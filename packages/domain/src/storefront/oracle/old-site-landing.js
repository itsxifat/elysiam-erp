// THE OLD WEBSITE'S LANDING-PAGE PRICING, KEPT ONLY AS A TEST ORACLE (M35b, D-550).
//
// Copied verbatim from the old site's lib/landing-pricing.js and lib/landing-promotions.js (commit
// b9cef59) on 2026-10-05; nothing below this header was changed except that the two files are
// joined into one module. `landing.differential.test.ts` runs it beside the port
// (`../landing.ts`) on generated pages and orders. Never import it from production code, and
// never fix it: it is the record of what the old site charged.

// ---- lib/landing-pricing.js ----

// The landing-page offer pricing rule, in a pure module so the browser can
// preview a price as the customer switches sizes while the server stays the only
// authority on what is actually charged (see lib/landing.js → priceOffer).
//
// Exposing the rule to the client leaks nothing: it's the same discount the page
// already displays. A tampered request still gets repriced from the DB.

// Apply an offer's pricing rule to the undiscounted ("regular") total.
// Always ≥ 0 and never above the regular total — a rule that would raise the
// price is a config error, so clamp rather than overcharge.
export function applyOfferPricing(pricing, regularTotal) {
  const v = Math.max(0, Number(pricing?.priceValue ?? pricing?.value) || 0);
  let total;
  switch (pricing?.pricingMode ?? pricing?.mode) {
    case "fixed":
      total = v;
      break;
    case "percent":
      total = regularTotal * (1 - Math.min(v, 100) / 100);
      break;
    case "amount":
      total = regularTotal - v;
      break;
    default:
      total = regularTotal;
  }
  return Math.max(0, Math.min(Math.round(total), Math.round(regularTotal)));
}

export const PRICING_MODES = [
  { value: "auto", label: "No discount (sum of product prices)" },
  { value: "fixed", label: "Fixed bundle price" },
  { value: "percent", label: "Percentage off" },
  { value: "amount", label: "Amount off (৳)" },
];

// A collection offer's price ladder → the price for a given total quantity.
// Non-linear and fully manual: we return the price of the highest tier whose
// quantity is ≤ `qty` (so a gap in the ladder floors to the tier below), and
// null when `qty` is below the smallest tier (nothing valid to charge yet).
// Shared by the client preview and the server (the authority) so they agree.
export function tierPriceFor(tiers, qty) {
  if (!Array.isArray(tiers) || !tiers.length || qty <= 0) return null;
  const sorted = [...tiers]
    .map((t) => ({ quantity: Number(t.quantity) || 0, price: Math.max(0, Number(t.price) || 0) }))
    .filter((t) => t.quantity >= 1)
    .sort((a, b) => a.quantity - b.quantity);
  let match = null;
  for (const t of sorted) {
    if (t.quantity <= qty) match = t;
    else break;
  }
  return match ? match.price : null;
}

// The largest quantity the ladder prices — the cap on how many a customer may
// add to a collection order.
export function maxTierQuantity(tiers) {
  if (!Array.isArray(tiers) || !tiers.length) return 0;
  return Math.max(0, ...tiers.map((t) => Number(t.quantity) || 0));
}

// The smallest quantity the ladder prices — the minimum a customer must add.
export function minTierQuantity(tiers) {
  const qs = (tiers || []).map((t) => Number(t.quantity) || 0).filter((q) => q >= 1);
  return qs.length ? Math.min(...qs) : 0;
}

// ---- lib/landing-promotions.js ----

// Page-wide promotions for a landing page: free-delivery thresholds and
// spend-and-save discount rules. Pure module (no imports) so the browser can
// preview the reward live as the cart changes while the server (lib/landing.js →
// the order route) stays the sole authority on what's actually charged.
//
// Two rule families, both evaluated on the customer's order:
//   • freeShipping — delivery becomes free once an amount OR quantity threshold
//     is met.
//   • discountRules[] — a "spend/buy this much → get this off" ladder. Each rule
//     triggers on an amount OR quantity threshold and rewards a fixed ৳ amount or
//     a percentage (optionally capped). The single BEST rule for the customer
//     applies — rules don't stack on each other (but free shipping is separate,
//     so a customer can get both a discount AND free delivery).
//
// `goodsTotal` is what the customer pays for products (the offer price, before
// shipping); `quantity` is the total number of pieces.

export const DISCOUNT_BASES = [
  { value: "amount", label: "Order amount (৳)" },
  { value: "quantity", label: "Number of items" },
];
export const REWARD_TYPES = [
  { value: "amount", label: "Fixed amount off (৳)" },
  { value: "percent", label: "Percentage off (%)" },
];

