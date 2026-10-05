/**
 * The till's durable memory, in IndexedDB (architecture §14: "sales queue in
 * IndexedDB with a client UUID and an idempotency key").
 *
 * Plain IndexedDB through the browser API — no wrapper library, so no dependency
 * for the one thing the till cannot do without.
 *
 * ## Why the queue entry and the receipt number are written together
 *
 * A sale is recorded in one IndexedDB transaction that both takes the next receipt
 * number and puts the document in the outbox. If they were two transactions, a tab
 * closed between them would either burn a number with no sale behind it or — worse
 * — leave a sale whose number the next sale reuses, and two customers would hold
 * receipts that a return cannot tell apart.
 *
 * ## What leaves the queue
 *
 * Only an answer from the server that it has the document: `posted`, `held` (in
 * review) or `voided`. A network failure leaves it queued; a refusal leaves it in
 * the queue marked `failed`, visible, for a person. Nothing is ever deleted because
 * a request failed — that is how a till silently loses a sale.
 *
 * ## The database's name, and the one-time move (M31, D-472)
 *
 * The database is `erp-pos`: every brand runs its own copy of the till, and nothing it
 * keeps in a browser names whose it is. An older build kept the same stores under a
 * product-specific `<word>-pos` name. On the first open, everything in such a database
 * on this origin — the queue above all, sales not yet synced — is copied into `erp-pos`
 * in one transaction, and the old database is deleted only after that transaction has
 * committed. A tab closed half-way leaves the old database whole, and the next start
 * copies again; an entry already in the new database is never overwritten, so nothing
 * synced since is undone. The old name is matched by its shape, never spelled out.
 */

export const DB_NAME = 'erp-pos';
const DB_VERSION = 1;
/** An older build's name for this database: `<word>-pos`, never ours. */
export const LEGACY_DB_NAME = /^[a-z]+-pos$/;

export type OutboxStatus = 'queued' | 'synced' | 'failed';

export interface OutboxEntry {
  readonly id: string;
  /** Insertion order, so the queue drains oldest first (an exchange's return before its sale). */
  readonly seq: number;
  readonly kind: 'sale' | 'return';
  readonly document: unknown;
  readonly status: OutboxStatus;
  readonly createdAt: string;
  readonly attempts: number;
  /** The server's answer, once it has one. */
  readonly outcome: string | null;
  readonly reasons: readonly string[];
  readonly error: string | null;
  /** What the receipt printed, for reprints and the history list. */
  readonly receipt: unknown;
}

let opened: Promise<IDBDatabase> | undefined;

function openTill(factory: IDBFactory): Promise<IDBDatabase> {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = factory.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains('outbox')) {
        const outbox = db.createObjectStore('outbox', { keyPath: 'id' });
        outbox.createIndex('seq', 'seq', { unique: true });
        outbox.createIndex('status', 'status');
      }
      if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
    };
    request.onsuccess = () => {
      resolve(request.result);
    };
    request.onerror = () => {
      reject(request.error ?? new Error('IndexedDB would not open.'));
    };
  });
}

function database(): Promise<IDBDatabase> {
  opened ??= openTill(indexedDB).then(async (db) => {
    try {
      await moveLegacyDatabases(indexedDB, db);
    } catch {
      // The old database stays whole and the next start tries again; the till works on.
    }
    return db;
  });
  return opened;
}

function openExisting(factory: IDBFactory, name: string): Promise<IDBDatabase | undefined> {
  return new Promise((resolve, reject) => {
    const request = factory.open(name);
    // Opening a name that is not there would create it: refuse, and leave nothing behind.
    request.onupgradeneeded = () => {
      request.transaction?.abort();
    };
    request.onsuccess = () => {
      resolve(request.result);
    };
    request.onerror = () => {
      // An aborted upgrade lands here: the database did not exist.
      if (request.error?.name === 'AbortError') resolve(undefined);
      else reject(request.error ?? new Error('IndexedDB would not open.'));
    };
  });
}

interface LegacyContents {
  readonly outbox: OutboxEntry[];
  readonly kv: { readonly key: IDBValidKey; readonly value: unknown }[];
}

/** The queue's and the counters' contents of an older build's database. */
async function readAll(db: IDBDatabase): Promise<LegacyContents> {
  const stores = ['outbox', 'kv'].filter((name) => db.objectStoreNames.contains(name));
  if (stores.length === 0) return { outbox: [], kv: [] };
  const transaction = db.transaction(stores, 'readonly');
  const outbox = stores.includes('outbox')
    ? ((await result(transaction.objectStore('outbox').getAll())) as OutboxEntry[])
    : [];
  const kv: { key: IDBValidKey; value: unknown }[] = [];
  if (stores.includes('kv')) {
    const store = transaction.objectStore('kv');
    const [keys, values] = await Promise.all([result(store.getAllKeys()), result(store.getAll())]);
    keys.forEach((key, index) => kv.push({ key, value: values[index] as unknown }));
  }
  return { outbox, kv };
}

function deleteDatabase(factory: IDBFactory, name: string): Promise<void> {
  return new Promise((resolve) => {
    const request = factory.deleteDatabase(name);
    // Blocked or failed: it is tried again on the next start, and the copy is idempotent.
    request.onsuccess = () => {
      resolve();
    };
    request.onerror = () => {
      resolve();
    };
    request.onblocked = () => {
      resolve();
    };
  });
}

