// T3 Map — a local bridge that turns T3 Code's live orchestration stream into a calm map.
// Binds to 127.0.0.1 only. The T3 bearer token never leaves this process.

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { T3Shell, favorites, providerInstances, runCli, launchDefaults } from "./t3.mjs";
import { ImageStore, MAX_IMAGE_BYTES, IMAGE_TYPES } from "./images.mjs";
import { slimProjection } from "./thread.mjs";
import { DemoShell, demoTeam } from "./demo.mjs";
import { TEAM_FILE, LEVELS, loadTeam, saveTeam, roleOf, levelOf, bossBrief, managerBrief, managerBriefProject, autonomyNote, isNoProject } from "./team.mjs";
import { diffThread, normalizeProject, normalizeThread, providerName, modelName } from "./model.mjs";

const DEMO = process.env.T3_MAP_DEMO === "1";
const PORT = Number(process.env.T3_MAP_PORT || (DEMO ? 4774 : 4773));
if (!Number.isInteger(PORT) || PORT < 0 || PORT > 65535) throw new Error("T3_MAP_PORT must be an integer from 0 to 65535.");
const DESKTOP = process.env.T3_MAP_DESKTOP === "1";
let boundPort = PORT;
const HOST = "127.0.0.1";
const WEB = fileURLToPath(new URL("../web/", import.meta.url));
const EVENT_WINDOW_MS = 15 * 60_000;
const MAX_EVENTS = 2000;

// ---- store -----------------------------------------------------------------

const raw = new Map(); // threadId -> raw T3 thread shell
const projects = new Map(); // projectId -> normalized project
const projectDefaults = new Map();
let events = []; // recent map events (newest last)
let team = DEMO ? demoTeam() : await loadTeam();
const live = { bossFrom: DEMO ? "d-inv" : null }; // which thread the Boss's current question came from
let seq = 0;

function pushEvents(list) {
  if (!list.length) return;
  for (const e of list) e.id = ++seq;
  events.push(...list);
  const cutoff = Date.now() - EVENT_WINDOW_MS;
  let drop = 0;
  while (drop < events.length && (events[drop].at < cutoff || events.length - drop > MAX_EVENTS)) drop++;
  if (drop) events = events.slice(drop);
  broadcast("events", list);
}

function stateMessage() {
  return {
    status: shell.status,
    environmentId: shell.info?.environmentId ?? null,
    serverVersion: shell.info?.serverVersion ?? null,
    demo: DEMO,
    projects: [...projects.values()],
    threads: [...raw.values()].map(view),
    team: teamView(),
    events,
    now: Date.now(),
  };
}

// Role threads (Boss, Managers) always stay on the map, even when settled.
function view(t) {
  const n = normalizeThread(t);
  const r = roleOf(team, t.id);
  if (r) Object.assign(n, { role: r.role, visible: !t.deletedAt && !t.archivedAt });
  return n;
}

function teamView() {
  return { ...team, bossFrom: live.bossFrom, file: DEMO ? null : TEAM_FILE };
}

// ---- T3 stream -------------------------------------------------------------

const shell = DEMO ? new DemoShell() : new T3Shell();
const images = new ImageStore(shell, DEMO);

shell.on("status", (s) => broadcast("status", s));

shell.on("snapshot", ({ threads, projects: ps }) => {
  const at = Date.now();
  const derived = [];
  // A resubscribe after a reconnect is a fresh snapshot: diff against what we had
  // so real changes during the gap still show, but don't animate a cold start.
  const warm = raw.size > 0;
  const next = new Map(threads.map((t) => [t.id, t]));
  if (warm) for (const t of threads) derived.push(...diffThread(raw.get(t.id), t, at).filter((e) => e.type !== "work"));
  raw.clear();
  for (const [id, t] of next) raw.set(id, t);
  // Identity enrichment is async; keep a known repo until a fresh one arrives.
  const prior = new Map(projects);
  projects.clear();
  for (const p of ps) {
    projectDefaults.set(p.id, { defaultModelSelection: p.defaultModelSelection });
    const next = normalizeProject(p);
    projects.set(p.id, { ...next, repo: next.repo ?? prior.get(p.id)?.repo ?? null });
  }
  broadcast("state", stateMessage());
  pushEvents(derived);
  if (team.boss && raw.has(team.boss.threadId) && view(raw.get(team.boss.threadId)).state === "needs") traceBossQuestion();
});

