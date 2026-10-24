// The game screen shared by the host and the players: three layouts, soft themes and the ⚙ popover.
// Pages build a plain "model" of what to show; this module turns it into DOM and reports clicks back.
import { esc, nl2br, fmt, store } from './util.js?v=1792848738154';
import { controlsHTML, bindControls, setHTML } from './controls.js?v=1792848738154';
import { sound } from './sound.js?v=1792848738154';

export const THEMES = [['sand', 'Песок', '#5b8a85'], ['studio', 'Студия', '#3a4a85'], ['night', 'Ночь', '#a99cf0'], ['mint', 'Мята', '#4fae8f'], ['lilac', 'Лаванда', '#8c7cc2']];
export const LAYOUTS = [['a', 'Колонка справа'], ['b', 'Счёт внизу'], ['c', 'Телешоу']];
export const BUZZ = [['round', 'Круглая кнопка'], ['bar', 'Полоса внизу'], ['card', 'Своя команда'], ['tap', 'Тап по вопросу']];

// Look and feel is personal: every device keeps its own choice.
const PREFS_KEY = 'plyukh-ui';
// vol: question audio and video, sfx: the game's own beeps (host only). Both 0–1.
export const prefs = { theme: 'sand', layout: 'a', buzz: 'round', vol: 0.7, sfx: 0.7, ...store.get(PREFS_KEY, {}) };
const savePrefs = () => store.set(PREFS_KEY, prefs);
sound.vol = prefs.sfx;

// Question text shrinks as it gets longer and when it shares the space with a picture.
function textScale(t, media) {
  const n = (t || '').length;
  const vw = n < 40 ? 3.4 : n < 90 ? 2.8 : n < 160 ? 2.2 : 1.7;
  return `${media ? vw * 0.8 : vw}vw`;
}

const teamName = (t) => (t ? `<span style="color:${esc(t.color)}">${esc(t.name)}</span>` : '');
const fill = (s, t, t2) => esc(s || '').replace('{team}', teamName(t)).replace('{team2}', teamName(t2));

/**
 * @param {HTMLElement} parent
 * @param {{ role: 'host'|'player', on: (type: string, data?: object) => void,
 *           mediaNode: (media: any, autoplay: boolean) => Promise<Node|null>,
 *           settings?: () => { html: string, bind: (el: HTMLElement) => void },
 *           links?: () => Array<{ name: string, label: string, cls?: string }> }} opts
 */
