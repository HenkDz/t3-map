import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ImageStore, MAX_IMAGE_BYTES } from '../server/images.mjs';
import { imageTextHTML, imageReference } from '../web/composer.js';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
test('two same-named images retain distinct bindings at different positions in the message', async () => {
  const store = new ImageStore(null, true);
  const first = await store.upload('image.png', 'image/png', png), second = await store.upload('image.png', 'image/png', png);
  const text = `Change ${imageReference(second)} in the header, and ${imageReference(first)} in the footer.`;
  const message = store.message(text, [first.id, second.id]);
  assert.equal(message.text, text);
  assert.notEqual(message.attachments[0].id, message.attachments[1].id);
  assert.equal(message.context.records.find((r) => r.contextId === second.contextId).attachmentId, message.attachments[1].id);
  assert.deepEqual(await store.preview(message.attachments[0]), png);
  const html = imageTextHTML(text, message.attachments, message.context);
  assert.ok(html.indexOf(message.attachments[1].id) < html.indexOf(message.attachments[0].id));
  assert.equal((html.match(/class="image-chip"/g) ?? []).length, 2);
});
test('image-only sends get a reference and unknown, duplicate or unbound image ids fail', async () => {
  const store = new ImageStore(null, true), image = await store.upload('shot.png', 'image/png', png);
  assert.match(store.message('', [image.id]).text, /t3-context:\/\/v1\/image/);
  assert.throws(() => store.message('x', ['arbitrary-T3-id']), /no longer available/);
  assert.throws(() => store.message('x', [image.id, image.id]), /different images/);
  assert.throws(() => store.message(imageReference(image), []), /no attached image/);
  await store.remove(image.id);
  assert.throws(() => store.message('x', [image.id]), /no longer available/);
});
test('image trust boundary rejects SVG, mismatched bytes, empty or oversized uploads and unsafe names', async () => {
  const store = new ImageStore(null, true);
  await assert.rejects(store.upload('bad.svg', 'image/svg+xml', Buffer.from('<svg/>')), /PNG, JPEG/);
  await assert.rejects(store.upload('bad.png', 'image/png', Buffer.from('<html>bad</html>')), /matching file content/);
  await assert.rejects(store.upload('bad.jpg', 'image/jpeg', png), /matching file content/);
  await assert.rejects(store.upload('empty.png', 'image/png', Buffer.alloc(0)), /10 MiB/);
  await assert.rejects(store.upload('large.png', 'image/png', Buffer.alloc(MAX_IMAGE_BYTES + 1)), /10 MiB/);
  await assert.rejects(store.upload('', 'image/png', png), /filename/);
  const image = await store.upload('C:\\fakepath\\shot.png', 'image/png', png);
  assert.equal(image.name, 'shot.png');
  const html = imageTextHTML('Hi <script>bad()</script>', [], null);
  assert.ok(!html.includes('<script>'));
});