shell.on("thread", (t) => {
  const prev = raw.get(t.id);
  raw.set(t.id, t);
  broadcast("thread", view(t));
  pushEvents(diffThread(prev, t));
  claimManager(t).catch(() => {});
  if (t.id === team.boss?.threadId && view(t).state === "needs" && (!prev || normalizeThread(prev).state !== "needs")) traceBossQuestion();
});

// Project updates and identity enrichment: keep what we know, fill in what's new.
shell.on("projects", (list) => {
  for (const p of list) {
    if ('defaultModelSelection' in p) projectDefaults.set(p.id, { defaultModelSelection: p.defaultModelSelection });
    const next = normalizeProject(p);
    const prev = projects.get(p.id);
    projects.set(p.id, prev ? { ...prev, ...next, repo: next.repo ?? prev.repo } : next);
  }
  broadcast("projects", list.map((p) => projects.get(p.id)));
});

shell.on("projectRemoved", (id) => {
  projects.delete(id);
  projectDefaults.delete(id);
  broadcast("projectRemoved", { id });
});

shell.on("removed", (id) => {
  raw.delete(id);
  broadcast("removed", { id });
});

// ---- SSE -------------------------------------------------------------------

const clients = new Set();

function broadcast(event, data) {
  const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) res.write(frame);
}

setInterval(() => {
  for (const res of clients) res.write(": keepalive\n\n");
}, 20_000).unref();

// ---- actions ---------------------------------------------------------------
// Every action is one of T3's own orchestration commands, sent the way T3's client sends it.

const DECISIONS = new Set(["accept", "acceptForSession", "acceptAlways", "decline", "cancel"]);
const str = (v, max) => (typeof v === "string" && v.trim() && v.length <= max ? v.trim() : null);

async function changes(threadId) {
  if (!raw.has(threadId)) return [404, { error: "That thread is no longer in T3." }];
  if (DEMO) return [200, shell.changes(threadId)];
  const p = await shell.call("orchestration.getThreadProjection", { threadId });
  const toTurnCount = Math.max(0, ...(p.checkpoints ?? []).filter((c) => c.status === "ready").map((c) => c.appRunOrdinal ?? 0));
  if (!toTurnCount) return [200, { diff: "", toTurnCount: 0 }];
  const out = await shell.call("orchestration.getFullThreadDiff", { threadId, toTurnCount }, { timeout: 30_000 });
  return [200, { ...out, diff: out.diff.slice(0, 500_000), truncated: out.diff.length > 500_000 }];
}

async function getThread(threadId) {
  if (!raw.has(threadId)) return [404, { error: "That thread is no longer in T3." }];
  if (DEMO) return [200, shell.projection(threadId)];
  const p = await shell.call("orchestration.getThreadProjection", { threadId }, { timeout: 20_000 });
  return [200, slimProjection(p, raw.get(threadId))];
}

