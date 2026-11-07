import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_MANAGER, loadManagerDefault, saveManagerDefault, managerCommand, configureManager } from '../server/manager-settings.mjs';
import { rosterHTML, managerSettingsHTML } from '../web/team.js';
import { enabledProviderInstances } from '../server/t3.mjs';

const pair = { provider: 'codex', model: 'next-model' };
const projection = () => ({ thread: { id: 'manager', providerInstanceId: 'codex', modelSelection: { instanceId: 'codex', model: 'old', options: [{ id: 'effort', value: 'high' }] } }, runs: [], runtimeRequests: [] });

test('enabled instances follow stock, driver, nested, and project settings', () => {
  assert.deepEqual(Object.keys(enabledProviderInstances({})), ['codex', 'claudeAgent']);
  const settings = { providerInstances: {
    codex: { driver: 'codex', config: { enabled: false } },
    custom: { driver: 'claudeAgent', enabled: true, config: { enabled: false } },
    grok: { driver: 'grok' },
    chosen: { driver: 'grok', config: { enabled: true } },
    acp: { driver: 'acpRegistry' },
  }, projectSettingsOverrides: { p: { providerInstances: { codex: { enabled: true }, chosen: { enabled: false } } } } };
  assert.deepEqual(Object.keys(enabledProviderInstances(settings)), ['claudeAgent', 'chosen', 'acp']);
  assert.deepEqual(Object.keys(enabledProviderInstances(settings, 'p')), ['codex', 'claudeAgent', 'acp']);
});

test('active timeline work blocks changes except rolled-back and persistent tool items', () => {
  for (const type of ['command_execution', 'dynamic_tool', 'subagent']) {
    for (const status of ['pending', 'running', 'waiting']) {
      const item = { type, status, runId: 'old', input: {} };
      assert.throws(() => managerCommand({ ...projection(), turnItems: [item] }, pair), { status: 409 });
      assert.throws(() => managerCommand({ ...projection(), visibleTurnItems: [{ item }] }, pair), { status: 409 });
      assert.equal(managerCommand({ ...projection(), runs: [{ id: 'old', status: 'rolled_back' }], turnItems: [item] }, pair).threadId, 'manager');
    }
  }
  assert.equal(managerCommand({ ...projection(), turnItems: [{ type: 'dynamic_tool', status: 'running', input: { persistent: true } }] }, pair).threadId, 'manager');
});

test('Manager default round-trips separately and missing or malformed settings use the original default', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'manager-settings-'));
  const file = join(dir, 'settings.json');
  assert.deepEqual(await loadManagerDefault(file), DEFAULT_MANAGER);
  await saveManagerDefault(pair, file);
  assert.deepEqual(await loadManagerDefault(file), pair);
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), { managerDefault: pair });
  await writeFile(file, '{');
  assert.deepEqual(await loadManagerDefault(file), DEFAULT_MANAGER);
  await writeFile(file, '{"managerDefault":{"provider":"codex"}}');
  assert.deepEqual(await loadManagerDefault(file), DEFAULT_MANAGER);
  await writeFile(file, 'null');
  assert.deepEqual(await loadManagerDefault(file), DEFAULT_MANAGER);
  await writeFile(file, JSON.stringify({ otherSetting: { keep: true } }));
  await saveManagerDefault(pair, file);
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), { otherSetting: { keep: true }, managerDefault: pair });
});

test('native command keeps thread and same-instance options; a provider change does not copy foreign options', () => {
  const p = projection();
  assert.deepEqual(managerCommand(p, pair), { type: 'thread.model-selection.set', threadId: 'manager', modelSelection: { instanceId: 'codex', model: 'next-model', options: p.thread.modelSelection.options } });
  assert.deepEqual(managerCommand(p, { provider: 'claudeAgent', model: 'opus' }), { type: 'provider.switch', threadId: 'manager', modelSelection: { instanceId: 'claudeAgent', model: 'opus' } });
  assert.equal(p.thread.modelSelection.model, 'old');
});

test('all active run states and pending requests reject settings without dispatch', async () => {
  for (const status of ['queued', 'preparing', 'starting', 'running', 'waiting']) {
    const p = projection(); p.runs.push({ status });
    assert.throws(() => managerCommand(p, pair), { status: 409 });
  }
  const p = projection(); p.runtimeRequests.push({ status: 'pending' });
  let dispatches = 0;
  await assert.rejects(configureManager({ call: async () => p, dispatch: async () => dispatches++ }, 'manager', pair), { status: 409 });
  assert.equal(dispatches, 0);
  for (const extra of [{ providerThreads: [{ pendingBackgroundTasks: [{ taskId: 'task' }] }] }, { subagents: [{ status: 'running' }] }]) {
    assert.throws(() => managerCommand({ ...projection(), ...extra }, pair), { status: 409 });
  }
});

test('configure only reads and dispatches settings, and propagates failure without changing source', async () => {
  const p = projection(), before = structuredClone(p), calls = [];
  await assert.rejects(configureManager({ call: async (...args) => { calls.push(args); return p; }, dispatch: async (command) => { calls.push(command); throw new Error('Provider unavailable'); } }, 'manager', pair), /Provider unavailable/);
  assert.deepEqual(calls[0], ['orchestration.getThreadProjection', { threadId: 'manager' }]);
  assert.equal(calls[1].type, 'thread.model-selection.set');
  assert.deepEqual(p, before);
});

test('Manager row shows provider and model, with escaped settings and current selection', () => {
  const p = { id: 'p', title: '<Project>' };
  const t = { id: 'manager', provider: 'codex', providerName: 'Codex', model: 'next-model', state: 'idle' };
  const html = rosterHTML({ team: { managers: { p: { threadId: t.id } } }, threads: new Map([[t.id, t]]), projects: new Map([['p', p]]), active: [p], quiet: [] });
  assert.match(html, /Manager · Codex · next-model/);
  assert.match(html, /data-team="manager-agent"/);
  assert.match(html, /data-team="manager-default"/);
  const dialog = managerSettingsHTML({ kind: 'manager-agent', current: pair, agents: [{ ...pair, label: '<agent>' }], projectTitle: p.title });
  assert.match(dialog, /value="0" selected/);
  assert.match(dialog, /Keeps this thread and its conversation history/);
  assert.match(dialog, /&lt;agent&gt;/);
  assert.doesNotMatch(dialog, /<Project>/);
});
