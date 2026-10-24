// Your team on top of T3: one Boss thread for everything, one Manager thread per project.
// Roles are plain T3 threads with a short written brief. T3 does the actual work:
// delegate_task for workers, t3_thread_send between threads, and its own question
// prompts for anything that needs you. The roster lives in ~/.t3-map/team.json.

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export const TEAM_FILE = join(homedir(), ".t3-map", "team.json");
export const LEVELS = ["cautious", "normal", "bold"];

export function emptyTeam() {
  return { boss: null, managers: {}, autonomy: {} };
}

export function cleanTeam(t) {
  const out = emptyTeam();
  if (t?.boss?.threadId) out.boss = { threadId: String(t.boss.threadId) };
  for (const [pid, m] of Object.entries(t?.managers ?? {})) if (m?.threadId) out.managers[pid] = { threadId: String(m.threadId), project: m.project ?? null };
  for (const [pid, l] of Object.entries(t?.autonomy ?? {})) if (LEVELS.includes(l)) out.autonomy[pid] = l;
  return out;
}

export async function loadTeam(file = TEAM_FILE) {
  try {
    return cleanTeam(JSON.parse(await readFile(file, "utf8")));
  } catch {
    return emptyTeam();
  }
}

export async function saveTeam(team, file = TEAM_FILE) {
  await mkdir(join(file, ".."), { recursive: true });
  await writeFile(file, JSON.stringify(team, null, 2));
}

export const levelOf = (team, projectId) => team.autonomy[projectId] ?? "normal";

/** T3's built-in "No project" home: where the Boss lives, since it works across every project. */
export function isNoProject(p) {
  return Boolean(p) && (p.title === "No project" || /[\\/]\.t3[\\/]scratch[\\/]?$/i.test(p.root ?? ""));
}

/** Every role thread id, so the map can always show them even when settled. */
export function roleOf(team, threadId) {
  if (team.boss?.threadId === threadId) return { role: "boss" };
  for (const [pid, m] of Object.entries(team.managers)) if (m.threadId === threadId) return { role: "manager", projectId: pid };
  return null;
}

// Briefs are written as a plain request from the user, not a "You are..." persona prompt:
// that framing, plus talk of other threads and tools, reads like prompt injection to
// model safety filters, and a flagged thread can't answer anything afterwards.
export const DECISION_TAG = "Decision needed (user):";

const POLICY = "Read ~/.t3-map/policy.md before acting. It is authoritative for decision rights and overrides this brief and autonomy levels.";
const MESSAGES = `Use the policy's message format: "Decision: … at HH:MM UTC unless you object." (carry on; proceed after 15 minutes without objection), or "${DECISION_TAG}" (hard stop; wait for an explicit yes). "Done:" is two lines only for user review or serious problems. No acknowledgements, progress updates, or relays.`;

export function bossBrief({ rosterFile = TEAM_FILE, managers = [] } = {}) {
  const roster = managers.length
    ? managers.map((m) => `- ${m.project}: thread ${m.threadId}`).join("\n")
    : "- None yet. I'll add them as we go; until then, just help me directly when I ask.";
  return `Hi! I'd like this thread to be my lead for all my software projects in T3 Code. I'll call it "the Boss".

${POLICY}
Here's the setup:
- Each project can have its own lead thread (a Manager). The list of them is in ${rosterFile}. If a project has no Manager yet, start a thread in that project titled "<project name> Manager" and open its brief with: "Hi! I'd like this thread to lead the <project name> project for me in T3 Code." The map recognises that and registers it as the Manager, so there's only ever one.
- When I give you a goal for a project, pass it to that project's Manager with the t3_thread_send tool: the goal, any constraints, and what done looks like.
- Managers send "Decision: … at HH:MM UTC unless you object." and proceed after 15 minutes without objection. "${DECISION_TAG}" is a hard stop awaiting explicit user approval. "Done:" is only for user review or serious problems. No acknowledgements, progress updates, or relays.
- Reply to Decision: only to object, using "Objection: …" or "Approved: …" plus anything new. Authorize outcomes, not procedures; do not restate standing rules.
- Bring me only policy level-3 items, work ready for review, and serious problems. Ask hard-stop questions with your question tool, two or three options, your recommendation first.
- Merging and releasing stay with me, so leave those for my review.
- When you update me, start with the outcome in a sentence or two.

Managers right now:
${roster}

No acknowledgement needed.`;
}

/** Which project a Manager brief is for, or null. Matches the opener every Manager brief
 *  starts with, whether the map or the Boss sent it. */
export function managerBriefProject(text) {
  const m = /lead the (.+?) project for me in T3 Code|I'll call it the (.+?) Manager\b/i.exec(String(text ?? ""));
  return m ? (m[1] ?? m[2]).trim() : null;
}

export function managerBrief({ project, bossThreadId = null, level = "normal" }) {
  const escalate = bossThreadId
    ? `- Send policy messages to the Boss thread (${bossThreadId}) with t3_thread_send. The Boss asks the user for hard stops.`
    : `- With no Boss, ask me with your question tool for user-only hard stops; never bypass the policy.`;
  return `Hi! I'd like this thread to lead the ${project} project for me in T3 Code. I'll call it the ${project} Manager.

${POLICY}
Here's how I'd like it to work:
- Split work into focused tasks and hand them to helper agents with the delegate_task tool. Answer their questions yourself where you can.
- Autonomy on your own (${level}) remains subordinate to the policy.
${escalate}
- ${MESSAGES}
- Check the helpers' results before calling something done. Merging and releasing stay with me: get the pull request ready and tell me it's ready to review.
- Progress stays in this thread. Merging, releasing, and deploying require explicit user approval.

No acknowledgement needed.`;
}

export function autonomyNote(level) {
  return `Update from the user: autonomy for this project is now ${level}. ${POLICY} Decide only within its decision rights. No reply needed.`;
}

export function bossRosterNote(managers) {
  return `Roster update from the user (also in ${TEAM_FILE}):\n${managers.map((m) => `- ${m.project}: Manager thread ${m.threadId}`).join("\n") || "- No Managers."}\nNo reply needed.`;
}
