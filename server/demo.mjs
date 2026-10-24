// Demo feed: T3-shaped threads that change over time, for previewing the map
// without touching a real T3. Runs only when T3_MAP_DEMO=1, and the UI labels it.

import { EventEmitter } from "node:events";

const iso = (msAgo = 0) => new Date(Date.now() - msAgo).toISOString();
const min = 60_000;

const PROJECTS = [
  ["p-mono", "Moonbeam Studio", "storybook-demo/moonbeam-studio"],
  ["p-dz", "Clover Market", "storybook-demo/clover-market"],
  ["p-ep", "Sunflower Academy", "storybook-demo/sunflower-academy"],
  ["p-af", "Paper Kite Post", "storybook-demo/paper-kite-post"],
  ["p-wg", "Campfire Club", "storybook-demo/campfire-club"],
  ["p-bl", "Pebble Browser", null],
  ["p-tb", "Puddle Bot", "storybook-demo/puddle-bot"],
  ["p-wr", "Acorn Notes", null],
  ["p-none", "No project", null],
].map(([id, title, repo]) => ({
  id,
  title,
  workspaceRoot: id === "p-none" ? "C:\\Users\\you\\.t3\\scratch" : `E:\\Projects\\AI\\${title}`,
  repositoryIdentity: repo ? { owner: repo.split("/")[0], name: repo.split("/")[1] } : null,
  projectIcon: null,
}));

let n = 0;
function thread(projectId, title, provider, model, over = {}) {
  const id = over.id ?? `demo-${++n}`;
  return {
    id,
    projectId,
    title,
    providerInstanceId: provider,
    modelSelection: { instanceId: provider, model },
    createdBy: over.parent ? "agent" : "user",
    lineage: { parentThreadId: over.parent ?? null, relationshipToParent: over.parent ? "subagent" : null, rootThreadId: over.parent ?? id },
    branch: over.branch ?? null,
    status: "running",
    activityRunStatus: "running",
    activityRunStartedAt: iso(over.age ?? 6 * min),
    latestRunStartedAt: iso(over.age ?? 6 * min),
    latestRunCompletedAt: null,
    latestUserMessageAt: iso(over.age ?? 6 * min),
    latestUserAuthoredMessageAt: over.parent ? null : iso(over.age ?? 6 * min),
    pendingRuntimeRequest: null,
    hasActionableProposedPlan: false,
    lastError: null,
    usageLimitResetAt: null,
    blockedOnThreadWait: false,
    itemCount: 10 + Math.floor(Math.random() * 30),
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    createdAt: iso((over.age ?? 6 * min) + 3 * min),
    updatedAt: iso(),
    archivedAt: null,
    deletedAt: null,
    ...over.raw,
  };
}

