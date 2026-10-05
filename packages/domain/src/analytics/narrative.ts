import { kpis } from './kpis.js';
import { INSIGHT_CODES, type Insight, type InsightCode, type InsightMonth } from './insights.js';

/**
 * The payload the optional LLM narrative is written from (architecture §18; M24 check 4,
 * D-327; invariant 10).
 *
 * §18: "generated only from the metrics JSON (no PII)". The payload is therefore built
 * from an **allow-list**: a fixed set of keys, each holding a count, an amount in poisha,
 * a rate in basis points, a number of seconds, a month, or a code from a closed list.
 * Nothing in it is text a person typed — no buyer, agent or campaign name, no phone, no
 * address, no note — and no id that leads back to one: a campaign is `campaign_1`, in the
 * order the insights name them.
 *
 * Two guarantees, and both are tested:
 *
 * 1. `buildNarrativePayload` copies only the fields it names, so an input that happens to
 *    carry more (a name on a campaign row, a phone in an insight parameter) loses it.
 * 2. `assertNarrativePayloadSafe` walks the finished payload and refuses any key or value
 *    outside the allow-list. The server calls it before every provider call, so a later
 *    change to the builder that let something through fails closed, not open.
 */

/**
 * 2 since M31: the leaderboard block (a rank among the brands) left the payload with the
 * leaderboard itself, because a brand's ERP knows no other brand (D-471).
 */
export const NARRATIVE_PAYLOAD_VERSION = 2;

export interface NarrativeInput {
  /** `YYYY-MM`, Asia/Dhaka. */
  readonly month: string;
  readonly current: InsightMonth;
  readonly previous: InsightMonth;
  readonly insights: readonly Insight[];
  /** The order-channel vocabulary (`ORDER_CHANNELS`); any other channel value is dropped. */
  readonly channelCodes: readonly string[];
}

export interface NarrativeFigures {
  readonly ordersConfirmed: number;
  readonly ordersDelivered: number;
  readonly ordersReturned: number;
  readonly ordersCancelled: number;
  readonly deliveredRevenuePoisha: string;
  readonly spendPoisha: string;
  readonly aovPoisha: string | null;
  readonly returnRateBps: string | null;
  readonly deliverySuccessBps: string | null;
  readonly roasBps: string | null;
  readonly cpdoPoisha: string | null;
  readonly pickupMeanSeconds: number | null;
}

export interface NarrativeInsight {
  readonly code: InsightCode;
  readonly severity: 'warning' | 'info';
  readonly params: Readonly<Record<string, string>>;
}

export interface NarrativePayload {
  readonly version: typeof NARRATIVE_PAYLOAD_VERSION;
  readonly month: string;
  readonly currency: 'BDT';
  readonly moneyUnit: 'poisha';
  readonly rateUnit: 'basis_points';
  readonly current: NarrativeFigures;
  readonly previous: NarrativeFigures;
  readonly insights: readonly NarrativeInsight[];
}

/** Insight parameters that are numbers, and so may pass as they are. */
const NUMERIC_PARAMS = new Set([
  'rateBps',
  'medianBps',
  'gapBps',
  'previousBps',
  'riseBps',
  'roasBps',
  'spendPoisha',
  'cpdoPoisha',
  'previousPoisha',
  'meanSeconds',
  'thresholdSeconds',
  'pickups',
  'totalSeconds',
  'brandRateBps',
  'successBps',
]);

const INTEGER = /^-?\d{1,19}$/;
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const CAMPAIGN_LABEL = /^campaign_\d{1,3}$/;

const asText = (value: bigint | null): string | null => (value === null ? null : value.toString());

