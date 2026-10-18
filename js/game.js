// The host screen: setup, lobby with teams, board, clues, rounds, final, results.
// All game logic lives here; phones only send intents and render the views we push.
import * as db from './db.js?v=1792357741893';
import { $, esc, uid, fmt, signed, clamp, store, toast, dialog, dialogOpen, confirmDlg, promptDlg, copyText, qrSvg, plural, siteUpdatedBanner } from './util.js?v=1792357741893';
import { filled, hasQ, finalReady, roundPlayable } from './board.js?v=1792357741893';
import { mediaEl, kindOf } from './media.js?v=1792357741893';
import { play as sfx, sound, unlock } from './sound.js?v=1792357741893';
import { Host, errText, hostChannelName } from './net.js?v=1792357741893';
import { setHTML } from './controls.js?v=1792357741893';
import { saveGame } from './history.js?v=1792357741893';
import { MediaSender, describe } from './mediasync.js?v=1792357741893';
import { VERSION } from './version.js?v=1792357741893';
import { createScreen } from './gameui.js?v=1792357741893';
import * as screamer from './screamer.js?v=1792357741893';
import { MODS, modHead, resolveMod } from './mods.js?v=1792357741893';
import { GAMES, INTRO_MS, newGame, scoreOf, resultText } from './minigames.js?v=1792357741893';

const SETTINGS_KEY = 'plyukh-settings';
const DEFAULTS = { dd: true, timer: 15, sound: true, penalty: false, finalTimer: 30, phoneMedia: true, phoneText: true, shared: false, mediaSync: 'all', scare: 'rare', phonePick: true, answer: 'buzz', turnMinus: false, mods: 'off', mini: 'rare', secret: 'one' };
const BUZZ_WINDOW_MS = 220;
const MODS_PER_ROUND = { few: 1, many: 3 };
const SECRETS_PER_ROUND = { one: 1, two: 2 };
const MINI_CHANCE = { rare: 0.12, often: 0.3 }; // after each question, once enough questions passed
const MINI_GAP = { rare: 4, often: 2 };
const TEAM_COLORS = ['#df6e5c', '#5b8def', '#4fae8f', '#e0a43a', '#a77fd6', '#7d9a3a', '#d6588f', '#2a9fb5'];
function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}
const TEAM_NAMES = ['Красные', 'Синие', 'Зелёные', 'Жёлтые', 'Фиолетовые', 'Голубые', 'Розовые', 'Оливковые'];

