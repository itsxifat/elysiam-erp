/**
 * Recordings kept in this browser until the server has them (M38b, D-611).
 *
 * The recorder hands over a chunk every few seconds and each is written here at once, so a
 * reload, a crash or a dropped connection loses at most the last few seconds: what was
 * recorded is uploaded on the next visit to the station. A recording leaves only when its
 * upload is attached on the server.
 *
 * IndexedDB where the browser has it (database `elysium-packing`: `recordings` by video id,
 * `chunks` by video id and sequence); in a browser without it (a private window that refuses
 * storage) the same interface in memory, which keeps a failed upload only while the page is
 * open.
 */

export interface StoredRecording {
  readonly videoId: string;
  readonly sessionId: string;
  readonly orderNo: string;
  /** The recorder's format, e.g. `video/webm;codecs=vp8`. */
  readonly mime: string;
  readonly startedAt: number;
  /** When the recorder stopped; null while it is (or was, before a reload) recording. */
  readonly endedAt: number | null;
  readonly lastChunkAt: number | null;
  readonly chunks: number;
  readonly bytes: number;
  readonly attempts: number;
  readonly lastAttemptAt: number | null;
  readonly lastError: string | null;
  /**
   * The server's file once its upload was finalized, kept until the attach succeeds: a retry
   * attaches this file rather than uploading a second copy (M38b audit). Absent on a recording
   * kept by an older page, which reads as none.
   */
  readonly uploadedFileId?: string | null;
}

export interface VideoStore {
  begin(recording: StoredRecording): Promise<void>;
  append(videoId: string, seq: number, chunk: Blob, at: number): Promise<void>;
  finish(videoId: string, endedAt: number): Promise<void>;
  list(): Promise<StoredRecording[]>;
  /** The recording's bytes, its chunks in order. */
  blob(videoId: string): Promise<Blob | null>;
  update(videoId: string, patch: Partial<StoredRecording>): Promise<void>;
  remove(videoId: string): Promise<void>;
}

/** The same store in memory: tests, and browsers that refuse IndexedDB. */
export function memoryVideoStore(): VideoStore {
  const recordings = new Map<string, StoredRecording>();
  const chunks = new Map<string, Map<number, Blob>>();
  return {
    begin(recording) {
      recordings.set(recording.videoId, recording);
      chunks.set(recording.videoId, new Map());
      return Promise.resolve();
    },
    append(videoId, seq, chunk, at) {
      const known = recordings.get(videoId);
      if (known === undefined) return Promise.resolve();
      chunks.get(videoId)?.set(seq, chunk);
      recordings.set(videoId, {
        ...known,
        chunks: known.chunks + 1,
        bytes: known.bytes + chunk.size,
        lastChunkAt: at,
      });
      return Promise.resolve();
    },
    finish(videoId, endedAt) {
      const known = recordings.get(videoId);
      if (known !== undefined) recordings.set(videoId, { ...known, endedAt });
      return Promise.resolve();
    },
    list() {
      return Promise.resolve([...recordings.values()]);
    },
    blob(videoId) {
      const known = recordings.get(videoId);
      const parts = chunks.get(videoId);
      if (known === undefined || parts === undefined) return Promise.resolve(null);
      const ordered = [...parts.entries()].sort(([a], [b]) => a - b).map(([, part]) => part);
      return Promise.resolve(new Blob(ordered, { type: known.mime }));
    },
    update(videoId, patch) {
      const known = recordings.get(videoId);
      if (known !== undefined) recordings.set(videoId, { ...known, ...patch });
      return Promise.resolve();
    },
    remove(videoId) {
      recordings.delete(videoId);
      chunks.delete(videoId);
      return Promise.resolve();
    },
  };
}

const DATABASE = 'elysium-packing';
const RECORDINGS = 'recordings';
const CHUNKS = 'chunks';

function requested<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB refused a request.'));
  });
}

function finished(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () =>
      reject(transaction.error ?? new Error('IndexedDB refused a transaction.'));
    transaction.onabort = () =>
      reject(transaction.error ?? new Error('IndexedDB abandoned a transaction.'));
  });
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(RECORDINGS)) {
        db.createObjectStore(RECORDINGS, { keyPath: 'videoId' });
      }
      if (!db.objectStoreNames.contains(CHUNKS)) {
        const store = db.createObjectStore(CHUNKS, { keyPath: ['videoId', 'seq'] });
        store.createIndex('byVideo', 'videoId');
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB did not open.'));
    request.onblocked = () => reject(new Error('IndexedDB is held by another tab.'));
  });
}

function indexedVideoStore(db: IDBDatabase): VideoStore {
  const patchRecording = async (
    videoId: string,
    change: (known: StoredRecording) => StoredRecording,
    extra?: (transaction: IDBTransaction) => void,
  ): Promise<void> => {
    const transaction = db.transaction(
      extra === undefined ? [RECORDINGS] : [RECORDINGS, CHUNKS],
      'readwrite',
    );
    const done = finished(transaction);
    const store = transaction.objectStore(RECORDINGS);
    const known = (await requested(store.get(videoId))) as StoredRecording | undefined;
    if (known !== undefined) {
      store.put(change(known));
      extra?.(transaction);
    }
    await done;
  };

  return {
    async begin(recording) {
      const transaction = db.transaction([RECORDINGS], 'readwrite');
      transaction.objectStore(RECORDINGS).put(recording);
      await finished(transaction);
    },
    append(videoId, seq, chunk, at) {
      return patchRecording(
        videoId,
        (known) => ({
          ...known,
          chunks: known.chunks + 1,
          bytes: known.bytes + chunk.size,
          lastChunkAt: at,
        }),
        (transaction) => transaction.objectStore(CHUNKS).put({ videoId, seq, chunk }),
      );
    },
    finish(videoId, endedAt) {
      return patchRecording(videoId, (known) => ({ ...known, endedAt }));
    },
    async list() {
      const transaction = db.transaction([RECORDINGS], 'readonly');
      const rows = (await requested(
        transaction.objectStore(RECORDINGS).getAll(),
      )) as StoredRecording[];
      return rows;
    },
    async blob(videoId) {
      const transaction = db.transaction([RECORDINGS, CHUNKS], 'readonly');
      const known = (await requested(transaction.objectStore(RECORDINGS).get(videoId))) as
        StoredRecording | undefined;
      if (known === undefined) return null;
      const rows = (await requested(
        transaction.objectStore(CHUNKS).index('byVideo').getAll(videoId),
      )) as { seq: number; chunk: Blob }[];
      const ordered = rows.sort((a, b) => a.seq - b.seq).map((row) => row.chunk);
      return new Blob(ordered, { type: known.mime });
    },
    update(videoId, patch) {
      return patchRecording(videoId, (known) => ({ ...known, ...patch }));
    },
    async remove(videoId) {
      const transaction = db.transaction([RECORDINGS, CHUNKS], 'readwrite');
      const done = finished(transaction);
      transaction.objectStore(RECORDINGS).delete(videoId);
      const chunkStore = transaction.objectStore(CHUNKS);
      const keys = await requested(chunkStore.index('byVideo').getAllKeys(videoId));
      for (const key of keys) chunkStore.delete(key);
      await done;
    },
  };
}

let shared: Promise<VideoStore> | undefined;

/** This browser's store: IndexedDB, or memory where the browser has none. Opened once. */
export function openVideoStore(): Promise<VideoStore> {
  shared ??= (async () => {
    try {
      if (typeof indexedDB === 'undefined') return memoryVideoStore();
      return indexedVideoStore(await openDatabase());
    } catch {
      return memoryVideoStore();
    }
  })();
  return shared;
}
