import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { request } from 'node:http';

async function start(t) {
  const child = spawn(process.execPath, ['server/index.mjs'], {
    cwd: new URL('..', import.meta.url), windowsHide: true,
    env: { ...process.env, T3_MAP_DEMO: '1', T3_MAP_DESKTOP: '1', T3_MAP_PORT: '0' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  t.after(() => child.kill());
  let errors = '';
  child.stderr.on('data', (chunk) => errors += chunk);
  const lines = createInterface({ input: child.stdout });
  const [line] = await Promise.race([
    once(lines, 'line'),
    once(child, 'exit').then(() => { throw new Error(`Bridge exited before readiness: ${errors}`); }),
    new Promise((_, reject) => setTimeout(() => reject(new Error('Bridge readiness timed out')), 5000).unref()),
  ]);
  const ready = JSON.parse(line);
  assert.equal(ready.type, 't3-map-ready');
  assert.ok(Number.isInteger(ready.port) && ready.port > 0);
  return { child, port: ready.port, origin: `http://127.0.0.1:${ready.port}` };
}

const addressed = (origin, host) => new Promise((resolve, reject) => {
  request(origin + '/api/health', { headers: { host } }, (res) => { res.resume(); resolve(res.statusCode); }).on('error', reject).end();
});

test('desktop binds an independent ephemeral bridge and enforces its actual port/origin', { timeout: 10_000 }, async (t) => {
  const first = await start(t), second = await start(t);
  assert.notEqual(first.port, second.port);
  for (const app of [first, second]) {
    const health = await fetch(app.origin + '/api/health');
    assert.equal(health.status, 200);
    assert.equal((await health.json()).ok, true);
    assert.match(await (await fetch(app.origin + '/')).text(), /<title>T3 Map<\/title>/);
    assert.equal(await addressed(app.origin, `localhost:${app.port}`), 200);
    assert.equal(await addressed(app.origin, '127.0.0.1:0'), 421);
    assert.equal(await addressed(app.origin, 'evil.example'), 421);
    for (const [origin, expected] of [[app.origin, 404], [`http://localhost:${app.port}`, 404], [first === app ? second.origin : first.origin, 403], [`https://127.0.0.1:${app.port}`, 403], ['null', 403], [`${app.origin}/path`, 403]]) {
      const res = await fetch(app.origin + '/api/unknown', { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: '{}' });
      assert.equal(res.status, expected, origin);
    }
  }
  const stream = await fetch(first.origin + '/api/stream');
  const reader = stream.body.getReader();
  assert.match(new TextDecoder().decode((await reader.read()).value), /event: state/);
  const exit = once(first.child, 'exit');
  first.child.stdin.end();
  const [code] = await Promise.race([exit, new Promise((_, reject) => setTimeout(() => reject(new Error('Owned bridge did not stop after stdin EOF')), 3000).unref())]);
  assert.equal(code, 0);
  await reader.cancel();
  await assert.rejects(fetch(first.origin + '/api/health'));
  assert.equal((await fetch(second.origin + '/api/health')).status, 200, 'exiting one desktop must preserve its peer');
});

test('normal bridge keeps its human startup output with an ephemeral override', { timeout: 5000 }, async (t) => {
  const child = spawn(process.execPath, ['server/index.mjs'], {
    cwd: new URL('..', import.meta.url), windowsHide: true,
    env: { ...process.env, T3_MAP_DEMO: '1', T3_MAP_PORT: '0', T3_MAP_DESKTOP: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => child.kill());
  const [chunk] = await once(child.stdout, 'data');
  assert.match(String(chunk), /T3 Map \(demo data\).*http:\/\/127\.0\.0\.1:[1-9]\d+/);
});