function figures(month: InsightMonth): NarrativeFigures {
  const ratios = kpis({
    ordersConfirmed: month.ordersConfirmed,
    ordersDelivered: month.ordersDelivered,
    ordersReturned: month.ordersReturned,
    ordersCancelled: month.ordersCancelled,
    deliveredRevenuePoisha: month.deliveredRevenuePoisha,
    spendPoisha: month.spendPoisha,
    pickupCount: month.pickupCount,
    pickupSeconds: month.pickupSeconds,
  });
  return {
    ordersConfirmed: month.ordersConfirmed,
    ordersDelivered: month.ordersDelivered,
    ordersReturned: month.ordersReturned,
    ordersCancelled: month.ordersCancelled,
    deliveredRevenuePoisha: month.deliveredRevenuePoisha.toString(),
    spendPoisha: month.spendPoisha.toString(),
    aovPoisha: asText(ratios.aovPoisha),
    returnRateBps: asText(ratios.returnRateBps),
    deliverySuccessBps: asText(ratios.deliverySuccessBps),
    roasBps: asText(ratios.roasBps),
    cpdoPoisha: asText(ratios.cpdoPoisha),
    pickupMeanSeconds: ratios.pickupMeanSeconds,
  };
}

/** The payload, from the allow-list only. Throws if the month is not `YYYY-MM`. */
export function buildNarrativePayload(input: NarrativeInput): NarrativePayload {
  if (!MONTH.test(input.month)) throw new RangeError('The narrative month must be YYYY-MM.');
  const channels = new Set(input.channelCodes);
  const campaignLabels = new Map<string, string>();

  const insights = input.insights
    .filter((insight) => (INSIGHT_CODES as readonly string[]).includes(insight.code))
    .map((insight): NarrativeInsight => {
      const params: Record<string, string> = {};
      for (const [key, value] of Object.entries(insight.params)) {
        if (NUMERIC_PARAMS.has(key) && INTEGER.test(value)) {
          params[key] = value;
        } else if (key === 'channel' && channels.has(value)) {
          params.channel = value;
        } else if (key === 'campaignId') {
          // An id, which leads back to a name somebody typed: replaced by its ordinal.
          let label = campaignLabels.get(value);
          if (label === undefined) {
            label = `campaign_${String(campaignLabels.size + 1)}`;
            campaignLabels.set(value, label);
          }
          params.campaign = label;
        }
        // Anything else is dropped: the allow-list is the rule, not a deny-list.
      }
      return {
        code: insight.code,
        severity: insight.severity === 'warning' ? 'warning' : 'info',
        params,
      };
    });

  return {
    version: NARRATIVE_PAYLOAD_VERSION,
    month: input.month,
    currency: 'BDT',
    moneyUnit: 'poisha',
    rateUnit: 'basis_points',
    current: figures(input.current),
    previous: figures(input.previous),
    insights,
  };
}

// --- the guard ---------------------------------------------------------------------

const FIGURE_KEYS = new Set<string>([
  'ordersConfirmed',
  'ordersDelivered',
  'ordersReturned',
  'ordersCancelled',
  'deliveredRevenuePoisha',
  'spendPoisha',
  'aovPoisha',
  'returnRateBps',
  'deliverySuccessBps',
  'roasBps',
  'cpdoPoisha',
  'pickupMeanSeconds',
]);

export class NarrativePayloadError extends Error {
  constructor(readonly path: string) {
    super(`The narrative payload has a value outside its allow-list at ${path}.`);
    this.name = 'NarrativePayloadError';
  }
}

function integerOrNull(value: unknown): boolean {
  return value === null || (typeof value === 'number' && Number.isSafeInteger(value));
}

function integerTextOrNull(value: unknown): boolean {
  return value === null || (typeof value === 'string' && INTEGER.test(value));
}

function checkFigures(value: unknown, path: string): void {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new NarrativePayloadError(path);
  }
  for (const [key, leaf] of Object.entries(value)) {
    if (!FIGURE_KEYS.has(key)) throw new NarrativePayloadError(`${path}.${key}`);
    const ok =
      key.startsWith('orders') || key === 'pickupMeanSeconds'
        ? integerOrNull(leaf)
        : integerTextOrNull(leaf);
    if (!ok) throw new NarrativePayloadError(`${path}.${key}`);
  }
}