/**
 * Move every older build's till database on this origin into `erp-pos` (see the file
 * note). `database()` runs it on first open; the till's browser test drives it. Returns
 * how many queue entries were copied.
 */
export async function moveLegacyDatabases(
  factory: IDBFactory,
  target: IDBDatabase,
): Promise<number> {
  // Older engines cannot list databases; nothing to find, nothing lost.
  if (typeof factory.databases !== 'function') return 0;
  const names = (await factory.databases())
    .map((info) => info.name)
    .filter(
      (name): name is string =>
        typeof name === 'string' && name !== DB_NAME && LEGACY_DB_NAME.test(name),
    );
  let copied = 0;
  for (const name of names) {
    const legacy = await openExisting(factory, name);
    if (legacy === undefined) continue;
    let contents: LegacyContents;
    try {
      contents = await readAll(legacy);
    } finally {
      legacy.close();
    }

    const transaction = target.transaction(['kv', 'outbox'], 'readwrite');
    const outbox = transaction.objectStore('outbox');
    const kv = transaction.objectStore('kv');
    for (const entry of contents.outbox) {
      // Never over an entry the new database already has: it may have synced since.
      if ((await result(outbox.getKey(entry.id))) === undefined) {
        outbox.add(entry);
        copied += 1;
      }
    }
    for (const { key, value } of contents.kv) {
      const existing: unknown = await result(kv.get(key));
      if (existing === undefined) kv.put(value, key);
      else if (typeof existing === 'number' && typeof value === 'number' && value > existing) {
        // A receipt or queue counter: the higher, so no number is handed out twice.
        kv.put(value, key);
      }
    }
    await done(transaction);

    // Only now, with the copy committed, may the old database go.
    await deleteDatabase(factory, name);
  }
  return copied;
}

function done(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => {
      resolve();
    };
    transaction.onerror = () => {
      reject(transaction.error ?? new Error('IndexedDB transaction failed.'));
    };
    transaction.onabort = () => {
      reject(transaction.error ?? new Error('IndexedDB transaction aborted.'));
    };
  });
}

function result<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => {
      resolve(request.result);
    };
    request.onerror = () => {
      reject(request.error ?? new Error('IndexedDB request failed.'));
    };
  });
}

export async function getValue<T>(key: string): Promise<T | undefined> {
  const db = await database();
  return (await result(db.transaction('kv').objectStore('kv').get(key))) as T | undefined;
}

export async function setValue(key: string, value: unknown): Promise<void> {
  const db = await database();
  const transaction = db.transaction('kv', 'readwrite');
  transaction.objectStore('kv').put(value, key);
  await done(transaction);
}

/**
 * Take the next receipt sequence for a shift and queue the document built with
 * it, atomically (see the file comment).
 */
export async function recordDocument(input: {
  readonly shiftId: string;
  readonly kind: 'sale' | 'return';
  readonly build: (seq: number) => { document: { id: string }; receipt: unknown };
}): Promise<OutboxEntry> {
  const db = await database();
  const transaction = db.transaction(['kv', 'outbox'], 'readwrite');
  const kv = transaction.objectStore('kv');
  const outbox = transaction.objectStore('outbox');
  const counterKey = `receipt-seq:${input.shiftId}`;
  const queueKey = 'outbox-seq';

  const [current, queueSeq] = await Promise.all([
    result(kv.get(counterKey)) as Promise<number | undefined>,
    result(kv.get(queueKey)) as Promise<number | undefined>,
  ]);
  const seq = (current ?? 0) + 1;
  const order = (queueSeq ?? 0) + 1;
  const built = input.build(seq);
  const entry: OutboxEntry = {
    id: built.document.id,
    seq: order,
    kind: input.kind,
    document: built.document,
    status: 'queued',
    createdAt: new Date().toISOString(),
    attempts: 0,
    outcome: null,
    reasons: [],
    error: null,
    receipt: built.receipt,
  };
  kv.put(seq, counterKey);
  kv.put(order, queueKey);
  outbox.add(entry);
  await done(transaction);
  return entry;
}

export async function outbox(): Promise<OutboxEntry[]> {
  const db = await database();
  const all = (await result(
    db.transaction('outbox').objectStore('outbox').index('seq').getAll(),
  )) as OutboxEntry[];
  return all;
}

export async function queued(): Promise<OutboxEntry[]> {
  return (await outbox()).filter((entry) => entry.status === 'queued');
}

export async function updateEntries(
  updates: readonly { readonly id: string; readonly patch: Partial<OutboxEntry> }[],
): Promise<void> {
  if (updates.length === 0) return;
  const db = await database();
  const transaction = db.transaction('outbox', 'readwrite');
  const store = transaction.objectStore('outbox');
  for (const update of updates) {
    const request = store.get(update.id);
    request.onsuccess = () => {
      const existing = request.result as OutboxEntry | undefined;
      if (existing !== undefined) store.put({ ...existing, ...update.patch });
    };
  }
  await done(transaction);
}

/** Put a failed document back in the queue for another try. */
export async function requeue(id: string): Promise<void> {
  await updateEntries([{ id, patch: { status: 'queued', error: null } }]);
}
