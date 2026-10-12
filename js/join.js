// Player page: the game screen (board, questions, buzzing) on a phone or a computer,
// or the host's remote when opened with ?k=<host key>.
import { $, esc, nl2br, fmt, signed, store, uid, toast, banner, dialog, confirmDlg, LOGO_SVG } from './util.js?v=1791812190596';
import { VERSION } from './version.js?v=1791812190596';
import { Client, LocalLink } from './net.js?v=1791812190596';
import { controlsHTML, bindControls, setHTML } from './controls.js?v=1791812190596';
import { MediaReceiver } from './mediasync.js?v=1791812190596';
import { createScreen, prefs } from './gameui.js?v=1791812190596';

const app = document.getElementById('app');
const params = new URLSearchParams(location.search);
let code = (params.get('r') || '').replace(/\D/g, '').slice(0, 4);
const hostKey = params.get('k') || '';
const role = hostKey ? 'host' : 'player';
// Host window opened from the game screen on the same computer (no room code, no network).
const local = role === 'host' && params.get('local') === '1';
if (local) document.title = 'Окно ведущего — artempje';
// Test bench (test/): a fake player in a frame, with its own id and an automatic team.
const testN = params.get('test');

let client = null;
let view = null;
let pid = null;
let name = testN ? params.get('tname') || `Игрок ${testN}` : store.get('plyukh-name', '');
let mounted = false;
let screen = null;
let lastOpenId = 0;
let openAt = 0;
let pressedOpen = 0;
let earlyAt = 0;
let lockedUntil = 0;

// Clue media streamed from the host; kept for the whole visit, so reconnects don't download it again.
let mediaRaf = 0;
const receiver = new MediaReceiver(() => {
  if (mediaRaf || mounted !== 'player') return;
  mediaRaf = requestAnimationFrame(() => { mediaRaf = 0; if (view) renderPlayer(); });
});

const logo = `<a class="logo" href="../">${LOGO_SVG}<span>artempje</span></a>`;

function pidFor(c) {
  if (testN) return `test-${testN}`;
  const k = 'plyukh-pid-' + c;
  let p = store.get(k);
  if (!p) { p = uid('p'); store.set(k, p); }
  return p;
}

// ---------- navigation ----------
const homeLink = '<a class="back-link" href="../">← На главную</a>';

// Leaves the room: back to the code screen, or to the home page.
function leave(home = false) {
  client?.stop();
  client = null;
  view = null;
  mounted = false;
  screen?.destroy();
  screen = null;
  document.getElementById('banner')?.remove();
  if (home || role === 'host') { location.href = '../'; return; }
  code = '';
  history.replaceState(null, '', location.pathname);
  codeScreen();
}

async function confirmLeave(home) {
  const playing = role === 'player' && view && !['lobby', 'end'].includes(view.phase);
  if (playing && !(await confirmDlg('Выйти из игры? Очки команды сохранятся — можно вернуться по тому же коду.', 'Выйти'))) return;
  leave(home);
}

async function openMenu() {
  const r = await dialog({
    title: local ? 'Окно ведущего' : 'Пульт ведущего',
    cls: 'menu-dlg',
    buttons: [{ label: 'На главную', value: 'home' }, { label: 'Отмена', value: null, cls: 'ghost' }],
  });
  if (r) leave(true);
}

const menuButton = '<button type="button" class="ph-menu" data-menu aria-label="Меню">☰</button>';

