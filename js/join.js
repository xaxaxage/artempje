// Phone page: a player's buzzer, or the host's remote when opened with ?k=<host key>.
import { $, esc, fmt, signed, store, uid, toast, LOGO_SVG } from './util.js';
import { Client } from './net.js';
import { controlsHTML, bindControls, setHTML } from './controls.js';

const app = document.getElementById('app');
const params = new URLSearchParams(location.search);
let code = (params.get('r') || '').replace(/\D/g, '').slice(0, 4);
const hostKey = params.get('k') || '';
const role = hostKey ? 'host' : 'player';

let client = null;
let view = null;
let pid = null;
let name = store.get('plyukh-name', '');
let mounted = false;
let lastOpenId = 0;
let openAt = 0;
let pressedOpen = 0;
let earlyAt = 0;
let lockedUntil = 0;
let deadline = 0;

const logo = `<a class="logo" href="../">${LOGO_SVG}<span>Плюх</span></a>`;

function pidFor(c) {
  const k = 'plyukh-pid-' + c;
  let p = store.get(k);
  if (!p) { p = uid('p'); store.set(k, p); }
  return p;
}

// ---------- entry screens ----------
function codeScreen(err = '') {
  mounted = false;
  app.innerHTML = `<div class="ph-center">
    ${logo}
    <h1>Вход в игру</h1>
    <p class="muted">Введи код комнаты с экрана ведущего</p>
    ${err ? `<p class="err">${esc(err)}</p>` : ''}
    <form class="ph-form">
      <input class="input code-input" inputmode="numeric" pattern="[0-9]*" maxlength="4" autocomplete="off" placeholder="0000" value="${esc(code)}">
      <button class="btn primary big wide">Дальше</button>
    </form>
  </div>`;
  const i = $('.code-input', app);
  i.focus();
  $('form', app).addEventListener('submit', (e) => {
    e.preventDefault();
    const v = i.value.replace(/\D/g, '');
    if (v.length !== 4) return toast('Код — это 4 цифры');
    code = v;
    history.replaceState(null, '', `?r=${code}`);
    nameScreen();
  });
}

function nameScreen() {
  mounted = false;
  app.innerHTML = `<div class="ph-center">
    ${logo}
    <div class="room-code small">${esc(code)}</div>
    <p class="muted">Как тебя зовут?</p>
    <form class="ph-form">
      <input class="input" maxlength="20" placeholder="Твоё имя" value="${esc(name)}" autocomplete="nickname">
      <button class="btn primary big wide">Играть</button>
    </form>
    <button class="link-btn" data-other>Другой код</button>
  </div>`;
  const i = $('form input', app);
  i.focus();
  $('form', app).addEventListener('submit', (e) => {
    e.preventDefault();
    name = i.value.trim().slice(0, 20);
    if (!name) return toast('Напиши имя');
    store.set('plyukh-name', name);
    connect();
  });
  $('[data-other]', app).addEventListener('click', () => { code = ''; codeScreen(); });
}

function messageScreen(title, text, retry = false) {
  mounted = false;
  app.innerHTML = `<div class="ph-center">${logo}<h1>${esc(title)}</h1><p class="muted">${esc(text)}</p>
    ${retry ? '<button class="btn primary big wide" data-retry>Войти снова</button>' : ''}</div>`;
  $('[data-retry]', app)?.addEventListener('click', () => { code = ''; history.replaceState(null, '', '?'); codeScreen(); });
}

function connect() {
  pid = role === 'host' ? 'host' : pidFor(code);
  mounted = false;
  view = null;
  app.innerHTML = `<div class="ph-center">${logo}<div class="connecting"><div class="spinner"></div>Подключаемся к комнате ${esc(code)}…</div></div>`;
  client = new Client(code, {
    onOpen: () => client.send({ t: 'hello', role, pid, name, key: hostKey }),
    onData: onMsg,
    onStatus: (s) => { app.dataset.net = s; },
    onNoRoom: () => { client = null; codeScreen(`Комната ${code} не найдена. Проверь код на экране`); },
  });
  client.connect();
  wake();
}

