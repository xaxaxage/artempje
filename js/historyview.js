// One played game, as it happened: who played, every question in order, and a "time machine"
// that steps through the game showing the board, the question and the score at that moment.
import * as db from './db.js?v=1792358422380';
import { esc, nl2br, fmt, signed, plural, confirmDlg } from './util.js?v=1792358422380';
import { getGame, removeGame } from './history.js?v=1792358422380';
import { srcOf } from './media.js?v=1792358422380';
import { MODS } from './mods.js?v=1792358422380';
import { GAMES } from './minigames.js?v=1792358422380';

const MODE_NAMES = { simple: 'простой режим', buzzer: 'с кнопками' };
// Team colours are validated for the light surface; these two need a deeper step on the dark one.
const DARK_STEP = { '#4fae8f': '#3a9a7c', '#e0a43a': '#b88224' };
const isDark = () => matchMedia('(prefers-color-scheme: dark)').matches;
const tcol = (c) => (isDark() && DARK_STEP[c]) || c;
const clock = (t) => new Date(t).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
const day = (t) => new Date(t).toLocaleString('ru-RU', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });

// Turns the raw event log into steps: one per question, plus start, new rounds, final and end.
export function buildSteps(h) {
  const steps = [];
  const zero = Object.fromEntries(h.teams.map((t) => [t.id, 0]));
  let scores = { ...zero };
  let used = {};
  let round = 0;
  let cur = null;
  let fin = null;
  const close = () => { if (cur) { used = { ...used, [cur.key]: true }; cur = null; } };
  for (const e of h.events || []) {
    switch (e.k) {
      case 'start':
        round = e.r || 0;
        steps.push({ kind: 'start', t: e.t, round, used, scores: { ...(e.scores || zero) }, picker: e.picker });
        break;
      case 'round':
        close();
        round = e.r;
        steps.push({ kind: 'round', t: e.t, round, used: {}, scores: { ...scores } });
        used = {};
        break;
      case 'pick':
        close();
        round = e.r;
        cur = { kind: 'clue', t: e.t, round, c: e.c, q: e.q, key: `${e.r}:${e.c}:${e.q}`, value: e.value, dd: e.dd, picker: e.picker, used, outcomes: [], buzzes: [], scores: { ...scores } };
        steps.push(cur);
        break;
      case 'dd': if (cur) { cur.wager = e.wager; cur.ddTeam = e.team; } break;
      case 'buzz': cur?.buzzes.push({ team: e.team, by: e.by }); break;
      case 'right':
      case 'wrong':
        scores = { ...e.scores };
        if (cur) { cur.outcomes.push({ team: e.team, by: e.by, delta: e.delta, ok: e.k === 'right' }); cur.scores = { ...scores }; }
        break;
      case 'none': if (cur) cur.nobody = true; break;
      case 'mod':
        scores = { ...e.scores };
        if (cur) { cur.mod = { kind: e.mod, team: e.team, target: e.target }; cur.scores = { ...scores }; }
        break;
      case 'mini':
        close();
        scores = { ...e.scores };
        steps.push({ kind: 'mini', t: e.t, round, used, game: e.game, team: e.team, by: e.by, delta: e.delta, scores: { ...scores } });
        break;
      case 'adj':
        scores = { ...e.scores };
        if (cur) { cur.outcomes.push({ team: e.team, delta: e.delta, manual: true }); cur.scores = { ...scores }; }
        else steps.push({ kind: 'adj', t: e.t, round, used, team: e.team, delta: e.delta, scores: { ...scores } });
        break;
      case 'final':
        close();
        fin = { kind: 'final', t: e.t, round, used, scores: { ...scores }, wagers: null };
        steps.push(fin);
        break;
      case 'fwagers': if (fin) fin.wagers = e.wagers; break;
      case 'fjudge':
        scores = { ...e.scores };
        steps.push({ kind: 'fjudge', t: e.t, round, used, team: e.team, answer: e.answer, wager: e.wager, ok: e.ok, scores: { ...scores } });
        break;
      case 'end':
        close();
        steps.push({ kind: 'end', t: e.t, round, used, scores: { ...(e.scores || scores) } });
        break;
    }
  }
  return steps;
}

