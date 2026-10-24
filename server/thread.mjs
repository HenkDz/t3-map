// Turn T3's thread projection into a calm conversation: what you asked, what the
// agent answered, and the work in between folded into a single "Worked for…" row.

const MAX_ANSWER = 24_000;
const MAX_STEPS = 80;

const base = (p) => String(p ?? "").split(/[\\/]/).filter(Boolean).pop() ?? "";
const clip = (s, n) => {
  s = String(s ?? "").replace(/\s+/g, " ").trim();
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
};
const ms = (iso) => (iso ? Date.parse(iso) : 0);

// Keep image references intact so their inline chips retain the attachment binding.
export function cleanUserText(text) {
  return String(text ?? "")
    .replace(/(!?)\[([^\]]*)\]\(t3-context:\/\/([^)]*)\)/g, (source, _, label, path) => path.startsWith('v1/image/') ? source : `[${label || 'attachment'}]`)
    .trim();
}

export function stepOf(item) {
  switch (item.type) {
    case "command_execution":
      return { kind: "command", text: clip(String(item.input ?? "").split("\n")[0], 110), failed: Boolean(item.outputIndicatesFailure || (item.exitCode ?? 0) !== 0 || item.status === "failed") };
    case "file_change": {
      const counts = item.additions != null || item.deletions != null ? ` +${item.additions ?? 0} −${item.deletions ?? 0}` : "";
      return { kind: "edit", text: `${base(item.fileName)}${counts}`, failed: item.status === "failed" };
    }
    case "dynamic_tool":
      return { kind: "tool", text: clip(item.title || item.toolName || "Used a tool", 110), failed: item.status === "failed" };
    case "reasoning":
      return { kind: "think", text: clip(item.text, 140) || "Thought it through" };
    case "assistant_message":
      return { kind: "note", text: clip(item.text, 220) };
    case "web_search":
      return { kind: "search", text: `Searched the web${item.patterns?.length ? `: ${clip(item.patterns.join(", "), 90)}` : ""}` };
    case "file_search":
      return { kind: "search", text: `Searched files${item.pattern ? `: ${clip(item.pattern, 90)}` : ""}` };
    case "todo_list":
      return { kind: "plan", text: `Updated its checklist (${item.steps?.length ?? 0} steps)` };
    case "notification":
      return { kind: "note", text: clip(item.title || item.text || "Notification", 140) };
    case "checkpoint":
    case "proposed_plan":
    case "user_input_request":
    case "approval_request":
      return null;
    default:
      return item.title ? { kind: "tool", text: clip(item.title, 110) } : null;
  }
}