function onMsg(d) {
  if (d.t === 'welcome') { pid = d.pid; return; }
  if (d.t === 'denied') { client.stop(); return messageScreen('Ссылка пульта устарела', 'Открой новую ссылку из меню игры на экране ведущего'); }
  if (d.t === 'kicked') { client.stop(); store.del('plyukh-pid-' + code); return messageScreen('Ты вне игры', 'Ведущий убрал тебя из этой комнаты', true); }
  if (d.t !== 'state' && d.t !== 'hstate') return;
  view = d;
  const c = d.clue;
  if (c?.stage === 'open' && c.openId !== lastOpenId) { lastOpenId = c.openId; openAt = performance.now(); }
  if (c?.lockedMs > 0) lockedUntil = Date.now() + c.lockedMs;
  const remain = c?.remainMs || d.fin?.remainMs || 0;
  deadline = remain > 0 ? Date.now() + remain : 0;
  render();
}

// ---------- player view ----------
function buzzer(v) {
  const c = v.clue;
  if (v.phase !== 'clue' || !c) return { cls: 'off', big: 'Плюх!', small: '(пока рано)' };
  if (c.stage === 'answer') {
    const r = c.result;
    if (r?.me) return { cls: r.delta >= 0 ? 'mine' : 'bad', big: signed(r.delta), small: r.delta >= 0 ? 'верно!' : 'неверно' };
    return { cls: 'off', big: r ? r.name : 'Никто', small: r ? `${signed(r.delta)}` : 'не ответил' };
  }
  if (c.dd) {
    if (c.ddMe && c.stage === 'reading') return { cls: 'mine', big: 'Отвечай!', small: `ставка ${fmt(c.wager)}` };
    return { cls: 'off', big: 'Ставка', small: c.ddName ? `отвечает ${c.ddName}` : '' };
  }
  if (v.mode !== 'buzzer') return { cls: 'off', big: 'Плюх!', small: 'в этой игре отвечают вслух' };
  if (c.stage === 'reading') {
    if (Date.now() - earlyAt < 900) return { cls: 'early', big: 'Рано!', small: 'дождись, пока откроют кнопки' };
    return { cls: 'ready', big: 'Плюх!', small: '(ещё закрыто)' };
  }
  if (c.stage === 'open') {
    if (c.triedMe) return { cls: 'done', big: 'Мимо', small: 'ты уже отвечал(а)' };
    if (pressedOpen === c.openId) return { cls: 'pressed', big: 'Нажато!', small: 'кто же первый…' };
    if (lockedUntil > Date.now()) return { cls: 'early', big: 'Фальстарт', small: 'кнопка заблокирована на секунду' };
    return { cls: 'live', big: 'Плюх!', small: 'жми!' };
  }
  if (c.stage === 'buzzed') return c.buzzedMe ? { cls: 'mine', big: 'Отвечай!', small: 'ты первый(ая)!' } : { cls: 'other', big: c.buzzedName || '…', small: 'отвечает' };
  return { cls: 'off', big: 'Плюх!', small: '' };
}

