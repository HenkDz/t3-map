// Small shared helpers: escaping, time, colour, glyphs.
import { PROVIDER_LOGOS } from './provider-logos.js';

export const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

export function ago(iso, now = Date.now()) {
  const t = typeof iso === "number" ? iso : Date.parse(iso ?? "");
  if (!t) return "";
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 45) return "now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}

export function clock(iso) {
  const d = new Date(iso);
  return Number.isNaN(+d) ? "" : d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

export function truncate(s, n) {
  s = String(s ?? "");
  return s.length > n ? s.slice(0, n - 1).trimEnd() + "…" : s;
}

export function hue(str) {
  let h = 0;
  for (const ch of String(str)) h = (h * 31 + ch.codePointAt(0)) >>> 0;
  return h % 360;
}

export const projectColor = (p) => `hsl(${hue(p?.title ?? p?.id ?? "")} 62% 62%)`;

export function monogram(title) {
  const words = String(title ?? "?")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .split(" ")
    .filter(Boolean);
  if (!words.length) return "?";
  if (words.length === 1) return words[0].slice(0, 2).replace(/^./, (c) => c.toUpperCase());
  return (words[0][0] + words[1][0]).toUpperCase();
}

/** Slide a tab list's underline to its selected tab. The first placement doesn't animate. */
export function moveInk(list) {
  const ink = list?.querySelector(".tab-ink");
  const sel = list?.querySelector('[aria-selected="true"]');
  if (!ink || !sel || !sel.offsetWidth) return;
  ink.style.width = sel.offsetWidth + "px";
  ink.style.transform = `translateX(${sel.offsetLeft}px)`;
  if (!ink.dataset.ready) requestAnimationFrame(() => (ink.dataset.ready = "1"));
}

/** Replay a one-shot entrance animation class. */
export function replay(el, cls = "swap") {
  if (!el) return;
  el.classList.remove(cls);
  void el.offsetWidth;
  el.classList.add(cls);
}

export function glyph(provider, size = 16) {
  return `<svg class="glyph" viewBox="0 0 16 16" width="${size}" height="${size}" aria-hidden="true">${glyphBody(provider)}</svg>`;
}

export function glyphBody(provider) {
  const key = provider?.startsWith('acpRegistry_') ? 'acpRegistry' : ({ openai: 'codex', chatgpt: 'codex', claude: 'claudeAgent', claudeteam: 'claudeAgent' }[String(provider).toLowerCase()] ?? provider);
  if (PROVIDER_LOGOS[key]) return PROVIDER_LOGOS[key];
  if (key === 'terminal' || key === 'watch') return '<g fill="none" stroke="currentColor" stroke-width="1.5" data-activity="terminal"><rect x="1.5" y="2.5" width="13" height="11" rx="2"/><path d="m4 6 2 2-2 2m4 0h4"/></g>';
  return `<text x="8" y="8.5" dominant-baseline="middle" text-anchor="middle" fill="currentColor" font-family="var(--font)" font-size="9" font-weight="650">${esc(monogram(provider || 'Agent'))}</text>`;
}

export const STATE_LABEL = {
  needs: "Needs you",
  failed: "Failed",
  working: "Working",
  waiting: "Waiting on team",
  reported: "Result to read",
  idle: "Idle",
};

export const reducedMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

// shortcut: common chat Markdown only; use a full parser when richer documents are needed.
export function markdown(text) {
  const inline = (s) => String(s).split(/(`[^`\n]+`|\[[^\]\n]+\]\([^\s)]+\)|\*\*[^*\n]+\*\*)/g).map((part) => {
    if (part.startsWith('`') && part.endsWith('`')) return `<code>${esc(part.slice(1, -1))}</code>`;
    if (part.startsWith('**') && part.endsWith('**')) return `<strong>${esc(part.slice(2, -2))}</strong>`;
    const link = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(part);
    if (link && /^https?:\/\//i.test(link[2])) return `<a href="${esc(link[2])}" target="_blank" rel="noopener noreferrer">${esc(link[1])}</a>`;
    return esc(part);
  }).join('');
  const lines = String(text ?? '').replace(/\r/g, '').split('\n');
  const out = [];
  for (let i = 0; i < lines.length;) {
    const line = lines[i++];
    if (!line.trim()) continue;
    if (/^\s*```/.test(line)) {
      const code = [];
      while (i < lines.length && !/^\s*```/.test(lines[i])) code.push(lines[i++]);
      i++;
      out.push(`<pre><code>${esc(code.join('\n'))}</code></pre>`);
    } else if (/^#{1,6}\s/.test(line)) {
      out.push(`<h3>${inline(line.replace(/^#+\s/, ''))}</h3>`);
    } else if (/^\s*([-*+] |\d+\. )/.test(line)) {
      const ordered = /^\s*\d+\./.test(line), tag = ordered ? 'ol' : 'ul';
      const match = ordered ? /^\s*\d+\. / : /^\s*[-*+] /;
      const rows = [line];
      while (i < lines.length && match.test(lines[i])) rows.push(lines[i++]);
      out.push(`<${tag}>${rows.map((l) => `<li>${inline(l.replace(match, ''))}</li>`).join('')}</${tag}>`);
    } else if (line.includes('|') && /^\s*\|?\s*:?-{3,}/.test(lines[i] ?? '')) {
      const cells = (l) => l.trim().replace(/^\||\|$/g, '').split('|').map((c) => inline(c.trim()));
      const head = cells(line), rows = [];
      i++;
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) rows.push(cells(lines[i++]));
      out.push(`<div class="md-table"><table><thead><tr>${head.map((c) => `<th>${c}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`);
    } else {
      const rows = [line];
      while (i < lines.length && lines[i].trim() && !/^\s*(#{1,6} |```|[-*+] |\d+\. )/.test(lines[i])) rows.push(lines[i++]);
      out.push(`<p>${rows.map(inline).join('<br>')}</p>`);
    }
  }
  return out.join('');
}
