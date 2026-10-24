import { STATE_LABEL, esc, glyph, clock, markdown, moveInk, replay } from './ui.js';
import { createComposer, imageTextHTML, showImage } from './composer.js';

const duration = (from, to) => {
  const seconds = Math.max(0, Math.round(((to ? Date.parse(to) : Date.now()) - Date.parse(from)) / 1000));
  if (!Number.isFinite(seconds)) return '';
  return seconds < 60 ? `${seconds}s` : seconds < 3600 ? `${Math.floor(seconds / 60)}m ${seconds % 60}s` : `${Math.floor(seconds / 3600)}h ${Math.floor(seconds / 60) % 60}m`;
};
const decisionLabel = { accept: 'Approve', acceptForSession: 'Approve for session', acceptAlways: 'Always approve', decline: 'Deny', cancel: 'Cancel' };

export function createThreadPanel({ thread, project, post, toast, onOpen, onClose }) {
  const $ = (s) => document.querySelector(s);
  let id = null, view = null, controller = null, timer = null, busy = false, tab = 'conversation', trigger = null;
  let contentSig = '', requestSig = '';
  const drafts = new Map();
  const composer = createComposer({ form: $('#reply-form'), editor: $('#reply'), button: $('#reply-attach'), input: $('#reply-image-input'), tray: $('#reply-images'), toast });
  const attachmentUrl = (imageId) => `/api/image/${encodeURIComponent(id)}/${encodeURIComponent(imageId)}`;

  function header() {
    const t = thread(id);
    $('#thread-title').textContent = t?.title ?? 'Conversation';
    $('#thread-title').title = t?.title ?? '';
    $('#thread-meta').innerHTML = t ? `${glyph(t.provider, 14)}<span>${esc(project(t.projectId))}</span><span>·</span><span>${esc(t.providerName)} · ${esc(t.model)}</span><span class="chip ${esc(t.state)}">${esc(STATE_LABEL[t.state])}</span>${t.role ? `<span class="chip role">${t.role === 'boss' ? 'Boss' : 'Manager'}</span>` : ''}` : '';
    $('#thread-branch').textContent = t?.branch ?? '';
    $('#thread-parent').hidden = !t?.parentId;
    $('#thread-stop').hidden = !t || !['working', 'waiting', 'needs'].includes(t.state);
    $('#thread-settle').hidden = !t || ['working', 'waiting', 'needs'].includes(t.state) || t.settled;
    $('#thread-read').hidden = t?.state !== 'reported';
    $('#reply-hint').textContent = t && ['working', 'waiting'].includes(t.state) ? 'Replies queue after the current run · Enter to send' : 'Enter to send · Shift + Enter for a new line';
    $('#thread-demo').hidden = !document.body.classList.contains('is-demo');
  }

  function paint() {
    const body = $('#thread-conversation');
    const nearBottom = body.scrollHeight - body.scrollTop - body.clientHeight < 100;
    const html = `${view.partial ? '<p class="history-note">Showing the conversation available from T3. Earlier work may be omitted.</p>' : ''}` + view.turns.map((turn, i) => `
      <article class="turn">
        ${turn.user ? `<div class="message-user">${turn.user.attachments?.length ? `<div class="message-images">${turn.user.attachments.map((a) => `<button type="button" data-message-image="${esc(a.id)}" aria-label="Preview ${esc(a.name)}"><img src="${attachmentUrl(a.id)}" alt="${esc(a.name)}" loading="lazy"><span>${esc(a.name)}</span></button>`).join('')}</div>` : ''}<div class="message-label">${turn.user.byAgent ? 'From its lead' : 'You'}<time>${esc(clock(turn.user.at))}</time></div><div class="user-text">${imageTextHTML(turn.user.text, turn.user.attachments, turn.user.context)}</div></div>` : ''}
        <div class="message-agent">
          ${turn.stepCount ? `<details class="work" data-work="${i}"><summary><span class="work-chevron">›</span>${turn.running ? 'Working' : 'Worked'}${turn.startedAt ? ` for ${duration(turn.startedAt, turn.endedAt)}` : ''}<span>${turn.stepCount} steps${turn.failedSteps ? ` · ${turn.failedSteps} failed` : ''}</span></summary><ol>${turn.steps.map((s) => `<li class="${s.failed ? 'step-failed' : ''}"><span class="step-kind">${esc(s.kind)}</span><span>${esc(s.text)}</span></li>`).join('')}</ol></details>` : ''}
          ${turn.answer ? `<div class="message-label">${esc(thread(id)?.providerName ?? 'Agent')}<time>${esc(clock(turn.answer.at))}</time></div><div class="markdown">${markdown(turn.answer.text)}</div>${turn.answer.truncated ? '<p class="history-note">Long answer shortened.</p>' : ''}` : ''}
          ${turn.plan ? `<div class="plan"><div class="message-label">Proposed plan</div><div class="markdown">${markdown(turn.plan.markdown)}</div>${view.actionablePlan && i === view.turns.length - 1 ? `<button class="action-primary" data-thread-action="plan" data-plan="${esc(turn.plan.planId)}">Go ahead with this plan</button>` : ''}</div>` : ''}
          ${turn.running ? '<div class="run-indicator"><i></i>Agent is working</div>' : ''}
        </div>
      </article>`).join('') || '<div class="thread-empty">The conversation will appear here when work starts.</div>';
    if (html !== contentSig) {
      const open = new Set([...body.querySelectorAll('details[open]')].map((n) => n.dataset.work));
      contentSig = html;
      body.innerHTML = html;
      body.querySelectorAll('details').forEach((n) => n.open = open.has(n.dataset.work));
      if (nearBottom) body.scrollTop = body.scrollHeight;
    }
    paintRequest();
    paintTasks();
  }

  function paintTasks() {
    const box = $('#thread-tasks'), tasks = view.tasks;
    box.hidden = !tasks?.steps?.length;
    if (box.hidden) { box.innerHTML = ''; delete box.dataset.sig; return; }
    const done = tasks.steps.filter((s) => s.status === 'completed').length;
    const current = tasks.steps.find((s) => s.status === 'running') ?? tasks.steps.find((s) => s.status !== 'completed');
    if (box.dataset.thread !== id || (view.pending && box.dataset.pending !== 'true')) box.open = !view.pending && done < tasks.steps.length;
    box.dataset.thread = id;
    box.dataset.pending = String(Boolean(view.pending));
    const html = `<summary><span class="tasks-icon" aria-hidden="true">☷</span><b>Tasks</b><span class="tasks-current">${esc(current?.text ?? 'All tasks complete')}</span><span class="tasks-count">${done}/${tasks.steps.length}</span><span class="task-meter" aria-hidden="true">${tasks.steps.map((s) => `<i class="${esc(s.status)}"></i>`).join('')}</span><span class="tasks-chevron">⌄</span></summary><ol>${tasks.steps.map((s) => `<li class="${esc(s.status)}"><i aria-hidden="true">${s.status === 'completed' ? '✓' : ''}</i><span>${esc(s.text)}</span>${s.status === 'running' ? '<small>now</small>' : ''}</li>`).join('')}</ol>`;
    if (box.dataset.sig !== html) { box.dataset.sig = html; box.innerHTML = html; }
  }

  function paintRequest() {
    const r = view.pending;
    const sig = JSON.stringify(r);
    if (sig === requestSig) return;
    requestSig = sig;
    const box = $('#thread-request');
    box.hidden = !r || tab !== 'conversation';
    if (!r) { box.innerHTML = ''; return; }
    if (r.kind === 'question' && r.questions.length) {
      box.innerHTML = `<form id="answer-form"><div class="request-kicker">Your decision</div>${r.questions.map((q, i) => `<fieldset data-question="${i}"><legend>${esc(q.question)}</legend>${q.options.map((o, j) => `<label class="answer-option"><input type="${q.multiSelect ? 'checkbox' : 'radio'}" name="q${i}" value="${j}"><span><b>${esc(o.label)}</b>${o.description ? `<small>${esc(o.description)}</small>` : ''}</span></label>`).join('')}${q.allowCustom || !q.options.length ? `<textarea name="custom${i}" rows="2" aria-label="Your answer${r.questions.length > 1 ? ` ${i + 1}` : ''}" placeholder="${q.options.length ? 'Or write your own answer…' : 'Your answer…'}" maxlength="4000"></textarea>` : ''}</fieldset>`).join('')}<div class="request-actions"><button class="action-primary" type="submit">Send answer</button><button class="action-quiet" type="button" data-thread-action="dismiss">Dismiss question</button></div></form>`;
    } else if (r.kind === 'approval' && r.prompt && r.options.length) {
      box.innerHTML = `<div class="request-kicker">Approval requested${r.appName ? ` · ${esc(r.appName)}` : ''}</div>${r.reason ? `<p>${esc(r.reason)}</p>` : ''}<pre class="approval-prompt">${esc(r.prompt)}</pre><textarea id="approval-feedback" rows="2" maxlength="4000" aria-label="Approval feedback" placeholder="Optional feedback…"></textarea><div class="request-actions">${r.options.map((o) => {
        const option = typeof o === 'string' ? { decision: o } : o;
        return `<div class="approval-option"><button type="button" class="${option.decision.startsWith('accept') ? 'action-primary' : 'action-quiet'}" data-thread-action="decide" data-decision="${esc(option.decision)}">${esc(option.label || decisionLabel[option.decision] || option.decision)}</button>${option.warning ? `<small>${esc(option.warning)}</small>` : ''}</div>`;
      }).join('')}</div>`;
    } else {
      box.innerHTML = `<div class="request-kicker">${r.requestKind === 'auth_refresh' ? 'Sign-in required' : 'Waiting for input'}</div><p>${r.requestKind === 'auth_refresh' ? 'Complete the provider sign-in in its own window, then return here.' : 'T3 has not supplied the request details. Refresh to try again.'}</p><button type="button" class="action-quiet" data-thread-action="refresh">Refresh</button>`;
    }
  }

  async function load() {
    clearTimeout(timer);
    if (!id) return;
    const current = id;
    controller?.abort();
    const ac = controller = new AbortController();
    try {
      const res = await fetch(`/api/thread/${encodeURIComponent(current)}`, { signal: ac.signal });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not load this conversation.');
      if (id !== current || ac.signal.aborted) return;
      view = data;
      header();
      paint();
      $('#thread-error').hidden = true;
    } catch (e) {
      if (e.name === 'AbortError' || id !== current) return;
      $('#thread-error').textContent = e.message;
      $('#thread-error').hidden = false;
    } finally {
      if (id === current && !ac.signal.aborted) timer = setTimeout(load, document.hidden ? 10_000 : 2500);
    }
  }

  async function changes() {
    const current = id;
    $('#thread-changes').textContent = 'Loading changes…';
    try {
      const res = await fetch(`/api/changes/${encodeURIComponent(current)}`);
      const out = await res.json();
      if (!res.ok) throw new Error(out.error || 'Could not load changes.');
      if (id !== current) return;
      $('#thread-changes').innerHTML = out.diff ? `<p class="history-note">Changes through completed turn ${out.toTurnCount}${out.truncated ? ' · large diff shortened' : ''}</p><pre class="diff">${out.diff.split('\n').map((l) => `<span class="${l.startsWith('+') ? 'diff-add' : l.startsWith('-') ? 'diff-remove' : l.startsWith('@@') ? 'diff-hunk' : ''}">${esc(l)}</span>`).join('\n')}</pre>` : '<div class="thread-empty">No checkpoint changes yet.</div>';
    } catch (e) { if (id === current) $('#thread-changes').textContent = e.message; }
  }

  function setTab(next) {
    tab = next;
    $('#thread-conversation').hidden = tab !== 'conversation';
    $('#thread-changes').hidden = tab !== 'changes';
    $('#thread-request').hidden = tab !== 'conversation' || !view?.pending;
    document.querySelectorAll('[data-thread-tab]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.threadTab === tab)));
    moveInk($('.thread-nav [role=tablist]'));
    replay(tab === 'changes' ? $('#thread-changes') : $('#thread-conversation'));
    if (tab === 'changes') changes();
  }

  function close() {
    if (id) drafts.set(id, composer.draft());
    id = null;
    controller?.abort();
    clearTimeout(timer);
    $('#thread-panel').inert = true;
    $('.body').classList.remove('thread-open');
    $('#rail').inert = $('.body').classList.contains('dock-collapsed');
    onClose();
    if (trigger?.isConnected && trigger !== document.body && !trigger.closest('[inert]')) trigger.focus();
    else $('#dock-toggle').focus();
  }

  async function action(action, extra = {}) {
    if (busy || !id) return;
    const current = id;
    busy = true;
    $('#thread-panel').classList.add('is-busy');
    try {
      await post('/api/act', { threadId: current, action, ...extra });
      toast(document.body.classList.contains('is-demo') ? 'Demo action applied' : ({ send: 'Reply sent to T3', read: 'Marked as read', settle: 'Thread settled', stop: 'Stop requested' }[action] ?? 'Sent to T3'));
      if (action === 'send') {
        drafts.delete(current);
        if (id === current) composer.clear();
      }
      if (id === current) await load();
    } catch (e) { toast(e.message); }
    finally { busy = false; $('#thread-panel').classList.remove('is-busy'); }
  }

  $('#thread-panel').addEventListener('click', (e) => {
    const imageButton = e.target.closest('[data-message-image], #thread-conversation [data-image]');
    if (imageButton) {
      const imageId = imageButton.dataset.messageImage ?? imageButton.dataset.image;
      const image = view?.turns.flatMap((t) => t.user?.attachments ?? []).find((a) => a.id === imageId);
      if (image) return showImage(attachmentUrl(imageId), image.name);
    }
    const b = e.target.closest('[data-thread-action]');
    if (b) {
      const a = b.dataset.threadAction;
      if (a === 'close') return close();
      if (a === 'refresh') { load(); if (tab === 'changes') changes(); return; }
      if (a === 'parent') return onOpen(thread(id)?.parentId);
      return action(a, { ...(a === 'plan' ? { planId: b.dataset.plan } : {}), ...(a === 'decide' ? { requestId: view?.pending?.requestId, decision: b.dataset.decision, feedback: $('#approval-feedback')?.value } : {}), ...(a === 'dismiss' ? { requestId: view?.pending?.requestId } : {}) });
    }
    const t = e.target.closest('[data-thread-tab]');
    if (t) setTab(t.dataset.threadTab);
  });

  $('#thread-request').addEventListener('submit', (e) => {
    e.preventDefault();
    if (!view?.pending?.questions) return;
    const form = new FormData(e.target), answers = Object.create(null);
    for (const [i, q] of view.pending.questions.entries()) {
      const custom = String(form.get(`custom${i}`) ?? '').trim();
      const selected = form.getAll(`q${i}`).map((j) => q.options[Number(j)].value);
      if (!custom && !selected.length) { if (q.required === false) continue; return toast('Answer each question first.'); }
      answers[q.id] = custom ? (q.multiSelect ? [...selected, custom] : custom) : q.multiSelect ? selected : selected[0];
    }
    action('answer', { requestId: view.pending.requestId, answers });
  });
  let preparing = false;
  $('#reply-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!composer.hasContent || busy || preparing) return;
    const current = id;
    preparing = true; composer.freeze(true);
    try { const message = await composer.prepare(); if (id === current) await action('send', message); }
    catch (e) { toast(e.message); }
    finally { preparing = false; composer.freeze(false); }
  });
  $('#thread-panel').addEventListener('keydown', (e) => {
    const image = e.target.closest('#thread-conversation .image-chip');
    if (image && ['Enter', ' '].includes(e.key)) { e.preventDefault(); image.click(); return; }
    if (e.key === 'Escape' && !document.querySelector('dialog[open]')) { e.preventDefault(); e.stopPropagation(); close(); }
  });

  return {
    open(next) {
      if (!next) return;
      if (id === next) return;
      if (!id) trigger = document.activeElement;
      else drafts.set(id, composer.draft());
      id = next;
      view = null; contentSig = ''; requestSig = '';
      composer.restore(drafts.get(id));
      $('#thread-conversation').innerHTML = '<div class="thread-empty">Loading conversation…</div>';
      $('#thread-request').hidden = true;
      $('#thread-tasks').hidden = true;
      delete $('#thread-tasks').dataset.sig;
      $('#thread-panel').inert = false;
      $('#rail').inert = true;
      $('.body').classList.add('thread-open');
      setTab('conversation'); header(); load();
      $('#thread-title').focus();
    },
    close,
    get id() { return id; },
  };
}
