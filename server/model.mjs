// Pure translation from T3's orchestration shell stream into the map's model.
// Everything here is deterministic so it can be tested without a running T3.

const WORKING_RUN = new Set(["preparing", "starting", "running"]);
const WORKING_STATUS = new Set(["preparing", "queued", "starting", "running"]);

const PROVIDERS = {
  claudeAgent: "Claude",
  claudeTeam: "Claude Team",
  codex: "Codex",
  grok: "Grok",
  opencode: "OpenCode",
  pi: "Pi",
  cursor: "Cursor",
  gemini: "Gemini",
  copilot: "Copilot",
};

export function providerName(id) {
  if (!id) return "Agent";
  if (PROVIDERS[id]) return PROVIDERS[id];
  const acp = /^acpRegistry_(.+)$/.exec(id);
  const raw = acp ? acp[1] : id;
  return raw
    .split(/[_-]+/)
    .filter(Boolean)
    .map((w) => (w.length <= 2 ? w.toUpperCase() : w[0].toUpperCase() + w.slice(1)))
    .join(" ");
}

export function modelName(selection) {
  const model = selection?.model;
  if (!model) return null;
  // ACP harness models arrive as a JSON pair: ["provider","model"].
  if (model.startsWith("[")) {
    try {
      const pair = JSON.parse(model);
      if (Array.isArray(pair) && pair.length) return String(pair[pair.length - 1]);
    } catch {}
  }
  return model.includes("/") ? model.slice(model.lastIndexOf("/") + 1) : model;
}

const ms = (iso) => (iso ? Date.parse(iso) : 0);

export function isSettled(t) {
  if (t.settledOverride === "settled") return true;
  if (t.settledOverride === "active") return false;
  return Boolean(t.settledAt) && !(ms(t.unsettledAt) > ms(t.settledAt));
}

const NEED_REASON = {
  user_input: "Has a question for you",
  dynamic_tool_call: "Waiting for your approval",
  auth_refresh: "Needs you to sign in again",
};

/** The one state the map shows for a thread, in priority order. */
export function deriveState(t) {
  const req = t.pendingRuntimeRequest;
  if (req) {
    return { state: "needs", reason: NEED_REASON[req.kind] ?? "Needs your input", since: req.createdAt };
  }
  if (t.hasActionableProposedPlan) {
    return { state: "needs", reason: "Plan ready for your review", since: t.latestRunCompletedAt ?? t.updatedAt };
  }
  const working = WORKING_RUN.has(t.activityRunStatus) || WORKING_STATUS.has(t.status);
  if (isSettled(t) && !working && t.activityRunStatus !== "waiting" && !t.blockedOnThreadWait) {
    return { state: "idle", reason: "Settled", since: t.settledAt ?? t.updatedAt };
  }
  // Recovery and error fields can survive a fork or a later successful run.
  const recovery = t.limitRecovery?.runId === t.latestRunId ? t.limitRecovery : null;
  if (!working && t.status === "failed" && (t.usageLimitResetAt || recovery)) {
    return { state: "failed", reason: "Paused at a usage limit", since: t.updatedAt, resetsAt: t.usageLimitResetAt ?? recovery?.resetAt ?? null };
  }
  if (!working && t.status === "failed") {
    return { state: "failed", reason: shortError(t.lastError) ?? "The last run failed", since: t.latestRunCompletedAt ?? t.updatedAt };
  }
  if (t.activityRunStatus === "waiting" || (t.blockedOnThreadWait && !WORKING_RUN.has(t.activityRunStatus))) {
    return { state: "waiting", reason: "Waiting on its team", since: t.activityRunStartedAt ?? t.updatedAt };
  }
  if (working) {
    return { state: "working", reason: "Working", since: t.activityRunStartedAt ?? t.latestRunStartedAt ?? t.updatedAt };
  }
  const done = ms(t.latestRunCompletedAt);
  if (done && t.status === "completed" && !isSettled(t) && !(ms(t.lastVisitedAt) >= done)) {
    return { state: "reported", reason: "Finished — result to read", since: t.latestRunCompletedAt };
  }
  return { state: "idle", reason: isSettled(t) ? "Settled" : "Idle", since: t.updatedAt };
}

function shortError(text) {
  if (!text) return null;
  const line = String(text).split("\n").find((l) => l.trim()) ?? "";
  const clean = line.replace(/\s+/g, " ").trim();
  return clean.length > 90 ? clean.slice(0, 87) + "…" : clean;
}

