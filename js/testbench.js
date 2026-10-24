// Test bench: the host screen and a few fake players side by side, so one person can try a whole game.
// The host frame creates a room and reports its code; each player frame then joins it with its own id.
import * as db from './db.js?v=1792852434343';
import { esc, store } from './util.js?v=1792852434343';
import { stats } from './board.js?v=1792852434343';
import { exampleBoard } from './examples.js?v=1792852434343';

const NAMES = ['Вася', 'Маша', 'Петя', 'Оля'];
const $ = (s) => document.querySelector(s);
const hostFrame = $('#tb-host');
const players = $('#tb-players');
const status = $('#tb-status');
const saved = store.get('plyukh-testbench', { n: 2, dev: 'phone' });

async function init() {
  let boards = (await db.listBoards()).filter((b) => stats(b).done > 0);
  if (!boards.length) {
    // A browser that never opened the home page has no games yet: give it the example to test with.
    await db.putBoard(exampleBoard());
    store.set('plyukh-seeded', true);
    boards = (await db.listBoards()).filter((b) => stats(b).done > 0);
  }
  const wanted = new URLSearchParams(location.search).get('board') || saved.board;
  $('#tb-board').innerHTML = boards.map((b) => `<option value="${esc(b.id)}" ${b.id === wanted ? 'selected' : ''}>${esc(b.title)}</option>`).join('');
  $('#tb-n').value = saved.n;
  $('#tb-dev').value = saved.dev;
  start();
}

function start() {
  const board = $('#tb-board').value;
  const n = +$('#tb-n').value;
  const dev = $('#tb-dev').value;
  store.set('plyukh-testbench', { board, n, dev });
  players.className = `tb-players ${dev}`;
  players.innerHTML = '<div class="tb-wait">Игроки зайдут, как только ведущий создаст комнату…</div>';
  status.textContent = 'Создаём комнату…';
  // A fresh URL each time, so the frame really restarts the game.
  hostFrame.src = `../?autotest=1&t=${Date.now()}#/play/${board}`;
}

function addPlayers(code) {
  const n = +$('#tb-n').value;
  status.textContent = `Комната ${code}. Начни игру в окне ведущего.`;
  players.innerHTML = Array.from({ length: n }, (_, i) => {
    const name = NAMES[i];
    return `<section class="tb-frame"><b>Игрок: ${name}</b><iframe title="${name}" src="../join/?r=${code}&test=${i + 1}&tname=${encodeURIComponent(name)}"></iframe></section>`;
  }).join('');
}

window.addEventListener('message', (e) => {
  if (e.origin !== location.origin || e.source !== hostFrame.contentWindow) return;
  if (e.data?.plyukh === 'room') addPlayers(e.data.code);
});

$('#tb-start').addEventListener('click', start);
$('#tb-mini').addEventListener('click', () => hostFrame.contentWindow?.postMessage({ plyukh: 'mini' }, location.origin));
$('#tb-scare').addEventListener('click', () => hostFrame.contentWindow?.postMessage({ plyukh: 'scare' }, location.origin));
$('#tb-board').addEventListener('change', start);
$('#tb-n').addEventListener('change', start);
$('#tb-dev').addEventListener('change', start);
init();