function status(v) {
  const c = v.clue;
  const f = v.fin;
  switch (v.phase) {
    case 'lobby': return ['Ждём начала игры…', 'Как только ведущий начнёт, здесь появится кнопка'];
    case 'board': return v.pickerMe ? ['Твой выбор!', 'Скажи тему и стоимость'] : [v.picker ? `Выбирает ${v.picker}` : 'Выбираем вопрос…', 'Смотри на экран'];
    case 'clue': {
      const head = `${c.cat || 'Вопрос'} · ${c.dd ? 'вопрос-ставка' : fmt(c.value)}`;
      if (c.stage === 'ddIntro') return c.ddMe ? ['Вопрос-ставка!', `Сколько ставишь? От ${fmt(c.wagerReq?.min || 0)} до ${fmt(c.wagerReq?.max || 0)}`] : [head, `Вопрос-ставка у ${c.ddName || '…'}. Ждём ставку`];
      if (c.stage === 'reading') return [head, c.dd ? (c.ddMe ? 'Отвечай вслух!' : `Отвечает ${c.ddName}`) : v.mode === 'buzzer' ? 'Слушай вопрос — кнопки скоро откроют' : 'Отвечай вслух'];
      if (c.stage === 'open') return [head, c.triedMe ? 'Ждём остальных' : 'Кнопки открыты!'];
      if (c.stage === 'buzzed') return [head, c.buzzedMe ? 'Говори ответ вслух!' : `Отвечает ${c.buzzedName}`];
      return [head, c.result ? (c.result.me ? (c.result.delta >= 0 ? 'Красава!' : 'Не повезло') : `${c.result.name}: ${signed(c.result.delta)}`) : 'Никто не ответил'];
    }
    case 'roundEnd': return ['Раунд завершён', 'Промежуточные итоги'];
    case 'final':
      if (f.stage === 'wager') return [`Финал: ${f.cat || ''}`, f.wager != null ? `Ставка принята: ${fmt(f.wager)}. Можно поменять, пока не показали вопрос` : `Сколько ставишь? От 0 до ${fmt(f.max)}`];
      if (f.stage === 'clue') return ['Финальный вопрос — на экране', f.answer != null ? 'Ответ отправлен. Можно исправить, пока идёт время' : 'Напиши ответ и отправь'];
      return ['Ведущий проверяет ответы', f.judged == null ? `Твой ответ: «${f.answer || '—'}», ставка ${fmt(f.wager || 0)}` : f.judged ? `Верно! ${signed(f.wager || 0)}` : `Неверно: ${signed(-(f.wager || 0))}`];
    case 'end': {
      const place = (v.standings || []).findIndex((s) => s.me) + 1;
      return [place === 1 ? 'Ты победил(а)! 🏆' : place ? `Ты на ${place} месте` : 'Игра окончена', 'Спасибо за игру!'];
    }
  }
  return ['', ''];
}

function mainBlock(v) {
  const c = v.clue;
  const f = v.fin;
  if (v.phase === 'clue' && c?.stage === 'ddIntro' && c.ddMe && c.wagerReq) {
    return { key: 'dd', html: wagerForm('dd', c.wagerReq.min, c.wagerReq.max, Math.min(c.wagerReq.max, c.value), 'Поставить') };
  }
  if (v.phase === 'final' && f.stage === 'wager') return { key: 'fw', html: wagerForm('fw', 0, f.max, f.wager ?? '', f.wager != null ? 'Изменить ставку' : 'Поставить') };
  if (v.phase === 'final' && f.stage === 'clue') {
    return { key: 'fa', html: `<form class="ph-form big-form" data-form="fa"><div class="ph-timer"><span></span></div><textarea class="input" rows="3" maxlength="300" placeholder="Твой ответ"></textarea><button class="btn primary big wide">Отправить ответ</button></form>` };
  }
  if (['roundEnd', 'end'].includes(v.phase) && v.standings) {
    return { key: 'st', html: `<ol class="standings ph">${v.standings.map((s) => `<li class="${s.me ? 'me' : ''}"><span>${esc(s.name)}</span><b>${fmt(s.score)}</b></li>`).join('')}</ol>` };
  }
  return { key: 'buzzer', html: `<button class="buzzer" type="button"><span class="bz-timer"></span><span class="bz-big"></span><span class="bz-small"></span></button>` };
}

function wagerForm(kind, min, max, value, label) {
  return `<form class="ph-form big-form" data-form="${kind}">
    <input class="input wager-input" type="number" inputmode="numeric" min="${min}" max="${max}" value="${value}" placeholder="${min}–${max}">
    <div class="quick">${[...new Set([min, Math.round(max / 2), max])].map((x) => `<button type="button" class="btn small" data-quick="${x}">${x === max && max > 0 ? 'Ва-банк ' : ''}${fmt(x)}</button>`).join('')}</div>
    <button class="btn primary big wide">${esc(label)}</button>
  </form>`;
}