// ---------- entry screens ----------
function codeScreen(err = '') {
  mounted = false;
  app.innerHTML = `<div class="ph-center">
    ${homeLink}
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
    ${homeLink}
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
  $('[data-other]', app).addEventListener('click', () => leave());
}

function messageScreen(title, text, retry = false) {
  mounted = false;
  screen?.destroy();
  screen = null;
  app.innerHTML = `<div class="ph-center">${homeLink}${logo}<h1>${esc(title)}</h1><p class="muted">${esc(text)}</p>
    ${retry ? '<button class="btn primary big wide" data-retry>Войти снова</button>' : ''}</div>`;
  $('[data-retry]', app)?.addEventListener('click', () => { code = ''; history.replaceState(null, '', '?'); codeScreen(); });
}

function connect() {
  pid = role === 'host' ? 'host' : pidFor(code);
  mounted = false;
  view = null;
  screen?.destroy();
  screen = null;
  app.innerHTML = `<div class="ph-center">${homeLink}${logo}<div class="connecting"><div class="spinner"></div>${local ? 'Подключаемся к экрану игры…' : `Подключаемся к комнате ${esc(code)}…`}</div>
    <button type="button" class="link-btn" data-cancel>${role === 'player' ? 'Отмена — ввести другой код' : 'Отмена'}</button></div>`;
  $('[data-cancel]', app).addEventListener('click', () => leave());
  const handlers = {
    onOpen: () => client.send({ t: 'hello', role, pid, name, key: hostKey, have: receiver.keys(), v: VERSION, auto: !!testN }),
    onData: onMsg,
    onStatus: (s) => { app.dataset.net = s; },
    onNoRoom: () => { client = null; codeScreen(`Комната ${code} не найдена. Проверь код на экране`); },
  };
  client = local ? new LocalLink(hostKey, handlers) : new Client(code, handlers);
  client.connect();
  if (!local && !testN) wake();
}

function onMsg(d) {
  if (receiver.handle(d)) return;
  if (d.t === 'welcome') { pid = d.pid; checkVersion(d.v); return; }
  if (d.t === 'denied') { client.stop(); return messageScreen('Ссылка пульта устарела', 'Открой новую ссылку из меню игры на экране ведущего'); }
  if (d.t === 'kicked') { client.stop(); store.del('plyukh-pid-' + code); return messageScreen('Ты вне игры', 'Ведущий убрал тебя из этой комнаты', true); }
  if (d.t !== 'state' && d.t !== 'hstate') return;
  view = d;
  if (d.t === 'state') {
    const c = d.me?.clue;
    if (c?.stage === 'open' && c.openId !== lastOpenId) { lastOpenId = c.openId; openAt = performance.now(); }
    if (c?.lockedMs > 0) lockedUntil = Date.now() + c.lockedMs;
    // The host sends time left; turn it into our own clock once, on arrival.
    const t = d.view?.timer;
    if (t) d.view.timer = { deadline: Date.now() + t.remain, total: t.total };
  }
  render();
}

// Host and phone must run the same release, or features like clue media silently go missing.
function checkVersion(hostV) {
  if (hostV === VERSION) return;
  if (!hostV || hostV < VERSION) {
    banner('Ведущему нужно обновить страницу игры (F5) — иначе часть игры не будет работать.');
    return;
  }
  // This page came from the browser cache and is older than the host's: load it fresh, once.
  const once = 'plyukh-reloaded-' + hostV;
  let tried = false;
  try { tried = !!sessionStorage.getItem(once); sessionStorage.setItem(once, '1'); } catch {}
  if (tried) {
    banner('На сайте новая версия — обнови страницу.', { label: 'Обновить', onClick: () => location.reload() });
    return;
  }
  const u = new URL(location.href);
  u.searchParams.set('_', Date.now());
  location.replace(u.href);
}

// ---------- player: buzzing ----------
function buzzState(v) {
  const me = v.me;
  const c = me.clue;
  if (v.phase === 'board') return { cls: 'bs-closed', big: 'Жди', small: v.view?.mine ? 'ваш выбор — нажми на клетку' : 'ждём вопрос' };
  if (v.phase !== 'clue' || !c) return { cls: 'bs-closed', big: 'Жди', small: '' };
  if (c.stage === 'answer') {
    const r = c.result;
    if (r?.mine) return { cls: r.delta >= 0 ? 'bs-mine' : 'bs-bad', big: signed(r.delta), small: r.delta >= 0 ? 'верно!' : 'неверно' };
    return { cls: 'bs-off', big: r ? r.team?.name || '' : 'Никто', small: r ? signed(r.delta) : 'не ответил' };
  }
  if (c.stage === 'reading') {
    if (Date.now() - earlyAt < 900) return { cls: 'bs-early', big: 'Рано!', small: 'дождись, пока откроют кнопки' };
    return { cls: 'bs-closed', big: 'Жди', small: 'кнопки ещё закрыты' };
  }
  if (c.stage === 'open') {
    if (c.triedMine) return { cls: 'bs-done', big: 'Мимо', small: 'ваша команда уже отвечала' };
    if (pressedOpen === c.openId) return { cls: 'bs-pressed', big: 'Нажато!', small: 'кто же первый…' };
    if (lockedUntil > Date.now()) return { cls: 'bs-early', big: 'Фальстарт', small: 'кнопка заблокирована на секунду' };
    return { cls: 'bs-live', big: 'Жми!', small: 'кнопки открыты' };
  }
  if (c.stage === 'buzzed') {
    if (c.buzzedMine) return { cls: 'bs-mine', big: 'Отвечайте!', small: c.buzzedName ? `${c.buzzedName} нажал(а) первым` : 'ваша команда первая' };
    return { cls: 'bs-other', big: c.buzzedTeam?.name || '…', small: 'отвечают' };
  }
  return { cls: 'bs-closed', big: 'Жди', small: '' };
}

function press() {
  const c = view?.me?.clue;
  if (!c || view.mode !== 'buzzer' || c.dd) return;
  if (c.stage === 'open' && !c.triedMine && pressedOpen !== c.openId && lockedUntil <= Date.now()) {
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

// ---------- player: the side panel ----------
function playerPanel(v) {
  const me = v.me;
  const c = me.clue;
  const f = me.fin;
  if (me.needTeam) return { kind: 'text', lbl: 'Команда', text: 'Выбери свою команду — нажми «Вступить».' };
  if (v.phase === 'lobby') {
    return me.team && v.teamMode !== 'solo'
      ? { kind: 'text', lbl: 'Команда', text: 'Ты в команде {team}. Можно перейти в другую, пока игра не началась.', team: me.team }
      : { kind: 'text', lbl: 'Скоро начнём', text: 'Ведущий собирает игроков.' };
  }
  if (v.phase === 'clue' && c) {
    if (c.stage === 'ddIntro') {
      if (c.wagerReq) return { kind: 'form', form: { key: `dd:${v.view?.key}`, type: 'wager', title: 'Ставка вашей команды', min: c.wagerReq.min, max: c.wagerReq.max, value: '', label: 'Поставить', sub: `От ${fmt(c.wagerReq.min)} до ${fmt(c.wagerReq.max)}` } };
      return { kind: 'text', lbl: 'Вопрос-ставка', text: '{team} делают ставку.', team: c.ddTeam };
    }
    if (c.dd && c.stage !== 'answer') return { kind: 'text', lbl: 'Вопрос-ставка', text: c.ddMine ? `Ваша команда отвечает (ставка ${fmt(c.wager)}) — говорите вслух!` : `Отвечают {team}, ставка ${fmt(c.wager)}`, team: c.ddTeam };
    if (v.mode !== 'buzzer') return { kind: 'text', text: 'Отвечайте вслух — ведущий отметит, кто прав.' };
    return { kind: 'buzz', buzz: buzzState(v) };
  }
  if (v.phase === 'board') return v.mode === 'buzzer' ? { kind: 'buzz', buzz: buzzState(v) } : null;
  if (v.phase === 'final' && f) {
    if (f.stage === 'wager') return { kind: 'form', form: { key: 'fw', type: 'wager', title: 'Ставка вашей команды', min: 0, max: f.max, value: f.wager ?? (f.max ? '' : 0), label: 'Поставить', sub: f.wager != null ? `Принято: ${fmt(f.wager)}. Можно изменить, пока не показали вопрос` : f.max ? `От 0 до ${fmt(f.max)}` : 'У команды нет очков — ставка 0, но ответить можно' } };
    if (f.stage === 'clue') return { kind: 'form', form: { key: 'fa', type: 'answer', title: 'Ответ вашей команды', value: f.answer ?? '', label: f.answer != null ? 'Исправить ответ' : 'Отправить ответ', sub: f.answer != null ? `Отправлено: «${f.answer}»` : 'Один ответ на команду' } };
    return { kind: 'text', lbl: 'Финал', text: f.judged == null ? `Ваша ставка ${fmt(f.wager || 0)}. Ведущий проверяет ответы.` : f.judged ? `Верно! ${signed(f.wager || 0)}` : `Неверно: ${signed(-(f.wager || 0))}` };
  }
  if (v.phase === 'final' && !f) return { kind: 'text', text: 'Финал играют команды.' };
  if (v.phase === 'end' || v.phase === 'roundEnd') {
    const st = v.view?.standings || [];
    const place = st.findIndex((s) => s.me) + 1;
    return { kind: 'text', lbl: v.phase === 'end' ? 'Итог' : 'Раунд завершён', text: place === 1 ? 'Ваша команда первая! 🏆' : place ? `Ваша команда на ${place} месте` : '' };
  }
  return null;
}

// ---------- player: the screen ----------
const KIND_WORD = { image: 'картинку', audio: 'аудио', video: 'видео' };

function mediaReady(m) {
  return m.k === 'youtube' || !!m.url || !!receiver.url(m.key);
}

async function playerMediaNode(m, autoplay) {
  const url = m.key ? receiver.url(m.key) : m.url || null;
  if (m.k !== 'youtube' && !url) {
    const d = document.createElement('div');
    d.className = 'pc-loading';
    d.innerHTML = `Загружаем ${KIND_WORD[m.k] || 'файл'}… <span class="pc-pct"></span>`;
    return d;
  }
  if (m.k === 'youtube') {
    const f = document.createElement('iframe');
    f.src = `https://www.youtube-nocookie.com/embed/${encodeURIComponent(m.vid)}?autoplay=${autoplay ? 1 : 0}&start=${m.start || 0}&rel=0&playsinline=1`;
    f.allow = 'autoplay; encrypted-media; fullscreen; picture-in-picture';
    f.allowFullscreen = true;
    return f;
  }
  if (m.k === 'image') {
    const img = new Image();
    img.alt = '';
    img.src = url;
    return img;
  }
  const el = document.createElement(m.k === 'audio' ? 'audio' : 'video');
  el.src = url;
  el.controls = true;
  el.playsInline = true;
  el.preload = 'auto';
  if (autoplay) {
    el.autoplay = true;
    // Phones may block autoplay with sound; the controls stay visible to start it by hand.
    el.play?.().catch(() => {});
  }
  if (m.k !== 'audio') return el;
  const d = document.createElement('div');
  d.className = 'pc-audio';
  d.innerHTML = '<span>🎵</span>';
  d.append(el);
  return d;
}

