import {
  draftTotalsOf,
  extractBdPhones,
  hintsInMessages,
  recommendSize,
  sameSize,
  summariseHints,
  type DraftProblem,
  type DraftTotals,
  type HintDetector,
  type HintSummary,
  type MeasurementHint,
  type ProductRef,
  type SizeRecommendation,
} from '@elysium/domain/inbox';

import type { ChannelKind, MessageView } from './api.js';
import type { PickerProduct, PickerVariant, SizeChart } from './sell-api.js';

/**
 * Selling from the chat, the screen's rules (M44b, D-770 to D-775): the draft order a panel
 * keeps per conversation, what the side card reads from the newest messages, which size and
 * colour of a product a request names, what is still missing before the order can be placed,
 * the body sent to the order desk's route, and the summary the customer is sent. Pure, so each
 * is tested without a browser; the arithmetic is the domain's (`draftTotalsOf`).
 */

export const ADVANCE_METHODS = ['bkash', 'nagad', 'bank'] as const;
export type AdvanceMethod = (typeof ADVANCE_METHODS)[number];

/** Messenger, Instagram and WhatsApp as §9's order channels name them (D-742). */
export const ORDER_CHANNEL_FOR: Readonly<
  Record<ChannelKind, 'facebook' | 'instagram' | 'whatsapp'>
> = {
  messenger: 'facebook',
  instagram: 'instagram',
  whatsapp: 'whatsapp',
};

export interface DraftLine {
  readonly skuId: string;
  readonly productId: string;
  readonly productName: string;
  readonly code: string;
  readonly size: string | null;
  readonly colour: string | null;
  readonly label: string;
  /** The catalog's selling price when it was picked. */
  readonly listPricePoisha: string;
  /** What the agent charges: the list price unless they typed another. */
  readonly unitPricePoisha: string;
  readonly qty: number;
  /** Units in hand when it was picked; null when unknown. */
  readonly available: number | null;
}

export interface DraftCustomer {
  readonly name: string;
  /** As typed: `01712-345678`, Bangla digits allowed. */
  readonly phone: string;
  readonly districtId: number | null;
  readonly thanaId: number | null;
  readonly area: string;
  readonly addressLine: string;
}

export type CustomerField = keyof DraftCustomer;

export interface PlacedOrder {
  readonly orderId: string;
  readonly orderNo: string;
  /** The summary to send, written when the order was placed. */
  readonly summary: string;
  /** The advance failed to record: its reason, so the agent can try again. */
  readonly advanceError: string | null;
}

export interface SellDraft {
  readonly version: 1;
  readonly conversationId: string;
  readonly updatedAt: number;
  readonly lines: readonly DraftLine[];
  readonly customer: DraftCustomer;
  /** Fields the agent typed: the chat never fills these again. */
  readonly typed: readonly CustomerField[];
  /** Null: the delivery zone's charge. A string: what the agent typed, in taka. */
  readonly deliveryTaka: string | null;
  readonly discountTaka: string;
  readonly promoCode: string;
  readonly advance: {
    readonly method: AdvanceMethod;
    readonly transactionRef: string;
    readonly amountTaka: string;
  } | null;
  readonly notes: string;
  /** The newest customer message the card has been acted on (added or dismissed). */
  readonly hintsSeenAt: string | null;
  /** The product the agent last picked: the one the card's size applies to next. */
  readonly focus: { readonly id: string; readonly name: string } | null;
  readonly placed: PlacedOrder | null;
}

export function emptyDraft(conversationId: string, now = Date.now()): SellDraft {
  return {
    version: 1,
    conversationId,
    updatedAt: now,
    lines: [],
    customer: {
      name: '',
      phone: '',
      districtId: null,
      thanaId: null,
      area: '',
      addressLine: '',
    },
    typed: [],
    deliveryTaka: null,
    discountTaka: '',
    promoCode: '',
    advance: null,
    notes: '',
    hintsSeenAt: null,
    focus: null,
    placed: null,
  };
}