export async function startPlay(root, boardId) {
  const board = await db.getBoard(boardId);
  if (!board) {
    root.innerHTML = `<div class="page center"><h1>Игра не найдена</h1><a class="btn primary" href="#/">На главную</a></div>`;
    return;
  }

  // Test bench (test/): the host runs in a frame next to fake players.
  const autotest = new URLSearchParams(location.search).has('autotest');
  const SAVE_KEY = autotest ? 'plyukh-game-test' : 'plyukh-game';

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
  let screen = null; // the game screen (gameui)
  let destroyed = false;

  const R = () => board.rounds[S.round];
  const player = (id) => S.players.find((p) => p.id === id);
  const team = (id) => S.teams.find((t) => t.id === id);
  const teamOf = (pid) => team(player(pid)?.teamId);
  const members = (tid) => S.players.filter((p) => p.teamId === tid);
  const keyOf = (r, c, q) => `${r}:${c}:${q}`;
  const clueAt = (c) => R().categories[c.c].clues[c.q];
  const worth = () => (S.clue.dd ? S.clue.wager || 0 : S.clue.value * (S.clue.mult || 1));
  const firstRound = () => board.rounds.findIndex(roundPlayable);
  const standings = () => [...S.teams].sort((a, b) => b.score - a.score);
  const saveSettings = () => store.set(SETTINGS_KEY, settings);
  const pageUrl = () => location.href.split('#')[0].split('?')[0];
  const joinUrl = () => new URL(`join/?r=${S.code}`, pageUrl()).href;
  const remoteUrl = () => new URL(`join/?r=${S.code}&k=${S.hostKey}`, pageUrl()).href;
  const usesPhones = () => S.mode === 'buzzer';
  const solo = () => S.teamMode === 'solo';
  // "По очереди": teams answer in turn, no buttons; a right answer earns picking the next team's question.
  const turns = () => settings.answer === 'turns';
  // What a mini-game win is worth: the cheapest question of the round.
  const bonus = () => { const v = R().values.filter((x) => x > 0); return v.length ? Math.min(...v) : 100; };
  const step = () => Math.min(...R().values.filter((v) => v > 0), 100) || 100;
  // A team can buzz if someone of it is online, or if it plays without phones (the host buzzes for it).
  const canPlay = (t) => { const m = members(t.id).filter((p) => p.phone); return !m.length || m.some((p) => p.online); };
  const withPhones = (t) => members(t.id).some((p) => p.phone && p.online);

  function freshState(mode = 'buzzer') {
    return {
      v: 2, phase: 'setup', mode, teamMode: 'teams', teams: [], players: [], kicked: [], round: 0, used: {}, dds: {},
      picker: null, turn: null, mods: {}, mini: null, clue: null, fin: null, code: null, hostKey: uid().slice(0, 10), openSeq: 0,
    };
  }

  function newTeam(name) {
    const used = new Set(S.teams.map((t) => t.color));
    const color = TEAM_COLORS.find((c) => !used.has(c)) || TEAM_COLORS[S.teams.length % TEAM_COLORS.length];
    const t = { id: uid('t'), name: (name || TEAM_NAMES[S.teams.length % TEAM_NAMES.length]).slice(0, 24), color, score: 0 };
    S.teams.push(t);
    return t;
  }

  // In "каждый сам за себя" every player is a team of one.
  function soloTeam(p) {
    let t = team(p.teamId);
    if (!t) { t = newTeam(p.name); p.teamId = t.id; }
    return t;
  }

  function autoTeam(p) {
    if (solo()) return soloTeam(p);
    if (!S.teams.length) { newTeam(); newTeam(); }
    const t = [...S.teams].sort((a, b) => members(a.id).length - members(b.id).length)[0];
    p.teamId = t.id;
    return t;
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
    // Undo is about the game, not about who may come in: the lock and the kicked list stay as they are.
    const { locked, kicked, banned } = S;
    S = JSON.parse(prev);
    Object.assign(S, { locked, kicked, banned });
    S.players = S.players.filter((p) => !kicked.includes(p.id));
    for (const p of S.players) p.online = !!online[p.id];
    clearBuzz();
    toast('Отменено');
  }

  // ---------- scoring helpers ----------
  function addScore(tid, delta) {
    const t = team(tid);
    if (t) t.score += delta;
  }
  function ddRange(t) {
    const top = Math.max(...R().values);
    return { min: 0, max: Math.max(t?.score || 0, top) };
  }
  // In "по очереди" a team has to answer, so a miss costs nothing unless the host wants it to.
  // The secret question and the wager are different: there a miss always costs.
  function penalty() {
    return turns() && !settings.turnMinus && !S.clue.dd && !S.clue.only ? 0 : worth();
  }
  function eligible() {
    const c = S.clue;
    return S.teams.filter((t) => !c.tried.includes(t.id) && canPlay(t));
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
      if (!hasQ(cl) || cl.mod) return;
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

  // Random secret questions and modifier cells for the round, on top of those the author put on the board.
  function placeMods() {
    S.mods = {};
    const cands = [];
    R().categories.forEach((cat, ci) => cat.clues.forEach((cl, qi) => {
      const key = keyOf(S.round, ci, qi);
      if (hasQ(cl) && !cl.mod && !S.dds[key] && !S.used[key]) cands.push(key);
    }));
    shuffle(cands);
    // A secret question has to be handed to someone else, so it needs two teams.
    const secrets = S.teams.length > 1 ? SECRETS_PER_ROUND[settings.secret] || 0 : 0;
    for (const key of cands.splice(0, secrets)) S.mods[key] = 'cat';
    for (const key of cands.splice(0, MODS_PER_ROUND[settings.mods] || 0)) S.mods[key] = 'random';
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
  function setBuzzed(tid, pid = null) {
    const c = S.clue;
    clearBuzz();
    c.stage = 'buzzed';
    c.buzzed = { team: tid, pid };
    c.ansTotal = Math.max(5, settings.timer) * 1000;
    c.ansDeadline = settings.timer ? Date.now() + c.ansTotal : 0;
    c.ansBeeped = false;
    log({ k: 'buzz', team: tid, by: player(pid)?.name || '' });
    sfx('buzz');
  }
  // The question itself, right away or after the modifier. One team answers alone in the
  // "по очереди" mode and after the secret question; otherwise everyone races for the button.
  function startQuestion() {
    const c = S.clue;
    const single = c.only || (turns() ? S.turn : null);
    if (!team(single)) { c.stage = 'reading'; return; }
    c.single = true;
    c.stage = 'buzzed';
    c.buzzed = { team: single, pid: null };
    c.ansTotal = (Math.max(5, settings.timer) + 5) * 1000; // they also need to hear the question
    c.ansDeadline = settings.timer ? Date.now() + c.ansTotal : 0;
    c.ansBeeped = false;
  }
  function nextTurn(tid) {
    const n = S.teams.length;
    const i = S.teams.findIndex((t) => t.id === tid);
    for (let k = 1; k <= n; k++) {
      const t = S.teams[(i + k + n) % n];
      if (canPlay(t) && (members(t.id).length || !usesPhones())) return t.id;
    }
    return S.teams[(i + 1 + n) % n]?.id || null;
  }
  function finishClue() {
    const c = S.clue;
    S.used[c.key] = true;
    if (turns()) {
      S.turn = nextTurn(S.turn);
      S.picker = c.result?.ok ? c.result.team : S.turn;
    }
    S.clue = null;
    clearBuzz();
    S.phase = roundDone() ? 'roundEnd' : 'board';
  }
  function beginGame() {
    S.round = Math.max(0, firstRound());
    S.used = {};
    S.clue = null;
    S.fin = null;
    for (const t of S.teams) t.score = 0;
    const playing = S.teams.filter((t) => members(t.id).length || !usesPhones());
    const pool = playing.length ? playing : S.teams;
    S.picker = pool.length ? pool[Math.floor(Math.random() * pool.length)].id : null;
    S.turn = S.picker;
    S.mini = null;
    cluesSinceMini = 0;
    S.gameId = uid('g');
    S.startedAt = Date.now();
    S.endedAt = 0;
    S.log = [];
    placeDDs();
    placeMods();
    S.phase = 'board';
    log({ k: 'start', r: S.round, picker: S.picker, scores: scoreMap() });
  }

  // ---------- modifiers (js/mods.js) ----------
  // Applies the modifier of the open cell; `target` is the team picked for swap, steal or the secret question.
  function applyMod(target = null) {
    const c = S.clue;
    const m = c.mod;
    const me = team(m.team);
    const other = team(target);
    const v = c.value;
    const before = scoreMap();
    let note = '';
    switch (m.kind) {
      case 'flip':
        if (me) me.score = -me.score;
        if (me && !me.score) note = 'У команды 0 — менять нечего. Повезло!';
        break;
      case 'swap':
        if (me && other) [me.score, other.score] = [other.score, me.score];
        if (me && other && me.score === other.score) note = 'Очков было поровну — ничего не изменилось';
        break;
      case 'steal':
        if (me && other) { other.score -= v; me.score += v; }
        break;
      case 'gift': if (me) me.score += v; break;
      case 'bomb': if (me) me.score -= v; break;
      case 'robin': {
        const st = standings();
        const top = st[0];
        const low = st[st.length - 1];
        if (top && low && top.score > low.score) { top.score -= v; low.score += v; }
        else note = 'У всех поровну — Робину некого грабить';
        break;
      }
      case 'shuffle': {
        const vals = S.teams.map((t) => t.score);
        let mixed = shuffle([...vals]);
        for (let i = 0; i < 8 && new Set(vals).size > 1 && mixed.every((x, j) => x === vals[j]); i++) mixed = shuffle([...vals]);
        S.teams.forEach((t, i) => { t.score = mixed[i]; });
        if (new Set(vals).size < 2) note = 'У всех поровну — перемешивать нечего';
        break;
      }
      case 'double':
        c.mult = 2;
        break;
      case 'cat':
        c.only = target;
        note = `Вопрос достаётся команде ${other?.name || '…'} — отвечают только они`;
        break;
    }
    m.target = target;
    m.done = true;
    m.note = note;
    m.changes = S.teams.filter((t) => t.score !== before[t.id]).map((t) => ({ id: t.id, from: before[t.id], to: t.score }));
    log({ k: 'mod', mod: m.kind, team: m.team, target, scores: scoreMap() });
  }

  // ---------- game log for the history ("time machine") ----------
  const scoreMap = () => Object.fromEntries(S.teams.map((t) => [t.id, t.score]));
  function log(e) {
    (S.log ||= []).push({ t: Date.now(), ...e });
  }

  // The board as text, so the history can show questions even if the board is later edited or deleted.
  function boardSnapshot() {
    const m = (ref) => {
      if (!ref) return null;
      if (ref.kind === 'file') return { k: kindOf(ref), id: ref.id };
      if (ref.kind === 'youtube') return { k: 'youtube', vid: ref.vid };
      return { k: kindOf(ref), url: ref.url.length < 30000 ? ref.url : null };
    };
    return {
      rounds: board.rounds.map((r) => ({
        name: r.name, values: r.values,
        cats: r.categories.map((c) => ({ name: c.name, clues: c.clues.map((cl) => ({ q: cl.q, a: cl.a, m: m(cl.media), am: m(cl.aMedia), ...(cl.mod ? { mod: cl.mod } : {}) })) })),
      })),
      final: finalReady(board) ? { cat: board.final.category, q: board.final.q, a: board.final.a, m: m(board.final.media), am: m(board.final.aMedia) } : null,
    };
  }

  let historyTimer = null;
  function recordHistory() {
    // A game is worth remembering once at least one question was played.
    if (!S.log?.some((e) => ['right', 'wrong', 'none', 'fjudge'].includes(e.k))) return;
    const finished = S.phase === 'end';
    saveGame({
      v: 2,
      test: autotest,
      id: S.gameId || (S.gameId = uid('g')),
      at: finished ? S.endedAt || (S.endedAt = Date.now()) : Date.now(),
      startedAt: S.startedAt || 0,
      finished,
      board: board.title,
      boardId: board.id,
      mode: S.mode,
      answer: settings.answer,
      teamMode: S.teamMode,
      teams: S.teams.map((t) => ({ id: t.id, name: t.name, color: t.color, score: t.score, members: members(t.id).map((p) => p.name) })),
      players: standings().map((t) => ({ name: solo() ? t.name : `${t.name}${members(t.id).length ? ` (${members(t.id).map((p) => p.name).join(', ')})` : ''}`, score: t.score })),
      snapshot: boardSnapshot(),
      events: S.log,
    });
  }
  function scheduleHistory() {
    clearTimeout(historyTimer);
    historyTimer = setTimeout(() => { historyTimer = null; recordHistory(); }, 700);
  }

  // ---------- actions (from the screen, keyboard, the host's phone or the host window) ----------
  const A = {
    pick({ c, q }) {
      if (S.phase !== 'board') return;
      const key = keyOf(S.round, c, q);
      const cl = R().categories[c]?.clues[q];
      if (!filled(cl) || S.used[key]) return;
      const modId = cl.mod || (S.mods?.[key] === 'cat' && S.teams.length < 2 ? null : S.mods?.[key]);
      const dd = !modId && !!S.dds[key] && settings.dd;
      // Whoever opened the cell: the choosing team, or in "по очереди" the team whose turn it is.
      const opener = turns() ? S.turn : S.picker;
      const who = team(opener) ? opener : S.teams[0]?.id || null;
      if (modId) snapshot();
      S.clue = { c, q, key, value: R().values[q], dd, stage: 'reading', tried: [], buzzed: null, result: null, openId: 0, deadline: 0 };
      S.phase = 'clue';
      log({ k: 'pick', r: S.round, c, q, value: S.clue.value, dd, picker: S.picker, ...(turns() ? { turn: S.turn } : {}) });
      if (modId) {
        S.clue.mod = { kind: resolveMod(modId, S.teams.length, hasQ(cl)), team: who, target: null, done: false, changes: [], note: '' };
        S.clue.stage = 'mod';
        sfx('dd');
        if (!MODS[S.clue.mod.kind].target) applyMod();
      } else if (dd) {
        Object.assign(S.clue, { stage: 'ddIntro', ddTeam: who, wager: null });
        sfx('dd');
      } else startQuestion();
      maybeScare();
    },
    modTarget({ team: tid, random } = {}) {
      const c = S.clue;
      const m = c?.mod;
      if (c?.stage !== 'mod' || m.done || !MODS[m.kind].target) return;
      const others = S.teams.filter((t) => t.id !== m.team);
      if (random) tid = others[Math.floor(Math.random() * others.length)]?.id;
      if (!team(tid) || tid === m.team) return;
      snapshot();
      applyMod(tid);
    },
    modNext() {
      const c = S.clue;
      if (c?.stage !== 'mod' || !c.mod.done) return;
      if (hasQ(clueAt(c))) return startQuestion();
      finishClue();
      maybeMini();
    },
    ddTeam({ team: tid }) {
      if (S.clue?.stage === 'ddIntro' && team(tid)) S.clue.ddTeam = tid;
    },
    ddWager({ amount }) {
      const c = S.clue;
      if (c?.stage !== 'ddIntro') return;
      const t = team(c.ddTeam);
      if (!t) return toast('Сначала выбери, кто отвечает');
      const { min, max } = ddRange(t);
      c.wager = clamp(Math.round(+amount || 0), min, max);
      c.stage = 'reading';
      log({ k: 'dd', team: t.id, wager: c.wager });
    },
    open() {
      const c = S.clue;
      if (!usesPhones() || c?.stage !== 'reading' || c.dd) return;
      startOpen();
      sfx('open');
    },
    correct({ team: tid } = {}) {
      const c = S.clue;
      if (!c || !['reading', 'open', 'buzzed'].includes(c.stage)) return;
      tid = tid ?? (c.dd ? c.ddTeam : c.buzzed?.team);
      if (!team(tid) || c.tried.includes(tid)) return;
      snapshot();
      const v = worth();
      addScore(tid, v);
      log({ k: 'right', team: tid, by: player(c.buzzed?.pid)?.name || '', delta: v, scores: scoreMap() });
      c.result = { team: tid, pid: c.buzzed?.pid || null, delta: v, ok: true };
      c.stage = 'answer';
      c.buzzed = null;
      S.picker = tid;
      clearBuzz();
      sfx('correct');
    },
    wrong({ team: tid } = {}) {
      const c = S.clue;
      if (!c || !['reading', 'open', 'buzzed'].includes(c.stage)) return;
      tid = tid ?? (c.dd ? c.ddTeam : c.buzzed?.team);
      if (!team(tid) || c.tried.includes(tid)) return;
      snapshot();
      const v = penalty();
      addScore(tid, -v);
      log({ k: 'wrong', team: tid, by: player(c.buzzed?.pid)?.name || '', delta: -v, scores: scoreMap() });
      c.tried.push(tid);
      sfx('wrong');
      if (c.dd || c.single) { c.result = { team: tid, delta: -v, ok: false }; c.stage = 'answer'; c.buzzed = null; return; }
      if (usesPhones()) {
        c.buzzed = null;
        if (eligible().length) startOpen();
        else c.stage = 'answer';
      } else if (S.teams.every((t) => c.tried.includes(t.id))) {
        c.stage = 'answer';
      }
    },
    reveal() {
      const c = S.clue;
      if (!c || ['answer', 'ddIntro', 'mod'].includes(c.stage)) return;
      c.stage = 'answer';
      c.buzzed = null;
      clearBuzz();
      log({ k: 'none' });
    },
    manualBuzz({ team: tid }) {
      if (S.clue?.stage === 'open' && eligible().some((t) => t.id === tid)) setBuzzed(tid);
    },
    cont() {
      if (S.clue?.stage !== 'answer') return;
      finishClue();
      maybeMini();
    },
    back() {
      const c = S.clue;
      if (!c) return;
      if (c.tried.length || c.result || c.stage === 'answer' || c.mod?.done) finishClue();
      else {
        // Opened by mistake: it never happened, so drop it from the log too.
        while (S.log?.length && S.log[S.log.length - 1].k !== 'pick') S.log.pop();
        S.log?.pop();
        S.clue = null;
        S.phase = 'board';
        clearBuzz();
      }
    },
    adj({ team: tid, delta }) {
      if (!team(tid)) return;
      snapshot();
      addScore(tid, Math.round(+delta || 0));
      log({ k: 'adj', team: tid, delta: Math.round(+delta || 0), scores: scoreMap() });
    },
    setScore({ team: tid, value }) {
      const t = team(tid);
      if (!t) return;
      snapshot();
      const before = t.score;
      t.score = Math.round(+value || 0);
      log({ k: 'adj', team: tid, delta: t.score - before, scores: scoreMap() });
    },
    setPicker({ team: tid }) {
      if (team(tid)) S.picker = tid;
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
        placeMods();
        S.phase = 'board';
        log({ k: 'round', r: nx });
      } else if (finalReady(board) && S.teams.length) {
        S.phase = 'final';
        S.fin = { stage: 'wager', wagers: {}, answers: {}, shown: {}, judged: {}, deadline: 0, showAnswer: false, timeUp: false };
        log({ k: 'final' });
      } else {
        S.phase = 'end';
        log({ k: 'end', scores: scoreMap() });
        sfx('win');
      }
    },
    finWager({ team: tid, amount }) {
      const f = S.fin;
      const t = team(tid);
      if (S.phase !== 'final' || f.stage !== 'wager' || !t) return;
      f.wagers[tid] = clamp(Math.round(+amount || 0), 0, Math.max(0, t.score));
    },
    finClue() {
      if (S.phase !== 'final' || S.fin.stage !== 'wager') return;
      snapshot();
      for (const t of S.teams) S.fin.wagers[t.id] ??= 0;
      log({ k: 'fwagers', wagers: { ...S.fin.wagers } });
      S.fin.stage = 'clue';
      S.fin.deadline = settings.finalTimer ? Date.now() + settings.finalTimer * 1000 : 0;
      S.fin.timeUp = false;
    },
    finAnswer({ team: tid, text }) {
      if (S.phase !== 'final' || S.fin.stage !== 'clue' || !team(tid)) return;
      S.fin.answers[tid] = String(text || '').slice(0, 300);
    },
    finReveal() {
      if (S.phase !== 'final' || S.fin.stage !== 'clue') return;
      snapshot();
      S.fin.stage = 'reveal';
    },
    finShow({ team: tid }) {
      if (S.fin?.stage === 'reveal') S.fin.shown[tid] = true;
    },
    finJudge({ team: tid, ok }) {
      const f = S.fin;
      if (f?.stage !== 'reveal' || !team(tid) || f.judged[tid] != null) return;
      snapshot();
      f.shown[tid] = true;
      f.judged[tid] = !!ok;
      const w = f.wagers[tid] || 0;
      addScore(tid, ok ? w : -w);
      log({ k: 'fjudge', team: tid, answer: f.answers[tid] ?? null, wager: w, ok: !!ok, scores: scoreMap() });
      sfx(ok ? 'correct' : 'wrong');
    },
    finCorrect() {
      if (S.fin?.stage === 'reveal') S.fin.showAnswer = true;
    },
    finEnd() {
      if (S.phase !== 'final') return;
      snapshot();
      S.phase = 'end';
      log({ k: 'end', scores: scoreMap() });
      sfx('win');
    },
    kick({ pid, ban }) {
      kick(pid, !!ban);
    },
    // A closed room lets nobody new in; whoever is already playing can still reconnect.
    lock({ on } = {}) {
      S.locked = on ?? !S.locked;
      toast(S.locked ? 'Комната закрыта: новые игроки не зайдут' : 'Комната открыта: можно заходить по коду');
    },
    mini({ kind } = {}) {
      if (S.phase === 'board' && usesPhones()) startMini(kind);
    },
    miniEnd() {
      if (S.phase !== 'mini') return;
      S.phase = S.mini?.after || 'board';
      S.mini = null;
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
    const p = player(pid);
    switch (d.t) {
      case 'buzz': return onBuzz(pid, d);
      case 'early': return onEarly(pid);
      case 'pick':
        // Players of the choosing team pick on their own screens.
        if (p && S.phase === 'board' && p.teamId === S.picker && settings.phonePick) act('pick', { c: d.c, q: d.q });
        return;
      case 'team':
        if (p && team(d.team) && (S.phase === 'lobby' || !team(p.teamId)) && !solo()) { p.teamId = d.team; commit(); }
        return;
      case 'wager':
        if (p && S.clue?.stage === 'ddIntro' && S.clue.ddTeam === p.teamId) act('ddWager', { amount: d.amount });
        return;
      case 'modTarget':
        if (p && S.clue?.stage === 'mod' && S.clue.mod.team === p.teamId) act('modTarget', { team: d.team });
        return;
      case 'mini': return onMini(pid, d);
      case 'spy':
        // The secret code typed on a player's screen: they get the host's remote (js/join.js).
        if (p && d.code === '556') net.send(conn, { t: 'spy', key: S.hostKey });
        return;
      case 'fwager': if (p) act('finWager', { team: p.teamId, amount: d.amount }); return;
      case 'fanswer': if (p) act('finAnswer', { team: p.teamId, text: d.text }); return;
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
      if (!d.spy) toast('Пульт ведущего подключён'); // a spy's remote stays secret
      return;
    }
    if (S.kicked.includes(d.pid)) {
      net.send(conn, { t: 'kicked', ban: !!S.banned?.includes(d.pid) });
      setTimeout(() => conn.close(), 400);
      return;
    }
    if (S.locked && !player(d.pid)) {
      net.send(conn, { t: 'locked' });
      setTimeout(() => conn.close(), 400);
      return;
    }
    const name = String(d.name || 'Игрок').trim().slice(0, 20) || 'Игрок';
    let p = player(d.pid);
    if (!p) {
      p = { id: d.pid || uid('p'), name, teamId: null, phone: true, online: true };
      S.players.push(p);
      if (solo() || d.auto) autoTeam(p);
      sfx('join');
      if (S.phase !== 'lobby') toast(`${p.name} присоединяется`);
    } else {
      p.online = true;
      p.name = name;
      p.phone = true;
      if (solo()) { const t = soloTeam(p); t.name = name; }
      else if (!team(p.teamId) && d.auto) autoTeam(p);
    }
    if (!team(S.picker) && !['setup', 'lobby'].includes(S.phase)) S.picker = p.teamId;
    if (!team(S.turn) && !['setup', 'lobby'].includes(S.phase)) S.turn = p.teamId;
    const old = conns.get(p.id);
    if (old && old !== conn) { old._replaced = true; try { old.close(); } catch {} }
    conn._pid = p.id;
    conns.set(p.id, conn);
    if (Array.isArray(d.have)) sender?.have(conn, d.have);
    // A phone running a newer release means this page is stale.
    if (d.v && d.v > VERSION) siteUpdatedBanner();
    net.send(conn, { t: 'welcome', pid: p.id, v: VERSION });
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
    const t = teamOf(pid);
    if (!c || !t || c.stage !== 'open' || oid !== c.openId) return;
    if (c.tried.includes(t.id) || (locks[pid] || 0) > Date.now()) return;
    if (buzzCands.some((b) => b.team === t.id)) return;
    // Phones report their reaction time, so a slower connection doesn't lose a fair race.
    buzzCands.push({ pid, team: t.id, rt: clamp(+rt || 0, 0, 60000) });
    if (!buzzTimer) {
      buzzTimer = setTimeout(() => {
        buzzTimer = null;
        const best = [...buzzCands].sort((a, b) => a.rt - b.rt)[0];
        buzzCands = [];
        if (best && S.clue?.stage === 'open' && S.clue.openId === oid) {
          setBuzzed(best.team, best.pid);
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

  // Sends a player out of the room. A kicked phone forgets its id, so it can come back with the room
  // code as a new player; a banned one keeps it and is turned away until the game ends.
  function kick(pid, ban = false) {
    const p = player(pid);
    if (!p) return;
    const conn = conns.get(pid);
    if (conn) { net.send(conn, { t: 'kicked', ban }); setTimeout(() => { try { conn.close(); } catch {} }, 300); conns.delete(pid); }
    if (!S.kicked.includes(pid)) S.kicked.push(pid);
    if (ban) (S.banned ||= []).push(pid);
    S.players = S.players.filter((x) => x.id !== pid);
    if (solo() && !members(p.teamId).length) removeTeam(p.teamId);
    toast(ban ? `${p.name} выгнан(а) насовсем` : `${p.name} выгнан(а)`);
  }

  function removeTeam(tid) {
    S.teams = S.teams.filter((t) => t.id !== tid);
    for (const p of S.players) if (p.teamId === tid) p.teamId = null;
    if (S.picker === tid) S.picker = S.teams[0]?.id || null;
    if (S.turn === tid) S.turn = S.teams[0]?.id || null;
  }

  // ---------- what each screen shows ----------
  // A file can be kept off the phones with its own checkbox in the editor.
  const forPhones = (ref) => (ref && ref.phone !== false ? ref : null);
  // Answer media replaces the question's once revealed; if it's hidden, the question's stays.
  const phonePick = (qRef, aRef, revealed) => (revealed && forPhones(aRef)) || forPhones(qRef);
  const hostPick = (qRef, aRef, revealed) => (revealed && aRef) || qRef;
  const tinfo = (tid) => { const t = team(tid); return t ? { name: t.name, color: t.color } : null; };

  // Board/question/final part of the screen; `pid` is a player, or null for the host.
  function viewFor(pid) {
    const host = pid == null;
    const r = R();
    const c = S.clue;
    if (S.phase === 'lobby') return { v: 'lobby', head: 'Ждём начала игры…', sub: 'Как только ведущий начнёт, здесь появится доска.' };
    if (S.phase === 'board' || (S.phase === 'clue' && !c)) {
      const myTeam = player(pid)?.teamId;
      const picking = !host && !!myTeam && myTeam === S.picker;
      const mine = picking && settings.phonePick;
      return {
        v: 'board', cats: r.categories.map((x) => x.name), values: r.values,
        open: r.categories.map((cat, ci) => cat.clues.map((cl, qi) => filled(cl) && !S.used[keyOf(S.round, ci, qi)])),
        canPick: host || mine, mine,
        hint: host ? '' : boardHint(myTeam, picking, mine),
      };
    }
    if (S.phase === 'mini' && S.mini) return miniView(pid);
    if (S.phase === 'clue') {
      const cl = clueAt(c);
      const cat = r.categories[c.c].name;
      if (c.stage === 'mod') return modView(c);
      if (c.stage === 'ddIntro') {
        return { v: 'dd', key: c.key, cat, team: tinfo(c.ddTeam), text: '{team} делают ставку' };
      }
      const revealed = c.stage === 'answer';
      const ref = host ? hostPick(cl.media, cl.aMedia, revealed) : settings.phoneMedia ? phonePick(cl.media, cl.aMedia, revealed) : null;
      const which = ref && ref === cl.aMedia ? 'a' : 'q';
      const v = {
        v: 'clue', key: c.key, cat,
        label: c.dd ? (c.wager != null ? `ставка ${fmt(c.wager)}` : 'вопрос-ставка') : c.only ? `🤫 ${fmt(worth())}` : c.mult > 1 ? `×2 · ${fmt(worth())}` : fmt(c.value),
        text: host || settings.phoneText ? cl.q : 'Вопрос — на экране ведущего',
        media: ref ? (host ? ref : describe(ref)) : null, mediaKey: ref ? `${c.key}:${which}` : '',
        autoplay: settings.mediaSync === 'all', stage: c.stage,
      };
      if (c.stage === 'open' && c.deadline) v.timer = { deadline: c.deadline, total: settings.timer * 1000 };
      if (c.stage === 'buzzed' && c.ansDeadline) v.timer = { deadline: c.ansDeadline, total: c.ansTotal || Math.max(5, settings.timer) * 1000 };
      if (c.stage === 'reading') v.status = { text: c.dd ? `Отвечают {team} · ставка ${fmt(c.wager)}` : usesPhones() ? 'Кнопки закрыты — слушайте вопрос' : 'Отвечайте вслух', team: tinfo(c.ddTeam) };
      if (c.stage === 'open') v.status = { text: `Кнопки открыты — жмите!${c.tried.length ? ` Мимо: ${c.tried.map((id) => team(id)?.name).join(', ')}` : ''}` };
      if (c.stage === 'buzzed') v.status = { text: c.only ? 'Секретный вопрос: отвечают только {team}' : c.single ? 'Ход команды {team} — отвечайте!' : `Отвечают {team}${player(c.buzzed.pid) ? ` — ${player(c.buzzed.pid).name}` : ''}`, team: tinfo(c.buzzed.team) };
      if (revealed && (host || settings.phoneText)) {
        const res = c.result;
        v.answer = {
          text: cl.a,
          result: res ? { text: res.ok === false && !res.delta ? '{team} — мимо' : `{team} ${signed(res.delta)}`, team: tinfo(res.team), cls: (res.ok ?? res.delta >= 0) ? 'good' : 'bad' } : { text: 'Никто не ответил' },
        };
      }
      return v;
    }
    if (S.phase === 'roundEnd') return { v: 'roundEnd', key: S.round, head: `${r.name} — всё!`, standings: standingsFor(pid) };
    if (S.phase === 'final') {
      const f = S.fin;
      const fc = board.final;
      const chips = (src) => S.teams.map((t) => ({ name: t.name, ok: src[t.id] != null }));
      if (f.stage === 'wager') return { v: 'finw', key: 'w', cat: fc.category, sub: usesPhones() ? 'Команды делают ставки: сколько очков готовы поставить?' : 'Каждая команда делает ставку — от 0 до всех своих очков', chips: chips(f.wagers) };
      const ref = host ? hostPick(fc.media, fc.aMedia, f.showAnswer) : settings.phoneMedia ? phonePick(fc.media, fc.aMedia, f.showAnswer) : null;
      const v = {
        v: 'finq', key: 'q', cat: 'Финал', label: fc.category || '',
        text: host || settings.phoneText ? fc.q : 'Вопрос — на экране ведущего',
        media: ref ? (host ? ref : describe(ref)) : null, mediaKey: ref ? `fin:${ref === fc.aMedia ? 'a' : 'q'}` : '',
        autoplay: settings.mediaSync === 'all',
      };
      if (f.stage === 'clue') {
        if (f.deadline) v.timer = { deadline: f.deadline, total: settings.finalTimer * 1000 };
        if (usesPhones()) v.chips = chips(f.answers);
      }
      if (f.stage === 'reveal') {
        const myTeam = player(pid)?.teamId;
        v.cards = [...S.teams].sort((a, b) => a.score - b.score).map((t) => {
          const judged = f.judged[t.id];
          const w = f.wagers[t.id] || 0;
          const showWager = judged != null || host || t.id === myTeam;
          const open = f.shown[t.id] || judged != null;
          return {
            name: t.name, color: t.color,
            answer: open ? f.answers[t.id] ?? (usesPhones() ? '' : 'вслух') : null,
            note: judged != null ? `ставка ${fmt(w)} → ${signed(judged ? w : -w)}` : showWager ? `ставка ${fmt(w)}` : 'ставка скрыта',
            cls: judged == null ? '' : judged ? 'good' : 'bad',
          };
        });
        if (f.showAnswer && (host || settings.phoneText)) v.answer = { text: fc.a };
      }
      return v;
    }
    if (S.phase === 'end') return { v: 'end', key: 'end', standings: standingsFor(pid) };
    return { v: 'empty' };
  }

  function boardHint(myTeam, picking, mine) {
    const how = mine ? 'нажми на клетку' : 'скажите ведущему';
    const pk = team(S.picker)?.name;
    const tn = team(S.turn)?.name;
    if (turns() && tn && S.turn !== S.picker) {
      if (picking) return `Вы выбираете вопрос для команды «${tn}» — ${how}`;
      return myTeam === S.turn ? `Ваш ход! Вопрос вам выбирают «${pk}»` : `Ход: ${tn}. Вопрос им выбирают «${pk}»`;
    }
    if (picking) return `${turns() ? 'Ваш ход! ' : ''}Ваша команда выбирает — ${how}`;
    if (!pk) return '';
    return turns() ? `Ход: ${pk}` : `Выбирают ${pk}`;
  }

  function standingsFor(pid) {
    const mine = player(pid)?.teamId;
    return standings().map((t) => ({ name: t.name, color: t.color, score: t.score, me: t.id === mine }));
  }

  function teamsFor(pid) {
    const c = S.clue;
    const f = S.fin;
    const mine = player(pid)?.teamId;
    return S.teams.map((t) => {
      let badge = '';
      const cls = [];
      if (S.phase === 'board') {
        if (turns() && S.turn === t.id) badge = S.picker === t.id ? 'ход · выбирает' : 'ход';
        else if (S.picker === t.id) badge = 'выбирает';
      }
      if (S.phase === 'mini' && S.mini?.win?.team === t.id) badge = `+${fmt(S.mini.bonus)}`;
      if (S.phase === 'clue' && c) {
        if (c.stage === 'mod' && c.mod.team === t.id) { badge = c.mod.kind === 'cat' ? 'отдаёт вопрос' : 'модернизатор'; cls.push('answering'); }
        else if (c.buzzed?.team === t.id) { badge = player(c.buzzed.pid) ? `отвечает ${player(c.buzzed.pid).name}` : 'отвечает'; cls.push('answering'); }
        else if (c.dd && c.ddTeam === t.id && c.stage !== 'answer') { badge = 'ставка'; cls.push('answering'); }
        else if (c.tried.includes(t.id) && c.stage !== 'answer') { badge = 'мимо'; cls.push('out'); }
      }
      if (S.phase === 'final' && f) {
        if (f.stage === 'wager' && f.wagers[t.id] != null) badge = 'ставка ✓';
        if (f.stage === 'clue' && f.answers[t.id] != null) badge = 'ответ ✓';
      }
      if (t.id === mine) cls.push('mine');
      return {
        id: t.id, name: t.name, color: t.color, score: t.score, badge, cls, step: step(),
        members: solo() ? [] : members(t.id).map((p) => ({ id: pid == null ? p.id : undefined, name: p.name, online: !p.phone || p.online })),
        sub: solo() ? '' : members(t.id).length ? '' : usesPhones() ? 'пока никого' : '',
        joinable: pid != null && !solo() && (S.phase === 'lobby' || !team(mine)), mine: t.id === mine,
      };
    });
  }

  function modView(c) {
    const m = c.mod;
    const M = MODS[m.kind];
    return {
      v: 'mod', key: `${c.key}:${m.done ? 1 : 0}`, head: modHead(m.kind), icon: M.icon, name: M.name, desc: M.desc(c.value), team: tinfo(m.team),
      changes: m.changes.map((x) => ({ ...tinfo(x.id), from: x.from, to: x.to })),
      note: m.note, wait: m.done ? '' : `{team} выбирают. ${M.ask}`,
    };
  }

  function miniView(pid) {
    const m = S.mini;
    const g = GAMES[m.game.kind];
    const done = m.stage === 'done';
    const ids = done ? miniRanking(m).map((x) => x.pid) : m.parts;
    const v = {
      v: 'mini', key: `${m.id}:${m.stage}`, icon: g.icon, name: g.name, rule: g.rule, stage: m.stage, bonus: m.bonus,
      rows: ids.map((id) => {
        const p = player(id);
        const t = team(p?.teamId);
        const r = m.res[id];
        return { name: p?.name || '?', color: t?.color || '#999', team: solo() ? '' : t?.name || '', res: done ? resultText(m.game.kind, r) : r ? '✓' : '…', ok: !!r, win: m.win?.pid === id, me: id === pid };
      }),
    };
    if (!done) v.timer = { deadline: m.until, total: m.stage === 'intro' ? INTRO_MS : g.time };
    if (m.win) v.win = { text: `${m.win.name} — {team} +${fmt(m.bonus)}`, team: tinfo(m.win.team) };
    return v;
  }

  // Everything a phone needs: the shared screen plus what only this player should know.
  function playerView(pid) {
    const p = player(pid);
    const t = team(p?.teamId);
    const c = S.clue;
    const f = S.fin;
    const view = viewFor(pid);
    // Phones run their own clock: send the time left, not our deadline.
    if (view.timer) view.timer = { remain: view.timer.deadline - Date.now(), total: view.timer.total };
    const me = { pid, team: t ? { id: t.id, name: t.name, color: t.color } : null, needTeam: !t && !solo(), name: p?.name || '' };
    if (S.phase === 'clue' && c) {
      me.clue = {
        stage: c.stage, openId: c.openId, dd: c.dd, ddMine: c.dd && c.ddTeam === p?.teamId, ddTeam: tinfo(c.ddTeam), wager: c.wager,
        triedMine: !!t && c.tried.includes(t.id), buzzedMine: !!t && c.buzzed?.team === t.id, buzzedTeam: tinfo(c.buzzed?.team),
        buzzedName: player(c.buzzed?.pid)?.name || '', lockedMs: Math.max(0, (locks[pid] || 0) - Date.now()),
        result: c.result ? { mine: c.result.team === t?.id, delta: c.result.delta, ok: c.result.ok, team: tinfo(c.result.team) } : null,
        wagerReq: c.stage === 'ddIntro' && t && c.ddTeam === t.id ? ddRange(t) : null,
        single: !!c.single, only: !!c.only,
      };
      if (c.stage === 'mod') {
        const m = c.mod;
        const M = MODS[m.kind];
        me.clue.mod = {
          name: M.name, icon: M.icon, lbl: m.kind === 'cat' ? `${M.icon} ${M.name}` : `${M.icon} Модернизатор «${M.name}»`, team: tinfo(m.team), done: m.done, mine: m.team === t?.id,
          ask: !m.done && M.target && m.team === t?.id ? { text: M.ask, options: S.teams.filter((x) => x.id !== m.team).map((x) => ({ id: x.id, name: x.name, color: x.color, score: x.score })) } : null,
        };
      }
    }
    if (S.phase === 'mini' && S.mini) {
      const m = S.mini;
      me.mini = {
        id: m.id, game: m.game, stage: m.stage, remain: Math.max(0, m.until - Date.now()), part: m.parts.includes(pid), sent: !!m.res[pid], bonus: m.bonus,
        win: m.win ? { name: m.win.name, team: team(m.win.team)?.name || '', mine: m.win.team === p?.teamId } : null,
        list: m.stage === 'done' ? view.rows.slice(0, 8).map((x) => ({ name: x.name, color: x.color, res: x.res, me: x.me })) : null,
      };
    }
    if (S.phase === 'board' && t) me.turn = turns() && S.turn === t.id;
    if (S.phase === 'final' && f && t) {
      me.fin = { stage: f.stage, max: Math.max(0, t.score), wager: f.wagers[t.id] ?? null, answer: f.answers[t.id] ?? null, judged: f.judged[t.id] ?? null };
    }
    return { t: 'state', phase: S.phase, mode: S.mode, answer: settings.answer, title: board.title, round: S.phase === 'final' ? 'Финал' : R()?.name || '', view, teams: teamsFor(pid), me, teamMode: S.teamMode };
  }

  function hostView() {
    const r = R();
    const c = S.clue;
    const cl = c ? clueAt(c) : null;
    return {
      t: 'hstate', phase: S.phase, title: board.title, mode: S.mode, code: S.code,
      round: r ? {
        name: r.name, cats: r.categories.map((x) => x.name), values: r.values,
        grid: r.categories.map((cat, ci) => cat.clues.map((x, qi) => ({ f: filled(x), u: !!S.used[keyOf(S.round, ci, qi)], d: !!S.dds[keyOf(S.round, ci, qi)], m: x.mod || S.mods?.[keyOf(S.round, ci, qi)] || '' }))),
      } : null,
      clue: c ? { cat: r.categories[c.c].name, value: worth() || c.value, q: cl.q, a: cl.a, stage: c.stage, dd: c.dd, status: statusText() } : null,
      mini: S.phase === 'mini' && S.mini ? { name: `${GAMES[S.mini.game.kind].icon} ${GAMES[S.mini.game.kind].name}`, status: statusText() } : null,
      fin: S.phase === 'final' ? { cat: board.final.category, q: board.final.q, a: board.final.a, stage: S.fin.stage, status: statusText() } : null,
      teams: S.teams.map((t) => ({ id: t.id, name: t.name, color: t.color, score: t.score, online: canPlay(t), members: members(t.id).map((p) => p.name), picker: S.picker === t.id })),
      controls: controls(),
      players: S.players.map((p) => ({ id: p.id, name: p.name, team: solo() ? '' : team(p.teamId)?.name || '', color: team(p.teamId)?.color || '#999', online: !p.phone || p.online })),
      canUndo: hist.length > 0,
      locked: !!S.locked,
    };
  }

  // The media phones show right now (it gets sent first).
  function phoneRef() {
    const c = S.clue;
    if (S.phase === 'clue' && c && c.stage !== 'ddIntro') {
      const cl = clueAt(c);
      return phonePick(cl.media, cl.aMedia, c.stage === 'answer');
    }
    if (S.phase === 'final' && S.fin && S.fin.stage !== 'wager') {
      const fc = board.final;
      return phonePick(fc.media, fc.aMedia, S.fin.showAnswer);
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
    else if (['board', 'clue', 'roundEnd', 'mini'].includes(S.phase)) add(S.round);
    if (S.phase === 'roundEnd') add(nextRoundIndex());
    if (finalReady(board) && S.phase !== 'end') out.push(board.final.media, board.final.aMedia);
    return out.filter(forPhones);
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

  // ---------- jump scare (js/screamer.js) ----------
  // Now and then, while a fresh question is being read, Foxy jumps out on one random player's phone.
  // Never in the first couple of questions or twice in a row. No phones, no scare.
  let picksSinceScare = 0;
  function maybeScare() {
    if (++picksSinceScare < 3 || !(Math.random() < (screamer.CHANCE[settings.scare] || 0))) return;
    scareOne();
  }
  function scareOne(delay = 1200 + Math.random() * 1800) {
    const phones = net ? [...conns.values()].filter((c) => c.open) : [];
    if (!phones.length) return;
    picksSinceScare = 0;
    net.send(phones[Math.floor(Math.random() * phones.length)], { t: 'scare', delay });
  }

  // ---------- mini-games (js/minigames.js) ----------
  // Rarely, after a question, everyone with a phone plays something tiny; the best gets bonus points
  // for their team. Needs players of at least two teams online, so it is a real contest.
  let cluesSinceMini = 0;
  const miniPlayers = () => S.players.filter((p) => p.phone && p.online && conns.has(p.id) && team(p.teamId));
  function maybeMini() {
    cluesSinceMini++;
    const chance = MINI_CHANCE[settings.mini];
    if (!chance || !usesPhones() || !['board', 'roundEnd'].includes(S.phase)) return;
    if (cluesSinceMini < MINI_GAP[settings.mini] || Math.random() >= chance) return;
    if (new Set(miniPlayers().map((p) => p.teamId)).size < 2) return;
    startMini();
  }
  function startMini(kind) {
    const ps = miniPlayers();
    if (!ps.length) return toast('Для мини-игры нужны игроки с телефонами');
    snapshot();
    cluesSinceMini = 0;
    S.mini = { id: uid('m'), game: newGame(kind), stage: 'intro', until: Date.now() + INTRO_MS, parts: ps.map((p) => p.id), res: {}, bonus: bonus(), after: S.phase, win: null };
    S.phase = 'mini';
    sfx('dd');
  }
  const miniAllIn = (m) => m.parts.every((id) => m.res[id] || !conns.has(id));
  function onMini(pid, d) {
    const m = S.mini;
    if (S.phase !== 'mini' || !m || d.id !== m.id || m.stage !== 'play' || !m.parts.includes(pid) || m.res[pid]) return;
    m.res[pid] = { val: clamp(Math.round(+d.val || 0), 0, 600000), ok: !!d.ok, why: String(d.why || '').slice(0, 10) };
    if (miniAllIn(m)) finishMini();
    commit();
  }
  function miniRanking(m) {
    return m.parts.map((pid) => ({ pid, s: scoreOf(m.game.kind, m.res[pid]) }))
      .sort((a, b) => (a.s == null) - (b.s == null) || (a.s ?? 0) - (b.s ?? 0));
  }
  function finishMini() {
    const m = S.mini;
    if (m.stage === 'done') return;
    m.stage = 'done';
    const best = miniRanking(m)[0];
    const p = best && best.s != null ? player(best.pid) : null;
    if (p && team(p.teamId)) {
      addScore(p.teamId, m.bonus);
      m.win = { pid: p.id, team: p.teamId, name: p.name };
      sfx('correct');
    } else sfx('wrong');
    log({ k: 'mini', game: m.game.kind, team: m.win?.team || null, by: m.win?.name || '', delta: m.win ? m.bonus : 0, scores: scoreMap() });
  }
  // Called by the clock: intro → play → done.
  function miniTick(now) {
    const m = S.mini;
    if (m.stage === 'intro' && now >= m.until) {
      m.stage = 'play';
      m.until = now + GAMES[m.game.kind].time;
      sfx('open');
      return true;
    }
    if (m.stage === 'play' && (now >= m.until || miniAllIn(m))) { finishMini(); return true; }
    return false;
  }

  // ---------- host window on this computer ----------
  // Shows the answers in a separate browser window: share only the game window in Discord
  // and the players never see them.
  let chan = null;
  let hostWinSeen = 0;
  let hostWinShown = false;
  const hostWinOpen = () => Date.now() - hostWinSeen < 5000;
  const hostWinUrl = () => new URL(`join/?k=${S.hostKey}&local=1`, pageUrl()).href;

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
    if (!settings.shared) { settings.shared = true; saveSettings(); commit(); }
    toast('В Discord показывай только окно с игрой, а не весь экран');
  }

  function commit() {
    if (destroyed) return;
    if (S.gameId && !['setup', 'lobby'].includes(S.phase)) scheduleHistory();
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
      if (f.stage === 'wager') return `Ставки: ${Object.keys(f.wagers).length} из ${S.teams.length}`;
      if (f.stage === 'clue') return `Ответы: ${Object.keys(f.answers).length} из ${S.teams.length}`;
      return 'Проверяем ответы';
    }
    if (S.phase === 'mini' && S.mini) return `Мини-игра «${GAMES[S.mini.game.kind].name}»${S.mini.stage === 'done' ? ': итоги' : ''}`;
    if (!c) return '';
    switch (c.stage) {
      case 'mod': return `${c.mod.kind === 'cat' ? 'Секретный вопрос' : `Модернизатор «${MODS[c.mod.kind].name}»`}${c.mod.done ? '' : `: выбирают ${team(c.mod.team)?.name || '…'}`}`;
      case 'ddIntro': return `Вопрос-ставка! Отвечают ${team(c.ddTeam)?.name || '…'}`;
      case 'reading': return c.dd ? `${team(c.ddTeam)?.name}: ставка ${fmt(c.wager)}` : usesPhones() ? 'Кнопки закрыты' : 'Кто ответит?';
      case 'open': return 'Кнопки открыты — жмите!';
      case 'buzzed': return `Отвечают ${team(c.buzzed?.team)?.name}${player(c.buzzed?.pid) ? ` (${player(c.buzzed.pid).name})` : ''}`;
      case 'answer': return c.result ? `${team(c.result.team)?.name}: ${signed(c.result.delta)}` : 'Никто не ответил';
    }
    return '';
  }

  function controls() {
    const c = S.clue;
    if (S.phase === 'clue' && c) {
      const v = worth();
      switch (c.stage) {
        case 'mod': {
          const m = c.mod;
          if (m.done) return [{ items: [{ label: hasQ(clueAt(c)) ? 'К вопросу →' : 'Дальше', act: 'modNext', cls: 'primary big', key: 'Пробел' }] }];
          const t = team(m.team);
          return [
            { title: `${MODS[m.kind].ask} Выбирают ${t?.name || '…'}${t && withPhones(t) ? ' — с телефона, или нажми за них' : ''}`, items: S.teams.filter((x) => x.id !== m.team).map((x) => ({ label: x.name, act: 'modTarget', args: { team: x.id }, cls: 'chip' })) },
            { items: [{ label: '🎲 Случайно', act: 'modTarget', args: { random: true }, cls: 'ghost' }] },
          ];
        }
        case 'ddIntro': {
          const t = team(c.ddTeam);
          const rows = [{ title: 'Кто отвечает?', items: S.teams.map((x) => ({ label: x.name, act: 'ddTeam', args: { team: x.id }, cls: 'chip' + (x.id === c.ddTeam ? ' sel' : '') })) }];
          if (t) {
            const { min, max } = ddRange(t);
            rows.push({
              title: withPhones(t) ? `Ставка ${t.name} (${fmt(min)}–${fmt(max)}) — ждём с телефона или введи сам` : `Ставка ${t.name} (${fmt(min)}–${fmt(max)})`,
              items: [{ type: 'wager', act: 'ddWager', min, max, value: Math.min(max, c.value), label: 'Принять' }],
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
            ...S.teams.map((t) => ({
              title: t.name, inline: true,
              items: [
                { label: `✓ +${fmt(v)}`, act: 'correct', args: { team: t.id }, cls: 'green', disabled: c.tried.includes(t.id) },
                { label: `✗ −${fmt(v)}`, act: 'wrong', args: { team: t.id }, cls: 'red', disabled: c.tried.includes(t.id) },
              ],
            })),
            { items: [{ label: 'Показать ответ', act: 'reveal', cls: 'ghost', key: 'N' }] },
          ];
        case 'open': {
          const el = eligible();
          const rows = [];
          if (el.some((t) => !withPhones(t))) rows.push({ title: 'Кто поднял руку?', items: el.map((t) => ({ label: t.name, act: 'manualBuzz', args: { team: t.id }, cls: 'chip' })) });
          rows.push({ items: [{ label: 'Никто не знает — показать ответ', act: 'reveal', cls: 'ghost', key: 'N' }] });
          return rows;
        }
        case 'buzzed': {
          const pen = penalty();
          return [
            { items: [{ label: `Верно +${fmt(v)}`, act: 'correct', cls: 'green big' }, { label: pen ? `Неверно −${fmt(pen)}` : 'Неверно', act: 'wrong', cls: 'red big' }] },
            { items: [{ label: c.single ? 'Не знают — показать ответ' : 'Никто не знает', act: 'reveal', cls: 'ghost', key: 'N' }] },
          ];
        }
        case 'answer':
          return [{ items: [{ label: 'Продолжить', act: 'cont', cls: 'primary big', key: 'Пробел' }] }];
      }
    }
    if (S.phase === 'roundEnd') {
      const nx = nextRoundIndex();
      const label = nx >= 0 ? `Дальше: ${board.rounds[nx].name}` : finalReady(board) && S.teams.length ? 'Финальный вопрос' : 'Итоги';
      return [{ items: [{ label, act: 'nextRound', cls: 'primary big', key: 'Пробел' }] }];
    }
    if (S.phase === 'final') {
      const f = S.fin;
      if (f.stage === 'wager') {
        const rows = S.teams.filter((t) => !withPhones(t) || !usesPhones()).map((t) => ({
          title: `${t.name}${f.wagers[t.id] != null ? ` — ${fmt(f.wagers[t.id])}` : ''}`, inline: true,
          items: [{ type: 'wager', act: 'finWager', args: { team: t.id }, min: 0, max: Math.max(0, t.score), value: f.wagers[t.id] ?? '', label: 'OK' }],
        }));
        rows.push({ items: [{ label: 'Показать вопрос', act: 'finClue', cls: 'primary big' }] });
        return rows;
      }
      if (f.stage === 'clue') return [{ items: [{ label: 'Смотреть ответы', act: 'finReveal', cls: 'primary big' }] }];
      if (f.stage === 'reveal') {
        const rows = [...S.teams].sort((a, b) => a.score - b.score).map((t) => {
          const w = f.wagers[t.id] || 0;
          const ans = f.answers[t.id];
          const typed = usesPhones() && withPhones(t) || ans != null;
          let title = t.name;
          let items;
          if (typed && !f.shown[t.id]) items = [{ label: 'Показать ответ', act: 'finShow', args: { team: t.id } }];
          else {
            if (typed) title += `: «${ans || '—'}»`;
            if (f.judged[t.id] == null) items = [{ label: '✓', act: 'finJudge', args: { team: t.id, ok: true }, cls: 'green' }, { label: '✗', act: 'finJudge', args: { team: t.id, ok: false }, cls: 'red' }];
            else items = [{ type: 'note', text: `${signed(f.judged[t.id] ? w : -w)}` }];
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
    if (S.phase === 'mini' && S.mini) {
      return S.mini.stage === 'done'
        ? [{ items: [{ label: 'Продолжить', act: 'miniEnd', cls: 'primary big', key: 'Пробел' }] }]
        : [{ items: [{ label: 'Пропустить мини-игру', act: 'miniEnd', cls: 'ghost' }] }];
    }
    if (S.phase === 'end') return [{ items: [{ label: 'Сыграть ещё раз', act: 'replay', cls: 'primary big' }] }];
    return [];
  }

  // The host's side panel: correct answer plus the buttons that run the game.
  function hostPanel() {
    const c = S.clue;
    const hidden = settings.shared;
    if (S.phase === 'board') {
      const how = settings.phonePick ? 'Кликни по клетке за них — или дождись, пока выберут у себя.' : 'Кликни по клетке, которую назовут.';
      if (!team(S.picker)) return { kind: 'host', lbl: 'Ход игры', text: 'Кликни по клетке.', controls: [] };
      if (turns() && team(S.turn) && S.turn !== S.picker) {
        return { kind: 'host', lbl: 'Ход игры', text: `Ход: {team}. Вопрос им выбирают {team2} — за верный ответ. ${how}`, team: tinfo(S.turn), team2: tinfo(S.picker), controls: [] };
      }
      return { kind: 'host', lbl: 'Ход игры', text: `${turns() ? 'Ход: {team}, сами выбирают вопрос.' : 'Выбирают {team}.'} ${how}`, team: tinfo(S.picker), controls: [] };
    }
    if (S.phase === 'mini' && S.mini) {
      const m = S.mini;
      const text = m.stage === 'intro' ? 'Сейчас начнётся — смотрите в телефоны.' : m.stage === 'play' ? `Играют: ${Object.keys(m.res).length} из ${m.parts.length} уже готовы.` : m.win ? `Победа: ${m.win.name}, +${fmt(m.bonus)} команде {team}.` : 'Никто не справился — очки никому.';
      return { kind: 'host', lbl: `Мини-игра · ${GAMES[m.game.kind].name}`, text, team: tinfo(m.win?.team), controls: controls() };
    }
    if (S.phase === 'clue' && c) {
      const cl = clueAt(c);
      return { kind: 'host', answer: c.stage === 'answer' || !hasQ(cl) ? null : cl.a, hidden, status: c.stage === 'answer' ? statusText() : '', controls: controls() };
    }
    if (S.phase === 'final' && S.fin) {
      const f = S.fin;
      return { kind: 'host', lbl: f.stage === 'wager' ? 'Финал: ставки' : '', answer: f.stage === 'wager' || f.showAnswer ? null : board.final.a, hidden, status: statusText(), controls: controls() };
    }
    return { kind: 'host', controls: controls() };
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
    unmountScreen();
    root.className = 'page-play-setup';
    root.innerHTML = `
      <div class="page center narrow">
        <a class="back-link" href="#/">← Мои игры</a>
        <h1 class="page-title">${esc(board.title)}</h1>
        <p class="muted">Как будем играть?</p>
        <div class="modes">
          <button class="mode-card" data-mode="simple">
            <b>Простой</b><span class="mode-sub">Один экран, ведущий — ты</span>
            <span class="muted">Выводишь доску на телевизор, читаешь вопросы, сам отмечаешь, какая команда ответила.</span>
          </button>
          <button class="mode-card hot" data-mode="buzzer">
            <b>С кнопками</b><span class="mode-sub">Каждый со своего телефона или компьютера</span>
            <span class="muted">Игроки заходят по коду или QR, видят доску и вопросы у себя и жмут первыми.</span>
          </button>
        </div>
        <a class="btn small" href="test/?board=${esc(board.id)}">🧪 Проверить одному на тест-стенде</a>
        <div class="settings-card" style="margin-top:16px">${settingsHTML()}</div>
        <p class="muted small">Очки — просто очки. Никто никому ничего не платит.</p>
      </div>`;
    bindSettings(root);
    root.querySelectorAll('[data-mode]').forEach((b) => b.addEventListener('click', () => chooseMode(b.dataset.mode)));
  }

  function settingsHTML() {
    const opt = (v, cur, label) => `<option value="${v}" ${String(cur) === String(v) ? 'selected' : ''}>${label}</option>`;
    return `
      <label class="set-row"><span>Экран ведущего <small class="muted">(«общий» — если его видят игроки: на телевизоре или в трансляции. Тогда ответ скрыт)</small></span><select class="input small" data-set="shared" data-bool>${opt(false, settings.shared, 'Свой')}${opt(true, settings.shared, 'Общий')}</select></label>
      <label class="set-row"><span>Кто отвечает <small class="muted">(«по очереди» — команды отвечают по кругу, без кнопок; ответили верно — выбираете вопрос следующей команде)</small></span><select class="input small" data-set="answer" data-str>${opt('buzz', settings.answer, 'кто быстрее')}${opt('turns', settings.answer, 'по очереди')}</select></label>
      <label class="set-row"><span>Минус за ошибку «по очереди» <small class="muted">(иначе неверный ответ просто 0)</small></span><input type="checkbox" data-set="turnMinus" ${settings.turnMinus ? 'checked' : ''}></label>
      <label class="set-row"><span>Секретные вопросы 🤫 <small class="muted">(случайная клетка: кто её откроет — не глядя отдаёт вопрос другой команде, очки только у отвечающих)</small></span><select class="input small" data-set="secret" data-str>${opt('off', settings.secret, 'выкл')}${opt('one', settings.secret, '1 за раунд')}${opt('two', settings.secret, '2 за раунд')}</select></label>
      <label class="set-row"><span>Случайные модернизаторы <small class="muted">(клетки-сюрпризы: меняют счёт. Свои можно поставить на любую клетку в редакторе)</small></span><select class="input small" data-set="mods" data-str>${opt('off', settings.mods, 'выкл')}${opt('few', settings.mods, '1 за раунд')}${opt('many', settings.mods, '3 за раунд')}</select></label>
      <label class="set-row"><span>Мини-игры 🎮 <small class="muted">(иногда между вопросами — быстрая игра на телефонах за доп. очки)</small></span><select class="input small" data-set="mini" data-str>${opt('off', settings.mini, 'выкл')}${opt('rare', settings.mini, 'редко')}${opt('often', settings.mini, 'часто')}</select></label>
      <label class="set-row"><span>Игроки сами выбирают вопрос <small class="muted">(команда, чей ход, жмёт клетку у себя на телефоне. Выключи — и выбирать будет только ведущий)</small></span><input type="checkbox" data-set="phonePick" ${settings.phonePick ? 'checked' : ''}></label>
      <label class="set-row"><span>Вопросы-ставки <small class="muted">(случайные клетки, где можно поставить свои очки)</small></span><input type="checkbox" data-set="dd" ${settings.dd ? 'checked' : ''}></label>
      <label class="set-row"><span>Таймер на ответ</span><select class="input small" data-set="timer">${[0, 10, 15, 20, 30, 45].map((v) => opt(v, settings.timer, v ? `${v} сек` : 'выкл')).join('')}</select></label>
      <label class="set-row"><span>Таймер в финале</span><select class="input small" data-set="finalTimer">${[0, 30, 45, 60, 90].map((v) => opt(v, settings.finalTimer, v ? `${v} сек` : 'выкл')).join('')}</select></label>
      <label class="set-row"><span>Видео и музыка</span><select class="input small" data-set="mediaSync" data-str>${opt('all', settings.mediaSync, 'запускать у всех')}${opt('self', settings.mediaSync, 'каждый жмёт сам')}</select></label>
      <label class="set-row"><span>Картинки, видео и аудио у игроков</span><input type="checkbox" data-set="phoneMedia" ${settings.phoneMedia ? 'checked' : ''}></label>
      <label class="set-row"><span>Текст вопроса и ответ у игроков</span><input type="checkbox" data-set="phoneText" ${settings.phoneText ? 'checked' : ''}></label>
      <label class="set-row"><span>Звуки</span><input type="checkbox" data-set="sound" ${settings.sound ? 'checked' : ''}></label>
      <label class="set-row"><span>Штраф за фальстарт <small class="muted">(нажал раньше времени — кнопка блокируется на 1 сек)</small></span><input type="checkbox" data-set="penalty" ${settings.penalty ? 'checked' : ''}></label>
      <label class="set-row"><span>Скример 👻 <small class="muted">(иногда, пока читают вопрос, выскакивает на телефоне у одного случайного игрока. И в редакторе досок тоже)</small></span><select class="input small" data-set="scare" data-str>${opt('off', settings.scare, 'выкл')}${opt('rare', settings.scare, 'редко')}${opt('often', settings.scare, 'часто')}</select></label>`;
  }
  function bindSettings(el) {
    el.querySelectorAll('[data-set]').forEach((i) => i.addEventListener('change', () => {
      const k = i.dataset.set;
      settings[k] = i.type === 'checkbox' ? i.checked : 'bool' in i.dataset ? i.value === 'true' : 'str' in i.dataset ? i.value : +i.value;
      sound.on = settings.sound;
      saveSettings();
      if (S && k === 'answer' && turns() && !team(S.turn)) S.turn = S.picker;
      if (S && (k === 'mods' || k === 'secret') && ['board', 'clue'].includes(S.phase)) placeMods();
      if (S && S.phase !== 'setup') commit();
    }));
  }

  async function chooseMode(mode) {
    unlock();
    S.mode = mode;
    if (!S.teams.length) { newTeam(); newTeam(); }
    if (mode === 'buzzer') {
      const box = $('.modes', root);
      if (box) box.innerHTML = `<div class="connecting"><div class="spinner"></div>Создаём комнату…</div>`;
      try {
        await startNet();
      } catch (e) {
        if (!box) throw e;
        box.innerHTML = `<div class="err-card"><b>Не получилось создать комнату</b><p>${esc(errText(e))}</p>
          <button class="btn" data-retry>Попробовать снова</button> <button class="btn ghost" data-simple>Играть в простом режиме</button></div>`;
        box.querySelector('[data-retry]').onclick = () => chooseMode('buzzer');
        box.querySelector('[data-simple]').onclick = () => chooseMode('simple');
        return;
      }
    }
    S.phase = 'lobby';
    commit();
    if (autotest && S.code) parent.postMessage({ plyukh: 'room', code: S.code }, location.origin);
  }

  async function startNet(code) {
    net = new Host({ onData, onClose });
    sender = new MediaSender((c, m) => net.send(c, m));
    S.code = await net.start(code);
    if (code && S.code !== code) toast(`Новый код комнаты: ${S.code}. Игрокам нужно зайти заново`, 'warn');
  }

  // ---------- lobby: players and teams ----------
  function renderLobby() {
    if (mounted !== 'lobby') {
      mounted = 'lobby';
      unmountScreen();
      root.className = 'page-lobby';
      const phones = usesPhones();
      const base = new URL('join/', pageUrl());
      root.innerHTML = `
        <div class="page center narrow">
          <a class="back-link" href="#/">← Мои игры</a>
          <h1 class="page-title">${esc(board.title)}</h1>
          <p class="muted">${phones ? 'Собираем игроков' : 'Кто играет?'}</p>
          ${phones ? `
            <p class="join-hint">Наведи камеру на QR-код или открой <b>${esc(base.host + base.pathname)}</b> и введи код</p>
            <div class="room-code">${esc(S.code)}</div>
            <div class="qr-big">${qrSvg(joinUrl())}</div>
            <button class="link-btn" data-copy="join">Скопировать ссылку для входа</button>
            <button class="link-btn lock-btn" data-lock></button>
            <div class="remote-card">
              <div><b>Пульт ведущего на телефоне</b><p class="muted small">Видишь правильные ответы и управляешь игрой со своего телефона. QR пульта откроется отдельно — чтобы игроки его не увидели.</p>
              <button class="btn small" data-remote>Показать QR пульта</button> <button class="link-btn" data-copy="remote">Скопировать ссылку</button></div>
            </div>
            <div class="team-mode"><button class="btn small" data-tm="teams">Команды</button><button class="btn small" data-tm="solo">Каждый сам за себя</button></div>` : ''}
          <div class="team-mode"><button class="btn small" data-am="buzz">⚡ Кто быстрее</button><button class="btn small" data-am="turns">🔁 По очереди</button></div>
          <p class="muted small am-hint"></p>
          <div class="lobby-teams"></div>
          <p class="muted small lobby-tip" hidden>Нажми на имя игрока, чтобы перевести его в другую команду или выгнать.</p>
          <div class="lobby-free"></div>
          <form class="add-player">
            <input class="input" maxlength="24" placeholder="Название команды">
            <button class="btn">+ Команда</button>
          </form>
          <button class="btn primary big wide" data-start></button>
        </div>`;
      root.querySelectorAll('[data-copy]').forEach((b) => b.addEventListener('click', () => copyText(b.dataset.copy === 'join' ? joinUrl() : remoteUrl())));
      $('[data-remote]', root)?.addEventListener('click', showRemoteQR);
      $('[data-lock]', root)?.addEventListener('click', () => act('lock'));
      $('.add-player', root).addEventListener('submit', (e) => {
        e.preventDefault();
        const i = $('.add-player input', root);
        newTeam(i.value.trim() || undefined);
        i.value = '';
        commit();
      });
      root.querySelectorAll('[data-tm]').forEach((b) => b.addEventListener('click', () => setTeamMode(b.dataset.tm)));
      root.querySelectorAll('[data-am]').forEach((b) => b.addEventListener('click', () => { settings.answer = b.dataset.am; saveSettings(); commit(); }));
      $('[data-start]', root).addEventListener('click', () => {
        unlock();
        if (!S.teams.length) return toast('Добавь хотя бы одну команду');
        if (usesPhones() && !S.players.length) return toast('Ждём хотя бы одного игрока');
        if (firstRound() < 0) return toast('В этой игре ещё нет вопросов — заполни доску в редакторе');
        if (!solo()) S.teams = S.teams.filter((t) => members(t.id).length || !usesPhones() || S.teams.length <= 1);
        beginGame();
        commit();
      });
      root.addEventListener('click', (e) => {
        const r = e.target.closest('[data-trename]');
        if (r) return renameTeam(r.dataset.trename);
        const d = e.target.closest('[data-tdel]');
        if (d) { removeTeam(d.dataset.tdel); return commit(); }
        const p = e.target.closest('[data-pmenu]');
        if (p) return playerMenu(p.dataset.pmenu);
      });
    }
    root.querySelectorAll('[data-tm]').forEach((b) => b.classList.toggle('primary', b.dataset.tm === S.teamMode));
    const lockBtn = $('[data-lock]', root);
    if (lockBtn) lockBtn.textContent = S.locked ? '🔒 Комната закрыта — открыть' : '🔒 Закрыть комнату';
    root.querySelectorAll('[data-am]').forEach((b) => b.classList.toggle('primary', b.dataset.am === settings.answer));
    $('.am-hint', root).textContent = turns()
      ? 'Команды отвечают по кругу, кнопки не нужны. Ответили верно — выбираете вопрос для следующей команды.'
      : usesPhones() ? 'Отвечает тот, кто первым нажмёт кнопку на телефоне.' : 'Отвечает тот, кто первым поднимет руку, — ты отмечаешь.';
    $('.add-player', root).hidden = solo();
    const chip = (p) => `<button type="button" class="lp-chip ${p.phone && !p.online ? 'off' : ''}" data-pmenu="${esc(p.id)}">${p.phone ? `<span class="dot ${p.online ? 'on' : 'off'}"></span>` : ''}${esc(p.name)}</button>`;
    setHTML($('.lobby-teams', root), S.teams.length ? S.teams.map((t) => `
      <div class="lt" style="--tc:${t.color}">
        <span class="lt-dot"></span>
        <div class="lt-main">
          <button type="button" class="lt-name" data-trename="${esc(t.id)}" title="Переименовать">${esc(t.name)}</button>
          ${solo() ? '' : `<div class="lt-members">${members(t.id).map(chip).join('') || `<span class="muted small">${usesPhones() ? 'игроки выбирают команду на телефоне' : 'команда без телефонов'}</span>`}</div>`}
        </div>
        ${solo() && members(t.id)[0] ? `<button type="button" class="icon-btn" data-pmenu="${esc(members(t.id)[0].id)}" title="Выгнать игрока">×</button>` : `<button type="button" class="icon-btn" data-tdel="${esc(t.id)}" title="Убрать команду">×</button>`}
      </div>`).join('') : `<div class="lp empty muted">${usesPhones() ? 'Пока никого… ждём игроков' : 'Добавь команды ниже'}</div>`);
    $('.lobby-tip', root).hidden = !S.players.length;
    if (solo()) $('.lobby-tip', root).textContent = 'Чтобы выгнать игрока, нажми × рядом с ним.';
    else $('.lobby-tip', root).textContent = 'Нажми на имя игрока, чтобы перевести его в другую команду или выгнать.';
    const free = S.players.filter((p) => !team(p.teamId));
    setHTML($('.lobby-free', root), free.length && !solo() ? `<div class="muted small">Ещё не выбрали команду:</div><div class="lt-members">${free.map(chip).join('')}</div>` : '');
    const n = solo() ? S.teams.length : S.players.length;
    $('[data-start]', root).textContent = usesPhones()
      ? `Начать игру (${n} ${plural(n, 'игрок', 'игрока', 'игроков')}${solo() ? '' : `, ${S.teams.length} ${plural(S.teams.length, 'команда', 'команды', 'команд')}`})`
      : `Начать игру (${S.teams.length} ${plural(S.teams.length, 'команда', 'команды', 'команд')})`;
  }

  function setTeamMode(mode) {
    if (S.teamMode === mode) return;
    S.teamMode = mode;
    S.teams = [];
    for (const p of S.players) p.teamId = null;
    if (mode === 'solo') for (const p of S.players) soloTeam(p);
    else { newTeam(); newTeam(); }
    commit();
  }

  async function renameTeam(tid) {
    const t = team(tid);
    if (!t) return;
    const v = await promptDlg('Название команды', t.name);
    if (v && v.trim()) { t.name = v.trim().slice(0, 24); commit(); }
  }

  // ---------- the game screen ----------
  function unmountScreen() {
    screen?.destroy();
    screen = null;
  }

  function mountGame() {
    mounted = 'game';
    root.className = 'page-game';
    root.innerHTML = '';
    screen = createScreen(root, {
      role: 'host',
      on: onScreen,
      mediaNode: (ref, autoplay) => mediaEl(ref, { autoplay }),
      settings: () => ({ html: settingsHTML(), bind: bindSettings }),
      links: () => [
        { name: 'hostwin', label: '👁 Окно ведущего (для трансляции)' },
        ...(usesPhones() ? [{ name: 'remote', label: '📱 Пульт на телефоне (QR)' }] : []),
        ...(usesPhones() ? [{ name: 'lock', label: S.locked ? '🔓 Открыть комнату' : '🔒 Закрыть комнату — новые не зайдут' }] : []),
        ...(usesPhones() ? [{ name: 'players', label: '👥 Игроки — выгнать или перевести' }] : []),
        { name: 'addTeam', label: '+ Добавить команду' },
        ...(usesPhones() && S.phase === 'board' ? [{ name: 'mini', label: '🎮 Мини-игра прямо сейчас' }] : []),
        ...(['board', 'clue'].includes(S.phase) ? [{ name: 'endRound', label: 'Завершить раунд досрочно' }] : []),
        { name: 'exit', label: 'Выйти на главную' },
        { name: 'restart', label: 'Начать заново', cls: 'danger' },
      ],
    });
  }

  function renderGame() {
    if (mounted !== 'game' || !screen) mountGame();
    screen.update({
      title: board.title,
      round: S.phase === 'final' ? 'Финал' : R()?.name || '',
      tools: { code: usesPhones() ? S.code : null, locked: !!S.locked, canUndo: hist.length > 0, shared: settings.shared },
      view: viewFor(null),
      teams: teamsFor(null),
      panel: hostPanel(),
    });
  }

  async function onScreen(type, d = {}) {
    switch (type) {
      case 'pick': return act('pick', d);
      case 'act': return act(d.a, d.args);
      case 'adj': return act('adj', { team: d.team, delta: d.delta });
      case 'teamMenu': return teamMenu(d.team);
      case 'playerMenu': return playerMenu(d.pid);
      case 'tool':
        if (d.name === 'code') return showQR();
        if (d.name === 'undo') return act('undo');
        if (d.name === 'full') return toggleFullscreen();
        if (d.name === 'exit') return exitGame();
        if (d.name === 'shared') { settings.shared = !settings.shared; saveSettings(); toast(settings.shared ? 'Общий экран: ответы скрыты' : 'Свой экран: ответы видны'); return commit(); }
        return;
      case 'link':
        if (d.name === 'hostwin') return openHostWindow();
        if (d.name === 'remote') return showRemoteQR();
        if (d.name === 'mini') return act('mini');
        if (d.name === 'players') return playersDialog();
        if (d.name === 'lock') return act('lock');
        if (d.name === 'addTeam') {
          const name = await promptDlg('Название команды', '', { placeholder: 'Например, Котики' });
          if (name != null) { newTeam(name.trim() || undefined); if (!team(S.picker)) S.picker = S.teams[0].id; commit(); }
          return;
        }
        if (d.name === 'endRound' && (await confirmDlg('Закончить раунд? Оставшиеся вопросы пропадут.', 'Закончить'))) return act('endRound');
        if (d.name === 'exit') return exitGame();
        if (d.name === 'restart' && (await confirmDlg('Начать игру заново? Все очки обнулятся.', 'Заново', true))) {
          hist = [];
          beginGame();
          commit();
        }
    }
  }

  async function exitGame() {
    if (autotest || (await confirmDlg('Выйти из игры? Её можно будет продолжить позже с того же места.', 'Выйти'))) location.hash = '#/';
  }

  function toggleFullscreen() {
    if (document.fullscreenElement) document.exitFullscreen?.();
    else document.documentElement.requestFullscreen?.().catch(() => {});
  }

  async function showQR() {
    const r = await dialog({
      cls: 'qr-dlg',
      html: `<div class="room-code">${esc(S.code)}</div>${S.locked ? '<p class="lock-note">🔒 Комната закрыта: новые игроки не зайдут, пока ты её не откроешь</p>' : ''}<div class="qr-big">${qrSvg(joinUrl())}</div><p class="muted">${esc(joinUrl())}</p>`,
      buttons: [
        { label: 'Скопировать ссылку', value: () => { copyText(joinUrl()); } },
        { label: S.locked ? '🔓 Открыть комнату' : '🔒 Закрыть комнату', value: 'lock' },
        { label: 'Готово', value: true, cls: 'primary' },
      ],
    });
    if (r === 'lock') act('lock');
  }

  function showRemoteQR() {
    dialog({
      title: 'Пульт ведущего',
      cls: 'qr-dlg',
      html: `<div class="qr-big">${qrSvg(remoteUrl())}</div><p class="muted">Отсканируй своим телефоном: увидишь правильные ответы и сможешь управлять игрой. Не показывай этот код игрокам.</p>`,
      buttons: [{ label: 'Скопировать ссылку', value: () => { copyText(remoteUrl()); } }, { label: 'Закрыть', value: true, cls: 'primary' }],
    });
  }

  async function teamMenu(tid) {
    const t = team(tid);
    if (!t) return;
    const m = members(tid);
    const r = await dialog({
      title: t.name,
      html: `<p class="muted">Очки: ${fmt(t.score)}${m.length ? ` · ${m.map((p) => esc(p.name)).join(', ')}` : ''}</p>`,
      cls: 'menu-dlg',
      buttons: [
        { label: 'Сейчас выбирают они', value: 'picker' },
        { label: 'Изменить очки', value: 'score' },
        { label: 'Переименовать', value: 'rename' },
        ...m.map((p) => ({ label: `Игрок: ${p.name}…`, value: `p:${p.id}` })),
        { label: 'Убрать команду', value: 'del', cls: 'danger' },
        { label: 'Закрыть', value: null, cls: 'ghost' },
      ],
    });
    if (r === 'picker') act('setPicker', { team: tid });
    if (r === 'score') {
      const v = await promptDlg(`Очки: ${t.name}`, t.score, { type: 'number' });
      if (v != null && v !== '') act('setScore', { team: tid, value: +v });
    }
    if (r === 'rename') renameTeam(tid);
    if (r?.startsWith?.('p:')) playerMenu(r.slice(2));
    if (r === 'del' && (await confirmDlg(`Убрать команду «${t.name}»? Её игроки останутся без команды.`, 'Убрать', true))) { removeTeam(tid); commit(); }
  }

  async function playerMenu(pid) {
    const p = player(pid);
    if (!p) return;
    const r = await dialog({
      title: p.name,
      html: `<p class="muted">${p.phone ? (p.online ? 'на связи' : 'не на связи') : 'без телефона'}${team(p.teamId) ? ` · ${esc(team(p.teamId).name)}` : ''}</p>`,
      cls: 'menu-dlg',
      buttons: [
        ...(solo() ? [] : S.teams.filter((t) => t.id !== p.teamId).map((t) => ({ label: `→ В команду «${t.name}»`, value: `t:${t.id}` }))),
        { label: 'Выгнать', value: 'kick', cls: 'danger' },
        { label: 'Выгнать и не пускать обратно', value: 'ban', cls: 'danger' },
        { label: 'Закрыть', value: null, cls: 'ghost' },
      ],
    });
    if (r?.startsWith?.('t:')) { p.teamId = r.slice(2); commit(); }
    if (r === 'kick' && (await confirmDlg(`Выгнать ${p.name}? Очки команды останутся, а зайти снова можно по коду комнаты.`, 'Выгнать', true))) act('kick', { pid });
    if (r === 'ban' && (await confirmDlg(`Выгнать ${p.name} и больше не пускать в эту игру?`, 'Выгнать', true))) act('kick', { pid, ban: true });
  }

  // Everyone in the room, to move or kick them during the game (⚙ → «Игроки»).
  async function playersDialog() {
    if (!S.players.length) return toast('Пока никто не зашёл');
    const row = (p) => {
      const t = team(p.teamId);
      const st = p.phone ? (p.online ? 'на связи' : 'не на связи') : 'без телефона';
      return `<button type="button" class="pl-row" data-p="${esc(p.id)}"><span class="dot ${!p.phone || p.online ? 'on' : 'off'}"></span><b>${esc(p.name)}</b><span class="muted small">${solo() || !t ? '' : `${esc(t.name)} · `}${st}</span><span class="pl-go">›</span></button>`;
    };
    const pid = await dialog({
      title: `Игроки (${S.players.length})`,
      html: `<div class="pl-list">${S.players.map(row).join('')}</div>`,
      cls: 'menu-dlg',
      buttons: [{ label: 'Закрыть', value: null, cls: 'ghost' }],
      onMount: (w, close) => w.querySelector('.pl-list').addEventListener('click', (e) => { const b = e.target.closest('[data-p]'); if (b) close(b.dataset.p); }),
    });
    if (pid) playerMenu(pid);
  }

  // ---------- timers ----------
  const tick = setInterval(() => {
    if (!S || destroyed) return;
    if (hostWinShown !== hostWinOpen()) { hostWinShown = !hostWinShown; render(); }
    const c = S.clue;
    const now = Date.now();
    if (S.phase === 'mini' && S.mini && miniTick(now)) commit();
    if (S.phase === 'clue' && c?.stage === 'open' && c.deadline && now >= c.deadline && !buzzTimer) {
      c.stage = 'answer';
      log({ k: 'none' });
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
      if (c?.stage === 'mod' && c.mod.done) return act('modNext');
      if (S.phase === 'mini' && S.mini?.stage === 'done') return act('miniEnd');
      if (S.phase === 'roundEnd') return act('nextRound');
    }
    if (e.code === 'KeyN' && c) return act('reveal');
    if (e.code === 'Escape' && c) { if (screen?.el.querySelector('.q-media.zoom')) return; return act('back'); }
    if (e.code === 'KeyF') return toggleFullscreen();
  }
  document.addEventListener('keydown', onKey);
  const onBeforeUnload = (e) => {
    if (!autotest && S && !['setup', 'end'].includes(S.phase)) { e.preventDefault(); e.returnValue = ''; }
  };
  window.addEventListener('beforeunload', onBeforeUnload);

  // ---------- start ----------
  const saved = autotest ? null : store.get(SAVE_KEY);
  if (saved?.boardId === board.id && saved.s?.v === 2 && !['setup', 'end'].includes(saved.s.phase)) {
    const n = saved.s.teams.length;
    const r = await dialog({
      title: 'Продолжить игру?',
      html: `<p>Есть незаконченная игра по этой доске (${n} ${plural(n, 'команда', 'команды', 'команд')}). Продолжить с того же места?</p>`,
      buttons: [{ label: 'Новая игра', value: 'new' }, { label: 'Продолжить', value: 'resume', cls: 'primary' }],
    });
    if (r === 'resume') {
      S = saved.s;
      S.kicked ||= [];
      S.mods ||= {};
      if (S.phase === 'mini') { S.phase = S.mini?.after || 'board'; S.mini = null; }
      for (const p of S.players) p.online = false;
      if (S.clue) {
        clearBuzz();
        if (S.clue.single && S.clue.stage === 'buzzed') startQuestion();
        else if (S.clue.stage === 'open' || S.clue.stage === 'buzzed') { S.clue.stage = 'reading'; S.clue.buzzed = null; }
      }
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
    if (autotest) {
      addEventListener('message', onBenchMsg);
      root.innerHTML = `<div class="page center"><div class="connecting"><div class="spinner"></div>Тест-стенд: создаём комнату…</div></div>`;
      chooseMode('buzzer').catch((e) => { root.innerHTML = `<div class="page center"><h1>Не получилось создать комнату</h1><p class="muted">${esc(errText(e))}</p></div>`; });
    } else render();
  }

  // Test bench buttons (test/): "scare now", "mini-game now".
  function onBenchMsg(e) {
    if (e.origin !== location.origin || e.source !== parent || !S || destroyed) return;
    if (e.data?.plyukh === 'scare') scareOne(300);
    if (e.data?.plyukh === 'mini') { if (S.phase === 'board') act('mini', { kind: e.data.kind }); else toast('Мини-игру можно запустить, когда на экране доска'); }
  }

  return () => {
    destroyed = true;
    removeEventListener('message', onBenchMsg);
    // Leaving the page: save the latest moves right away instead of waiting for the timer.
    if (historyTimer) { clearTimeout(historyTimer); recordHistory(); }
    clearInterval(tick);
    clearBuzz();
    unmountScreen();
    document.removeEventListener('keydown', onKey);
    window.removeEventListener('beforeunload', onBeforeUnload);
    chan?.close();
    net?.destroy();
  };
}