async function act(body) {
  const threadId = str(body.threadId, 400);
  if (!threadId || !raw.has(threadId)) return [404, { error: "That thread is no longer in T3." }];
  const action = body.action;
  let command;
  switch (action) {
    case "send": {
      if (typeof body.text !== 'string' || body.text.length > 20_000) return [400, { error: "The message must contain at most 20,000 characters." }];
      const message = images.message(body.text.trim(), body.imageIds);
      if (!message.text) return [400, { error: "Write something or attach an image first." }];
      command = { type: "message.dispatch", createdBy: "user", creationSource: "web", threadId, messageId: randomUUID(), ...message, dispatchMode: { type: "queue_after_active" } };
      break;
    }
    case "plan": {
      const planId = str(body.planId, 400);
      if (!planId) return [400, { error: "That plan is gone." }];
      const text = str(body.text, 20_000) ?? "Go ahead with the plan.";
      command = { type: "message.dispatch", createdBy: "user", creationSource: "web", threadId, messageId: randomUUID(), text, attachments: [], dispatchMode: { type: "queue_after_active" }, sourcePlanRef: { threadId, planId } };
      break;
    }
    case "answer": {
      const requestId = str(body.requestId, 400);
      const answers = body.answers && typeof body.answers === "object" && !Array.isArray(body.answers) ? body.answers : null;
      const valueOk = (v) => typeof v === "string" && v.trim().length > 0 && v.length <= 4000;
      const ok = answers && Object.values(answers).every((v) => valueOk(v) || (Array.isArray(v) && v.length > 0 && v.length <= 100 && v.every(valueOk)));
      if (!requestId || !ok) return [400, { error: "Pick an answer first." }];
      command = { type: "runtime-request.respond", threadId, requestId, answers };
      break;
    }
    case "decide": {
      const requestId = str(body.requestId, 400);
      if (!requestId || !DECISIONS.has(body.decision)) return [400, { error: "Choose approve or deny." }];
      const feedback = str(body.feedback, 4000);
      command = { type: "runtime-request.respond", threadId, requestId, decision: body.decision, ...(feedback ? { feedback } : {}) };
      break;
    }
    case "dismiss": {
      const requestId = str(body.requestId, 400);
      if (!requestId) return [400, { error: "Nothing to dismiss." }];
      command = { type: "thread.user-input.dismiss", threadId, requestId };
      break;
    }
    case "stop":
      command = { type: "thread.stop", threadId };
      break;
    case "read":
      command = { type: "thread.visit", threadId, visitedAt: new Date().toISOString() };
      break;
    case "settle":
      command = { type: "thread.settle", threadId };
      break;
    default:
      return [400, { error: "Unknown action." }];
  }
  if (["plan", "answer", "decide", "dismiss"].includes(action)) {
    const [, view] = await getThread(threadId);
    const r = view.pending;
    if (action === "plan") {
      if (!view.actionablePlan || view.turns.at(-1)?.plan?.planId !== body.planId) return [409, { error: "That plan is no longer awaiting approval. Refresh the conversation." }];
    } else {
      if (!r || r.requestId !== body.requestId) return [409, { error: "That request has already changed. Refresh the conversation." }];
      if (action === "answer") {
        if (r.kind !== "question" || !r.questions.length) return [400, { error: "T3 hasn't supplied the question details yet." }];
        if (Object.keys(body.answers).some((key) => !r.questions.some((q) => q.id === key))) return [400, { error: "Unknown question." }];
        for (const q of r.questions) {
          const value = Object.hasOwn(body.answers, q.id) ? body.answers[q.id] : null;
          if (value == null && q.required === false) continue;
          if (value == null || (!q.multiSelect && Array.isArray(value))) return [400, { error: "Answer each question first." }];
          if (!q.allowCustom && [value].flat().some((v) => !q.options.some((o) => o.value === v))) return [400, { error: "Choose one of the offered answers." }];
        }
      }
      if (action === "decide" && (r.kind !== "approval" || !r.prompt || !r.options.some((o) => (o.decision ?? o) === body.decision))) return [400, { error: "That approval option is unavailable." }];
      if (action === "dismiss" && r.kind !== "question") return [400, { error: "Only questions can be dismissed." }];
    }
  }
  if (action === "settle" && ["working", "waiting", "needs"].includes(normalizeThread(raw.get(threadId)).state)) return [409, { error: "Stop or finish this work before settling the thread." }];
  if (DEMO) return [200, shell.act(threadId, action, action === 'send' ? { ...body, text: command.text, attachments: command.attachments, context: command.context } : body)];
  await shell.dispatch(command);
  return [200, { ok: true }];
}