function onScreen(type, d = {}) {
  switch (type) {
    case 'buzz': return press();
    case 'pick': return client?.send({ t: 'pick', c: d.c, q: d.q });
    case 'join': return client?.send({ t: 'team', team: d.team });
    case 'prefs': return render();
    case 'link': return confirmLeave(d.name === 'home');
    case 'form': {
      if (d.type === 'answer') {
        const t = String(d.value || '').trim();
        if (!t) return toast('Напиши ответ');
        client.send({ t: 'fanswer', text: t });
        return toast('Ответ отправлен');
      }
      const n = Math.round(+d.value);
      const form = screen.el.querySelector('.p-form input');
      const min = +(form?.min || 0), max = +(form?.max || 0);
      if (d.value === '' || !Number.isFinite(n) || n < min || n > max) return toast(`Ставка от ${fmt(min)} до ${fmt(max)}`);
      client.send({ t: d.key === 'fw' ? 'fwager' : 'wager', amount: n });
      return toast('Ставка отправлена');
    }
  }
}

function renderPlayer() {
  if (mounted !== 'player' || !screen) {
    mounted = 'player';
    app.innerHTML = '';
    screen = createScreen(app, {
      role: 'player',
      on: onScreen,
      mediaNode: playerMediaNode,
      links: () => [{ name: 'leave', label: 'Выйти из комнаты' }, { name: 'home', label: 'На главную' }],
    });
  }
  const v = view;
  const me = v.me;
  const c = me.clue;
  const vw = { ...v.view };
  if (vw.media) vw.mediaKey = `${vw.mediaKey}|${mediaReady(vw.media) ? 1 : 0}`;
  const open = v.phase === 'clue' && v.mode === 'buzzer' && c && !c.dd && c.stage === 'open';
  vw.tap = prefs.buzz === 'tap' && open;
  const teams = v.teams.map((t) => {
    if (t.id !== me.team?.id || prefs.buzz !== 'card' || v.phase !== 'clue' || v.mode !== 'buzzer' || c?.dd) return t;
    const cls = [...t.cls, 'tappable'];
    if (open && !c.triedMine && pressedOpen !== c.openId) cls.push('live');
    return { ...t, cls, sub: t.sub, badge: t.badge || (open ? 'жми сюда' : '') };
  });
  screen.update({
    title: v.title,
    round: v.round,
    tools: { name: me.name, color: me.team?.color },
    view: vw,
    teams,
    panel: playerPanel(v),
  });
  if (vw.media?.key && !mediaReady(vw.media)) screen.setProgress(`${Math.round(receiver.progress(vw.media.key) * 100)}%`);
}

