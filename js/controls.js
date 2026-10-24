// Host controls are described as data so the TV screen and the host's phone remote
// render the same buttons and send the same actions.
//   row:  { title?, inline?, items: [item] }
//   item: { label, act, args?, cls?, key?, disabled? }
//         { type: 'wager', label, act, args?, min, max, value? }
//         { type: 'note', text }
//         { type: 'range', label, act, args?, min, max, step, value, unit? } — sends { value } when let go
import { esc } from './util.js?v=1792859542530';

function itemHTML(it) {
  const args = esc(JSON.stringify(it.args || {}));
  if (it.type === 'note') return `<div class="ctl-note">${esc(it.text)}</div>`;
  if (it.type === 'range') {
    return `<label class="ctl-range"><span>${esc(it.label)} · <b>${rangeText(it.value, it.unit)}</b></span>
      <input type="range" min="${it.min}" max="${it.max}" step="${it.step}" value="${it.value}" data-act="${esc(it.act)}" data-args="${args}" data-unit="${esc(it.unit || '')}"></label>`;
  }
  if (it.type === 'wager') {
    return `<form class="ctl-wager" data-act="${esc(it.act)}" data-args="${args}">
      <input class="input" type="number" inputmode="numeric" min="${it.min}" max="${it.max}" step="1" value="${it.value ?? ''}" placeholder="${it.min}–${it.max}" required>
      <button class="btn ${it.cls || 'primary'}">${esc(it.label)}</button></form>`;
  }
  return `<button type="button" class="btn ${it.cls || ''}" data-act="${esc(it.act)}" data-args="${args}" ${it.disabled ? 'disabled' : ''}>${esc(it.label)}${it.key ? ` <kbd>${esc(it.key)}</kbd>` : ''}</button>`;
}

const rangeText = (v, unit = '') => `${String(v).replace('.', ',')}${esc(unit)}`;

export const controlsHTML = (rows = []) =>
  rows.map((r) => `<div class="ctl-row ${r.inline ? 'inline' : ''}">${r.title ? `<div class="ctl-title">${esc(r.title)}</div>` : ''}<div class="ctl-items">${r.items.map(itemHTML).join('')}</div></div>`).join('');

export function bindControls(el, onAct) {
  el.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-act]');
    if (!b || b.disabled || !el.contains(b)) return;
    e.preventDefault();
    onAct(b.dataset.act, JSON.parse(b.dataset.args || '{}'));
  });
  // Sliders show their value while dragged and act once let go.
  el.addEventListener('input', (e) => {
    const r = e.target.closest('.ctl-range input');
    if (r) r.closest('.ctl-range').querySelector('b').textContent = rangeText(r.value, r.dataset.unit);
  });
  el.addEventListener('change', (e) => {
    const r = e.target.closest('.ctl-range input');
    if (!r || !el.contains(r)) return;
    onAct(r.dataset.act, { ...JSON.parse(r.dataset.args || '{}'), value: +r.value });
  });
  el.addEventListener('submit', (e) => {
    const f = e.target.closest('form.ctl-wager');
    if (!f) return;
    e.preventDefault();
    const args = JSON.parse(f.dataset.args || '{}');
    args.amount = Math.round(+f.querySelector('input').value || 0);
    onAct(f.dataset.act, args);
  });
}

// Sets innerHTML only when it actually changed, so focused inputs and playing media survive re-renders.
export function setHTML(el, html) {
  if (el && el._html !== html) { el._html = html; el.innerHTML = html; }
}