async function agents() {
  const list = DEMO
    ? [{ provider: "claudeAgent", model: "claude-opus-5-5" }, { provider: "codex", model: "gpt-6.1-sol" }, { provider: "grok", model: "grok-4.7" }]
    : await favorites();
  // "Claude · Team" is a T3 Claude instance launched without skills. A big global skill
  // library (security tooling especially) makes Opus 5.5's safety filter block threads
  // that have no project around them, like the Boss in "No project".
  if (!DEMO && (await providerInstances()).claudeTeam && !list.some((f) => f.provider === "claudeTeam")) list.unshift({ provider: "claudeTeam", model: "claude-opus-5-5" });
  return [200, list.map((f) => ({ provider: f.provider, model: f.model, label: `${providerName(f.provider)} · ${modelName({ model: f.model })}` }))];
}

async function start(body) {
  const projectId = str(body.projectId, 400);
  if (!projectId || !projects.has(projectId)) return [400, { error: "Pick a project first." }];
  if (typeof body.text !== 'string' || body.text.length > 20_000) return [400, { error: "The message must contain at most 20,000 characters." }];
  const message = images.message(body.text.trim(), body.imageIds);
  const text = message.text;
  if (!text) return [400, { error: "Write something or attach an image first." }];
  const worktree = body.worktree == null ? null : str(body.worktree, 200);
  const branch = body.branch ? str(body.branch, 200) : null;
  if ((body.worktree != null && (!worktree || worktree.startsWith("-") || /[\r\n\0]/.test(worktree))) || (body.branch && (!branch || branch.startsWith("-") || /[\r\n\0]/.test(branch))) || (branch && !worktree)) return [400, { error: "Choose a valid base and branch for the worktree." }];
  const args = ["thread", "start", projectId, "-", "--json"];
  let selectedModel = null;
  if (body.provider || body.model) {
    // Only the agents you've starred in T3 — never arbitrary values.
    const [, list] = await agents();
    const fav = list.find((f) => f.provider === body.provider && f.model === body.model);
    if (!fav) return [400, { error: "Pick one of your starred agents." }];
    args.push("--provider", fav.provider, "--model", fav.model);
    selectedModel = { instanceId: fav.provider, model: fav.model };
  }
  if (worktree) args.push("--worktree", worktree);
  if (branch) args.push("--branch", branch);
  if (DEMO) return [200, shell.startThread(projectId, text, { ...body, attachments: message.attachments, context: message.context })];
  if (message.attachments.length) {
    const defaults = await launchDefaults(projectId, projectDefaults.get(projectId));
    const modelSelection = selectedModel ?? defaults.modelSelection;
    if (!modelSelection) return [400, { error: "This project has no default agent. Choose one in new work options." }];
    const launched = await shell.call('orchestration.launchThread', {
      commandId: randomUUID(), threadId: randomUUID(), projectId,
      title: text.replace(/!?\[[^\]\n]*\]\(t3-context:[^)]*\)/g, 'image').split('\n')[0].slice(0, 100) || 'Image review',
      creationSource: 'web', modelSelection, runtimeMode: defaults.runtimeMode, interactionMode: 'default',
      workspaceStrategy: worktree ? { type: 'worktree', baseRef: worktree, ...(branch ? { branch } : {}), startFromOrigin: false } : { type: 'root' },
      initialMessage: { messageId: randomUUID(), ...message },
    }, { timeout: 60_000 });
    return [200, { ok: true, threadId: launched.threadId }];
  }
  const out = await runCli(args, { input: text });
  let threadId = null;
  try {
    const j = JSON.parse(out.slice(out.indexOf("{")));
    threadId = j.threadId ?? j.thread?.id ?? j.id ?? null;
  } catch {
    threadId = /[0-9a-f]{8}-[0-9a-f-]{27}/i.exec(out)?.[0] ?? null;
  }
  return [200, { ok: true, threadId }];
}

// ---- team ------------------------------------------------------------------
// The Boss and Managers are ordinary T3 threads with a short brief. Assigning a role
// starts (or messages) a thread through T3; the roster itself is a local file.

