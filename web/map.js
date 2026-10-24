// The living map: You at the centre, projects on an orbit, threads fanning out.
// Keyed SVG rendering, gliding layout, interactive links, real-event pulses.
// No per-frame app state: motion runs on refs + rAF.

import { esc, glyphBody, monogram, projectColor, reducedMotion, truncate } from "./ui.js";

const NS = "http://www.w3.org/2000/svg";
const MAX_PULSES = 12;
const SPEED = 0.42; // world px per ms
const R_YOU = 32;
const R_PROJECT = 26;
const R_QUIET = 11;
const R_THREAD = 15;
const R_SUB = 10;
const R_BOSS = 34;
const CROWN = "M-9 5.5V-3.5l4.5 4 4.5-7 4.5 7 4.5-4v9z";
const RANK = { needs: 0, failed: 1, working: 2, waiting: 2, reported: 3, idle: 4 };

const el = (tag, attrs = {}, parent) => {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  parent?.appendChild(e);
  return e;
};
const ease = (t) => 1 - Math.pow(1 - t, 3);
const f1 = (n) => n.toFixed(1);

export function createMap(stage, handlers) {
  const svg = stage.querySelector("#map");
  const world = svg.querySelector("#world");
  const defs = svg.querySelector("defs");
  const L = {
    rings: svg.querySelector("#rings"),
    links: svg.querySelector("#links"),
    pulses: svg.querySelector("#pulses"),
    nodes: svg.querySelector("#nodes"),
  };
  const dots = svg.querySelector(".map-dots");
  world.insertBefore(dots, world.firstChild);

  const nodes = new Map(); // key -> { g, sig, cur:{x,y,o}, to, leaving, pos }
  const links = new Map(); // key -> { g, base, flow, hit, grad, spec, d }
  let layout = { pos: new Map(), parentOf: new Map(), projectOf: new Map(), bounds: null, rings: {}, threadTotal: 0 };
  let model = null;
  let cam = { x: 0, y: 0, k: 1 };
  let camAnim = 0;
  let userMoved = false;
  let tween = 0;
  let gradSeq = 0;
  const pulses = [];
  let raf = 0;
  const lastTick = new Map();

  // ---------- layout ----------

  function computeLayout(m) {
    const pos = new Map();
    const projectOf = new Map();
    const parentOf = new Map();
    const { active, quiet, threadsByProject } = m;

    const n = active.length;
    const boss = Boolean(m.bossId);
    const R = n <= 1 ? 0 : Math.min(320, (boss ? 130 : 110) + n * 28);
    const rx = R * 1.4;
    const ry = R * 0.78;
    // With a Boss, You sit just above it, so no project takes the top spot.
    const start = boss ? (n === 2 ? 0 : -Math.PI / 2 + Math.PI / Math.max(1, n)) : n === 2 ? Math.PI : -Math.PI / 2;
    if (boss) {
      pos.set("boss", { x: 0, y: 0, r: R_BOSS, kind: "boss" });
      pos.set("you", { x: 0, y: -(R_BOSS + 64), r: 17, kind: "you", pill: true });
    } else pos.set("you", { x: 0, y: 0, r: R_YOU, kind: "you" });

    active.forEach((p, i) => {
      const a = start + (i * 2 * Math.PI) / Math.max(1, n);
      const single = boss ? Math.PI / 2 : -Math.PI / 2;
      const px = n === 1 ? 0 : Math.cos(a) * rx;
      const py = n === 1 ? Math.sin(single) * 190 : Math.sin(a) * ry;
      const dir = n === 1 ? single : a;
      const collapsed = m.collapsed.has(p.id);
      pos.set(p.id, { x: px, y: py, r: R_PROJECT, kind: "project", angle: dir, collapsed });
      if (collapsed) return;

      const threads = threadsByProject.get(p.id) ?? [];
      const ids = new Set(threads.map((t) => t.id));
      const kids = new Map();
      const roots = [];
      for (const t of threads) {
        projectOf.set(t.id, p.id);
        if (t.parentId && ids.has(t.parentId)) {
          parentOf.set(t.id, t.parentId);
          if (!kids.has(t.parentId)) kids.set(t.parentId, []);
          kids.get(t.parentId).push(t);
        } else roots.push(t);
      }
      const k = roots.length;
      const spread = Math.min(Math.PI * 0.95, Math.max(0, k - 1) * 0.5);
      roots.forEach((t, j) => {
        const ang = dir + (k === 1 ? 0 : -spread / 2 + (spread * j) / (k - 1));
        const vertical = Math.abs(Math.sin(dir)) > 0.7;
        const dist = (vertical ? 88 : 98) + (k > 5 && j % 2 ? 48 : 0);
        placeThread(t, px + Math.cos(ang) * dist, py + Math.sin(ang) * dist, ang, R_THREAD);
      });

      function placeThread(t, x, y, ang, r) {
        const children = kids.get(t.id) ?? [];
        pos.set(t.id, { x, y, r, kind: "thread", angle: ang, title: t.title, project: p.id, loud: t.state === "needs" || t.state === "failed", lead: children.length > 0 });
        const c = children.length;
        const sp = Math.min(Math.PI * 0.8, Math.max(0, c - 1) * 0.62);
        children.forEach((ch, j) => {
          const ca = ang + (c === 1 ? 0 : -sp / 2 + (sp * j) / (c - 1));
          placeThread(ch, x + Math.cos(ca) * 66, y + Math.sin(ca) * 66, ca, R_SUB);
        });
      }
    });

    const qn = quiet.length;
    const qrx = Math.max(rx + 250, 420);
    const qry = Math.max(ry + 170, 300);
    quiet.forEach((p, i) => {
      const a = -Math.PI / 2 + ((i + 0.5) * 2 * Math.PI) / Math.max(1, qn);
      pos.set(p.id, { x: Math.cos(a) * qrx, y: Math.sin(a) * qry, r: R_QUIET, kind: "quiet", angle: a });
    });

    const threadTotal = [...pos.values()].filter((p) => p.kind === "thread").length;
    const box = (filter, generous) => {
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const [key, p] of pos) {
        if (!filter(key, p)) continue;
        const side = p.kind === "thread" ? labelSide(p) : null;
        const room = p.kind === "thread" && (p.loud || generous || threadTotal <= 10) ? Math.min(26, p.title.length) * 6.9 + 14 : 64;
        minX = Math.min(minX, p.x - p.r - (side === "left" ? room : 64));
        maxX = Math.max(maxX, p.x + p.r + (side === "right" ? room : 64));
        minY = Math.min(minY, p.y - p.r - (side === "above" || p.kind === "project" ? 40 : 18));
        maxY = Math.max(maxY, p.y + p.r + 42);
      }
      return { minX, minY, maxX, maxY };
    };
    let bounds = box((key, p) => p.kind !== "quiet" || n === 0);
    if (n === 0) {
      bounds = { minX: Math.max(bounds.minX, -qrx * 0.75), maxX: Math.min(bounds.maxX, qrx * 0.75), minY: Math.max(bounds.minY, -qry * 0.75), maxY: Math.min(bounds.maxY, qry * 0.75) };
    }
    const teamBox = (id) => box((key, p) => key === id || p.project === id, true);
    return { pos, projectOf, parentOf, rings: { rx, ry, qrx, qry, hasQuiet: qn > 0, hasRing: n > 1 }, bounds, teamBox, threadTotal };
  }

  // Labels sit on the outward side: beside left/right fans, above/below otherwise.
  function labelSide(p) {
    const a = p.angle ?? 0;
    if (p.lead) return Math.sin(a) > 0.2 ? "below" : "above";
    if (Math.cos(a) > 0.6) return "right";
    if (Math.cos(a) < -0.6) return "left";
    return Math.sin(a) > 0 ? "below" : "above";
  }

  // ---------- rendering ----------

  function update(m) {
    model = m;
    layout = computeLayout(m);
    const { pos } = layout;

    L.rings.replaceChildren();
    if (layout.rings.hasRing) el("ellipse", { class: "ring", cx: 0, cy: 0, rx: layout.rings.rx, ry: layout.rings.ry }, L.rings);
    if (layout.rings.hasQuiet) el("ellipse", { class: "ring outer", cx: 0, cy: 0, rx: layout.rings.qrx, ry: layout.rings.qry }, L.rings);

    const live = new Set();
    const threadById = new Map(m.threads.map((t) => [t.id, t]));
    for (const [key, p] of pos) {
      live.add(key);
      let rec = nodes.get(key);
      if (!rec) {
        const g = el("g", { "data-key": key }, L.nodes);
        const from = spawnFrom(key, p);
        rec = { g, sig: "", cur: { x: from.x, y: from.y, o: 0 }, to: null, leaving: false };
        nodes.set(key, rec);
      }
      if (rec.leaving) rec.g.style.pointerEvents = "";
      rec.leaving = false;
      rec.pos = p;
      rec.to = { x: p.x, y: p.y, o: 1 };
      if (p.kind === "you") drawYou(rec, m);
      else if (p.kind === "boss") drawBoss(rec, m);
      else if (p.kind === "project") drawProject(rec, m.active.find((x) => x.id === key), p, m);
      else if (p.kind === "quiet") drawQuiet(rec, m.quiet.find((x) => x.id === key), m);
      else drawThread(rec, threadById.get(key), p, m);
    }
    for (const [key, rec] of nodes) {
      if (live.has(key) || rec.leaving) continue;
      rec.leaving = true;
      const home = nodes.get(rec.pos?.project)?.to ?? rec.cur;
      rec.to = { x: home.x, y: home.y, o: 0 };
      rec.g.style.pointerEvents = "none";
    }

    syncLinks(m);
    placeLabels(m);
    startTween();
    if (!userMoved && !camAnim) fit(false);
    applyLabels();
  }

  function spawnFrom(key, p) {
    if (p.kind === "thread") {
      const parent = layout.parentOf.get(key) ?? p.project;
      const rec = nodes.get(parent);
      if (rec) return rec.cur;
      const pp = layout.pos.get(parent);
      if (pp) return pp;
    }
    return p;
  }

  const dimmed = (projectId) => Boolean(model.focus) && projectId !== model.focus;

  function drawYou(rec, m) {
    const pill = Boolean(rec.pos?.pill);
    rec.g.setAttribute("class", `node you ${pill ? "pill" : ""} ${m.needsCount ? "needs" : ""} ${m.workingCount ? "working" : ""}`);
    rec.g.dataset.kind = "you";
    const sub = m.needsCount ? `${m.needsCount} need${m.needsCount === 1 ? "s" : ""} you` : m.workingCount ? `${m.workingCount} working` : "All quiet";
    if (rec.sig === sub + pill) return;
    rec.sig = sub + pill;
    if (pill) {
      const w = m.needsCount ? 92 : 70;
      rec.g.innerHTML = `
        <rect class="hit" x="${-w / 2 - 8}" y="-24" width="${w + 16}" height="48" rx="24"/>
        <rect class="aura" x="${-w / 2 - 5}" y="-21" width="${w + 10}" height="42" rx="21"/>
        <rect class="face" x="${-w / 2}" y="-16" width="${w}" height="32" rx="16" data-r="17"/>
        <circle class="you-dot" cx="${-w / 2 + 16}" cy="0" r="10"/>
        <path class="you-person" transform="translate(${-w / 2 + 16} 0)" d="M0 -5.2a2.6 2.6 0 1 1 0 5.2a2.6 2.6 0 1 1 0-5.2M-4.6 5.4c.5-2.6 2.4-4 4.6-4s4.1 1.4 4.6 4z"/>
        <text class="pill-text" x="${-w / 2 + 31}" y="0.5">You</text>
        ${m.needsCount ? `<g class="badge needs" transform="translate(${w / 2 - 15} 0)"><rect x="-9" y="-9" width="${m.needsCount > 9 ? 24 : 18}" height="18" rx="9"/><text x="${m.needsCount > 9 ? 3 : 0}" y="0.5">${m.needsCount}</text></g>` : ""}`;
      return;
    }
    rec.g.innerHTML = `
      <circle class="hit" r="${R_YOU + 10}"/>
      <circle class="aura" r="${R_YOU + 14}"/>
      <circle class="orbit" r="${R_YOU + 8}"/>
      <circle class="face" r="${R_YOU}"/>
      <text class="mono" y="0.5">You</text>
      <text class="sub ${m.needsCount ? "hot" : ""}" y="${R_YOU + 23}">${esc(sub)}</text>`;
  }

  function drawBoss(rec, m) {
    const t = m.boss;
    const state = t?.state ?? "idle";
    rec.g.setAttribute("class", `node boss ${state}`);
    rec.g.dataset.kind = "boss";
    rec.g.dataset.id = m.bossId;
    const sub = state === "needs" ? "needs you" : state === "working" || state === "waiting" ? `working · ${t.providerName}` : state === "failed" ? "hit a problem" : t?.providerName ?? "";
    const sig = [state, sub].join("|");
    if (rec.sig === sig) return;
    rec.sig = sig;
    const r = R_BOSS;
    const arc = 2 * Math.PI * (r + 5);
    rec.g.innerHTML = `
      <circle class="hit" r="${r + 12}"/>
      <circle class="aura" r="${r + 14}"/>
      <circle class="orbit" r="${r + 9}"/>
      <circle class="spin" r="${r + 5}" stroke-dasharray="${f1(arc * 0.2)} ${f1(arc)}"/>
      <circle class="face" r="${r}"/>
      <path class="crown" transform="translate(0 -6) scale(1.15)" d="${CROWN}"/>
      <text class="boss-word" y="13">Boss</text>
      ${state === "needs" ? `<g class="badge needs" transform="translate(${f1(r * 0.74)} ${f1(-r * 0.74)})"><rect x="-9" y="-9" width="18" height="18" rx="9"/><text y="0.5">!</text></g>` : ""}
      <text class="sub ${state === "needs" ? "hot" : ""}" y="${r + 22}">${esc(sub)}</text>`;
  }

  function drawProject(rec, p, pos, m) {
    const s = m.projectState.get(p.id) ?? {};
    const total = (m.threadsByProject.get(p.id) ?? []).length;
    const state = s.needs ? "needs" : s.failed ? "failed" : s.working ? "working" : s.reported ? "reported" : "idle";
    const focused = m.focus === p.id;
    rec.g.setAttribute("class", `node project ${state} ${pos.collapsed ? "collapsed" : ""} ${dimmed(p.id) ? "dim" : ""} ${focused ? "focused" : ""}`);
    rec.g.dataset.kind = "project";
    rec.g.dataset.id = p.id;
    rec.g.style.setProperty("--hue", projectColor(p));
    const parts = [];
    if (s.needs) parts.push(`${s.needs} need${s.needs === 1 ? "s" : ""} you`);
    if (s.working) parts.push(`${s.working} working`);
    if (s.failed) parts.push(`${s.failed} failed`);
    if (s.reported) parts.push(`${s.reported} to read`);
    const sub = pos.collapsed ? `${total} thread${total === 1 ? "" : "s"} folded${parts[0] ? ` · ${parts[0]}` : ""}` : parts.slice(0, 2).join(" · ") || "idle";
    const badgeN = s.needs || s.working || 0;
    const r = R_PROJECT;
    // Labels go on the side away from the team's fan.
    const down = !pos.collapsed && Math.sin(pos.angle) > 0.5;
    const ly = down ? -r - 30 : r + 20;
    const sy = down ? -r - 15 : r + 35;
    const mgr = m.managers?.get(p.id) ?? null;
    const sig = [p.title, sub, state, badgeN, pos.collapsed, total, focused, down, mgr?.id, mgr?.state, mgr?.provider].join("|");
    if (rec.sig === sig) return;
    rec.sig = sig;
    const shown = Math.min(total, 12);
    const dotsAround = pos.collapsed
      ? Array.from({ length: shown }, (_, i) => {
          const a = -Math.PI / 2 + (i * 2 * Math.PI) / shown;
          return `<circle class="tdot" cx="${f1(Math.cos(a) * (r + 8))}" cy="${f1(Math.sin(a) * (r + 8))}" r="2"/>`;
        }).join("")
      : "";
    rec.g.innerHTML = `
      <circle class="hit" r="${r + 12}" role="button" tabindex="0" aria-label="Chat with ${esc(p.title)} Manager" data-project-chat="${esc(p.id)}"/>
      <circle class="aura" r="${r + 10}"/>
      <circle class="ring-state" r="${r + 4.5}"/>
      ${dotsAround}
      <circle class="face" r="${r}"/>
      <circle class="tint" r="${r - 5}"/>
      <text class="mono" y="0.5">${esc(monogram(p.title))}</text>
      ${badgeN ? `<g class="badge ${s.needs ? "needs" : "working"}" transform="translate(${f1(r * 0.74)} ${f1(-r * 0.74)})"><rect x="-9" y="-9" width="${badgeN > 9 ? 24 : 18}" height="18" rx="9"/><text x="${badgeN > 9 ? 3 : 0}" y="0.5">${badgeN}</text></g>` : ""}
      ${mgr ? `<g class="mgr ${mgr.state}" data-thread="${esc(mgr.id)}" transform="translate(${f1(r * 0.8)} ${f1(r * 0.8)})"><title>Manager: ${esc(mgr.title)} — open the conversation</title>
        <circle class="mgr-hit" r="13"/><circle class="mgr-spin" r="12" stroke-dasharray="${f1(2 * Math.PI * 12 * 0.25)} ${f1(2 * Math.PI * 12)}"/><circle class="mgr-face" r="10"/>
        <g transform="translate(-5.6 -5.6) scale(0.7)" class="glyph">${glyphBody(mgr.provider)}</g></g>` : ""}
      <g class="zbtn" data-zoom="${esc(p.id)}" transform="translate(${f1(-r * 0.78)} ${f1(-r * 0.78)})">
        <title>${focused ? "Zoom back out" : `Zoom into ${esc(p.title)}`}</title>
        <circle r="10"/>
        <path d="${focused ? "M-3.5 0h7" : "M-3.5 0h7M0 -3.5v7"}"/>
      </g>
      <g class="zbtn foldbtn" role="button" tabindex="0" aria-label="${pos.collapsed ? "Unfold" : "Fold"} ${esc(p.title)} threads" data-fold="${esc(p.id)}" transform="translate(${f1(-r * 0.78)} ${f1(r * 0.78)})">
        <title>${pos.collapsed ? "Unfold" : "Fold"} threads</title><circle r="10"/><path d="M-3.5 0h7${pos.collapsed ? "M0 -3.5v7" : ""}"/>
      </g>
      <text class="label" y="${ly}">${esc(truncate(p.title, 26))}</text>
      <text class="sub" y="${sy}">${esc(sub)}</text>`;
  }

  function drawQuiet(rec, p, m) {
    rec.g.setAttribute("class", `node quiet ${m.focus ? "dim" : ""}`);
    rec.g.dataset.kind = "quiet";
    rec.g.dataset.id = p.id;
    rec.g.style.setProperty("--hue", projectColor(p));
    if (rec.sig === p.title) return;
    rec.sig = p.title;
    rec.g.innerHTML = `
      <circle class="hit" r="${R_QUIET + 10}" role="button" tabindex="0" aria-label="Chat with ${esc(p.title)} Manager" data-project-chat="${esc(p.id)}"/>
      <circle class="face" r="${R_QUIET}"/>
      <text class="mono" y="0.5">${esc(monogram(p.title).slice(0, 2))}</text>
      <text class="label" y="${R_QUIET + 16}">${esc(truncate(p.title, 18))}</text>`;
  }

  function drawThread(rec, t, pos, m) {
    if (!t) return;
    rec.g.setAttribute("class", `node thread ${t.state} ${pos.r === R_SUB ? "subagent" : ""} ${dimmed(pos.project) ? "dim" : ""} ${m.selected === t.id ? "selected" : ""}`);
    rec.g.dataset.kind = "thread";
    rec.g.dataset.id = t.id;
    const r = pos.r;
    const side = labelSide(pos);
    const [lx, ly, sx, sy, anchor] =
      side === "right" ? [r + 10, -2, r + 10, 12, "start"]
      : side === "left" ? [-r - 10, -2, -r - 10, 12, "end"]
      : side === "below" ? [0, r + 16, 0, r + 29, "middle"]
      : [0, -r - 19, 0, -r - 6, "middle"];
    const sub = t.state === "idle" ? t.providerName : `${t.providerName} · ${stateWord(t)}`;
    const sig = [t.state, t.title, r, sub, side].join("|");
    if (rec.sig === sig) return;
    rec.sig = sig;
    const s = (r / 8) * 0.7;
    const arc = 2 * Math.PI * (r + 4);
    rec.g.innerHTML = `
      <circle class="hit" r="${r + 9}"/>
      <circle class="aura" r="${r + 7}"/>
      <circle class="spin" r="${r + 4}" stroke-dasharray="${f1(arc * 0.24)} ${f1(arc)}"/>
      <circle class="face" r="${r}"/>
      <g transform="translate(${f1(-8 * s)} ${f1(-8 * s)}) scale(${s.toFixed(3)})" class="glyph">${glyphBody(t.provider)}</g>
      ${t.state === "reported" ? `<circle class="pip" cx="${f1(r * 0.72)}" cy="${f1(-r * 0.72)}" r="3.4"/>` : ""}
      <text class="label" x="${lx}" y="${ly}" style="text-anchor:${anchor}">${esc(truncate(t.title, side === "left" || side === "right" ? 26 : 30))}</text>
      <text class="sub" x="${sx}" y="${sy}" style="text-anchor:${anchor}">${esc(sub)}</text>`;
  }

  function stateWord(t) {
    return { needs: "needs you", failed: "failed", working: "working", waiting: "waiting", reported: "to read" }[t.state] ?? "";
  }

  // Keep thread labels from colliding: the most important thread keeps its label.
  function placeLabels(m) {
    const boxes = [];
    const hit = (b) => boxes.some((o) => b.x < o.x + o.w && b.x + b.w > o.x && b.y < o.y + o.h && b.y + b.h > o.y);
    for (const [, p] of layout.pos) {
      boxes.push({ x: p.x - p.r, y: p.y - p.r, w: p.r * 2, h: p.r * 2 });
      if (p.kind === "project" || p.kind === "you") {
        const down = p.kind === "project" && !p.collapsed && Math.sin(p.angle) > 0.5;
        boxes.push({ x: p.x - 72, y: down ? p.y - p.r - 44 : p.y + p.r + 4, w: 144, h: 38 });
      }
    }
    const threads = m.threads.filter((t) => layout.pos.has(t.id)).sort((a, b) => (RANK[a.state] ?? 5) - (RANK[b.state] ?? 5));
    for (const t of threads) {
      const rec = nodes.get(t.id);
      const p = layout.pos.get(t.id);
      if (!rec || !p) continue;
      const side = labelSide(p);
      const w = Math.min(side === "left" || side === "right" ? 26 : 30, t.title.length) * 6.9 + 8;
      const b =
        side === "right" ? { x: p.x + p.r + 6, y: p.y - 15, w, h: 32 }
        : side === "left" ? { x: p.x - p.r - 6 - w, y: p.y - 15, w, h: 32 }
        : side === "below" ? { x: p.x - w / 2, y: p.y + p.r + 3, w, h: 30 }
        : { x: p.x - w / 2, y: p.y - p.r - 32, w, h: 30 };
      const clash = hit(b);
      rec.g.classList.toggle("label-off", clash);
      if (!clash) boxes.push(b);
    }
  }

  // ---------- links ----------

  function syncLinks(m) {
    const want = new Map();
    const hub = m.bossId ? "boss" : "you";
    if (m.bossId) {
      const st = m.boss?.state;
      want.set("you>boss", { kind: "trunk command", from: "you", to: "boss", state: st === "needs" ? "needs" : st === "working" || st === "waiting" ? "working" : "", width: 2, project: null, boss: true });
    }
    for (const p of m.active) {
      const s = m.projectState.get(p.id) ?? {};
      const state = s.needs ? "needs" : s.working ? "working" : s.failed ? "failed" : "";
      want.set(`${hub}>${p.id}`, { kind: "trunk", from: hub, to: p.id, state, width: m.widths.get(p.id) ?? 1.25, project: p.id });
    }
    for (const p of m.quiet) want.set(`${hub}>${p.id}`, { kind: "trunk quiet", from: hub, to: p.id, state: "", width: 1, project: p.id, quiet: true });
    for (const t of m.threads) {
      if (!layout.pos.has(t.id)) continue;
      const parent = layout.parentOf.get(t.id);
      const from = parent ?? t.projectId;
      const st = t.state === "needs" ? "needs" : t.state === "working" || t.state === "waiting" ? "working" : t.state === "failed" ? "failed" : t.state === "reported" ? "reported" : "";
      want.set(`${from}>${t.id}`, { kind: parent ? "sub" : "branch", from, to: t.id, state: st, width: parent ? 1 : 1.3, project: t.projectId, thread: t.id });
    }
    for (const [key, spec] of want) {
      let l = links.get(key);
      if (!l) {
        const g = el("g", { "data-link": key }, L.links);
        l = { g, d: "" };
        if (spec.kind === "trunk" || spec.kind === "trunk command") {
          l.gradId = `lg${++gradSeq}`;
          l.grad = el("linearGradient", { id: l.gradId, gradientUnits: "userSpaceOnUse" }, defs);
          el("stop", { offset: "0", class: "g0" }, l.grad);
          el("stop", { offset: "1", class: "g1" }, l.grad);
        }
        l.base = el("path", { class: "l-base" }, g);
        if (l.gradId) l.base.style.stroke = `url(#${l.gradId})`;
        l.flow = el("path", { class: "l-flow" }, g);
        l.hit = el("path", { class: "l-hit" }, g);
        links.set(key, l);
        l.hit.addEventListener("pointerenter", (e) => linkHover(key, e));
        l.hit.addEventListener("pointermove", (e) => linkHover(key, e));
        l.hit.addEventListener("pointerleave", () => linkHover(null));
        l.hit.addEventListener("click", (e) => {
          e.stopPropagation();
          const sp = links.get(key)?.spec;
          if (sp) handlers.onLinkClick?.(sp);
        });
      }
      l.spec = spec;
      const dim = spec.boss ? false : spec.quiet ? Boolean(model.focus) : dimmed(spec.project);
      l.g.setAttribute("class", `link ${spec.kind} ${spec.state} ${dim ? "dim" : ""} ${hovered === key ? "hover" : ""}`);
      l.grad?.setAttribute("class", `grad ${spec.state}`);
      l.base.style.strokeWidth = `${spec.width}px`;
    }
    for (const [key, l] of links) {
      if (want.has(key)) continue;
      l.g.remove();
      l.grad?.remove();
      links.delete(key);
    }
  }

  let hovered = null;
  function linkHover(key, e) {
    if (hovered && hovered !== key) {
      links.get(hovered)?.g.classList.remove("hover");
      svg.querySelectorAll(".node.link-end").forEach((n) => n.classList.remove("link-end"));
    }
    hovered = key;
    if (!key) return handlers.onLinkHover?.(null);
    const l = links.get(key);
    if (!l) return;
    l.g.classList.add("hover");
    for (const end of [l.spec.from, l.spec.to]) nodes.get(end)?.g.classList.add("link-end");
    handlers.onHover?.(null);
    handlers.onLinkHover?.({ ...l.spec, key, x: e.clientX, y: e.clientY });
  }

  function edge(p, tx, ty, gap) {
    const dx = tx - p.x;
    const dy = ty - p.y;
    const d = Math.hypot(dx, dy) || 1;
    return [p.x + (dx / d) * (p.r + gap), p.y + (dy / d) * (p.r + gap)];
  }

  // A gentle arc between two nodes, bending the same way everywhere.
  function arcPath(a, b, bend) {
    const mx = (a.x + b.x) / 2;
    const my = (a.y + b.y) / 2;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy) || 1;
    const amt = Math.min(bend.max, len * bend.ratio);
    const cx = mx - (dy / len) * amt;
    const cy = my + (dx / len) * amt;
    const [sx, sy] = edge(a, cx, cy, bend.gapA);
    const [ex, ey] = edge(b, cx, cy, bend.gapB);
    return { d: `M${f1(sx)} ${f1(sy)}Q${f1(cx)} ${f1(cy)} ${f1(ex)} ${f1(ey)}`, sx, sy, ex, ey };
  }

  function drawLinks() {
    for (const l of links.values()) {
      const a = nodes.get(l.spec.from);
      const b = nodes.get(l.spec.to);
      if (!a?.pos || !b?.pos) continue;
      const trunk = l.spec.kind.startsWith("trunk");
      const res = arcPath(
        { ...a.cur, r: a.pos.r },
        { ...b.cur, r: b.pos.r },
        trunk ? { max: 56, ratio: 0.12, gapA: 12, gapB: 8 } : { max: 16, ratio: 0.16, gapA: 7, gapB: 6 },
      );
      if (res.d === l.d) continue;
      l.d = res.d;
      l.base.setAttribute("d", res.d);
      l.flow.setAttribute("d", res.d);
      l.hit.setAttribute("d", res.d);
      if (l.grad) {
        l.grad.setAttribute("x1", f1(res.sx));
        l.grad.setAttribute("y1", f1(res.sy));
        l.grad.setAttribute("x2", f1(res.ex));
        l.grad.setAttribute("y2", f1(res.ey));
      }
    }
  }

  // ---------- motion ----------

  function placeNodes() {
    for (const rec of nodes.values()) {
      rec.g.setAttribute("transform", `translate(${f1(rec.cur.x)} ${f1(rec.cur.y)})`);
      rec.g.style.opacity = rec.cur.o.toFixed(3);
    }
  }

  function startTween() {
    const from = new Map([...nodes].map(([k, r]) => [k, { ...r.cur }]));
    const instant = reducedMotion();
    const t0 = performance.now();
    const ms = 460;
    let done = false;
    const step = (now) => {
      if (done) return;
      const p = instant ? 1 : Math.min(1, (now - t0) / ms);
      const e = ease(p);
      for (const [key, rec] of nodes) {
        const a = from.get(key) ?? rec.cur;
        const b = rec.to ?? rec.cur;
        rec.cur = { x: a.x + (b.x - a.x) * e, y: a.y + (b.y - a.y) * e, o: a.o + (b.o - a.o) * e };
      }
      placeNodes();
      drawLinks();
      if (p < 1) {
        tween = requestAnimationFrame(step);
        return;
      }
      done = true;
      for (const [key, rec] of nodes) if (rec.leaving) (rec.g.remove(), nodes.delete(key));
    };
    cancelAnimationFrame(tween);
    tween = requestAnimationFrame(step);
    // Throttled pages may never paint; settle on the target anyway.
    clearTimeout(startTween.guard);
    startTween.guard = setTimeout(() => step(t0 + ms + 1), ms + 200);
    if (instant) step(t0);
  }

  // ---------- camera ----------

  function size() {
    const r = svg.getBoundingClientRect();
    return { w: r.width || 1, h: r.height || 1, r };
  }

  function apply() {
    world.setAttribute("transform", `translate(${cam.x.toFixed(2)} ${cam.y.toFixed(2)}) scale(${cam.k.toFixed(4)})`);
    applyLabels();
    handlers.onCamera?.(cam);
  }

  function applyLabels() {
    svg.classList.toggle("show-labels", cam.k >= 1.2 || Boolean(model?.focus) || layout.threadTotal <= 10);
  }

  function frame(b, { padTop = 30, padX = 40, maxK = 1.6 } = {}) {
    const { w, h, r } = size();
    const overlay = handlers.bottomOverlay?.()?.getBoundingClientRect();
    const padBottom = overlay && overlay.height ? Math.max(24, r.bottom - overlay.top + 16) : 40;
    const bw = Math.max(1, b.maxX - b.minX);
    const bh = Math.max(1, b.maxY - b.minY);
    const k = Math.max(0.3, Math.min(maxK, (w - padX * 2) / bw, (h - padTop - padBottom) / bh));
    const cx = (b.minX + b.maxX) / 2;
    const cy = (b.minY + b.maxY) / 2;
    return { k, x: w / 2 - cx * k, y: padTop + (h - padTop - padBottom) / 2 - cy * k };
  }

  function animateTo(target, ms = 650) {
    cancelAnimationFrame(camAnim);
    if (reducedMotion()) {
      cam = target;
      camAnim = 0;
      return apply();
    }
    const from = { ...cam };
    const t0 = performance.now();
    const step = (now) => {
      const p = Math.min(1, (now - t0) / ms);
      const e = 1 - Math.pow(1 - p, 4);
      cam = { x: from.x + (target.x - from.x) * e, y: from.y + (target.y - from.y) * e, k: from.k + (target.k - from.k) * e };
      apply();
      camAnim = p < 1 ? requestAnimationFrame(step) : 0;
    };
    camAnim = requestAnimationFrame(step);
    clearTimeout(animateTo.guard);
    animateTo.guard = setTimeout(() => {
      if (!camAnim) return;
      cancelAnimationFrame(camAnim);
      camAnim = 0;
      cam = target;
      apply();
    }, ms + 150);
  }

  function fit(animate = true) {
    if (!layout.bounds || !Number.isFinite(layout.bounds.minX)) return;
    userMoved = false;
    const t = frame(layout.bounds);
    animate ? animateTo(t) : ((cam = t), apply());
  }

  function focusOn(projectId) {
    const b = layout.teamBox?.(projectId);
    if (!b || !Number.isFinite(b.minX)) return;
    userMoved = true;
    animateTo(frame({ minX: b.minX - 20, maxX: b.maxX + 20, minY: b.minY - 10, maxY: b.maxY + 10 }, { maxK: 1.45 }));
  }

  function zoomBy(f, cx, cy) {
    const { w, h } = size();
    cx ??= w / 2;
    cy ??= h / 2;
    const k = Math.max(0.25, Math.min(4, cam.k * f));
    const r = k / cam.k;
    cam = { k, x: cx - (cx - cam.x) * r, y: cy - (cy - cam.y) * r };
    userMoved = true;
    cancelAnimationFrame(camAnim);
    camAnim = 0;
    apply();
  }

  // ---------- input ----------

  let drag = null;
  svg.addEventListener("pointerdown", (e) => {
    if (e.button !== 0 || e.target.closest(".l-hit")) return;
    drag = { x: e.clientX, y: e.clientY, cx: cam.x, cy: cam.y, moved: false, target: e.target };
    svg.setPointerCapture(e.pointerId);
  });
  svg.addEventListener("pointermove", (e) => {
    if (!drag) return hover(e);
    const dx = e.clientX - drag.x;
    const dy = e.clientY - drag.y;
    if (!drag.moved && Math.hypot(dx, dy) < 4) return;
    drag.moved = true;
    svg.classList.add("dragging");
    handlers.onHover?.(null);
    cancelAnimationFrame(camAnim);
    camAnim = 0;
    userMoved = true;
    cam = { ...cam, x: drag.cx + dx, y: drag.cy + dy };
    apply();
  });

  let pending = null;
  svg.addEventListener("pointerup", () => {
    const d = drag;
    drag = null;
    svg.classList.remove("dragging");
    if (!d || d.moved) return;
    const fold = d.target.closest?.(".foldbtn");
    if (fold) return handlers.onToggle?.(fold.dataset.fold);
    const zoom = d.target.closest?.(".zbtn");
    if (zoom) return handlers.onZoom?.(zoom.dataset.zoom);
    const mgr = d.target.closest?.(".mgr");
    if (mgr) return handlers.onThread?.(mgr.dataset.thread);
    const n = d.target.closest?.(".node");
    if (!n) return handlers.onBackground?.();
    const kind = n.dataset.kind;
    if (kind === "you") return handlers.onBackground?.(true);
    if (kind === "boss") return handlers.onThread?.(n.dataset.id);
    if (kind === "quiet") return handlers.onChip?.(n.dataset.id);
    if (kind === "thread") return handlers.onThread?.(n.dataset.id);
    if (kind === "project") {
      // One click chats with the Manager; a quick second click zooms into the team.
      const id = n.dataset.id;
      if (pending?.id === id) {
        clearTimeout(pending.t);
        pending = null;
        return handlers.onZoom?.(id);
      }
      clearTimeout(pending?.t);
      pending = { id, t: setTimeout(() => ((pending = null), handlers.onProject?.(id)), 230) };
    }
  });
  svg.addEventListener("keydown", (e) => {
    if (!["Enter", " "].includes(e.key)) return;
    const target = e.target.closest?.("[data-project-chat], [data-fold]");
    if (!target) return;
    e.preventDefault();
    if (target.dataset.fold) handlers.onToggle?.(target.dataset.fold);
    else handlers.onProject?.(target.dataset.projectChat);
  });
  svg.addEventListener("pointerleave", () => handlers.onHover?.(null));
  svg.addEventListener("wheel", (e) => {
    e.preventDefault();
    const r = svg.getBoundingClientRect();
    zoomBy(Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0016)), e.clientX - r.left, e.clientY - r.top);
  }, { passive: false });

  let hoverKey = null;
  function hover(e) {
    if (e.target.closest?.(".l-hit")) return;
    const n = e.target.closest?.(".node");
    const mgr = e.target.closest?.(".mgr");
    const key = mgr ? `mgr:${mgr.dataset.thread}` : n && !e.target.closest(".zbtn") ? n.dataset.key : null;
    if (key === hoverKey) return;
    hoverKey = key;
    if (mgr) return handlers.onHover?.({ kind: "thread", id: mgr.dataset.thread, rect: mgr.querySelector(".mgr-face").getBoundingClientRect() });
    if (n?.dataset.kind === "boss") return handlers.onHover?.({ kind: "thread", id: n.dataset.id, rect: n.querySelector(".face").getBoundingClientRect() });
    if (!key || n.dataset.kind === "you") return handlers.onHover?.(null);
    handlers.onHover?.({ kind: n.dataset.kind === "quiet" ? "project" : n.dataset.kind, id: n.dataset.id, rect: n.querySelector(".face").getBoundingClientRect() });
  }

  new ResizeObserver(() => {
    if (!userMoved) fit(false);
  }).observe(svg);

  // ---------- pulses ----------

  function linkInto(key) {
    for (const [k, l] of links) if (l.spec.to === key) return k;
    return null;
  }

  function chainUp(id) {
    const out = [];
    let cur = id;
    for (let guard = 0; guard < 8; guard++) {
      const k = linkInto(cur);
      if (!k) break;
      out.push([k, true]);
      cur = links.get(k).spec.from;
      if (cur === "you") break;
    }
    return out;
  }

  // A thread that isn't drawn (folded project) routes from its project.
  const drawnOr = (threadId, projectId) =>
    threadId && threadId === model?.bossId ? "boss" : nodes.has(threadId) && !nodes.get(threadId).leaving ? threadId : projectId;

  function route(ev) {
    const { from, to } = ev;
    if (to === "you") return chainUp(drawnOr(from, ev.projectId));
    if (from === "you") return chainUp(drawnOr(to, ev.projectId)).reverse().map(([k]) => [k, false]);
    if (links.has(`${from}>${to}`)) return [[`${from}>${to}`, false]];
    if (links.has(`${to}>${from}`)) return [[`${to}>${from}`, true]];
    return [];
  }

  function pulse(ev) {
    if (reducedMotion() || document.hidden) return;
    if (model?.focus && ev.projectId !== model.focus && ev.threadId !== model.bossId) return;
    if (ev.type === "work") return tick(drawnOr(ev.from, ev.projectId));
    const color = ev.type;
    flash(drawnOr(ev.type === "call" ? ev.to : ev.from, ev.projectId), color);
    const segs = route(ev).map(([k, rev]) => [links.get(k)?.base, rev]).filter(([p]) => p && p.getAttribute("d"));
    if (!segs.length) return;
    const key = segs.map(([p]) => p.parentNode.dataset.link).join("|") + color;
    const now = performance.now();
    if (pulses.some((p) => p.key === key && now - p.t0 < 320) || pulses.length >= MAX_PULSES) return;
    const lens = segs.map(([p]) => p.getTotalLength());
    const total = lens.reduce((a, b) => a + b, 0);
    const dur = Math.max(650, Math.min(2400, total / SPEED));
    for (const [p] of segs) p.parentNode.classList.add(`carry-${color}`);
    const glow = el("circle", { class: `pulse-glow ${color}`, r: 9 }, L.pulses);
    const tail = el("circle", { class: `pulse ${color}`, r: 2.6, opacity: 0.4 }, L.pulses);
    const dot = el("circle", { class: `pulse ${color}`, r: 4 }, L.pulses);
    pulses.push({ key, t0: now, dur, segs, lens, total, dot, tail, glow, color, end: ev.to === "you" ? "you" : null });
    if (!raf) raf = requestAnimationFrame(loop);
  }

  function pointAt(p, d) {
    let acc = 0;
    for (let i = 0; i < p.segs.length; i++) {
      const len = p.lens[i];
      if (d <= acc + len || i === p.segs.length - 1) {
        const [path, rev] = p.segs[i];
        const local = Math.max(0, Math.min(len, d - acc));
        return path.getPointAtLength(rev ? len - local : local);
      }
      acc += len;
    }
    return { x: 0, y: 0 };
  }

  function loop(now) {
    for (let i = pulses.length - 1; i >= 0; i--) {
      const p = pulses[i];
      const t = Math.min(1, (now - p.t0) / p.dur);
      const e = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
      const d = e * p.total;
      const a = pointAt(p, d);
      const b = pointAt(p, Math.max(0, d - 12));
      const fade = t > 0.86 ? (1 - t) / 0.14 : Math.min(1, t * 8);
      for (const c of [p.dot, p.glow]) (c.setAttribute("cx", a.x), c.setAttribute("cy", a.y));
      p.tail.setAttribute("cx", b.x);
      p.tail.setAttribute("cy", b.y);
      p.dot.setAttribute("opacity", fade);
      p.glow.setAttribute("opacity", fade * 0.3);
      if (t >= 1) {
        p.dot.remove();
        p.tail.remove();
        p.glow.remove();
        pulses.splice(i, 1);
        for (const [path] of p.segs) path.parentNode?.classList.remove(`carry-${p.color}`);
        if (p.end) flash("you", p.color);
      }
    }
    raf = pulses.length ? requestAnimationFrame(loop) : 0;
  }

  function flash(key, color) {
    const rec = nodes.get(key);
    if (!rec) return;
    const cls = `flash-${color}`;
    rec.g.classList.add(cls);
    setTimeout(() => rec.g.classList.remove(cls), 750);
    ping(rec.g, color);
  }

  function tick(key) {
    const now = performance.now();
    if (now - (lastTick.get(key) ?? 0) < 1600) return;
    lastTick.set(key, now);
    const rec = nodes.get(key);
    if (rec) ping(rec.g, "work");
  }

  function ping(g, color) {
    const face = g.querySelector(".face");
    if (!face) return;
    const stroke = { call: "var(--blue)", answer: "var(--green)", needs: "var(--amber)", failed: "var(--red)", work: "var(--blue)" }[color];
    const c = el("circle", { class: "ping", r: face.getAttribute("r") ?? face.dataset.r ?? 18, stroke, opacity: color === "work" ? 0.45 : 0.9 });
    g.insertBefore(c, face);
    setTimeout(() => c.remove(), 950);
  }

  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) return;
    for (const p of pulses) (p.dot.remove(), p.tail.remove(), p.glow.remove());
    pulses.length = 0;
  });

  return {
    update,
    pulse,
    fit: () => fit(true),
    focusOn,
    zoomIn: () => zoomBy(1.25),
    zoomOut: () => zoomBy(0.8),
  };
}
