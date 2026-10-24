export const $ = (s, r = document) => r.querySelector(s);
export const $$ = (s, r = document) => [...r.querySelectorAll(s)];

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ESC[c]);
export const nl2br = (s) => esc(s).replace(/\n/g, '<br>');
export const uid = (p = '') => p + Math.random().toString(36).slice(2, 9) + Date.now().toString(36).slice(-3);
export const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
// 1000 stays "1000"; bigger numbers get a thin space: "12 000".
const num = (n) => (Math.abs(n) < 10000 ? String(Math.abs(n)) : Math.abs(n).toLocaleString('ru-RU'));
export const fmt = (n) => (n < 0 ? '−' : '') + num(n);
export const signed = (n) => (n > 0 ? '+' : n < 0 ? '−' : '') + num(n);

export function plural(n, one, few, many) {
  const a = Math.abs(n) % 100, b = a % 10;
  if (b === 1 && a !== 11) return one;
  if (b >= 2 && b <= 4 && (a < 12 || a > 14)) return few;
  return many;
}

// How loud question audio and video play on this device (⚙ → «Громкость вопросов»), 0–1.
export const mediaVolume = () => { const v = store.get('plyukh-ui', {}).vol; return typeof v === 'number' ? v : 0.7; };

export const store = {
  get(k, d = null) {
    try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; }
  },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
  del(k) { try { localStorage.removeItem(k); } catch {} },
};

export function debounce(fn, ms) {
  let t;
  const d = (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
  d.flush = (...a) => { clearTimeout(t); return fn(...a); };
  return d;
}

export function toast(msg, kind = '') {
  let box = document.getElementById('toasts');
  if (!box) { box = document.createElement('div'); box.id = 'toasts'; document.body.append(box); }
  const t = document.createElement('div');
  t.className = 'toast ' + kind;
  t.textContent = msg;
  box.append(t);
  setTimeout(() => t.classList.add('out'), 2600);
  setTimeout(() => t.remove(), 3000);
}

export const dialogOpen = () => !!document.querySelector('.dlg-wrap');

// A bar pinned to the top of the page that stays until the page is reloaded.
export function banner(text, button) {
  let b = document.getElementById('banner');
  if (!b) { b = document.createElement('div'); b.id = 'banner'; document.body.prepend(b); }
  b.innerHTML = `<span>${esc(text)}</span>${button ? `<button type="button" class="btn small primary">${esc(button.label)}</button>` : ''}`;
  if (button) b.querySelector('button').onclick = button.onClick;
}

export const siteUpdatedBanner = () =>
  banner('Сайт обновился — обнови страницу, чтобы всё работало. Игра сохранится.', { label: 'Обновить', onClick: () => location.reload() });

// Generic modal. Each button: { label, value, cls }. value may be a function(wrap) -> value (undefined keeps the dialog open).
export function dialog({ title = '', html = '', buttons = [{ label: 'OK', value: true, cls: 'primary' }], onMount, cls = '' } = {}) {
  return new Promise((resolve) => {
    const wrap = document.createElement('div');
    wrap.className = 'dlg-wrap';
    wrap.innerHTML = `<div class="dlg ${cls}" role="dialog" aria-modal="true">
      ${title ? `<h3 class="dlg-title">${esc(title)}</h3>` : ''}
      <div class="dlg-body">${html}</div>
      ${buttons.length ? `<div class="dlg-actions">${buttons.map((b, i) => `<button type="button" class="btn ${b.cls || ''}" data-i="${i}">${esc(b.label)}</button>`).join('')}</div>` : ''}
    </div>`;
    const close = (v) => { wrap.remove(); document.removeEventListener('keydown', onKey, true); resolve(v); };
    const finish = (i) => {
      const b = buttons[i];
      const v = typeof b.value === 'function' ? b.value(wrap) : b.value;
      if (v !== undefined) close(v);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); e.preventDefault(); close(null); }
      else if (e.key === 'Enter' && e.target.tagName !== 'TEXTAREA') {
        const p = buttons.findIndex((b) => (b.cls || '').includes('primary'));
        if (p >= 0) { e.preventDefault(); e.stopPropagation(); finish(p); }
      }
    };
    wrap.addEventListener('mousedown', (e) => { wrap._down = e.target; });
    wrap.addEventListener('click', (e) => {
      if (e.target === wrap && wrap._down === wrap) return close(null);
      const btn = e.target.closest('[data-i]');
      if (btn) finish(+btn.dataset.i);
    });
    document.addEventListener('keydown', onKey, true);
    document.body.append(wrap);
    wrap.close = close;
    onMount?.(wrap, close);
    const f = wrap.querySelector('input:not([type=checkbox]),textarea,select');
    if (f) { f.focus(); f.select?.(); }
  });
}

export const confirmDlg = (text, ok = 'Да', danger = false) =>
  dialog({ html: `<p>${esc(text)}</p>`, buttons: [{ label: 'Отмена', value: false }, { label: ok, value: true, cls: danger ? 'danger primary' : 'primary' }] }).then((v) => !!v);

export const promptDlg = (title, value = '', { type = 'text', placeholder = '', ok = 'OK' } = {}) =>
  dialog({
    title,
    html: `<input class="input" type="${type}" value="${esc(value)}" placeholder="${esc(placeholder)}" ${type === 'number' ? 'inputmode="numeric"' : ''}>`,
    buttons: [{ label: 'Отмена', value: null }, { label: ok, cls: 'primary', value: (w) => w.querySelector('input').value }],
  });

export function download(name, blob) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.append(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
}

export function pickFile(accept = '') {
  return new Promise((resolve) => {
    const i = document.createElement('input');
    i.type = 'file';
    i.accept = accept;
    i.onchange = () => resolve(i.files[0] || null);
    i.click();
  });
}

export async function copyText(t) {
  try { await navigator.clipboard.writeText(t); toast('Ссылка скопирована'); }
  catch { promptDlg('Скопируй ссылку', t); }
}

export function qrSvg(text) {
  const q = window.qrcode(0, 'M');
  q.addData(text);
  q.make();
  return q.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
}

export const safeFileName = (s) => (s || 'igra').replace(/[\\/:*?"<>|]+/g, '').trim().slice(0, 60) || 'igra';

export const LOGO_SVG = `<svg class="logo-mark" viewBox="0 0 32 24" aria-hidden="true"><path d="M3 15c0-6 5-11 13-11s13 4 13 9-5 9-12 9c-3 0-5-1-7-2l-5 2 1-4c-2-1-3-2-3-3z" fill="currentColor"/></svg>`;
