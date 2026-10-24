// T3 Map — app controller: live stream, header, rail, ticker, composer.

import { createMap } from "./map.js";
import { createThreadPanel } from "./thread.js";
import { createComposer } from "./composer.js";
import { BOSS, CROWN, chainFor, chainHTML, createTeamDialog, rosterHTML, teamAction } from "./team.js";
import { STATE_LABEL, ago, clock, esc, glyph, moveInk, projectColor, replay, truncate } from "./ui.js";

const $ = (s) => document.querySelector(s);

const S = {
  status: { state: "connecting", detail: "" },
  env: null,
  projects: new Map(),
  threads: new Map(),
  events: [],
  focus: null,
  selected: null,
  tab: "needs",
  scope: null,
  serverOffset: 0,
  // Your explicit choices per project (true = collapsed); everything else follows the default.
  fold: new Map(Object.entries(JSON.parse(localStorage.getItem("t3map.fold") || "{}"))),
  quietOpen: false,
  team: null,
};

const saveFold = () => localStorage.setItem("t3map.fold", JSON.stringify(Object.fromEntries(S.fold)));

function isCollapsed(id) {
  return S.fold.get(id) === true;
}

const theme = new URLSearchParams(location.search).get("theme");
if (theme === "light" || theme === "dark") document.documentElement.dataset.theme = theme;

// ---------- live stream ----------

function connect() {
  const es = new EventSource("/api/stream");
  es.addEventListener("state", (e) => {
    const m = JSON.parse(e.data);
    S.status = m.status;
    S.env = m.environmentId;
    S.demo = m.demo;
    document.body.classList.toggle("is-demo", Boolean(m.demo));
    S.serverOffset = m.now - Date.now();
    S.projects = new Map(m.projects.map((p) => [p.id, p]));
    S.threads = new Map(m.threads.map((t) => [t.id, t]));
    S.events = m.events;
    S.team = m.team ?? null;
    render();
  });
  es.addEventListener("team", (e) => {
    S.team = JSON.parse(e.data);
    render();
  });
  es.addEventListener("thread", (e) => {
    const t = JSON.parse(e.data);
    S.threads.set(t.id, t);
    render();
  });
  es.addEventListener("projects", (e) => {
    for (const p of JSON.parse(e.data)) S.projects.set(p.id, p);
    render();
  });
  es.addEventListener("projectRemoved", (e) => {
    S.projects.delete(JSON.parse(e.data).id);
    render();
  });
  es.addEventListener("removed", (e) => {
    S.threads.delete(JSON.parse(e.data).id);
    render();
  });
  es.addEventListener("status", (e) => {
    S.status = JSON.parse(e.data);
    renderConn();
    renderEmpty();
  });
  es.addEventListener("events", (e) => {
    const list = JSON.parse(e.data);
    S.events.push(...list);
    if (S.events.length > 2000) S.events.splice(0, S.events.length - 2000);
    render();
    // Pulses run after the render so new nodes and links already exist.
    nextFrame(() => list.forEach((ev) => map.pulse(ev)));
  });
  es.onerror = () => {
    S.status = { state: "reconnecting", detail: "Reconnecting to the map server…" };
    renderConn();
  };
}

// ---------- derived model ----------

function model() {
  const visible = [...S.threads.values()].filter((t) => t.visible);
  const team = S.team ?? { boss: null, managers: {} };
  const bossId = team.boss?.threadId && S.threads.has(team.boss.threadId) ? team.boss.threadId : null;
  const managers = new Map(Object.entries(team.managers ?? {}).filter(([, m]) => S.threads.has(m.threadId)).map(([pid, m]) => [pid, S.threads.get(m.threadId)]));
  const roleIds = new Set([bossId, ...[...managers.values()].map((t) => t.id)].filter(Boolean));
  const byProject = new Map();
  for (const t of visible) {
    if (roleIds.has(t.id)) continue;
    if (!S.projects.has(t.projectId)) S.projects.set(t.projectId, { id: t.projectId, title: "Other threads", repo: null, synthetic: true });
    if (!byProject.has(t.projectId)) byProject.set(t.projectId, []);
    byProject.get(t.projectId).push(t);
  }
  for (const list of byProject.values()) list.sort((a, b) => a.createdAt.localeCompare(b.createdAt));

  const projectState = new Map();
  for (const pid of new Set([...byProject.keys(), ...managers.keys()])) {
    const list = [...(byProject.get(pid) ?? []), ...(managers.has(pid) ? [managers.get(pid)] : [])];
    const s = { working: 0, needs: 0, reported: 0, failed: 0 };
    for (const t of list) {
      if (t.state === "working" || t.state === "waiting") s.working++;
      else if (t.state in s) s[t.state]++;
    }
    projectState.set(pid, s);
  }

  const byTitle = (a, b) => a.title.localeCompare(b.title);
  const onMap = (p) => byProject.has(p.id) || managers.has(p.id);
  const active = [...S.projects.values()].filter(onMap).sort(byTitle);
  const quiet = [...S.projects.values()].filter((p) => !onMap(p) && !p.synthetic && p.title !== "No project").sort(byTitle);

  // Busier teams get thicker trunks: activity over the last five minutes.
  const now = Date.now() + S.serverOffset;
  const counts = new Map();
  for (const e of S.events) {
    if (now - e.at > 5 * 60_000) continue;
    counts.set(e.projectId, (counts.get(e.projectId) ?? 0) + (e.weight ?? 1));
  }
  const widths = new Map(active.map((p) => [p.id, linkWidth(counts.get(p.id) ?? 0)]));

  const count = (st) => visible.filter((t) => st.includes(t.state)).length;
  return {
    visible,
    threads: visible.filter((t) => !roleIds.has(t.id)),
    team,
    bossId,
    boss: bossId ? S.threads.get(bossId) : null,
    managers,
    active,
    quiet,
    threadsByProject: byProject,
    projectState,
    widths,
    focus: S.focus,
    selected: S.selected,
    collapsed: new Set(active.filter((p) => isCollapsed(p.id, projectState.get(p.id))).map((p) => p.id)),
    quietOpen: S.quietOpen,
    activity: counts,
    needsCount: count(["needs"]),
    workingCount: count(["working", "waiting"]),
    reportedCount: count(["reported"]),
    failedCount: count(["failed"]),
  };
}