async function traceBossQuestion() {
  if (DEMO || !team.boss) return;
  try {
    const p = await shell.call("orchestration.getThreadProjection", { threadId: team.boss.threadId }, { timeout: 20_000 });
    const items = [...(p.visibleTurnItems ?? [])].sort((a, b) => a.position - b.position).map((v) => v.item);
    const last = items.filter((it) => it.type === "user_message" && it.senderThreadId).at(-1);
    live.bossFrom = last?.senderThreadId ?? null;
    broadcast("team", teamView());
  } catch {}
}

let teamWrite = Promise.resolve();
async function persistTeam() {
  if (!DEMO) {
    teamWrite = teamWrite.catch(() => {}).then(() => saveTeam(team));
    await teamWrite;
  }
  broadcast("state", stateMessage());
}

const projectTitle = (pid) => projects.get(pid)?.title ?? team.managers[pid]?.project ?? "this project";
const roster = () => Object.entries(team.managers).map(([pid, m]) => ({ project: projectTitle(pid), threadId: m.threadId }));
const managerStarts = new Map();

async function sendText(threadId, text) {
  if (DEMO) return shell.act(threadId, "send", { text });
  await shell.dispatch({ type: "message.dispatch", createdBy: "user", creationSource: "web", threadId, messageId: randomUUID(), text, attachments: [], dispatchMode: { type: "queue_after_active" } });
}

async function startRole({ projectId, title, text, provider, model }) {
  let fav = null;
  if (provider || model) {
    const [, list] = await agents();
    fav = list.find((f) => f.provider === provider && f.model === model);
    if (!fav) throw Object.assign(new Error("Pick one of your starred agents."), { status: 400 });
  }
  if (DEMO) return shell.startThread(projectId, text, { title, provider: fav?.provider, model: fav?.model }).threadId;
  const defaults = await launchDefaults(projectId, projectDefaults.get(projectId));
  const { threadId } = await shell.call("orchestration.launchThread", {
    commandId: randomUUID(), threadId: randomUUID(), projectId, title, creationSource: "web",
    modelSelection: fav ? { instanceId: fav.provider, model: fav.model } : defaults.modelSelection,
    runtimeMode: defaults.runtimeMode, interactionMode: "default", workspaceStrategy: { type: "root" },
    initialMessage: { messageId: randomUUID(), text, attachments: [] },
  }, { timeout: 60_000 });
  // Pin it so T3's own sidebar shows the team at the top too. Best effort.
  shell.dispatch({ type: "thread.pin", threadId }).catch(() => {});
  return threadId;
}

// A thread is a Manager when it's named "<project> Manager" or its first message is a
// Manager brief: the map's own, or one the Boss wrote. Checked once per thread.
const briefSeen = new Map(); // threadId -> project title from the brief, or "" for none
async function briefProjectOf(t) {
  if (briefSeen.has(t.id)) return briefSeen.get(t.id) || null;
  const p = await shell.call("orchestration.getThreadProjection", { threadId: t.id }, { timeout: 20_000 });
  const first = [...(p.visibleTurnItems ?? [])].sort((a, b) => a.position - b.position).map((v) => v.item).find((it) => it.type === "user_message");
  if (!first) return null; // no first message yet; look again on the next update
  const found = managerBriefProject(first.text) ?? "";
  briefSeen.set(t.id, found);
  return found || null;
}
function looksLikeManager(t, title) {
  return String(t.title ?? "").trim().toLowerCase() === `${title} manager`.toLowerCase();
}
const isRoleThread = (id) => team.boss?.threadId === id || Object.values(team.managers).some((m) => m.threadId === id);

/** An unregistered Manager thread already in the project, newest first. */
async function existingManager(projectId) {
  const title = projectTitle(projectId);
  const candidates = [...raw.values()]
    .filter((t) => t.projectId === projectId && !isRoleThread(t.id))
    .sort((a, b) => String(b.createdAt ?? "").localeCompare(String(a.createdAt ?? "")))
    .slice(0, 12);
  for (const t of candidates) {
    if (looksLikeManager(t, title)) return t;
    const briefed = await briefProjectOf(t).catch(() => null);
    if (briefed && briefed.toLowerCase() === title.toLowerCase()) return t;
  }
  return null;
}

