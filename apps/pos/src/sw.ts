/*
 * The till's offline shell (architecture §24 "PWAs").
 *
 * Hand-written, no library: it does one thing. Same-origin GETs are answered from
 * the network when there is one and from the cache when there is not, and a
 * navigation that cannot reach the network gets the cached shell.
 *
 * It never touches the API. The API is a different origin, so those requests do
 * not match the same-origin test below — and that is deliberate rather than
 * incidental: a cached `GET /v1/pos/...` would show the cashier yesterday's shift
 * as today's. Everything the till may use offline is in IndexedDB, written by the
 * app on purpose (`src/lib/store.ts`). Sales are never queued here either; the
 * outbox is the app's, where a person can see it.
 *
 * Built by Vite as its own entry and emitted at `/sw.js` (see `vite.config.ts`):
 * a worker's scope is the directory it is served from, so it cannot live under
 * `/assets/` with the hashed bundles.
 */

// The few worker types this file needs, declared here rather than by adding the
// `WebWorker` lib to a DOM project, where the two libraries' globals collide.
interface ExtendableEvent extends Event {
  waitUntil(work: Promise<unknown>): void;
}
interface FetchEvent extends ExtendableEvent {
  readonly request: Request;
  respondWith(response: Promise<Response> | Response): void;
}
interface WorkerScope {
  readonly location: Location;
  readonly clients: { claim(): Promise<void> };
  skipWaiting(): Promise<void>;
  addEventListener(type: 'install' | 'activate', listener: (event: ExtendableEvent) => void): void;
  addEventListener(type: 'fetch', listener: (event: FetchEvent) => void): void;
}

const worker = self as unknown as WorkerScope;
// A neutral name (D-472). `activate` below deletes every other cache on the origin, an older
// build's shell included, so a rename needs no migration: the shell is re-fetched.
const SHELL_CACHE = 'erp-pos-shell-v1';

/**
 * The till's own path: the directory this worker is served from, `/` on Pages and `/pos/`
 * on the single-server preview (D-352). The shell is that path's index, and nothing outside
 * it is the worker's business: on the preview the API shares the origin, and an API answer
 * must never be cached here (offline-shell.ts).
 */
const SHELL = new URL('./', worker.location.href).pathname;

worker.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(SHELL_CACHE)
      .then((cache) => cache.add(SHELL))
      .then(() => worker.skipWaiting()),
  );
});

worker.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((key) => key !== SHELL_CACHE).map((key) => caches.delete(key))),
      )
      .then(() => worker.clients.claim()),
  );
});

async function fromCache(request: Request): Promise<Response> {
  // `ignoreVary`: the shell's files were put in the cache by the page with a plain
  // request, and are asked for here by a `<script type="module" crossorigin>`. The
  // static server answers with a `Vary` header, the two requests differ in the
  // headers it names, and an exact match would miss the very file it holds — a
  // till that starts offline to a blank page.
  const cached = await caches.match(request, { ignoreSearch: true, ignoreVary: true });
  if (cached !== undefined) return cached;
  if (request.mode === 'navigate') {
    const shell = await caches.match(SHELL);
    if (shell !== undefined) return shell;
  }
  return Response.error();
}

worker.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== worker.location.origin || !url.pathname.startsWith(SHELL)) return;

  event.respondWith(
    fetch(request)
      .then((response) => {
        if (response.ok) {
          const copy = response.clone();
          void caches.open(SHELL_CACHE).then((cache) => cache.put(request, copy));
        }
        return response;
      })
      .catch(() => fromCache(request)),
  );
});
