// Played games, kept in this browser (IndexedDB): who played, every question and every answer.
import * as db from './db.js?v=1791919655137';
import { store } from './util.js?v=1791919655137';

const OLD_KEY = 'plyukh-history'; // short summaries from before the detailed history

async function migrate() {
  const old = store.get(OLD_KEY);
  if (!Array.isArray(old) || !old.length) return;
  for (const h of old) await db.putHistory({ v: 1, ...h });
  store.del(OLD_KEY);
}

export async function listHistory() {
  await migrate();
  return (await db.listHistory()).sort((a, b) => b.at - a.at);
}

export const getGame = (id) => db.getHistory(id);

// One entry per game: it is rewritten as the game goes on, so even an unfinished game is remembered.
export const saveGame = (entry) => db.putHistory(entry).catch(() => {});

export const removeGame = (id) => db.deleteHistory(id);

export async function clearHistory() {
  store.del(OLD_KEY);
  await db.clearHistory();
}