// --- the side card ---------------------------------------------------------------------------

/** How many of the newest customer messages the card reads. */
export const CARD_MESSAGES = 20;

/** Customer messages newer than `seenAt` (all when null), the newest `CARD_MESSAGES`. */
export function freshInbound(
  messages: readonly MessageView[],
  seenAt: string | null,
): MessageView[] {
  const since = seenAt === null ? Number.NEGATIVE_INFINITY : Date.parse(seenAt);
  return messages
    .filter(
      (message) =>
        message.direction === 'inbound' &&
        message.text !== null &&
        message.text.trim() !== '' &&
        Date.parse(message.at) > since,
    )
    .slice(-CARD_MESSAGES);
}

export interface CardRead {
  readonly summary: HintSummary;
  /** The newest phone in those messages, E.164, when it is not the draft's already. */
  readonly phone: string | null;
  /** The newest message read, to mark the card acted on. */
  readonly newestAt: string | null;
  /** Whether there is anything to offer. */
  readonly empty: boolean;
}

export function readCard(
  messages: readonly MessageView[],
  seenAt: string | null,
  detector: HintDetector,
  draftPhone: string,
): CardRead {
  const fresh = freshInbound(messages, seenAt);
  const summary = summariseHints(
    hintsInMessages(
      fresh.map((message) => ({ id: message.id, text: message.text })),
      detector,
    ),
  );
  let phone: string | null = null;
  for (const message of fresh) {
    const found = extractBdPhones(message.text ?? '');
    if (found.length > 0) phone = found[found.length - 1] ?? phone;
  }
  const current = toE164(draftPhone);
  if (phone !== null && phone === current) phone = null;
  return {
    summary,
    phone,
    newestAt: fresh[fresh.length - 1]?.at ?? null,
    empty: summary.empty && phone === null,
  };
}

/** What a product reference asks the picker: the code, the barcode, the slug. */
export function refQuery(ref: ProductRef): string {
  return ref.type === 'code' ? ref.code : ref.type === 'barcode' ? ref.barcode : ref.slug;
}

/** The measurements the size chart is read for (a length in inches, a weight in kg). */
export function bodyOf(measurements: readonly MeasurementHint[]) {
  return measurements.map((hint) => ({ part: hint.part, inches: hint.inches, kg: hint.kg }));
}

/** The size the product's chart gives the card's measurements, or null when none applies. */
export function chartRecommendation(
  chart: SizeChart | undefined,
  measurements: readonly MeasurementHint[],
): SizeRecommendation | null {
  if (chart === undefined || measurements.length === 0) return null;
  return recommendSize(chart, bodyOf(measurements));
}

/** "5 ft 6 in", "60 kg", "42 in": how the card shows a measurement. */
export function measureParts(
  hint: Pick<MeasurementHint, 'part' | 'value' | 'unit' | 'inches' | 'kg'>,
):
  | { readonly key: 'inbox.sell.unit.feet'; readonly values: { feet: string; inches: string } }
  | {
      readonly key: 'inbox.sell.unit.in' | 'inbox.sell.unit.cm' | 'inbox.sell.unit.kg';
      readonly values: { value: string };
    } {
  if (hint.part === 'weight') {
    return { key: 'inbox.sell.unit.kg', values: { value: String(hint.kg ?? hint.value) } };
  }
  if (hint.part === 'height' && hint.inches !== null && hint.unit !== 'cm') {
    const whole = Math.round(hint.inches);
    return {
      key: 'inbox.sell.unit.feet',
      values: { feet: String(Math.floor(whole / 12)), inches: String(whole % 12) },
    };
  }
  return hint.unit === 'cm'
    ? { key: 'inbox.sell.unit.cm', values: { value: String(hint.value) } }
    : { key: 'inbox.sell.unit.in', values: { value: String(hint.inches ?? hint.value) } };
}

// --- choosing and adding ---------------------------------------------------------------------

export interface Want {
  readonly size: string | null;
  readonly colour: string | null;
  readonly qty: number | null;
}

