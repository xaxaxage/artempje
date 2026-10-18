// Mini-games: now and then, between questions, everyone plays something tiny on their phone for
// bonus points. The host picks the game and collects the results; every phone measures itself
// (a reaction time is counted on the phone, so a slow connection doesn't lose).
import { esc, plural } from './util.js?v=1792357741893';

export const GAMES = {
  reaction: { icon: '⚡', name: 'Реакция', rule: 'Жди зелёный экран и сразу жми. Нажмёшь раньше — вылетишь.', time: 10000 },
  taps: { icon: '👆', name: 'Тапалка', rule: 'Жми на кнопку как можно чаще — 5 секунд!', time: 8000 },
  math: { icon: '🧮', name: 'Считалка', rule: 'Реши пример быстрее всех. Ошибёшься — вылетишь.', time: 15000 },
  colors: { icon: '🎨', name: 'Цвета', rule: 'Жми цвет, которым написано слово, — а не то, что написано.', time: 15000 },
  stop: { icon: '⏱', name: 'Ровно 5 секунд', rule: 'Останови секундомер ровно на 5,00. Цифры пропадут через секунду!', time: 15000 },
};
export const INTRO_MS = 4000;
const TAP_MS = 5000;
const STOP_AT = 5000;
const COLORS = [['красный', '#e0483e'], ['синий', '#2f6fe0'], ['зелёный', '#24a05a'], ['жёлтый', '#e2ad12'], ['фиолетовый', '#9a4fd8']];

const rnd = (a, b) => a + Math.floor(Math.random() * (b - a + 1));
const pick = (a) => a[Math.floor(Math.random() * a.length)];
function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}
const sec = (ms) => (ms / 1000).toFixed(2).replace('.', ',');

// ---------- host side ----------
export function newGame(kind = pick(Object.keys(GAMES))) {
  if (kind === 'reaction') return { kind, delay: rnd(1500, 4000) };
  if (kind === 'math') {
    const op = pick(['+', '−', '×']);
    let a, b, ans;
    if (op === '+') { a = rnd(12, 79); b = rnd(12, 79); ans = a + b; }
    else if (op === '−') { a = rnd(40, 99); b = rnd(11, a - 11); ans = a - b; }
    else { a = rnd(3, 12); b = rnd(3, 12); ans = a * b; }
    const opts = new Set([ans]);
    for (const d of shuffle([1, -1, 2, -2, 10, -10, 9, 11])) if (opts.size < 4 && ans + d > 0) opts.add(ans + d);
    return { kind, q: `${a} ${op} ${b}`, ans, opts: shuffle([...opts]) };
  }
  if (kind === 'colors') {
    const [word, ink, x, y] = shuffle([0, 1, 2, 3, 4]);
    return { kind, word, ink, opts: shuffle([word, ink, x, y]) };
  }
  return { kind };
}

// Lower is better in every game; null means the player is out.
export function scoreOf(kind, r) {
  if (!r?.ok) return null;
  if (kind === 'taps') return -r.val;
  if (kind === 'stop') return Math.abs(r.val - STOP_AT);
  return r.val;
}

export function resultText(kind, r) {
  if (!r) return 'не успел(а)';
  if (!r.ok) return { early: 'фальстарт', wrong: 'ошибка' }[r.why] || 'не успел(а)';
  if (kind === 'reaction') return `${Math.round(r.val)} мс`;
  if (kind === 'taps') return `${r.val} ${plural(r.val, 'нажатие', 'нажатия', 'нажатий')}`;
  if (kind === 'stop') return `${sec(r.val)} с`;
  return `${sec(r.val)} с`;
}

// ---------- phone side: a full-screen overlay over the game screen ----------
export class MiniPlayer {
  constructor(send) {
    this.send = send;
    this.el = null;
    this.id = null;
  }

