// Mission deck: one project's team as a live control deck.
// The Manager sits at the hub; threads sit in sectors by state (needs you up,
// in flight right, landed left, parked down). Everything shown is real T3 state.

import { STATE_LABEL, ago, clock, esc, glyph, glyphBody, markdown, monogram, prLabel, prLive, projectColor, reducedMotion, truncate } from "./ui.js";

const NS = "http://www.w3.org/2000/svg";
const SECTOR = { needs: "up", failed: "up", working: "right", waiting: "right", reported: "left", idle: "down" };
const DIR = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] };
const RANK = { needs: 0, failed: 1, working: 2, waiting: 2, reported: 3, idle: 4 };
const POD_W = 214;
const POD_H = 60;
const HUB_R = 46;
const WINDOW = 3 * 3600_000;
const DAY = 24 * 3600_000;
const WINDOWS = [15, 30, 60, 120, 180, 360, 720, 1440].map((m) => m * 60_000);
const dur = (ms) => (ms < 3600_000 ? `${Math.round(ms / 60_000)}m` : `${+(ms / 3600_000).toFixed(1)}h`);
const MAX_LANES = 10;
const E = "cubic-bezier(.7,0,.2,1)";
const EO = "cubic-bezier(.16,1,.3,1)";
const TICK = { call: "var(--blue)", answer: "var(--green)", needs: "var(--amber)", failed: "var(--red)" };
const f1 = (n) => Number(n).toFixed(1);

