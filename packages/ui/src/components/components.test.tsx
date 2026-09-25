import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { DateTime } from './date-time.js';
import { Money } from './money.js';
import { PermissionGate } from './permission-gate.js';
import { StatusBadge } from './status-badge.js';

/**
 * The kit's rules, tested where they can regress silently.
 *
 * Not every component — a button that renders is obvious from looking at it, and
 * a test asserting it has a class name is a test about the class name. These are
 * the ones where the *reasoning* is load-bearing and a plausible edit undoes it
 * without looking wrong: the timezone, the integer-poisha discipline, the
 * withheld-versus-zero distinction, and the rule that a status is a word.
 */

describe('<DateTime> renders Asia/Dhaka, not the viewer’s zone (invariant 8)', () => {
  /*
   * The case that makes this matter, and it is not the obvious one.
   *
   * 2026-09-01T23:30 Dhaka is 17:30 UTC on the same day — rendered in UTC it
   * reads as the 1st, and by luck it is right. 2026-09-01T23:30 **UTC** is
   * 05:30 Dhaka on the *2nd*: rendered in the viewer's zone it reads as the 1st,
   * and now the screen and the day book disagree about which day's takings a row
   * belongs to. Nobody notices until a variance.
   */
  it('puts a late-evening UTC instant on the next Dhaka day', () => {
    render(<DateTime value="2026-09-01T23:30:00.000Z" dateOnly />);
    expect(screen.getByText(/02 Sept 2026/)).toBeDefined();
  });

  it('keeps a Dhaka-evening instant on its own day', () => {
    // 17:30Z is 23:30 Dhaka on the 1st.
    render(<DateTime value="2026-09-01T17:30:00.000Z" dateOnly />);
    expect(screen.getByText(/01 Sept 2026/)).toBeDefined();
  });

  it('shows 24-hour Dhaka time when it is a moment rather than a date', () => {
    render(<DateTime value="2026-09-01T17:30:00.000Z" />);
    expect(screen.getByText(/23:30/)).toBeDefined();
  });

  it('carries the full instant in `dateTime` for machines', () => {
    // A screen reader and a test should get the unambiguous value while the
    // human reads Dhaka time.
    const { container } = render(<DateTime value="2026-09-01T17:30:00.000Z" />);
    expect(container.querySelector('time')?.getAttribute('dateTime')).toBe(
      '2026-09-01T17:30:00.000Z',
    );
  });

  it('renders an em dash rather than the words "Invalid Date"', () => {
    render(<DateTime value="not a date" />);
    expect(screen.getByLabelText('unknown date')).toBeDefined();
  });
});

describe('<Money> keeps integer poisha intact (invariant 1)', () => {
  it('formats a crore-scale amount that a JavaScript number would round', () => {
    /*
     * 9,007,199,254,740,993 poisha is `Number.MAX_SAFE_INTEGER + 2`: as a JSON
     * number it becomes ...992 and the last digit is gone. The component takes a
     * bigint or a string precisely so that cannot happen, and this is the
     * assertion that would fail if the prop type were ever widened to `number`
     * for convenience.
     */
    render(<Money poisha="9007199254740993" symbol={false} />);
    // 9,00,71,99,25,47,409.93 taka. The last digit is the point: as a JSON
    // number the value becomes ...992 and the 3 is gone.
    expect(screen.getByText('9,00,71,99,25,47,409.93')).toBeDefined();
  });

  it('groups in lakh and crore, not thousands', () => {
    // ৳1,23,456.78 — not ৳123,456.78. In Bangladesh the second is a number the
    // reader has to stop and re-parse.
    render(<Money poisha={12345678n} />);
    expect(screen.getByText('৳1,23,456.78')).toBeDefined();
  });

  it('uses tabular numerals, so a column lines up', () => {
    const { container } = render(<Money poisha={100n} />);
    expect(container.firstElementChild?.className).toContain('tabular-nums');
  });

  it('distinguishes withheld from zero', () => {
    /*
     * The distinction the ledger audit cared about: a role without `read:cost`
     * receives no amount at all, and rendering `0` would state a fact that is
     * not true. An em dash with an accessible name says "not for you".
     */
    render(<Money poisha="0" withheld />);
    const withheld = screen.getByLabelText('amount withheld');
    expect(withheld.textContent).not.toContain('0');
  });

  it('renders a real zero as a zero', () => {
    // The positive control for the above.
    render(<Money poisha={0n} />);
    expect(screen.getByText('৳0.00')).toBeDefined();
  });
});

describe('<StatusBadge> always carries a word', () => {
  it('renders the label, not only a colour', () => {
    /*
     * §24's floor: a label beside every status colour. A coloured dot alone is
     * unreadable to roughly one man in twelve, in a screenshot, and to anyone
     * scanning quickly.
     *
     * There is no dot-only variant to test the absence of — `children` is a
     * required prop, so the wrong usage does not compile. This asserts the label
     * survives to the DOM.
     */
    render(<StatusBadge tone="danger">Returned</StatusBadge>);
    expect(screen.getByText('Returned')).toBeDefined();
  });

  it('uses the subtle token family, so a row of badges does not shout', () => {
    const { container } = render(<StatusBadge tone="success">Delivered</StatusBadge>);
    const classes = (container.firstElementChild?.className ?? '').split(/\s+/);

    // Split on whitespace and compare whole class names. A regex over the joined
    // string cannot express this: `bg-success-subtle` contains `bg-success`, and
    // `` sits happily before the hyphen, so every word-boundary spelling of
    // "not the full-strength fill" matches the very class we require.
    expect(classes).toContain('bg-success-subtle');
    expect(classes, 'a full-strength fill competes with the primary action').not.toContain(
      'bg-success',
    );
  });
});

describe('<PermissionGate> hides rather than explains, unless asked', () => {
  it('renders nothing when the caller may not act', () => {
    const { container } = render(
      <PermissionGate allowed={false}>
        <button type="button">Approve</button>
      </PermissionGate>,
    );
    expect(container.textContent).toBe('');
  });

  it('renders the children when they may', () => {
    render(
      <PermissionGate allowed>
        <button type="button">Approve</button>
      </PermissionGate>,
    );
    expect(screen.getByRole('button', { name: 'Approve' })).toBeDefined();
  });

  it('explains when a missing panel would look like a bug', () => {
    render(
      <PermissionGate allowed={false} explain={{ title: 'Accounts only', detail: 'Ask an admin.' }}>
        <div>ledger</div>
      </PermissionGate>,
    );
    expect(screen.getByText('Accounts only')).toBeDefined();
    expect(screen.queryByText('ledger')).toBeNull();
  });
});
