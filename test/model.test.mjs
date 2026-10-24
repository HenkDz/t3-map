import { test } from "node:test";
import assert from "node:assert/strict";
import { deriveState, diffThread, isSettled, linkWidth, modelName, normalizeThread, providerName } from "../server/model.mjs";

const base = {
  id: "t1",
  projectId: "p1",
  title: "Fix the thing",
  providerInstanceId: "codex",
  modelSelection: { instanceId: "codex", model: "gpt-6.1-sol" },
  createdBy: "user",
  lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: "t1" },
  status: "idle",
  activityRunStatus: null,
  pendingRuntimeRequest: null,
  hasActionableProposedPlan: false,
  itemCount: 4,
  latestRunCompletedAt: null,
  lastVisitedAt: null,
  settledOverride: null,
  settledAt: null,
  updatedAt: "2026-10-23T10:00:00.000Z",
  createdAt: "2026-10-23T09:00:00.000Z",
  archivedAt: null,
  deletedAt: null,
};
const t = (over) => ({ ...base, ...over });

test("needs-you beats everything, with a human reason", () => {
  const s = deriveState(t({ status: "running", activityRunStatus: "running", pendingRuntimeRequest: { id: "r", kind: "dynamic_tool_call", createdAt: "x" } }));
  assert.equal(s.state, "needs");
  assert.match(s.reason, /approval/);
});

test("a run that is active counts as working even if the last run was cancelled", () => {
  assert.equal(deriveState(t({ status: "cancelled", activityRunStatus: "running" })).state, "working");
  assert.equal(deriveState(t({ status: "queued" })).state, "working");
});

test("waiting on subagents is its own calm state", () => {
  assert.equal(deriveState(t({ status: "running", activityRunStatus: "waiting" })).state, "waiting");
});

test("unread completed results are reported until visited or settled", () => {
  const done = { status: "completed", latestRunCompletedAt: "2026-10-23T10:00:00.000Z" };
  assert.equal(deriveState(t(done)).state, "reported");
  assert.equal(deriveState(t({ ...done, lastVisitedAt: "2026-10-23T10:01:00.000Z" })).state, "idle");
  assert.equal(deriveState(t({ ...done, settledOverride: "settled" })).state, "idle");
});

test("failures and usage limits read as failed", () => {
  assert.equal(deriveState(t({ status: "failed", lastError: "boom\nstack" })).reason, "boom");
  assert.equal(deriveState(t({ status: "failed", usageLimitResetAt: "2026-10-23T12:00:00.000Z" })).state, "failed");
});

test("old failure metadata cannot override a completed, cancelled or waiting run", () => {
  const stale = { lastError: "Earlier failure", usageLimitResetAt: "2026-10-23T12:00:00Z", limitRecovery: { runId: "parent:old", resetAt: "2026-10-23T12:00:00Z" }, latestRunId: "child:new" };
  const done = { ...stale, status: "completed", latestRunCompletedAt: "2026-10-23T13:00:00Z" };
  assert.equal(deriveState(t(done)).state, "reported");
  assert.equal(deriveState(t({ ...done, lastVisitedAt: "2026-10-23T13:01:00Z" })).state, "idle");
  for (const status of ["idle", "cancelled", "interrupted"]) assert.equal(deriveState(t({ ...stale, status })).state, "idle");
  assert.equal(deriveState(t({ ...stale, status: "running", activityRunStatus: "waiting" })).state, "waiting");
  assert.equal(deriveState(t({ ...stale, status: "running", activityRunStatus: "running" })).state, "working");
});

test("only the latest failed run's recovery describes its failure", () => {
  const failure = { status: "failed", latestRunId: "new", lastError: "Build failed" };
  assert.equal(deriveState(t({ ...failure, limitRecovery: { runId: "old", resetAt: "2026-10-23T12:00:00Z" } })).reason, "Build failed");
  const current = deriveState(t({ ...failure, limitRecovery: { runId: "new", resetAt: "2026-10-23T14:00:00Z" } }));
  assert.equal(current.reason, "Paused at a usage limit");
  assert.equal(current.resetsAt, "2026-10-23T14:00:00Z");
});

