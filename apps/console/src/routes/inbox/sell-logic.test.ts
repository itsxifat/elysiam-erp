import { chatHintDetector } from '@elysium/domain/inbox';
import { formatMoneyText } from '@elysium/i18n';
import { en } from '@elysium/i18n/locales/sections/inbox-sell.en';
import { describe, expect, it } from 'vitest';

import type { MessageView } from './api.js';
import { fill } from './logic.js';
import type { PickerProduct, PickerVariant } from './sell-api.js';
import {
  addToDraft,
  chooseVariant,
  emptyDraft,
  freshInbound,
  lineName,
  measureParts,
  orderBody,
  placeCheck,
  prefillCustomer,
  readCard,
  summaryText,
  takaInput,
  typeCustomer,
  typedPhone,
  type SellDraft,
} from './sell-logic.js';

/**
 * The panel's selling rules (M44b): the card's reading of the newest messages, choosing a size,
 * the draft's prefill, what still stops it, the body for the order desk's route, the summary.
 */

const detector = chatHintDetector({ colours: ['Black', 'White'] });

let n = 0;
function message(
  text: string,
  minutesAgo: number,
  direction: 'inbound' | 'outbound' = 'inbound',
): MessageView {
  n += 1;
  return {
    id: `m${String(n)}`,
    direction,
    text,
    attachments: [],
    status: direction === 'inbound' ? 'received' : 'sent',
    sentBy: null,
    at: new Date(Date.UTC(2026, 9, 12, 10, 0) - minutesAgo * 60_000).toISOString(),
    sentAt: null,
    deliveredAt: null,
    readAt: null,
    error: null,
  };
}

const variant = (over: Partial<PickerVariant>): PickerVariant => ({
  skuId: 'sku',
  code: 'ELY-PNJ-0001-M',
  size: 'M',
  colour: null,
  label: 'M',
  pricePoisha: '150000',
  compareAtPoisha: null,
  available: 3,
  ...over,
});

const panjabi: PickerProduct = {
  id: 'p1',
  name: 'Eid Panjabi',
  imageFileId: null,
  sizeChartId: 'c1',
  matchedSkuId: null,
  minPricePoisha: '150000',
  maxPricePoisha: '160000',
  variants: [
    variant({ skuId: 's-m', size: 'M', label: 'M' }),
    variant({ skuId: 's-l', size: 'L', label: 'L', available: 0 }),
    variant({ skuId: 's-xxl', size: '2XL', label: '2XL', pricePoisha: '160000' }),
  ],
};

describe('the side card reads the newest customer messages', () => {
  const messages = [
    message('L size 2 ta', 30),
    message('ok', 20, 'outbound'),
    message('আমার বুকের মাপ ৪২, এক্সএল সাইজের ২টা দিবেন। 01712345678', 5),
  ];

  it('reads size, quantity, chest and phone, newest first', () => {
    const read = readCard(messages, null, detector, '');
    expect(read.summary.size?.size).toBe('XL');
    expect(read.summary.quantity?.qty).toBe(2);
    expect(read.summary.measurements[0]).toMatchObject({ part: 'chest', inches: 42 });
    expect(read.phone).toBe('+8801712345678');
    expect(read.newestAt).toBe(messages[2]?.at);
    expect(read.empty).toBe(false);
  });

  it('forgets what was added or dismissed, and a phone the draft already has', () => {
    expect(freshInbound(messages, messages[2]?.at ?? null)).toEqual([]);
    expect(readCard(messages, messages[2]?.at ?? null, detector, '').empty).toBe(true);
    expect(readCard(messages, null, detector, '01712-345678').phone).toBeNull();
    expect(freshInbound(messages, messages[0]?.at ?? null).map((m) => m.id)).toEqual([
      messages[2]?.id,
    ]);
  });

  it('shows measurements as people say them', () => {
    expect(measureParts({ part: 'height', value: 5, unit: 'ft', inches: 66, kg: null })).toEqual({
      key: 'inbox.sell.unit.feet',
      values: { feet: '5', inches: '6' },
    });
    expect(measureParts({ part: 'weight', value: 60, unit: 'kg', inches: null, kg: 60 }).key).toBe(
      'inbox.sell.unit.kg',
    );
  });
});

