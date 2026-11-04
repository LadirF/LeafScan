// Páginas guardadas no próprio aparelho (IndexedDB). Se o navegador bloquear o
// IndexedDB (aba anônima, por exemplo), as páginas ficam só na memória.

const NAME = 'leafscan';
const STORE = 'pages';
let dbp = null;
let memory = null;

function open() {
  if (memory) return Promise.resolve(null);
  if (!dbp) {
    dbp = new Promise((resolve) => {
      let req;
      try {
        req = indexedDB.open(NAME, 1);
      } catch {
        memory = new Map();
        return resolve(null);
      }
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => { memory = new Map(); resolve(null); };
    });
  }
  return dbp;
}

function run(mode, fn) {
  return open().then((db) => {
    if (!db) return fn(null);
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const req = fn(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(req && req.result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  });
}

export async function all() {
  const list = await run('readonly', (s) => (s ? s.getAll() : null));
  const pages = list || (memory ? [...memory.values()] : []);
  return pages.sort((a, b) => a.pos - b.pos);
}

export function put(page) {
  return run('readwrite', (s) => {
    if (!s) { memory.set(page.id, page); return null; }
    return s.put(page);
  });
}

export function del(id) {
  return run('readwrite', (s) => {
    if (!s) { memory.delete(id); return null; }
    return s.delete(id);
  });
}

export function clear() {
  return run('readwrite', (s) => {
    if (!s) { memory.clear(); return null; }
    return s.clear();
  });
}

export const isMemoryOnly = () => !!memory;