const same = (a: string | null, b: string | null) =>
  a !== null && b !== null && a.trim().toLowerCase() === b.trim().toLowerCase();

/**
 * The variant a request names: its size (however written) and colour. A product with one
 * variant is that variant; a request that leaves a real choice open (two colours of XL and no
 * colour said) names none, so the picker asks.
 */
export function chooseVariant(product: PickerProduct, want: Want): PickerVariant | null {
  const variants = product.variants;
  if (variants.length === 1) return variants[0] ?? null;
  let candidates = variants;
  if (want.size !== null) {
    const size = want.size;
    candidates = candidates.filter((variant) => sameSize(variant.size ?? variant.label, size));
  }
  if (want.colour !== null && candidates.some((variant) => variant.colour !== null)) {
    candidates = candidates.filter((variant) => same(variant.colour, want.colour));
  }
  if (want.size === null && want.colour === null) return null;
  return candidates.length === 1 ? (candidates[0] ?? null) : null;
}

/** The draft's quantities: one to 999, as the desk takes them. */
export const MAX_QTY = 999;

const clampQty = (qty: number) => Math.min(Math.max(Math.trunc(qty), 1), MAX_QTY);

/**
 * Add a variant, or change the one already there (the server takes a SKU once per order): to the
 * detected quantity when there is one, else one more.
 */
export function addToDraft(
  draft: SellDraft,
  product: Pick<PickerProduct, 'id' | 'name'>,
  variant: PickerVariant,
  qty: number | null,
): SellDraft {
  const existing = draft.lines.find((line) => line.skuId === variant.skuId);
  const lines =
    existing === undefined
      ? [
          ...draft.lines,
          {
            skuId: variant.skuId,
            productId: product.id,
            productName: product.name,
            code: variant.code,
            size: variant.size,
            colour: variant.colour,
            label: variant.label,
            listPricePoisha: variant.pricePoisha,
            unitPricePoisha: variant.pricePoisha,
            qty: clampQty(qty ?? 1),
            available: variant.available,
          },
        ]
      : draft.lines.map((line) =>
          line.skuId === variant.skuId
            ? {
                ...line,
                qty: clampQty(qty ?? line.qty + 1),
                available: variant.available,
              }
            : line,
        );
  return { ...draft, lines, focus: { id: product.id, name: product.name }, placed: null };
}

export function setLineQty(draft: SellDraft, skuId: string, qty: number): SellDraft {
  if (!Number.isFinite(qty)) return draft;
  return {
    ...draft,
    lines: draft.lines.map((line) =>
      line.skuId === skuId ? { ...line, qty: clampQty(qty) } : line,
    ),
  };
}

export function setLinePrice(draft: SellDraft, skuId: string, pricePoisha: string): SellDraft {
  return {
    ...draft,
    lines: draft.lines.map((line) =>
      line.skuId === skuId ? { ...line, unitPricePoisha: pricePoisha } : line,
    ),
  };
}

export function removeLine(draft: SellDraft, skuId: string): SellDraft {
  return { ...draft, lines: draft.lines.filter((line) => line.skuId !== skuId) };
}

// --- the customer --------------------------------------------------------------------------------

/** `+8801712345678` → `01712345678`; anything else as it is. */
export function nationalPhone(e164: string): string {
  return /^\+8801\d{9}$/.test(e164) ? `0${e164.slice(4)}` : e164;
}

const BANGLA_DIGITS = '০১২৩৪৫৬৭৮৯';

/** A typed number as `01XXXXXXXXX`, or null while it is not a Bangladeshi mobile yet. */
export function typedPhone(input: string): string | null {
  const digits = input
    .replace(/[০-৯]/g, (digit) => String(BANGLA_DIGITS.indexOf(digit)))
    .replace(/\D+/g, '');
  let national = digits;
  if (national.startsWith('00880')) national = national.slice(5);
  else if (national.startsWith('880')) national = national.slice(3);
  if (/^1[3-9]\d{8}$/.test(national)) national = `0${national}`;
  return /^01[3-9]\d{8}$/.test(national) ? national : null;
}