export async function renderHistory(root, id) {
  const h = await getGame(id);
  root.className = 'page-history';
  if (!h) {
    root.innerHTML = `<div class="page center"><h1>Игра не найдена</h1><a class="btn primary" href="#/">На главную</a></div>`;
    return;
  }
  const boardExists = !!(await db.getBoard(h.boardId).catch(() => null));
  const mins = h.startedAt ? Math.max(1, Math.round((h.at - h.startedAt) / 60000)) : 0;
  const steps = h.v === 2 ? buildSteps(h) : [];
  const clueSteps = steps.filter((s) => s.kind === 'clue');
  const meta = [day(h.at), mins ? `${mins} мин` : '', MODE_NAMES[h.mode] || '', h.answer === 'turns' ? 'по очереди' : '', clueSteps.length ? `${clueSteps.length} ${plural(clueSteps.length, 'вопрос', 'вопроса', 'вопросов')}` : ''].filter(Boolean).join(' · ');

  root.innerHTML = `
    <div class="page hv">
      <a class="back-link" href="#/">← Мои игры</a>
      <header class="hv-head">
        <div>
          <h1 class="page-title">${esc(h.board)}</h1>
          <p class="muted">${esc(meta)}${h.v === 2 && !h.finished ? ' · <span class="hv-tag">не доиграна</span>' : ''}</p>
        </div>
        <div class="hv-actions">
          ${boardExists ? `<a class="btn primary" href="#/play/${esc(h.boardId)}">▶ Сыграть снова</a>` : ''}
          <button class="btn ghost danger-text" data-a="del">Удалить из истории</button>
        </div>
      </header>
      <section class="hv-teams"></section>
      ${h.v === 2 && steps.length ? `
      <section class="card hv-tm">
        <div class="hv-tm-top">
          <h2>Машина времени</h2>
          <div class="hv-ctrl">
            <button class="btn small" data-a="first" title="В начало">⏮</button>
            <button class="btn small" data-a="prev" title="Назад (←)">←</button>
            <button class="btn small primary" data-a="play">▶ Проиграть</button>
            <button class="btn small" data-a="next" title="Вперёд (→)">→</button>
            <button class="btn small" data-a="last" title="В конец">⏭</button>
          </div>
        </div>
        <input class="hv-range" type="range" min="0" max="${steps.length - 1}" value="0" aria-label="Момент игры">
        <div class="hv-pos muted small"></div>
        <div class="hv-tm-body"><div class="hv-board"></div><div class="hv-event"></div></div>
        <div class="hv-score"></div>
      </section>
      <section class="card hv-chart">
        <h2>Как менялся счёт</h2>
        <div class="hv-legend"></div>
        <div class="hv-plot"></div>
        <div class="hv-tip" hidden></div>
      </section>
      <section class="card hv-list"><h2>Все вопросы по порядку</h2><ol class="hv-steps"></ol></section>`
      : `<section class="card"><p class="muted">Подробная запись (вопросы, ответы, машина времени) есть для игр, сыгранных после обновления сайта. Для этой игры сохранился только итог.</p></section>`}
    </div>`;

  const $ = (s) => root.querySelector(s);
  const team = (tid) => h.teams.find((t) => t.id === tid);
  const tname = (tid) => team(tid)?.name || '—';
  const dot = (tid) => `<i class="hv-dot" style="background:${esc(tcol(team(tid)?.color || '#999'))}"></i>`;
  const snapRound = (r) => h.snapshot?.rounds?.[r];
  const clueOf = (s) => snapRound(s.round)?.cats?.[s.c]?.clues?.[s.q];
  const catOf = (s) => snapRound(s.round)?.cats?.[s.c]?.name || '';

  // ---------- teams with final scores ----------
  const finalTeams = h.v === 2 ? [...h.teams].sort((a, b) => b.score - a.score) : (h.players || []).map((p, i) => ({ id: `p${i}`, name: p.name, score: p.score, members: [], color: '#999' }));
  $('.hv-teams').innerHTML = finalTeams.map((t, i) => `
    <div class="hv-team ${i === 0 ? 'win' : ''}" style="--tc:${esc(tcol(t.color))}">
      <span class="hv-place">${i === 0 ? '🏆' : i + 1}</span>
      <div class="hv-team-main"><b>${esc(t.name)}</b>${t.members?.length && h.teamMode !== 'solo' ? `<span class="muted small">${esc(t.members.join(', '))}</span>` : ''}</div>
      <b class="hv-team-score ${t.score < 0 ? 'neg' : ''}">${fmt(t.score)}</b>
    </div>`).join('');

  root.querySelector('[data-a=del]').addEventListener('click', async () => {
    if (!(await confirmDlg('Удалить эту игру из истории?', 'Удалить', true))) return;
    await removeGame(h.id);
    location.hash = '#/';
  });
  if (h.v !== 2 || !steps.length) return () => {};

  // ---------- the time machine ----------
  let at = 0;
  let playing = null;

  function boardHTML(s) {
    if (['final', 'fjudge', 'end'].includes(s.kind) && h.snapshot?.final) {
      return `<div class="hv-final-box"><span class="muted small">Финал · тема</span><b>${esc(h.snapshot.final.cat || 'Финальный вопрос')}</b></div>`;
    }
    const r = snapRound(s.round);
    if (!r) return '';
    let cells = r.cats.map((c) => `<div class="hv-cat">${esc(c.name)}</div>`).join('');
    r.values.forEach((v, qi) => r.cats.forEach((cat, ci) => {
      const key = `${s.round}:${ci}:${qi}`;
      const has = (cat.clues[qi]?.q || '').trim() || cat.clues[qi]?.m || cat.clues[qi]?.mod;
      const cls = !has ? 'empty' : key === s.key ? 'now' : s.used[key] ? 'used' : '';
      cells += `<div class="hv-cell ${cls}">${has && !s.used[key] ? fmt(v) : ''}</div>`;
    }));
    return `<div class="muted small">${esc(r.name)}</div><div class="hv-grid" style="--cols:${r.cats.length}">${cells}</div>`;
  }

  function outcomeHTML(o) {
    if (o.manual) return `<li>${dot(o.team)}<span>${esc(tname(o.team))}: ведущий поправил очки</span><b>${signed(o.delta)}</b></li>`;
    return `<li>${dot(o.team)}<span>${o.ok ? '✓ Верно' : '✗ Неверно'} — ${esc(tname(o.team))}${o.by ? ` (${esc(o.by)})` : ''}</span><b>${signed(o.delta)}</b></li>`;
  }

  function eventHTML(s) {
    switch (s.kind) {
      case 'start': {
        return `<h3>Игра началась</h3><p class="muted">${esc(clock(s.t))}</p>
          <ul class="hv-out">${h.teams.map((t) => `<li>${dot(t.id)}<span>${esc(t.name)}${t.members?.length && h.teamMode !== 'solo' ? ` — ${esc(t.members.join(', '))}` : ''}</span></li>`).join('')}</ul>
          ${s.picker ? `<p>Первыми выбирали ${dot(s.picker)}${esc(tname(s.picker))}</p>` : ''}`;
      }
      case 'mini': {
        const g = GAMES[s.game] || { icon: '🎮', name: 'Мини-игра' };
        return `<h3>${g.icon} Мини-игра «${esc(g.name)}»</h3><p class="muted">${esc(clock(s.t))}</p>
          <ul class="hv-out">${s.team ? `<li>${dot(s.team)}<span>Победа: ${esc(s.by)} — ${esc(tname(s.team))}</span><b>${signed(s.delta)}</b></li>` : '<li class="muted"><span>Никто не справился</span></li>'}</ul>`;
      }
      case 'round': return `<h3>${esc(snapRound(s.round)?.name || 'Новый раунд')}</h3><p class="muted">Начался новый раунд — стоимость вопросов выше.</p>`;
      case 'adj': return `<h3>Ведущий поправил очки</h3><ul class="hv-out">${outcomeHTML({ team: s.team, delta: s.delta, manual: true })}</ul>`;
      case 'final': {
        const f = h.snapshot?.final;
        return `<h3>Финал${f?.cat ? `: ${esc(f.cat)}` : ''}</h3>
          ${f ? `<p class="hv-q">${nl2br(f.q)}</p><div class="hv-media" data-m="${esc(JSON.stringify(f.m || null))}"></div><p class="hv-a">Ответ: <b>${nl2br(f.a || '—')}</b></p>` : ''}
          ${s.wagers ? `<p class="muted small">Ставки</p><ul class="hv-out">${Object.entries(s.wagers).map(([tid, w]) => `<li>${dot(tid)}<span>${esc(tname(tid))}</span><b>${fmt(w)}</b></li>`).join('')}</ul>` : ''}`;
      }
      case 'fjudge':
        return `<h3>Финал: ответ команды ${esc(tname(s.team))}</h3>
          <p class="hv-q">${s.answer == null ? '<span class="muted">Ответили вслух</span>' : `«${esc(s.answer || '—')}»`}</p>
          <ul class="hv-out"><li>${dot(s.team)}<span>${s.ok ? '✓ Верно' : '✗ Неверно'}, ставка ${fmt(s.wager || 0)}</span><b>${signed(s.ok ? s.wager || 0 : -(s.wager || 0))}</b></li></ul>`;
      case 'end': {
        const best = [...h.teams].sort((a, b) => (s.scores[b.id] ?? 0) - (s.scores[a.id] ?? 0))[0];
        return `<h3>Конец игры</h3><p>Победили ${best ? `${dot(best.id)}<b>${esc(best.name)}</b>` : '—'}!</p><p class="muted">${esc(clock(s.t))}</p>`;
      }
      case 'clue': {
        const cl = clueOf(s) || {};
        const head = s.dd ? `Вопрос-ставка${s.wager != null ? ` · ставка ${fmt(s.wager)}` : ''}` : fmt(s.value);
        const M = s.mod && MODS[s.mod.kind];
        const mod = M ? `<p class="hv-mod">${M.icon} ${s.mod.kind === 'cat' ? esc(M.name) : `Модернизатор «${esc(M.name)}»`} — открыли ${dot(s.mod.team)}${esc(tname(s.mod.team))}${s.mod.target ? `, ${s.mod.kind === 'cat' ? 'отдали' : 'выбрали'} ${dot(s.mod.target)}${esc(tname(s.mod.target))}` : ''}</p>` : '';
        const outs = s.outcomes.length ? s.outcomes.map(outcomeHTML).join('') : '';
        const nobody = !s.outcomes.some((o) => o.ok) && (s.nobody || s.outcomes.some((o) => !o.manual)) ? '<li class="muted"><span>Правильно никто не ответил</span></li>' : '';
        return `<h3>${esc(catOf(s))} <span class="hv-val">${esc(head)}</span></h3>
          <p class="muted small">${esc(clock(s.t))}${s.picker ? ` · выбирали ${esc(tname(s.picker))}` : ''}</p>
          ${mod}
          ${cl.q ? `<p class="hv-q">${nl2br(cl.q)}</p>` : ''}
          <div class="hv-media" data-m="${esc(JSON.stringify(cl.m || null))}"></div>
          ${cl.q || cl.m ? `<p class="hv-a">Ответ: <b>${nl2br(cl.a || '—')}</b></p>` : ''}
          <ul class="hv-out">${outs}${nobody}</ul>`;
      }
    }
    return '';
  }

  async function fillMedia(el) {
    const box = el.querySelector('.hv-media');
    if (!box) return;
    let m = null;
    try { m = JSON.parse(box.dataset.m); } catch {}
    if (!m) return box.remove();
    if (m.k === 'youtube') {
      box.innerHTML = `<a href="https://www.youtube.com/watch?v=${encodeURIComponent(m.vid)}" target="_blank" rel="noopener"><img src="https://i.ytimg.com/vi/${encodeURIComponent(m.vid)}/hqdefault.jpg" alt="Видео на YouTube"></a>`;
      return;
    }
    const src = m.id ? await srcOf({ kind: 'file', id: m.id }).catch(() => null) : m.url;
    if (!src) { box.innerHTML = `<span class="muted small">${m.k === 'image' ? 'Картинка' : m.k === 'audio' ? 'Аудио' : 'Видео'} — файл больше не хранится</span>`; return; }
    if (m.k === 'image') box.innerHTML = `<img src="${esc(src)}" alt="">`;
    else if (m.k === 'audio') box.innerHTML = `<audio controls src="${esc(src)}"></audio>`;
    else box.innerHTML = `<video controls playsinline src="${esc(src)}"></video>`;
  }

  function scoreHTML(s, prev) {
    const vals = h.teams.map((t) => s.scores[t.id] ?? 0);
    const max = Math.max(1, ...vals.map(Math.abs));
    return h.teams.map((t) => {
      const v = s.scores[t.id] ?? 0;
      const d = v - (prev?.scores[t.id] ?? 0);
      const w = Math.round((Math.abs(v) / max) * 100);
      return `<div class="hv-srow">
        <span class="hv-sname">${dot(t.id)}${esc(t.name)}</span>
        <span class="hv-sbar"><i style="width:${w}%;background:${esc(tcol(t.color))};${v < 0 ? 'opacity:.45' : ''}"></i></span>
        <b class="${v < 0 ? 'neg' : ''}">${fmt(v)}</b>
        <span class="hv-sd">${d ? `${d > 0 ? '▲' : '▼'} ${signed(d)}` : ''}</span>
      </div>`;
    }).join('');
  }

  function stepLabel(s, i) {
    if (s.kind === 'clue') return `Вопрос ${clueSteps.indexOf(s) + 1} из ${clueSteps.length}: ${catOf(s)} · ${s.dd ? 'ставка' : fmt(s.value)}`;
    return { start: 'Начало игры', round: 'Новый раунд', adj: 'Поправка очков', mini: 'Мини-игра', final: 'Финал', fjudge: `Финал: ${tname(s.team)}`, end: 'Конец игры' }[s.kind] || `Шаг ${i + 1}`;
  }

  function show(i) {
    at = Math.max(0, Math.min(steps.length - 1, i));
    const s = steps[at];
    $('.hv-range').value = at;
    $('.hv-pos').textContent = `${stepLabel(s, at)} · ${clock(s.t)}${h.startedAt ? ` · ${Math.max(0, Math.round((s.t - h.startedAt) / 60000))} мин от начала` : ''}`;
    $('.hv-board').innerHTML = boardHTML(s);
    const ev = $('.hv-event');
    ev.innerHTML = eventHTML(s);
    fillMedia(ev);
    $('.hv-score').innerHTML = scoreHTML(s, steps[at - 1]);
    root.querySelectorAll('.hv-steps li').forEach((li) => li.classList.toggle('on', +li.dataset.i === at));
    drawChart();
  }

  function play() {
    if (playing) return stop();
    if (at >= steps.length - 1) show(0);
    $('[data-a=play]').textContent = '⏸ Пауза';
    playing = setInterval(() => {
      if (at >= steps.length - 1) return stop();
      show(at + 1);
    }, 1800);
  }
  function stop() {
    clearInterval(playing);
    playing = null;
    const b = $('[data-a=play]');
    if (b) b.textContent = '▶ Проиграть';
  }

  root.addEventListener('click', (e) => {
    const a = e.target.closest('[data-a]')?.dataset.a;
    if (a === 'prev') { stop(); show(at - 1); }
    if (a === 'next') { stop(); show(at + 1); }
    if (a === 'first') { stop(); show(0); }
    if (a === 'last') { stop(); show(steps.length - 1); }
    if (a === 'play') play();
    const li = e.target.closest('.hv-steps li[data-i]');
    if (li) { stop(); show(+li.dataset.i); $('.hv-tm').scrollIntoView({ behavior: 'smooth', block: 'start' }); }
  });
  $('.hv-range').addEventListener('input', (e) => { stop(); show(+e.target.value); });
  const onKey = (e) => {
    if (e.target.closest('input:not([type=range]), textarea, select')) return;
    if (e.key === 'ArrowLeft') { stop(); show(at - 1); e.preventDefault(); }
    if (e.key === 'ArrowRight') { stop(); show(at + 1); e.preventDefault(); }
  };
  document.addEventListener('keydown', onKey);

  // ---------- list of all questions ----------
  $('.hv-steps').innerHTML = steps.map((s, i) => {
    if (s.kind === 'clue') {
      const cl = clueOf(s) || {};
      const right = s.outcomes.find((o) => o.ok);
      const wrong = s.outcomes.filter((o) => o.ok === false);
      return `<li data-i="${i}">
        <span class="hv-li-head">${s.mod && MODS[s.mod.kind] ? `${MODS[s.mod.kind].icon} ` : ''}${esc(catOf(s))} · ${s.dd ? `ставка ${fmt(s.wager || 0)}` : fmt(s.value)}</span>
        <span class="hv-li-q">${esc((cl.q || (cl.m ? '(картинка / звук)' : s.mod ? `модернизатор «${MODS[s.mod.kind]?.name || ''}»` : '')).slice(0, 140))}</span>
        <span class="hv-li-a">→ ${esc(cl.a || '—')}</span>
        <span class="hv-li-res">${right ? `${dot(right.team)}${esc(tname(right.team))} ${signed(right.delta)}` : 'никто'}${wrong.length ? ` · мимо: ${wrong.map((o) => esc(tname(o.team))).join(', ')}` : ''}</span>
      </li>`;
    }
    if (s.kind === 'mini') return `<li data-i="${i}"><span class="hv-li-head">${GAMES[s.game]?.icon || '🎮'} Мини-игра «${esc(GAMES[s.game]?.name || '')}»</span><span class="hv-li-res">${s.team ? `${dot(s.team)}${esc(s.by)} — ${esc(tname(s.team))} ${signed(s.delta)}` : 'никто'}</span></li>`;
    if (s.kind === 'fjudge') return `<li data-i="${i}"><span class="hv-li-head">Финал · ${esc(tname(s.team))}</span><span class="hv-li-q">${s.answer == null ? 'ответ вслух' : `«${esc(s.answer || '—')}»`}</span><span class="hv-li-res">${s.ok ? '✓' : '✗'} ${signed(s.ok ? s.wager || 0 : -(s.wager || 0))}</span></li>`;
    if (['round', 'final', 'end', 'start'].includes(s.kind)) return `<li data-i="${i}" class="hv-li-sep"><span>${esc(stepLabel(s, i))}</span></li>`;
    return '';
  }).join('');

  // ---------- score chart: one line per team, current step marked ----------
  const plot = $('.hv-plot');
  const tip = $('.hv-tip');
  $('.hv-legend').innerHTML = h.teams.map((t) => `<span><i style="background:${esc(tcol(t.color))}"></i>${esc(t.name)}</span>`).join('');

  function niceTicks(lo, hi) {
    const span = Math.max(1, hi - lo);
    const raw = span / 4;
    const mag = 10 ** Math.floor(Math.log10(raw));
    const stepv = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((m) => span / m <= 5) || mag * 10;
    const out = [];
    for (let v = Math.floor(lo / stepv) * stepv; v <= hi + 1e-9; v += stepv) out.push(Math.round(v));
    return out;
  }

  function drawChart() {
    const W = Math.max(280, plot.clientWidth);
    const H = 240;
    const labelW = h.teams.length <= 4 ? 96 : 12;
    const pad = { l: 46, r: labelW, t: 12, b: 26 };
    const all = steps.flatMap((s) => h.teams.map((t) => s.scores[t.id] ?? 0));
    const ticks = niceTicks(Math.min(0, ...all), Math.max(0, ...all));
    const lo = ticks[0];
    const hi = ticks[ticks.length - 1];
    const n = steps.length;
    const x = (i) => pad.l + (n === 1 ? 0 : (i / (n - 1)) * (W - pad.l - pad.r));
    const y = (v) => pad.t + (1 - (v - lo) / (hi - lo || 1)) * (H - pad.t - pad.b);
    let svg = `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="Счёт команд по ходу игры">`;
    for (const tv of ticks) {
      svg += `<line class="${tv === 0 ? 'zero' : 'grid'}" x1="${pad.l}" x2="${W - pad.r}" y1="${y(tv)}" y2="${y(tv)}"/><text class="tick" x="${pad.l - 8}" y="${y(tv) + 4}" text-anchor="end">${fmt(tv)}</text>`;
    }
    svg += `<line class="now" x1="${x(at)}" x2="${x(at)}" y1="${pad.t}" y2="${H - pad.b}"/>`;
    // Direct labels at the line ends, nudged apart so they never overlap.
    const ends = h.teams.map((t) => ({ t, y: y(steps[n - 1].scores[t.id] ?? 0) })).sort((a, b) => a.y - b.y);
    for (let i = 1; i < ends.length; i++) if (ends[i].y - ends[i - 1].y < 15) ends[i].y = ends[i - 1].y + 15;
    for (const t of h.teams) {
      const pts = steps.map((s, i) => `${x(i).toFixed(1)},${y(s.scores[t.id] ?? 0).toFixed(1)}`).join(' ');
      svg += `<polyline class="ln" points="${pts}" style="stroke:${esc(tcol(t.color))}"/>`;
      svg += `<circle class="dotm" cx="${x(at)}" cy="${y(steps[at].scores[t.id] ?? 0)}" r="4.5" style="fill:${esc(tcol(t.color))}"/>`;
    }
    if (labelW > 20) for (const e of ends) svg += `<line x1="${W - pad.r + 6}" x2="${W - pad.r + 16}" y1="${e.y}" y2="${e.y}" style="stroke:${esc(tcol(e.t.color))};stroke-width:2"/><text class="lbl" x="${W - pad.r + 20}" y="${e.y + 4}">${esc(e.t.name.length > 10 ? `${e.t.name.slice(0, 9)}…` : e.t.name)}</text>`;
    svg += `<text class="tick" x="${pad.l}" y="${H - 6}">начало</text><text class="tick" x="${W - pad.r}" y="${H - 6}" text-anchor="end">конец</text>`;
    svg += `<rect class="hit" x="${pad.l}" y="${pad.t}" width="${W - pad.l - pad.r}" height="${H - pad.t - pad.b}"/></svg>`;
    plot.innerHTML = svg;
    const hit = plot.querySelector('.hit');
    const nearest = (ev) => {
      const r = plot.querySelector('svg').getBoundingClientRect();
      const px = ((ev.clientX - r.left) / r.width) * W;
      return Math.max(0, Math.min(n - 1, Math.round(((px - pad.l) / (W - pad.l - pad.r)) * (n - 1))));
    };
    hit.addEventListener('pointermove', (ev) => {
      const i = nearest(ev);
      const s = steps[i];
      // Values lead, names follow; team names go in as text, never as markup.
      tip.replaceChildren();
      const head = document.createElement('div');
      head.className = 'hv-tip-head';
      head.textContent = stepLabel(s, i);
      tip.append(head);
      for (const t of [...h.teams].sort((a, b) => (s.scores[b.id] ?? 0) - (s.scores[a.id] ?? 0))) {
        const row = document.createElement('div');
        row.className = 'hv-tip-row';
        const key = document.createElement('i');
        key.style.background = tcol(t.color);
        const val = document.createElement('b');
        val.textContent = fmt(s.scores[t.id] ?? 0);
        const nm = document.createElement('span');
        nm.textContent = t.name;
        row.append(key, val, nm);
        tip.append(row);
      }
      tip.hidden = false;
      const pr = plot.getBoundingClientRect();
      const left = ev.clientX - pr.left + 14;
      tip.style.left = `${Math.min(left, pr.width - tip.offsetWidth - 4)}px`;
      tip.style.top = `${ev.clientY - pr.top + 10}px`;
    });
    hit.addEventListener('pointerleave', () => { tip.hidden = true; });
    hit.addEventListener('click', (ev) => { stop(); show(nearest(ev)); });
  }

  const ro = new ResizeObserver(() => drawChart());
  ro.observe(plot);
  show(0);

  return () => {
    stop();
    ro.disconnect();
    document.removeEventListener('keydown', onKey);
  };
}
