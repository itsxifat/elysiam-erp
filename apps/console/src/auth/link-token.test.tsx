import { act, Suspense, use } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { useLinkToken } from './link-token.js';

/**
 * A link page keeps its token when React throws a render away and mounts the page again.
 * That happened in production: the set-password screen arrives in its own chunk, React holds
 * the reveal back a moment, the branding or the session check lands meanwhile, and the
 * screen is mounted a second time. When the first mount had already emptied the address bar,
 * the second found no fragment and a whole, unused invite said it was incomplete. A sibling
 * that suspends on the first pass is the same discarded mount, without the timing.
 */

function Shows() {
  return <p>{useLinkToken() ?? 'no token'}</p>;
}

function Waits({ until }: { readonly until: Promise<void> }) {
  use(until);
  return null;
}

let root: Root | null = null;
let host: HTMLElement;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.body.appendChild(document.createElement('div'));
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  host.remove();
  window.history.replaceState(null, '', '/');
});

describe('useLinkToken', () => {
  it('keeps the token through a mount React discards, and empties the address bar once shown', async () => {
    window.history.replaceState(null, '', '/accept-invite#token=abc_DEF-123');
    let release: () => void = () => undefined;
    const until = new Promise<void>((resolve) => {
      release = resolve;
    });

    root = createRoot(host);
    // Awaited, because the first pass suspends (React warns of an unawaited one).
    await act(async () => {
      root?.render(
        <Suspense fallback={<p>waiting</p>}>
          <Shows />
          <Waits until={until} />
        </Suspense>,
      );
      await Promise.resolve();
    });
    expect(host.textContent).toBe('waiting');
    // Nothing was shown, so nothing was taken out of the address bar.
    expect(window.location.hash).toBe('#token=abc_DEF-123');

    await act(async () => {
      release();
      await until;
    });
    expect(host.textContent).toBe('abc_DEF-123');
    expect(window.location.hash).toBe('');
    expect(window.location.pathname).toBe('/accept-invite');
  });

  it('has no token without one, and still empties the address bar', () => {
    window.history.replaceState(null, '', '/accept-invite#something-else');
    root = createRoot(host);
    act(() => root?.render(<Shows />));
    expect(host.textContent).toBe('no token');
    expect(window.location.hash).toBe('');
  });
});