function toE164(input: string): string | null {
  const national = typedPhone(input);
  return national === null ? null : `+88${national}`;
}

export interface CustomerSources {
  readonly name: string | null;
  /** E.164 or as typed. */
  readonly phone: string | null;
  readonly address: {
    readonly districtId: number;
    readonly thanaId: number;
    readonly area: string | null;
    readonly addressLine: string;
  } | null;
}

/**
 * Fill what is still empty from the chat (the contact, the matched customer, what was found in
 * the messages), never a field the agent typed or one already filled.
 */
export function prefillCustomer(draft: SellDraft, sources: CustomerSources): SellDraft {
  const open = (field: CustomerField) => !draft.typed.includes(field);
  const customer = { ...draft.customer };
  let changed = false;
  if (open('name') && customer.name === '' && sources.name !== null && sources.name !== '') {
    customer.name = sources.name;
    changed = true;
  }
  if (open('phone') && customer.phone === '' && sources.phone !== null) {
    customer.phone = nationalPhone(sources.phone);
    changed = true;
  }
  const address = sources.address;
  if (
    address !== null &&
    open('districtId') &&
    open('thanaId') &&
    open('addressLine') &&
    customer.districtId === null &&
    customer.thanaId === null &&
    customer.addressLine === ''
  ) {
    customer.districtId = address.districtId;
    customer.thanaId = address.thanaId;
    customer.area = customer.area === '' ? (address.area ?? '') : customer.area;
    customer.addressLine = address.addressLine;
    changed = true;
  }
  return changed ? { ...draft, customer } : draft;
}

/** The agent typed into a field: it is theirs from now on. */
export function typeCustomer<F extends CustomerField>(
  draft: SellDraft,
  field: F,
  value: DraftCustomer[F],
): SellDraft {
  return {
    ...draft,
    customer: { ...draft.customer, [field]: value },
    typed: draft.typed.includes(field) ? draft.typed : [...draft.typed, field],
  };
}

// --- money and placing -----------------------------------------------------------------------

export type PromoState =
  | { readonly kind: 'none' }
  | { readonly kind: 'checking' }
  | {
      readonly kind: 'ok';
      readonly discountPoisha: string;
      readonly deliveryDiscountPoisha: string;
    }
  | { readonly kind: 'not_found' }
  | { readonly kind: 'refused'; readonly reason: string }
  | { readonly kind: 'failed' };

/** Taka as typed (`1,250.50`) → poisha, or null when it is not a non-negative amount. */
export function takaInput(text: string): string | null {
  const trimmed = text.trim().replace(/,/g, '');
  if (trimmed === '') return '0';
  const match = /^(\d*)(?:\.(\d{0,2}))?$/.exec(trimmed);
  if (match === null) return null;
  const [, whole = '', fraction] = match;
  if (whole === '' && (fraction === undefined || fraction === '')) return null;
  return `${whole === '' ? '0' : whole}${(fraction ?? '').padEnd(2, '0')}`.replace(/^0+(?=\d)/, '');
}

export type MissingField = 'items' | 'name' | 'phone' | 'area' | 'address' | 'money' | 'promo';

export interface PlaceCheck {
  readonly totals: DraftTotals | null;
  readonly deliveryPoisha: string | null;
  readonly discountPoisha: string | null;
  readonly advancePoisha: string | null;
  readonly missing: readonly MissingField[];
  readonly problems: readonly DraftProblem[];
  readonly ready: boolean;
}

