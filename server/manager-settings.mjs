import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';

export const SETTINGS_FILE = join(homedir(), '.t3-map', 'settings.json');
export const DEFAULT_MANAGER = { provider: 'codex', model: 'gpt-6.1-sol' };
const valid = (p) => typeof p?.provider === 'string' && p.provider.length > 0 && typeof p?.model === 'string' && p.model.length > 0;
export async function loadManagerDefault(file = SETTINGS_FILE) {
  try {
    const s = JSON.parse(await readFile(file, 'utf8'));
    return valid(s?.managerDefault) ? { provider: s.managerDefault.provider, model: s.managerDefault.model } : { ...DEFAULT_MANAGER };
  } catch (e) {
    if (e.code === 'ENOENT' || e instanceof SyntaxError) return { ...DEFAULT_MANAGER };
    throw e;
  }
}
export async function saveManagerDefault(pair, file = SETTINGS_FILE) {
  let settings = {};
  try {
    const saved = JSON.parse(await readFile(file, 'utf8'));
    if (saved && typeof saved === 'object' && !Array.isArray(saved)) settings = saved;
  } catch (e) {
    if (e.code !== 'ENOENT' && !(e instanceof SyntaxError)) throw e;
  }
  await mkdir(dirname(file), { recursive: true });
  const temp = `${file}.${randomUUID()}.tmp`;
  await writeFile(temp, JSON.stringify({ ...settings, managerDefault: pair }, null, 2) + '\n', { mode: 0o600 });
  await rename(temp, file);
}

export function managerCommand(projection, pair) {
  const { thread, runs = [], runtimeRequests = [], providerThreads = [], subagents = [] } = projection;
  const rolledBack = new Set(runs.filter((r) => r.status === 'rolled_back').map((r) => r.id));
  const backgroundItems = [...(projection.turnItems ?? []), ...(projection.visibleTurnItems ?? []).map((v) => v.item)];
  const backgroundActive = backgroundItems.some((item) => item && ['command_execution', 'dynamic_tool', 'subagent'].includes(item.type) && ['pending', 'running', 'waiting'].includes(item.status) && !rolledBack.has(item.runId) && !(item.type === 'dynamic_tool' && item.input?.persistent === true));
  if (backgroundActive) throw Object.assign(new Error('Finish background work before changing the Manager agent.'), { status: 409 });
  // Provider switches can detach sessions: never detach one that still has work or requests.
  if (thread.archivedAt || thread.deletedAt || runs.some((r) => ['queued', 'preparing', 'starting', 'running', 'waiting'].includes(r.status)) || runtimeRequests.some((r) => r.status === 'pending') || providerThreads.some((p) => p.pendingBackgroundTasks?.length) || subagents.some((a) => ['pending', 'running', 'waiting'].includes(a.status))) {
    throw Object.assign(new Error('Finish pending work and requests before changing the Manager agent.'), { status: 409 });
  }
  const same = thread.providerInstanceId === pair.provider;
  return {
    type: same ? 'thread.model-selection.set' : 'provider.switch', threadId: thread.id,
    modelSelection: { instanceId: pair.provider, model: pair.model, ...(same && thread.modelSelection?.options !== undefined ? { options: thread.modelSelection.options } : {}) },
  };
}

export async function configureManager(shell, threadId, pair) {
  // shortcut: external activity can race this read, use an atomic precondition when T3 supports one.
  const projection = await shell.call('orchestration.getThreadProjection', { threadId });
  await shell.dispatch(managerCommand(projection, pair));
}
