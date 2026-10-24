// Team view: the Boss, a Manager per project, and how much each Manager may decide alone.
// Roles are ordinary T3 threads; assigning one starts or briefs a thread through the bridge.

import { STATE_LABEL, esc, glyph, monogram, projectColor, truncate } from "./ui.js";

export const BOSS = "__boss";
export const CROWN = `<svg viewBox="-11 -9 22 17" width="15" height="12" aria-hidden="true"><path d="M-9 5.5V-3.5l4.5 4 4.5-7 4.5 7 4.5-4v9z" fill="currentColor"/></svg>`;
const LEVELS = [
  ["cautious", "Cautious", "Decides only small, reversible things"],
  ["normal", "Normal", "Decides routine work; escalates scope, cost, production and UX"],
  ["bold", "Bold", "Decides everything except irreversible or spending calls"],
];

const stateText = (t) => (t ? STATE_LABEL[t.state] ?? t.state : "Missing");

/** The roster that tops the Team tab. */
export function rosterHTML({ team, threads, projects, active, quiet, scoped }) {
  const boss = team?.boss?.threadId ? threads.get(team.boss.threadId) : null;
  const bossBlock = boss
    ? `<button type="button" class="role-card boss ${boss.state}" data-act="open" data-id="${esc(boss.id)}" data-key="role:boss">
        <span class="role-ic boss">${CROWN}</span>
        <span class="role-main"><b>Boss</b><small>${glyph(boss.provider, 12)} ${esc([boss.providerName, boss.model].filter(Boolean).join(" · "))}</small></span>
        <span class="chip ${boss.state}">${esc(stateText(boss))}</span>
      </button>${boss.state === "failed" ? `<div class="role-actions role-recover"><small>This Boss thread stopped working.</small><button type="button" class="pill-btn" data-team="boss">Start a fresh Boss</button></div>` : ""}`
    : team?.boss
      ? `<div class="role-empty"><p>The Boss thread is no longer in T3.</p><div class="role-actions"><button type="button" class="pill-btn" data-team="boss">Set up a new Boss</button><button type="button" class="text-btn" data-team="unassign" data-role="boss">Remove</button></div></div>`
      : `<div class="role-empty"><span class="role-ic boss big">${CROWN}</span><div><b>No Boss yet</b><p>One thread that steers every project and only brings you the big decisions.</p><button type="button" class="pill-btn" data-team="boss">Set up a Boss</button></div></div>`;

  // T3's "No project" bucket holds loose threads; it has no team to manage.
  const list = [...active, ...quiet].filter((p) => !p.synthetic && p.title !== "No project" && (!scoped || p.id === scoped));
  const assigned = list.filter((p) => team?.managers?.[p.id]).length;
  const rows = list
    .map((p) => {
      const m = team?.managers?.[p.id];
      const t = m ? threads.get(m.threadId) : null;
      const level = team?.autonomy?.[p.id] ?? "normal";
      const isQuiet = quiet.includes(p);
      const who = m
        ? t
          ? `<button type="button" class="role-who" data-act="open" data-id="${esc(t.id)}">${glyph(t.provider, 12)}<span>Manager · ${esc(t.providerName)}</span><span class="chip ${t.state}">${esc(stateText(t))}</span></button>`
          : `<span class="role-who missing">Manager thread is gone</span>`
        : `<span class="role-who none">No Manager</span>`;
      const levels = m
        ? `<div class="level" role="radiogroup" aria-label="Autonomy for ${esc(p.title)}">${LEVELS.map(([v, label, help]) => `<button type="button" role="radio" aria-checked="${level === v}" title="${esc(help)}" data-team="level" data-project="${esc(p.id)}" data-level="${v}">${label}</button>`).join("")}</div>`
        : "";
      const controls = m
        ? `<button type="button" class="icon-btn" data-team="unassign" data-role="manager" data-project="${esc(p.id)}" title="Remove this Manager role (the thread stays in T3)" aria-label="Remove Manager for ${esc(p.title)}">×</button>`
        : `<button type="button" class="ghost-pill" data-team="manager" data-project="${esc(p.id)}">Assign</button>`;
      return `<div class="role-row ${isQuiet ? "quiet" : ""} ${m ? "has" : ""}" data-key="role:${esc(p.id)}">
        <span class="role-ic proj" style="--hue:${projectColor(p)}">${esc(monogram(p.title))}</span>
        <div class="role-main"><b>${esc(truncate(p.title, 28))}</b>${who}${levels}</div>
        <div class="role-ctl">${controls}</div>
      </div>`;
    })
    .join("");

  return `<section class="group roster"><div class="group-title"><span>Boss</span></div>${bossBlock}</section>
    <section class="group roster"><div class="group-title"><span>Managers</span><span>${assigned} of ${list.length}</span></div>${rows || `<p class="role-note">No projects yet.</p>`}
    <p class="role-note">Managers run their project's workers and decide routine things. Above their autonomy they escalate to the Boss, and the Boss only brings you the big calls. Merging is always yours.</p></section>`;
}