/** The draft's totals and what still stops it, with the zone's charge when none was typed. */
export function placeCheck(
  draft: SellDraft,
  zoneChargePoisha: string | null,
  promo: PromoState,
): PlaceCheck {
  const deliveryPoisha =
    draft.deliveryTaka === null ? (zoneChargePoisha ?? '0') : takaInput(draft.deliveryTaka);
  const discountPoisha = takaInput(draft.discountTaka);
  const advancePoisha = draft.advance === null ? '0' : takaInput(draft.advance.amountTaka);
  const priced =
    deliveryPoisha === null || discountPoisha === null || advancePoisha === null
      ? null
      : draftTotalsOf({
          lines: draft.lines.map((line) => ({
            unitPricePoisha: line.unitPricePoisha,
            qty: line.qty,
          })),
          discountPoisha,
          deliveryPoisha,
          promo: promo.kind === 'ok' ? promo : null,
          advancePoisha,
        });
  const missing: MissingField[] = [];
  if (draft.lines.length === 0) missing.push('items');
  if (draft.customer.name.trim() === '') missing.push('name');
  if (typedPhone(draft.customer.phone) === null) missing.push('phone');
  if (draft.customer.districtId === null || draft.customer.thanaId === null) missing.push('area');
  if (draft.customer.addressLine.trim().length < 3) missing.push('address');
  if (priced === null) missing.push('money');
  if (draft.promoCode.trim() !== '' && promo.kind !== 'ok') missing.push('promo');
  if (
    draft.advance !== null &&
    (draft.advance.transactionRef.trim() === '' || advancePoisha === '0')
  ) {
    missing.push('money');
  }
  const problems = (priced?.problems ?? []).filter((problem) => problem !== 'no_lines');
  return {
    totals: priced,
    deliveryPoisha,
    discountPoisha,
    advancePoisha,
    missing: [...new Set(missing)],
    problems,
    ready: missing.length === 0 && problems.length === 0,
  };
}

export interface OrderBody {
  readonly channel: 'facebook' | 'instagram' | 'whatsapp';
  readonly customer: { readonly phone: string; readonly name: string };
  readonly shipTo: {
    readonly name: string;
    readonly districtId: number;
    readonly thanaId: number;
    readonly area?: string;
    readonly addressLine: string;
  };
  readonly lines: readonly {
    readonly skuId: string;
    readonly qty: number;
    readonly unitPricePoisha?: string;
  }[];
  readonly deliveryChargePoisha?: string;
  readonly discountPoisha?: string;
  readonly promoCode?: string;
  readonly notes?: string;
  readonly assignedTo?: string;
  readonly source: { readonly inboxConversationId: string };
}

/**
 * What the order desk's route is sent (D-774): the chat's channel and conversation, the person
 * placing it as its owner, a line's price only when the agent changed it, the delivery charge
 * only when typed (else the zone's), the code as the word the customer gave. Null until ready.
 */
export function orderBody(
  draft: SellDraft,
  check: PlaceCheck,
  context: {
    readonly channel: ChannelKind;
    readonly me: string | null;
    readonly promoApplies: boolean;
  },
): OrderBody | null {
  const phone = typedPhone(draft.customer.phone);
  const { districtId, thanaId } = draft.customer;
  if (!check.ready || phone === null || districtId === null || thanaId === null) return null;
  const name = draft.customer.name.trim();
  const area = draft.customer.area.trim();
  const notes = draft.notes.trim();
  return {
    channel: ORDER_CHANNEL_FOR[context.channel],
    customer: { phone, name },
    shipTo: {
      name,
      districtId,
      thanaId,
      ...(area === '' ? {} : { area }),
      addressLine: draft.customer.addressLine.trim(),
    },
    lines: draft.lines.map((line) => ({
      skuId: line.skuId,
      qty: line.qty,
      ...(line.unitPricePoisha === line.listPricePoisha
        ? {}
        : { unitPricePoisha: line.unitPricePoisha }),
    })),
    ...(draft.deliveryTaka !== null && check.deliveryPoisha !== null
      ? { deliveryChargePoisha: check.deliveryPoisha }
      : {}),
    ...(check.discountPoisha !== null && check.discountPoisha !== '0'
      ? { discountPoisha: check.discountPoisha }
      : {}),
    ...(context.promoApplies && draft.promoCode.trim() !== ''
      ? { promoCode: draft.promoCode.trim() }
      : {}),
    ...(notes === '' ? {} : { notes }),
    ...(context.me === null ? {} : { assignedTo: context.me }),
    source: { inboxConversationId: draft.conversationId },
  };
}

