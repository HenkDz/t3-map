import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { autonomyNote, bossBrief, cleanTeam, emptyTeam, isNoProject, levelOf, loadTeam, managerBrief, roleOf, saveTeam } from "../server/team.mjs";
import { chainFor } from "../web/team.js";

const team = {
  boss: { threadId: "boss" },
  managers: { p1: { threadId: "mgr1", project: "dzdistro" } },
  autonomy: { p1: "cautious" },
  bossFrom: "mgr1",
};

test("roster file round-trips and drops junk", async () => {
  const dir = await mkdtemp(join(tmpdir(), "t3map-"));
  const file = join(dir, "team.json");
  await saveTeam(cleanTeam({ ...team, autonomy: { p1: "cautious", p2: "reckless" }, extra: 1 }), file);
  const back = await loadTeam(file);
  assert.deepEqual(back, { boss: { threadId: "boss" }, managers: { p1: { threadId: "mgr1", project: "dzdistro" } }, autonomy: { p1: "cautious" } });
  assert.deepEqual(await loadTeam(join(dir, "missing.json")), emptyTeam());
  assert.match(await readFile(file, "utf8"), /"mgr1"/);
});

test("roles and autonomy are looked up from the roster", () => {
  assert.deepEqual(roleOf(team, "boss"), { role: "boss" });
  assert.deepEqual(roleOf(team, "mgr1"), { role: "manager", projectId: "p1" });
  assert.equal(roleOf(team, "worker"), null);
  assert.equal(levelOf(team, "p1"), "cautious");
  assert.equal(levelOf(team, "p9"), "normal");
});

test("the Boss brief routes through Managers and never merges", () => {
  const brief = bossBrief({ managers: [{ project: "dzdistro", threadId: "mgr1" }], rosterFile: "/x/team.json" });
  assert.match(brief, /t3_thread_send/);
  assert.match(brief, /Decision needed:/);
  assert.match(brief, /dzdistro: thread mgr1/);
  assert.match(brief, /\/x\/team\.json/);
  assert.match(brief, /Merging and releasing stay with me/);
});

test("a Manager brief escalates to the Boss when there is one, otherwise to you", () => {
  const withBoss = managerBrief({ project: "dzdistro", bossThreadId: "boss", level: "bold" });
  assert.match(withBoss, /delegate_task/);
  assert.ok(withBoss.includes("Boss thread (boss)"));
  assert.ok(withBoss.includes("on your own (bold)"));
  assert.doesNotMatch(withBoss, /ask me with your question tool/);
  const alone = managerBrief({ project: "dzdistro", level: "normal" });
  assert.match(alone, /ask me with your question tool/);
  assert.match(autonomyNote("cautious"), /now cautious/);
});

test("Needs-you chains show where a question came from", () => {
  const threads = new Map([
    ["boss", { id: "boss", providerName: "Claude" }],
    ["mgr1", { id: "mgr1", providerName: "Codex", projectId: "p1" }],
    ["w1", { id: "w1", providerName: "Grok", parentId: "mgr1", projectId: "p1" }],
    ["solo", { id: "solo", providerName: "Pi", projectId: "p2" }],
  ]);
  const ctx = { team, threads, projTitle: (id) => ({ p1: "dzdistro" })[id] ?? id };
  assert.deepEqual(chainFor(threads.get("boss"), ctx), ["dzdistro Manager", "Boss", "You"]);
  assert.deepEqual(chainFor(threads.get("mgr1"), ctx), ["dzdistro Manager", "You"]);
  assert.deepEqual(chainFor(threads.get("w1"), ctx), ["Grok worker", "dzdistro Manager", "You"]);
  assert.equal(chainFor(threads.get("solo"), ctx), null);
});

test("the Boss lives in T3's No project, found by title or by its scratch root", () => {
  const bs = String.fromCharCode(92);
  assert.equal(isNoProject({ title: "No project" }), true);
  assert.equal(isNoProject({ title: "Renamed", root: ["C:", "Users", "you", ".t3", "scratch"].join(bs) }), true);
  assert.equal(isNoProject({ title: "x", root: "/home/you/.t3/scratch/" }), true);
  assert.equal(isNoProject({ title: "dzdistro", root: "E:/Projects/AI/dzdistro" }), false);
  assert.equal(isNoProject(null), false);
});

test("recognises a Manager brief from the map or the Boss", async () => {
  const { managerBrief, managerBriefProject } = await import("../server/team.mjs");
  assert.equal(managerBriefProject(managerBrief({ project: "T3 Map" })), "T3 Map");
  assert.equal(managerBriefProject("Hi! I'd like this thread to lead the dzdistro project for me in T3 Code. Thanks"), "dzdistro");
  assert.equal(managerBriefProject("Welcome aboard. I'll call it the CGMS Manager from now on."), "CGMS");
  assert.equal(managerBriefProject("Fix the login bug in dzdistro"), null);
  assert.equal(managerBriefProject(undefined), null);
});