function linkWidth(n) {
  return n ? Math.min(6, 1.2 + Math.log2(1 + n) * 0.75) : 1.2;
}

// ---------- rendering ----------

// Next paint, or a short timer when the page is throttled (background tabs skip frames).
function nextFrame(fn) {
  let done = false;
  const run = () => !done && ((done = true), fn());
  requestAnimationFrame(run);
  setTimeout(run, 60);
}

let M = null;
let queued = false;
function render() {
  if (queued) return;
  queued = true;
  nextFrame(() => {
    queued = false;
    M = model();
    if (S.focus && !M.active.some((p) => p.id === S.focus)) S.focus = null;
    map.update(M);
    renderStats();
    renderCrumbs();
    renderSpark();
    renderRail();
    renderTicker();
    renderConn();
    renderEmpty();
    renderScope();
    renderTeamPrompt();
  });
}

// Until there's a Boss, the map invites you to set one up (dismissible for this session).
function renderTeamPrompt() {
  $("#team-prompt").hidden = Boolean(M.bossId) || S.status.state !== "live" || sessionStorage.getItem("t3map.teamPrompt") === "hidden";
}

function renderStats() {
  const items = [
    ["working", M.workingCount, "working"],
    ["needs", M.needsCount, M.needsCount === 1 ? "needs you" : "need you"],
    ["reported", M.reportedCount, "to read"],
    ...(M.failedCount ? [["failed", M.failedCount, "failed"]] : []),
  ];
  $("#stats").innerHTML =
    items
      .map(([k, n, label]) => `<span class="stat ${k} ${n ? "hot" : "is-zero"}"><i class="d ${k}"></i><b>${n}</b>${label}</span>`)
      .join("") + `<span class="stat ${M.active.length ? "" : "is-zero"}"><b>${M.active.length}</b>of ${M.active.length + M.quiet.length} projects active</span>`;
  $("#needs-count").textContent = M.needsCount + M.failedCount;
  $("#needs-count").classList.toggle("hot", M.needsCount > 0);
  $("#dock-toggle").dataset.count = M.needsCount;
  document.title = M.needsCount ? `(${M.needsCount}) T3 Map` : "T3 Map";
}

function renderCrumbs() {
  const p = S.focus && S.projects.get(S.focus);
  $("#crumbs").innerHTML = p
    ? `<button type="button" data-act="overview">All projects</button><span class="sep">/</span><span class="here">${esc(p.title)}</span>`
    : "";
}

function renderSpark() {
  const now = Date.now() + S.serverOffset;
  const buckets = Array.from({ length: 12 }, () => ({ s: 0, f: 0 }));
  const slot = (iso) => {
    const age = now - Date.parse(iso ?? "");
    if (!(age >= 0 && age < 3600_000)) return null;
    return 11 - Math.floor(age / 300_000);
  };
  for (const t of S.threads.values()) {
    const a = slot(t.startedAt);
    if (a !== null) buckets[a].s++;
    const b = slot(t.completedAt);
    if (b !== null) buckets[b].f++;
  }
  const max = Math.max(2, ...buckets.map((b) => b.s + b.f));
  const started = buckets.reduce((a, b) => a + b.s, 0);
  const finished = buckets.reduce((a, b) => a + b.f, 0);
  $("#spark").title = `Last hour: ${started} started, ${finished} finished`;
  $("#spark").innerHTML = buckets
    .map((b) => {
      const hs = Math.round((b.s / max) * 20);
      const hf = Math.round((b.f / max) * 20);
      return `<span class="col">${hf ? `<i class="f" style="height:${hf}px"></i>` : ""}${hs ? `<i class="s" style="height:${hs}px"></i>` : ""}${!hs && !hf ? "<i></i>" : ""}</span>`;
    })
    .join("");
}

function renderConn() {
  const c = $("#conn");
  c.dataset.state = S.status.state;
  c.title = S.status.detail ?? "";
  c.querySelector(".conn-label").textContent = { live: "Live", reconnecting: "Reconnecting", connecting: "Connecting", offline: "Offline" }[S.status.state] ?? S.status.state;
}

function renderEmpty() {
  const box = $("#empty");
  const offline = S.status.state === "offline" && S.threads.size === 0;
  box.hidden = !offline;
  if (offline) {
    box.innerHTML = `<div><div class="calm-mark" style="background:var(--line);color:var(--muted)">${glyph("t3", 20)}</div>
      <h3>${esc(S.status.detail || "T3 Code isn't reachable")}</h3><p>Open T3 Code — the map reconnects on its own.</p></div>`;
  }
}

// ---------- rail ----------

const inScope = (t) => !S.focus || t.projectId === S.focus;
const projTitle = (id) => S.projects.get(id)?.title ?? "Other threads";

function renderRail() {
  document.querySelectorAll(".tab").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.tab === S.tab)));
  moveInk($(".tabs"));
  const filter = $("#rail-filter");
  const p = S.focus && S.projects.get(S.focus);
  filter.hidden = !p;
  if (p) filter.innerHTML = `Showing <button type="button" data-act="overview">${esc(p.title)} <span aria-hidden="true">×</span></button>`;

  const body = $("#rail-body");
  const html = S.tab === "needs" ? railNeeds() : S.tab === "activity" ? railActivity() : railTeam();
  // Only touch the DOM when something visible changed, so cards don't re-animate.
  if (body.dataset.sig !== html) {
    const keep = new Set([...body.querySelectorAll("[data-key]")].map((n) => n.dataset.key));
    body.dataset.sig = html;
    body.innerHTML = html;
    body.querySelectorAll("[data-key]").forEach((n) => keep.has(n.dataset.key) && (n.style.animation = "none"));
  }
  if (S.tabSwap) (S.tabSwap = false, (body.scrollTop = 0), replay(body));
}