/** The promo check's basket: each line's price times its quantity. */
export function promoBasket(
  draft: SellDraft,
): { readonly skuId: string; readonly qty: number; readonly netPoisha: string }[] {
  return draft.lines.map((line) => ({
    skuId: line.skuId,
    qty: line.qty,
    netPoisha: (
      BigInt(/^\d+$/.test(line.unitPricePoisha) ? line.unitPricePoisha : '0') * BigInt(line.qty)
    ).toString(),
  }));
}

// --- the summary sent to the customer -----------------------------------------------------------

export type SummaryKey =
  | 'inbox.sell.summary.thanksName'
  | 'inbox.sell.summary.thanks'
  | 'inbox.sell.summary.line'
  | 'inbox.sell.summary.discount'
  | 'inbox.sell.summary.delivery'
  | 'inbox.sell.summary.total'
  | 'inbox.sell.summary.advance'
  | 'inbox.sell.summary.toCollect'
  | 'inbox.sell.summary.shipTo'
  | 'inbox.sell.summary.phone'
  | 'inbox.sell.summary.closing';

/**
 * The order summary in the customer's chat (D-775): formal English (D-750), money as `Tk 1,250.00`
 * (`money` is the domain's `takaText`, D-751), one fact a line.
 */
export function summaryText(
  t: (key: SummaryKey, values?: Readonly<Record<string, string>>) => string,
  money: (poisha: string) => string,
  input: {
    readonly orderNo: string;
    readonly name: string;
    readonly lines: readonly {
      readonly item: string;
      readonly qty: number;
      readonly totalPoisha: string;
    }[];
    readonly totals: DraftTotals;
    readonly address: string;
    readonly phone: string;
  },
): string {
  const out: string[] = [];
  out.push(
    input.name.trim() === ''
      ? t('inbox.sell.summary.thanks', { orderNo: input.orderNo })
      : t('inbox.sell.summary.thanksName', { name: input.name.trim(), orderNo: input.orderNo }),
  );
  for (const line of input.lines) {
    out.push(
      t('inbox.sell.summary.line', {
        item: line.item,
        qty: String(line.qty),
        amount: money(line.totalPoisha),
      }),
    );
  }
  if (input.totals.discountPoisha > 0n) {
    out.push(
      t('inbox.sell.summary.discount', { amount: money(input.totals.discountPoisha.toString()) }),
    );
  }
  out.push(
    t('inbox.sell.summary.delivery', { amount: money(input.totals.deliveryPoisha.toString()) }),
  );
  out.push(t('inbox.sell.summary.total', { amount: money(input.totals.totalPoisha.toString()) }));
  if (input.totals.advancePoisha > 0n) {
    out.push(
      t('inbox.sell.summary.advance', { amount: money(input.totals.advancePoisha.toString()) }),
    );
  }
  out.push(
    t('inbox.sell.summary.toCollect', { amount: money(input.totals.toCollectPoisha.toString()) }),
  );
  out.push(t('inbox.sell.summary.shipTo', { address: input.address }));
  out.push(t('inbox.sell.summary.phone', { phone: input.phone }));
  out.push(t('inbox.sell.summary.closing'));
  return out.join('\n');
}

/** A line as the summary names it: `Eid Panjabi (L / Black)`. */
export function lineName(line: Pick<DraftLine, 'productName' | 'label'>): string {
  return line.label === '' ? line.productName : `${line.productName} (${line.label})`;
}

/** Whether a picked variant matches what the card asked for, to point it out. */
export function matchesWant(variant: PickerVariant, want: Want | null): boolean {
  if (want === null) return false;
  if (want.size !== null && !sameSize(variant.size ?? variant.label, want.size)) return false;
  if (want.colour !== null && variant.colour !== null && !same(variant.colour, want.colour)) {
    return false;
  }
  return want.size !== null || want.colour !== null;
}
