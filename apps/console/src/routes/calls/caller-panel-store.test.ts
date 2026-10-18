import { afterEach, describe, expect, it } from 'vitest';

import { closeCallerPanel, openCallerPanel, openCallerPanelNow } from './caller-panel-store.js';

afterEach(() => closeCallerPanel());

describe('the caller panel’s store (D-860)', () => {
  it('opens one panel at a time, keeps the same party as it is, and closes', () => {
    expect(openCallerPanelNow()).toBeNull();

    openCallerPanel({ phone: '+8801712345678' }, { auto: true });
    const first = openCallerPanelNow();
    expect(first?.auto).toBe(true);

    // Details on the same ringing call leaves the open panel alone (and its focus rule).
    openCallerPanel({ phone: '+8801712345678' });
    expect(openCallerPanelNow()).toBe(first);

    openCallerPanel({ callId: '7c7d4f0e-3c7a-4a6e-9a77-0b1c2d3e4f50' });
    expect(openCallerPanelNow()?.auto).toBe(false);
    expect(openCallerPanelNow()?.seq).not.toBe(first?.seq);

    closeCallerPanel();
    expect(openCallerPanelNow()).toBeNull();
  });
});