function railNeeds() {
  const list = M.visible.filter(inScope);
  const by = (st) => list.filter((t) => t.state === st).sort((a, b) => (a.since ?? "").localeCompare(b.since ?? ""));
  // The Boss only asks about big calls, so its questions lead.
  const needs = by("needs").sort((a, b) => (b.role === "boss") - (a.role === "boss"));
  const failed = by("failed");
  const reported = by("reported").reverse();
  const now = Date.now() + S.serverOffset;

  const card = (t) => {
    let title = t.title;
    if (t.role === "boss" && t.title === "Boss") {
      if (t.state === "needs") title = "The Boss needs your input";
      if (t.state === "reported") title = "Update from the Boss";
    }
    return `
    <article class="item ${t.state} ${S.selected === t.id ? "hl" : ""}" data-key="${esc(t.id)}" data-thread="${esc(t.id)}">
      <span class="item-ic">${needIcon(t)}</span>
      <div class="item-main">
        ${chainHTML(chainFor(t, { team: S.team, threads: S.threads, projTitle }))}
        <div class="item-title">${esc(title)}</div>
        <div class="item-why">${esc(t.reason)}${t.resetsAt ? ` · resets ${esc(clock(t.resetsAt))}` : ""}</div>
        <div class="item-meta">${glyph(t.provider, 12)}<span class="proj">${esc(projTitle(t.projectId))}</span><span>·</span><span>${esc(t.providerName)}</span><span>·</span><span>${esc(ago(t.since, now))}</span></div>
        <div class="item-actions">
          <button type="button" class="pill-btn" data-act="open" data-id="${esc(t.id)}">${t.state === "needs" ? (t.request?.kind === "dynamic_tool_call" ? "Review request" : "Review & answer") : t.state === "reported" ? "Read result" : "View thread"}<svg viewBox="0 0 12 12" width="10" height="10" aria-hidden="true"><path d="M4 2.5h5.5V8M9.5 2.5 3 9" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
          <button type="button" class="text-btn" data-act="locate" data-id="${esc(t.id)}">Show on map</button>
        </div>
      </div>
    </article>`;
  };

  const group = (title, items) => (items.length ? `<section class="group"><div class="group-title"><span>${title}</span><span>${items.length}</span></div>${items.map(card).join("")}</section>` : "");

  const working = list.filter((t) => t.state === "working" || t.state === "waiting").sort((a, b) => (a.since ?? "").localeCompare(b.since ?? ""));
  const workingGroup = working.length
    ? `<section class="group"><div class="group-title"><span>Working now</span><span>${working.length}</span></div>${working.map((t) => liveRow(t, now)).join("")}</section>`
    : "";

  if (!needs.length && !failed.length && !reported.length) {
    return `<div class="calm"><div class="calm-mark"><svg viewBox="0 0 20 20" width="20" height="20"><path d="M5 10.5l3.2 3L15 7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg></div>
      <h3>Nothing needs you</h3><p>${working.length ? `${working.length} thread${working.length === 1 ? " is" : "s are"} working on ${working.length === 1 ? "its" : "their"} own.` : "The team is quiet. Start something below."}</p></div>` + workingGroup;
  }
  return group("Decisions", needs) + group("Problems", failed) + group("Fresh results", reported) + workingGroup;
}

function eventText(e) {
  const t = S.threads.get(e.threadId);
  const who = t?.providerName ?? "Agent";
  const verb =
    e.type === "call" ? (e.from === "you" ? "got your message" : e.text === "started" ? "was started by its lead" : "got a message from its lead")
    : e.type === "answer" ? "finished"
    : e.type === "needs" ? (e.text || "needs you").replace(/^./, (c) => c.toLowerCase())
    : e.type === "failed" ? "hit a problem"
    : "is working";
  return { who, verb, title: t?.title ?? "a thread" };
}

function feedItems(limit) {
  const items = S.events.filter((e) => e.type !== "work" && (!S.focus || e.projectId === S.focus)).slice(-limit).reverse();
  // Before any live traffic, show today's real finishes from T3's own timestamps.
  if (items.length < limit) {
    const since = new Date();
    since.setHours(0, 0, 0, 0);
    const seen = new Set(items.filter((e) => e.type === "answer").map((e) => e.threadId));
    const seeded = [...S.threads.values()]
      .filter((t) => t.completedAt && Date.parse(t.completedAt) >= +since && !seen.has(t.id) && (!S.focus || t.projectId === S.focus))
      .map((t) => ({ id: `seed:${t.id}`, type: "answer", threadId: t.id, projectId: t.projectId, at: Date.parse(t.completedAt), seeded: true }));
    items.push(...seeded);
    items.sort((a, b) => b.at - a.at);
  }
  // Fold back-to-back repeats ("got your message" ×3) into one line.
  const folded = [];
  for (const e of items) {
    const last = folded[folded.length - 1];
    if (last && last.type === e.type && last.threadId === e.threadId && last.from === e.from) last.times = (last.times ?? 1) + 1;
    else folded.push({ ...e });
  }
  return folded.slice(0, limit);
}