export function createScreen(parent, opts) {
  const { role, on } = opts;
  const el = document.createElement('div');
  el.className = `gs role-${role}`;
  el.innerHTML = `
    <div class="box g-title"><span class="g-left"></span><span class="g-name"></span><span class="g-rname"></span><span class="sp"></span><span class="g-tools g-tools-in"></span></div>
    <div class="g-tools g-tools-side"></div>
    <div class="g-main"></div>
    <div class="g-teams"></div>
    <div class="box g-panel"></div>
    <button type="button" class="g-buzzbar" data-buzz hidden></button>
    <div class="box g-pop"></div>
    <canvas class="confetti" hidden></canvas>`;
  parent.append(el);
  const $ = (s) => el.querySelector(s);
  let model = null;
  let popOpen = false;

  // ---------- events ----------
  el.addEventListener('pointerdown', (e) => {
    // Buzzing reacts on press, not on release: every millisecond counts.
    const b = e.target.closest('[data-buzz]');
    if (b) { e.preventDefault(); on('buzz'); return; }
    const card = e.target.closest('.g-team.tappable');
    if (card) { on('buzz'); return; }
    if (e.target.closest('.g-q.tap .q-body') && !e.target.closest('audio, video, iframe')) { on('buzz'); return; }
    const peek = e.target.closest('[data-peek]');
    if (peek) {
      const w = peek.closest('.p-wrap');
      w?.classList.add('peek');
      const up = () => { w?.classList.remove('peek'); window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', up); };
      window.addEventListener('pointerup', up);
      window.addEventListener('pointercancel', up);
    }
  });
  el.addEventListener('click', (e) => {
    const t = e.target;
    const cell = t.closest('[data-pick]');
    if (cell && !cell.disabled) { const [c, q] = cell.dataset.pick.split(',').map(Number); return on('pick', { c, q }); }
    const adj = t.closest('[data-adj]');
    if (adj) return on('adj', { team: adj.dataset.adj, delta: +adj.dataset.d });
    const pm = t.closest('[data-player]');
    if (pm) return on('playerMenu', { pid: pm.dataset.player });
    const tm = t.closest('[data-tmenu]');
    if (tm) return on('teamMenu', { team: tm.dataset.tmenu });
    const choice = t.closest('[data-choice]');
    if (choice) return on('choice', { id: choice.dataset.choice });
    const join = t.closest('[data-join]');
    if (join) return on('join', { team: join.dataset.join });
    const tool = t.closest('[data-tool]');
    if (tool && !tool.disabled) {
      if (tool.dataset.tool === 'gear') { popOpen = !popOpen; return drawPop(); }
      return on('tool', { name: tool.dataset.tool });
    }
    if (t.closest('[data-popclose]')) { popOpen = false; return drawPop(); }
    const pref = t.closest('[data-pref]');
    if (pref) {
      prefs[pref.dataset.pref] = pref.dataset.v;
      savePrefs();
      drawPop();
      if (model) draw();
      return on('prefs');
    }
    const link = t.closest('[data-link]');
    if (link) { popOpen = false; drawPop(); return on('link', { name: link.dataset.link }); }
    const quick = t.closest('[data-quick]');
    if (quick) { const i = quick.closest('form')?.querySelector('input'); if (i) i.value = quick.dataset.quick; return; }
    const img = t.closest('.q-media img');
    if (img) { img.closest('.q-media').classList.toggle('zoom'); return; }
    if (t.closest('.q-media.zoom') && !t.closest('video, audio, iframe')) { t.closest('.q-media').classList.remove('zoom'); return; }
    if (popOpen && !t.closest('.g-pop')) { popOpen = false; drawPop(); }
  });
  // Volume sliders in the ⚙ popover act while being dragged.
  el.addEventListener('input', (e) => {
    const r = e.target.closest('[data-volume]');
    if (!r) return;
    prefs[r.dataset.volume] = +r.value / 100;
    savePrefs();
    sound.vol = prefs.sfx;
    applyVolume();
    const out = r.closest('.g-opt')?.querySelector('.g-vol-v');
    if (out) out.textContent = `${r.value}%`;
  });
  function applyVolume(root = el) {
    for (const m of root.querySelectorAll('audio, video')) m.volume = prefs.vol;
  }
  el.addEventListener('submit', (e) => {
    const f = e.target.closest('form.p-form');
    if (!f) return;
    e.preventDefault();
    const inp = f.querySelector('input, textarea');
    on('form', { key: f.dataset.form, type: f.dataset.type, value: inp ? inp.value : '' });
  });
  bindControls(el, (a, args) => on('act', { a, args }));

  // ---------- drawing ----------
  function draw() {
    const m = model;
    const hasBar = role === 'player' && m.panel?.kind === 'buzz' && prefs.buzz === 'bar';
    el.className = `gs role-${role} th-${prefs.theme} L-${prefs.layout} ${hasBar ? 'has-bar' : ''}`;
    $('.g-name').textContent = m.title || '';
    $('.g-rname').textContent = m.round || '';
    drawTools(m.tools || {});
    drawMain(m.view || { v: 'empty' });
    drawTeams(m.teams || []);
    drawPanel(m.panel, hasBar);
  }

  function drawTools(t) {
    let html;
    if (role === 'host') {
      setHTML($('.g-left'), `<button type="button" class="tb back" data-tool="exit" title="Выйти">←</button>`);
      html = `${t.code ? `<button type="button" class="tb code ${t.locked ? 'locked' : ''}" data-tool="code" title="${t.locked ? 'Комната закрыта: новые игроки не зайдут' : 'Код комнаты и QR'}">${t.locked ? '🔒' : '▦'} ${esc(t.code)}</button>` : ''}
        <button type="button" class="tb hide-ph" data-tool="shared" title="Видят ли игроки этот экран">${t.shared ? '📺 Общий экран' : '🖥 Свой экран'}</button>
        <button type="button" class="tb" data-tool="undo" title="Отменить (Ctrl+Z)" ${t.canUndo ? '' : 'disabled'}>↶</button>
        <button type="button" class="tb hide-ph" data-tool="full" title="Во весь экран (F)">⛶</button>
        <button type="button" class="tb gear ${popOpen ? 'on' : ''}" data-tool="gear" title="Настройки">⚙</button>`;
    } else {
      setHTML($('.g-left'), '');
      html = `${t.name ? `<span class="tb me"><span class="g-dot" style="background:${esc(t.color || '#999')}"></span>${esc(t.name)}</span>` : ''}
        <button type="button" class="tb gear ${popOpen ? 'on' : ''}" data-tool="gear" title="Настройки">⚙</button>`;
    }
    setHTML($('.g-tools-in'), html);
    setHTML($('.g-tools-side'), html);
  }

  function drawMain(v) {
    const main = $('.g-main');
    const key = v.v === 'clue' || v.v === 'finq' ? `${v.v}:${v.key}` : v.v === 'board' ? 'board' : `${v.v}:${v.key || ''}`;
    if (main._key !== key) {
      main._key = key;
      main._html = null;
      if (v.v === 'board') main.innerHTML = `<div class="g-board"></div><div class="g-hint"></div>`;
      else if (v.v === 'parade') main.innerHTML = v.done
        ? '<div class="g-parade done"><p class="g-par-k">Темы игры</p><div class="g-par-all"></div></div>'
        : '<div class="g-parade"><p class="g-par-k">Темы игры</p><div class="g-par-win"><div class="g-par-roll"></div></div></div>';
      else if (v.v === 'clue' || v.v === 'finq') main.innerHTML = `<div class="g-q"><div class="box q-cat"><span class="c"></span><b class="l"></b></div><div class="box q-body"><div class="q-text"></div><div class="q-media"></div></div><div class="q-extra"></div></div>`;
      else main.innerHTML = `<div class="g-banner"></div>`;
    }
    setConfetti(v.v === 'end');
    if (v.v === 'board') return drawBoard(v);
    if (v.v === 'clue' || v.v === 'finq') return drawClue(v);
    if (v.v === 'parade') return drawParade(v);
    setHTML($('.g-banner'), bannerHTML(v));
  }

  function drawBoard(v) {
    const b = $('.g-board');
    b.style.setProperty('--cols', v.cats.length);
    b.style.setProperty('--rows', v.values.length);
    let h = v.cats.map((c) => `<div class="g-cat">${esc(c)}</div>`).join('');
    v.values.forEach((val, qi) => v.cats.forEach((_, ci) => {
      const open = v.open[ci]?.[qi];
      h += open
        ? `<button type="button" class="g-cell ${v.canPick ? 'can' : ''} ${v.mine ? 'mine' : ''}" data-pick="${ci},${qi}" ${v.canPick ? '' : 'disabled'}>${fmt(val)}</button>`
        : '<div class="g-cell used"></div>';
    }));
    setHTML(b, h);
    setHTML($('.g-hint'), v.hint ? esc(v.hint) : '');
  }

  // The themes float up like film credits. The position comes from the clock, not from a CSS
  // animation: a phone that was locked for a moment catches up instead of lagging behind the host.
  // The clock is reset only when the host pauses, resumes or replays (seq), from the elapsed time it sent.
  let paradeRaf = 0;
  function drawParade(v) {
    if (v.done) { setHTML($('.g-par-all'), v.list.map((t) => `<span>${esc(t)}</span>`).join('')); return; }
    const roll = $('.g-par-roll');
    const list = v.list.join('\n');
    if (roll._list !== list) { roll._list = list; roll.innerHTML = v.list.map((t) => `<div class="g-par-item">${esc(t)}</div>`).join(''); }
    if (roll._seq !== v.seq) { roll._seq = v.seq; roll._t0 = performance.now() - v.elapsed; }
    roll._dur = v.dur;
    roll._stop = v.paused ? v.elapsed : null;
    if (paradeRaf) return;
    const step = () => {
      const r = el.querySelector('.g-par-roll');
      if (!r) { paradeRaf = 0; return; }
      const p = Math.min(1, Math.max(0, (r._stop ?? performance.now() - r._t0) / r._dur));
      r.style.top = `${(1 - p) * 100}%`;
      r.style.transform = `translateY(${-p * 100}%)`;
      paradeRaf = requestAnimationFrame(step);
    };
    step();
  }

  function drawClue(v) {
    $('.q-cat .c').textContent = v.cat || '';
    $('.q-cat .l').textContent = v.label || '';
    const body = $('.q-body');
    body.classList.toggle('media', !!v.media && !!v.text);
    body.classList.toggle('only-media', !!v.media && !v.text);
    const q = $('.q-text');
    q.style.setProperty('--qs', textScale(v.text, !!v.media));
    setHTML(q, v.text ? nl2br(v.text) : '');
    $('.g-q').classList.toggle('tap', !!v.tap);
    const mEl = $('.q-media');
    if (mEl._mk !== v.mediaKey) {
      mEl._mk = v.mediaKey;
      mEl.classList.remove('zoom');
      mEl.innerHTML = '';
      if (v.media) opts.mediaNode(v.media, !!v.autoplay).then((n) => { if (n && mEl._mk === v.mediaKey) { mEl.append(n); applyVolume(mEl); } });
    }
    setHTML($('.q-extra'), extraHTML(v));
  }

  function timerHTML(t) {
    return t ? `<div class="timer" data-deadline="${t.deadline}" data-total="${t.total}"><span></span></div>` : '';
  }

  function extraHTML(v) {
    let h = '';
    if (v.timer) h += timerHTML(v.timer);
    if (v.status) h += `<div class="q-status">${fill(v.status.text, v.status.team)}</div>`;
    if (v.chips) h += `<div class="g-chips">${v.chips.map((c) => `<span class="g-chip ${c.ok ? 'ok' : ''}">${c.ok ? '✓' : '…'} ${esc(c.name)}</span>`).join('')}</div>`;
    if (v.answer) {
      const r = v.answer.result;
      h += `<div class="box q-ans">${r ? `<div class="res ${r.cls || ''}">${fill(r.text, r.team)}</div>` : ''}<div class="txt">${nl2br(v.answer.text || '—')}</div></div>`;
    }
    if (v.cards) {
      h += `<div class="g-fin-cards">${v.cards.map((c) => `<div class="box g-fin-card" style="--tc:${esc(c.color)}"><b>${esc(c.name)}</b><div class="a">${c.answer == null ? '…' : `«${esc(c.answer || '—')}»`}</div><div class="w ${c.cls || ''}">${esc(c.note || '')}</div></div>`).join('')}</div>`;
    }
    return h;
  }

  function standingsHTML(list, from = 0) {
    return `<ol class="g-stand">${list.slice(from).map((s) => `<li class="${s.me ? 'me' : ''}"><span class="g-dot" style="background:${esc(s.color)}"></span><span>${esc(s.name)}</span><b class="${s.score < 0 ? 'neg' : ''}">${fmt(s.score)}</b></li>`).join('')}</ol>`;
  }

  function bannerHTML(v) {
    switch (v.v) {
      case 'lobby':
        return `<h2>${esc(v.head || 'Ждём начала игры…')}</h2><p>${esc(v.sub || '')}</p>`;
      case 'dd':
        return `<h2>Вопрос-ставка!</h2><div class="big">${esc(v.cat || '')}</div><p>${fill(v.text, v.team)}</p>`;
      case 'roundEnd':
        return `<h2>${esc(v.head)}</h2>${standingsHTML(v.standings)}`;
      case 'mod':
        return `<div class="g-mod">
          <div class="g-mod-ico">${esc(v.icon)}</div>
          <p class="g-mod-k">${esc(v.head || 'Модернизатор!')}</p>
          <h2>${esc(v.name)}</h2>
          <p class="g-mod-d">${esc(v.desc)}</p>
          ${v.team ? `<p class="g-mod-who">Открыли: ${teamName(v.team)}</p>` : ''}
          ${v.changes?.length ? `<ul class="g-mod-ch">${v.changes.map((x) => `<li><span class="g-dot" style="background:${esc(x.color)}"></span><span class="n">${esc(x.name)}</span><s>${fmt(x.from)}</s><span class="ar">→</span><b class="${x.to < 0 ? 'neg' : ''}">${fmt(x.to)}</b></li>`).join('')}</ul>` : ''}
          ${v.note ? `<p class="g-mod-note">${esc(v.note)}</p>` : ''}
          ${v.wait ? `<p class="g-mod-wait">${fill(v.wait, v.team)}</p>` : ''}
        </div>`;
      case 'mini': {
        const rows = (v.rows || []).map((r) => `<li class="${r.win ? 'win' : ''} ${r.me ? 'me' : ''} ${r.ok ? 'ok' : ''}"><span class="g-dot" style="background:${esc(r.color)}"></span><span class="n">${esc(r.name)}${r.team ? ` <small>${esc(r.team)}</small>` : ''}</span><b>${esc(r.res)}</b></li>`).join('');
        const sub = v.stage === 'intro' ? esc(v.rule) : v.stage === 'play' ? 'Играем на телефонах!' : v.win ? `Победа: ${fill(v.win.text, v.win.team)}` : 'Никто не справился';
        return `<div class="g-mod g-mini">
          <div class="g-mod-ico">${esc(v.icon)}</div>
          <p class="g-mod-k">Мини-игра · победителю +${fmt(v.bonus)}</p>
          <h2>${esc(v.name)}</h2>
          <p class="g-mod-d">${sub}</p>
          ${timerHTML(v.timer)}
          ${rows ? `<ol class="g-mini-list">${rows}</ol>` : ''}
        </div>`;
      }
      case 'finw':
        return `<p>Финал · тема</p><h2>${esc(v.cat || 'Финальный вопрос')}</h2><p>${esc(v.sub || '')}</p>${v.chips ? `<div class="g-chips">${v.chips.map((c) => `<span class="g-chip ${c.ok ? 'ok' : ''}">${c.ok ? '✓' : '…'} ${esc(c.name)}</span>`).join('')}</div>` : ''}`;
      case 'end': {
        const st = v.standings;
        const pods = st.slice(0, 3).map((s, i) => `<div class="g-pod p${i + 1}"><div class="nm">${esc(s.name)}</div><div class="sc">${fmt(s.score)}</div><div class="bar">${i + 1}</div></div>`);
        return `<h2>${st[0] ? `Победа: ${esc(st[0].name)}!` : 'Игра окончена'}</h2><div class="g-podium">${[pods[1], pods[0], pods[2]].filter(Boolean).join('')}</div>${st.length > 3 ? standingsHTML(st, 3) : ''}`;
      }
      default:
        return '';
    }
  }

  function drawTeams(teams) {
    const host = role === 'host';
    setHTML($('.g-teams'), teams.map((t) => `
      <div class="box g-team ${(t.cls || []).join(' ')}" style="--tc:${esc(t.color)}">
        <span class="t-stripe"></span>
        ${t.badge ? `<span class="t-badge">${esc(t.badge)}</span>` : ''}
        <div class="t-main">
          <div class="t-name">${host ? `<button type="button" data-tmenu="${esc(t.id)}" title="Действия с командой">${esc(t.name)}</button>` : esc(t.name)}</div>
          <div class="t-mem">${t.members?.length ? t.members.map((p) => p.id ? `<button type="button" class="t-pl ${p.online === false ? 'off' : ''}" data-player="${esc(p.id)}" title="Перевести или выгнать">${esc(p.name)}</button>` : `<span class="${p.online === false ? 'off' : ''}">${esc(p.name)}</span>`).join(', ') : esc(t.sub || '')}</div>
          ${t.joinable ? `<button type="button" class="btn small g-join" data-join="${esc(t.id)}">${t.mine ? 'Ты здесь' : 'Вступить'}</button>` : ''}
        </div>
        <div class="t-score ${t.score < 0 ? 'neg' : ''}">${fmt(t.score)}</div>
        ${host ? `<div class="t-pm"><button type="button" data-adj="${esc(t.id)}" data-d="${-(t.step || 100)}" title="−${t.step || 100}">−</button><button type="button" data-adj="${esc(t.id)}" data-d="${t.step || 100}" title="+${t.step || 100}">+</button></div>` : ''}
      </div>`).join(''));
  }

  function drawPanel(p, hasBar) {
    const panel = $('.g-panel');
    const bar = $('.g-buzzbar');
    bar.hidden = !hasBar;
    if (!p) { panel._k = null; setHTML(panel, ''); return; }
    if (p.kind === 'host') {
      panel._k = null;
      const ans = p.answer == null ? '' : `<div class="p-wrap ${p.hidden ? 'p-hidden' : ''}"><div class="p-lbl">Правильный ответ</div><div class="p-ans">${nl2br(p.answer || '—')}</div>${p.hidden ? '<div class="p-hidden-note">Скрыт: экран видят игроки</div><button type="button" class="btn ghost" data-peek>👁 Подсмотреть (зажми)</button>' : ''}</div>`;
      setHTML(panel, `${p.lbl ? `<div class="p-lbl">${esc(p.lbl)}</div>` : ''}${p.text ? `<div class="p-text">${fill(p.text, p.team, p.team2)}</div>` : ''}${ans}${p.status ? `<div class="p-status">${fill(p.status, p.statusTeam)}</div>` : ''}${controlsHTML(p.controls || [])}`);
      return;
    }
    if (p.kind === 'buzz') {
      const b = p.buzz;
      if (hasBar) {
        setHTML(panel, '');
        panel._k = null;
        bar.className = `g-buzzbar ${b.cls}`;
        bar.innerHTML = `${esc(b.big)}<small>${esc(b.small || '')}</small>`;
        return;
      }
      if (prefs.buzz === 'round') {
        if (panel._k !== 'round') { panel._k = 'round'; panel._html = null; panel.innerHTML = '<div class="p-buzz"><button type="button" class="g-round" data-buzz></button><div class="st"></div></div>'; }
        const r = panel.querySelector('.g-round');
        r.className = `g-round ${b.cls}`;
        r.textContent = b.big;
        panel.querySelector('.st').textContent = b.small || '';
        return;
      }
      panel._k = null;
      setHTML(panel, `<div class="p-lbl">Как жать</div><div class="p-text">${prefs.buzz === 'card' ? 'Нажимай на <b>карточку своей команды</b> или пробел. Когда можно — она пульсирует.' : 'Нажимай <b>прямо на вопрос</b> или пробел.'}</div><div class="p-status">${esc(b.small || '')}</div>`);
      return;
    }
    if (p.kind === 'form') {
      const f = p.form;
      const k = `form:${f.key}`;
      if (panel._k !== k) {
        panel._k = k;
        panel._html = null;
        const quick = f.type === 'wager' ? `<div class="quick">${[...new Set([f.min, Math.round(f.max / 2), f.max])].map((x) => `<button type="button" class="btn" data-quick="${x}">${x === f.max && f.max > 0 ? 'Ва-банк ' : ''}${fmt(x)}</button>`).join('')}</div>` : '';
        const field = f.type === 'wager'
          ? `<input class="input" type="number" inputmode="numeric" min="${f.min}" max="${f.max}" value="${esc(f.value ?? '')}" placeholder="${f.min}–${f.max}">`
          : `<textarea class="input" rows="2" maxlength="300" placeholder="Ответ команды">${esc(f.value ?? '')}</textarea>`;
        panel.innerHTML = `<form class="p-form" data-form="${esc(f.key)}" data-type="${f.type}"><div class="p-lbl">${esc(f.title)}</div><div class="p-text p-sub"></div>${field}${quick}<button class="btn primary">${esc(f.label)}</button></form>`;
      }
      panel.querySelector('.p-sub').textContent = f.sub || '';
      return;
    }
    if (p.kind === 'choice') {
      panel._k = null;
      setHTML(panel, `${p.lbl ? `<div class="p-lbl">${esc(p.lbl)}</div>` : ''}<div class="p-text">${fill(p.text, p.team)}</div>
        <div class="p-choice">${p.options.map((o) => `<button type="button" class="btn" data-choice="${esc(o.id)}"><span class="g-dot" style="background:${esc(o.color)}"></span><span class="n">${esc(o.name)}</span><b>${fmt(o.score)}</b></button>`).join('')}</div>`);
      return;
    }
    panel._k = null;
    setHTML(panel, p.text ? `${p.lbl ? `<div class="p-lbl">${esc(p.lbl)}</div>` : ''}<div class="p-text">${fill(p.text, p.team)}</div>` : '');
  }

  function drawPop() {
    const pop = $('.g-pop');
    pop.classList.toggle('open', popOpen);
    $('.g-tools-in .gear')?.classList.toggle('on', popOpen);
    $('.g-tools-side .gear')?.classList.toggle('on', popOpen);
    if (!popOpen) { pop.innerHTML = ''; return; }
    const seg = (key, label, list) => `<div class="g-opt"><span>${label}</span><div class="g-seg">${list.map(([v, l, sw]) => `<button type="button" data-pref="${key}" data-v="${v}" class="${prefs[key] === v ? 'on' : ''}">${sw ? `<span class="g-sw" style="background:${sw}"></span>` : ''}${l}</button>`).join('')}</div></div>`;
    const slider = (key, label, note = '') => `<div class="g-opt"><span>${label} · <b class="g-vol-v">${Math.round(prefs[key] * 100)}%</b></span><input type="range" class="g-vol" min="0" max="100" step="5" value="${Math.round(prefs[key] * 100)}" data-volume="${key}" aria-label="${label}">${note ? `<small class="g-vol-note">${note}</small>` : ''}</div>`;
    const extra = opts.settings?.();
    const links = opts.links?.() || [];
    pop.innerHTML = `<h4>Настройки <button type="button" data-popclose title="Закрыть">×</button></h4>
      <div class="sub">Это устройство</div>
      ${slider('vol', '🔊 Громкость вопросов', 'видео и музыка в вопросах; у YouTube — свой ползунок в плеере')}${role === 'host' ? slider('sfx', '🔔 Звуки игры') : ''}
      ${seg('theme', 'Тема', THEMES)}${seg('layout', 'Раскладка', LAYOUTS)}${role === 'player' ? seg('buzz', 'Как жать', BUZZ) : ''}
      ${extra ? `<div class="divider"></div><div class="sub">Игра</div>${extra.html}` : ''}
      ${links.length ? `<div class="divider"></div><div class="g-links">${links.map((l) => `<button type="button" class="btn ${l.cls || ''}" data-link="${esc(l.name)}">${esc(l.label)}</button>`).join('')}</div>` : ''}`;
    extra?.bind(pop);
  }

  // ---------- confetti on the final screen ----------
  let confettiRaf = 0;
  function setConfetti(onOff) {
    const cv = $('.confetti');
    if (!onOff) { cancelAnimationFrame(confettiRaf); confettiRaf = 0; cv.hidden = true; return; }
    if (confettiRaf) return;
    cv.hidden = false;
    const ctx = cv.getContext('2d');
    const colors = ['#d9825b', '#e8c36a', '#4f9a7a', '#5b8def', '#cf6b5f', '#a99cf0'];
    let parts = [];
    const spawn = (n) => { for (let i = 0; i < n; i++) parts.push({ x: Math.random() * cv.width, y: -20 - Math.random() * cv.height * 0.5, vx: (Math.random() - 0.5) * 2, vy: 2 + Math.random() * 3, r: Math.random() * 6.28, vr: (Math.random() - 0.5) * 0.3, s: 6 + Math.random() * 8, c: colors[(Math.random() * colors.length) | 0] }); };
    const resize = () => { cv.width = el.clientWidth; cv.height = el.clientHeight; };
    resize();
    spawn(200);
    let frames = 0;
    const step = () => {
      ctx.clearRect(0, 0, cv.width, cv.height);
      for (const p of parts) {
        p.x += p.vx; p.y += p.vy; p.r += p.vr;
        ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.r); ctx.fillStyle = p.c; ctx.fillRect(-p.s / 2, -p.s / 4, p.s, p.s / 2); ctx.restore();
      }
      parts = parts.filter((p) => p.y < cv.height + 30);
      if (++frames < 240 && frames % 20 === 0) spawn(25);
      if (parts.length) confettiRaf = requestAnimationFrame(step);
      else { confettiRaf = 0; cv.hidden = true; }
    };
    confettiRaf = requestAnimationFrame(step);
  }

  // ---------- timers ----------
  function tick() {
    const now = Date.now();
    for (const t of el.querySelectorAll('.timer')) {
      const left = Math.max(0, +t.dataset.deadline - now);
      const total = +t.dataset.total || 1;
      t.style.setProperty('--p', (left / total).toFixed(3));
      t.firstElementChild.textContent = Math.ceil(left / 1000);
      t.classList.toggle('low', left < 5000);
    }
  }
  const timer = setInterval(tick, 200);

  return {
    el,
    update(m) { model = m; draw(); tick(); if (popOpen && m.refreshPop) drawPop(); },
    closePop() { popOpen = false; drawPop(); },
    refreshPop() { if (popOpen) drawPop(); },
    setProgress(text) { const p = el.querySelector('.pc-pct'); if (p) p.textContent = text; },
    destroy() { clearInterval(timer); cancelAnimationFrame(confettiRaf); cancelAnimationFrame(paradeRaf); el.remove(); },
  };
}

