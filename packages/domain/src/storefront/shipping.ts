import { MAX_POISHA, type Poisha } from '../money/index.js';

/**
 * The website's shipping rule (M33, D-503), as the old site kept it and as the ERP maps it.
 *
 * The old site charged by three zones it named itself — inside Dhaka, the suburbs, outside
 * Dhaka — with an optional free-shipping threshold. The ERP prices delivery by its own
 * delivery zones (§9, `sales.delivery_zones`), which a district or thana resolves to. So the
 * rule keeps the website's three zones and their fees, and says which ERP zones each one
 * covers: M34's checkout resolves the shopper's address to an ERP zone, the ERP zone to a
 * website zone here, and charges that zone's fee.
 *
 * Free shipping, when on, applies when the items total reaches the threshold; a threshold of
 * zero (or none) means every order ships free. The old site stored the threshold in two
 * places and read one of them; here it is one number.
 */

export const WEB_ZONES = ['inside_dhaka', 'suburbs', 'outside_dhaka'] as const;
export type WebZone = (typeof WEB_ZONES)[number];

export interface WebZoneRule {
  readonly feePoisha: Poisha;
  /** The ERP delivery zones this website zone covers. */
  readonly deliveryZoneIds: readonly string[];
}

export interface ShippingRule {
  readonly freeShippingEnabled: boolean;
  /** Items total at or above which shipping is free; zero or null: always free when on. */
  readonly freeShippingThresholdPoisha: Poisha | null;
  readonly zones: Readonly<Record<WebZone, WebZoneRule>>;
}

export type ShippingProblem =
  | { readonly code: 'FEE_OUT_OF_RANGE'; readonly zone: WebZone }
  | { readonly code: 'THRESHOLD_OUT_OF_RANGE' }
  | { readonly code: 'ZONE_UNKNOWN'; readonly zone: WebZone; readonly deliveryZoneId: string }
  | { readonly code: 'ZONE_IN_TWO_PLACES'; readonly deliveryZoneId: string };

/**
 * Everything wrong with a rule, given the brand's ERP delivery zone ids. Empty means valid.
 *
 * An ERP zone may be in at most one website zone: in two, the fee a shopper is charged would
 * depend on which one was checked first. An ERP zone in none is allowed — the brand may run
 * a zone the website does not ship to — and `webZoneFor` answers null for it.
 */
export function shippingRuleProblems(
  rule: ShippingRule,
  knownDeliveryZoneIds: readonly string[],
): ShippingProblem[] {
  const problems: ShippingProblem[] = [];
  const known = new Set(knownDeliveryZoneIds);
  const seen = new Set<string>();
  const twice = new Set<string>();

  const threshold = rule.freeShippingThresholdPoisha;
  if (threshold !== null && (threshold < 0n || threshold > MAX_POISHA)) {
    problems.push({ code: 'THRESHOLD_OUT_OF_RANGE' });
  }
  for (const zone of WEB_ZONES) {
    const entry = rule.zones[zone];
    if (entry.feePoisha < 0n || entry.feePoisha > MAX_POISHA) {
      problems.push({ code: 'FEE_OUT_OF_RANGE', zone });
    }
    for (const id of new Set(entry.deliveryZoneIds)) {
      if (!known.has(id)) problems.push({ code: 'ZONE_UNKNOWN', zone, deliveryZoneId: id });
      if (seen.has(id)) twice.add(id);
      seen.add(id);
    }
  }
  for (const id of twice) problems.push({ code: 'ZONE_IN_TWO_PLACES', deliveryZoneId: id });
  return problems;
}

/** The website zone an ERP delivery zone falls in, or null when the website does not ship there. */
export function webZoneFor(rule: ShippingRule, deliveryZoneId: string): WebZone | null {
  for (const zone of WEB_ZONES) {
    if (rule.zones[zone].deliveryZoneIds.includes(deliveryZoneId)) return zone;
  }
  return null;
}

/** Whether an items total ships free under this rule. */
export function shipsFree(rule: ShippingRule, itemsTotalPoisha: Poisha): boolean {
  if (!rule.freeShippingEnabled) return false;
  const threshold = rule.freeShippingThresholdPoisha;
  return threshold === null || threshold <= 0n || itemsTotalPoisha >= threshold;
}

/**
 * The delivery fee for an order to an ERP zone, or null when the website does not ship to
 * that zone. Zero when the order ships free.
 */
export function shippingFeeFor(
  rule: ShippingRule,
  deliveryZoneId: string,
  itemsTotalPoisha: Poisha,
): Poisha | null {
  const zone = webZoneFor(rule, deliveryZoneId);
  if (zone === null) return null;
  return shipsFree(rule, itemsTotalPoisha) ? (0n as Poisha) : rule.zones[zone].feePoisha;
}
