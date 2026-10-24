import { randomUUID } from 'node:crypto';

export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_MESSAGE_IMAGE_BYTES = 80 * 1024 * 1024;
export const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
const error = (message, status = 400) => Object.assign(new Error(message), { status });
const label = (name) => name.replace(/[[\]\\\r\n]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200);

export function imageMime(bytes) {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
  if (['GIF87a', 'GIF89a'].includes(bytes.subarray(0, 6).toString())) return 'image/gif';
  if (bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP') return 'image/webp';
  return null;
}

// The browser sends only ids minted here, never arbitrary T3 attachment ids or file paths.
export class ImageStore {
  constructor(shell, demo = false) { this.shell = shell; this.demo = demo; this.images = new Map(); }

  async upload(name, mimeType, bytes) {
    if (!bytes.length || bytes.length > MAX_IMAGE_BYTES) throw error('Each image must be between 1 byte and 10 MiB.', 413);
    if (!IMAGE_TYPES.includes(mimeType) || imageMime(bytes) !== mimeType) throw error('Choose a PNG, JPEG, GIF or WebP image with matching file content.');
    name = String(name ?? '').split(/[\\/]/).at(-1).replace(/[\x00-\x1f\x7f]/g, '').trim();
    if (!name || name.length > 255) throw error('The image needs a filename of at most 255 characters.');
    for (const [id, image] of this.images) if (Date.now() - image.at > 24 * 3600_000) this.images.delete(id);
    const total = [...this.images.values()].reduce((n, i) => n + i.sizeBytes, 0);
    if (this.images.size >= 1000 || (this.demo && total + bytes.length > MAX_MESSAGE_IMAGE_BYTES)) throw error('The image queue is full. Remove unused images first.', 413);
    const id = randomUUID();
    let attachmentId = `pending-${id}`;
    if (!this.demo) {
      const upload = await this.shell.call('attachments.createUploadUrl', { type: 'image', name, mimeType, sizeBytes: bytes.length });
      attachmentId = upload.attachmentId;
      try {
        const res = await fetch(new URL(upload.relativeUrl, this.shell.info.origin), { method: 'POST', headers: { 'content-type': mimeType }, body: bytes, signal: AbortSignal.timeout(30_000) });
        if (!res.ok) throw new Error(`T3 could not store that image (${res.status}).`);
      } catch (e) { await this.shell.call('attachments.delete', { attachmentId }).catch(() => {}); throw e; }
    }
    const image = { id, contextId: `image_${id}`, attachmentId, name, mimeType, sizeBytes: bytes.length, at: Date.now(), ...(this.demo ? { bytes } : {}) };
    this.images.set(id, image);
    return { id, contextId: image.contextId, name, mimeType, sizeBytes: bytes.length };
  }

  message(text, imageIds = []) {
    if (!Array.isArray(imageIds) || imageIds.length > 100 || new Set(imageIds).size !== imageIds.length) throw error('Choose up to 100 different images.');
    const images = imageIds.map((id) => {
      const image = this.images.get(id);
      if (!image || Date.now() - image.at > 24 * 3600_000) throw error('An image is no longer available. Remove it and attach it again.', 409);
      return image;
    });
    if (images.reduce((n, i) => n + i.sizeBytes, 0) > MAX_MESSAGE_IMAGE_BYTES) throw error('Images can total up to 80 MiB per message.', 413);
    const refs = [...text.matchAll(/!?\[[^\]\n]*\]\(t3-context:\/\/v1\/image\/([a-z0-9_-]+)\)/gi)];
    if (refs.some((r) => !images.some((i) => i.contextId === r[1]))) throw error('An inline image reference has no attached image. Remove it or attach the image again.');
    for (const image of images) if (!refs.some((r) => r[1] === image.contextId)) text += `${text.trim() ? '\n' : ''}![${label(image.name)}](t3-context://v1/image/${image.contextId})`;
    return {
      text,
      attachments: images.map((i) => ({ type: 'image', id: i.attachmentId, name: i.name, mimeType: i.mimeType, sizeBytes: i.sizeBytes })),
      ...(images.length ? { context: { version: 1, records: images.map((i) => ({ version: 1, kind: 'image', contextId: i.contextId, label: label(i.name), attachmentId: i.attachmentId, name: i.name, mimeType: i.mimeType, sizeBytes: i.sizeBytes })) } } : {}),
    };
  }

  async remove(id) {
    const image = this.images.get(id);
    if (!image) return;
    if (!this.demo) await this.shell.call('attachments.delete', { attachmentId: image.attachmentId });
    this.images.delete(id);
  }

  async preview(attachment) {
    if (this.demo) {
      const image = [...this.images.values()].find((i) => i.attachmentId === attachment.id);
      if (!image) throw error('Image is no longer available.', 404);
      return image.bytes;
    }
    const asset = await this.shell.call('assets.createUrl', { resource: { _tag: 'attachment', attachmentId: attachment.id, mimeType: attachment.mimeType, fileName: attachment.name, disposition: 'inline' } });
    const res = await fetch(new URL(asset.relativeUrl, this.shell.info.origin), { signal: AbortSignal.timeout(20_000) });
    if (!res.ok) throw error('T3 could not load that image.', 502);
    const bytes = Buffer.from(await res.arrayBuffer());
    if (bytes.length > MAX_IMAGE_BYTES || imageMime(bytes) !== attachment.mimeType) throw error('The attachment is not a supported image.', 415);
    return bytes;
  }
}