describe('choosing and adding', () => {
  it('names a variant by its size however written, and none when the choice is open', () => {
    expect(chooseVariant(panjabi, { size: 'XXL', colour: null, qty: null })?.skuId).toBe('s-xxl');
    expect(chooseVariant(panjabi, { size: 'L', colour: null, qty: 2 })?.skuId).toBe('s-l');
    expect(chooseVariant(panjabi, { size: 'XS', colour: null, qty: null })).toBeNull();
    expect(chooseVariant(panjabi, { size: null, colour: null, qty: 2 })).toBeNull();
    const twoColours: PickerProduct = {
      ...panjabi,
      variants: [
        variant({ skuId: 'b', size: 'XL', colour: 'Black', label: 'XL / Black' }),
        variant({ skuId: 'w', size: 'XL', colour: 'White', label: 'XL / White' }),
      ],
    };
    expect(chooseVariant(twoColours, { size: 'XL', colour: null, qty: null })).toBeNull();
    expect(chooseVariant(twoColours, { size: 'XL', colour: 'white', qty: null })?.skuId).toBe('w');
    const oneSize = { ...panjabi, variants: [variant({ skuId: 'only', size: null, label: '' })] };
    expect(chooseVariant(oneSize, { size: null, colour: null, qty: null })?.skuId).toBe('only');
  });

  it('adds a line, then sets it to the asked quantity or one more', () => {
    const m = panjabi.variants[0]!;
    let draft = addToDraft(emptyDraft('c'), panjabi, m, 2);
    expect(draft.lines).toMatchObject([{ skuId: 's-m', qty: 2, unitPricePoisha: '150000' }]);
    expect(draft.focus).toEqual({ id: 'p1', name: 'Eid Panjabi' });
    draft = addToDraft(draft, panjabi, m, null);
    expect(draft.lines[0]?.qty).toBe(3);
    draft = addToDraft(draft, panjabi, m, 1);
    expect(draft.lines[0]?.qty).toBe(1);
    expect(lineName(draft.lines[0]!)).toBe('Eid Panjabi (M)');
  });
});

describe('the delivery details', () => {
  const sources = {
    name: 'Rahim',
    phone: '+8801712345678',
    address: { districtId: 1, thanaId: 10, area: null, addressLine: 'House 4, Mirpur 10' },
  };

  it('fills what is empty from the chat, never what the agent typed', () => {
    const filled = prefillCustomer(emptyDraft('c'), sources);
    expect(filled.customer).toMatchObject({
      name: 'Rahim',
      phone: '01712345678',
      districtId: 1,
      thanaId: 10,
      addressLine: 'House 4, Mirpur 10',
    });
    const typed = typeCustomer(emptyDraft('c'), 'name', '');
    expect(prefillCustomer(typed, sources).customer.name).toBe('');
    expect(prefillCustomer(filled, { ...sources, name: 'Karim' }).customer.name).toBe('Rahim');
  });

  it('reads a phone typed in either script', () => {
    expect(typedPhone('০১৭১২-৩৪৫৬৭৮')).toBe('01712345678');
    expect(typedPhone('+880 1712 345678')).toBe('01712345678');
    expect(typedPhone('1234')).toBeNull();
  });
});

