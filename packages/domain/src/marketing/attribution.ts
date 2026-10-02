/**
 * Which campaign an order belongs to (architecture §11 "Attribution priority"; M18).
 *
 * §11's order, exactly:
 *
 * 1. **explicit**: a campaign set on the order by an agent or a landing page. That is the
 *    order's `source.campaignId` when it names one of the brand's campaigns, by our id or by
 *    a Meta campaign id the campaign carries; failing that, the campaign of the promo code
 *    the order used (D-251), because a code made for a campaign is that campaign named on
 *    the order by the buyer.
 * 2. **ad_referral**: the click-to-message ad the conversation started from
 *    (`source.adId`), mapped through the campaign's Meta ad ids.
 * 3. **utm**: `source.utmCampaign`, mapped through the campaign's `utm_campaign` values,
 *    compared trimmed and case-insensitively (a link typed as `Eid-Sale` and one tagged
 *    `eid-sale` are the same campaign to the person who made them).
 * 4. **none**.
 *
 * A step that names nothing the brand knows falls through to the next, rather than
 * stopping: an agent who pasted a stale Meta id should not hide a perfectly good UTM.
 *
 * The answer is computed when it is read, from the order's own recorded source and the
 * brand's current mappings (D-250). Adding a mapping later therefore attributes the orders
 * it describes — which is what a marketer who forgot to tag a campaign wants.
 */

export const ATTRIBUTION_RULES = ['explicit', 'ad_referral', 'utm', 'none'] as const;
export type AttributionRule = (typeof ATTRIBUTION_RULES)[number];

export const CAMPAIGN_REF_KINDS = ['meta_campaign', 'meta_ad', 'utm_campaign'] as const;
export type CampaignRefKind = (typeof CAMPAIGN_REF_KINDS)[number];

/** What an order recorded about where it came from. Every field is optional. */
export interface OrderAttributionSource {
  /** `source.campaignId`: one of our campaign ids, or a Meta campaign id. */
  readonly campaignId?: string | null | undefined;
  /** The campaign of the promo code the order used, when the code has one. */
  readonly promoCampaignId?: string | null | undefined;
  /** `source.adId`: the click-to-message ad referral, when the channel exposes it. */
  readonly adId?: string | null | undefined;
  /** `source.utmCampaign`. */
  readonly utmCampaign?: string | null | undefined;
}

export interface CampaignRef {
  readonly campaignId: string;
  readonly kind: CampaignRefKind;
  readonly value: string;
}

/** A brand's campaigns and their external ids, indexed for lookup. */
export interface CampaignIndex {
  readonly ids: ReadonlySet<string>;
  readonly metaCampaign: ReadonlyMap<string, string>;
  readonly metaAd: ReadonlyMap<string, string>;
  readonly utm: ReadonlyMap<string, string>;
}

export interface Attribution {
  readonly campaignId: string | null;
  readonly rule: AttributionRule;
}

/** How a ref value is compared: trimmed, and for UTMs lower-cased as well. */
export function normaliseRefValue(kind: CampaignRefKind, value: string): string {
  const trimmed = value.trim();
  return kind === 'utm_campaign' ? trimmed.toLowerCase() : trimmed;
}

export function campaignIndex(
  campaignIds: Iterable<string>,
  refs: Iterable<CampaignRef>,
): CampaignIndex {
  const ids = new Set(campaignIds);
  const metaCampaign = new Map<string, string>();
  const metaAd = new Map<string, string>();
  const utm = new Map<string, string>();
  for (const ref of refs) {
    // A ref to a campaign the index does not hold would attribute to a campaign no report
    // can show, so it is ignored rather than trusted.
    if (!ids.has(ref.campaignId)) continue;
    const value = normaliseRefValue(ref.kind, ref.value);
    if (value === '') continue;
    const target =
      ref.kind === 'meta_campaign' ? metaCampaign : ref.kind === 'meta_ad' ? metaAd : utm;
    // The database keeps a value unique per kind; the first wins if a caller did not.
    if (!target.has(value)) target.set(value, ref.campaignId);
  }
  return { ids, metaCampaign, metaAd, utm };
}

function present(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

export function resolveAttribution(
  source: OrderAttributionSource,
  index: CampaignIndex,
): Attribution {
  const explicit = present(source.campaignId);
  if (explicit !== null) {
    if (index.ids.has(explicit)) return { campaignId: explicit, rule: 'explicit' };
    const byMeta = index.metaCampaign.get(explicit);
    if (byMeta !== undefined) return { campaignId: byMeta, rule: 'explicit' };
  }

  const promo = present(source.promoCampaignId);
  if (promo !== null && index.ids.has(promo)) return { campaignId: promo, rule: 'explicit' };

  const ad = present(source.adId);
  if (ad !== null) {
    const byAd = index.metaAd.get(ad);
    if (byAd !== undefined) return { campaignId: byAd, rule: 'ad_referral' };
  }

  const utm = present(source.utmCampaign);
  if (utm !== null) {
    const byUtm = index.utm.get(normaliseRefValue('utm_campaign', utm));
    if (byUtm !== undefined) return { campaignId: byUtm, rule: 'utm' };
  }

  return { campaignId: null, rule: 'none' };
}