function mountPlayer() {
  mounted = 'player';
  app.innerHTML = `<div class="ph-game">
    <header class="ph-top"><span class="logo small">${LOGO_SVG}<span>Плюх</span></span><span class="ph-code">${esc(code)}</span><span class="net-dot"></span></header>
    <div class="ph-status"><div class="ph-title"></div><div class="ph-sub"></div></div>
    <div class="ph-main"></div>
    <footer class="ph-foot"><span class="ph-name"></span><span class="ph-score"></span></footer>
  </div>`;
  const main = $('.ph-main', app);
  main.addEventListener('pointerdown', (e) => {
    if (e.target.closest('.buzzer')) { e.preventDefault(); press(); }
  });
  main.addEventListener('click', (e) => {
    const q = e.target.closest('[data-quick]');
    if (q) { const i = q.closest('form').querySelector('input'); i.value = q.dataset.quick; }
  });
  main.addEventListener('submit', (e) => {
    e.preventDefault();
    const form = e.target;
    const kind = form.dataset.form;
    if (kind === 'fa') {
      const t = form.querySelector('textarea').value.trim();
      if (!t) return toast('Напиши ответ');
      client.send({ t: 'fanswer', text: t });
      toast('Ответ отправлен');
      return;
    }
    const n = Math.round(+form.querySelector('input').value);
    const min = +form.querySelector('input').min, max = +form.querySelector('input').max;
    if (!Number.isFinite(n) || n < min || n > max) return toast(`Ставка от ${fmt(min)} до ${fmt(max)}`);
    client.send({ t: kind === 'dd' ? 'wager' : 'fwager', amount: n });
    toast('Ставка отправлена');
    form.querySelector('input').blur();
  });
}

function press() {
  const c = view?.clue;
  if (!c || view.mode !== 'buzzer' || c.dd) return;
  if (c.stage === 'open' && !c.triedMe && pressedOpen !== c.openId && lockedUntil <= Date.now()) {
    pressedOpen = c.openId;
    client.send({ t: 'buzz', oid: c.openId, rt: performance.now() - openAt });
    navigator.vibrate?.(40);
  } else if (c.stage === 'reading') {
    client.send({ t: 'early' });
    earlyAt = Date.now();
    navigator.vibrate?.([30, 40, 30]);
    setTimeout(render, 950);
  }
  render();
}

function renderPlayer() {
  if (mounted !== 'player') mountPlayer();
  const v = view;
  const [t, s] = status(v);
  $('.ph-title', app).textContent = t;
  $('.ph-sub', app).textContent = s;
  $('.ph-name', app).textContent = v.you?.name || name;
  $('.ph-score', app).textContent = fmt(v.you?.score || 0);
  $('.ph-score', app).classList.toggle('neg', (v.you?.score || 0) < 0);
  const m = mainBlock(v);
  const main = $('.ph-main', app);
  if (main.dataset.key !== m.key) {
    main.dataset.key = m.key;
    main._html = null;
  }
  setHTML(main, m.html);
  if (m.key === 'fa') {
    const ta = main.querySelector('textarea');
    if (ta && !ta.value && v.fin?.answer) ta.value = v.fin.answer;
  }
  const b = main.querySelector('.buzzer');
  if (b) {
    const st = buzzer(v);
    b.className = `buzzer ${st.cls}`;
    b.querySelector('.bz-big').textContent = st.big;
    b.querySelector('.bz-small').textContent = st.small;
  }
  tick();
}

// ---------- host remote ----------
function mountRemote() {
  mounted = 'remote';
  app.innerHTML = `<div class="rm">
    <header class="ph-top"><span class="logo small">${LOGO_SVG}<span>Пульт</span></span><span class="ph-code">${esc(code)}</span><span class="net-dot"></span></header>
    <div class="rm-info"></div>
    <div class="rm-ctl"></div>
    <div class="rm-players"></div>
    <div class="rm-foot"><button class="btn" data-act="undo">↶ Отменить последнее</button></div>
  </div>`;
  bindControls($('.rm', app), (a, args) => {
    if (!client.send({ t: 'act', a, args })) toast('Нет связи с экраном');
    navigator.vibrate?.(15);
  });
}