/** Escalation path for a "Needs you" item, e.g. "dzdistro Manager → Boss → You". */
export function chainFor(t, { team, threads, projTitle }) {
  if (!team) return null;
  const managerProject = (id) => Object.entries(team.managers ?? {}).find(([, m]) => m.threadId === id)?.[0];
  const label = (id) => {
    if (!id) return null;
    if (id === team.boss?.threadId) return "Boss";
    const pid = managerProject(id);
    if (pid) return `${projTitle(pid)} Manager`;
    const th = threads.get(id);
    return th ? `${th.providerName} worker` : null;
  };
  if (t.id === team.boss?.threadId) return [label(team.bossFrom), "Boss", "You"].filter(Boolean);
  if (managerProject(t.id)) return [label(t.id), "You"];
  const lead = t.parentId && managerProject(t.parentId) ? t.parentId : null;
  if (lead) return [`${t.providerName} worker`, label(lead), "You"];
  return null;
}

export function chainHTML(chain) {
  if (!chain || chain.length < 2) return "";
  return `<div class="item-chain">${chain.map((c, i) => `<span class="${i === chain.length - 1 ? "you" : ""}">${esc(c)}</span>`).join('<i aria-hidden="true">→</i>')}</div>`;
}

/** One dialog for setting up the Boss and assigning Managers. */
export function createTeamDialog({ post, toast, openThread, data }) {
  const dialog = document.createElement("dialog");
  dialog.className = "team-dialog";
  document.body.appendChild(dialog);
  let ctx = null;

  dialog.addEventListener("click", (e) => {
    if (e.target === dialog) dialog.close();
    const mode = e.target.closest("[data-mode]");
    if (mode) setMode(mode.dataset.mode);
    if (e.target.closest("[data-close]")) dialog.close();
  });
  dialog.addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = new FormData(dialog.querySelector("form"));
    const agent = ctx.agents[f.get("agent")];
    const body =
      ctx.kind === "boss"
        ? ctx.mode === "adopt"
          ? { action: "boss", mode: "adopt", threadId: f.get("thread") }
          : { action: "boss", mode: "new", projectId: ctx.noProject?.id ?? f.get("home"), ...(agent ? { provider: agent.provider, model: agent.model } : {}) }
        : ctx.mode === "adopt"
          ? { action: "manager", mode: "adopt", projectId: ctx.projectId, threadId: f.get("thread") }
          : { action: "manager", mode: "new", projectId: ctx.projectId, ...(agent ? { provider: agent.provider, model: agent.model } : {}) };
    const go = dialog.querySelector("[type=submit]");
    go.disabled = true;
    go.textContent = ctx.mode === "adopt" ? "Briefing…" : "Starting…";
    try {
      const out = await post("/api/team", body);
      dialog.close();
      toast(ctx.kind === "boss" ? "Your Boss is getting its brief" : `${ctx.projectTitle} has a Manager`);
      if (out.threadId) openThread(out.threadId);
    } catch (err) {
      toast(err.message);
      go.disabled = false;
      paint();
    }
  });

  function setMode(mode) {
    if (mode === ctx.mode) return;
    ctx.mode = mode;
    dialog.querySelectorAll(".seg-mini [data-mode]").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.mode === mode)));
    setTimeout(paint, matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 200);
  }

  function paint() {
    const { kind, mode, agents, candidates, homes, projectTitle } = ctx;
    const boss = kind === "boss";
    // Claude Team (Claude without the global skill library) first: Opus 5.5 works there.
    const team = agents.findIndex((a) => a.provider === "claudeTeam");
    const rec = boss ? (team >= 0 ? team : agents.findIndex((a) => /opus|fable/i.test(a.model))) : agents.findIndex((a) => a.provider === "codex" && a.model === "gpt-6.1-sol");
    const pick = rec >= 0 ? rec : 0;
    dialog.innerHTML = `<form method="dialog" class="td">
      <header><span class="role-ic ${boss ? "boss big" : "proj"}" ${boss ? "" : `style="--hue:${ctx.hue}"`}>${boss ? CROWN : esc(monogram(projectTitle))}</span>
        <div><h2>${boss ? "Set up your Boss" : `A Manager for ${esc(projectTitle)}`}</h2>
        <p>${boss ? "One thread that steers every project. Managers escalate to it; it only asks you about high-impact calls." : "Runs this project's workers, decides routine things itself, and escalates the rest to the Boss."}</p></div></header>
      <div class="seg-mini" role="tablist">
        <button type="button" role="tab" data-mode="new" aria-selected="${mode === "new"}">Start a new thread</button>
        <button type="button" role="tab" data-mode="adopt" aria-selected="${mode === "adopt"}" ${candidates.length ? "" : "disabled"}>Promote an existing thread</button>
      </div>
      ${mode === "new"
        ? `<label>Agent<select name="agent">${agents.length ? agents.map((a, i) => `<option value="${i}" ${i === pick ? "selected" : ""}>${esc(a.label)}${i === rec ? " — recommended" : ""}</option>`).join("") : `<option value="">Project default</option>`}</select></label>
           ${boss && ctx.noProject ? `<p class="td-home"><span>Lives in</span><b>No project</b><small>T3's home for work that isn't tied to one project — the Boss works across all of them.</small></p>` : ""}
           ${boss && !ctx.noProject ? `<label>Lives in project<select name="home">${homes.map((p) => `<option value="${esc(p.id)}" ${p.id === ctx.home ? "selected" : ""}>${esc(p.title)}</option>`).join("")}</select><small>Just where the thread sits in T3. The Boss works across every project.</small></label>` : ""}`
        : `<label>Thread<select name="thread">${candidates.map((t) => `<option value="${esc(t.id)}">${esc(truncate(t.title, 60))} · ${esc(t.providerName)}</option>`).join("")}</select><small>It keeps its history and gets a short role brief as its next message.</small></label>`}
      <ul class="td-facts">
        <li>Gets a short written brief: how to delegate, when to escalate, and never to merge.</li>
        <li>${boss ? "Pinned in T3 so it's easy to find there too." : "Workers it starts appear under this project on the map."}</li>
      </ul>
      <footer><button type="button" class="text-btn" data-close>Cancel</button><button type="submit" class="pill-btn">${mode === "adopt" ? "Promote and brief" : boss ? "Start the Boss" : "Start the Manager"}</button></footer>
    </form>`;
  }

  async function open(kind, projectId = null) {
    const d = data();
    let agents = [];
    try {
      const res = await fetch("/api/agents");
      agents = res.ok ? await res.json() : [];
    } catch {}
    const roleIds = new Set([d.team?.boss?.threadId, ...Object.values(d.team?.managers ?? {}).map((m) => m.threadId)].filter(Boolean));
    const live = [...d.threads.values()].filter((t) => t.visible && !roleIds.has(t.id) && !t.parentId);
    const noProject = [...d.projects.values()].find((p) => p.title === "No project" || /[\\/]\.t3[\\/]scratch[\\/]?$/i.test(p.root ?? "")) ?? null;
    const homes = [...d.projects.values()].filter((p) => !p.synthetic && p !== noProject).sort((a, b) => a.title.localeCompare(b.title));
    const busiest = [...homes].sort((a, b) => live.filter((t) => t.projectId === b.id).length - live.filter((t) => t.projectId === a.id).length)[0];
    const p = projectId ? d.projects.get(projectId) : null;
    ctx = {
      kind,
      projectId,
      projectTitle: p?.title ?? "",
      hue: p ? projectColor(p) : "",
      mode: "new",
      agents,
      homes,
      noProject,
      home: d.scope && d.projects.has(d.scope) ? d.scope : busiest?.id,
      candidates: kind === "boss" ? live : live.filter((t) => t.projectId === projectId),
    };
    paint();
    dialog.showModal();
  }

  return { open };
}

export async function teamAction(target, { post, toast, data, dialog, confirmRemove }) {
  const kind = target.dataset.team;
  if (kind === "boss") return dialog.open("boss");
  if (kind === "manager") return dialog.open("manager", target.dataset.project);
  if (kind === "level") {
    const d = data();
    const pid = target.dataset.project;
    if ((d.team?.autonomy?.[pid] ?? "normal") === target.dataset.level) return;
    try {
      await post("/api/team", { action: "autonomy", projectId: pid, level: target.dataset.level });
      toast(`${d.projects.get(pid)?.title ?? "Project"} Manager is now ${target.dataset.level}`);
    } catch (e) {
      toast(e.message);
    }
  }
  if (kind === "unassign") {
    const role = target.dataset.role;
    if (!(await confirmRemove(role === "boss" ? "Remove the Boss role? The thread stays in T3." : "Remove this Manager role? The thread stays in T3."))) return;
    try {
      await post("/api/team", { action: "unassign", role, projectId: target.dataset.project });
      toast("Role removed");
    } catch (e) {
      toast(e.message);
    }
  }
}