function railActivity() {
  const items = feedItems(80);
  if (!items.length) return `<div class="calm"><h3>No activity yet today</h3><p>Messages, finishes and questions show up here as they happen.</p></div>`;
  const now = Date.now() + S.serverOffset;
  return `<ul class="feed">${items
    .map((e) => {
      const { who, verb, title } = eventText(e);
      return `<li data-key="${esc(String(e.id))}" data-thread="${esc(e.threadId)}"><i class="fd ${e.type}"></i>
        <div class="ft"><div><b>${esc(who)}</b> ${esc(verb)}${e.times > 1 ? ` <span class="times">×${e.times}</span>` : ""}</div><small>${esc(truncate(title, 60))} · ${esc(projTitle(e.projectId))}</small></div>
        <span class="fa">${esc(ago(e.at, now))}</span></li>`;
    })
    .join("")}</ul>`;
}

function railTeam() {
  const roster = rosterHTML({ team: S.team, threads: S.threads, projects: S.projects, active: M.active, quiet: M.quiet, scoped: S.focus });
  const roles = new Set([M.bossId, ...[...M.managers.values()].map((t) => t.id)]);
  const list = M.visible.filter((t) => inScope(t) && !roles.has(t.id));
  if (!list.length) return roster;
  return roster + `<div class="group-title others"><span>Everyone else at work</span></div>` + railWorkers(list);
}

function railWorkers(list) {
  const now = Date.now() + S.serverOffset;
  const groups = new Map();
  for (const t of list) {
    if (!groups.has(t.projectId)) groups.set(t.projectId, []);
    groups.get(t.projectId).push(t);
  }
  const order = (t) => ({ needs: 0, failed: 1, working: 2, waiting: 2, reported: 3, idle: 4 })[t.state] ?? 5;
  return [...groups]
    .sort((a, b) => projTitle(a[0]).localeCompare(projTitle(b[0])))
    .map(([pid, ts]) => {
      const ids = new Set(ts.map((t) => t.id));
      const roots = ts.filter((t) => !t.parentId || !ids.has(t.parentId)).sort((a, b) => order(a) - order(b));
      const rows = [];
      const walk = (t, depth) => {
        rows.push(teamRow(t, depth, now));
        ts.filter((c) => c.parentId === t.id).forEach((c) => walk(c, depth + 1));
      };
      roots.forEach((t) => walk(t, 0));
      const p = S.projects.get(pid);
      return `<section class="group"><div class="group-title"><span style="color:${projectColor(p)}">${esc(projTitle(pid))}</span><span>${ts.length}</span></div>${rows.join("")}</section>`;
    })
    .join("");
}

function liveRow(t, now) {
  return `<button type="button" class="row" data-key="w:${esc(t.id)}" data-thread="${esc(t.id)}" data-act="open" data-id="${esc(t.id)}">
    <span class="gl live">${glyph(t.provider, 13)}</span>
    <span class="ti"><div>${esc(t.title)}</div><small>${esc(projTitle(t.projectId))} · ${esc(t.providerName)}${t.state === "waiting" ? " · waiting on its team" : ""}</small></span>
    <span class="elapsed">${esc(ago(t.since, now))}</span></button>`;
}

function teamRow(t, depth, now) {
  return `<button type="button" class="row" style="${depth ? `padding-left:${10 + depth * 20}px` : ""}" data-key="${esc(t.id)}" data-thread="${esc(t.id)}" data-act="open" data-id="${esc(t.id)}">
    <span class="gl">${glyph(t.provider, 13)}</span>
    <span class="ti"><div>${esc(t.title)}</div><small>${esc([t.providerName, t.model].filter(Boolean).join(" · "))} · ${esc(ago(t.updatedAt, now))}</small></span>
    <span class="chip ${t.state}">${esc(STATE_LABEL[t.state])}</span></button>`;
}

// ---------- ticker ----------

let tickerSig = "";
function renderTicker() {
  const items = feedItems(8);
  const sig = items.map((e) => e.id).join(",");
  if (sig === tickerSig) return;
  const fresh = new Set(items.filter((e) => !tickerSig.split(",").includes(String(e.id))).map((e) => String(e.id)));
  tickerSig = sig;
  const now = Date.now() + S.serverOffset;
  $("#ticker-track").innerHTML = items.length
    ? items
        .map((e) => {
          const { who, verb, title } = eventText(e);
          return `<span class="${fresh.has(String(e.id)) && tickerSig ? "new" : ""}"><i class="fd ${e.type}" style="width:6px;height:6px;border-radius:50%;display:inline-block"></i><b>${esc(who)}</b> ${esc(verb)}${e.times > 1 ? ` <span class="times">×${e.times}</span>` : ""} “${esc(truncate(title, 42))}” <small style="color:var(--faint)">${esc(ago(e.at, now))}</small></span>`;
        })
        .join("")
    : `<span style="color:var(--faint)">Nothing yet today.</span>`;
}

// ---------- tooltip ----------