function scenario() {
  const lead = thread("p-mono", "Command map: living network pulses", "claudeAgent", "claude-opus-5-5", { id: "d-lead", age: 18 * min, branch: "ccmap3/pulses" });
  const subA = thread("p-mono", "Pulse cap and coalescing tests", "codex", "gpt-6.1-sol", { id: "d-subA", parent: "d-lead", age: 9 * min });
  const subB = thread("p-mono", "Reduced-motion audit", "codex", "gpt-6-luna", {
    id: "d-subB", parent: "d-lead", age: 12 * min,
    raw: { status: "completed", activityRunStatus: null, latestRunCompletedAt: iso(2 * min) },
  });
  const notes = thread("p-mono", "Checkpoint 10 release notes", "codex", "gpt-6.1-sol", {
    id: "d-notes", age: 4 * min,
    raw: { status: "running", activityRunStatus: "waiting", pendingRuntimeRequest: { id: "rq1", kind: "user_input", createdAt: iso(3 * min), blocking: true } },
  });
  const inv = thread("p-dz", "Distributor invoicing export", "codex", "gpt-6.1-sol", { id: "d-inv", age: 22 * min, branch: "codex/invoicing-export" });
  const xls = thread("p-dz", "Parse the legacy XLS fixtures", "grok", "grok-4.7", { id: "d-xls", parent: "d-inv", age: 7 * min });
  const rtl = thread("p-dz", "Fix homepage pricing RTL", "claudeAgent", "claude-opus-5-5", {
    id: "d-rtl", age: 40 * min, branch: "codex/fix-homepage-pricing-rtl",
    raw: { status: "completed", activityRunStatus: null, latestRunCompletedAt: iso(6 * min) },
  });
  const sales = thread("p-dz", "Product sales report", "opencode", "opencode-go/kimi-k3", {
    id: "d-sales", age: 30 * min,
    raw: { status: "failed", activityRunStatus: null, usageLimitResetAt: new Date(Date.now() + 95 * min).toISOString(), latestRunCompletedAt: iso(11 * min) },
  });
  const deploy = thread("p-ep", "Promote staging to production", "claudeAgent", "claude-sonnet-5-5", {
    id: "d-deploy", age: 9 * min,
    raw: { status: "running", activityRunStatus: "waiting", pendingRuntimeRequest: { id: "rq2", kind: "dynamic_tool_call", createdAt: iso(1 * min), blocking: true } },
  });
  const ledger = thread("p-af", "Ledger foundation", "pi", "openai-codex/gpt-6.1-sol", { id: "d-ledger", age: 14 * min, branch: "codex/issue-17-ledger-foundation" });
  const plan = thread("p-af", "Carrier rate-card importer", "acpRegistry_deepseek_harness", '["openai-codex","gpt-6-luna"]', {
    id: "d-plan", age: 5 * min,
    raw: { status: "completed", activityRunStatus: null, latestRunCompletedAt: iso(1 * min), hasActionableProposedPlan: true },
  });
  const boss = thread("p-none", "Boss", "claudeAgent", "claude-opus-5-5", {
    id: "d-boss", age: 45 * min,
    raw: {
      status: "running", activityRunStatus: "waiting",
      pendingRuntimeRequest: { id: "rq-boss", kind: "user_input", createdAt: iso(2 * min), blocking: true },
      demoQuestion: { id: "xls", header: "XLS", question: "The Clover Market Manager asks: 3 shopkeepers still upload the legacy XLS template. Support it, or go CSV-only and announce a deprecation?", multiSelect: false, allowCustom: true, options: [{ label: "CSV only, announce deprecation", description: "Boss recommends: less to maintain, one week notice", value: "csv" }, { label: "Support XLS too", description: "About a day of work plus a parser to maintain", value: "xls" }] },
    },
  });
  return [boss, lead, subA, subB, notes, inv, xls, rtl, sales, deploy, ledger, plan];
}

/** The demo's team: a Boss, and Managers for two of the four busy projects. */
export function demoTeam() {
  return {
    boss: { threadId: "d-boss" },
    managers: { "p-mono": { threadId: "d-lead", project: "Moonbeam Studio" }, "p-dz": { threadId: "d-inv", project: "Clover Market" } },
    autonomy: { "p-dz": "cautious" },
  };
}

export class DemoShell extends EventEmitter {
  constructor() {
    super();
    this.status = { state: "live", detail: "Demo data — not your T3" };
    this.info = { environmentId: null, serverVersion: "demo", demo: true };
    this.threads = new Map();
    this.completions = new Map();
  }

  start() {
    for (const t of scenario()) this.threads.set(t.id, t);
    setTimeout(() => {
      this.emit("status", this.status);
      this.emit("snapshot", { threads: [...this.threads.values()], projects: PROJECTS });
    }, 50);
    const loop = () => {
      this.step();
      this.timer = setTimeout(loop, 900 + Math.random() * 1600);
    };
    this.timer = setTimeout(loop, 1500);
  }

  stop() {
    clearTimeout(this.timer);
    for (const timer of this.completions.values()) clearTimeout(timer);
  }

  // ---- thread panel (simulated; nothing reaches a real T3) ----

