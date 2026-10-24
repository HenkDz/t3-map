import { test } from 'node:test';
import assert from 'node:assert/strict';
import { slimProjection, cleanUserText, stepOf } from '../server/thread.mjs';
import { markdown, glyph, glyphBody } from '../web/ui.js';

const item = (position, type, fields = {}) => ({ position, item: { type, runId: 'r1', startedAt: '2026-10-23T10:00:00Z', ...fields } });
test('conversation keeps answers, folds earlier notes, and uses each steered message time', () => {
  const view = slimProjection({ runs: [{ id: 'r1', status: 'running' }], visibleTurnItems: [item(0, 'user_message', { text: 'First' }), item(1, 'assistant_message', { text: 'Checking' }), item(2, 'command_execution', { input: 'npm test', exitCode: 1 }), item(3, 'assistant_message', { text: 'Result' }), item(4, 'user_message', { text: 'Follow-up', startedAt: '2026-10-23T10:05:00Z' })] });
  assert.equal(view.turns.length, 2);
  assert.equal(view.turns[0].answer.text, 'Result');
  assert.equal(view.turns[0].stepCount, 2);
  assert.equal(view.turns[0].failedSteps, 1);
  assert.equal(view.turns[0].running, false);
  assert.equal(view.turns[1].running, true);
  assert.equal(view.turns[1].startedAt, '2026-10-23T10:05:00Z');
});
test('only current pending requests show, preserving custom answers and approval warnings', () => {
  const p = { runtimeRequests: [{ id: 'new', status: 'pending' }], visibleTurnItems: [item(0, 'approval_request', { requestId: 'old', prompt: 'Old' }), item(1, 'approval_request', { requestId: 'new', prompt: 'New', options: [{ decision: 'acceptAlways', label: 'Always allow', warning: 'All future runs' }] })] };
  const view = slimProjection(p);
  assert.equal(view.pending.prompt, 'New');
  assert.equal(view.pending.options[0].warning, 'All future runs');
  assert.equal(view.partial, true);
});
test('work limits retain the real total and show a count of omitted steps', () => {
  const view = slimProjection({ visibleTurnItems: Array.from({ length: 100 }, (_, i) => item(i, 'dynamic_tool', { title: 'Read file' })) });
  assert.equal(view.turns[0].steps.length, 80);
  assert.equal(view.turns[0].stepCount, 100);
  assert.equal(view.turns[0].steps.at(-1).text, '21 more steps');
  assert.equal(cleanUserText('See ![pic](t3-context://v1/image/123)'), 'See ![pic](t3-context://v1/image/123)');
  assert.equal(stepOf({ type: 'file_change', fileName: 'C:\\app\\main.js', additions: 2 }).text, 'main.js +2 −0');
});
test('projection preserves image references and bindings and exposes the latest Tasks checklist', () => {
  const attachment = { type: 'image', id: 'stored-image', name: 'shot.png', mimeType: 'image/png', sizeBytes: 500 };
  const context = { version: 1, records: [{ version: 1, kind: 'image', contextId: 'ctx-shot', attachmentId: 'stored-image', name: 'shot.png', mimeType: 'image/png', sizeBytes: 500, label: 'shot.png' }] };
  const view = slimProjection({ visibleTurnItems: [item(0, 'user_message', { text: 'Fix ![shot](t3-context://v1/image/ctx-shot) here', attachments: [attachment], context }), item(1, 'todo_list', { planId: 'tasks', steps: [{ id: 'one', text: 'Inspect', status: 'running' }] }), item(2, 'todo_list', { planId: 'tasks', steps: [{ id: 'one', text: 'Inspect', status: 'completed' }, { id: 'two', text: 'Build', status: 'running' }] })] });
  assert.equal(view.turns[0].user.attachments[0].id, 'stored-image');
  assert.equal(view.turns[0].user.context.records[0].attachmentId, 'stored-image');
  assert.match(view.turns[0].user.text, /ctx-shot/);
  assert.equal(view.tasks.steps.length, 2);
  assert.equal(view.tasks.steps[1].status, 'running');
});
test('question projection preserves optional and multi-select rules', () => {
  const view = slimProjection({ runtimeRequests: [{ id: 'q', status: 'pending' }], visibleTurnItems: [item(0, 'user_input_request', { requestId: 'q', questions: [{ id: 'optional', question: 'Any additions?', required: false, multiSelect: true, allowCustomAnswer: false, options: [{ label: 'Extra', value: 'extra' }] }] })] });
  assert.equal(view.pending.questions[0].required, false);
  assert.equal(view.pending.questions[0].multiSelect, true);
  assert.equal(view.pending.questions[0].allowCustom, false);
  assert.equal(view.pending.questions[0].options[0].value, 'extra');
});
test('image-bearing user messages survive a bounded tool window, and Tasks use the latest artifact', () => {
  const view = slimProjection({ messages: [{ id: 'user1', role: 'user', text: 'Look at this image', createdAt: '2026-10-23T09:59:00Z', attachments: [{ type: 'image', id: 'photo', name: 'photo.png', mimeType: 'image/png', sizeBytes: 10 }] }], plans: [{ id: 'current', kind: 'todo_list', status: 'active', steps: [{ id: 'latest', text: 'Current task', status: 'running' }] }], visibleTurnItems: [item(10, 'dynamic_tool', { title: 'Read file' }), item(11, 'todo_list', { planId: 'old', steps: [{ id: 'old', text: 'Old task', status: 'completed' }] })] });
  assert.equal(view.turns[0].user.text, 'Look at this image');
  assert.equal(view.turns[0].user.attachments[0].id, 'photo');
  assert.equal(view.tasks.steps[0].text, 'Current task');
  assert.equal(view.partial, true);
});
test('chat Markdown escapes HTML, unsafe links and code while rendering common answer content', () => {
  const html = markdown('### Result\n\n**Ready** <img src=x onerror=alert(1)>\n\n[bad](javascript:alert) [ok](https://example.com/?x=%22)\n\n```html\n<script>bad()</script>\n```\n\n- One\n- Two\n\n| A | B |\n| --- | --- |\n| 1 | 2 |');
  assert.match(html, /<h3>Result<\/h3>/);
  assert.match(html, /<strong>Ready<\/strong>/);
  assert.ok(!html.includes('<img') && !html.includes('<script>') && !html.includes('href="javascript:'));
  assert.match(html, /rel="noopener noreferrer"/);
  assert.match(html, /<table>/);
  assert.match(html, /<ul>/);
});
test('provider logos are brands in both rail and map; only terminal or watch activities use a terminal mark', () => {
  for (const provider of ['codex', 'ChatGPT', 'openai', 'claudeAgent', 'grok', 'opencode', 'pi', 'cursor', 'acpRegistry_deepseek_harness']) {
    assert.match(glyph(provider), /data-brand=/);
    assert.match(glyphBody(provider), /data-brand=/);
    assert.doesNotMatch(glyph(provider), /data-activity="terminal"/);
  }
  assert.match(glyph('terminal'), /data-activity="terminal"/);
  assert.match(glyph('watch'), /data-activity="terminal"/);
  assert.doesNotMatch(glyph('custom-agent'), /data-activity="terminal"/);
  assert.ok(!glyph('<script>').includes('<script>'));
});
