import { createAdapter } from '@socket.io/redis-adapter';
import { Redis } from 'ioredis';
import type { Server } from 'socket.io';

/**
 * The Valkey adapter (architecture §19, "with the Valkey adapter so it works
 * across multiple instances").
 *
 * Without it, a socket only ever receives events emitted by the *one* API
 * process it happens to be connected to. §3 runs replicas behind a load
 * balancer, and the outbox dispatcher hands each row to exactly one of them, so
 * a single-process gateway would deliver roughly 1/N of events to any given
 * browser — an intermittent, load-dependent failure that looks like a flaky
 * network and is nearly impossible to reproduce on one developer machine. The
 * adapter turns the local `emit` into a Valkey publish every instance receives.
 *
 * ioredis rather than iovalkey: Valkey speaks RESP, ioredis is the client
 * `@socket.io/redis-adapter` is built and tested against, and iovalkey is a 0.x
 * fork of it. Nothing here uses a Redis-only command.
 */

export interface ValkeyAdapterOptions {
  readonly url: string;
  /**
   * Channel namespace. Instances that share it share one fan-out — which is the
   * point — so environments and parallel test runs must not share one. See
   * `REALTIME_ADAPTER_KEY` in the env schema.
   */
  readonly key: string;
  /** Called when a client's connection to Valkey errors. */
  readonly onError?: (error: Error) => void;
}

export interface AttachedAdapter {
  /** Closes both clients. The gateway's own `close()` calls this. */
  close(): Promise<void>;
}

/**
 * Attach the adapter to the server and hand back its shutdown.
 *
 * The server, not one namespace: `Server#adapter` is what re-initializes every
 * namespace's adapter, and `Namespace#adapter` is the live instance rather than
 * a setter. Setting the latter typechecks as a call and does nothing, which
 * would be the silent single-instance failure this file exists to prevent — so
 * it is stated here where the next reader will look.
 *
 * Two connections, not one, and that is a protocol requirement rather than a
 * choice: a RESP client in subscriber mode may issue nothing but subscribe and
 * unsubscribe, so the publishing side needs its own socket. `duplicate()` copies
 * the options so the two cannot be configured differently.
 */
export function attachValkeyAdapter(
  io: Pick<Server, 'adapter'>,
  options: ValkeyAdapterOptions,
): AttachedAdapter {
  const pub = new Redis(options.url, {
    /*
     * Keep retrying rather than failing a command after 20 attempts.
     *
     * ioredis's default `maxRetriesPerRequest: 20` makes a queued command
     * reject once Valkey has been unreachable for a while. For a cache that is
     * right; for this it is not — the adapter has no retry of its own, so a
     * rejected publish is an event that silently never reaches any other
     * instance. Valkey coming back should resume delivery, not leave a gap.
     */
    maxRetriesPerRequest: null,
    // Named so a `redis-cli client list` during an incident says which process
    // holds which connection.
    connectionName: `${options.key}:pub`,
    lazyConnect: false,
  });
  const sub = pub.duplicate({ connectionName: `${options.key}:sub` });

  const onError = options.onError;
  if (onError !== undefined) {
    // Unhandled 'error' on an ioredis client is an unhandled event-emitter
    // error, which takes the process down. A realtime transport losing its
    // broker must not stop the API from serving HTTP.
    pub.on('error', onError);
    sub.on('error', onError);
  }

  io.adapter(createAdapter(pub, sub, { key: options.key }));

  return {
    async close() {
      // `quit` rather than `disconnect`, so an in-flight publish is not dropped
      // on the way out of a rolling restart.
      await Promise.allSettled([pub.quit(), sub.quit()]);
    },
  };
}
