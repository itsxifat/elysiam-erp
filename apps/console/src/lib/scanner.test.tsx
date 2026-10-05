import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { describe, expect, it } from 'vitest';

import { currentScanHandler, isTypingTarget, useScanHandler } from './scanner.js';

/**
 * Where a scan goes (M38a, D-605): the key presses the console-wide listener leaves alone
 * (anywhere a person types, unless the field opted in), and the last screen to ask for scans
 * receives them until it closes.
 */

function element(html: string): HTMLElement {
  const host = document.createElement('div');
  host.innerHTML = html;
  document.body.append(host);
  const found = host.firstElementChild;
  if (!(found instanceof HTMLElement)) throw new Error('no element');
  return found;
}

describe('isTypingTarget', () => {
  it('leaves text boxes, text areas and selects alone', () => {
    expect(isTypingTarget(element('<input type="text">'))).toBe(true);
    expect(isTypingTarget(element('<input>'))).toBe(true);
    expect(isTypingTarget(element('<textarea></textarea>'))).toBe(true);
    expect(isTypingTarget(element('<select></select>'))).toBe(true);
  });

  it('listens on buttons, checkboxes and the page itself', () => {
    expect(isTypingTarget(element('<button>Go</button>'))).toBe(false);
    expect(isTypingTarget(element('<input type="checkbox">'))).toBe(false);
    expect(isTypingTarget(document.body)).toBe(false);
    expect(isTypingTarget(null)).toBe(false);
  });

  it('listens inside a field that opted in', () => {
    expect(
      isTypingTarget(element('<div data-scan="accept"><input></div>').querySelector('input')),
    ).toBe(false);
  });
});

function Listener({ name, seen }: { readonly name: string; readonly seen: string[] }) {
  useScanHandler((code) => seen.push(`${name}:${code}`));
  return null;
}

function mount(node: React.ReactNode): Root {
  const root = createRoot(document.body.appendChild(document.createElement('div')));
  act(() => root.render(node));
  return root;
}

describe('useScanHandler', () => {
  it('sends a scan to the newest screen, and back to the one before when it closes', () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const seen: string[] = [];
    expect(currentScanHandler()).toBeUndefined();
    const page = mount(<Listener name="page" seen={seen} />);
    const dialog = mount(<Listener name="dialog" seen={seen} />);
    currentScanHandler()?.('111');
    act(() => dialog.unmount());
    currentScanHandler()?.('222');
    act(() => page.unmount());
    expect(currentScanHandler()).toBeUndefined();
    expect(seen).toEqual(['dialog:111', 'page:222']);
  });
});
