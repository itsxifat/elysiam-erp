import { poisha } from '@elysium/domain';

import type { DocumentBrand, OrderDocumentData } from './order-documents.js';

/**
 * A realistic order for the document tests and the review screenshots (M43): a long
 * Dhaka address, several lines with sizes and colours, a discount, a delivery charge, an
 * advance paid and a booked parcel. Every name and number is made up; the phone is in a test
 * range (invariant 10).
 */

export const SAMPLE_BRAND: DocumentBrand = {
  displayName: 'Elysiam Lifestyle BD',
  legalName: 'Elysiam Lifestyle BD Limited',
  address: 'House 12, Road 5, Dhanmondi, Dhaka 1205',
  vatNo: '004512345678',
  invoiceFooter: null,
  logo: null,
};

export const SAMPLE_ORDER: OrderDocumentData = {
  orderNo: 'ELY-2610-00042',
  issuedOn: '2026-10-11',
  channel: 'facebook',
  customerName: 'Nusrat Jahan Chowdhury',
  customerPhone: '01700-000123',
  addressLine:
    'Flat 7B, Concord Royal Court, House 275, Road 27 (Old), Dhanmondi Residential Area, near Rabindra Sarobar, opposite the city bank ATM',
  locality: 'Dhanmondi, Dhanmondi',
  district: 'Dhaka',
  lines: [
    {
      name: 'Linen Panjabi',
      sku: 'ELY-PNJ-0012-M-NVY',
      size: 'M',
      colour: 'Navy',
      other: null,
      qty: 2,
      unitPricePoisha: poisha(245_000n),
      lineDiscountPoisha: poisha(0n),
    },
    {
      name: 'Cotton Kurti with block print',
      sku: 'ELY-KRT-0031-L-MRN',
      size: 'L',
      colour: 'Maroon',
      other: 'Long sleeve',
      qty: 1,
      unitPricePoisha: poisha(189_000n),
      lineDiscountPoisha: poisha(10_000n),
    },
    {
      name: 'Printed Georgette Orna',
      sku: 'ELY-ORN-0007-FS-OLV',
      size: 'Free size',
      colour: 'Olive',
      other: null,
      qty: 3,
      unitPricePoisha: poisha(68_500n),
      lineDiscountPoisha: poisha(0n),
    },
    {
      name: 'Gift wrap',
      sku: 'ELY-GFT-0001',
      size: null,
      colour: null,
      other: null,
      qty: 1,
      unitPricePoisha: poisha(5_000n),
      lineDiscountPoisha: poisha(0n),
    },
  ],
  // Σ qty × unit price, before any discount (the domain's `itemsPoisha`):
  // 2 × 2,450 + 1,890 + 3 × 685 + 50 = 4,900 + 1,890 + 2,055 + 50 = 8,895.
  itemsPoisha: poisha(889_500n),
  // The kurti's line discount (100) and an order discount (195).
  discountPoisha: poisha(29_500n),
  deliveryChargePoisha: poisha(6_000n),
  advancePaidPoisha: poisha(20_000n),
  // 8,895 − 295 + 60 − 200 = 8,460.
  codAmountPoisha: poisha(846_000n),
  notes: 'Call before delivery. The buyer is at work until 6 pm; deliver to the guard if absent.',
  courier: { name: 'Steadfast', consignmentNo: '127403991', trackingCode: 'SFR2610ELY42' },
};
