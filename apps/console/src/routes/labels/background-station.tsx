import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';

import { playTone } from '../../alive/tones.js';
import '../../i18n/labels.js';
import { useT } from '../../i18n/locale.js';
import { useRealtime } from '../../realtime/use-realtime.js';
import { stationDocument, stationJobs, stationResult, type PrintJob } from './api.js';
import { useBrandBinding, useTerminalCheckIn } from './terminal-binding.js';

/**
 * The print station, wherever the console is open on a label computer (D-900).
 *
 * D-816 printed a browser printer's jobs only while Labels → Print station was the page on
 * screen, while the computer's check-in, which any Labels or Packaging page sent, made the
 * printer read Online. So the printer looked connected and every job, the test print among them,
 * waited Queued for a page nobody had open. Now the work dock mounts this on every page of a
 * computer bound to a label terminal: it checks in and prints from wherever the person is, and
 * Online means the jobs print.
 *
 * One tab prints. Each tab asks the browser for the terminal's lock (`navigator.locks`); the one
 * holding it runs the loop, the others wait and take over when it closes, so no job prints twice
 * from one computer (the server already keeps two computers apart, D-826 W2). The Print station
 * page shows this state and pauses or resumes it.
 */

export interface StationState {
  /** `here`: this tab prints; `elsewhere`: another tab of this browser does; `off`: none. */
  readonly role: 'here' | 'elsewhere' | 'off';
  readonly paused: boolean;
  readonly busy: string | null;
  readonly last: PrintJob | null;
  readonly failure: string | null;
  /** The last print waited on a dialog: Chrome is not printing silently (`--kiosk-printing`). */
  readonly dialog: boolean;
}

let current: StationState = {
  role: 'off',
  paused: false,
  busy: null,
  last: null,
  failure: null,
  dialog: false,
};
const listeners = new Set<() => void>();

function update(patch: Partial<StationState>): void {
  current = { ...current, ...patch };
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useStationState(): StationState {
  return useSyncExternalStore(
    subscribe,
    () => current,
    () => current,
  );
}

export function setStationPaused(paused: boolean): void {
  update({ paused });
}

/**
 * A print call that returns after this long waited on a person: Chrome showed its dialog. With
 * `--kiosk-printing` it returns at once.
 */
export const PRINT_DIALOG_MS = 1500;

/** Print a PDF from a hidden frame; resolves once the browser's print calls returned. */
export async function printPdf(
  frame: HTMLIFrameElement,
  blob: Blob,
  copies: number,
): Promise<{ readonly dialog: boolean }> {
  const url = URL.createObjectURL(blob);
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = window.setTimeout(
        () => reject(new Error('The page did not load to print.')),
        20_000,
      );
      frame.onload = () => {
        window.clearTimeout(timer);
        resolve();
      };
      frame.src = url;
    });
    // The PDF viewer draws a moment after the frame loads.
    await new Promise((resolve) => window.setTimeout(resolve, 600));
    const target = frame.contentWindow;
    if (target === null) throw new Error('The print frame is gone.');
    // The frame is focused to print and the person's field gets the focus back at once: this
    // runs on any page, and a scan typed into the hidden frame would be lost (D-900's review).
    const active = document.activeElement;
    const previous = active instanceof HTMLElement && active !== document.body ? active : null;
    let dialog = false;
    try {
      for (let copy = 0; copy < copies; copy += 1) {
        const started = Date.now();
        target.focus();
        target.print();
        if (Date.now() - started > PRINT_DIALOG_MS) dialog = true;
      }
    } finally {
      previous?.focus({ preventScroll: true });
    }
    return { dialog };
  } finally {
    window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }
}

/**
 * Hold the browser's lock named `name` while mounted: true while this tab holds it. A browser
 * with no Web Locks (none the console supports, and a test's DOM) counts as holding it.
 */
export function useStationLock(name: string | null): boolean {
  const [held, setHeld] = useState(false);
  const locks = typeof navigator === 'undefined' ? undefined : navigator.locks;
  useEffect(() => {
    if (name === null || locks === undefined) return;
    const controller = new AbortController();
    let release: (() => void) | null = null;
    void locks
      .request(
        name,
        { signal: controller.signal },
        () =>
          new Promise<void>((resolve) => {
            release = resolve;
            setHeld(true);
          }),
      )
      // Aborted while another tab held it: this tab unmounted first.
      .catch(() => undefined);
    return () => {
      controller.abort();
      release?.();
      setHeld(false);
    };
  }, [name, locks]);
  return name !== null && (locks === undefined || held);
}