export function createDeck(stage, h) {
  const root = stage.querySelector("#deck");
  root.innerHTML = `
    <div class="dk-cam">
      <div class="dk-world">
        <div class="dk-sweep"></div>
        <svg class="dk-svg" viewBox="-2000 -2000 4000 4000" width="4000" height="4000" aria-hidden="true">
          <g class="dk-rings"></g><g class="dk-edges"></g><g class="dk-packets"></g><g class="dk-pulses"></g>
        </svg>
        <div class="dk-secs" aria-hidden="true">
          <span data-sec="up">▲ Needs you</span><span data-sec="right">In flight ▶</span><span data-sec="left">◀ Landed</span><span data-sec="down">▼ Parked</span>
        </div>
        <div class="dk-beacon" hidden><i>You</i><span>via Manager → Boss</span></div>
        <button type="button" class="dk-hub"></button>
        <div class="dk-pods"></div>
        <div class="dk-empty" hidden>No threads yet.<br>Tell the Manager what you want below.</div>
      </div>
    </div>
    <div class="dk-hud">
      <button type="button" class="dk-back" data-dk="back">‹ All projects <kbd>Esc</kbd></button>
      <div class="dk-name"><i></i><span></span></div>
      <div class="dk-stats"></div>
    </div>
    <div class="dk-clock"></div>
    <div class="dk-card" role="dialog" aria-label="Thread details" hidden></div>
    <div class="dk-rec" aria-label="Flight recorder"></div>
    <div class="dk-fx" aria-hidden="true"><div class="dk-warp"></div><div class="dk-streaks"></div></div>`;

  const q = (s) => root.querySelector(s);
  const cam = q(".dk-cam");
  const world = q(".dk-world");
  const G = { rings: q(".dk-rings"), edges: q(".dk-edges"), packets: q(".dk-packets"), pulses: q(".dk-pulses") };
  const hubEl = q(".dk-hub");
  const podsEl = q(".dk-pods");
  const cardEl = q(".dk-card");
  const recEl = q(".dk-rec");
  const beacon = q(".dk-beacon");
  const mapSvg = stage.querySelector("#map");

  let pid = null;
  let M = null;
  let open = false;
  let entering = false;
  let list = [];
  let mgr = null;
  let lay = { pos: new Map(), box: null };
  let view = { k: 1, cx: 0, cy: 0 };
  let cardId = null;
  let selected = null;
  let recSig = "";
  let hubSig = "";
  let hudSig = "";
  const pods = new Map(); // id -> { el, sig }
  const edges = new Map(); // id -> { path, packet, sig }
  const escal = new Map(); // id -> path
  const tasks = new Map(); // id -> { done, total, current, at }
  const views = new Map(); // id -> { data, at }
  let edgeSeq = 0;
  let clockTimer = 0;
  let taskTimer = 0;

  const now = () => Date.now() + (h.offset?.() ?? 0);
  const motion = () => !reducedMotion();
  const anim = (el, kf, o = {}) => el?.animate(kf, { duration: 1000, easing: E, fill: "forwards", ...o });
  const enterAnim = (el, kf, o = {}) => el?.animate(kf, { duration: 600, easing: EO, fill: "backwards", ...o });
  const stop = (el) => el?.getAnimations().forEach((a) => a.cancel());

  // ---------- data ----------

  function collect(m) {
    mgr = m.managers.get(pid) ?? null;
    list = [...(m.threadsByProject.get(pid) ?? [])].sort((a, b) => (RANK[a.state] ?? 5) - (RANK[b.state] ?? 5) || recency(b) - recency(a));
  }

  const recency = (t) => Date.parse(t.since ?? t.updatedAt ?? "") || 0;

  // ---------- layout (world coords, hub at 0,0) ----------

  // `side` is how far the landed / in-flight columns sit from the hub; wide screens push them out.
  function layout(side = 255) {
    const pos = new Map();
    const placed = [{ x: -HUB_R - 30, y: -HUB_R - 26, w: HUB_R * 2 + 60, h: HUB_R * 2 + 64 }];
    const overlaps = (r) => placed.some((o) => r.x < o.x + o.w && r.x + r.w > o.x && r.y < o.y + o.h && r.y + r.h > o.y);
    const rect = (x, y) => ({ x: x - POD_W / 2 - 8, y: y - POD_H / 2 - 7, w: POD_W + 16, h: POD_H + 14 });
    const bySector = { up: [], right: [], left: [], down: [] };
    for (const t of list) bySector[SECTOR[t.state] ?? "down"].push(t);
    // Most recent first, so the freshest sit nearest the hub.
    for (const s of Object.values(bySector)) s.sort((a, b) => (RANK[a.state] ?? 5) - (RANK[b.state] ?? 5) || recency(b) - recency(a));

    const slot = (i) => (i === 0 ? 0 : i % 2 ? Math.ceil(i / 2) : -i / 2);
    const rowGap = POD_W + 22 + Math.max(0, side - 255) * 0.25;
    const seed = {
      up: (i) => { const s = slot(i); return [s * rowGap, -150 - Math.abs(s) * 16]; },
      down: (i) => { const s = slot(i); return [s * rowGap, 150 + Math.abs(s) * 16]; },
      right: (i) => { const s = slot(i); return [side + Math.abs(s) * 22, s * (POD_H + 18)]; },
      left: (i) => { const s = slot(i); return [-side - Math.abs(s) * 22, s * (POD_H + 18)]; },
    };
    // Needs-you goes first: it gets the best spots; everyone else makes room.
    for (const sec of ["up", "right", "left", "down"]) {
      const [dx, dy] = DIR[sec];
      bySector[sec].forEach((t, i) => {
        let [x, y] = seed[sec](i);
        for (let n = 0; n < 80 && overlaps(rect(x, y)); n++) (x += dx * 18), (y += dy * 18);
        placed.push(rect(x, y));
        pos.set(t.id, { x, y, sec });
      });
    }
    let minX = -HUB_R - 40, maxX = HUB_R + 40, minY = -HUB_R - 30, maxY = HUB_R + 40;
    for (const p of pos.values()) {
      minX = Math.min(minX, p.x - POD_W / 2);
      maxX = Math.max(maxX, p.x + POD_W / 2);
      minY = Math.min(minY, p.y - POD_H / 2);
      maxY = Math.max(maxY, p.y + POD_H / 2);
    }
    const needsAny = list.some((t) => t.state === "needs");
    const beaconY = Math.min(-120, minY - 56);
    if (needsAny) minY = beaconY - 16;
    // Keep the sector labels inside the frame even for a sparse deck.
    minX = Math.min(minX, -190); maxX = Math.max(maxX, 190); minY = Math.min(minY, -120); maxY = Math.max(maxY, 120);
    return { pos, box: { minX, maxX, minY, maxY }, beaconY, needsAny, side };
  }

  const K_MAX = 1.75;

  // Layout pixels, not screen pixels, so browser or OS zoom can't skew the fit.
  const size = () => ({ width: stage.clientWidth || 1, height: stage.clientHeight || 1 });

  function frame(box) {
    const r = size();
    const recH = recEl.offsetHeight || 0;
    const composer = stage.querySelector("#composer");
    const compH = composer && getComputedStyle(composer).display !== "none" && !stage.classList.contains("deck-card") ? composer.offsetHeight + 24 : 12;
    const top = 96;
    const availW = Math.max(200, r.width - 64);
    const availH = Math.max(160, r.height - top - recH - compH - 14);
    const bw = box.maxX - box.minX + 40;
    const bh = box.maxY - box.minY + 30;
    const k = Math.max(0.42, Math.min(K_MAX, availW / bw, availH / bh));
    return { r, k, availW, availH, bw, top, cx: r.width / 2 - ((box.minX + box.maxX) / 2) * k, cy: top + availH / 2 - ((box.minY + box.maxY) / 2) * k };
  }

  // Lay out for this screen: when height limits the scale, spend spare width spreading the deck.
  function plan() {
    lay = layout(255);
    const f = frame(lay.box);
    const spare = f.availW / f.k - f.bw;
    if (spare > 160) lay = layout(Math.min(255 + spare * 0.32, 640));
  }

  let manual = null; // your own zoom/pan; null follows the auto fit
  let ui = 1; // the HUD, card and recorder grow with the deck on big screens
  let shift = 0; // the deck slides aside to make room for an open card

  function fit() {
    if (!open || !lay.box) return;
    const f = frame(lay.box);
    view = manual ? { ...manual } : { k: f.k, cx: f.cx, cy: f.cy };
    view.cx += shift;
    const nextUi = Math.round(Math.max(1, Math.min(1.4, f.k * 0.8)) * 100) / 100;
    if (nextUi !== ui) {
      ui = nextUi;
      root.style.setProperty("--dk-ui", String(ui));
      // The recorder's height follows the scale, so the frame needs one more pass.
      if (!manual) { const g = frame(lay.box); view = { k: g.k, cx: g.cx + shift, cy: g.cy }; }
    }
    applyView();
    stage.style.setProperty("--rec-h", `${recEl.offsetHeight || 0}px`);
    if (cardId) placeCard();
  }

  function applyView() {
    world.style.transform = `translate(${f1(view.cx)}px, ${f1(view.cy)}px) scale(${view.k.toFixed(4)})`;
  }

  function zoomBy(factor, px, py) {
    if (!open) return;
    const r = size();
    px ??= r.width / 2;
    py ??= r.height / 2;
    const k = Math.max(0.3, Math.min(3.2, view.k * factor));
    const ratio = k / view.k;
    manual = { k, cx: px - (px - view.cx) * ratio - shift, cy: py - (py - view.cy) * ratio };
    world.classList.add("dk-free");
    fit();
  }

  function resetView() {
    manual = null;
    world.classList.remove("dk-free");
    fit();
  }

  const toScreen = (x, y) => ({ x: view.cx + x * view.k, y: view.cy + y * view.k });

  // ---------- render ----------

  function update(m) {
    M = m;
    if (!open || !pid) return;
    collect(m);
    plan();
    drawHud();
    drawHub();
    drawRings();
    drawPods();
    drawEdges();
    drawRecorder();
    q(".dk-empty").hidden = list.length > 0;
    beacon.hidden = !lay.needsAny;
    beacon.style.transform = `translate(-50%, -50%) translate(0px, ${f1(lay.beaconY)}px)`;
    fit();
    if (cardId && !list.some((t) => t.id === cardId) && cardId !== mgr?.id) closeCard();
    else if (cardId) paintCard(false);
  }

  function drawHud() {
    const p = h.project(pid);
    const all = [...list, ...(mgr ? [mgr] : [])];
    const n = (st) => all.filter((t) => st.includes(t.state)).length;
    const auto = (h.autonomy?.(pid) ?? "normal").toUpperCase();
    const sig = [p?.title, n(["needs"]), n(["failed"]), n(["working", "waiting"]), n(["reported"]), n(["idle"]), auto].join("|");
    if (sig === hudSig) return;
    hudSig = sig;
    q(".dk-name i").style.background = projectColor(p);
    if (!entering) q(".dk-name span").textContent = p?.title ?? "Project";
    const stat = (cls, v, label) => (v ? `<span class="${cls}"><b>${v}</b> ${label}</span>` : "");
    q(".dk-stats").innerHTML =
      stat("needs", n(["needs"]), "needs you") + stat("failed", n(["failed"]), "failed") + stat("working", n(["working", "waiting"]), "in flight") +
      stat("reported", n(["reported"]), "landed") + stat("idle", n(["idle"]), "parked") || `<span>All quiet</span>`;
    q(".dk-clock").dataset.auto = auto;
    tickClock();
  }

  function tickClock() {
    const live = [...list, ...(mgr ? [mgr] : [])].filter((t) => t.state === "working" || t.state === "waiting");
    const start = Math.min(...live.map((t) => Date.parse(t.since ?? "") || Infinity));
    const el = q(".dk-clock");
    const auto = el.dataset.auto ?? "NORMAL";
    if (Number.isFinite(start)) {
      const s = Math.max(0, Math.floor((now() - start) / 1000));
      const hh = String(Math.floor(s / 3600)).padStart(2, "0"), mm = String(Math.floor(s / 60) % 60).padStart(2, "0"), ss = String(s % 60).padStart(2, "0");
      el.innerHTML = `<small>Mission clock</small><b>T+${hh}:${mm}:${ss}</b><small>Autonomy ${esc(auto)}</small>`;
    } else {
      el.innerHTML = `<small>Local time</small><b>${esc(new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }))}</b><small>Autonomy ${esc(auto)}</small>`;
    }
  }

  function drawHub() {
    const p = h.project(pid);
    const st = mgr?.state ?? "none";
    const badge = !mgr ? "Set up a Manager" : mgr.state === "needs" ? "Needs you" : mgr.state === "failed" ? "Hit a problem" : prLive(mgr.pr) ? prLabel(mgr.pr) : STATE_LABEL[mgr.state];
    const focus = Boolean(mgr) && (cardId === mgr.id || h.panelId?.() === mgr.id);
    const sig = [p?.title, st, badge, mgr?.provider, selected === mgr?.id, focus].join("|");
    if (sig === hubSig) return;
    hubSig = sig;
    hubEl.className = `dk-hub st-${st} ${focus ? "sel" : ""} ${mgr && selected === mgr.id ? "hl" : ""}`;
    hubEl.dataset.id = mgr?.id ?? "";
    hubEl.style.setProperty("--hue", projectColor(p));
    hubEl.setAttribute("aria-label", mgr ? `${p?.title} Manager: ${STATE_LABEL[mgr.state]}` : `Set up a Manager for ${p?.title}`);
    hubEl.innerHTML = `<span class="dk-hub-ring"></span><span class="dk-hub-mono">${esc(monogram(p?.title))}</span><span class="dk-hub-role">${mgr ? `${glyph(mgr.provider, 11)} Manager` : "No Manager"}</span><span class="dk-hub-badge">${esc(badge)}</span>`;
  }

  function drawRings() {
    if (G.rings.childElementCount) return;
    for (const r of [150, 255, 360]) {
      const c = document.createElementNS(NS, "circle");
      c.setAttribute("r", r);
      c.setAttribute("class", "dk-ring");
      G.rings.appendChild(c);
    }
  }

  function outcome(t) {
    const tk = tasks.get(t.id);
    if (t.state === "needs" || t.state === "failed") return t.reason + (t.resetsAt ? ` · resets ${clock(t.resetsAt)}` : "");
    if (t.state === "working") return tk?.current ? `${tk.done}/${tk.total} · ${tk.current}` : `Working · ${ago(t.since, now())}`;
    if (t.state === "waiting") return "Waiting on its team";
    if (t.state === "reported") return prLive(t.pr) ? `${prLabel(t.pr)} · finished ${ago(t.completedAt ?? t.since, now())} ago` : `Finished ${ago(t.completedAt ?? t.since, now())} ago · to read`;
    return prLive(t.pr) ? `${prLabel(t.pr)} · idle` : `Idle · ${ago(t.updatedAt, now())}`;
  }

  function ringSVG(t) {
    const R = 13, C = 2 * Math.PI * R;
    const tk = tasks.get(t.id);
    const live = t.state === "working" || t.state === "waiting";
    const frac = live ? (tk?.total ? tk.done / tk.total : null) : t.state === "idle" ? 0 : 1;
    const arc = frac === null
      ? `<circle class="arc spin" r="${R}" stroke-dasharray="${f1(C * 0.28)} ${f1(C)}"/>`
      : `<circle class="arc" r="${R}" stroke-dasharray="${f1(C * frac)} ${f1(C)}" transform="rotate(-90)"/>`;
    const center = t.state === "needs" || t.state === "failed" ? `<text class="mark" y="4">!</text>`
      : t.state === "reported" ? `<text class="mark" y="4">✓</text>`
      : live && tk?.total ? `<text class="mark small" y="3.5">${tk.done}/${tk.total}</text>`
      : `<g class="g" transform="translate(-6.4 -6.4) scale(.8)">${glyphBody(t.provider)}</g>`;
    return `<svg class="dk-ring-svg" viewBox="-16 -16 32 32" aria-hidden="true"><circle class="track" r="${R}"/>${arc}${center}</svg>`;
  }

  function drawPods() {
    const keep = new Set();
    for (const t of list) {
      const p = lay.pos.get(t.id);
      if (!p) continue;
      keep.add(t.id);
      let rec = pods.get(t.id);
      if (!rec) {
        const el = document.createElement("button");
        el.type = "button";
        el.dataset.id = t.id;
        podsEl.appendChild(el);
        rec = { el, sig: "" };
        pods.set(t.id, rec);
        if (open && !entering && motion()) enterAnim(el, [{ transform: `translate(${f1(-p.x)}px, ${f1(-p.y)}px) scale(.2)`, opacity: 0 }, { opacity: 1, offset: 0.4 }, { transform: "none", opacity: 1 }], { duration: 700 });
      }
      rec.el.style.left = `${f1(p.x - POD_W / 2)}px`;
      rec.el.style.top = `${f1(p.y - POD_H / 2)}px`;
      rec.el.className = `dk-pod st-${t.state} ${t.parentId && t.parentId !== mgr?.id ? "sub" : ""} ${selected === t.id ? "hl" : ""} ${cardId === t.id || h.panelId?.() === t.id ? "sel" : ""}`;
      const text = outcome(t);
      const tk = tasks.get(t.id);
      const sig = [t.title, t.state, text, t.provider, tk?.done, tk?.total].join("|");
      if (sig === rec.sig) continue;
      rec.sig = sig;
      rec.el.setAttribute("aria-label", `${t.title}: ${STATE_LABEL[t.state]}`);
      rec.el.innerHTML = `${ringSVG(t)}<span class="dk-pod-text"><b>${esc(truncate(t.title, 54))}</b><small>${esc(truncate(text, 70))}</small></span>`;
    }
    for (const [id, rec] of pods) {
      if (keep.has(id)) continue;
      pods.delete(id);
      if (motion()) anim(rec.el, [{ opacity: 1 }, { opacity: 0, transform: "scale(.8)" }], { duration: 260 }).onfinish = () => rec.el.remove();
      else rec.el.remove();
    }
  }

  function edgeFrom(t) {
    const parent = t.parentId && t.parentId !== mgr?.id ? lay.pos.get(t.parentId) : null;
    return parent ?? { x: 0, y: 0, hub: true };
  }

  function curve(a, b) {
    const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
    const dx = b.x - a.x, dy = b.y - a.y, len = Math.hypot(dx, dy) || 1;
    const bend = Math.min(40, len * 0.12);
    const cx = mx + (dy / len) * bend, cy = my - (dx / len) * bend;
    const sx = a.x + (dx / len) * (a.hub ? HUB_R + 4 : 0), sy = a.y + (dy / len) * (a.hub ? HUB_R + 4 : 0);
    return `M${f1(sx)} ${f1(sy)}Q${f1(cx)} ${f1(cy)} ${f1(b.x)} ${f1(b.y)}`;
  }

  function drawEdges() {
    const keep = new Set();
    for (const t of list) {
      const p = lay.pos.get(t.id);
      if (!p) continue;
      keep.add(t.id);
      let e = edges.get(t.id);
      if (!e) {
        const path = document.createElementNS(NS, "path");
        path.id = `dk-e${++edgeSeq}`;
        path.setAttribute("pathLength", "1");
        G.edges.appendChild(path);
        e = { path, packet: null, sig: "" };
        edges.set(t.id, e);
        if (open && !entering && motion()) enterAnim(path, [{ strokeDashoffset: 1, strokeDasharray: 1 }, { strokeDashoffset: 0, strokeDasharray: 1 }], { duration: 650 });
      }
      e.path.setAttribute("d", curve(edgeFrom(t), p));
      e.path.setAttribute("class", `dk-edge st-${t.state}`);
      const live = t.state === "working" || t.state === "waiting";
      const sig = `${t.state}`;
      if (sig !== e.sig) {
        e.sig = sig;
        e.packet?.remove();
        e.packet = null;
        // Steady traffic only while the thread is really running.
        if (live && motion()) {
          const g = document.createElementNS(NS, "g");
          g.innerHTML = `<circle r="3.2" class="pk call"><animateMotion dur="2.4s" repeatCount="indefinite"><mpath href="#${e.path.id}"/></animateMotion></circle>` +
            (t.state === "working" ? `<circle r="2.6" class="pk answer"><animateMotion dur="3.1s" begin="1.2s" repeatCount="indefinite" keyPoints="1;0" keyTimes="0;1" calcMode="linear"><mpath href="#${e.path.id}"/></animateMotion></circle>` : "");
          G.packets.appendChild(g);
          e.packet = g;
        }
      }
    }
    for (const [id, e] of edges) {
      if (keep.has(id)) continue;
      e.path.remove();
      e.packet?.remove();
      edges.delete(id);
    }
    // Escalation: needs-you threads route up to You.
    const want = new Set();
    for (const t of list) {
      if (t.state !== "needs") continue;
      const p = lay.pos.get(t.id);
      if (!p) continue;
      want.add(t.id);
      let path = escal.get(t.id);
      if (!path) {
        path = document.createElementNS(NS, "path");
        path.setAttribute("class", "dk-escal");
        G.edges.appendChild(path);
        escal.set(t.id, path);
      }
      path.setAttribute("d", `M${f1(p.x)} ${f1(p.y - POD_H / 2)}C${f1(p.x)} ${f1(lay.beaconY + 40)} 0 ${f1(lay.beaconY + 50)} 0 ${f1(lay.beaconY + 14)}`);
    }
    for (const [id, path] of escal) if (!want.has(id)) (path.remove(), escal.delete(id));
  }

  // ---------- flight recorder ----------

  function drawRecorder() {
    const t1 = now();
    const lanes = [...(mgr ? [mgr] : []), ...list].slice(0, MAX_LANES);
    const more = list.length + (mgr ? 1 : 0) - lanes.length;
    const ids = new Set(lanes.map((t) => t.id));
    const day = (h.events?.() ?? []).filter((e) => e.projectId === pid && e.type !== "work" && ids.has(e.threadId) && e.at >= t1 - DAY);
    // The window fits the work: the earliest span or event in the last day, rounded to a readable size.
    const starts = [...lanes.map((t) => Date.parse(t.startedAt ?? t.since ?? "") || 0), ...day.map((e) => e.at)].filter((v) => v && v > t1 - DAY);
    const need = starts.length ? t1 - Math.min(...starts) : WINDOW;
    const span = WINDOWS.find((w) => w >= need * 1.1) ?? DAY;
    const t0 = t1 - span;
    const evs = day.filter((e) => e.at >= t0);
    const x = (ms) => Math.max(0, Math.min(100, ((ms - t0) / span) * 100));
    const rows = lanes.map((t) => {
      const start = Date.parse(t.startedAt ?? t.since ?? "") || 0;
      const live = t.state === "working" || t.state === "waiting" || t.state === "needs";
      const end = live ? t1 : Date.parse(t.completedAt ?? "") || 0;
      const bar = start && end > t0 && end >= start ? `<i class="bar ${live ? "live" : ""}" style="left:${f1(x(start))}%;width:${f1(Math.max(0.6, x(end) - x(start)))}%"></i>` : "";
      const ticks = evs.filter((e) => e.threadId === t.id && TICK[e.type]).map((e) => `<i class="tick" style="left:${f1(x(e.at))}%;background:${TICK[e.type]}" title="${esc(`${e.type === "call" ? "Call" : e.type === "answer" ? "Answer" : e.type === "needs" ? "Needs you" : "Failed"} · ${e.text ?? ""} · ${clock(new Date(e.at - (h.offset?.() ?? 0)).toISOString())}`)}"></i>`).join("");
      return `<div class="lane ${selected === t.id ? "hl" : ""}" data-id="${esc(t.id)}"><span class="ln">${t.id === mgr?.id ? "◆ Manager" : esc(t.title)}</span><span class="tr">${bar}${ticks}</span></div>`;
    });
    const html = `<div class="rh"><span class="rh-t">Flight recorder · ${esc(dur(span))}</span><span class="rh-x"><span>−${esc(dur(span))}</span><span>−${esc(dur((span * 2) / 3))}</span><span>−${esc(dur(span / 3))}</span><span class="now">now</span></span></div>${rows.join("")}${more > 0 ? `<div class="lane-more">+${more} more on the deck</div>` : ""}`;
    if (html === recSig) return;
    recSig = html;
    recEl.innerHTML = `<div class="dk-rec-in">${html}</div>`;
  }

  // ---------- card ----------

  const threadOf = (id) => (id === mgr?.id ? mgr : list.find((t) => t.id === id) ?? h.thread(id));

  function selectThread(id) {
    if (!id) return;
    if (h.panelOpen?.()) return h.openFull(id);
    openCard(id);
  }

  function openCard(id) {
    const t = threadOf(id);
    if (!t) return;
    cardId = id;
    root.classList.add("inspecting");
    stage.classList.add("deck-card");
    cardEl.hidden = false;
    paintCard(true);
    placeCard();
    if (motion()) enterAnim(cardEl, [{ opacity: 0, transform: `scale(${ui * 0.96}) translateY(4px)` }, { opacity: 1, transform: `scale(${ui})` }], { duration: 220 });
    refresh();
    loadView(id);
  }

  function closeCard() {
    if (!cardId) return;
    cardId = null;
    root.classList.remove("inspecting");
    stage.classList.remove("deck-card");
    if (shift) (shift = 0), fit();
    cardEl.hidden = true;
    cardEl.innerHTML = "";
    refresh();
  }

  function refresh() {
    hubSig = "";
    drawHub();
    for (const [id, rec] of pods) rec.el.classList.toggle("sel", id === cardId || id === h.panelId?.());
  }

  function placeCard() {
    if (!cardId) return;
    const t = threadOf(cardId);
    const r = size();
    const p = cardId === mgr?.id ? { x: 0, y: 0 } : lay.pos.get(cardId) ?? { x: 0, y: 0 };
    const s = toScreen(p.x, p.y);
    const base = Math.min(372, (r.width - 24) / ui);
    const w = base * ui;
    const half = (cardId === mgr?.id ? HUB_R : POD_W / 2) * view.k + 14;
    // Open outward, away from the hub, so the Manager and its neighbours stay visible.
    // When there's no room on that side, the whole deck slides over to make it.
    const outward = cardId === mgr?.id || p.x >= -10 ? 1 : -1;
    const x0 = s.x - shift;
    const left0 = outward > 0 ? x0 + half : x0 - half - w;
    let need = outward > 0 ? Math.min(0, r.width - 12 - (left0 + w)) : Math.max(0, 12 - left0);
    need = Math.max(-r.width * 0.45, Math.min(r.width * 0.45, need));
    if (Math.abs(need - shift) > 1) {
      shift = need;
      return fit();
    }
    const left = Math.max(12, Math.min(r.width - w - 12, left0 + shift));
    const floor = r.height - (recEl.offsetHeight || 0) - 12;
    cardEl.style.maxHeight = `${Math.max(220, floor - 56) / ui}px`;
    const ch = (cardEl.offsetHeight || 300) * ui;
    const top = Math.max(56, Math.min(floor - ch, s.y - ch / 2));
    cardEl.style.width = `${base}px`;
    cardEl.style.transform = ui === 1 ? "" : `scale(${ui})`;
    cardEl.style.left = `${f1(left)}px`;
    cardEl.style.top = `${f1(top)}px`;
  }

  async function loadView(id) {
    try {
      const res = await fetch(`/api/thread/${encodeURIComponent(id)}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not load this thread.");
      views.set(id, { data, at: Date.now() });
      noteTasks(id, data);
      if (cardId === id) (paintCard(false), placeCard());
    } catch (e) {
      if (cardId === id) {
        const body = cardEl.querySelector(".dk-card-body");
        if (body) body.innerHTML = `<p class="dk-card-note">${esc(e.message)}</p>`;
      }
    }
  }

  function noteTasks(id, data) {
    const steps = data?.tasks?.steps;
    if (!steps?.length) return tasks.delete(id);
    const done = steps.filter((s) => s.status === "completed").length;
    const cur = steps.find((s) => s.status === "running") ?? steps.find((s) => s.status !== "completed");
    tasks.set(id, { done, total: steps.length, current: cur?.text ?? null, at: Date.now() });
  }

  let cardSig = "";
  function paintCard(force) {
    const t = threadOf(cardId);
    if (!t) return closeCard();
    const v = views.get(cardId)?.data;
    const isMgr = cardId === mgr?.id;
    const p = h.project(pid);
    const kicker = `${esc(p?.title ?? "")} · ${isMgr ? "Manager" : { up: t.state === "failed" ? "Problem" : "Needs you", right: "In flight", left: "Landed", down: "Parked" }[SECTOR[t.state] ?? "down"]}`;
    const chips = [`<span class="chip ${esc(t.state)}">${esc(STATE_LABEL[t.state])}</span>`, `<span class="dk-chip">${glyph(t.provider, 11)} ${esc([t.providerName, t.model].filter(Boolean).join(" · "))}</span>`];
    if (t.pr) {
      const cls = `dk-chip pr ${esc(t.pr.state ?? "")}`;
      const tip = t.pr.count > 1 ? ` title="${t.pr.count} PRs linked to this thread"` : "";
      chips.push(t.pr.url ? `<a class="${cls}"${tip} href="${esc(t.pr.url)}" target="_blank" rel="noopener noreferrer">${esc(prLabel(t.pr))} ↗</a>` : `<span class="${cls}"${tip}>${esc(prLabel(t.pr))}</span>`);
    }
    if (t.branch) chips.push(`<span class="dk-chip mono">${esc(truncate(t.branch, 34))}</span>`);

    let body = "";
    const r = v?.pending;
    if (r?.kind === "question" && r.questions?.length) body += `<div class="dk-ask"><small>Question for you</small>${esc(truncate(r.questions[0].question, 260))}</div>`;
    else if (r?.kind === "approval") body += `<div class="dk-ask"><small>Approval requested${r.appName ? ` · ${esc(r.appName)}` : ""}</small>${r.reason ? `${esc(truncate(r.reason, 200))}` : ""}${r.prompt ? `<pre>${esc(truncate(r.prompt, 240))}</pre>` : ""}</div>`;
    else if (t.state === "needs") body += `<div class="dk-ask"><small>Needs you</small>${esc(t.reason)}</div>`;
    if (v?.actionablePlan) body += `<div class="dk-ask plan"><small>Plan ready</small>Review the proposed plan in the full thread.</div>`;
    const tk = v?.tasks?.steps;
    if (tk?.length) body += `<ol class="dk-tasks">${tk.map((s) => `<li class="${esc(s.status)}"><i>${s.status === "completed" ? "✓" : s.status === "running" ? "▸" : "○"}</i>${esc(truncate(s.text, 80))}</li>`).join("")}</ol>`;
    const last = v?.turns ? [...v.turns].reverse().find((x) => x.answer?.text) : null;
    if (last) body += `<div class="dk-answer markdown">${markdown(truncate(last.answer.text, 520))}</div>`;
    if (!v) body += `<p class="dk-card-note">Loading the latest from T3…</p>`;
    else if (!body) body = `<p class="dk-card-note">${esc(t.reason || "Nothing to report yet.")}</p>`;

    const acts = [];
    if (t.state === "needs") acts.push(`<button type="button" class="pill-btn amber" data-dk="full">${r?.kind === "approval" ? "Review request" : v?.actionablePlan ? "Review plan" : "Review & answer"}</button>`);
    if (t.state === "failed") acts.push(`<button type="button" class="pill-btn" data-dk="full">See what happened</button>`);
    if (t.state === "reported") acts.push(`<button type="button" class="pill-btn" data-dk="act" data-action="read">Mark read</button>`);
    if (["working", "waiting"].includes(t.state)) acts.push(`<button type="button" class="dk-btn" data-dk="act" data-action="stop">Stop</button>`);
    if (!["working", "waiting", "needs"].includes(t.state) && !t.settled && !isMgr) acts.push(`<button type="button" class="dk-btn" data-dk="act" data-action="settle">Settle</button>`);

    const html = `<div class="dk-card-head"><div class="dk-kicker">${kicker}</div><h3>${esc(t.title)}</h3><div class="dk-chips">${chips.join("")}</div></div>
      <div class="dk-card-body">${body}</div>
      <div class="dk-card-actions">${acts.join("")}<span class="sp"></span><button type="button" class="dk-btn" data-dk="full">Full thread <kbd>f</kbd></button></div>
      <form class="dk-card-reply" data-dk="reply"><input name="text" maxlength="20000" autocomplete="off" placeholder="${["working", "waiting"].includes(t.state) ? "Reply — queues after the current run" : `Reply to ${isMgr ? "the Manager" : "this thread"}…`}" aria-label="Quick reply"><button type="submit" aria-label="Send">↵</button></form>`;
    if (!force && html === cardSig) return;
    const input = cardEl.querySelector(".dk-card-reply input");
    const draft = input?.value ?? "";
    const focused = document.activeElement === input;
    cardSig = html;
    cardEl.innerHTML = html;
    const next = cardEl.querySelector(".dk-card-reply input");
    if (next && draft) next.value = draft;
    if (focused) next?.focus();
  }

  cardEl.addEventListener("click", async (e) => {
    e.stopPropagation();
    const b = e.target.closest("[data-dk]");
    if (!b || !cardId) return;
    if (b.dataset.dk === "full") return openFull(cardId);
    if (b.dataset.dk === "act") {
      b.disabled = true;
      try { await h.act(cardId, b.dataset.action); } finally { b.disabled = false; }
    }
  });
  cardEl.addEventListener("submit", async (e) => {
    e.preventDefault();
    const input = e.target.querySelector("input");
    const text = input.value.trim();
    if (!text || !cardId) return;
    input.disabled = true;
    try {
      if (await h.act(cardId, "send", { text })) input.value = "";
    } finally {
      input.disabled = false;
      input.focus();
    }
  });

  // Morph the card into the full conversation panel.
  function openFull(id) {
    const from = cardId === id && !cardEl.hidden ? cardEl.getBoundingClientRect() : null;
    const ghostHTML = from ? cardEl.innerHTML : null;
    closeCard();
    h.openFull(id);
    const panel = document.querySelector("#thread-panel");
    if (!from || !panel || !motion() || matchMedia("(max-width: 980px)").matches) return;
    const dock = document.querySelector("#dock").getBoundingClientRect();
    const to = { left: innerWidth - panel.offsetWidth, top: dock.top, width: panel.offsetWidth, height: dock.height };
    const ghost = document.createElement("div");
    ghost.className = "dk-ghost";
    ghost.innerHTML = ghostHTML;
    Object.assign(ghost.style, { left: `${from.left}px`, top: `${from.top}px`, width: `${from.width}px`, height: `${from.height}px` });
    document.body.appendChild(ghost);
    ghost.animate(
      [
        { left: `${from.left}px`, top: `${from.top}px`, width: `${from.width}px`, height: `${from.height}px`, opacity: 1, borderRadius: "14px" },
        { opacity: 1, offset: 0.7 },
        { left: `${to.left}px`, top: `${to.top}px`, width: `${to.width}px`, height: `${to.height}px`, opacity: 0, borderRadius: "0px" },
      ],
      { duration: 560, easing: EO, fill: "forwards" },
    ).onfinish = () => ghost.remove();
  }

  // ---------- input ----------

  // Pan by dragging empty space, zoom with the wheel; double-click empty space to re-fit.
  let drag = null;
  let dragged = false;
  const chrome = ".dk-pod, .dk-hub, .dk-card, .dk-rec, .dk-hud, button, a, input";
  root.addEventListener("pointerdown", (e) => {
    if (!open || e.button !== 0 || e.target.closest(chrome)) return;
    drag = { x: e.clientX, y: e.clientY, cx: view.cx - shift, cy: view.cy, k: view.k, moved: false };
  });
  addEventListener("pointermove", (e) => {
    if (!drag) return;
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    if (!drag.moved && Math.hypot(dx, dy) < 4) return;
    drag.moved = true;
    root.classList.add("dk-grabbing");
    world.classList.add("dk-free");
    manual = { k: drag.k, cx: drag.cx + dx, cy: drag.cy + dy };
    fit();
  });
  addEventListener("pointerup", () => {
    if (drag?.moved) (dragged = true), setTimeout(() => (dragged = false), 0);
    drag = null;
    root.classList.remove("dk-grabbing");
  });
  root.addEventListener("wheel", (e) => {
    if (!open || e.target.closest(".dk-card, .dk-rec")) return;
    e.preventDefault();
    const r = stage.getBoundingClientRect();
    zoomBy(Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0016)), e.clientX - r.left, e.clientY - r.top);
  }, { passive: false });
  root.addEventListener("dblclick", (e) => {
    if (open && !e.target.closest(chrome)) resetView();
  });

  root.addEventListener("click", (e) => {
    if (entering || dragged) return;
    const pod = e.target.closest(".dk-pod");
    if (pod) return selectThread(pod.dataset.id);
    if (e.target.closest(".dk-hub")) return mgr ? selectThread(mgr.id) : h.onSetup?.(pid);
    const lane = e.target.closest(".lane[data-id]");
    if (lane) return selectThread(lane.dataset.id);
    if (e.target.closest("[data-dk=back]")) return h.onBack?.();
    if (cardId && !e.target.closest(".dk-card")) closeCard();
  });
  root.addEventListener("pointerover", (e) => {
    const id = e.target.closest(".dk-pod, .lane[data-id], .dk-hub")?.dataset.id || null;
    highlight(id);
  });
  root.addEventListener("pointerleave", () => highlight(null));

  function highlight(id) {
    if (id === selected) return;
    selected = id;
    for (const [pidKey, rec] of pods) rec.el.classList.toggle("hl", pidKey === id);
    hubEl.classList.toggle("hl", Boolean(id) && id === mgr?.id);
    recEl.querySelectorAll(".lane").forEach((l) => l.classList.toggle("hl", l.dataset.id === id));
  }

  function order() {
    return [...(mgr && mgr.state === "needs" ? [mgr.id] : []), ...list.map((t) => t.id), ...(mgr && mgr.state !== "needs" ? [mgr.id] : [])];
  }

  function cycle(dir) {
    const ids = order();
    if (!ids.length) return;
    const cur = h.panelOpen?.() ? h.panelId?.() : cardId;
    const i = ids.indexOf(cur);
    selectThread(ids[(i + dir + ids.length) % ids.length] ?? ids[0]);
  }

  // ---------- live work ----------

  async function pollTasks() {
    clearTimeout(taskTimer);
    if (!open) return;
    const live = [...list, ...(mgr ? [mgr] : [])].filter((t) => t.state === "working" || t.state === "waiting").slice(0, 6);
    for (const t of list) if (!live.includes(t) && tasks.has(t.id) && t.state !== "working") tasks.delete(t.id);
    await Promise.all(live.map(async (t) => {
      try {
        const res = await fetch(`/api/thread/${encodeURIComponent(t.id)}`);
        if (!res.ok) return;
        const data = await res.json();
        views.set(t.id, { data, at: Date.now() });
        noteTasks(t.id, data);
      } catch {}
    }));
    if (open && M) {
      for (const rec of pods.values()) rec.sig = "";
      update(M);
    }
    taskTimer = setTimeout(pollTasks, document.hidden ? 30_000 : 10_000);
  }

  function pulse(ev) {
    if (!open || !motion() || document.hidden || ev.projectId !== pid) return;
    const color = ev.type === "work" ? null : ev.type;
    const isMgr = ev.threadId === mgr?.id;
    const rec = pods.get(ev.threadId);
    const ping = (el, cls) => { if (!el) return; el.classList.remove(cls); void el.offsetWidth; el.classList.add(cls); setTimeout(() => el.classList.remove(cls), 900); };
    if (ev.type === "work") return ping(isMgr ? hubEl : rec?.el, "ping-work");
    ping(isMgr ? hubEl : rec?.el, `ping-${color}`);
    const e = edges.get(ev.threadId);
    if (!e || isMgr) return;
    const path = e.path;
    const len = path.getTotalLength();
    const reverse = ev.type !== "call";
    const dot = document.createElementNS(NS, "circle");
    dot.setAttribute("r", "5");
    dot.setAttribute("class", `pulse-dot ${color}`);
    G.pulses.appendChild(dot);
    const t0 = performance.now(), dur = 1100;
    const step = (now2) => {
      const p = Math.min(1, (now2 - t0) / dur);
      const k = p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2;
      const pt = path.getPointAtLength((reverse ? 1 - k : k) * len);
      dot.setAttribute("cx", pt.x);
      dot.setAttribute("cy", pt.y);
      dot.setAttribute("opacity", p > 0.85 ? (1 - p) / 0.15 : 1);
      if (p < 1) requestAnimationFrame(step);
      else {
        dot.remove();
        if (reverse) ping(hubEl, `ping-${color}`);
        if (ev.type === "needs") ping(beacon, "ping-needs");
      }
    };
    requestAnimationFrame(step);
  }

  // ---------- the dive ----------

  function scramble(el, text, ms = 650) {
    const chars = "▚▞▖▗▘▝01#%&ABCDEFGHJKMNPQRSTVWXYZ";
    const t0 = performance.now();
    const step = (t) => {
      const p = Math.min(1, (t - t0) / ms);
      const n = Math.floor(p * text.length);
      el.textContent = text.slice(0, n) + [...text.slice(n)].map((c) => (c === " " ? " " : chars[(Math.random() * chars.length) | 0])).join("");
      if (p < 1) requestAnimationFrame(step);
      else el.textContent = text;
    };
    requestAnimationFrame(step);
  }

  function streaks(at) {
    const s = q(".dk-streaks");
    s.style.left = `${at.x}px`;
    s.style.top = `${at.y}px`;
    s.innerHTML = Array.from({ length: 26 }, (_, i) => `<i style="transform:rotate(${(i * 13.85).toFixed(1)}deg) translateX(${(60 + Math.random() * 90).toFixed(0)}px)"></i>`).join("");
    anim(s, [{ opacity: 0, transform: "scale(.4)" }, { opacity: 1, offset: 0.35 }, { opacity: 0, transform: "scale(2.6)" }], { duration: 900, easing: "cubic-bezier(.4,0,.2,1)", fill: "none" });
  }

  function enter(projectId, origin, opts = {}) {
    pid = projectId;
    open = true;
    manual = null;
    shift = 0;
    world.classList.remove("dk-free");
    cardId = null;
    hubSig = hudSig = recSig = "";
    root.classList.add("on");
    root.classList.remove("inspecting");
    cardEl.hidden = true;
    stage.classList.add("deck-on");
    for (const rec of pods.values()) rec.el.remove();
    pods.clear();
    for (const e of edges.values()) (e.path.remove(), e.packet?.remove());
    edges.clear();
    for (const p of escal.values()) p.remove();
    escal.clear();
    entering = true;
    if (M) update(M);
    clearInterval(clockTimer);
    clockTimer = setInterval(tickClock, 1000);
    pollTasks();

    const hub = toScreen(0, 0);
    const from = origin ?? hub;
    const name = h.project(pid)?.title ?? "Project";
    const done = () => {
      entering = false;
      q(".dk-name span").textContent = name;
      if (opts.select) selectThread(opts.select);
    };

    stop(cam); stop(mapSvg);
    if (!motion()) {
      mapSvg.style.opacity = "0";
      anim(cam, [{ opacity: 0 }, { opacity: 1 }], { duration: 160, easing: "linear" });
      return done();
    }
    mapSvg.style.transformOrigin = `${f1(from.x)}px ${f1(from.y)}px`;
    anim(mapSvg, [{ transform: "none", opacity: 1, filter: "blur(0)" }, { opacity: 1, offset: 0.45 }, { transform: `translate(${f1(hub.x - from.x)}px, ${f1(hub.y - from.y)}px) scale(4.2) rotate(-24deg)`, opacity: 0, filter: "blur(8px)" }], { duration: 1150 });
    cam.style.transformOrigin = `${f1(hub.x)}px ${f1(hub.y)}px`;
    anim(cam, [{ transform: `translate(${f1(from.x - hub.x)}px, ${f1(from.y - hub.y)}px) scale(.24) rotate(70deg)`, opacity: 0 }, { opacity: 1, offset: 0.5 }, { transform: "none", opacity: 1 }], { duration: 1250, delay: 120, easing: "cubic-bezier(.65,0,.15,1)" });
    const warp = q(".dk-warp");
    warp.style.setProperty("--wx", `${f1(hub.x)}px`);
    warp.style.setProperty("--wy", `${f1(hub.y)}px`);
    anim(warp, [{ opacity: 0 }, { opacity: 1, offset: 0.45 }, { opacity: 0 }], { duration: 1100, fill: "none" });
    setTimeout(() => streaks(hub), 250);

    enterAnim(hubEl, [{ transform: "scale(.3)", filter: "brightness(3)" }, { transform: "scale(1.12)", offset: 0.6 }, { transform: "scale(1)" }], { delay: 650, duration: 700 });
    [...G.rings.children].forEach((r, i) => enterAnim(r, [{ transform: "scale(.2)", opacity: 0 }, { transform: "scale(1)", opacity: 1 }], { delay: 700 + i * 90, duration: 900 }));
    list.forEach((t, i) => {
      const p = lay.pos.get(t.id);
      const rec = pods.get(t.id);
      if (!p || !rec) return;
      const d = 850 + Math.min(i, 14) * 70;
      enterAnim(rec.el, [{ transform: `translate(${f1(-p.x)}px, ${f1(-p.y)}px) scale(.15)`, opacity: 0 }, { opacity: 1, offset: 0.4 }, { transform: "none", opacity: 1 }], { delay: d, duration: 750 });
      const e = edges.get(t.id);
      if (e) enterAnim(e.path, [{ strokeDashoffset: 1, strokeDasharray: 1 }, { strokeDashoffset: 0, strokeDasharray: 1 }], { delay: d - 60, duration: 650 });
      const arc = rec.el.querySelector(".arc:not(.spin)");
      if (arc) enterAnim(arc, [{ strokeDasharray: "0 100" }, { strokeDasharray: arc.getAttribute("stroke-dasharray") }], { delay: d + 350, duration: 700 });
    });
    for (const p of escal.values()) enterAnim(p, [{ opacity: 0 }, { opacity: 1 }], { delay: 1300, duration: 500 });
    enterAnim(G.packets, [{ opacity: 0 }, { opacity: 1 }], { delay: 1500, duration: 500 });
    [...root.querySelectorAll(".dk-secs span"), beacon].forEach((s, i) => enterAnim(s, [{ opacity: 0, letterSpacing: ".6em" }, { opacity: 1 }], { delay: 1100 + i * 60, duration: 700 }));
    enterAnim(q(".dk-hud"), [{ opacity: 0, transform: `translateX(-14px) scale(${ui})` }, { opacity: 1, transform: `scale(${ui})` }], { delay: 900 });
    enterAnim(q(".dk-clock"), [{ opacity: 0, transform: `translateX(14px) scale(${ui})` }, { opacity: 1, transform: `scale(${ui})` }], { delay: 950 });
    setTimeout(() => scramble(q(".dk-name span"), name), 900);
    enterAnim(recEl, [{ transform: "translateY(100%)", opacity: 0 }, { transform: "none", opacity: 1 }], { delay: 1050, duration: 800 });
    recEl.querySelectorAll(".bar").forEach((b, i) => enterAnim(b, [{ transform: "scaleX(0)" }, { transform: "scaleX(1)" }], { delay: 1300 + i * 50, duration: 700 }));
    recEl.querySelectorAll(".tick").forEach((b, i) => enterAnim(b, [{ opacity: 0, transform: "scaleY(0)" }, { opacity: 1, transform: "none" }], { delay: 1500 + Math.min(i, 30) * 18, duration: 300 }));
    setTimeout(done, 1550);
  }

  function exit(origin) {
    if (!open) return;
    const hub = toScreen(0, 0);
    const to = origin ?? hub;
    open = false;
    entering = false;
    closeCard();
    clearInterval(clockTimer);
    clearTimeout(taskTimer);
    stage.classList.remove("deck-on");
    stage.style.removeProperty("--rec-h");
    const finish = () => {
      if (open) return;
      root.classList.remove("on");
      stop(cam);
      stop(mapSvg);
      mapSvg.style.opacity = "";
      pid = null;
    };
    stop(cam); stop(mapSvg);
    if (!motion()) return finish();
    cam.style.transformOrigin = `${f1(hub.x)}px ${f1(hub.y)}px`;
    anim(cam, [{ transform: "none", opacity: 1 }, { opacity: 0, offset: 0.6 }, { transform: `translate(${f1(to.x - hub.x)}px, ${f1(to.y - hub.y)}px) scale(.24) rotate(70deg)`, opacity: 0 }], { duration: 950 });
    for (const el of [q(".dk-hud"), q(".dk-clock"), recEl]) anim(el, [{ opacity: 1 }, { opacity: 0 }], { duration: 300, easing: "ease-out" });
    mapSvg.style.transformOrigin = `${f1(to.x)}px ${f1(to.y)}px`;
    anim(mapSvg, [{ transform: `translate(${f1(hub.x - to.x)}px, ${f1(hub.y - to.y)}px) scale(4.2) rotate(-24deg)`, opacity: 0, filter: "blur(8px)" }, { transform: "none", opacity: 1, filter: "blur(0)" }], { duration: 1050, delay: 80, easing: "cubic-bezier(.3,0,.15,1)" }).onfinish = () => {
      if (open) return;
      stop(mapSvg);
      finish();
      for (const el of [q(".dk-hud"), q(".dk-clock"), recEl]) stop(el);
    };
    anim(q(".dk-warp"), [{ opacity: 0 }, { opacity: 0.6, offset: 0.4 }, { opacity: 0 }], { duration: 900, fill: "none" });
  }

  // A resize can change how wide the deck should spread, so re-plan rather than just rescale.
  new ResizeObserver(() => open && M && update(M)).observe(stage);

  return {
    enter,
    exit,
    update,
    pulse,
    select: selectThread,
    cycle,
    closeCard,
    zoomIn: () => zoomBy(1.25),
    zoomOut: () => zoomBy(0.8),
    resetView,
    openFull: () => cardId && openFull(cardId),
    highlight,
    get open() { return open; },
    get project() { return pid; },
    get card() { return cardId; },
  };
}
