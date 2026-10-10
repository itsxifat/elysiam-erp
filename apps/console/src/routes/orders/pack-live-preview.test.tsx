import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

import { LocaleProvider } from '../../i18n/locale.js';

vi.mock('../../env.js', () => ({ env: { VITE_API_URL: 'http://api.test' } }));

const { CameraLivePreview, LIVE_PREVIEW_IDLE_MS, LIVE_PREVIEW_REFRESH_MS } =
  await import('./pack-live-preview.js');

/**
 * The packing table's live view (M38c, D-683): it asks for the camera's newest frame every
 * 400 ms, shows each as an object URL with a "Live" badge, lets the previous one go, pauses
 * while the tab is hidden, and says so when no picture comes.
 */

const CAMERA = '6b0f3a0e-8f0e-4c55-9d0b-2b4a1f2b7c11';

let root: Root | null = null;
let host: HTMLElement;
let fetchMock: Mock<(input: unknown) => Promise<Response>>;
let created: string[];
let revoked: string[];
let visibility: DocumentVisibilityState;

beforeEach(() => {
  vi.useFakeTimers();
  created = [];
  revoked = [];
  visibility = 'visible';
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => visibility,
  });
  let counter = 0;
  vi.spyOn(URL, 'createObjectURL').mockImplementation(() => {
    counter += 1;
    const url = `blob:frame-${String(counter)}`;
    created.push(url);
    return url;
  });
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation((url: string) => {
    revoked.push(url);
  });
  fetchMock = vi.fn(() =>
    Promise.resolve(new Response(new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xd9])]))),
  );
  vi.stubGlobal('fetch', fetchMock);
  host = document.createElement('div');
  document.body.append(host);
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  host.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

async function render(): Promise<void> {
  await act(async () => {
    root = createRoot(host);
    root.render(
      <LocaleProvider>
        <CameraLivePreview cameraId={CAMERA} label="Packing table" />
      </LocaleProvider>,
    );
    await vi.advanceTimersByTimeAsync(0);
  });
}

const view = () => host.querySelector('[data-testid="pack-live-preview"]');

describe('the live view', () => {
  it('shows each new frame with the Live badge and lets the previous one go', async () => {
    await render();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain(`/v1/packing/cameras/${CAMERA}/preview`);
    expect(view()?.getAttribute('data-state')).toBe('live');
    const image = host.querySelector('img');
    expect(image?.getAttribute('src')).toBe('blob:frame-1');
    expect(image?.getAttribute('alt')).toContain('Packing table');
    expect(view()?.textContent).toContain('Live');

    await act(async () => {
      await vi.advanceTimersByTimeAsync(LIVE_PREVIEW_REFRESH_MS);
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(host.querySelector('img')?.getAttribute('src')).toBe('blob:frame-2');
    expect(revoked).toEqual(['blob:frame-1']);
  });

  it('stops asking while the tab is hidden and starts again when it is shown', async () => {
    await render();
    visibility = 'hidden';
    await act(async () => {
      await vi.advanceTimersByTimeAsync(LIVE_PREVIEW_REFRESH_MS * 5);
    });
    const whileHidden = fetchMock.mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(LIVE_PREVIEW_REFRESH_MS * 5);
    });
    expect(fetchMock.mock.calls.length).toBe(whileHidden);
    visibility = 'visible';
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(fetchMock.mock.calls.length).toBe(whileHidden + 1);
  });

  it('asks every 3 s while no frame comes (204), says so, and goes back to 400 ms when frames return', async () => {
    let frames = false;
    fetchMock.mockImplementation(() =>
      Promise.resolve(
        frames
          ? new Response(new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xd9])]))
          : new Response(null, { status: 204 }),
      ),
    );
    await render();
    expect(view()?.getAttribute('data-state')).toBe('waiting');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // Backed off: nothing more at 400 ms, the next ask at 3 s.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(LIVE_PREVIEW_REFRESH_MS * 2);
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(LIVE_PREVIEW_IDLE_MS);
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(LIVE_PREVIEW_IDLE_MS);
    });
    expect(view()?.getAttribute('data-state')).toBe('offline');
    expect(host.querySelector('img')).toBeNull();
    // Frames come back: live, and asked for every 400 ms again.
    frames = true;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(LIVE_PREVIEW_IDLE_MS);
    });
    expect(view()?.getAttribute('data-state')).toBe('live');
    const live = fetchMock.mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(LIVE_PREVIEW_REFRESH_MS);
    });
    expect(fetchMock.mock.calls.length).toBe(live + 1);
    act(() => root?.unmount());
    root = null;
    const asked = fetchMock.mock.calls.length;
    await vi.advanceTimersByTimeAsync(LIVE_PREVIEW_IDLE_MS * 2);
    expect(fetchMock.mock.calls.length).toBe(asked);
  });
});