/** Mounted by the work dock on a computer bound to a label terminal (D-900). */
export function BackgroundPrintStation() {
  const binding = useBrandBinding();
  // The check-in from every page: the printer is Online exactly while this prints.
  useTerminalCheckIn();
  const label = binding?.kind === 'label';
  const held = useStationLock(label ? `erp.print-station:${binding.terminalId}` : null);
  useEffect(() => {
    update({ role: !label ? 'off' : held ? 'here' : 'elsewhere' });
  }, [label, held]);
  if (!label || !held) return null;
  return <StationLoop terminalId={binding.terminalId} token={binding.token} />;
}

/** A job whose print failed is tried again after this long, not at once (D-900's review). */
const RETRY_AFTER_MS = 30_000;

function StationLoop({
  terminalId,
  token,
}: {
  readonly terminalId: string;
  readonly token: string;
}) {
  const t = useT();
  const queryClient = useQueryClient();
  const frame = useRef<HTMLIFrameElement>(null);
  const { paused, busy } = useStationState();
  /*
   * The jobs this loop has started: never started again while the server still lists them, so
   * the list from before a print (it is refetched after) cannot print the job a second time, and
   * a job the server refuses is not asked for in a loop. A job leaves this set when the server
   * stops listing it (printed, failed), so one put back by Retry prints; one that failed here is
   * tried again after `RETRY_AFTER_MS`.
   */
  const started = useRef(new Set<string>());
  // Bumped when a failed job may be tried again: the list it is in may not have changed.
  const [retries, setRetries] = useState(0);
  const jobs = useQuery({
    queryKey: ['labels', 'station', token],
    queryFn: stationJobs,
    refetchInterval: 15_000,
    refetchIntervalInBackground: true,
    retry: false,
  });
  useEffect(() => {
    if (jobs.data === undefined) return;
    const listed = new Set(jobs.data.items.map((job) => job.id));
    for (const id of started.current) if (!listed.has(id)) started.current.delete(id);
  }, [jobs.data]);
  const onEvent = useCallback(
    (_name: string, payload: unknown) => {
      const event = payload as { terminalId?: unknown; state?: unknown } | null;
      if (event?.terminalId === terminalId && event?.state === 'queued') {
        void queryClient.invalidateQueries({ queryKey: ['labels', 'station'] });
      }
    },
    [terminalId, queryClient],
  );
  useRealtime({ events: ['labels.job_changed'], onEvent });

  // Nothing prints here any more once this loop is gone (a sign-out, another brand, a lost lock).
  useEffect(() => () => update({ busy: null }), []);

  useEffect(() => {
    // The store, not this render's copy: a second run of this effect before the first one's
    // update arrives (React's development double effects) sees the job taken.
    if (paused || current.busy !== null || frame.current === null) return;
    const job = (jobs.data?.items ?? []).find(
      (candidate) =>
        (candidate.state === 'queued' || candidate.state === 'sending') &&
        !started.current.has(candidate.id),
    );
    if (job === undefined) return;
    const target = frame.current;
    started.current.add(job.id);
    update({ busy: job.id, failure: null });
    void (async () => {
      try {
        const blob = await stationDocument(job.id);
        const printed = await printPdf(target, blob, job.copies);
        await stationResult(job.id, 'printed');
        update({ last: job, dialog: printed.dialog });
        playTone('sent');
      } catch (error) {
        const message = error instanceof Error ? error.message : t('lb.failed');
        update({ failure: message });
        playTone('error');
        await stationResult(job.id, 'failed', message).catch(() => undefined);
        window.setTimeout(() => {
          started.current.delete(job.id);
          setRetries((count) => count + 1);
        }, RETRY_AFTER_MS);
      } finally {
        // The fresh list first, then the next job: never the list from before this print.
        await queryClient.invalidateQueries({ queryKey: ['labels'] });
        update({ busy: null });
      }
    })();
  }, [paused, busy, jobs.data, retries, queryClient, t]);

  // The frame the PDFs print from: off-screen, never shown.
  return (
    <iframe
      ref={frame}
      title={t('lb.station.title')}
      aria-hidden="true"
      tabIndex={-1}
      className="pointer-events-none fixed size-1 opacity-0"
    />
  );
}