  // `m` is the player's part of the state (me.mini), or null when there is no mini-game.
  update(m) {
    if (!m) return this.close();
    if (m.id !== this.id) { this.close(); this.open(m); }
    this.m = m;
    if (m.stage === 'intro') this.intro();
    else if (m.stage === 'play') {
      if (m.part && !m.sent && !this.started) this.play();
      else if (!this.started && !this.finished) this.watch();
    } else if (m.stage === 'done') this.done();
  }

  open(m) {
    this.id = m.id;
    this.started = this.finished = this.hidden = false;
    this.stage = null;
    this.el = document.createElement('div');
    this.el.className = 'mini-ov';
    this.el.innerHTML = '<div class="mini-in"></div>';
    this.el.addEventListener('pointerdown', (e) => {
      // Results close with a tap, but not with the last taps of the game itself.
      if (this.stage === 'done') { if (Date.now() - this.doneAt > 800) { this.hidden = true; this.el.hidden = true; } return; }
      if (this.onTap) { e.preventDefault(); this.onTap(e); }
    });
    document.body.append(this.el);
  }

  close() {
    this.clear();
    this.el?.remove();
    this.el = null;
    this.id = null;
  }

  clear() {
    clearInterval(this.iv);
    clearTimeout(this.to);
    clearTimeout(this.to2);
    this.onTap = null;
  }

  draw(html, cls = '') {
    this.el.className = `mini-ov ${cls}`;
    this.el.hidden = this.hidden;
    this.el.firstElementChild.innerHTML = html;
  }

  head() {
    const g = GAMES[this.m.game.kind];
    return `<div class="mini-ico">${g.icon}</div><div class="mini-name">Мини-игра · ${esc(g.name)}</div>`;
  }

  intro() {
    if (this.stage === 'intro') return;
    this.stage = 'intro';
    const end = Date.now() + this.m.remain;
    const g = GAMES[this.m.game.kind];
    this.draw(`${this.head()}<div class="mini-rule">${esc(g.rule)}</div>
      <div class="mini-big mini-cd"></div><div class="mini-sub">${this.m.part ? `за победу +${this.m.bonus} вашей команде` : 'ты в этот раз смотришь'}</div>`, 'm-intro');
    const cd = this.el.querySelector('.mini-cd');
    const tick = () => { cd.textContent = Math.max(1, Math.ceil((end - Date.now()) / 1000)); };
    tick();
    this.iv = setInterval(tick, 200);
  }

  watch() {
    if (this.stage === 'watch') return;
    this.clear();
    this.stage = 'watch';
    this.draw(`${this.head()}<div class="mini-big">Идёт игра…</div><div class="mini-sub">результаты появятся здесь</div>`, 'm-intro');
  }

  play() {
    this.clear();
    this.stage = 'play';
    this.started = true;
    this[this.m.game.kind]?.();
    navigator.vibrate?.(30);
  }

  finish(r) {
    if (this.finished) return;
    this.finished = true;
    this.clear();
    this.send({ t: 'mini', id: this.id, val: r.val, ok: r.ok, why: r.why || '' });
    navigator.vibrate?.(r.ok ? 40 : [40, 60, 40]);
    this.stage = 'sent';
    this.draw(`${this.head()}<div class="mini-big">${r.ok ? 'Готово!' : 'Эх!'}</div><div class="mini-res">${esc(resultText(this.m.game.kind, r))}</div><div class="mini-sub">ждём остальных…</div>`, r.ok ? 'm-ok' : 'm-bad');
  }

  later(ms, fn) { this.to2 = setTimeout(fn, ms); }

  // ---------- the games ----------
  reaction() {
    this.draw('<div class="mini-big">Жди…</div><div class="mini-sub">как только экран станет зелёным — жми</div>', 'm-red');
    let go = 0;
    this.to = setTimeout(() => {
      go = performance.now();
      this.draw('<div class="mini-big huge">ЖМИ!</div>', 'm-green');
      this.later(3000, () => this.finish({ val: 0, ok: false, why: 'late' }));
    }, this.m.game.delay);
    this.onTap = () => {
      if (!go) return this.finish({ val: 0, ok: false, why: 'early' });
      this.finish({ val: Math.round(performance.now() - go), ok: true });
    };
  }