/**
 * Refuse a payload with any key or value the allow-list does not name. Called on the
 * finished payload before it is turned into a prompt, every time.
 */
export function assertNarrativePayloadSafe(
  payload: unknown,
  channelCodes: readonly string[],
): asserts payload is NarrativePayload {
  const channels = new Set(channelCodes);
  if (typeof payload !== 'object' || payload === null) throw new NarrativePayloadError('$');
  const allowedTop = new Set([
    'version',
    'month',
    'currency',
    'moneyUnit',
    'rateUnit',
    'current',
    'previous',
    'insights',
  ]);
  const record = payload as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!allowedTop.has(key)) throw new NarrativePayloadError(`$.${key}`);
  }
  if (record.version !== NARRATIVE_PAYLOAD_VERSION) throw new NarrativePayloadError('$.version');
  if (typeof record.month !== 'string' || !MONTH.test(record.month)) {
    throw new NarrativePayloadError('$.month');
  }
  if (record.currency !== 'BDT') throw new NarrativePayloadError('$.currency');
  if (record.moneyUnit !== 'poisha') throw new NarrativePayloadError('$.moneyUnit');
  if (record.rateUnit !== 'basis_points') throw new NarrativePayloadError('$.rateUnit');
  checkFigures(record.current, '$.current');
  checkFigures(record.previous, '$.previous');

  if (!Array.isArray(record.insights)) throw new NarrativePayloadError('$.insights');
  record.insights.forEach((entry: unknown, index) => {
    const path = `$.insights[${String(index)}]`;
    if (typeof entry !== 'object' || entry === null) throw new NarrativePayloadError(path);
    const insight = entry as Record<string, unknown>;
    for (const key of Object.keys(insight)) {
      if (!['code', 'severity', 'params'].includes(key)) {
        throw new NarrativePayloadError(`${path}.${key}`);
      }
    }
    if (!(INSIGHT_CODES as readonly unknown[]).includes(insight.code)) {
      throw new NarrativePayloadError(`${path}.code`);
    }
    if (insight.severity !== 'warning' && insight.severity !== 'info') {
      throw new NarrativePayloadError(`${path}.severity`);
    }
    const params = insight.params;
    if (typeof params !== 'object' || params === null || Array.isArray(params)) {
      throw new NarrativePayloadError(`${path}.params`);
    }
    for (const [key, leaf] of Object.entries(params)) {
      const ok =
        (NUMERIC_PARAMS.has(key) && typeof leaf === 'string' && INTEGER.test(leaf)) ||
        (key === 'channel' && typeof leaf === 'string' && channels.has(leaf)) ||
        (key === 'campaign' && typeof leaf === 'string' && CAMPAIGN_LABEL.test(leaf));
      if (!ok) throw new NarrativePayloadError(`${path}.params.${key}`);
    }
  });
}

// --- the prompt ----------------------------------------------------------------------

/** What a provider is given: fixed instructions and the payload as JSON, nothing else. */
export interface NarrativePrompt {
  readonly system: string;
  readonly user: string;
}

const SYSTEM_PROMPT = [
  'You write a short monthly performance summary for the management of a Bangladeshi',
  'fashion brand that sells cash-on-delivery orders. You are given only aggregate metrics',
  'as JSON. Money is in poisha (100 poisha = 1 taka); rates are basis points (10,000 =',
  '100%; ROAS 10,000 = 1x). Write four to six plain sentences in English: what improved,',
  'what got worse, and the most important action suggested by the insights. Do not invent',
  'numbers that are not in the JSON, and do not mention any person or customer.',
].join(' ');

export function narrativePrompt(payload: NarrativePayload): NarrativePrompt {
  return { system: SYSTEM_PROMPT, user: JSON.stringify(payload) };
}
