import { describe, expect, it } from 'vitest';

import {
  orderLabelsHtml,
  qrSvg,
  qrValue,
  type LabelOptions,
  type OrderLabel,
} from './order-labels.js';

/**
 * The label sheet's QR code (M35b, D-555; D-912): a booked parcel's tracking code as it is, and
 * before the parcel is booked the order's ten digits rather than its number in letters, the same
 * code the order's own label and slip carry. Read without a renderer; the sheet's page size and
 * picture are `files/pdf/documents-review.test.ts`'s.
 */

const LABEL: OrderLabel = {
  shopName: 'Shop',
  merchantId: 'M-123',
  orderNo: 'ELY-2610-00042',
  date: '11/10/2026',
  scan: 'ELY-2610-00042',
  consignmentNo: null,
  recipientName: 'Buyer',
  recipientPhone: '01700-000123',
  address: 'House 1, Dhanmondi, Dhaka',
  subtotal: 'Tk 3,000.00',
  discount: null,
  delivery: 'Tk 60.00',
  collect: 'Tk 3,060.00',
  total: 'Tk 3,060.00',
  paymentWords: 'Cash on delivery',
};

const OPTIONS: LabelOptions = {
  size: '4x6',
  layout: 'portrait',
  showShopName: true,
  showQr: true,
  showPrices: true,
  showCod: true,
};

describe('the label sheet’s QR code (D-912)', () => {
  it('carries the order’s ten digits until the parcel is booked, then its tracking code', () => {
    expect(qrValue(LABEL)).toBe('2610000042');
    expect(qrValue({ ...LABEL, scan: 'SFR2610ELY42' })).toBe('SFR2610ELY42');
    // An order number with no digits-only code (a counter past six digits) stays as it is.
    expect(qrValue({ ...LABEL, orderNo: 'ELY-2610-1000000', scan: 'ELY-2610-1000000' })).toBe(
      'ELY-2610-1000000',
    );
  });

  it('draws the digits in the QR code and prints them under it', () => {
    const html = orderLabelsHtml({ labels: [LABEL], options: OPTIONS, fonts: [] });
    expect(html).toContain(qrSvg('2610000042', 34));
    expect(html).toContain('<div class="scan">2610000042</div>');
    // The order number in letters stays the human copy in the header.
    expect(html).toContain('<div class="order-no">ELY-2610-00042</div>');

    const booked = orderLabelsHtml({
      labels: [{ ...LABEL, scan: 'SFR2610ELY42' }],
      options: OPTIONS,
      fonts: [],
    });
    expect(booked).toContain(qrSvg('SFR2610ELY42', 34));
    expect(booked).not.toContain('2610000042');
  });
});
