// Results of finished games, kept in this browser.
import { store } from './util.js?v=1791789810288';

const KEY = 'plyukh-history';

export const listHistory = () => store.get(KEY, []);

// One entry per game: replaying the end screen (undo, reload) updates it instead of duplicating.
export function saveGame(entry) {
  const h = listHistory().filter((e) => e.id !== entry.id);
  h.unshift(entry);
  store.set(KEY, h.slice(0, 200));
}

export function removeGame(id) {
  store.set(KEY, listHistory().filter((e) => e.id !== id));
}

export const clearHistory = () => store.del(KEY);
