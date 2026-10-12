// The host screen: setup, lobby, board, clues, rounds, final, results.
// All game logic lives here; phones only send intents and render the views we push.
import * as db from './db.js';
import { $, esc, nl2br, uid, fmt, signed, clamp, store, toast, dialog, dialogOpen, confirmDlg, promptDlg, copyText, qrSvg, plural, LOGO_SVG } from './util.js';
import { filled, finalReady, roundPlayable } from './board.js';
import { mediaEl } from './media.js';
import { play as sfx, sound, unlock } from './sound.js';
import { Host, errText, hostChannelName } from './net.js';
import { controlsHTML, bindControls, setHTML } from './controls.js';
import { saveGame } from './history.js';
import { MediaSender, describe } from './mediasync.js';

const SETTINGS_KEY = 'plyukh-settings';
const SAVE_KEY = 'plyukh-game';
const DEFAULTS = { dd: true, timer: 15, sound: true, penalty: false, finalTimer: 30, phoneMedia: true, phoneText: true, hostAnswer: false };
const BUZZ_WINDOW_MS = 220;

export async function startPlay(root, boardId) {
  const board = await db.getBoard(boardId);
  if (!board) {
    root.innerHTML = `<div class="page center"><h1>Игра не найдена</h1><a class="btn primary" href="#/">На главную</a></div>`;
    return;
  }

  const settings = { ...DEFAULTS, ...store.get(SETTINGS_KEY, {}) };
  sound.on = settings.sound;
  let S = null; // game state (serialisable)
  let net = null;
  let sender = null; // streams clue media to phones
  const conns = new Map(); // player id -> connection
  const hostConns = new Set(); // phone remotes of the host
  const locks = {}; // player id -> timestamp until which buzzing is blocked
  let buzzCands = [];
  let buzzTimer = null;
  let hist = [];
  let mounted = null;
  let destroyed = false;

  const R = () => board.rounds[S.round];
  const player = (id) => S.players.find((p) => p.id === id);
  const keyOf = (r, c, q) => `${r}:${c}:${q}`;
  const clueAt = (c) => R().categories[c.c].clues[c.q];
  const worth = () => (S.clue.dd ? S.clue.wager || 0 : S.clue.value);
  const firstRound = () => board.rounds.findIndex(roundPlayable);
  const standings = () => [...S.players].sort((a, b) => b.score - a.score);
  const saveSettings = () => store.set(SETTINGS_KEY, settings);
  const joinUrl = () => new URL(`join/?r=${S.code}`, location.href.split('#')[0]).href;
  const remoteUrl = () => new URL(`join/?r=${S.code}&k=${S.hostKey}`, location.href.split('#')[0]).href;
  const usesPhones = () => S.mode === 'buzzer';

  function freshState(mode = 'buzzer') {
    return {
      v: 1, phase: 'setup', mode, players: [], kicked: [], round: 0, used: {}, dds: {},
      picker: null, clue: null, fin: null, code: null, hostKey: uid().slice(0, 10), openSeq: 0,
    };
  }

  // ---------- persistence & undo ----------
  function persist() {
    if (S.phase === 'setup') return;
    store.set(SAVE_KEY, { boardId: board.id, s: S, t: Date.now() });
  }
  function snapshot() {
    hist.push(JSON.stringify(S));
    if (hist.length > 60) hist.shift();
  }
  function undo() {
    const prev = hist.pop();
    if (!prev) return toast('Нечего отменять');
    const online = Object.fromEntries(S.players.map((p) => [p.id, p.online]));
    S = JSON.parse(prev);
    for (const p of S.players) p.online = !!online[p.id];
    clearBuzz();
    toast('Отменено');
  }

  // ---------- scoring helpers ----------
  function addScore(pid, delta) {
    const p = player(pid);
    if (p) p.score += delta;
  }
  function ddRange(p) {
    const top = Math.max(...R().values);
    return { min: 0, max: Math.max(p?.score || 0, top) };
  }
  function eligible() {
    const c = S.clue;
    return S.players.filter((p) => !c.tried.includes(p.id) && (p.online || !p.phone));
  }
  function roundDone() {
    return R().categories.every((cat, ci) => cat.clues.every((cl, qi) => !filled(cl) || S.used[keyOf(S.round, ci, qi)]));
  }
  function nextRoundIndex() {
    for (let i = S.round + 1; i < board.rounds.length; i++) if (roundPlayable(board.rounds[i])) return i;
    return -1;
  }
  function placeDDs() {
    S.dds = {};
    if (!settings.dd) return;
    const r = R();
    const want = S.round === firstRound() ? 1 : 2;
    const cands = [];
    r.categories.forEach((cat, ci) => cat.clues.forEach((cl, qi) => {
      if (!filled(cl)) return;
      const w = qi === 0 && r.values.length > 2 ? 0.15 : 1 + qi * 0.6;
      cands.push({ ci, qi, w });
    }));
    const usedCats = new Set();
    for (let n = 0; n < want && cands.length; n++) {
      const pool = cands.filter((x) => !usedCats.has(x.ci));
      const list = pool.length ? pool : cands;
      let roll = Math.random() * list.reduce((s, x) => s + x.w, 0);
      const pick = list.find((x) => (roll -= x.w) <= 0) || list[list.length - 1];
      S.dds[keyOf(S.round, pick.ci, pick.qi)] = true;
      usedCats.add(pick.ci);
      cands.splice(cands.indexOf(pick), 1);
    }
  }

  function clearBuzz() {
    clearTimeout(buzzTimer);
    buzzTimer = null;
    buzzCands = [];
  }
  function startOpen() {
    const c = S.clue;
    clearBuzz();
    c.stage = 'open';
    c.buzzed = null;
    c.openId = ++S.openSeq;
    c.deadline = settings.timer ? Date.now() + settings.timer * 1000 : 0;
  }
  function setBuzzed(pid) {
    const c = S.clue;
    clearBuzz();
    c.stage = 'buzzed';
    c.buzzed = pid;
    c.ansDeadline = settings.timer ? Date.now() + Math.max(5, settings.timer) * 1000 : 0;
    c.ansBeeped = false;
    sfx('buzz');
  }
  function finishClue() {
    S.used[S.clue.key] = true;
    S.clue = null;
    clearBuzz();
    S.phase = roundDone() ? 'roundEnd' : 'board';
  }
  function beginGame() {
    S.round = Math.max(0, firstRound());
    S.used = {};
    S.clue = null;
    S.fin = null;
    for (const p of S.players) p.score = 0;
    S.picker = S.players.length ? S.players[Math.floor(Math.random() * S.players.length)].id : null;
    S.gameId = uid('g');
    S.startedAt = Date.now();
    S.endedAt = 0;
    placeDDs();
    S.phase = 'board';
  }

  function recordHistory() {
    saveGame({
      id: S.gameId || (S.gameId = uid('g')),
      at: S.endedAt || (S.endedAt = Date.now()),
      startedAt: S.startedAt || 0,
      board: board.title,
      boardId: board.id,
      mode: S.mode,
      players: standings().map((p) => ({ name: p.name, score: p.score })),
    });
  }

  // ---------- actions (from the TV screen, keyboard or the host's phone) ----------
  const A = {
    pick({ c, q }) {
      if (S.phase !== 'board') return;
      const key = keyOf(S.round, c, q);
      const cl = R().categories[c]?.clues[q];
      if (!filled(cl) || S.used[key]) return;
      const dd = !!S.dds[key] && settings.dd;
      S.clue = { c, q, key, value: R().values[q], dd, stage: 'reading', tried: [], buzzed: null, result: null, openId: 0, deadline: 0 };
      if (dd) {
        Object.assign(S.clue, { stage: 'ddIntro', ddPlayer: player(S.picker) ? S.picker : S.players[0]?.id || null, wager: null });
        sfx('dd');
      }
      S.phase = 'clue';
    },
    ddPlayer({ pid }) {
      if (S.clue?.stage === 'ddIntro' && player(pid)) S.clue.ddPlayer = pid;
    },
    ddWager({ amount }) {
      const c = S.clue;
      if (c?.stage !== 'ddIntro') return;
      const p = player(c.ddPlayer);
      if (!p) return toast('Сначала выбери, кто отвечает');
      const { min, max } = ddRange(p);
      c.wager = clamp(Math.round(+amount || 0), min, max);
      c.stage = 'reading';
    },
    open() {
      const c = S.clue;
      if (!usesPhones() || c?.stage !== 'reading' || c.dd) return;
      startOpen();
      sfx('open');
    },
    correct({ pid } = {}) {
      const c = S.clue;
      if (!c || !['reading', 'open', 'buzzed'].includes(c.stage)) return;
      pid = pid ?? (c.dd ? c.ddPlayer : c.buzzed);
      if (!player(pid) || c.tried.includes(pid)) return;
      snapshot();
      const v = worth();
      addScore(pid, v);
      c.result = { pid, delta: v };
      c.stage = 'answer';
      c.buzzed = null;
      S.picker = pid;
      clearBuzz();
      sfx('correct');
    },
    wrong({ pid } = {}) {
      const c = S.clue;
      if (!c || !['reading', 'open', 'buzzed'].includes(c.stage)) return;
      pid = pid ?? (c.dd ? c.ddPlayer : c.buzzed);
      if (!player(pid) || c.tried.includes(pid)) return;
      snapshot();
      const v = worth();
      addScore(pid, -v);
      c.tried.push(pid);
      sfx('wrong');
      if (c.dd) { c.result = { pid, delta: -v }; c.stage = 'answer'; return; }
      if (usesPhones()) {
        c.buzzed = null;
        if (eligible().length) startOpen();
        else c.stage = 'answer';
      } else if (S.players.every((p) => c.tried.includes(p.id))) {
        c.stage = 'answer';
      }
    },
    reveal() {
      const c = S.clue;
      if (!c || ['answer', 'ddIntro'].includes(c.stage)) return;
      c.stage = 'answer';
      c.buzzed = null;
      clearBuzz();
    },
    manualBuzz({ pid }) {
      if (S.clue?.stage === 'open' && eligible().some((p) => p.id === pid)) setBuzzed(pid);
    },
    cont() {
      if (S.clue?.stage === 'answer') finishClue();
    },
    back() {
      const c = S.clue;
      if (!c) return;
      if (c.tried.length || c.result || c.stage === 'answer') finishClue();
      else { S.clue = null; S.phase = 'board'; clearBuzz(); }
    },
    adj({ pid, delta }) {
      if (!player(pid)) return;
      snapshot();
      addScore(pid, Math.round(+delta || 0));
    },
    setScore({ pid, value }) {
      const p = player(pid);
      if (!p) return;
      snapshot();
      p.score = Math.round(+value || 0);
    },
    setPicker({ pid }) {
      if (player(pid)) S.picker = pid;
    },
    endRound() {
      if (!['board', 'clue'].includes(S.phase)) return;
      snapshot();
      S.clue = null;
      clearBuzz();
      S.phase = 'roundEnd';
    },
    nextRound() {
      if (S.phase !== 'roundEnd') return;
      snapshot();
      const nx = nextRoundIndex();
      if (nx >= 0) {
        S.round = nx;
        placeDDs();
        S.phase = 'board';
      } else if (finalReady(board) && S.players.length) {
        S.phase = 'final';
        S.fin = { stage: 'wager', wagers: {}, answers: {}, shown: {}, judged: {}, deadline: 0, showAnswer: false, timeUp: false };
      } else {
        S.phase = 'end';
        sfx('win');
      }
    },
    finWager({ pid, amount }) {
      const f = S.fin;
      const p = player(pid);
      if (S.phase !== 'final' || f.stage !== 'wager' || !p) return;
      f.wagers[pid] = clamp(Math.round(+amount || 0), 0, Math.max(0, p.score));
    },
    finClue() {
      if (S.phase !== 'final' || S.fin.stage !== 'wager') return;
      snapshot();
      for (const p of S.players) S.fin.wagers[p.id] ??= 0;
      S.fin.stage = 'clue';
      S.fin.deadline = settings.finalTimer ? Date.now() + settings.finalTimer * 1000 : 0;
      S.fin.timeUp = false;
    },
    finAnswer({ pid, text }) {
      if (S.phase !== 'final' || S.fin.stage !== 'clue' || !player(pid)) return;
      S.fin.answers[pid] = String(text || '').slice(0, 300);
    },
    finReveal() {
      if (S.phase !== 'final' || S.fin.stage !== 'clue') return;
      snapshot();
      S.fin.stage = 'reveal';
    },
    finShow({ pid }) {
      if (S.fin?.stage === 'reveal') S.fin.shown[pid] = true;
    },
    finJudge({ pid, ok }) {
      const f = S.fin;
      if (f?.stage !== 'reveal' || !player(pid) || f.judged[pid] != null) return;
      snapshot();
      f.shown[pid] = true;
      f.judged[pid] = !!ok;
      const w = f.wagers[pid] || 0;
      addScore(pid, ok ? w : -w);
      sfx(ok ? 'correct' : 'wrong');
    },
    finCorrect() {
      if (S.fin?.stage === 'reveal') S.fin.showAnswer = true;
    },
    finEnd() {
      if (S.phase !== 'final') return;
      snapshot();
      S.phase = 'end';
      sfx('win');
    },
    replay() {
      if (S.phase !== 'end') return;
      hist = [];
      beginGame();
    },
    undo,
  };

  function act(name, args = {}) {
    if (!S || !A[name]) return;
    A[name](args);
    commit();
  }

  // ---------- networking ----------
  function onData(conn, d) {
    if (d.t === 'hello') return hello(conn, d);
    const pid = conn._pid;
    switch (d.t) {
      case 'buzz': return onBuzz(pid, d);
      case 'early': return onEarly(pid);
      case 'wager':
        if (S.clue?.stage === 'ddIntro' && S.clue.ddPlayer === pid) act('ddWager', { amount: d.amount });
        return;
      case 'fwager': return act('finWager', { pid, amount: d.amount });
      case 'fanswer': return act('finAnswer', { pid, text: d.text });
      case 'act':
        if (conn._role === 'host' && A[d.a]) act(d.a, d.args || {});
        return;
    }
  }

  function hello(conn, d) {
    if (d.role === 'host') {
      if (d.key !== S.hostKey) {
        net.send(conn, { t: 'denied' });
        setTimeout(() => conn.close(), 400);
        return;
      }
      conn._role = 'host';
      hostConns.add(conn);
      net.send(conn, hostView());
      toast('Пульт ведущего подключён');
      return;
    }
    if (S.kicked.includes(d.pid)) {
      net.send(conn, { t: 'kicked' });
      setTimeout(() => conn.close(), 400);
      return;
    }
    const name = String(d.name || 'Игрок').trim().slice(0, 20) || 'Игрок';
    let p = player(d.pid);
    if (!p) {
      p = { id: d.pid || uid('p'), name, score: 0, phone: true, online: true };
      S.players.push(p);
      if (!player(S.picker) && !['setup', 'lobby'].includes(S.phase)) S.picker = p.id;
      sfx('join');
      if (S.phase !== 'lobby') toast(`${p.name} присоединяется`);
    } else {
      p.online = true;
      p.name = name;
      p.phone = true;
    }
    const old = conns.get(p.id);
    if (old && old !== conn) { old._replaced = true; try { old.close(); } catch {} }
    conn._pid = p.id;
    conns.set(p.id, conn);
    if (Array.isArray(d.have)) sender?.have(conn, d.have);
    net.send(conn, { t: 'welcome', pid: p.id });
    commit();
  }

  function onClose(conn) {
    if (conn._role === 'host') { hostConns.delete(conn); return; }
    if (conn._replaced || !conn._pid || conns.get(conn._pid) !== conn) return;
    conns.delete(conn._pid);
    const p = player(conn._pid);
    if (p) p.online = false;
    commit();
  }

  function onBuzz(pid, { oid, rt }) {
    const c = S.clue;
    if (!c || c.stage !== 'open' || oid !== c.openId || !player(pid)) return;
    if (c.tried.includes(pid) || (locks[pid] || 0) > Date.now()) return;
    if (buzzCands.some((b) => b.pid === pid)) return;
    // Phones report their reaction time, so a slower connection doesn't lose a fair race.
    buzzCands.push({ pid, rt: clamp(+rt || 0, 0, 60000) });
    if (!buzzTimer) {
      buzzTimer = setTimeout(() => {
        buzzTimer = null;
        const best = [...buzzCands].sort((a, b) => a.rt - b.rt)[0];
        buzzCands = [];
        if (best && S.clue?.stage === 'open' && S.clue.openId === oid) {
          setBuzzed(best.pid);
          commit();
        }
      }, BUZZ_WINDOW_MS);
    }
  }

  function onEarly(pid) {
    if (!settings.penalty || S.clue?.stage !== 'reading' || S.clue.dd) return;
    locks[pid] = Date.now() + 1000;
    sendTo(pid);
  }

  function kick(pid) {
    const conn = conns.get(pid);
    if (conn) { net.send(conn, { t: 'kicked' }); setTimeout(() => { try { conn.close(); } catch {} }, 300); conns.delete(pid); }
    if (!S.kicked.includes(pid)) S.kicked.push(pid);
    S.players = S.players.filter((p) => p.id !== pid);
    if (S.picker === pid) S.picker = S.players[0]?.id || null;
    commit();
  }

  function playerView(pid) {
    const p = player(pid);
    const v = {
      t: 'state', phase: S.phase, title: board.title, mode: S.mode,
      you: p ? { id: p.id, name: p.name, score: p.score } : null,
      picker: player(S.picker)?.name || null, pickerMe: S.picker === pid,
    };
    const c = S.clue;
    if (S.phase === 'clue' && c) {
      v.clue = {
        cat: R().categories[c.c].name, value: c.value, dd: c.dd, stage: c.stage, openId: c.openId,
        remainMs: c.stage === 'open' && c.deadline ? c.deadline - Date.now() : 0,
        buzzedName: player(c.buzzed)?.name || null, buzzedMe: c.buzzed === pid,
        triedMe: c.tried.includes(pid), lockedMs: Math.max(0, (locks[pid] || 0) - Date.now()),
        result: c.result ? { name: player(c.result.pid)?.name || '', delta: c.result.delta, me: c.result.pid === pid } : null,
        ddMe: c.dd && c.ddPlayer === pid, ddName: c.dd ? player(c.ddPlayer)?.name || null : null, wager: c.wager,
        wagerReq: c.stage === 'ddIntro' && c.ddPlayer === pid && p ? ddRange(p) : null,
      };
      if (c.stage !== 'ddIntro') {
        const cl = clueAt(c);
        const ans = c.stage === 'answer';
        v.clue.show = phoneShow(ans && cl.aMedia ? cl.aMedia : cl.media, cl.q, ans ? cl.a : '');
      }
    }
    if (S.phase === 'final' && S.fin) {
      const f = S.fin;
      const fc = board.final;
      v.fin = {
        stage: f.stage, cat: fc.category,
        max: Math.max(0, p?.score || 0), wager: f.wagers[pid] ?? null, answer: f.answers[pid] ?? null,
        remainMs: f.stage === 'clue' && f.deadline ? f.deadline - Date.now() : 0,
        judged: f.judged[pid] ?? null,
      };
      if (f.stage !== 'wager') v.fin.show = phoneShow(f.showAnswer && fc.aMedia ? fc.aMedia : fc.media, fc.q, f.showAnswer ? fc.a : '');
    }
    if (['roundEnd', 'end'].includes(S.phase)) v.standings = standings().map((x) => ({ name: x.name, score: x.score, me: x.id === pid }));
    return v;
  }

  function hostView() {
    const r = R();
    const c = S.clue;
    const cl = c ? clueAt(c) : null;
    return {
      t: 'hstate', phase: S.phase, title: board.title, mode: S.mode, code: S.code,
      round: r ? {
        name: r.name, cats: r.categories.map((x) => x.name), values: r.values,
        grid: r.categories.map((cat, ci) => cat.clues.map((x, qi) => ({ f: filled(x), u: !!S.used[keyOf(S.round, ci, qi)], d: !!S.dds[keyOf(S.round, ci, qi)] }))),
      } : null,
      clue: c ? { cat: r.categories[c.c].name, value: worth() || c.value, q: cl.q, a: cl.a, stage: c.stage, dd: c.dd, status: statusText() } : null,
      fin: S.phase === 'final' ? { cat: board.final.category, q: board.final.q, a: board.final.a, stage: S.fin.stage, status: statusText() } : null,
      players: S.players.map((p) => ({ id: p.id, name: p.name, score: p.score, online: p.online, phone: p.phone, picker: S.picker === p.id })),
      controls: controls(),
      canUndo: hist.length > 0,
    };
  }

  // What phones show of the current clue; the toggles in settings decide how much.
  function phoneShow(ref, q, a) {
    return {
      media: settings.phoneMedia ? describe(ref) : null,
      text: settings.phoneText ? String(q || '').slice(0, 2000) : '',
      answer: settings.phoneText ? String(a || '').slice(0, 500) : '',
    };
  }

  // The media phones show right now (it gets sent first).
  function phoneRef() {
    const c = S.clue;
    if (S.phase === 'clue' && c && c.stage !== 'ddIntro') {
      const cl = clueAt(c);
      return c.stage === 'answer' && cl.aMedia ? cl.aMedia : cl.media;
    }
    if (S.phase === 'final' && S.fin && S.fin.stage !== 'wager') {
      const fc = board.final;
      return S.fin.showAnswer && fc.aMedia ? fc.aMedia : fc.media;
    }
    return null;
  }

  // Media of the clues still ahead, so phones have them before the clue is opened.
  function upcomingRefs() {
    const out = [];
    const add = (i) => board.rounds[i]?.categories.forEach((cat, ci) => cat.clues.forEach((cl, qi) => {
      if (filled(cl) && !S.used[keyOf(i, ci, qi)]) out.push(cl.media, cl.aMedia);
    }));
    if (['setup', 'lobby'].includes(S.phase)) add(firstRound());
    else if (['board', 'clue', 'roundEnd'].includes(S.phase)) add(S.round);
    if (S.phase === 'roundEnd') add(nextRoundIndex());
    if (finalReady(board) && S.phase !== 'end') out.push(board.final.media, board.final.aMedia);
    return out.filter(Boolean);
  }

  function syncMedia(conn) {
    if (!sender || !settings.phoneMedia) return;
    const cur = phoneRef();
    if (cur) sender.want(conn, cur, true);
    for (const ref of upcomingRefs()) sender.want(conn, ref);
  }

  function sendTo(pid) {
    const conn = conns.get(pid);
    if (conn) net.send(conn, playerView(pid));
  }
  let bcQueued = false;
  function broadcast() {
    if (bcQueued) return;
    bcQueued = true;
    queueMicrotask(() => {
      bcQueued = false;
      if (destroyed) return;
      if (chan && hostWinOpen()) chan.postMessage(hostView());
      if (!net) return;
      for (const pid of conns.keys()) sendTo(pid);
      for (const conn of conns.values()) syncMedia(conn);
      if (hostConns.size) { const hv = hostView(); for (const c of hostConns) net.send(c, hv); }
    });
  }

  // ---------- host window on this computer ----------
  // Shows the answers in a separate browser window: share only the game window in Discord
  // and the players never see them.
  let chan = null;
  let hostWinSeen = 0;
  let hostWinShown = false;
  const hostWinOpen = () => Date.now() - hostWinSeen < 5000;
  const hostWinUrl = () => new URL(`join/?k=${S.hostKey}&local=1`, location.href.split('#')[0]).href;

  function syncChannel() {
    if (!S || !('BroadcastChannel' in window)) return;
    const name = hostChannelName(S.hostKey);
    if (chan?.name === name) return;
    chan?.close();
    chan = new BroadcastChannel(name);
    chan.onmessage = (e) => {
      const d = e.data;
      if (!d || typeof d !== 'object' || destroyed) return;
      hostWinSeen = Date.now();
      if (d.t === 'hello' || d.t === 'ping') chan.postMessage(hostView());
      else if (d.t === 'act' && A[d.a]) act(d.a, d.args || {});
      if (!hostWinShown) { hostWinShown = true; render(); }
    };
  }

  function openHostWindow() {
    syncChannel();
    const url = hostWinUrl();
    const w = window.open(url, hostChannelName(S.hostKey), 'popup=yes,width=460,height=860');
    if (!w) {
      dialog({
        title: 'Окно ведущего',
        html: `<p>Браузер не дал открыть окно. Разреши всплывающие окна для этого сайта или открой ссылку сам в <b>отдельном окне</b> (не во вкладке):</p><input class="input" value="${esc(url)}" readonly>`,
        buttons: [{ label: 'Скопировать', value: () => { copyText(url); } }, { label: 'Закрыть', value: true, cls: 'primary' }],
      });
      return;
    }
    w.focus();
    toast('В Discord показывай только окно с игрой, а не весь экран');
  }

  function commit() {
    if (destroyed) return;
    if (S.phase === 'end') recordHistory();
    syncChannel();
    persist();
    render();
    broadcast();
  }

  // ---------- controls & texts shared with the phone remote ----------
  function statusText() {
    const c = S.clue;
    if (S.phase === 'final') {
      const f = S.fin;
      if (f.stage === 'wager') return `Ставки: ${Object.keys(f.wagers).length} из ${S.players.length}`;
      if (f.stage === 'clue') return `Ответы: ${Object.keys(f.answers).length} из ${S.players.length}`;
      return 'Проверяем ответы';
    }
    if (!c) return '';
    const bn = player(c.buzzed)?.name;
    switch (c.stage) {
      case 'ddIntro': return `Вопрос-ставка! Отвечает ${player(c.ddPlayer)?.name || '…'}`;
      case 'reading': return c.dd ? `${player(c.ddPlayer)?.name}: ставка ${fmt(c.wager)}` : usesPhones() ? 'Кнопки закрыты' : 'Кто ответит?';
      case 'open': return 'Кнопки открыты — жмите!';
      case 'buzzed': return `${bn} отвечает`;
      case 'answer': return c.result ? `${player(c.result.pid)?.name}: ${signed(c.result.delta)}` : 'Никто не ответил';
    }
    return '';
  }

  function controls() {
    const c = S.clue;
    if (S.phase === 'clue' && c) {
      const v = worth();
      switch (c.stage) {
        case 'ddIntro': {
          const p = player(c.ddPlayer);
          const rows = [{ title: 'Кто отвечает?', items: S.players.map((x) => ({ label: x.name, act: 'ddPlayer', args: { pid: x.id }, cls: 'chip' + (x.id === c.ddPlayer ? ' sel' : '') })) }];
          if (p) {
            const { min, max } = ddRange(p);
            rows.push({
              title: p.phone && p.online ? `Ставка ${p.name} (${fmt(min)}–${fmt(max)}) — ждём с телефона или введи сам` : `Ставка ${p.name} (${fmt(min)}–${fmt(max)})`,
              items: [{ type: 'wager', act: 'ddWager', min, max, value: Math.min(max, c.value), label: 'Принять ставку' }],
            });
          }
          return rows;
        }
        case 'reading':
          if (c.dd) return [{ items: [{ label: `Верно +${fmt(v)}`, act: 'correct', cls: 'green big' }, { label: `Неверно −${fmt(v)}`, act: 'wrong', cls: 'red big' }] }];
          if (usesPhones()) return [
            { items: [{ label: 'Открыть кнопки', act: 'open', cls: 'yellow big', key: 'Пробел' }] },
            { items: [{ label: 'Никто не знает — показать ответ', act: 'reveal', cls: 'ghost', key: 'N' }] },
          ];
          return [
            ...S.players.map((p) => ({
              title: p.name, inline: true,
              items: [
                { label: `✓ +${fmt(v)}`, act: 'correct', args: { pid: p.id }, cls: 'green', disabled: c.tried.includes(p.id) },
                { label: `✗ −${fmt(v)}`, act: 'wrong', args: { pid: p.id }, cls: 'red', disabled: c.tried.includes(p.id) },
              ],
            })),
            { items: [{ label: 'Показать ответ', act: 'reveal', cls: 'ghost', key: 'N' }] },
          ];
        case 'open': {
          const el = eligible();
          const rows = [];
          if (el.some((p) => !p.phone)) rows.push({ title: 'Кто поднял руку?', items: el.map((p) => ({ label: p.name, act: 'manualBuzz', args: { pid: p.id }, cls: 'chip' })) });
          rows.push({ items: [{ label: 'Никто не знает — показать ответ', act: 'reveal', cls: 'ghost', key: 'N' }] });
          return rows;
        }
        case 'buzzed':
          return [
            { items: [{ label: `Верно +${fmt(v)}`, act: 'correct', cls: 'green big' }, { label: `Неверно −${fmt(v)}`, act: 'wrong', cls: 'red big' }] },
            { items: [{ label: 'Никто не знает', act: 'reveal', cls: 'ghost', key: 'N' }] },
          ];
        case 'answer':
          return [{ items: [{ label: 'Продолжить', act: 'cont', cls: 'primary big', key: 'Пробел' }] }];
      }
    }
    if (S.phase === 'roundEnd') {
      const nx = nextRoundIndex();
      const label = nx >= 0 ? `Дальше: ${board.rounds[nx].name}` : finalReady(board) && S.players.length ? 'Финальный вопрос' : 'Итоги';
      return [{ items: [{ label, act: 'nextRound', cls: 'primary big', key: 'Пробел' }] }];
    }
    if (S.phase === 'final') {
      const f = S.fin;
      if (f.stage === 'wager') {
        const rows = S.players.filter((p) => !p.phone || !p.online || !usesPhones()).map((p) => ({
          title: `${p.name}${f.wagers[p.id] != null ? ` — ставка ${fmt(f.wagers[p.id])}` : ''}`, inline: true,
          items: [{ type: 'wager', act: 'finWager', args: { pid: p.id }, min: 0, max: Math.max(0, p.score), value: f.wagers[p.id] ?? '', label: 'OK' }],
        }));
        rows.push({ items: [{ label: 'Показать вопрос', act: 'finClue', cls: 'primary big' }] });
        return rows;
      }
      if (f.stage === 'clue') return [{ items: [{ label: 'Смотреть ответы', act: 'finReveal', cls: 'primary big' }] }];
      if (f.stage === 'reveal') {
        const rows = [...S.players].sort((a, b) => a.score - b.score).map((p) => {
          const w = f.wagers[p.id] || 0;
          const ans = f.answers[p.id];
          const typed = usesPhones() && p.phone;
          let title = p.name;
          let items;
          if (typed && !f.shown[p.id]) items = [{ label: 'Показать ответ', act: 'finShow', args: { pid: p.id } }];
          else {
            if (typed) title += `: «${ans || '—'}»`;
            if (f.judged[p.id] == null) items = [{ label: '✓ Верно', act: 'finJudge', args: { pid: p.id, ok: true }, cls: 'green' }, { label: '✗ Неверно', act: 'finJudge', args: { pid: p.id, ok: false }, cls: 'red' }];
            else items = [{ type: 'note', text: `ставка ${fmt(w)} → ${signed(f.judged[p.id] ? w : -w)}` }];
          }
          return { title, inline: true, items };
        });
        rows.push({ items: [
          ...(f.showAnswer ? [] : [{ label: 'Правильный ответ', act: 'finCorrect' }]),
          { label: 'Итоги игры', act: 'finEnd', cls: 'primary big' },
        ] });
        return rows;
      }
    }
    if (S.phase === 'end') return [{ items: [{ label: 'Сыграть ещё раз', act: 'replay', cls: 'primary big' }] }];
    return [];
  }

  // ---------- rendering ----------
  function render() {
    if (destroyed) return;
    if (S.phase === 'setup') return renderSetup();
    if (S.phase === 'lobby') return renderLobby();
    renderGame();
  }

  function renderSetup() {
    mounted = 'setup';
    root.className = 'page-play-setup';
    root.innerHTML = `
      <div class="page center narrow">
        <a class="back-link" href="#/">← Мои игры</a>
        <h1 class="page-title">${esc(board.title)}</h1>
        <p class="muted">Как будем играть?</p>
        <div class="modes">
          <button class="mode-card" data-mode="simple">
            <b>Простой</b><span class="mode-sub">Один экран, ведущий — ты</span>
            <span class="muted">Выводишь доску на телевизор, читаешь вопросы, сам отмечаешь, кто ответил.</span>
          </button>
          <button class="mode-card hot" data-mode="buzzer">
            <b>С кнопками</b><span class="mode-sub">Игроки жмут на своих телефонах</span>
            <span class="muted">Каждый заходит по коду или QR и пытается нажать первым. Хаос приветствуется.</span>
          </button>
        </div>
        <div class="settings-card">${settingsHTML()}</div>
        <p class="muted small">Очки — просто очки. Никто никому ничего не платит.</p>
      </div>`;
    bindSettings(root);
    root.querySelectorAll('[data-mode]').forEach((b) => b.addEventListener('click', () => chooseMode(b.dataset.mode)));
  }

  function settingsHTML() {
    const opt = (v, cur, label) => `<option value="${v}" ${+cur === v ? 'selected' : ''}>${label}</option>`;
    return `
      <label class="set-row"><span>Вопросы-ставки <small class="muted">(случайные клетки, где можно поставить свои очки)</small></span><input type="checkbox" data-set="dd" ${settings.dd ? 'checked' : ''}></label>
      <label class="set-row"><span>Таймер на ответ</span><select class="input small" data-set="timer">${[0, 10, 15, 20, 30, 45].map((v) => opt(v, settings.timer, v ? `${v} сек` : 'выкл')).join('')}</select></label>
      <label class="set-row"><span>Таймер в финале</span><select class="input small" data-set="finalTimer">${[0, 30, 45, 60, 90].map((v) => opt(v, settings.finalTimer, v ? `${v} сек` : 'выкл')).join('')}</select></label>
      <label class="set-row"><span>Звуки</span><input type="checkbox" data-set="sound" ${settings.sound ? 'checked' : ''}></label>
      <label class="set-row"><span>Штраф за фальстарт <small class="muted">(нажал раньше времени — кнопка блокируется на 1 сек)</small></span><input type="checkbox" data-set="penalty" ${settings.penalty ? 'checked' : ''}></label>
      <label class="set-row"><span>Картинки, видео и аудио на телефонах игроков <small class="muted">(файлы заранее загружаются на телефоны)</small></span><input type="checkbox" data-set="phoneMedia" ${settings.phoneMedia ? 'checked' : ''}></label>
      <label class="set-row"><span>Текст вопроса и ответ на телефонах игроков</span><input type="checkbox" data-set="phoneText" ${settings.phoneText ? 'checked' : ''}></label>
      <label class="set-row"><span>Показывать ответ прямо на игровом экране <small class="muted">(только если экран видишь ты один. Для телевизора и Discord открой «👁 Окно ведущего» — ответы будут там)</small></span><input type="checkbox" data-set="hostAnswer" ${settings.hostAnswer ? 'checked' : ''}></label>`;
  }
  function bindSettings(el) {
    el.querySelectorAll('[data-set]').forEach((i) => i.addEventListener('change', () => {
      const k = i.dataset.set;
      settings[k] = i.type === 'checkbox' ? i.checked : +i.value;
      sound.on = settings.sound;
      saveSettings();
      if (S && S.phase !== 'setup') commit();
    }));
  }

  async function chooseMode(mode) {
    unlock();
    S.mode = mode;
    if (mode === 'buzzer') {
      const box = $('.modes', root);
      box.innerHTML = `<div class="connecting"><div class="spinner"></div>Создаём комнату…</div>`;
      try {
        await startNet();
      } catch (e) {
        box.innerHTML = `<div class="err-card"><b>Не получилось создать комнату</b><p>${esc(errText(e))}</p>
          <button class="btn" data-retry>Попробовать снова</button> <button class="btn ghost" data-simple>Играть в простом режиме</button></div>`;
        box.querySelector('[data-retry]').onclick = () => chooseMode('buzzer');
        box.querySelector('[data-simple]').onclick = () => chooseMode('simple');
        return;
      }
    }
    S.phase = 'lobby';
    commit();
  }

  async function startNet(code) {
    net = new Host({ onData, onClose });
    sender = new MediaSender((c, m) => net.send(c, m));
    S.code = await net.start(code);
    if (code && S.code !== code) toast(`Новый код комнаты: ${S.code}. Игрокам нужно зайти заново`, 'warn');
  }

  function renderLobby() {
    if (mounted !== 'lobby') {
      mounted = 'lobby';
      root.className = 'page-lobby';
      const phones = usesPhones();
      root.innerHTML = `
        <div class="page center narrow">
          <a class="back-link" href="#/">← Мои игры</a>
          <h1 class="page-title">${esc(board.title)}</h1>
          <p class="muted">${phones ? 'Собираем игроков' : 'Кто играет?'}</p>
          ${phones ? `
            <p class="join-hint">Наведи камеру на QR-код или открой <b>${esc(new URL('join/', location.href.split('#')[0]).host + new URL('join/', location.href.split('#')[0]).pathname)}</b> и введи код</p>
            <div class="room-code">${esc(S.code)}</div>
            <div class="qr-big">${qrSvg(joinUrl())}</div>
            <button class="link-btn" data-copy="join">Скопировать ссылку для входа</button>
            <div class="remote-card">
              <div><b>Пульт ведущего на телефоне</b><p class="muted small">Видишь правильные ответы и управляешь игрой со своего телефона. QR пульта откроется отдельно — чтобы игроки его не увидели.</p>
              <button class="btn small" data-remote>Показать QR пульта</button> <button class="link-btn" data-copy="remote">Скопировать ссылку</button></div>
            </div>` : ''}
          <div class="lobby-players"></div>
          <form class="add-player">
            <input class="input" maxlength="20" placeholder="${phones ? 'Игрок без телефона' : 'Имя игрока'}">
            <button class="btn">Добавить</button>
          </form>
          <button class="btn primary big wide" data-start></button>
        </div>`;
      root.querySelectorAll('[data-copy]').forEach((b) => b.addEventListener('click', () => copyText(b.dataset.copy === 'join' ? joinUrl() : remoteUrl())));
      $('[data-remote]', root)?.addEventListener('click', showRemoteQR);
      $('.add-player', root).addEventListener('submit', (e) => {
        e.preventDefault();
        const i = $('.add-player input', root);
        const name = i.value.trim().slice(0, 20);
        if (!name) return;
        S.players.push({ id: uid('p'), name, score: 0, phone: false, online: false });
        i.value = '';
        commit();
        i.focus();
      });
      $('[data-start]', root).addEventListener('click', () => {
        unlock();
        if (!S.players.length) return toast(usesPhones() ? 'Ждём хотя бы одного игрока' : 'Добавь хотя бы одного игрока');
        if (firstRound() < 0) return toast('В этой игре ещё нет вопросов — заполни доску в редакторе');
        beginGame();
        commit();
      });
      $('.lobby-players', root).addEventListener('click', (e) => {
        const k = e.target.closest('[data-kick]');
        if (k) kick(k.dataset.kick);
      });
    }
    const list = $('.lobby-players', root);
    setHTML(list, S.players.length
      ? S.players.map((p) => `<div class="lp"><span class="dot ${p.phone ? (p.online ? 'on' : 'off') : 'none'}"></span><span class="lp-name">${esc(p.name)}</span>${p.phone ? '' : '<span class="muted small">без телефона</span>'}<button class="icon-btn" data-kick="${esc(p.id)}" title="Убрать">×</button></div>`).join('')
      : `<div class="lp empty muted">${usesPhones() ? 'Пока никого… ждём игроков' : 'Добавь игроков ниже'}</div>`);
    $('[data-start]', root).textContent = `Начать игру (${S.players.length} ${plural(S.players.length, 'игрок', 'игрока', 'игроков')})`;
  }

  function mountGame() {
    mounted = 'game';
    root.className = 'page-game';
    root.innerHTML = `
      <div class="play">
        <header class="topbar">
          <button class="icon-btn" data-ui="exit" title="Выйти">←</button>
          <span class="logo small">${LOGO_SVG}<span>Плюх</span></span>
          <span class="tb-title"></span>
          <span class="tb-spacer"></span>
          <button class="btn small ghost" data-ui="undo" title="Отменить (Ctrl+Z)">↶ Отменить</button>
          <button class="btn small ghost" data-ui="full" title="Во весь экран (F)">⛶</button>
          <button class="btn small" data-ui="hostwin" title="Отдельное окно с правильными ответами. В Discord показывай только окно с игрой">👁 Окно ведущего</button>
          <button class="btn small" data-ui="menu">☰ Меню</button>
        </header>
        <main class="board-wrap"><div class="board"></div></main>
        <footer class="scorebar"><div class="sb-qr"></div><div class="scores"></div></footer>
        <div class="overlay" hidden></div>
        <canvas class="confetti" hidden></canvas>
      </div>`;
    const play = $('.play', root);
    play.addEventListener('click', (e) => {
      const cell = e.target.closest('[data-pick]');
      if (cell) { const [c, q] = cell.dataset.pick.split(',').map(Number); return act('pick', { c, q }); }
      const ui = e.target.closest('[data-ui]');
      if (ui) return uiAction(ui.dataset.ui, ui.dataset);
      const media = e.target.closest('.ov-media img');
      if (media) media.classList.toggle('zoom');
    });
    bindControls($('.overlay', root), (a, args) => act(a, args));
  }

  function renderGame() {
    if (mounted !== 'game') mountGame();
    const r = R();
    $('.tb-title', root).innerHTML = `${esc(board.title)} <span class="muted">· ${esc(S.phase === 'final' ? 'Финал' : r.name)}</span>`;
    $('[data-ui=undo]', root).disabled = !hist.length;
    renderBoard();
    renderScores();
    renderOverlay();
  }

  function renderBoard() {
    const r = R();
    const el = $('.board', root);
    el.style.setProperty('--cols', r.categories.length);
    el.style.setProperty('--rows', r.values.length);
    const html = r.categories.map((c) => `<div class="cat"><span>${esc(c.name)}</span></div>`).join('') +
      r.values.map((v, qi) => r.categories.map((cat, ci) => {
        const used = S.used[keyOf(S.round, ci, qi)] || !filled(cat.clues[qi]);
        return `<button class="cell ${used ? 'used' : ''}" data-pick="${ci},${qi}" ${used ? 'disabled' : ''}>${used ? '' : fmt(v)}</button>`;
      }).join('')).join('');
    setHTML(el, html);
  }

  function renderScores() {
    const c = S.clue;
    const step = Math.min(...R().values.filter((v) => v > 0), 100) || 100;
    setHTML($('.scores', root), S.players.map((p) => {
      const cls = [
        S.picker === p.id ? 'picker' : '',
        p.phone && !p.online ? 'offline' : '',
        c?.buzzed === p.id || (c?.dd && c.ddPlayer === p.id && c.stage !== 'ddIntro') ? 'active' : '',
        c?.tried.includes(p.id) ? 'tried' : '',
      ].join(' ');
      return `<div class="chip-player ${cls}">
        ${S.picker === p.id ? '<span class="badge">выбирает</span>' : ''}
        <button class="pm" data-ui="adj" data-pid="${esc(p.id)}" data-d="${-step}" title="−${step}">−</button>
        <button class="pn" data-ui="player" data-pid="${esc(p.id)}">${p.phone ? `<span class="dot ${p.online ? 'on' : 'off'}"></span>` : ''}${esc(p.name)}</button>
        <span class="ps ${p.score < 0 ? 'neg' : ''}">${fmt(p.score)}</span>
        <button class="pm" data-ui="adj" data-pid="${esc(p.id)}" data-d="${step}" title="+${step}">+</button>
      </div>`;
    }).join(''));
    const qr = $('.sb-qr', root);
    if (usesPhones()) setHTML(qr, `<button class="sb-qr-btn" data-ui="qr" title="Показать QR-код">${qrSvg(joinUrl())}<span>${esc(S.code)}</span></button>`);
    else setHTML(qr, '');
  }

  function textSize(t, hasMedia) {
    const n = (t || '').length;
    const base = n < 50 ? 6 : n < 110 ? 5 : n < 200 ? 4 : 3.2;
    return hasMedia ? base * 0.62 : base;
  }

  function setMedia(el, ref, key) {
    if (el._mkey === key) return;
    el._mkey = key;
    el.innerHTML = '';
    el.classList.toggle('has', !!ref);
    if (!ref) return;
    mediaEl(ref, { autoplay: true }).then((node) => { if (el._mkey === key) el.append(node); });
  }

  function overlayView() {
    const r = R();
    if (S.phase === 'clue' && S.clue) {
      const c = S.clue;
      const cl = clueAt(c);
      const cat = r.categories[c.c].name;
      const showAns = c.stage === 'answer';
      const ref = showAns && cl.aMedia ? cl.aMedia : c.stage === 'ddIntro' ? null : cl.media;
      const top = `<button class="btn small light" data-ui="back">← Назад <kbd>Esc</kbd></button>
        <div class="ov-cat"><b>${esc(cat)}</b><span>${c.dd ? (c.wager != null ? `ставка ${fmt(c.wager)}` : 'вопрос-ставка') : fmt(c.value)}</span></div>
        ${c.dd ? '<span class="pill neutral">Вопрос-ставка</span>' : usesPhones() ? `<span class="pill ${c.stage === 'open' ? 'on' : ''}">${c.stage === 'open' ? 'Кнопки открыты' : 'Кнопки закрыты'}</span>` : '<span></span>'}`;
      let main = '';
      let status = '';
      if (c.stage === 'ddIntro') {
        main = `<div class="dd-banner">Вопрос-ставка!</div>`;
      } else {
        main = `<div class="clue-text" style="--fs:${textSize(cl.q, !!ref)}">${nl2br(cl.q)}</div>${showAns ? '' : hostPeek(cl.a)}`;
        if (c.stage === 'open' && c.deadline) status = timerHTML(c.deadline, settings.timer);
        if (c.stage === 'buzzed') status = `${c.ansDeadline ? timerHTML(c.ansDeadline, Math.max(5, settings.timer)) : ''}<div class="buzzed-name">Отвечает ${esc(player(c.buzzed)?.name)}!</div>`;
        if (c.stage === 'reading' && c.dd) status = `<div class="buzzed-name">Отвечает ${esc(player(c.ddPlayer)?.name)} · ставка ${fmt(c.wager)}</div>`;
        if (c.stage === 'open' && c.tried.length) status += `<div class="muted-light">Уже ошиблись: ${c.tried.map((id) => esc(player(id)?.name)).join(', ')}</div>`;
        if (showAns) {
          const res = c.result;
          status = `${res ? `<div class="res ${res.delta >= 0 ? 'good' : 'bad'}"><span>${esc(player(res.pid)?.name)}</span><b>${signed(res.delta)}</b></div>` : '<div class="res none">Никто не ответил</div>'}
            <div class="answer">${nl2br(cl.a || '—')}</div>`;
        }
      }
      return { key: `clue-${c.key}`, cls: `clue ${showAns ? 'show-answer' : ''} ${c.stage === 'ddIntro' ? 'dd' : ''}`, top, main, status, ref, mkey: `${c.key}-${showAns && cl.aMedia ? 'a' : c.stage === 'ddIntro' ? 'none' : 'q'}` };
    }
    if (S.phase === 'roundEnd') {
      return { key: 'roundEnd', cls: 'interlude', main: `<div class="big-title">${esc(r.name)} — всё!</div>${standingsHTML()}` };
    }
    if (S.phase === 'final') {
      const f = S.fin;
      const fc = board.final;
      const top = `<span></span><div class="ov-cat"><b>Финал</b><span>${esc(fc.category || '')}</span></div><span class="pill">${esc(statusText())}</span>`;
      if (f.stage === 'wager') {
        return { key: 'fin-wager', cls: 'final', top, main: `<div class="final-cat"><small>Тема финала</small>${esc(fc.category || 'Финальный вопрос')}</div><p class="muted-light">${usesPhones() ? 'Делайте ставки на телефонах: сколько очков вы готовы поставить?' : 'Каждый игрок делает ставку — от 0 до всех своих очков.'}</p>`, status: wagerStatus() };
      }
      const ref = f.stage === 'reveal' && f.showAnswer && fc.aMedia ? fc.aMedia : fc.media;
      const main = `<div class="clue-text" style="--fs:${textSize(fc.q, !!ref)}">${nl2br(fc.q)}</div>${f.showAnswer ? '' : hostPeek(fc.a)}`;
      let status = '';
      if (f.stage === 'clue') status = `${f.deadline ? timerHTML(f.deadline, settings.finalTimer) : ''}${usesPhones() ? wagerStatus('answers') : ''}`;
      if (f.stage === 'reveal' && f.showAnswer) status = `<div class="answer">${nl2br(fc.a || '—')}</div>`;
      return { key: `fin-${f.stage === 'wager' ? 'w' : 'q'}`, cls: `final ${f.stage === 'reveal' ? 'reveal' : ''}`, top, main, status, ref, mkey: `fin-${f.stage === 'reveal' && f.showAnswer && fc.aMedia ? 'a' : 'q'}` };
    }
    if (S.phase === 'end') {
      const st = standings();
      const podium = st.slice(0, 3).map((p, i) => `<div class="pod pod${i + 1}"><div class="pod-name">${esc(p.name)}</div><div class="pod-score">${fmt(p.score)}</div><div class="pod-bar">${i + 1}</div></div>`);
      const order = [podium[1], podium[0], podium[2]].filter(Boolean).join('');
      return { key: 'end', cls: 'interlude end', main: `<div class="big-title">${st[0] ? `Победа: ${esc(st[0].name)}!` : 'Игра окончена'}</div><div class="podium">${order}</div>${st.length > 3 ? standingsHTML(3) : ''}` };
    }
    return null;
  }

  // The correct answer for the host, shown before it is revealed (toggle in settings).
  // Never while the host window is open: then the answer lives there, off the shared screen.
  function hostPeek(a) {
    if (!settings.hostAnswer || hostWinOpen()) return '';
    return `<div class="host-ans"><small>Ответ для ведущего</small><b>${nl2br(a || '—')}</b></div>`;
  }

  function wagerStatus(kind = 'wagers') {
    const f = S.fin;
    const src = kind === 'wagers' ? f.wagers : f.answers;
    return `<div class="wager-status">${S.players.map((p) => `<span class="ws ${src[p.id] != null ? 'ok' : ''}">${src[p.id] != null ? '✓' : '…'} ${esc(p.name)}</span>`).join('')}</div>`;
  }

  function standingsHTML(from = 0) {
    return `<ol class="standings" start="${from + 1}">${standings().slice(from).map((p) => `<li><span>${esc(p.name)}</span><b class="${p.score < 0 ? 'neg' : ''}">${fmt(p.score)}</b></li>`).join('')}</ol>`;
  }

  function timerHTML(deadline, total) {
    return `<div class="timer" data-deadline="${deadline}" data-total="${total * 1000}"><span></span></div>`;
  }

  function renderOverlay() {
    const ov = $('.overlay', root);
    const v = overlayView();
    if (!v) {
      ov.hidden = true;
      ov.dataset.key = '';
      ov.innerHTML = '';
      setConfetti(false);
      return;
    }
    ov.hidden = false;
    if (ov.dataset.key !== v.key) {
      ov.dataset.key = v.key;
      ov.innerHTML = `<div class="ov-top"></div><div class="ov-body"><div class="ov-media"></div><div class="ov-main"></div><div class="ov-status"></div></div><div class="ov-ctl"></div>`;
    }
    ov.className = `overlay ${v.cls || ''}`;
    setHTML($('.ov-top', ov), v.top || '');
    setMedia($('.ov-media', ov), v.ref || null, v.mkey || v.key);
    setHTML($('.ov-main', ov), v.main || '');
    setHTML($('.ov-status', ov), v.status || '');
    setHTML($('.ov-ctl', ov), controlsHTML(controls()));
    tickTimers();
    setConfetti(S.phase === 'end');
  }

  // ---------- timers ----------
  function tickTimers() {
    const now = Date.now();
    for (const t of root.querySelectorAll('.timer')) {
      const left = Math.max(0, +t.dataset.deadline - now);
      const total = +t.dataset.total || 1;
      t.style.setProperty('--p', (left / total).toFixed(3));
      t.firstElementChild.textContent = Math.ceil(left / 1000);
      t.classList.toggle('low', left < 5000);
    }
  }
  const tick = setInterval(() => {
    if (!S || destroyed) return;
    tickTimers();
    if (hostWinShown !== hostWinOpen()) { hostWinShown = !hostWinShown; render(); }
    const c = S.clue;
    const now = Date.now();
    if (S.phase === 'clue' && c?.stage === 'open' && c.deadline && now >= c.deadline && !buzzTimer) {
      c.stage = 'answer';
      sfx('timeup');
      commit();
    } else if (S.phase === 'clue' && c?.stage === 'buzzed' && c.ansDeadline && now >= c.ansDeadline && !c.ansBeeped) {
      c.ansBeeped = true;
      sfx('timeup');
    } else if (S.phase === 'final' && S.fin?.stage === 'clue' && S.fin.deadline && now >= S.fin.deadline && !S.fin.timeUp) {
      S.fin.timeUp = true;
      sfx('timeup');
      commit();
    }
  }, 200);

  // ---------- confetti ----------
  let confettiRaf = 0;
  function setConfetti(on) {
    const cv = $('.confetti', root);
    if (!cv) return;
    if (!on) { cancelAnimationFrame(confettiRaf); confettiRaf = 0; cv.hidden = true; return; }
    if (confettiRaf) return;
    cv.hidden = false;
    const ctx = cv.getContext('2d');
    const colors = ['#e8662e', '#f5c518', '#1f9d68', '#2a7de1', '#d2312b', '#ffffff'];
    let parts = [];
    const spawn = (n) => { for (let i = 0; i < n; i++) parts.push({ x: Math.random() * cv.width, y: -20 - Math.random() * cv.height * 0.5, vx: (Math.random() - 0.5) * 2, vy: 2 + Math.random() * 3, r: Math.random() * 6.28, vr: (Math.random() - 0.5) * 0.3, s: 6 + Math.random() * 8, c: colors[(Math.random() * colors.length) | 0] }); };
    const resize = () => { cv.width = innerWidth; cv.height = innerHeight; };
    resize();
    spawn(220);
    let frames = 0;
    const step = () => {
      if (cv.width !== innerWidth) resize();
      ctx.clearRect(0, 0, cv.width, cv.height);
      for (const p of parts) {
        p.x += p.vx; p.y += p.vy; p.r += p.vr;
        ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.r); ctx.fillStyle = p.c; ctx.fillRect(-p.s / 2, -p.s / 4, p.s, p.s / 2); ctx.restore();
      }
      parts = parts.filter((p) => p.y < cv.height + 30);
      if (++frames < 240 && frames % 20 === 0) spawn(30);
      if (parts.length) confettiRaf = requestAnimationFrame(step);
      else { confettiRaf = 0; cv.hidden = true; }
    };
    confettiRaf = requestAnimationFrame(step);
  }

  // ---------- topbar / scoreboard UI ----------
  async function uiAction(what, ds) {
    switch (what) {
      case 'exit': {
        if (await confirmDlg('Выйти из игры? Её можно будет продолжить позже с того же места.', 'Выйти')) location.hash = '#/';
        return;
      }
      case 'undo': return act('undo');
      case 'full': return toggleFullscreen();
      case 'back': return act('back');
      case 'adj': return act('adj', { pid: ds.pid, delta: +ds.d });
      case 'qr': return showQR();
      case 'hostwin': return openHostWindow();
      case 'player': return playerMenu(ds.pid);
      case 'menu': return menu();
    }
  }

  function toggleFullscreen() {
    if (document.fullscreenElement) document.exitFullscreen?.();
    else document.documentElement.requestFullscreen?.().catch(() => {});
  }

  function showQR() {
    dialog({
      cls: 'qr-dlg',
      html: `<div class="room-code">${esc(S.code)}</div><div class="qr-big">${qrSvg(joinUrl())}</div><p class="muted">${esc(joinUrl())}</p>`,
      buttons: [{ label: 'Скопировать ссылку', value: () => { copyText(joinUrl()); } }, { label: 'Закрыть', value: true, cls: 'primary' }],
    });
  }

  function showRemoteQR() {
    dialog({
      title: 'Пульт ведущего',
      cls: 'qr-dlg',
      html: `<div class="qr-big">${qrSvg(remoteUrl())}</div><p class="muted">Отсканируй своим телефоном: увидишь правильные ответы и сможешь управлять игрой. Не показывай этот код игрокам.</p>`,
      buttons: [{ label: 'Скопировать ссылку', value: () => { copyText(remoteUrl()); } }, { label: 'Закрыть', value: true, cls: 'primary' }],
    });
  }

  async function playerMenu(pid) {
    const p = player(pid);
    if (!p) return;
    const r = await dialog({
      title: p.name,
      html: `<p class="muted">Очки: ${fmt(p.score)}${p.phone ? ` · ${p.online ? 'на связи' : 'не на связи'}` : ' · без телефона'}</p>`,
      cls: 'menu-dlg',
      buttons: [
        { label: 'Сейчас выбирает он/она', value: 'picker' },
        { label: 'Изменить очки', value: 'score' },
        { label: 'Переименовать', value: 'rename' },
        { label: 'Убрать из игры', value: 'kick', cls: 'danger' },
        { label: 'Закрыть', value: null, cls: 'ghost' },
      ],
    });
    if (r === 'picker') act('setPicker', { pid });
    if (r === 'score') {
      const v = await promptDlg(`Очки: ${p.name}`, p.score, { type: 'number' });
      if (v != null && v !== '') act('setScore', { pid, value: +v });
    }
    if (r === 'rename') {
      const v = await promptDlg('Новое имя', p.name);
      if (v && v.trim()) { p.name = v.trim().slice(0, 20); commit(); }
    }
    if (r === 'kick' && (await confirmDlg(`Убрать ${p.name} из игры?`, 'Убрать', true))) kick(pid);
  }

  async function menu() {
    const r = await dialog({
      title: 'Меню',
      cls: 'menu-dlg wide',
      html: `<div class="settings-card">${settingsHTML()}</div>`,
      onMount: (w) => bindSettings(w),
      buttons: [
        { label: 'Окно ведущего на этом компьютере', value: 'hostwin' },
        ...(usesPhones() ? [{ label: 'Ведущий с телефона (QR)', value: 'remote' }] : []),
        { label: 'Добавить игрока', value: 'add' },
        ...(['board', 'clue'].includes(S.phase) ? [{ label: 'Завершить раунд досрочно', value: 'endRound' }] : []),
        { label: 'Начать заново', value: 'restart', cls: 'danger' },
        { label: 'Готово', value: null, cls: 'primary' },
      ],
    });
    if (r === 'remote') showRemoteQR();
    if (r === 'hostwin') openHostWindow();
    if (r === 'add') {
      const name = await promptDlg('Имя игрока', '', { placeholder: 'Например, Вася' });
      if (name && name.trim()) {
        S.players.push({ id: uid('p'), name: name.trim().slice(0, 20), score: 0, phone: false, online: false });
        if (!player(S.picker)) S.picker = S.players[0].id;
        commit();
      }
    }
    if (r === 'endRound' && (await confirmDlg('Закончить раунд? Оставшиеся вопросы пропадут.', 'Закончить'))) act('endRound');
    if (r === 'restart' && (await confirmDlg('Начать игру заново? Все очки обнулятся.', 'Заново', true))) {
      hist = [];
      beginGame();
      commit();
    }
    render();
  }

  // ---------- keyboard ----------
  function onKey(e) {
    if (dialogOpen() || !S || ['setup', 'lobby'].includes(S.phase)) return;
    if (e.target.closest?.('input, textarea, select')) return;
    const c = S.clue;
    if ((e.ctrlKey || e.metaKey) && e.code === 'KeyZ') { e.preventDefault(); return act('undo'); }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.code === 'Space') {
      e.preventDefault();
      if (c?.stage === 'reading' && usesPhones() && !c.dd) return act('open');
      if (c?.stage === 'answer') return act('cont');
      if (S.phase === 'roundEnd') return act('nextRound');
    }
    if (e.code === 'KeyN' && c) return act('reveal');
    if (e.code === 'Escape' && c) return act('back');
    if (e.code === 'KeyF') return toggleFullscreen();
  }
  document.addEventListener('keydown', onKey);
  const onBeforeUnload = (e) => {
    if (S && !['setup', 'end'].includes(S.phase)) { e.preventDefault(); e.returnValue = ''; }
  };
  window.addEventListener('beforeunload', onBeforeUnload);

  // ---------- start ----------
  const saved = store.get(SAVE_KEY);
  if (saved?.boardId === board.id && saved.s && !['setup', 'end'].includes(saved.s.phase)) {
    const n = saved.s.players.length;
    const r = await dialog({
      title: 'Продолжить игру?',
      html: `<p>Есть незаконченная игра по этой доске (${n} ${plural(n, 'игрок', 'игрока', 'игроков')}). Продолжить с того же места?</p>`,
      buttons: [{ label: 'Новая игра', value: 'new' }, { label: 'Продолжить', value: 'resume', cls: 'primary' }],
    });
    if (r === 'resume') {
      S = saved.s;
      S.kicked ||= [];
      for (const p of S.players) p.online = false;
      if (S.clue) { clearBuzz(); if (S.clue.stage === 'open' || S.clue.stage === 'buzzed') { S.clue.stage = 'reading'; S.clue.buzzed = null; } }
      if (S.round >= board.rounds.length) S.round = Math.max(0, firstRound());
      if (S.mode === 'buzzer') {
        root.innerHTML = `<div class="page center"><div class="connecting"><div class="spinner"></div>Восстанавливаем комнату ${esc(S.code)}…</div></div>`;
        try { await startNet(S.code); } catch (e) {
          toast(`${errText(e)} — продолжаем в простом режиме`, 'warn');
          S.mode = 'simple';
          for (const p of S.players) p.phone = false;
        }
      }
      commit();
    }
  }
  if (!S) {
    S = freshState();
    render();
  }

  return () => {
    destroyed = true;
    clearInterval(tick);
    clearBuzz();
    cancelAnimationFrame(confettiRaf);
    document.removeEventListener('keydown', onKey);
    window.removeEventListener('beforeunload', onBeforeUnload);
    chan?.close();
    net?.destroy();
  };
}
