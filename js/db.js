// IndexedDB: boards, media blobs and the history of played games live in the host's browser.
let dbp;
function db() {
  if (!dbp) {
    dbp = new Promise((res, rej) => {
      const r = indexedDB.open('plyukh', 2);
      r.onupgradeneeded = () => {
        const d = r.result;
        for (const s of ['boards', 'media', 'history']) if (!d.objectStoreNames.contains(s)) d.createObjectStore(s, { keyPath: 'id' });
      };
      r.onsuccess = () => {
        const d = r.result;
        // Another tab updated the site and needs a newer database: step aside.
        d.onversionchange = () => { d.close(); dbp = null; };
        res(d);
      };
      r.onerror = () => rej(r.error);
    });
  }
  return dbp;
}

function tx(store, mode, fn) {
  return db().then((d) => new Promise((res, rej) => {
    const t = d.transaction(store, mode);
    let out;
    const r = fn(t.objectStore(store));
    if (r) r.onsuccess = () => { out = r.result; };
    t.oncomplete = () => res(out);
    t.onerror = () => rej(t.error);
    t.onabort = () => rej(t.error || new Error('Не удалось сохранить (закончилось место?)'));
  }));
}

export const listBoards = () => tx('boards', 'readonly', (s) => s.getAll()).then((a) => a.sort((x, y) => y.updatedAt - x.updatedAt));
export const getBoard = (id) => tx('boards', 'readonly', (s) => s.get(id));
export const putBoard = (b) => tx('boards', 'readwrite', (s) => s.put(b));
export const deleteBoardRecord = (id) => tx('boards', 'readwrite', (s) => s.delete(id));
export const getMedia = (id) => tx('media', 'readonly', (s) => s.get(id));
export const putMedia = (m) => tx('media', 'readwrite', (s) => s.put(m));
export const deleteMedia = (id) => tx('media', 'readwrite', (s) => s.delete(id));
export const listHistory = () => tx('history', 'readonly', (s) => s.getAll());
export const getHistory = (id) => tx('history', 'readonly', (s) => s.get(id));
export const putHistory = (h) => tx('history', 'readwrite', (s) => s.put(h));
export const deleteHistory = (id) => tx('history', 'readwrite', (s) => s.delete(id));
export const clearHistory = () => tx('history', 'readwrite', (s) => s.clear());
