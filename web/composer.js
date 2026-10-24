import { esc } from './ui.js';

export const IMAGE_ACCEPT = 'image/png,image/jpeg,image/gif,image/webp';
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const cleanLabel = (s) => String(s).replace(/[[\]\\\r\n]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200);
export const imageReference = (image) => `![${cleanLabel(image.name)}](t3-context://v1/image/${image.contextId})`;
const sizeLabel = (n) => n < 1024 * 1024 ? `${Math.ceil(n / 1024)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`;
const refPattern = /!?\[([^\]\n]*)\]\(t3-context:\/\/v1\/image\/([a-z0-9_-]+)\)/gi;

export function imageTextHTML(text, images = [], context = null) {
  let html = '', from = 0;
  for (const ref of String(text ?? '').matchAll(refPattern)) {
    html += esc(text.slice(from, ref.index));
    const record = context?.records?.find((r) => r.kind === 'image' && r.contextId === ref[2]);
    const image = images.find((i) => i.contextId === ref[2] || i.id === record?.attachmentId);
    html += image ? `<span class="image-chip" contenteditable="false" role="button" tabindex="0" data-image="${esc(image.id)}" data-context="${esc(ref[2])}" aria-label="Preview ${esc(image.name)}"><span aria-hidden="true">▧</span><b>${esc(image.name)}</b><small>${sizeLabel(image.sizeBytes)}</small></span>` : `<span class="image-mention">▧ ${esc(ref[1] || 'image')}</span>`;
    from = ref.index + ref[0].length;
  }
  return html + esc(String(text ?? '').slice(from));
}

export function showImage(url, name) {
  let dialog = document.querySelector('#image-viewer');
  if (!dialog) {
    dialog = document.createElement('dialog');
    dialog.id = 'image-viewer';
    dialog.innerHTML = '<div class="viewer-head"><span></span><button type="button" aria-label="Close image preview">×</button></div><img alt="">';
    document.body.append(dialog);
    dialog.querySelector('button').onclick = () => dialog.close();
    dialog.addEventListener('click', (e) => { if (e.target === dialog) dialog.close(); });
  }
  dialog.querySelector('span').textContent = name;
  dialog.querySelector('img').src = url;
  dialog.querySelector('img').alt = name;
  if (!dialog.open) dialog.showModal();
}