const ACTIVE_STATES = new Set(["needs", "failed", "waiting", "working", "reported"]);

/** Threads the map draws: anything unsettled, plus anything that needs attention. */
export function isVisible(t, state) {
  if (t.deletedAt || t.archivedAt) return false;
  return ACTIVE_STATES.has(state) || !isSettled(t);
}

export function normalizeThread(t) {
  const { state, reason, since, resetsAt } = deriveState(t);
  const pr = t.linkedPullRequest ?? t.branchPullRequest ?? t.pullRequests?.[0] ?? null;
  return {
    id: t.id,
    projectId: t.projectId,
    title: t.title || "Untitled thread",
    provider: t.providerInstanceId,
    providerName: providerName(t.providerInstanceId),
    model: modelName(t.modelSelection),
    state,
    reason,
    since: since ?? t.updatedAt,
    resetsAt: resetsAt ?? null,
    request: t.pendingRuntimeRequest ? { kind: t.pendingRuntimeRequest.kind, blocking: t.pendingRuntimeRequest.blocking !== false } : null,
    parentId: t.lineage?.parentThreadId ?? null,
    relation: t.lineage?.relationshipToParent ?? null,
    byAgent: t.createdBy === "agent",
    branch: t.branch ?? null,
    pr: pr?.number ? { number: pr.number, url: pr.url ?? null } : null,
    goal: t.goal?.objective ?? t.goal?.title ?? null,
    items: t.itemCount ?? 0,
    startedAt: t.latestRunStartedAt ?? null,
    completedAt: t.latestRunCompletedAt ?? null,
    updatedAt: t.updatedAt,
    createdAt: t.createdAt,
    settled: isSettled(t),
    visible: isVisible(t, state),
  };
}

export function normalizeProject(p) {
  const repo = p.repositoryIdentity;
  return {
    id: p.id,
    title: p.title || repo?.name || "Project",
    root: p.workspaceRoot ?? null,
    repo: repo?.owner && repo?.name ? `${repo.owner}/${repo.name}` : null,
    icon: p.projectIcon ?? null,
  };
}

/**
 * Compare two raw versions of the same thread and describe what happened, in the
 * map's vocabulary. Only real transitions produce events; nothing is invented.
 */
export function diffThread(prev, next, at = Date.now()) {
  const events = [];
  const base = { threadId: next.id, projectId: next.projectId, at };
  if (!prev) {
    if (next.lineage?.parentThreadId && next.createdBy === "agent") {
      events.push({ ...base, type: "call", from: next.lineage.parentThreadId, to: next.id, text: "started" });
    }
    return events;
  }
  const a = deriveState(prev).state;
  const b = deriveState(next).state;

  if (ms(next.latestUserAuthoredMessageAt) > ms(prev.latestUserAuthoredMessageAt)) {
    events.push({ ...base, type: "call", from: "you", to: next.id, text: "message from you" });
  } else if (ms(next.latestUserMessageAt) > ms(prev.latestUserMessageAt)) {
    const from = next.createdBy === "agent" && next.lineage?.parentThreadId ? next.lineage.parentThreadId : "you";
    events.push({ ...base, type: "call", from, to: next.id, text: from === "you" ? "woken" : "message from its lead" });
  }

  if (b === "needs" && a !== "needs") {
    events.push({ ...base, type: "needs", from: next.id, to: "you", text: deriveState(next).reason });
  } else if (b === "failed" && a !== "failed") {
    events.push({ ...base, type: "failed", from: next.id, to: upstream(next), text: deriveState(next).reason });
  } else if (ms(next.latestRunCompletedAt) > ms(prev.latestRunCompletedAt) && next.status === "completed") {
    events.push({ ...base, type: "answer", from: next.id, to: upstream(next), text: "finished" });
  }

  const grew = (next.itemCount ?? 0) - (prev.itemCount ?? 0);
  if (grew > 0 && events.length === 0) {
    events.push({ ...base, type: "work", from: next.id, to: next.id, weight: grew });
  }
  return events;
}

function upstream(t) {
  return t.createdBy === "agent" && t.lineage?.parentThreadId ? t.lineage.parentThreadId : "you";
}

/** Width of a project link in px from its recent activity count. */
export function linkWidth(eventsInWindow) {
  const min = 1.2;
  const max = 6;
  if (!eventsInWindow) return min;
  // Logarithmic so one chatty thread doesn't dwarf the rest.
  return Math.min(max, min + Math.log2(1 + eventsInWindow) * 0.75);
}
