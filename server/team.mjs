// Your team on top of T3: one Boss thread for everything, one Manager thread per project.
// Roles are plain T3 threads with a short written brief. T3 does the actual work:
// delegate_task for workers, t3_thread_send between threads, and its own question
// prompts for anything that needs you. The roster lives in ~/.t3-map/team.json.

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export const TEAM_FILE = join(homedir(), ".t3-map", "team.json");
export const LEVELS = ["cautious", "normal", "bold"];

const AUTONOMY = {
  cautious: "decide only small, easily reversible things yourself. Escalate anything that changes scope, design, dependencies, data, or user-facing behavior.",
  normal: "decide routine engineering choices yourself. Escalate anything that changes scope, costs money, touches production or customers, or changes the user experience.",
  bold: "decide everything within the project's goals yourself. Escalate only irreversible, production-affecting, or spending decisions.",
};

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
export const DECISION_TAG = "Decision needed:";

export function bossBrief({ rosterFile = TEAM_FILE, managers = [] } = {}) {
  const roster = managers.length
    ? managers.map((m) => `- ${m.project}: thread ${m.threadId}`).join("\n")
    : "- None yet. I'll add them as we go; until then, just help me directly when I ask.";
  return `Hi! I'd like this thread to be my lead for all my software projects in T3 Code. I'll call it "the Boss".

Here's the setup:
- Each project can have its own lead thread (a Manager). The list of them is in ${rosterFile}. If a project has no Manager yet, start a thread in that project titled "<project name> Manager" and open its brief with: "Hi! I'd like this thread to lead the <project name> project for me in T3 Code." The map recognises that and registers it as the Manager, so there's only ever one.
- When I give you a goal for a project, pass it to that project's Manager with the t3_thread_send tool: the goal, any constraints, and what done looks like.
- Managers may message you with "${DECISION_TAG}" when they're unsure. Please make the call yourself when you reasonably can and reply to them the same way.
- Bring me only the big calls: costly or hard-to-undo choices, or a change in product direction. Ask with your question tool, two or three options, your recommendation first.
- Merging and releasing stay with me, so leave those for my review.
- When you update me, start with the outcome in a sentence or two.

Managers right now:
${roster}

Just reply with a quick "ready" for now.`;
}

/** Which project a Manager brief is for, or null. Matches the opener every Manager brief
 *  starts with, whether the map or the Boss sent it. */
export function managerBriefProject(text) {
  const m = /lead the (.+?) project for me in T3 Code|I'll call it the (.+?) Manager\b/i.exec(String(text ?? ""));
  return m ? (m[1] ?? m[2]).trim() : null;
}

export function managerBrief({ project, bossThreadId = null, level = "normal" }) {
  const escalate = bossThreadId
    ? `- For bigger calls, message the Boss thread (${bossThreadId}) with t3_thread_send, starting with "${DECISION_TAG}": what needs deciding, the options, and what you'd pick. The Boss will check with me if needed.`
    : `- For bigger calls, ask me with your question tool: what needs deciding, two or three options, and what you'd pick.`;
  return `Hi! I'd like this thread to lead the ${project} project for me in T3 Code. I'll call it the ${project} Manager.

Here's how I'd like it to work:
- Split work into focused tasks and hand them to helper agents with the delegate_task tool. Answer their questions yourself where you can.
- How much to decide on your own (${level}): ${AUTONOMY[level]}
${escalate}
- Check the helpers' results before calling something done. Merging and releasing stay with me: get the pull request ready and tell me it's ready to review.
- When a goal is done, reply with a short summary of the outcome.

Just reply with a quick "ready" for now.`;
}

export function autonomyNote(level) {
  return `Update from the user: autonomy for this project is now ${level}. From now on, ${AUTONOMY[level]} No reply needed.`;
}

export function bossRosterNote(managers) {
  return `Roster update from the user (also in ${TEAM_FILE}):\n${managers.map((m) => `- ${m.project}: Manager thread ${m.threadId}`).join("\n") || "- No Managers."}\nNo reply needed.`;
}