test("settled logic honours overrides and unsettle times", () => {
  assert.equal(isSettled(t({ settledAt: "2026-10-23T10:00:00.000Z" })), true);
  assert.equal(isSettled(t({ settledAt: "2026-10-23T10:00:00.000Z", unsettledAt: "2026-10-23T11:00:00.000Z" })), false);
  assert.equal(isSettled(t({ settledAt: "2026-10-23T10:00:00.000Z", settledOverride: "active" })), false);
});

test("settled idle threads are hidden; settled threads that need you are not", () => {
  assert.equal(normalizeThread(t({ settledOverride: "settled" })).visible, false);
  assert.equal(normalizeThread(t({ settledOverride: "settled", hasActionableProposedPlan: true })).visible, true);
});

test("settling a failed or usage-limited thread clears it from the active map until new work", () => {
  for (const failure of [{ status: "failed", lastError: "Build failed" }, { status: "failed", usageLimitResetAt: "2026-10-23T12:00:00Z" }]) {
    assert.equal(normalizeThread(t({ ...failure, settledOverride: "settled" })).visible, false);
    assert.equal(normalizeThread(t({ ...failure, settledOverride: "active" })).visible, true);
    assert.equal(normalizeThread(t({ ...failure, settledOverride: "settled", activityRunStatus: "running" })).visible, true);
  }
});

test("diff: your message is a call from you", () => {
  const prev = t({ latestUserAuthoredMessageAt: null, latestUserMessageAt: null });
  const next = t({ latestUserAuthoredMessageAt: "2026-10-23T10:00:00.000Z", latestUserMessageAt: "2026-10-23T10:00:00.000Z" });
  const [e] = diffThread(prev, next, 1);
  assert.deepEqual([e.type, e.from, e.to], ["call", "you", "t1"]);
});

test("diff: a subagent finishing answers its parent", () => {
  const sub = { createdBy: "agent", lineage: { parentThreadId: "lead", relationshipToParent: "subagent" } };
  const prev = t({ ...sub, status: "running", activityRunStatus: "running" });
  const next = t({ ...sub, status: "completed", latestRunCompletedAt: "2026-10-23T10:00:00.000Z" });
  const events = diffThread(prev, next, 1);
  assert.deepEqual(events.map((e) => [e.type, e.from, e.to]), [["answer", "t1", "lead"]]);
});

test("diff: a new subagent is a call from its lead", () => {
  const next = t({ createdBy: "agent", lineage: { parentThreadId: "lead", relationshipToParent: "subagent" } });
  assert.deepEqual(diffThread(undefined, next, 1).map((e) => [e.type, e.from]), [["call", "lead"]]);
});

test("diff: needs-you travels to you once", () => {
  const prev = t({});
  const next = t({ pendingRuntimeRequest: { id: "r", kind: "user_input", createdAt: "x" } });
  assert.deepEqual(diffThread(prev, next, 1).map((e) => [e.type, e.to]), [["needs", "you"]]);
  assert.deepEqual(diffThread(next, next, 1), []);
});

test("diff: plain progress is quiet work, and nothing happens without change", () => {
  assert.deepEqual(diffThread(t({}), t({ itemCount: 6 }), 1).map((e) => [e.type, e.weight]), [["work", 2]]);
  assert.deepEqual(diffThread(t({}), t({}), 1), []);
});

test("link width grows with activity and stays clamped", () => {
  assert.equal(linkWidth(0), 1.2);
  assert.ok(linkWidth(5) > linkWidth(1));
  assert.equal(linkWidth(1e6), 6);
});

test("names read like people would say them", () => {
  assert.equal(providerName("claudeAgent"), "Claude");
  assert.equal(providerName("acpRegistry_deepseek_harness"), "Deepseek Harness");
  assert.equal(modelName({ model: '["openai-codex","gpt-6-luna"]' }), "gpt-6-luna");
  assert.equal(modelName({ model: "opencode-go/kimi-k3" }), "kimi-k3");
});
