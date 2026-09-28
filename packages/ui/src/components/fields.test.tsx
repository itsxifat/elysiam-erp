import { cleanup, render, screen } from '@testing-library/react';
import { useEffect } from 'react';
import { useForm } from 'react-hook-form';
import { afterEach, describe, expect, it } from 'vitest';

import { Form } from './form.js';
import { MoneyField, PhoneField, normalizeBdPhone, poishaToTaka, takaToPoisha } from './fields.js';

/**
 * The form kit's two load-bearing conversions, and the ARIA wiring.
 *
 * Not every field — a date input that renders is obvious from looking at it. These
 * are the ones where a plausible edit breaks something silently: the taka-to-poisha
 * parse (invariant 1), the phone normalization that decides whether a pasted number
 * validates, and the error wiring that decides whether a screen-reader user can
 * complete the form at all.
 */

/*
 * Unmount between tests, explicitly.
 *
 * Testing Library auto-cleans only when vitest runs with `globals: true`, and this
 * repo does not — so without this, every `render` leaves its tree in the document
 * and `getByRole` starts finding two of everything. The symptom is a suite that
 * passes test by test and fails as a file, which is the most confusing way for a
 * test to be wrong.
 */
afterEach(cleanup);

describe('taka to integer poisha (invariant 1)', () => {
  it('scales by exactly a hundred without arithmetic', () => {
    expect(takaToPoisha('19.99')).toBe('1999');
    expect(takaToPoisha('150')).toBe('15000');
    expect(takaToPoisha('0.05')).toBe('5');
  });

  it('does not lose the last digits of a crore-scale amount', () => {
    /*
     * The failure this exists to prevent. ৳1,23,45,678.90 is 1234567890 poisha,
     * which is fine — but the parse has to be string-based anyway, because
     * `Number('19.99') * 100` is 1998.9999999999998 and the rounding that hides it
     * would be a money operation outside packages/domain/src/money.
     */
    expect(takaToPoisha('12345678.90')).toBe('1234567890');
    expect(takaToPoisha('99999999999999.99')).toBe('9999999999999999');
  });

  it('pads a single decimal place rather than reading it as poisha', () => {
    // `10.5` is ten taka fifty poisha, not ten taka five poisha. Reading the
    // fraction without padding is a hundredfold error in the customer's favour.
    expect(takaToPoisha('10.5')).toBe('1050');
  });

  it('accepts a trailing point, because that is mid-typing', () => {
    expect(takaToPoisha('10.')).toBe('1000');
  });

  it('keeps a negative sign, for a refund or a reversal', () => {
    expect(takaToPoisha('-25.50')).toBe('-2550');
  });

  it('refuses a third decimal place instead of rounding it', () => {
    // Rounding here would choose between two neighbouring amounts on the user's
    // behalf, outside the one module allowed to round (invariant 1).
    expect(takaToPoisha('10.005')).toBeNull();
  });

  it('refuses text and an empty field', () => {
    expect(takaToPoisha('')).toBeNull();
    expect(takaToPoisha('1,0,0')).toBe('10000');
    expect(takaToPoisha('twelve')).toBeNull();
  });

  it('round-trips through the display form', () => {
    for (const poisha of ['0', '5', '99', '100', '1999', '1234567890']) {
      expect(takaToPoisha(poishaToTaka(poisha))).toBe(poisha);
    }
  });

  it('shows sub-taka amounts with both decimal places', () => {
    expect(poishaToTaka('5')).toBe('0.05');
    expect(poishaToTaka('50')).toBe('0.50');
  });
});

describe('Bangladeshi phone normalization', () => {
  it('reduces every common notation to the local eleven digits', () => {
    for (const input of [
      '01712345678',
      '+880 1712-345678',
      '880 1712 345678',
      '1712345678',
      '(017) 1234-5678',
    ]) {
      expect(normalizeBdPhone(input)).toBe('01712345678');
    }
  });

  it('leaves something that is not a mobile number alone rather than inventing one', () => {
    // The contract's regex is the judge. Silently prefixing a zero onto a landline
    // would turn an invalid number into a different invalid number and lose the
    // user's ability to see what they typed.
    expect(normalizeBdPhone('229334455')).toBe('229334455');
  });
});

interface Values {
  readonly amountPoisha: string;
  readonly phone: string;
}

/**
 * A two-field form with a real react-hook-form context.
 *
 * The error is planted with `setError` rather than by running a resolver, because
 * what is under test is how a field *renders* an error the resolver produced — and
 * a test that also exercised Zod would fail for two unrelated reasons.
 */
function Harness() {
  const form = useForm<Values>({ defaultValues: { amountPoisha: '', phone: '' } });

  useEffect(() => {
    form.setError('amountPoisha', { type: 'custom', message: 'An amount is required.' });
  }, [form]);

  return (
    <Form form={form} onSubmit={() => undefined}>
      <MoneyField<Values> name="amountPoisha" label="Amount" />
      <PhoneField<Values> name="phone" label="Phone" hint="Eleven digits." />
    </Form>
  );
}

describe('a field announces its own error', () => {
  it('renders the message the resolver produced, not one of its own', () => {
    render(<Harness />);
    expect(screen.getByRole('alert').textContent).toBe('An amount is required.');
  });

  it('marks the control invalid and points it at the message', () => {
    // Without these a screen-reader user tabs onto a field that is visually red and
    // hears nothing — the difference between hard to use and impossible.
    render(<Harness />);
    const amount = screen.getByLabelText(/Amount/);
    expect(amount.getAttribute('aria-invalid')).toBe('true');
    const errorId = amount.getAttribute('aria-errormessage');
    expect(errorId).not.toBeNull();
    expect(document.getElementById(errorId ?? '')?.textContent).toBe('An amount is required.');
  });

  it('wires a hint through aria-describedby', () => {
    render(<Harness />);
    const phone = screen.getByLabelText(/Phone/);
    const hintId = phone.getAttribute('aria-describedby');
    expect(document.getElementById(hintId ?? '')?.textContent).toBe('Eleven digits.');
  });

  it('never renders a number input for money', () => {
    // `type="number"` hands us a double and adds a spinner that changes an amount
    // on a stray scroll wheel. Asserted because it is the obvious "simplification".
    render(<Harness />);
    expect(screen.getByLabelText(/Amount/).getAttribute('type')).toBe('text');
    expect(screen.getByLabelText(/Amount/).getAttribute('inputMode')).toBe('decimal');
  });
});
