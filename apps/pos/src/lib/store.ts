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
 */

const DB_NAME = 'elysium-pos';
const DB_VERSION = 1;

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

function database(): Promise<IDBDatabase> {
  opened ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
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
  return opened;
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