  taps() {
    let n = 0;
    const end = performance.now() + TAP_MS;
    this.draw('<div class="mini-big mini-n">0</div><button type="button" class="mini-tap">ЖМИ!</button><div class="mini-sub mini-left"></div>', 'm-play');
    const num = this.el.querySelector('.mini-n');
    const left = this.el.querySelector('.mini-left');
    this.onTap = (e) => {
      if (!e.target.closest('.mini-tap')) return;
      num.textContent = ++n;
    };
    // A plain timer, not animation frames: those stop when the page is hidden.
    const tick = () => {
      const l = end - performance.now();
      if (l <= 0) return this.finish({ val: n, ok: true });
      left.textContent = `осталось ${sec(l).slice(0, -1)} с`;
    };
    tick();
    this.iv = setInterval(tick, 50);
  }

  math() {
    const g = this.m.game;
    const t0 = performance.now();
    this.draw(`<div class="mini-q">${esc(g.q)} = ?</div><div class="mini-opts">${g.opts.map((o) => `<button type="button" data-o="${o}">${o}</button>`).join('')}</div>`, 'm-play');
    this.onTap = (e) => {
      const b = e.target.closest('[data-o]');
      if (!b) return;
      const ok = +b.dataset.o === g.ans;
      this.finish({ val: Math.round(performance.now() - t0), ok, why: ok ? '' : 'wrong' });
    };
    this.to = setTimeout(() => this.finish({ val: 0, ok: false, why: 'late' }), 12000);
  }

  colors() {
    const g = this.m.game;
    const t0 = performance.now();
    this.draw(`<div class="mini-sub">Каким цветом написано?</div><div class="mini-q mini-word" style="color:${COLORS[g.ink][1]}">${COLORS[g.word][0].toUpperCase()}</div>
      <div class="mini-opts">${g.opts.map((i) => `<button type="button" data-c="${i}">${COLORS[i][0]}</button>`).join('')}</div>`, 'm-play m-light');
    this.onTap = (e) => {
      const b = e.target.closest('[data-c]');
      if (!b) return;
      const ok = +b.dataset.c === g.ink;
      this.finish({ val: Math.round(performance.now() - t0), ok, why: ok ? '' : 'wrong' });
    };
    this.to = setTimeout(() => this.finish({ val: 0, ok: false, why: 'late' }), 12000);
  }

  stop() {
    const t0 = performance.now();
    this.draw('<div class="mini-sub">останови ровно на 5,00</div><div class="mini-clock">0,00</div><button type="button" class="mini-tap">СТОП</button>', 'm-play');
    const clock = this.el.querySelector('.mini-clock');
    const tick = () => {
      const t = performance.now() - t0;
      if (t > 10000) return this.finish({ val: Math.round(t), ok: true });
      clock.textContent = t < 1000 ? sec(t) : '?,??';
    };
    tick();
    this.iv = setInterval(tick, 30);
    this.onTap = (e) => {
      if (e.target.closest('.mini-tap')) this.finish({ val: Math.round(performance.now() - t0), ok: true });
    };
  }

  done() {
    if (this.stage === 'done') return;
    this.clear();
    this.stage = 'done';
    this.doneAt = Date.now();
    const m = this.m;
    const w = m.win;
    const list = (m.list || []).map((r) => `<li class="${r.me ? 'me' : ''}"><i style="background:${esc(r.color)}"></i><span>${esc(r.name)}</span><b>${esc(r.res)}</b></li>`).join('');
    this.draw(`${this.head()}
      <div class="mini-big">${w ? (w.mine ? 'Победа! 🏆' : esc(w.name)) : 'Никто не справился'}</div>
      <div class="mini-sub">${w ? `${w.mine ? 'вашей команде' : esc(w.team)} +${m.bonus}` : 'очки никому'}</div>
      ${list ? `<ol class="mini-list">${list}</ol>` : ''}
      <div class="mini-sub mini-close">нажми, чтобы закрыть</div>`, w?.mine ? 'm-ok' : 'm-intro');
  }
}
