import { uid } from './util.js?v=1792855965883';
import { isMod } from './mods.js?v=1792855965883';

export const ROUND1_VALUES = [200, 400, 600, 800, 1000];

export const newClue = () => ({ q: '', a: '', media: null, aMedia: null });

export function newRound(name, values = ROUND1_VALUES, cats = 6) {
  return {
    id: uid('r'),
    name,
    values: [...values],
    categories: Array.from({ length: cats }, () => ({ name: '', clues: values.map(() => newClue()) })),
  };
}

export function newBoard(title = 'Новая игра') {
  return {
    id: uid('b'),
    title,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    rounds: [newRound('Раунд 1')],
    final: { enabled: true, category: '', ...newClue() },
  };
}

// Every clue in the board, including the final one.
export function* allClues(board) {
  for (const [ri, r] of board.rounds.entries())
    for (const [ci, c] of r.categories.entries())
      for (const [qi, clue] of c.clues.entries()) yield { clue, ri, ci, qi };
  if (board.final) yield { clue: board.final, final: true };
}

export function mediaRefs(board) {
  const out = [];
  for (const { clue } of allClues(board)) {
    if (clue.media) out.push(clue.media);
    if (clue.aMedia) out.push(clue.aMedia);
  }
  return out;
}

// A cell has a question if it has text or a picture/sound; a modifier (js/mods.js) alone also makes it playable.
export const hasQ = (c) => !!(c && ((c.q || '').trim() || c.media));
export const filled = (c) => hasQ(c) || !!c?.mod;
export const finalReady = (b) => !!(b.final && b.final.enabled && hasQ(b.final));
export const roundPlayable = (r) => r.categories.some((c) => c.clues.some(filled));

export function stats(board) {
  let total = 0, done = 0, media = 0;
  for (const { clue, final } of allClues(board)) {
    if (clue.media) media++;
    if (clue.aMedia) media++;
    if (final) continue;
    total++;
    if (filled(clue)) done++;
  }
  return { total, done, media };
}

// Repairs boards that came from an import or an older version.
export function normalize(b) {
  b.title = String(b.title || 'Без названия');
  b.rounds = Array.isArray(b.rounds) && b.rounds.length ? b.rounds : [newRound('Раунд 1')];
  for (const r of b.rounds) {
    r.id ||= uid('r');
    r.name = String(r.name || 'Раунд');
    r.values = (Array.isArray(r.values) && r.values.length ? r.values : ROUND1_VALUES).map((v) => +v || 0);
    r.categories = Array.isArray(r.categories) && r.categories.length ? r.categories : [{ name: '', clues: [] }];
    for (const c of r.categories) {
      c.name = String(c.name || '');
      c.clues = Array.isArray(c.clues) ? c.clues : [];
      while (c.clues.length < r.values.length) c.clues.push(newClue());
      c.clues.length = r.values.length;
      c.clues = c.clues.map((x) => ({ ...newClue(), ...x, q: String(x?.q || ''), a: String(x?.a || '') }));
      for (const x of c.clues) if (!isMod(x.mod)) delete x.mod;
    }
  }
  b.final = { enabled: true, category: '', ...newClue(), ...(b.final || {}) };
  b.createdAt ||= Date.now();
  b.updatedAt = Date.now();
  return b;
}
