// IndexedDB cache. One database, one transactions store, keyed by the composite
// `${accountId}|${postingId}` so multiple accounts can share the same DB without their
// rows colliding. Postings are immutable upstream, so a hit on a postingId means "we
// already have it" — that's how incremental sync stops walking.
//
// Why IndexedDB and not localStorage: 80k transactions × ~400 B is ~30 MB. localStorage
// caps at 5–10 MB; IndexedDB has gigabytes.

const DB_NAME = "dc-tx-viewer";
const DB_VERSION = 1;
const STORE = "transactions";
const META = "meta";

let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      // `key` is the composite "${accountId}|${postingId}"; we keep `accountId` as a
      // top-level index so per-account scans don't have to filter the whole store.
      const txns = db.createObjectStore(STORE, { keyPath: "key" });
      txns.createIndex("accountId", "accountId");
      db.createObjectStore(META, { keyPath: "key" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

const txDone = (tx) =>
  new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error);
    tx.onerror = () => reject(tx.error);
  });

const reqDone = (req) =>
  new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });

/** Every cached transaction for the account, returned as the raw Treasury items
 *  (without the storage key). Loaded once on view-mount and held in memory. */
export async function loadAllTransactions(accountId) {
  const db = await openDb();
  const tx = db.transaction(STORE, "readonly");
  const idx = tx.objectStore(STORE).index("accountId");
  const rows = await reqDone(idx.getAll(accountId));
  return rows.map((r) => r.item);
}

/** Bulk upsert. Postings are immutable upstream so overwriting is harmless. Chunked into
 *  5k-row transactions with a microtask yield in between so an 80k-item first sync
 *  doesn't lock up the main thread for the duration of the write. */
const PUT_CHUNK = 5000;

export async function putTransactions(accountId, items) {
  if (items.length === 0) return;
  const db = await openDb();
  for (let i = 0; i < items.length; i += PUT_CHUNK) {
    const tx = db.transaction(STORE, "readwrite");
    const store = tx.objectStore(STORE);
    const end = Math.min(i + PUT_CHUNK, items.length);
    for (let j = i; j < end; j++) {
      const item = items[j];
      store.put({ key: `${accountId}|${item.postingId}`, accountId, item });
    }
    await txDone(tx);
    if (end < items.length) await new Promise((r) => setTimeout(r));
  }
}

/** Drop the entire app database — used by "Disconnect & clear cache". */
export async function nukeDatabase() {
  if (dbPromise) (await dbPromise).close();
  dbPromise = null;
  await new Promise((resolve, reject) => {
    const req = indexedDB.deleteDatabase(DB_NAME);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
    req.onblocked = () => resolve(); // best-effort; the next open will retry
  });
}

// ─── Metadata ─────────────────────────────────────────────────────────────

const metaKey = (accountId) => `account:${accountId}`;

export async function getMeta(accountId) {
  const db = await openDb();
  const tx = db.transaction(META, "readonly");
  return (await reqDone(tx.objectStore(META).get(metaKey(accountId)))) ?? null;
}

export async function setMeta(accountId, patch) {
  const db = await openDb();
  // Queue the put synchronously from the get's onsuccess so the transaction stays
  // active. Using an await between get and put can let strict browsers (notably Safari)
  // auto-commit the transaction on the microtask boundary, throwing TransactionInactiveError
  // on the subsequent put.
  return new Promise((resolve, reject) => {
    const tx = db.transaction(META, "readwrite");
    const store = tx.objectStore(META);
    const key = metaKey(accountId);
    const getReq = store.get(key);
    getReq.onsuccess = () => {
      const existing = getReq.result ?? { key };
      store.put({ ...existing, ...patch, key });
    };
    getReq.onerror = () => reject(getReq.error);
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error);
    tx.onerror = () => reject(tx.error);
  });
}