const n = (v) => Math.max(0, Number(v) || 0);

function meetsThreshold(rule, goodsTotal, quantity) {
  const t = n(rule.threshold);
  if (t <= 0) return false;
  return rule.basis === "quantity" ? quantity >= t : goodsTotal >= t;
}

// The ৳ value a single discount rule would take off, clamped to the goods total.
export function discountRuleAmount(rule, goodsTotal) {
  let amt = rule.rewardType === "percent" ? goodsTotal * (n(rule.value) / 100) : n(rule.value);
  if (rule.rewardType === "percent" && n(rule.maxDiscount) > 0) amt = Math.min(amt, n(rule.maxDiscount));
  return Math.max(0, Math.min(Math.round(amt), Math.round(goodsTotal)));
}

// A human label for a rule when the admin didn't set one.
export function defaultRuleLabel(rule) {
  const cond = rule.basis === "quantity" ? `${n(rule.threshold)}+ items` : `৳${n(rule.threshold)}+`;
  const rew = rule.rewardType === "percent" ? `${n(rule.value)}% off` : `৳${n(rule.value)} off`;
  return `Spend ${cond} — ${rew}`;
}

// Free delivery once any enabled threshold is met.
export function qualifiesFreeShipping(freeShipping, goodsTotal, quantity) {
  const fs = freeShipping || {};
  if (!fs.enabled) return false;
  if (n(fs.minSubtotal) > 0 && goodsTotal >= n(fs.minSubtotal)) return true;
  if (n(fs.minQuantity) > 0 && quantity >= n(fs.minQuantity)) return true;
  return false;
}

// Apply everything to one order. Returns the promo discount, whether shipping is
// waived, the resulting shipping fee, and a customer-facing label for the applied
// discount.
export function applyPromotions({ goodsTotal, quantity, shippingFee, promotions }) {
  const p = promotions || {};

  let best = { amount: 0, rule: null };
  for (const rule of Array.isArray(p.discountRules) ? p.discountRules : []) {
    if (!meetsThreshold(rule, goodsTotal, quantity)) continue;
    const amount = discountRuleAmount(rule, goodsTotal);
    if (amount > best.amount) best = { amount, rule };
  }

  const free = qualifiesFreeShipping(p.freeShipping, goodsTotal, quantity);

  return {
    promoDiscount: best.amount,
    promoLabel: best.rule ? best.rule.label || defaultRuleLabel(best.rule) : "",
    freeShipping: free,
    shippingFee: free ? 0 : Math.max(0, Number(shippingFee) || 0),
  };
}

// Presentation-only nudges: "add ৳X more for free delivery / the next reward".
// Returns { freeShipping, discount } where each is { amountMore, quantityMore } or
// null. Used by the order form to encourage a bigger cart.
export function promotionHints({ goodsTotal, quantity, promotions }) {
  const p = promotions || {};
  const out = { freeShipping: null, discount: null };

  const fs = p.freeShipping || {};
  if (fs.enabled && !qualifiesFreeShipping(fs, goodsTotal, quantity)) {
    const amt = n(fs.minSubtotal) > 0 ? n(fs.minSubtotal) - goodsTotal : 0;
    const qty = n(fs.minQuantity) > 0 ? n(fs.minQuantity) - quantity : 0;
    out.freeShipping = {
      amountMore: amt > 0 ? amt : 0,
      quantityMore: qty > 0 ? qty : 0,
    };
  }

  // The nearest unmet discount rule that would improve on what's applied now.
  const applied = applyPromotions({ goodsTotal, quantity, shippingFee: 0, promotions }).promoDiscount;
  let nearest = null;
  for (const rule of Array.isArray(p.discountRules) ? p.discountRules : []) {
    if (meetsThreshold(rule, goodsTotal, quantity)) continue;
    const potential = discountRuleAmount(rule, Math.max(goodsTotal, n(rule.threshold)));
    if (potential <= applied) continue;
    const amountMore = rule.basis === "amount" ? Math.max(0, n(rule.threshold) - goodsTotal) : 0;
    const quantityMore = rule.basis === "quantity" ? Math.max(0, n(rule.threshold) - quantity) : 0;
    const distance = amountMore || quantityMore * 1e6; // prefer the closest reachable
    if (!nearest || distance < nearest.distance) {
      nearest = { amountMore, quantityMore, label: rule.label || defaultRuleLabel(rule), distance };
    }
  }
  if (nearest) out.discount = nearest;

  return out;
}
