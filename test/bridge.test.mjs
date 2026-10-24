import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { request } from 'node:http';
import { T3Shell } from '../server/t3.mjs';

const port = 14874;
const origin = `http://127.0.0.1:${port}`;
let child;
before(async () => {
  // Fail even when live adapters swallow an error and fall back to empty data.
  const isolationGuard = `
    import fs from 'node:fs/promises';
    import cp from 'node:child_process';
    import { Socket } from 'node:net';
    import { syncBuiltinESMExports } from 'node:module';
    import { resolve, relative, isAbsolute } from 'node:path';
    import { fileURLToPath } from 'node:url';
    const deny = () => { process.stderr.write('Demo attempted live filesystem, CLI or network access'); process.exit(90); };
    for (const name of ['readFile', 'writeFile', 'mkdir']) {
      const original = fs[name];
      fs[name] = (path, ...args) => {
        const local = relative(process.cwd(), resolve(path instanceof URL ? fileURLToPath(path) : String(path)));
        if (local.startsWith('..') || isAbsolute(local)) deny();
        return original(path, ...args);
      };
    }
    cp.execFile = cp.spawn = Socket.prototype.connect = globalThis.fetch = globalThis.WebSocket = deny;
    syncBuiltinESMExports();
    await import('./server/index.mjs');
  `;
  child = spawn(process.execPath, ['--input-type=module', '--eval', isolationGuard], { cwd: new URL('..', import.meta.url), env: { ...process.env, T3_MAP_DEMO: '1', T3_MAP_PORT: String(port) }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let errors = '';
  child.stderr.on('data', (s) => errors += s);
  await Promise.race([once(child.stdout, 'data'), once(child, 'exit').then(() => { throw new Error(errors); }), new Promise((_, reject) => setTimeout(() => reject(new Error('Bridge startup timed out')), 5000).unref())]);
  await new Promise((resolve) => setTimeout(resolve, 100));
});
after(() => child?.kill());
const post = async (path, body, headers = {}) => {
  const res = await fetch(origin + path, { method: 'POST', headers: { 'content-type': 'application/json', origin, ...headers }, body: JSON.stringify(body) });
  return { status: res.status, value: await res.json() };
};
const view = async (id) => (await fetch(`${origin}/api/thread/${id}`)).json();

test('isolated demo exposes only fictional projects, repositories, roster and sample questions', async () => {
  const controller = new AbortController();
  const stream = await fetch(`${origin}/api/stream`, { signal: controller.signal });
  let frame = '';
  try {
    for await (const chunk of stream.body) {
      frame += new TextDecoder().decode(chunk);
      if (frame.includes('\n\n')) break;
    }
  } finally { controller.abort(); }
  const state = JSON.parse(frame.split('\n').find((line) => line.startsWith('data: ')).slice(6));
  assert.equal(state.demo, true);
  assert.equal(state.team.file, null);
  assert.deepEqual(state.projects.map((p) => p.title), ['Moonbeam Studio', 'Clover Market', 'Sunflower Academy', 'Paper Kite Post', 'Campfire Club', 'Pebble Browser', 'Puddle Bot', 'Acorn Notes', 'No project']);
  assert.ok(state.projects.filter((p) => p.repo).every((p) => p.repo.startsWith('storybook-demo/')));
  assert.equal(state.team.managers['p-mono'].project, 'Moonbeam Studio');
  assert.equal(state.team.managers['p-dz'].project, 'Clover Market');
  const conversations = await Promise.all(state.threads.map((t) => view(t.id)));
  assert.match(conversations.find((p) => p.threadId === 'd-boss').pending.questions[0].question, /Clover Market Manager/);
  assert.doesNotMatch(JSON.stringify({ state, conversations }), /monocode|dzdistro|elitepathways|achraf[-_]freight|wa_groups|wa_righclick|wa-lead-folders|browser-link-3-tauri|HenkDz|kky42|t3bot|T3 Bot Demo/i);
});

test('HTTP boundary rejects hostile origins, malformed JSON, arrays, null and unknown actions', async () => {
  assert.equal((await post('/api/act', { threadId: 'd-lead', action: 'stop' }, { origin: 'https://evil.example' })).status, 403);
  assert.equal((await post('/api/act', null)).status, 400);
  assert.equal((await post('/api/act', [])).status, 400);
  assert.equal((await fetch(`${origin}/api/act`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{' })).status, 400);
  assert.equal((await post('/api/act', { threadId: 'd-lead', action: 'delete' })).status, 400);
  assert.equal((await post('/api/act', { threadId: 'missing', action: 'stop' })).status, 404);
  const hostileHostStatus = await new Promise((resolve, reject) => request(origin, { headers: { host: 'evil.example' } }, (res) => { res.resume(); resolve(res.statusCode); }).on('error', reject).end());
  assert.equal(hostileHostStatus, 421);
});
test('demo uses the live validation for questions, approvals and stale requests', async () => {
  assert.equal((await post('/api/act', { threadId: 'd-notes', action: 'answer', requestId: 'rq1', answers: {} })).status, 400);
  assert.equal((await post('/api/act', { threadId: 'd-notes', action: 'answer', requestId: 'rq1', answers: { unknown: 'yes' } })).status, 400);
  assert.equal((await post('/api/act', { threadId: 'd-notes', action: 'answer', requestId: 'old', answers: { q1: 'draft' } })).status, 409);
  assert.equal((await post('/api/act', { threadId: 'd-notes', action: 'answer', requestId: 'rq1', answers: { q1: 'draft' } })).status, 200);
  assert.equal((await view('d-notes')).pending, null);
  assert.equal((await post('/api/act', { threadId: 'd-deploy', action: 'decide', requestId: 'rq2', decision: 'acceptAlways' })).status, 400);
  assert.equal((await post('/api/act', { threadId: 'd-deploy', action: 'decide', requestId: 'rq2', decision: 'decline', feedback: 'Keep it staged' })).status, 200);
  assert.equal((await post('/api/act', { threadId: 'd-deploy', action: 'decide', requestId: 'rq2', decision: 'accept' })).status, 409);
});
test('reply, stop, plan, mark read, settle, and changes return concrete results', async () => {
  assert.equal((await post('/api/act', { threadId: 'd-rtl', action: 'read' })).status, 200);
  assert.equal((await post('/api/act', { threadId: 'd-rtl', action: 'settle' })).status, 200);
  assert.equal((await post('/api/act', { threadId: 'd-lead', action: 'settle' })).status, 409);
  assert.equal((await post('/api/act', { threadId: 'd-lead', action: 'send', text: '  ' })).status, 400);
  assert.equal((await post('/api/act', { threadId: 'd-lead', action: 'send', text: 'Keep this reply' })).status, 200);
  assert.equal((await view('d-lead')).turns.at(-1).user.text, 'Keep this reply');
  assert.equal((await post('/api/act', { threadId: 'd-lead', action: 'stop' })).status, 200);
  assert.equal((await view('d-lead')).turns.at(-1).running, false);
  assert.equal((await post('/api/act', { threadId: 'd-plan', action: 'plan', planId: 'stale' })).status, 409);
  assert.equal((await post('/api/act', { threadId: 'd-plan', action: 'plan', planId: 'plan-1' })).status, 200);
  assert.equal((await view('d-plan')).actionablePlan, false);
  assert.match((await (await fetch(`${origin}/api/changes/d-lead`)).json()).diff, /Review complete/);
});
test('new work validates projects and agent pairs and preserves prompt and worktree choice', async () => {
  assert.equal((await post('/api/start', { projectId: 'unknown', text: 'Hello' })).status, 400);
  assert.equal((await post('/api/start', { projectId: 'p-mono', text: 'Hello', provider: 'nope', model: 'x' })).status, 400);
  assert.equal((await post('/api/start', { projectId: 'p-mono', text: 'Hello', worktree: '--option' })).status, 400);
  const out = await post('/api/start', { projectId: 'p-mono', text: 'Hello\nKeep all words', provider: 'codex', model: 'gpt-6.1-sol', worktree: 'HEAD', branch: 'demo/hello' });
  assert.equal(out.status, 200);
  assert.equal((await view(out.value.threadId)).turns.at(-1).user.text, 'Hello\nKeep all words');
});

test('project Manager setup reuses its pinned role and coalesces repeated clicks', async () => {
  assert.equal((await post('/api/team', { action: 'manager', mode: 'ensure', projectId: 'unknown' })).status, 400);
  assert.equal((await post('/api/team', { action: 'manager', mode: 'ensure', projectId: 'p-none' })).status, 400);
  const existing = await post('/api/team', { action: 'manager', mode: 'ensure', projectId: 'p-mono' });
  assert.equal(existing.value.threadId, 'd-lead');
  const setup = () => post('/api/team', { action: 'manager', mode: 'ensure', projectId: 'p-wg' });
  const [first, second] = await Promise.all([setup(), setup()]);
  assert.equal(first.status, 200);
  assert.equal(second.value.threadId, first.value.threadId);
  const manager = await view(first.value.threadId);
  assert.match(manager.turns.at(-1).user.text, /lead the Campfire Club project/);
  assert.match(manager.turns.at(-1).user.text, /Boss thread/);
  assert.equal((await setup()).value.threadId, first.value.threadId);
  assert.equal((await view(first.value.threadId)).turns.length, manager.turns.length);
});
test('image upload, inline context, reply, new work and protected preview complete through HTTP', async () => {
  const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
  const upload = async () => {
    const res = await fetch(origin + '/api/images', { method: 'POST', headers: { origin, 'content-type': 'image/png', 'x-image-name': 'image.png' }, body: bytes });
    assert.equal(res.status, 200); return res.json();
  };
  assert.equal((await fetch(origin + '/api/images', { method: 'POST', headers: { origin: 'https://evil.example', 'content-type': 'image/png' }, body: bytes })).status, 403);
  assert.equal((await fetch(origin + '/api/images', { method: 'POST', headers: { origin, 'content-type': 'image/png' }, body: Buffer.from('not an image') })).status, 400);
  const first = await upload(), second = await upload();
  const text = `Fix ![image.png](t3-context://v1/image/${second.contextId}) here, then ![image.png](t3-context://v1/image/${first.contextId}) there.`;
  assert.equal((await post('/api/act', { threadId: 'd-notes', action: 'send', text, imageIds: [first.id, second.id] })).status, 200);
  const user = (await view('d-notes')).turns.at(-1).user;
  assert.equal(user.text, text);
  assert.equal(user.attachments.length, 2);
  assert.equal(user.context.records[1].attachmentId, user.attachments[1].id);
  const preview = await fetch(`${origin}/api/image/d-notes/${user.attachments[0].id}`);
  assert.equal(preview.status, 200);
  assert.deepEqual(Buffer.from(await preview.arrayBuffer()), bytes);
  assert.equal((await fetch(`${origin}/api/image/d-deploy/${user.attachments[0].id}`)).status, 404);
  const created = await post('/api/start', { projectId: 'p-mono', text: '', imageIds: [first.id] });
  assert.equal(created.status, 200);
  assert.equal((await view(created.value.threadId)).turns.at(-1).user.attachments.length, 1);
  assert.equal((await post('/api/act', { threadId: 'd-notes', action: 'send', text: 'No', imageIds: ['unknown'] })).status, 409);
});
test('RPC client dispatches structured commands and propagates T3 failures and timeouts', async () => {
  const shell = new T3Shell(), sent = [];
  shell.ws = { readyState: 1, send: (text) => sent.push(JSON.parse(text)) };
  const pending = shell.dispatch({ type: 'thread.visit', threadId: 't1', visitedAt: 'now' });
  assert.equal(sent[0].tag, 'orchestration.dispatchCommand');
  assert.ok(sent[0].payload.commandId);
  shell.onMessage(shell.ws, JSON.stringify({ _tag: 'Exit', requestId: sent[0].id, exit: { _tag: 'Success', value: { sequence: 2 } } }));
  assert.deepEqual(await pending, { sequence: 2 });
  const failed = shell.call('read', {});
  shell.onMessage(shell.ws, JSON.stringify({ _tag: 'Exit', requestId: sent[1].id, exit: { _tag: 'Failure', cause: { error: { message: 'Permission denied' } } } }));
  await assert.rejects(failed, /Permission denied/);
  await assert.rejects(shell.call('slow', {}, { timeout: 5 }), /too long/);
  assert.equal(shell.calls.size, 0);
});