/** Register a thread as its project's Manager the moment it shows up as one. */
async function claimManager(t) {
  if (DEMO || !t?.projectId || team.managers[t.projectId] || isRoleThread(t.id)) return;
  const p = projects.get(t.projectId);
  if (!p || isNoProject(p)) return;
  const title = projectTitle(t.projectId);
  const named = looksLikeManager(t, title);
  if (!named && briefSeen.has(t.id) && !briefSeen.get(t.id)) return;
  const briefed = named ? null : await briefProjectOf(t);
  if (!named && (!briefed || briefed.toLowerCase() !== title.toLowerCase())) return;
  if (team.managers[t.projectId]) return; // registered while we looked
  team.managers[t.projectId] = { threadId: t.id, project: title };
  await persistTeam();
  broadcast("team", teamView());
}

async function teamAction(body) {
  const action = body.action;
  if (action === "boss") {
    let threadId;
    if (body.mode === "adopt") {
      threadId = str(body.threadId, 400);
      if (!threadId || !raw.has(threadId)) return [404, { error: "That thread is no longer in T3." }];
      if (Object.values(team.managers).some((m) => m.threadId === threadId)) return [400, { error: "That thread is already a Manager." }];
      await sendText(threadId, bossBrief({ managers: roster() }));
      if (!DEMO) shell.dispatch({ type: "thread.pin", threadId }).catch(() => {});
    } else {
      // The Boss lives in T3's "No project" unless you pick somewhere else.
      const projectId = str(body.projectId, 400) ?? [...projects.values()].find(isNoProject)?.id ?? null;
      if (!projectId || !projects.has(projectId)) return [400, { error: "Pick where the Boss thread should live." }];
      threadId = await startRole({ projectId, title: "Boss", text: bossBrief({ managers: roster() }), provider: body.provider, model: body.model });
    }
    team.boss = { threadId };
    // Managers briefed before there was a Boss learn where to escalate now.
    for (const [pid, m] of Object.entries(team.managers)) {
      if (raw.has(m.threadId)) sendText(m.threadId, `There is now a Boss thread (${threadId}). Read ~/.t3-map/policy.md; it is authoritative for decision rights. Send policy messages there with t3_thread_send: "Decision: … at HH:MM UTC unless you object." (proceed after 15 minutes without objection), or "Decision needed (user):" (hard stop; wait for an explicit yes). Done: only for user review or serious problems. No acknowledgements.`).catch(() => {});
    }
    await persistTeam();
    return [200, { ok: true, threadId }];
  }
  if (action === "manager") {
    const projectId = str(body.projectId, 400);
    if (!projectId || !projects.has(projectId) || isNoProject(projects.get(projectId))) return [400, { error: "Pick a project." }];
    if (body.mode === "ensure") {
      const assigned = team.managers[projectId];
      if (assigned) return [200, { ok: true, threadId: assigned.threadId }];
      // Repeated clicks share one launch, including while T3 is still starting it.
      if (managerStarts.has(projectId)) return managerStarts.get(projectId);
      // The Boss may already have started "<project> Manager" itself. Register that thread
      // instead of starting a second Manager next to it.
      const existing = await existingManager(projectId);
      if (existing) {
        team.managers[projectId] = { threadId: existing.id, project: projectTitle(projectId) };
        await persistTeam();
        return [200, { ok: true, threadId: existing.id, adopted: true }];
      }
      const pending = teamAction({ action: "manager", mode: "new", projectId, provider: "codex", model: "gpt-6.1-sol" });
      managerStarts.set(projectId, pending);
      try { return await pending; } finally { managerStarts.delete(projectId); }
    }
    const brief = managerBrief({ project: projectTitle(projectId), bossThreadId: team.boss?.threadId ?? null, level: levelOf(team, projectId) });
    let threadId;
    if (body.mode === "adopt") {
      threadId = str(body.threadId, 400);
      const t = threadId && raw.get(threadId);
      if (!t) return [404, { error: "That thread is no longer in T3." }];
      if (t.projectId !== projectId) return [400, { error: "Pick a thread from this project." }];
      if (team.boss?.threadId === threadId) return [400, { error: "That thread is the Boss." }];
      await sendText(threadId, brief);
      if (!DEMO) shell.dispatch({ type: "thread.pin", threadId }).catch(() => {});
    } else {
      threadId = await startRole({ projectId, title: `${projectTitle(projectId)} Manager`, text: brief, provider: body.provider, model: body.model });
    }
    team.managers[projectId] = { threadId, project: projectTitle(projectId) };
    await persistTeam();
    return [200, { ok: true, threadId }];
  }
  if (action === "autonomy") {
    const projectId = str(body.projectId, 400);
    if (!projectId || !projects.has(projectId) || !LEVELS.includes(body.level)) return [400, { error: "Choose cautious, normal or bold." }];
    if (levelOf(team, projectId) === body.level) return [200, { ok: true }];
    team.autonomy[projectId] = body.level;
    const m = team.managers[projectId];
    if (m && raw.has(m.threadId)) await sendText(m.threadId, autonomyNote(body.level));
    await persistTeam();
    return [200, { ok: true }];
  }
  if (action === "unassign") {
    if (body.role === "boss") team.boss = null;
    else if (body.role === "manager" && str(body.projectId, 400)) delete team.managers[body.projectId];
    else return [400, { error: "Unknown role." }];
    await persistTeam();
    return [200, { ok: true }];
  }
  return [400, { error: "Unknown team action." }];
}

