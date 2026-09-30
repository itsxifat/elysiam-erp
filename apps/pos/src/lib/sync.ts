import { ApiError, endpoints, NetworkError, type SyncResult } from './api.js';
import { queued, updateEntries, type OutboxEntry } from './store.js';

/**
 * Draining the till's queue to the server (architecture §14 "Offline").
 *
 * The server does the hard part — exactly-once is its guarantee, keyed on the
 * till's own document ids — so this engine can afford to be simple and blunt:
 * send everything still queued, oldest first, whenever it might work, and believe
 * only what the server says back.
 *
 * * **A lost reply is harmless.** If the request reached the server and the reply
 *   did not reach us, the documents stay queued and go again; the server answers
 *   `replayed` with what it recorded the first time.
 * * **Offline is not an error.** A `NetworkError` stops this round and leaves the
 *   queue untouched. The next `online` event, or the next tick, tries again.
 * * **A refusal is never a deletion.** `rejected` or `conflict` marks the document
 *   `failed` and keeps it, with the server's reason, for a person to look at.
 */

export const BATCH = 50;

export type SyncState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'syncing' }
  | { readonly kind: 'offline' }
  | { readonly kind: 'signedOut' }
  | { readonly kind: 'error'; readonly message: string };

type Listener = (state: SyncState) => void;

export interface SyncStore {
  queued(): Promise<OutboxEntry[]>;
  updateEntries(
    updates: readonly { readonly id: string; readonly patch: Partial<OutboxEntry> }[],
  ): Promise<void>;
}

export class SyncEngine {
  private state: SyncState = { kind: 'idle' };
  private running: Promise<void> | null = null;
  private readonly listeners = new Set<Listener>();
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly send: (
      documents: readonly unknown[],
    ) => Promise<{ results: SyncResult[] }> = endpoints.sync,
    /** The outbox. Injected so the engine's rules can be tested without IndexedDB. */
    private readonly store: SyncStore = { queued, updateEntries },
    private readonly isOnline: () => boolean = () =>
      typeof navigator === 'undefined' || navigator.onLine,
  ) {}

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    listener(this.state);
    return () => this.listeners.delete(listener);
  }

  /** Start draining on reconnect and on a slow tick, for the life of the page. */
  start(intervalMs = 15_000): () => void {
    const kick = () => {
      void this.flush();
    };
    window.addEventListener('online', kick);
    this.timer = setInterval(kick, intervalMs);
    kick();
    return () => {
      window.removeEventListener('online', kick);
      if (this.timer !== null) clearInterval(this.timer);
    };
  }

  /** One pass over the queue. Concurrent calls share the pass already running. */
  flush(): Promise<void> {
    this.running ??= this.drain().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private set(state: SyncState): void {
    this.state = state;
    for (const listener of this.listeners) listener(state);
  }

  private async drain(): Promise<void> {
    for (;;) {
      const pending = await this.store.queued();
      if (pending.length === 0) {
        this.set({ kind: 'idle' });
        return;
      }
      if (!this.isOnline()) {
        this.set({ kind: 'offline' });
        return;
      }
      this.set({ kind: 'syncing' });
      const batch = pending.slice(0, BATCH);
      let answer: { results: SyncResult[] };
      try {
        answer = await this.send(batch.map((entry) => entry.document));
      } catch (error) {
        await this.store.updateEntries(
          batch.map((entry) => ({ id: entry.id, patch: { attempts: entry.attempts + 1 } })),
        );
        if (error instanceof NetworkError) {
          this.set({ kind: 'offline' });
        } else if (error instanceof ApiError && error.status === 401) {
          // The session ended; the documents wait for the next sign-in.
          this.set({ kind: 'signedOut' });
        } else {
          this.set({
            kind: 'error',
            message: error instanceof Error ? error.message : 'sync failed',
          });
        }
        return;
      }
      await this.store.updateEntries(
        answer.results.map((result) => ({ id: result.id, patch: patchFor(result, batch) })),
      );
      if (answer.results.length === 0) return;
    }
  }
}

function patchFor(result: SyncResult, batch: readonly OutboxEntry[]): Partial<OutboxEntry> {
  const attempts = (batch.find((entry) => entry.id === result.id)?.attempts ?? 0) + 1;
  if (result.outcome === 'rejected' || result.outcome === 'conflict') {
    return {
      status: 'failed',
      attempts,
      outcome: result.outcome,
      error: result.error?.message ?? result.outcome,
    };
  }
  return {
    status: 'synced',
    attempts,
    outcome: result.outcome,
    reasons: result.reasons,
    error: null,
  };
}
