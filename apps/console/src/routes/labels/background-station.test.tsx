import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../env.js', () => ({ env: { VITE_API_URL: 'http://api.test' } }));

const { printPdf, useStationLock, PRINT_DIALOG_MS } = await import('./background-station.js');

/**
 * One tab of a label computer prints (D-900): each asks the browser for the terminal's lock, the
 * first holds it and prints, a second waits and takes over the moment the first closes. A fake
 * `navigator.locks` with the Web Locks semantics the station relies on stands in for Chrome's.
 */

type Grant = () => Promise<void>;

function fakeLocks() {
  const held = new Map<string, boolean>();
  const waiting = new Map<string, { grant: Grant; signal?: AbortSignal; done: () => void }[]>();
  const run = (name: string) => {
    const queue = waiting.get(name) ?? [];
    while (queue.length > 0 && held.get(name) !== true) {
      const next = queue.shift();
      if (next === undefined) break;
      if (next.signal?.aborted === true) continue;
      held.set(name, true);
      void next.grant().finally(() => {
        held.set(name, false);
        next.done();
        run(name);
      });
    }
  };
  return {
    request(name: string, options: { signal?: AbortSignal }, grant: Grant): Promise<void> {
      return new Promise<void>((resolve, reject) => {
        const entry = {
          grant,
          done: resolve,
          ...(options.signal ? { signal: options.signal } : {}),
        };
        options.signal?.addEventListener('abort', () => {
          const queue = waiting.get(name) ?? [];
          const at = queue.indexOf(entry);
          if (at >= 0) {
            queue.splice(at, 1);
            reject(new DOMException('aborted', 'AbortError'));
          }
        });
        waiting.set(name, [...(waiting.get(name) ?? []), entry]);
        run(name);
      });
    },
  };
}

function Holder({ name, seen }: { readonly name: string; readonly seen: (held: boolean) => void }) {
  seen(useStationLock(name));
  return null;
}

let roots: Root[] = [];

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  Object.defineProperty(navigator, 'locks', { value: fakeLocks(), configurable: true });
});

afterEach(() => {
  for (const root of roots) act(() => root.unmount());
  roots = [];
});

async function mount(name: string): Promise<{ held: () => boolean; root: Root }> {
  let last = false;
  const root = createRoot(document.body.appendChild(document.createElement('div')));
  roots.push(root);
  await act(async () => {
    root.render(<Holder name={name} seen={(held) => (last = held)} />);
    await Promise.resolve();
  });
  return { held: () => last, root };
}

describe('the print station’s lock', () => {
  it('lets one tab print, and the next take over when it closes', async () => {
    const first = await mount('erp.print-station:t1');
    const second = await mount('erp.print-station:t1');
    expect(first.held()).toBe(true);
    expect(second.held()).toBe(false);

    await act(async () => {
      first.root.unmount();
      roots = roots.filter((root) => root !== first.root);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(second.held()).toBe(true);
  });

  it('holds another terminal’s lock on its own', async () => {
    const one = await mount('erp.print-station:t1');
    const other = await mount('erp.print-station:t2');
    expect(one.held()).toBe(true);
    expect(other.held()).toBe(true);
  });
});

describe('printing a job', () => {
  /** A frame whose print call takes `printMs`, as Chrome's does with (or without) its dialog. */
  function frameTaking(printMs: number) {
    let clock = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => clock);
    const prints: number[] = [];
    const frame = {
      onload: null as (() => void) | null,
      set src(_url: string) {
        setTimeout(() => this.onload?.(), 0);
      },
      contentWindow: {
        focus: () => undefined,
        print: () => {
          prints.push(clock);
          clock += printMs;
        },
      },
    };
    return { frame: frame as unknown as HTMLIFrameElement, prints };
  }

  beforeEach(() => {
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:job');
    vi.spyOn(URL, 'revokeObjectURL').mockReturnValue(undefined);
  });
  afterEach(() => vi.restoreAllMocks());

  it('prints each copy, and says nothing of a dialog when Chrome prints silently', async () => {
    const { frame, prints } = frameTaking(20);
    const printed = await printPdf(frame, new Blob(['%PDF']), 2);
    expect(prints).toHaveLength(2);
    expect(printed.dialog).toBe(false);
  });

  it('notices a print that waited on Chrome’s dialog (no --kiosk-printing)', async () => {
    const { frame } = frameTaking(PRINT_DIALOG_MS + 500);
    expect((await printPdf(frame, new Blob(['%PDF']), 1)).dialog).toBe(true);
  });
});