  projection(id) {
    const t = this.threads.get(id);
    const said = (this.said ??= new Map()).get(id) ?? [];
    const started = t.latestRunStartedAt ?? t.createdAt;
    const working = ["running", "waiting"].includes(t.activityRunStatus);
    const steps = [
      { kind: "think", text: "Read the brief and the files it touches" },
      { kind: "command", text: "rg -n \"pulse\" web/map.js" },
      { kind: "edit", text: "map.js +84 −12" },
      { kind: "command", text: "npm test" },
      { kind: "note", text: "Tests pass; checking the reduced-motion path next." },
    ];
    const answers = {
      reported: `Done. **${t.title}** is finished.\n\n- 14 focused tests pass\n- No changes outside \`web/\`\n\nNext I'd suggest a quick look at the narrow layout.`,
      failed: t.usageLimitResetAt ? "I hit the usage limit for this model, so I paused. I'll pick up where I left off once it resets." : "The last run failed: the build step exited with code 1.",
      idle: "All set — nothing else pending here.",
    };
    const first = {
      user: { text: `${t.title}. Keep it small and tell me when it's ready.`, at: t.createdAt, byAgent: t.createdBy === "agent" },
      steps,
      stepCount: 23,
      failedSteps: t.state === "failed" ? 1 : 0,
      answer: working ? { text: "Working on it — the core change is in, running the checks now.", at: iso(), streaming: true } : { text: answers[t.status === "failed" ? "failed" : t.latestRunCompletedAt ? "reported" : "idle"] ?? answers.idle, at: t.latestRunCompletedAt ?? iso() },
      plan: t.hasActionableProposedPlan ? { planId: "plan-1", markdown: "### Plan\n1. Parse the carrier CSV into rate rows\n2. Validate lanes against the zone table\n3. Show a diff before importing\n\nNo schema changes." } : null,
      running: working,
      status: working ? "running" : "completed",
      startedAt: started,
      endedAt: working ? null : t.latestRunCompletedAt ?? iso(),
    };
    const turns = [first, ...said];
    const req = t.pendingRuntimeRequest;
    const pending = !req ? null
      : req.kind === "user_input" && t.demoQuestion
        ? { kind: "question", requestId: req.id, questions: [t.demoQuestion] }
      : req.kind === "user_input"
        ? { kind: "question", requestId: req.id, questions: [{ id: "q1", header: "Format", question: "Should the release notes ship as a draft for review, or go out as final?", multiSelect: false, allowCustom: true, options: [{ label: "Draft first", description: "You review before it's published", value: "draft" }, { label: "Publish as final", description: "Goes out with the release", value: "final" }] }] }
        : { kind: "approval", requestId: req.id, requestKind: "command", prompt: "git push origin staging:production", reason: "Promote the tested staging build to production.", options: ["accept", "decline"] };
    return { threadId: id, turns, pending, actionablePlan: Boolean(t.hasActionableProposedPlan), partial: false, tasks: { id: 'demo-tasks', explanation: 'Image context and conversation experience', steps: [{ id: 'inspect', text: 'Inspect the brief and existing behavior', status: 'completed' }, { id: 'build', text: 'Build the requested change', status: working ? 'running' : 'completed' }, { id: 'check', text: 'Run checks and report the result', status: working ? 'pending' : 'completed' }] } };
  }

  act(id, action, body) {
    const now = iso();
    const said = (this.said ??= new Map());
    const add = (text) => said.set(id, [...(said.get(id) ?? []), { user: { text, at: now, attachments: body.attachments ?? [], context: body.context ?? null }, steps: [], stepCount: 0, failedSteps: 0, answer: null, plan: null, running: true, status: "running", startedAt: now, endedAt: null }]);
    const wake = { status: "running", activityRunStatus: "running", latestRunStartedAt: now, activityRunStartedAt: now, latestUserMessageAt: now, latestUserAuthoredMessageAt: now, settledOverride: "active", settledAt: null };
    if (["send", "plan", "answer", "decide", "stop", "dismiss"].includes(action)) clearTimeout(this.completions.get(id));
    if (action === "send") (add(String(body.text ?? "")), this.update(id, wake));
    else if (action === "plan") (add("Go ahead with the plan."), this.update(id, { ...wake, hasActionableProposedPlan: false }));
    else if (action === "answer" || action === "decide" || action === "dismiss") this.update(id, { ...wake, pendingRuntimeRequest: null });
    else if (action === "stop") {
      const list = said.get(id);
      if (list?.length) list[list.length - 1] = { ...list.at(-1), running: false, status: "cancelled", endedAt: now };
      this.update(id, { status: "cancelled", activityRunStatus: null, latestRunCompletedAt: now, pendingRuntimeRequest: null });
    }
    else if (action === "read") this.update(id, { lastVisitedAt: now });
    else if (action === "settle") this.update(id, { settledOverride: "settled", settledAt: now, lastVisitedAt: now });
    // Simulated agents finish a little later.
    if (["send", "plan", "answer", "decide"].includes(action)) {
      this.completions.set(id, setTimeout(() => {
        const list = said.get(id);
        if (list?.length) list[list.length - 1] = { ...list[list.length - 1], running: false, status: "completed", endedAt: iso(), stepCount: 6, steps: [{ kind: "think", text: "Took your note into account" }, { kind: "edit", text: "notes.md +12 −3" }], answer: { text: "Done — updated as you asked.", at: iso() } };
        this.update(id, { status: "completed", activityRunStatus: null, latestRunCompletedAt: iso() });
        this.completions.delete(id);
      }, 1800));
    }
    return { ok: true };
  }