export function slimProjection(p, shellThread) {
  const items = [...(p.visibleTurnItems ?? [])].sort((a, b) => a.position - b.position).map((v) => v.item);
  const omittedHead = items.length > 0 && items[0].type !== 'user_message';
  const pendingIds = new Set((p.runtimeRequests ?? []).filter((r) => r.status === "pending").map((r) => r.id));
  const runs = new Map((p.runs ?? []).map((r) => [r.id, r]));
  const messages = new Map((p.messages ?? []).map((m) => [m.id, m]));
  const visibleMessages = new Set(items.map((it) => it.messageId).filter(Boolean));
  // Long tool runs can push the user's image-bearing message out of the item window.
  for (const message of [...messages.values()].filter((m) => !visibleMessages.has(m.id) && ['user', 'assistant'].includes(m.role) && typeof m.text === 'string').sort((a, b) => ms(a.createdAt) - ms(b.createdAt))) {
    const at = items.findIndex((it) => ms(it.startedAt ?? it.updatedAt) >= ms(message.createdAt));
    items.splice(at < 0 ? items.length : at, 0, { ...message, messageId: message.id, type: message.role === 'user' ? 'user_message' : 'assistant_message', startedAt: message.createdAt });
  }
  const priorTasks = (p.plans ?? []).findLast((plan) => plan.kind === 'todo_list' && plan.status !== 'superseded' && plan.steps?.length);
  let tasks = priorTasks ? { id: priorTasks.id, explanation: priorTasks.explanation ?? '', steps: priorTasks.steps.map(({ id, text, status }) => ({ id, text, status })) } : null;

  const turns = [];
  let turn = null;
  let pending = null;
  const open = (user) => {
    turn = { user, steps: [], stepCount: 0, answer: null, plan: null, runIds: new Set(), startedAt: null, endedAt: null, failed: 0 };
    turns.push(turn);
  };

  for (const it of items) {
    if (it.type === "user_message") {
      const message = messages.get(it.messageId);
      open({ text: cleanUserText(it.text), at: it.startedAt ?? it.updatedAt, byAgent: it.createdBy === "agent" || Boolean(it.senderThreadId), attachments: (it.attachments ?? message?.attachments ?? []).filter((a) => a.type === 'image').map(({ type, id, name, mimeType, sizeBytes }) => ({ type, id, name, mimeType, sizeBytes })), context: it.context ?? message?.context ?? null });
      if (it.runId) turn.runIds.add(it.runId);
      continue;
    }
    if (!turn) open(null);
    if (it.runId) turn.runIds.add(it.runId);
    turn.startedAt ??= it.startedAt ?? null;
    if (it.completedAt && ms(it.completedAt) > ms(turn.endedAt)) turn.endedAt = it.completedAt;

    if (it.type === "assistant_message") {
      // The last thing the agent said in a turn is its answer; earlier words are part of the work.
      if (turn.answer) pushStep(turn, { kind: "note", text: clip(turn.answer.text, 220) });
      turn.answer = { text: String(it.text ?? "").slice(0, MAX_ANSWER), at: it.completedAt ?? it.startedAt, streaming: Boolean(it.streaming) };
      continue;
    }
    if (it.type === "proposed_plan") {
      turn.plan = { planId: it.planId, markdown: String(it.markdown ?? "").slice(0, MAX_ANSWER) };
      continue;
    }
    if (it.type === 'todo_list' && !priorTasks) {
      tasks = { id: it.planId ?? it.id, explanation: it.explanation ?? '', steps: (it.steps ?? []).map(({ id, text, status }) => ({ id, text, status })) };
    }
    if (it.type === "user_input_request" && pendingIds.has(it.requestId)) {
      pending = {
        kind: "question",
        requestId: it.requestId,
        questions: (it.questions ?? []).map((q) => ({
          id: q.id,
          header: q.header,
          question: q.question,
          multiSelect: Boolean(q.multiSelect),
          required: q.required !== false,
          allowCustom: q.allowCustomAnswer !== false,
          options: (q.options ?? []).map((o) => ({ label: o.label, description: o.description ?? "", value: o.value ?? o.label })),
        })),
      };
      continue;
    }
    if (it.type === "approval_request" && pendingIds.has(it.requestId)) {
      pending = {
        kind: "approval",
        requestId: it.requestId,
        requestKind: it.requestKind,
        prompt: it.prompt ?? null,
        reason: it.reason ?? null,
        appName: it.appName ?? null,
        options: (it.options ?? []).map((o) => typeof o === "string" ? { decision: o } : { decision: o.decision, label: o.label, warning: o.warning }).filter((o) => typeof o.decision === "string"),
      };
      continue;
    }
    const step = stepOf(it);
    if (step) pushStep(turn, step);
    if (step?.failed) turn.failed++;
  }

  // Pending requests whose item fell outside the bounded projection still need an answer.
  if (!pending) {
    const req = (p.runtimeRequests ?? []).find((r) => r.status === "pending");
    if (req) pending = { kind: req.kind === "user_input" ? "question" : "approval", requestId: req.id, requestKind: req.kind, questions: [], options: [], prompt: null, reason: null };
  }

  const out = turns.map((t, i) => {
    const run = [...t.runIds].map((id) => runs.get(id)).filter(Boolean).pop();
    // Only the latest turn can still be running; earlier ones were steered past.
    const running = i === turns.length - 1 && Boolean(run && ["preparing", "queued", "starting", "running", "waiting"].includes(run.status));
    const startedAt = t.user?.at ?? t.startedAt ?? run?.startedAt ?? null;
    const endedAt = running ? null : t.endedAt ?? run?.completedAt ?? null;
    return {
      user: t.user,
      steps: t.steps,
      stepCount: t.stepCount,
      failedSteps: t.failed,
      answer: t.answer ? { ...t.answer, truncated: t.answer.text.length === MAX_ANSWER } : null,
      plan: t.plan,
      running,
      status: run?.status ?? null,
      startedAt,
      endedAt,
    };
  });

  return {
    threadId: p.thread?.id ?? shellThread?.id,
    turns: out,
    tasks,
    pending,
    actionablePlan: Boolean(p.thread?.hasActionableProposedPlan ?? shellThread?.hasActionableProposedPlan),
    partial: omittedHead || (turns.length > 0 && !turns[0].user) || (p.messages ?? []).filter((m) => m.role === "user").length > turns.filter((t) => t.user).length,
  };
}

function pushStep(turn, step) {
  turn.stepCount++;
  if (turn.steps.length < MAX_STEPS) turn.steps.push(step);
  else turn.steps[MAX_STEPS - 1] = { kind: "more", text: `${turn.stepCount - MAX_STEPS + 1} more steps` };
}
