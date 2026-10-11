// IndexedDB: boards and media blobs live in the host's browser.
let dbp;
function db() {
  if (!dbp) {
    dbp = new Promise((res, rej) => {
      const r = indexedDB.open('plyukh', 1);
      r.onupgradeneeded = () => {
        const d = r.result;
        d.createObjectStore('boards', { keyPath: 'id' });
        d.createObjectStore('media', { keyPath: 'id' });
      };
      r.onsuccess = () => res(r.result);
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