function showTip(h) {
  const tip = $("#tip");
  if (!h) return (tip.hidden = true);
  const stage = $("#stage").getBoundingClientRect();
  let html = "";
  if (h.kind === "thread") {
    const t = S.threads.get(h.id);
    if (!t) return (tip.hidden = true);
    const now = Date.now() + S.serverOffset;
    html = `<h4>${esc(t.title)}</h4>
      <div class="row"><span class="chip ${t.state}">${esc(STATE_LABEL[t.state])}</span><span>${esc(ago(t.since, now))}</span></div>
      <div class="row">${glyph(t.provider, 13)}<span>${esc([t.providerName, t.model].filter(Boolean).join(" · "))}</span></div>
      ${t.state !== "working" && t.reason && t.state !== "idle" ? `<div class="row">${esc(t.reason)}</div>` : ""}
      ${t.branch ? `<div class="row"><span style="font-family:var(--mono);font-size:11px">${esc(truncate(t.branch, 40))}</span>${t.pr ? `<span>· PR #${t.pr.number}</span>` : ""}</div>` : ""}
      ${t.parentId && S.threads.get(t.parentId) ? `<div class="row">Lead: ${esc(truncate(S.threads.get(t.parentId).title, 38))}</div>` : ""}
      <div class="hint">Click to view conversation</div>`;
  } else if (h.kind === "project") {
    const p = S.projects.get(h.id);
    const s = M.projectState.get(h.id);
    html = `<h4>${esc(p?.title)}</h4>${p?.repo ? `<div class="row" style="font-family:var(--mono);font-size:11px">${esc(p.repo)}</div>` : ""}
      ${s ? `<div class="row">${[s.working && `${s.working} working`, s.needs && `${s.needs} need you`, s.reported && `${s.reported} to read`, s.failed && `${s.failed} failed`].filter(Boolean).join(" · ") || "Idle"}</div>` : `<div class="row">Quiet — no live threads</div>`}
      ${M.managers.has(h.id) ? `<div class="row">Manager · ${esc(M.managers.get(h.id).providerName)} · ${esc(STATE_LABEL[M.managers.get(h.id).state])}</div>` : ""}
      <div class="hint">${M.managers.has(h.id) ? "Click to chat with its Manager" : "Click to set up its Manager"} · double-click to zoom · −/+ folds threads</div>`;
  }
  tip.innerHTML = html;
  tip.hidden = false;
  const w = 280;
  let x = h.rect.left + h.rect.width / 2 - stage.left - w / 2;
  let y = h.rect.bottom - stage.top + 10;
  x = Math.max(10, Math.min(stage.width - w - 10, x));
  if (y + tip.offsetHeight > stage.height - 10) y = h.rect.top - stage.top - tip.offsetHeight - 10;
  tip.style.left = `${x}px`;
  tip.style.top = `${y}px`;
}

// ---------- link tooltip ----------