describe('placing', () => {
  const ready = (): SellDraft => {
    let draft = addToDraft(emptyDraft('conv-1'), panjabi, panjabi.variants[2]!, 2);
    draft = prefillCustomer(draft, {
      name: 'Rahim',
      phone: '01712345678',
      address: { districtId: 1, thanaId: 10, area: null, addressLine: 'House 4, Road 4' },
    });
    return draft;
  };

  it('says what is missing, and is ready once nothing is', () => {
    const empty = placeCheck(emptyDraft('c'), null, { kind: 'none' });
    expect(empty.missing).toEqual(['items', 'name', 'phone', 'area', 'address']);
    expect(empty.ready).toBe(false);
    const check = placeCheck(ready(), '6000', { kind: 'none' });
    expect(check.ready).toBe(true);
    expect(check.totals?.totalPoisha).toBe(326_000n);
  });

  it('counts the discount, a typed delivery, the code and the advance', () => {
    const draft: SellDraft = {
      ...ready(),
      discountTaka: '100',
      deliveryTaka: '120',
      promoCode: 'EID10',
      advance: { method: 'bkash', transactionRef: 'TX1', amountTaka: '500' },
    };
    const check = placeCheck(draft, '6000', {
      kind: 'ok',
      discountPoisha: '1000',
      deliveryDiscountPoisha: '2000',
    });
    expect(check.totals).toMatchObject({
      itemsPoisha: 320_000n,
      discountPoisha: 11_000n,
      deliveryPoisha: 10_000n,
      totalPoisha: 319_000n,
      toCollectPoisha: 269_000n,
    });
    expect(placeCheck(draft, '6000', { kind: 'checking' }).missing).toEqual(['promo']);
    expect(placeCheck({ ...draft, discountTaka: '1.234' }, '6000', { kind: 'none' }).ready).toBe(
      false,
    );
  });

  it('sends the chat’s channel and conversation, the agent as owner, prices only when changed', () => {
    const draft = ready();
    const body = orderBody(draft, placeCheck(draft, '6000', { kind: 'none' }), {
      channel: 'messenger',
      me: 'usr_agent',
      promoApplies: false,
    });
    expect(body).toEqual({
      channel: 'facebook',
      customer: { phone: '01712345678', name: 'Rahim' },
      shipTo: { name: 'Rahim', districtId: 1, thanaId: 10, addressLine: 'House 4, Road 4' },
      lines: [{ skuId: 's-xxl', qty: 2 }],
      assignedTo: 'usr_agent',
      source: { inboxConversationId: 'conv-1' },
    });
    const repriced: SellDraft = {
      ...draft,
      deliveryTaka: '80',
      lines: draft.lines.map((line) => ({ ...line, unitPricePoisha: '155000' })),
    };
    const second = orderBody(repriced, placeCheck(repriced, '6000', { kind: 'none' }), {
      channel: 'whatsapp',
      me: null,
      promoApplies: false,
    });
    expect(second).toMatchObject({
      channel: 'whatsapp',
      lines: [{ skuId: 's-xxl', qty: 2, unitPricePoisha: '155000' }],
      deliveryChargePoisha: '8000',
    });
    expect(second).not.toHaveProperty('assignedTo');
    expect(
      orderBody(emptyDraft('c'), placeCheck(emptyDraft('c'), null, { kind: 'none' }), {
        channel: 'instagram',
        me: null,
        promoApplies: false,
      }),
    ).toBeNull();
  });

  it('takes taka as typed', () => {
    expect(takaInput('1,250.5')).toBe('125050');
    expect(takaInput('')).toBe('0');
    expect(takaInput('-5')).toBeNull();
    expect(takaInput('abc')).toBeNull();
  });

  it('writes the summary in formal English with money as Tk', () => {
    const draft = ready();
    const totals = placeCheck(draft, '6000', { kind: 'none' }).totals!;
    const text = summaryText(
      (key, values) => fill(en[key], values ?? {}),
      (amount) => formatMoneyText(amount),
      {
        orderNo: 'EL-1042',
        name: 'Rahim',
        lines: draft.lines.map((line, index) => ({
          item: lineName(line),
          qty: line.qty,
          totalPoisha: (totals.lineTotals[index] ?? 0n).toString(),
        })),
        totals,
        address: 'House 4, Road 4, Mirpur, Dhaka',
        phone: '01712345678',
      },
    );
    expect(text).toBe(
      [
        'Thank you, Rahim. Your order EL-1042 is placed.',
        'Eid Panjabi (2XL) × 2: Tk 3,200.00',
        'Delivery: Tk 60.00',
        'Total: Tk 3,260.00',
        'Cash on delivery: Tk 3,260.00',
        'Delivery to: House 4, Road 4, Mirpur, Dhaka',
        'Phone: 01712345678',
        'We will call you to confirm before it ships.',
      ].join('\n'),
    );
    expect(text).not.toMatch(/[ঀ-৿]/);
  });
});