function renderRemote() {
  if (mounted !== 'remote') mountRemote();
  const v = view;
  let info = '';
  if (v.phase === 'lobby') info = `<div class="rm-card"><b>${esc(v.title)}</b><p class="muted">Игроки собираются. Начни игру на большом экране.</p></div>`;
  else if (v.phase === 'board' && v.round) {
    const r = v.round;
    info = `<div class="rm-card"><b>${esc(r.name)}</b><span class="muted small"> · ★ — вопрос-ставка</span>
      <div class="rm-grid" style="--cols:${r.cats.length}">
        ${r.cats.map((c) => `<div class="rm-cat">${esc(c)}</div>`).join('')}
        ${r.values.map((val, qi) => r.cats.map((_, ci) => {
          const g = r.grid[ci][qi];
          const off = g.u || !g.f;
          return `<button class="rm-cell ${off ? 'used' : ''}" data-act="pick" data-args='${JSON.stringify({ c: ci, q: qi })}' ${off ? 'disabled' : ''}>${off ? '' : fmt(val) + (g.d ? '★' : '')}</button>`;
        }).join('')).join('')}
      </div></div>`;
  } else if (v.clue) {
    const c = v.clue;
    info = `<div class="rm-card"><div class="muted small">${esc(c.cat)} · ${fmt(c.value)}${c.dd ? ' · ставка' : ''}</div>
      <div class="rm-q">${esc(c.q) || '<i class="muted">(медиа-вопрос)</i>'}</div>
      <div class="rm-a"><span class="muted small">Ответ</span><b>${esc(c.a || '—')}</b></div>
      <div class="rm-status">${esc(c.status)}</div></div>`;
  } else if (v.fin) {
    const f = v.fin;
    info = `<div class="rm-card"><div class="muted small">Финал · ${esc(f.cat)}</div><div class="rm-q">${esc(f.q)}</div>
      <div class="rm-a"><span class="muted small">Ответ</span><b>${esc(f.a || '—')}</b></div><div class="rm-status">${esc(f.status)}</div></div>`;
  } else if (v.phase === 'roundEnd') info = `<div class="rm-card"><b>Раунд завершён</b></div>`;
  else if (v.phase === 'end') info = `<div class="rm-card"><b>Игра окончена</b></div>`;
  setHTML($('.rm-info', app), info);
  setHTML($('.rm-ctl', app), controlsHTML(v.controls || []));
  setHTML($('.rm-players', app), `<div class="rm-card"><div class="muted small">Очки (± по 100)</div>${(v.players || []).map((p) => `
    <div class="rm-p ${p.picker ? 'picker' : ''}">
      <span class="dot ${p.phone ? (p.online ? 'on' : 'off') : 'none'}"></span>
      <span class="rm-pn">${esc(p.name)}${p.picker ? ' <small>выбирает</small>' : ''}</span>
      <b class="${p.score < 0 ? 'neg' : ''}">${fmt(p.score)}</b>
      <button class="btn small" data-act="adj" data-args='${JSON.stringify({ pid: p.id, delta: -100 })}'>−</button>
      <button class="btn small" data-act="adj" data-args='${JSON.stringify({ pid: p.id, delta: 100 })}'>+</button>
    </div>`).join('')}</div>`);
  $('.rm-foot [data-act=undo]', app).disabled = !v.canUndo;
}

// ---------- shared ----------
function render() {
  if (!view) return;
  if (role === 'host') renderRemote();
  else renderPlayer();
}

function tick() {
  const left = deadline ? Math.max(0, deadline - Date.now()) : 0;
  for (const el of app.querySelectorAll('.bz-timer, .ph-timer span')) el.textContent = left ? Math.ceil(left / 1000) : '';
  // Unlock the buzzer visuals when a penalty or "too early" flash expires.
  if (view?.clue && role === 'player') {
    const b = app.querySelector('.buzzer');
    if (b && (b.classList.contains('early') && Date.now() - earlyAt > 900 && lockedUntil <= Date.now())) renderPlayer();
  }
}
setInterval(tick, 250);

document.addEventListener('keydown', (e) => {
  if (e.code === 'Space' && role === 'player' && mounted === 'player' && !e.target.closest('input, textarea')) {
    e.preventDefault();
    if (!e.repeat) press();
  }
});

// Keep the phone screen awake during the game.
let lock = null;
async function wake() {
  try { if (!lock && document.visibilityState === 'visible') { lock = await navigator.wakeLock?.request('screen'); lock?.addEventListener('release', () => { lock = null; }); } } catch {}
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible' || !client) return;
  wake();
  if (!client.conn?.open) client.lost();
});

if (!code) codeScreen();
else if (role === 'host') connect();
else if (name && store.get('plyukh-pid-' + code)) connect(); // returning to the same room: skip the name step
else nameScreen();