const ARROW = `<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path d="M3 8h10M9.5 4.5 13 8l-3.5 3.5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

function lastEventFor(pred) {
  for (let i = S.events.length - 1; i >= 0; i--) if (S.events[i].type !== "work" && pred(S.events[i])) return S.events[i];
  return null;
}

function showLinkTip(spec) {
  const tip = $("#link-tip");
  if (!spec) return (tip.hidden = true);
  $("#tip").hidden = true;
  const now = Date.now() + S.serverOffset;
  const name = (key) => (key === "you" ? "You" : key === "boss" ? "Boss" : key === "quiet" ? "Quiet projects" : S.threads.get(key)?.title ?? S.projects.get(key)?.title ?? "…");
  let rows = [];
  let hint = "";
  if (spec.boss) {
    const b = M.boss;
    rows = [["Boss", b ? STATE_LABEL[b.state] : "—"], ["Agent", b ? [b.providerName, b.model].filter(Boolean).join(" · ") : "—"], ["Managers", `${M.managers.size}`]];
    hint = "Click to open the Boss conversation";
  } else if (spec.to === "quiet") {
    rows = [["Projects", String(M.quiet.length)], ["Live threads", "None"]];
    hint = "Click to show or hide them";
  } else if (spec.kind.startsWith("trunk")) {
    const s = M.projectState.get(spec.project) ?? {};
    const list = M.threadsByProject.get(spec.project) ?? [];
    const ev = lastEventFor((e) => e.projectId === spec.project);
    const recent = M.activity.get(spec.project) ?? 0;
    rows = [
      ["Threads", `${list.length}`],
      ["Working", `${s.working ?? 0}`],
      ...(s.needs ? [["Needs you", `${s.needs}`]] : []),
      ["Last 5 min", `${recent} update${recent === 1 ? "" : "s"}`],
      ...(ev ? [["Latest", `${eventText(ev).who} ${eventText(ev).verb} · ${ago(ev.at, now)}`]] : []),
    ];
    hint = S.focus === spec.project ? "Click to zoom back out" : "Click to zoom into this team";
  } else if (spec.thread) {
    const t = S.threads.get(spec.thread);
    const ev = lastEventFor((e) => e.threadId === spec.thread);
    rows = [
      ["Relation", spec.kind.startsWith("sub") ? "Subagent of its lead" : "Thread in this project"],
      ["State", t ? STATE_LABEL[t.state] : "—"],
      ["Agent", t ? [t.providerName, t.model].filter(Boolean).join(" · ") : "—"],
      ...(ev ? [["Latest", `${eventText(ev).verb} · ${ago(ev.at, now)}`]] : []),
    ];
    hint = "Click to view conversation";
  } else {
    rows = [["More threads", "Zoom in to see them all"]];
    hint = "Click to zoom into this team";
  }
  tip.innerHTML = `<div class="route"><span>${esc(truncate(name(spec.from), 26))}</span>${ARROW}<span>${esc(truncate(name(spec.to), 30))}</span></div>
    <dl class="kv">${rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join("")}</dl>
    <div class="hint">${esc(hint)}</div>`;
  tip.hidden = false;
  const stage = $("#stage").getBoundingClientRect();
  let x = spec.x - stage.left + 14;
  let y = spec.y - stage.top + 14;
  if (x + 290 > stage.width) x = spec.x - stage.left - 298;
  if (y + tip.offsetHeight > stage.height - 8) y = spec.y - stage.top - tip.offsetHeight - 12;
  tip.style.left = `${Math.max(8, x)}px`;
  tip.style.top = `${Math.max(8, y)}px`;
}

const ICONS = {
  question: `<svg viewBox="0 0 16 16" width="15" height="15"><path d="M3 3.5h10v7H7.5L4.5 13v-2.5H3z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/><path d="M6.6 5.6c.2-.7.8-1 1.4-1 .8 0 1.4.5 1.4 1.2 0 .9-1.3 1-1.3 1.8M8 8.9v.1" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>`,
  approve: `<svg viewBox="0 0 16 16" width="15" height="15"><path d="M8 2 13 4v4c0 3-2.2 5-5 6-2.8-1-5-3-5-6V4z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/><path d="m5.8 8 1.6 1.6 3-3.2" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  key: `<svg viewBox="0 0 16 16" width="15" height="15"><circle cx="5.5" cy="10.5" r="2.8" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="m7.5 8.5 5.5-5.5M11 5l1.6 1.6" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>`,
  plan: `<svg viewBox="0 0 16 16" width="15" height="15"><path d="M6.5 4.5H13M6.5 8H13M6.5 11.5H13" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/><path d="m2.8 4.5.9.9 1.5-1.6M2.8 8l.9.9 1.5-1.6" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/><circle cx="3.9" cy="11.5" r=".9" fill="currentColor"/></svg>`,
  alert: `<svg viewBox="0 0 16 16" width="15" height="15"><path d="M8 2.6 14 13H2z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/><path d="M8 6.6v3M8 11.3v.1" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>`,
  clock: `<svg viewBox="0 0 16 16" width="15" height="15"><circle cx="8" cy="8" r="5.5" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M8 5v3.2l2 1.3" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>`,
  done: `<svg viewBox="0 0 16 16" width="15" height="15"><circle cx="8" cy="8" r="5.5" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="m5.6 8.2 1.7 1.7 3.2-3.4" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
};

function needIcon(t) {
  if (t.state === "reported") return ICONS.done;
  if (t.state === "failed") return t.resetsAt || /limit/i.test(t.reason) ? ICONS.clock : ICONS.alert;
  const k = t.request?.kind;
  if (k === "dynamic_tool_call") return ICONS.approve;
  if (k === "auth_refresh") return ICONS.key;
  if (k === "user_input") return ICONS.question;
  return ICONS.plan;
}

// ---------- actions ----------

async function post(path, body) {
  const res = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const out = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(out.error || "Something went wrong");
  return out;
}

let toastTimer = 0;
function toast(text) {
  const t = $("#toast");
  t.textContent = text;
  replay(t, "show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), 2600);
}

function openThread(id) {
  if (id === S.team?.boss?.threadId) S.scope = BOSS;
  else {
    const manager = Object.entries(S.team?.managers ?? {}).find(([, m]) => m.threadId === id);
    if (manager) S.scope = manager[0];
  }
  S.selected = id;
  panel.open(id);
  syncDockToggle();
  render();
}

const panel = createThreadPanel({ thread: (id) => S.threads.get(id), project: projTitle, post, toast, onOpen: openThread, onClose: () => { syncDockToggle(); render(); } });

function focusProject(id) {
  S.focus = id;
  S.scope = id;
  // Zooming into a team always shows the team.
  if (isCollapsed(id)) (S.fold.set(id, false), saveFold());
  render();
  setTimeout(() => map.focusOn(id), 120);
}

async function selectProject(id) {
  const p = S.projects.get(id);
  if (!p || p.synthetic || p.title === "No project") return;
  S.scope = id;
  renderScope();
  const manager = S.team?.managers?.[id];
  if (manager) return openThread(manager.threadId);
  toast(`Setting up the ${p.title} Manager…`);
  try {
    const out = await post("/api/team", { action: "manager", mode: "ensure", projectId: id });
    S.team ??= { boss: null, managers: {}, autonomy: {} };
    S.team.managers[id] = { threadId: out.threadId, project: p.title };
    render();
    // A slower launch must not steal focus from a project selected afterwards.
    if (S.scope === id) openThread(out.threadId);
  } catch (e) { toast(e.message); }
}

function overview() {
  S.focus = null;
  S.scope = M?.bossId ? BOSS : null;
  S.selected = null;
  if (panel.id) panel.close();
  render();
  map.fit();
}

function locate(id) {
  const t = S.threads.get(id);
  if (!t) return;
  S.selected = id;
  if (S.focus !== t.projectId) focusProject(t.projectId);
  else render();
}

const map = createMap($("#stage"), {
  onProject: selectProject,
  onToggle: (id) => {
    S.fold.set(id, !isCollapsed(id));
    saveFold();
    $("#tip").hidden = true;
    render();
  },
  onZoom: (id) => {
    if (S.focus === id) return overview();
    focusProject(id);
    selectProject(id);
  },
  onThread: (id) => openThread(id),
  onQuiet: () => ((S.quietOpen = !S.quietOpen), render()),
  onChip: selectProject,
  onBackground: (you) => (S.focus || you ? overview() : null),
  onHover: showTip,
  onLinkHover: showLinkTip,
  onLinkClick: (spec) => {
    if (!spec) return;
    if (spec.boss) return M.bossId && openThread(M.bossId);
    if (spec.to === "quiet") return ((S.quietOpen = !S.quietOpen), render());
    if (spec.thread) return openThread(spec.thread);
    if (spec.project && spec.project !== "quiet") return selectProject(spec.project);
  },
  onCamera: () => (($("#tip").hidden = true), ($("#link-tip").hidden = true)),
  bottomOverlay: () => $("#composer"),
});

const teamDialog = createTeamDialog({ post, toast, openThread: (id) => openThread(id), data: () => ({ team: S.team, threads: S.threads, projects: S.projects, scope: S.scope }) });
const confirmRemove = (text) => new Promise((resolve) => {
  const d = document.createElement("dialog");
  d.className = "team-dialog confirm";
  d.innerHTML = `<form method="dialog" class="td"><p>${esc(text)}</p><footer><button value="no" class="text-btn">Keep it</button><button value="yes" class="pill-btn danger">Remove</button></footer></form>`;
  document.body.appendChild(d);
  d.addEventListener("close", () => (resolve(d.returnValue === "yes"), d.remove()));
  d.showModal();
});

document.addEventListener("click", (e) => {
  const tb = e.target.closest("[data-team]");
  if (tb?.dataset.team === "level") tb.parentElement.querySelectorAll("[data-level]").forEach((b) => b.setAttribute("aria-checked", String(b === tb)));
  if (tb) return teamAction(tb, { post, toast, data: () => ({ team: S.team, projects: S.projects }), dialog: teamDialog, confirmRemove });
  const a = e.target.closest("[data-act]");
  if (a) {
    const act = a.dataset.act;
    if (act === "overview") return overview();
    if (act === "open") return openThread(a.dataset.id);
    if (act === "locate") return locate(a.dataset.id);
  }
  const tab = e.target.closest(".tab");
  if (tab) {
    if (S.tab !== tab.dataset.tab) S.tabSwap = true;
    S.tab = tab.dataset.tab;
    renderRail();
  }
  const item = e.target.closest("#rail-body [data-thread]");
  if (item && !e.target.closest('button')) openThread(item.dataset.thread);
});

// Hovering a rail item highlights it on the map.
$("#rail-body").addEventListener("pointerover", (e) => {
  const id = e.target.closest("[data-thread]")?.dataset.thread ?? null;
  if (id === S.selected) return;
  S.selected = id;
  map.update(M);
});

$("#team-prompt-close").onclick = () => (sessionStorage.setItem("t3map.teamPrompt", "hidden"), renderTeamPrompt());
$("#z-in").onclick = () => map.zoomIn();
$("#z-out").onclick = () => map.zoomOut();
$("#z-fit").onclick = overview;

// The sidebar folds away for a full-width map; conversations still open beside it.
function setDock(collapsed, save = true) {
  $(".body").classList.toggle("dock-collapsed", collapsed);
  syncDockToggle();
  if (!panel.id) $("#rail").inert = collapsed;
  if (save) localStorage.setItem("t3map.dock", collapsed ? "collapsed" : "open");
}
function syncDockToggle() {
  const collapsed = $(".body").classList.contains("dock-collapsed");
  $("#stage").inert = Boolean(panel.id) && matchMedia("(max-width: 980px)").matches;
  const b = $("#dock-toggle");
  const label = panel.id ? "Close conversation" : collapsed ? "Show sidebar" : "Hide sidebar";
  b.setAttribute("aria-expanded", String(Boolean(panel.id) || !collapsed));
  b.setAttribute("aria-label", label);
  b.title = label + "  ]";
}
setDock(localStorage.getItem("t3map.dock") === "collapsed", false);
$("#dock-toggle").onclick = () => {
  if (panel.id) return panel.close();
  setDock(!$(".body").classList.contains("dock-collapsed"));
};
addEventListener("resize", () => (syncDockToggle(), moveInk($(".tabs")), moveInk($(".thread-nav [role=tablist]"))));
document.fonts?.ready.then(() => (moveInk($(".tabs")), moveInk($(".thread-nav [role=tablist]"))));

document.addEventListener("keydown", (e) => {
  if (document.querySelector('dialog[open]')) return;
  if (e.target.matches("input, textarea, select") || e.target.closest('[contenteditable]')) {
    if (e.key === "Escape") e.target.blur();
    return;
  }
  if (e.key === "Escape") { if (panel.id) panel.close(); else overview(); }
  if (e.key === "+" || e.key === "=") map.zoomIn();
  if (e.key === "-") map.zoomOut();
  if (e.key === "/") (e.preventDefault(), $("#ask").focus());
  if (e.key === "]") $("#dock-toggle").click();
});

// ---------- composer ----------

// Who "Tell the team" talks to: the Boss by default, the project's Manager when you're in a project.
function teamTarget() {
  if (!M) return null;
  if ((S.scope === BOSS || !S.scope) && M.bossId) return { threadId: M.bossId, label: "the Boss" };
  if (S.scope && S.scope !== BOSS && M.managers.has(S.scope)) return { threadId: M.managers.get(S.scope).id, label: `the ${projTitle(S.scope)} Manager` };
  return null;
}
function routeTarget() {
  return $("#new-separate")?.checked ? null : teamTarget();
}

// The options popover: first who gets this, then only the settings that apply to that choice.
function renderWorkOptions() {
  const team = teamTarget();
  const sep = $("#new-separate");
  const toNew = sep.checked || !team;
  const p = S.scope && S.scope !== BOSS ? S.projects.get(S.scope) : null;
  const teamBtn = $("#wo-team");
  teamBtn.textContent = team ? (team.label.replace(/^the /, "").replace(/^Boss$/, "Boss")) : "Boss or Manager";
  teamBtn.disabled = !team;
  teamBtn.title = team ? "" : p ? `${p.title} has no Manager yet` : "Set up a Boss first";
  document.querySelectorAll("#work-options [data-route]").forEach((b) => b.setAttribute("aria-selected", String((b.dataset.route === "new") === toNew)));
  $("#wo-new").hidden = !toNew;
  $("#wo-note").textContent = toNew
    ? p ? `A fresh agent thread in ${p.title}, outside the team.` : "Pick a project for the new thread."
    : team.label === "the Boss" ? "The Boss decides who handles it and only comes back for big calls." : `${team.label[4].toUpperCase()}${team.label.slice(5)} runs it with its workers.`;
  $("#wo-foot").textContent = S.demo ? "Demo: nothing real is started." : toNew && p ? `Starts a real thread in ${p.title}.` : "";
  $("#wo-foot").hidden = !$("#wo-foot").textContent;
  $("#work-options-toggle").classList.toggle("is-set", toNew && Boolean(team) || $("#new-worktree").checked || Boolean($("#new-agent").value));
}

function renderScope() {
  const boss = S.scope === BOSS || (!S.scope && M?.bossId);
  const p = !boss && S.scope && S.projects.get(S.scope);
  $("#scope-label").innerHTML = boss ? `<span class="scope-crown">${CROWN}</span>Boss` : esc(p ? p.title : "Pick a project");
  $(".scope-dot").style.background = p ? projectColor(p) : "";
  $(".scope-dot").hidden = Boolean(boss);
  const target = routeTarget();
  $("#ask").dataset.placeholder = target ? `Tell ${target.label} what you want…` : p ? `Start new work in ${p.title}…` : "Tell the team what you want…";
  $("#composer").dataset.route = target ? "role" : "new";
  $(".composer-go").setAttribute("aria-label", target ? `Send to ${target.label}` : "Start work");
  renderWorkOptions();
}

$("#scope").addEventListener("click", () => {
  const menu = $("#scope-menu");
  const open = menu.hidden;
  menu.hidden = !open;
  $("#scope").setAttribute("aria-expanded", String(open));
  if (!open) return;
  const all = [...S.projects.values()].filter((p) => !p.synthetic && p.title !== "No project").sort((a, b) => a.title.localeCompare(b.title));
  const s = M?.projectState ?? new Map();
  menu.innerHTML =
    (M?.bossId ? `<button type="button" role="option" data-scope="${BOSS}" aria-selected="${S.scope === BOSS || !S.scope}"><span class="scope-crown">${CROWN}</span>Boss<small>all projects</small></button>` : `<button type="button" role="option" data-scope="" aria-selected="${!S.scope}"><span class="scope-dot"></span>Pick a project</button>`) +
    all
      .map((p) => {
        const st = s.get(p.id);
        return `<button type="button" role="option" data-scope="${esc(p.id)}" aria-selected="${S.scope === p.id}"><span class="scope-dot" style="background:${projectColor(p)}"></span>${esc(p.title)}<small>${M?.managers.has(p.id) ? "Manager" : st ? `${st.working} working` : p.repo ? "" : "local"}</small></button>`;
      })
      .join("");
});

$("#scope-menu").addEventListener("click", (e) => {
  const b = e.target.closest("[data-scope]");
  if (!b) return;
  S.scope = b.dataset.scope || null;
  $("#scope-menu").hidden = true;
  $("#scope").setAttribute("aria-expanded", "false");
  renderScope();
  if (S.scope && S.scope !== BOSS) selectProject(S.scope);
  else if (M?.bossId) openThread(M.bossId);
  else $("#ask").focus();
});

document.addEventListener("pointerdown", (e) => {
  if (!e.target.closest("#scope-menu, #scope")) $("#scope-menu").hidden = true;
});

const newComposer = createComposer({ form: $('#composer'), editor: $('#ask'), button: $('#new-attach'), input: $('#new-image-input'), tray: $('#new-images'), toast });

let agents = [], starting = false;
$("#work-options-toggle").onclick = async () => {
  const box = $("#work-options");
  box.hidden = !box.hidden;
  $("#work-options-toggle").setAttribute('aria-expanded', String(!box.hidden));
  if (box.hidden) return;
  try {
    const res = await fetch('/api/agents');
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Could not load agents.');
    const selected = $("#new-agent").value;
    agents = data;
    $("#new-agent").innerHTML = '<option value="">Project default</option>' + agents.map((a, i) => `<option value="${i}">${esc(a.label)}</option>`).join('');
    $("#new-agent").value = selected;
  } catch (e) { toast(e.message); }
};
$("#new-worktree").onchange = (e) => (($("#worktree-fields").hidden = !e.target.checked), renderWorkOptions());
$("#new-agent").onchange = () => renderWorkOptions();
$("#work-options").addEventListener("click", (e) => {
  const b = e.target.closest("[data-route]");
  if (!b || b.disabled) return;
  $("#new-separate").checked = b.dataset.route === "new";
  renderScope();
});
function closeWorkOptions() {
  $("#work-options").hidden = true;
  $("#work-options-toggle").setAttribute("aria-expanded", "false");
}
document.addEventListener("pointerdown", (e) => {
  if (!$("#work-options").hidden && !e.target.closest("#work-options, #work-options-toggle")) closeWorkOptions();
});
$("#work-options").addEventListener("keydown", (e) => e.key === "Escape" && (closeWorkOptions(), $("#work-options-toggle").focus()));

$("#composer").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!newComposer.hasContent || starting) return;
  const target = routeTarget();
  if (target) {
    starting = true;
    newComposer.freeze(true);
    try {
      const message = await newComposer.prepare();
      await post("/api/act", { action: "send", threadId: target.threadId, ...message });
      newComposer.clear();
      $("#composer").classList.remove("has-text");
      toast(`Sent to ${target.label}`);
    } catch (err) {
      toast(err.message);
    } finally { starting = false; newComposer.freeze(false); }
    return;
  }
  if (!S.scope || S.scope === BOSS) { toast('Pick the project for this work.'); $("#scope").click(); return; }
  starting = true;
  newComposer.freeze(true);
  $(".composer-go").disabled = true;
  try {
    const message = await newComposer.prepare();
    const agent = agents[$("#new-agent").value];
    const out = await post("/api/start", { ...message, projectId: S.scope, ...(agent ? { provider: agent.provider, model: agent.model } : {}), ...($("#new-worktree").checked ? { worktree: $("#new-base").value.trim() || 'HEAD', branch: $("#new-branch").value.trim() } : {}) });
    newComposer.clear();
    $("#composer").classList.remove("has-text");
    $("#work-options").hidden = true;
    $("#work-options-toggle").setAttribute('aria-expanded', 'false');
    toast(S.demo ? 'Demo work started' : 'Work started in T3');
    if (out.threadId) openThread(out.threadId);
  } catch (err) {
    toast(err.message);
  } finally { starting = false; newComposer.freeze(false); $(".composer-go").disabled = false; }
});

// Relative times stay fresh without any app-state churn.
setInterval(() => {
  if (!M) return;
  renderSpark();
  renderRail();
  tickerSig = "";
  renderTicker();
  map.update(M = model());
}, 30_000);

connect();