// ---------- host remote ----------
function mountRemote() {
  mounted = 'remote';
  app.innerHTML = `<div class="rm">
    <header class="ph-top"><span class="logo small">${LOGO_SVG}<span>${local ? 'Окно ведущего' : 'Пульт'}</span></span><span class="ph-code">${esc(code)}</span><span class="net-dot"></span>${menuButton}</header>
    ${local ? '<p class="rm-warn">Это окно не показывай игрокам: в Discord выбирай «Окно» с игрой, а не весь экран.</p>' : ''}
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
  setHTML($('.rm-players', app), `<div class="rm-card"><div class="muted small">Команды (± по 100)</div>${(v.teams || []).map((t) => `
    <div class="rm-p ${t.picker ? 'picker' : ''}">
      <span class="dot" style="background:${esc(t.color)}"></span>
      <span class="rm-pn">${esc(t.name)}${t.picker ? ' <small>выбирает</small>' : ''}${t.members?.length ? `<br><small class="muted">${esc(t.members.join(', '))}</small>` : ''}</span>
      <b class="${t.score < 0 ? 'neg' : ''}">${fmt(t.score)}</b>
      <button class="btn small" data-act="adj" data-args='${esc(JSON.stringify({ team: t.id, delta: -100 }))}'>−</button>
      <button class="btn small" data-act="adj" data-args='${esc(JSON.stringify({ team: t.id, delta: 100 }))}'>+</button>
    </div>`).join('')}</div>`);
  $('.rm-foot [data-act=undo]', app).disabled = !v.canUndo;
}

// ---------- shared ----------
function render() {
  if (!view) return;
  if (role === 'host') renderRemote();
  else renderPlayer();
}

// Unlock the buzzer visuals when a penalty or "too early" flash expires.
setInterval(() => {
  if (role !== 'player' || !view?.me?.clue) return;
  if (earlyAt && Date.now() - earlyAt > 900 && Date.now() - earlyAt < 1400) render();
  if (lockedUntil && Date.now() > lockedUntil && Date.now() - lockedUntil < 400) render();
}, 250);

app.addEventListener('click', (e) => {
  if (e.target.closest('[data-menu]')) openMenu();
});

document.addEventListener('keydown', (e) => {
  if (e.code === 'Space' && role === 'player' && mounted === 'player' && !e.target.closest('input, textarea') && !document.querySelector('.dlg-wrap')) {
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
  if (!testN) wake();
  if (!client.conn?.open) client.lost();
});

if (local) connect();
else if (!code) codeScreen();
else if (role === 'host' || testN) connect();
else if (name && store.get('plyukh-pid-' + code)) connect(); // returning to the same room: skip the name step
else nameScreen();