// A shared native editor: actual image chips, plain-text paste, and no HTML clipboard imports.
export function createComposer({ form, editor, button, input, tray, toast }) {
  let images = [], frozen = false, caret = null;
  input.accept = IMAGE_ACCEPT;

  function textOf(node) {
    if (node.nodeType === 3) return node.textContent.replace(/\u200b/g, '');
    if (node.nodeType !== 1 && node.nodeType !== 11) return '';
    if (node.dataset?.context) {
      const image = images.find((i) => i.contextId === node.dataset.context);
      return image ? imageReference(image) : '';
    }
    if (node.nodeName === 'BR') return '\n';
    let text = '';
    for (const child of node.childNodes) {
      if (['DIV', 'P'].includes(child.nodeName) && text && !text.endsWith('\n')) text += '\n';
      text += textOf(child);
    }
    return text;
  }
  const text = () => textOf(editor).replace(/\u00a0/g, ' ');
  function changed() {
    editor.dataset.empty = String(!text().trim());
    form.classList.toggle('has-text', Boolean(text().trim() || images.length));
  }
  function captureCaret() {
    const selection = getSelection();
    if (selection?.rangeCount && editor.contains(selection.anchorNode)) caret = selection.getRangeAt(0).cloneRange();
  }
  function insert(fragment) {
    editor.focus();
    const range = caret && editor.contains(caret.startContainer) ? caret : document.createRange();
    if (range !== caret) { range.selectNodeContents(editor); range.collapse(false); }
    range.deleteContents();
    const last = fragment.lastChild;
    range.insertNode(fragment);
    if (last) range.setStartAfter(last);
    range.collapse(true);
    const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range);
    caret = range.cloneRange(); changed();
  }
  function paintTray() {
    tray.hidden = !images.length;
    tray.innerHTML = images.map((image) => `<div class="draft-image ${image.status}" data-draft-image="${image.id}"><button type="button" data-view="${image.id}" aria-label="Preview ${esc(image.name)}"><img src="${image.url}" alt="${esc(image.name)}"><span>${esc(image.name)}</span></button><button type="button" class="remove-image" data-remove="${image.id}" aria-label="Remove ${esc(image.name)}">×</button><small>${image.status === 'uploading' ? 'Uploading…' : image.status === 'failed' ? esc(image.error) : sizeLabel(image.sizeBytes)}</small>${image.status === 'failed' ? `<button type="button" data-retry="${image.id}">Retry upload</button>` : ''}</div>`).join('');
    changed();
  }
  async function upload(image) {
    image.status = 'uploading'; paintTray();
    try {
      try { const decoded = await createImageBitmap(image.file); decoded.close(); }
      catch { throw new Error('This image cannot be decoded. Remove it and choose another image.'); }
      const res = await fetch('/api/images', { method: 'POST', headers: { 'content-type': image.mimeType, 'x-image-name': encodeURIComponent(image.name) }, body: image.file });
      const out = await res.json();
      if (!res.ok) throw new Error(out.error || 'Image upload failed.');
      image.server = out; image.status = 'ready';
      if (image.removed) release(image);
    } catch (e) { image.status = 'failed'; image.error = e.message; }
    paintTray();
  }
  function release(image) {
    if (image.server) fetch('/api/images/remove', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: image.server.id }) }).catch(() => {});
  }
  function add(files) {
    if (frozen) return;
    captureCaret();
    for (const file of files) {
      if (!IMAGE_ACCEPT.split(',').includes(file.type)) { toast('Choose a PNG, JPEG, GIF or WebP image.'); continue; }
      if (!file.size || file.size > MAX_IMAGE_BYTES) { toast('Each image can be at most 10 MiB.'); continue; }
      if (images.length >= 100 || images.reduce((n, i) => n + i.sizeBytes, file.size) > 80 * 1024 * 1024) { toast('Images can total up to 80 MiB per message, with at most 100 images.'); break; }
      const id = crypto.randomUUID();
      const image = { id, contextId: `image_${id}`, name: file.name || 'image.png', mimeType: file.type, sizeBytes: file.size, file, url: URL.createObjectURL(file), status: 'uploading' };
      images.push(image);
      const fragment = document.createDocumentFragment(), span = document.createElement('span');
      span.innerHTML = imageTextHTML(imageReference(image), [image]);
      fragment.append(...span.childNodes, document.createTextNode(' '));
      insert(fragment);
      image.pending = upload(image);
    }
    paintTray();
  }
  button.addEventListener('mousedown', (e) => { e.preventDefault(); captureCaret(); });
  button.addEventListener('click', () => { if (!frozen) input.click(); });
  input.addEventListener('change', () => { add([...input.files]); input.value = ''; });
  editor.addEventListener('input', () => { captureCaret(); changed(); });
  editor.addEventListener('keyup', captureCaret);
  editor.addEventListener('mouseup', captureCaret);
  editor.addEventListener('paste', (e) => {
    if (frozen) return;
    e.preventDefault(); captureCaret();
    const files = [...(e.clipboardData?.files ?? [])].filter((f) => f.type.startsWith('image/'));
    if (files.length) return add(files);
    const pasted = e.clipboardData?.getData('text/plain') ?? '';
    const fragment = document.createDocumentFragment();
    fragment.append(document.createTextNode(pasted)); insert(fragment);
  });
  editor.addEventListener('keydown', (e) => {
    const chip = e.target.closest('[data-image]');
    if (chip && ['Enter', ' '].includes(e.key)) { e.preventDefault(); const image = images.find((i) => i.id === chip.dataset.image); if (image) showImage(image.url, image.name); return; }
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && !e.target.closest('[data-image]')) { e.preventDefault(); form.requestSubmit(); }
  });
  editor.addEventListener('click', (e) => { const image = images.find((i) => i.id === e.target.closest('[data-image]')?.dataset.image); if (image) showImage(image.url, image.name); });
  form.addEventListener('dragover', (e) => { if (e.dataTransfer?.types.includes('Files')) { e.preventDefault(); form.classList.add('drag-over'); } });
  form.addEventListener('dragleave', (e) => { if (!form.contains(e.relatedTarget)) form.classList.remove('drag-over'); });
  form.addEventListener('drop', (e) => { if (e.dataTransfer?.files.length) { e.preventDefault(); form.classList.remove('drag-over'); caret = null; add([...e.dataTransfer.files]); } });
  tray.addEventListener('click', (e) => {
    const remove = e.target.closest('[data-remove]'), retry = e.target.closest('[data-retry]'), view = e.target.closest('[data-view]');
    const image = images.find((i) => i.id === (remove?.dataset.remove ?? retry?.dataset.retry ?? view?.dataset.view));
    if (!image) return;
    if (view) return showImage(image.url, image.name);
    if (frozen) return;
    if (retry) { image.pending = upload(image); return; }
    image.removed = true; release(image); URL.revokeObjectURL(image.url);
    images = images.filter((i) => i !== image);
    editor.querySelectorAll('[data-image]').forEach((n) => { if (n.dataset.image === image.id) n.remove(); });
    paintTray();
  });
  changed();
  return {
    get text() { return text(); },
    get hasContent() { return Boolean(text().trim() || images.length); },
    draft() { return { text: text(), images: [...images] }; },
    restore(draft) { images = draft?.images ?? []; editor.innerHTML = imageTextHTML(draft?.text ?? '', images); caret = null; paintTray(); },
    clear() { images.forEach((i) => URL.revokeObjectURL(i.url)); images = []; editor.replaceChildren(); caret = null; paintTray(); },
    freeze(value) { frozen = value; editor.contentEditable = String(!value); button.disabled = value; form.classList.toggle('sending', value); },
    async prepare() {
      const selected = [...images];
      let content = text();
      if (content.length > 20_000) throw new Error('Keep the message within 20,000 characters.');
      await Promise.all(selected.map((i) => i.pending));
      if (selected.some((i) => i.status !== 'ready')) throw new Error('An image failed to upload. Retry it before sending.');
      for (const image of selected) content = content.replaceAll(`t3-context://v1/image/${image.contextId}`, `t3-context://v1/image/${image.server.contextId}`);
      return { text: content.trim(), imageIds: selected.map((i) => i.server.id) };
    },
  };
}