  changes(id) {
    return { threadId: id, toTurnCount: 1, diff: 'diff --git a/notes.md b/notes.md\n--- a/notes.md\n+++ b/notes.md\n@@ -1 +1,2 @@\n-Review pending\n+Review complete\n+All focused checks pass\n' };
  }

  startThread(projectId, text, options = {}) {
    const t = thread(projectId, options.title || text.replace(/!?\[[^\]\n]*\]\(t3-context:[^)]*\)/g, 'image').split("\n")[0].slice(0, 80), options.provider || "claudeAgent", options.model || "claude-opus-5-5", { age: 0, branch: options.worktree ? options.branch || 'demo/new-work' : null });
    this.threads.set(t.id, t);
    (this.said ??= new Map()).set(t.id, [{ user: { text, at: iso(), attachments: options.attachments ?? [], context: options.context ?? null }, steps: [], stepCount: 0, failedSteps: 0, answer: { text: 'This is simulated work. Your real T3 has not been changed.', at: iso() }, plan: null, running: true, status: 'running', startedAt: iso(), endedAt: null }]);
    this.emit("thread", t);
    return { ok: true, threadId: t.id };
  }

  update(id, patch) {
    const prev = this.threads.get(id);
    const next = { ...prev, ...patch, updatedAt: iso() };
    this.threads.set(id, next);
    this.emit("thread", next);
  }

  step() {
    const T = (id) => this.threads.get(id);
    const roll = Math.random();
    const working = [...this.threads.values()].filter((t) => t.activityRunStatus === "running");

    if (roll < 0.14) {
      // You message the lead.
      this.update("d-lead", { latestUserMessageAt: iso(), latestUserAuthoredMessageAt: iso(), itemCount: T("d-lead").itemCount + 1 });
    } else if (roll < 0.28) {
      // A lead hands work to a subagent: wake the finished one with a new task.
      const sub = T("d-subB").status === "completed" ? "d-subB" : "d-xls";
      this.update(sub, { status: "running", activityRunStatus: "running", latestUserMessageAt: iso(), latestRunStartedAt: iso(), activityRunStartedAt: iso() });
    } else if (roll < 0.42) {
      // A subagent reports back to its lead.
      const sub = ["d-subA", "d-subB", "d-xls"].map(T).find((t) => t.activityRunStatus === "running" && Math.random() < 0.7);
      if (sub) this.update(sub.id, { status: "completed", activityRunStatus: null, latestRunCompletedAt: iso(), itemCount: sub.itemCount + 2 });
    } else if (roll < 0.47) {
      // The ledger work asks a question, or gets its answer.
      const t = T("d-ledger");
      this.update("d-ledger", t.pendingRuntimeRequest
        ? { pendingRuntimeRequest: null, activityRunStatus: "running", latestUserAuthoredMessageAt: iso(), latestUserMessageAt: iso() }
        : { pendingRuntimeRequest: { id: "rq3", kind: "user_input", createdAt: iso(), blocking: true }, activityRunStatus: "waiting" });
    } else if (roll < 0.5) {
      // The invoicing export finishes, then gets picked up again.
      const t = T("d-inv");
      this.update("d-inv", t.activityRunStatus
        ? { status: "completed", activityRunStatus: null, latestRunCompletedAt: iso() }
        : { status: "running", activityRunStatus: "running", latestUserAuthoredMessageAt: iso(), latestUserMessageAt: iso(), latestRunStartedAt: iso(), activityRunStartedAt: iso() });
    } else if (working.length) {
      // Plain progress inside a working thread.
      const t = working[Math.floor(Math.random() * working.length)];
      this.update(t.id, { itemCount: t.itemCount + 1 + Math.floor(Math.random() * 3) });
    }
  }
}
