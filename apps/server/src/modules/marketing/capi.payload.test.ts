import { poisha } from '@elysium/domain';
import { buildPurchaseEvent, type PurchaseEventInput } from '@elysium/domain/marketing';
import { describe, expect, it } from 'vitest';

import { sha256Hex } from './credentials.js';

/**
 * M18 acceptance check 3: a snapshot of the Conversions API payload shows no plaintext
 * PII and a stable `event_id`.
 *
 * Built with the real SHA-256 the sender uses, so the snapshot is the exact JSON Meta
 * would receive. The buyer is a test value, not anybody.
 */

const ORDER_ID = '7f1c2e9a-0000-4000-8000-000000000001';

const INPUT: PurchaseEventInput = {
  orderId: ORDER_ID,
  customerId: '7f1c2e9a-0000-4000-8000-0000000000c1',
  channel: 'whatsapp',
  deliveredAt: new Date('2026-10-01T08:30:00.000Z'),
  valuePoisha: poisha(245_050),
  phoneE164: '+8801712345678',
  name: 'Nusrat Jahan',
  city: 'Cox’s Bazar',
  includeNameAndCity: true,
  contents: [
    { id: 'SAREE-RED-M', quantity: 1 },
    { id: 'KURTI-L', quantity: 2 },
  ],
};

/** Every way the buyer's details could leak in clear: as typed and as normalised. */
const PLAINTEXT = [
  '+8801712345678',
  '8801712345678',
  '01712345678',
  '1712345678',
  'Nusrat',
  'nusrat',
  'Jahan',
  'jahan',
  'Cox',
  'coxsbazar',
  'Bazar',
];

describe('the Conversions API Purchase payload (check 3)', () => {
  it('matches the snapshot: hashed identifiers, the order id as event_id, BDT value', () => {
    expect(buildPurchaseEvent(INPUT, sha256Hex)).toMatchInlineSnapshot(`
      {
        "action_source": "chat",
        "custom_data": {
          "content_type": "product",
          "contents": [
            {
              "id": "SAREE-RED-M",
              "quantity": 1,
            },
            {
              "id": "KURTI-L",
              "quantity": 2,
            },
          ],
          "currency": "BDT",
          "order_id": "7f1c2e9a-0000-4000-8000-000000000001",
          "value": 2450.5,
        },
        "event_id": "7f1c2e9a-0000-4000-8000-000000000001",
        "event_name": "Purchase",
        "event_time": 1790843400,
        "user_data": {
          "country": [
            "5e657ff6158d3e2a6d23e2a523917a2305acee9423365e268695c4b7b8919f4c",
          ],
          "ct": [
            "43dea41fc4e7f595cead44b14c4bfb1033a9af49026171bfc5b03a66b290ad37",
          ],
          "external_id": [
            "3440faa29a46c34977de2fb0be9a73711175ef5c2a0cb5a07689631812ec9fe6",
          ],
          "fn": [
            "db379336877389bc5eff1a3e18811454aa8357b28d6f15b4eb07291efe7c8029",
          ],
          "ln": [
            "5f505d5fc213e3787b30a2a49117bd279e236fbdc2a57804e268cd0a20f4be13",
          ],
          "ph": [
            "c327520f85b0c6058fed05dfc0a63d8755f325b6ea1b550824f4a8e380d75de1",
          ],
        },
      }
    `);
  });

  it('carries no plaintext personal data anywhere in the JSON', () => {
    const json = JSON.stringify(buildPurchaseEvent(INPUT, sha256Hex));
    for (const plain of PLAINTEXT) expect(json).not.toContain(plain);
    // Every identifier under user_data is a 64-character SHA-256 hex digest.
    const event = buildPurchaseEvent(INPUT, sha256Hex);
    for (const values of Object.values(event.user_data)) {
      for (const value of values) expect(value).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it('is the same event however often it is built: the event_id never changes', () => {
    const first = buildPurchaseEvent(INPUT, sha256Hex);
    const again = buildPurchaseEvent({ ...INPUT, contents: [...INPUT.contents] }, sha256Hex);
    expect(again).toEqual(first);
    expect(first.event_id).toBe(ORDER_ID);
  });

  it('leaves name and city out without consent', () => {
    const event = buildPurchaseEvent({ ...INPUT, includeNameAndCity: false }, sha256Hex);
    expect(Object.keys(event.user_data).sort()).toEqual(['country', 'external_id', 'ph']);
  });
});