// ---- HTTP ------------------------------------------------------------------

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

function json(res, code, body) {
  res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true; // non-browser callers on loopback
  return origin === `http://127.0.0.1:${boundPort}` || origin === `http://localhost:${boundPort}`;
}

async function readJson(req) {
  let body = "";
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 64_000) throw Object.assign(new Error("The message is too large."), { status: 413 });
  }
  let out;
  try { out = JSON.parse(body || "{}"); }
  catch { throw Object.assign(new Error("Invalid JSON."), { status: 400 }); }
  if (!out || typeof out !== "object" || Array.isArray(out)) throw Object.assign(new Error("Expected a JSON object."), { status: 400 });
  return out;
}

// Only answer requests addressed to our loopback name, so a DNS-rebinding page
// on another domain can't read your thread titles through the stream.
const server = createServer(async (req, res) => {
  res.setHeader("x-content-type-options", "nosniff");
  res.setHeader("content-security-policy", "frame-ancestors 'none'");
  const host = String(req.headers.host).toLowerCase();
  if (host !== `${HOST}:${boundPort}` && host !== `localhost:${boundPort}`) return json(res, 421, { error: "Misdirected request" });
  const url = new URL(req.url, `http://${HOST}:${boundPort}`);

  if (url.pathname === "/api/stream") {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-store",
      connection: "keep-alive",
    });
    res.write(`retry: 1500\nevent: state\ndata: ${JSON.stringify(stateMessage())}\n\n`);
    clients.add(res);
    req.on("close", () => clients.delete(res));
    return;
  }

  if (url.pathname === "/api/health") return json(res, 200, { ok: true, status: shell.status });

  if (req.method === 'POST' && url.pathname === '/api/images') {
    if (!sameOrigin(req) || !IMAGE_TYPES.includes(req.headers['content-type'])) return json(res, 403, { error: 'Choose a PNG, JPEG, GIF or WebP image from this map.' });
    try {
      const chunks = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > MAX_IMAGE_BYTES) throw Object.assign(new Error('Each image can be at most 10 MiB.'), { status: 413 });
        chunks.push(chunk);
      }
      const name = decodeURIComponent(String(req.headers['x-image-name'] ?? 'image.png'));
      return json(res, 200, await images.upload(name, req.headers['content-type'], Buffer.concat(chunks)));
    } catch (e) { return json(res, e.status ?? 502, { error: e.message }); }
  }
  if (req.method === 'GET' && url.pathname.startsWith('/api/image/')) {
    try {
      const [threadId, attachmentId, extra] = url.pathname.slice('/api/image/'.length).split('/').map(decodeURIComponent);
      if (extra || !raw.has(threadId)) return json(res, 404, { error: 'Image not found.' });
      const [, view] = await getThread(threadId);
      const attachment = view.turns.flatMap((t) => t.user?.attachments ?? []).find((a) => a.type === 'image' && a.id === attachmentId);
      if (!attachment) return json(res, 404, { error: 'This image is not attached to the conversation.' });
      const bytes = await images.preview(attachment);
      res.writeHead(200, { 'content-type': attachment.mimeType, 'cache-control': 'private, max-age=300' });
      return res.end(bytes);
    } catch (e) { return json(res, e.status ?? 502, { error: e.message }); }
  }

  if (req.method === "GET" && url.pathname.startsWith("/api/thread/")) {
    try {
      const [code, out] = await getThread(decodeURIComponent(url.pathname.slice("/api/thread/".length)));
      return json(res, code, out);
    } catch (e) {
      return json(res, 502, { error: e.message || "T3 couldn't load that thread." });
    }
  }
  if (req.method === "GET" && url.pathname === "/api/team") return json(res, 200, teamView());
  if (req.method === "GET" && url.pathname === "/api/agents") {
    try { const [code, out] = await agents(); return json(res, code, out); }
    catch (e) { return json(res, 502, { error: e.message }); }
  }
  if (req.method === "GET" && url.pathname.startsWith("/api/changes/")) {
    try { const [code, out] = await changes(decodeURIComponent(url.pathname.slice("/api/changes/".length))); return json(res, code, out); }
    catch (e) { return json(res, 502, { error: e.message || "T3 couldn't load changes." }); }
  }

  if (req.method === "POST" && url.pathname.startsWith("/api/")) {
    if (!sameOrigin(req) || !String(req.headers["content-type"]).startsWith("application/json")) {
      return json(res, 403, { error: "Forbidden" });
    }
    try {
      const body = await readJson(req);
      const handler = { "/api/act": act, "/api/start": start, "/api/team": teamAction, '/api/images/remove': async (b) => { await images.remove(b.id); return [200, { ok: true }]; } }[url.pathname];
      if (!handler) return json(res, 404, { error: "Unknown action" });
      const [code, out] = await handler(body);
      return json(res, code, out);
    } catch (e) {
      return json(res, e.status ?? 502, { error: e.message || "Couldn't hand that to T3." });
    }
  }

  // Static files.
  const path = url.pathname === "/" ? "/index.html" : url.pathname;
  let file;
  try { file = normalize(join(WEB, decodeURIComponent(path))); }
  catch { return json(res, 400, { error: "Invalid URL." }); }
  if (!file.startsWith(normalize(WEB) + (WEB.endsWith(sep) ? "" : sep)) && file !== normalize(WEB)) {
    return json(res, 403, { error: "Forbidden" });
  }
  try {
    const data = await readFile(file);
    res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream", "cache-control": "no-cache" });
    res.end(data);
  } catch {
    json(res, 404, { error: "Not found" });
  }
});

server.listen(PORT, HOST, () => {
  boundPort = server.address().port;
  shell.start();
  if (DESKTOP) console.log(JSON.stringify({ type: "t3-map-ready", port: boundPort }));
  else console.log(`T3 Map${DEMO ? " (demo data)" : ""} → http://${HOST}:${boundPort}`);
});

if (DESKTOP) {
  // The owning desktop keeps this pipe open. EOF also cleans up after a crash.
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    shell.stop();
    for (const res of clients) res.end();
    server.close(() => process.exit(0));
    server.closeAllConnections();
    setTimeout(() => process.exit(0), 1000).unref();
  };
  process.stdin.resume();
  process.stdin.on("end", stop);
  process.stdin.on("error", stop);
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}
