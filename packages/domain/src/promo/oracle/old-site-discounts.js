// THE OLD WEBSITE'S DISCOUNT ENGINE, KEPT ONLY AS A TEST ORACLE (M35a, D-540).
//
// Copied verbatim from the old site's lib/discounts.js (commit 333393e) on 2026-10-05; nothing below this
// header was changed. `discounts.differential.test.ts` runs it beside the ported engine
// (`../discounts.ts`) on generated carts and asserts they agree to the poisha. Never import it
// from production code, and never fix it: it is the record of what the old site did.

// Discount engine — pure evaluation, no DB. The caller loads candidate
// discounts (active ones + any matching entered codes), attaches each cart
// item's category ancestry, and passes everything in. Customer-specific gates
// (per-customer usage limit) are handled by the caller; first-order is passed in.

const sid = (v) => String(v);

// Expand cart items to eligible-by-scope units for a discount.
function eligibleItemsFor(d, items) {
  if (d.appliesTo === "products") {
    const ids = new Set((d.products || []).map(sid));
    return items.filter((i) => ids.has(sid(i.productId)));
  }
  if (d.appliesTo === "categories") {
    const ids = new Set((d.categories || []).map(sid));
    return items.filter((i) => (i.categoryIds || []).some((c) => ids.has(sid(c))));
  }
  return items; // "all"
}

const sumLine = (arr) => arr.reduce((s, i) => s + i.price * i.quantity, 0);

// Compute the money taken off (shipping handled separately) for one discount,
// assuming it is otherwise eligible.
function computeAmount(d, items, subtotal) {
  const scoped = eligibleItemsFor(d, items);
  const scopedSubtotal = sumLine(scoped);

  switch (d.type) {
    case "free_shipping":
      return { amount: 0, freeShipping: true };

    case "percentage": {
      let amt = (scopedSubtotal * (Number(d.value) || 0)) / 100;
      if (d.maxDiscount > 0) amt = Math.min(amt, d.maxDiscount);
      return { amount: Math.max(0, round(amt)), freeShipping: false };
    }

    case "fixed":
      return { amount: Math.max(0, Math.min(Number(d.value) || 0, scopedSubtotal)), freeShipping: false };

    case "tiered": {
      const tiers = [...(d.tiers || [])].sort((a, b) => b.minSubtotal - a.minSubtotal);
      const tier = tiers.find((t) => subtotal >= (t.minSubtotal || 0));
      if (!tier) return { amount: 0, freeShipping: false };
      const amt = tier.type === "fixed"
        ? Math.min(tier.value, scopedSubtotal)
        : (scopedSubtotal * (Number(tier.value) || 0)) / 100;
      return { amount: Math.max(0, round(amt)), freeShipping: false };
    }

    case "buy_x_get_y": {
      const buy = Number(d.buyQuantity) || 0;
      const get = Number(d.getQuantity) || 0;
      if (buy <= 0 || get <= 0) return { amount: 0, freeShipping: false };
      // Expand to unit prices, cheapest first → those become the discounted ones.
      const units = [];
      for (const i of scoped) for (let n = 0; n < i.quantity; n++) units.push(i.price);
      units.sort((a, b) => a - b);
      const group = buy + get;
      const sets = Math.floor(units.length / group);
      const freeUnits = sets * get;
      const pct = (Number(d.getDiscountPercent) || 100) / 100;
      let amt = 0;
      for (let k = 0; k < freeUnits; k++) amt += units[k] * pct;
      return { amount: Math.max(0, round(amt)), freeShipping: false };
    }

    default:
      return { amount: 0, freeShipping: false };
  }
}

function round(n) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

// Is `d` eligible given the cart/context (excluding per-customer usage, which the
// caller pre-filters)? Returns a reason string when not.
function eligibility(d, ctx) {
  if (!d.active) return "Inactive";
  const now = ctx.now || new Date();
  if (d.startsAt && now < new Date(d.startsAt)) return "Not started yet";
  if (d.endsAt && now > new Date(d.endsAt)) return "Expired";
  if (d.usageLimit > 0 && d.usedCount >= d.usageLimit) return "Usage limit reached";
  if (d.firstOrderOnly && !ctx.isFirstOrder) return "Valid on first order only";
  if (d.minSubtotal > 0 && ctx.subtotal < d.minSubtotal)
    return `Spend at least ${d.minSubtotal}`;
  if (d.minQuantity > 0 && ctx.totalQuantity < d.minQuantity)
    return `Add at least ${d.minQuantity} items`;
  // Scope must actually contain something.
  if (d.appliesTo !== "all" && eligibleItemsFor(d, ctx.items).length === 0)
    return "No eligible items in cart";
  return null;
}

// Value of a discount for ranking = money off + shipping saved (if free shipping).
const valueOf = (r, shippingFee) => r.amount + (r.freeShipping ? shippingFee : 0);

/**
 * @param {Object} args
 * @param {Array}  args.discounts  candidate discount docs (plain objects)
 * @param {Array}  args.items      [{ productId, categoryIds[], price, quantity }]
 * @param {number} args.shippingFee
 * @param {string[]} args.codes    coupon codes the customer entered
 * @param {boolean} args.isFirstOrder
 * @returns {{applied, rejected, discountTotal, freeShipping}}
 */
export function computeDiscounts({ discounts = [], items = [], shippingFee = 0, codes = [], isFirstOrder = false, now = new Date() }) {
  const subtotal = sumLine(items);
  const totalQuantity = items.reduce((n, i) => n + i.quantity, 0);
  const ctx = { items, subtotal, totalQuantity, shippingFee, isFirstOrder, now };
  const enteredCodes = new Set((codes || []).map((c) => String(c).toUpperCase().trim()).filter(Boolean));

  const rejected = [];
  const candidates = [];

  for (const d of discounts) {
    // Coupon-type discounts only apply when their code is entered.
    if (d.method === "code") {
      if (!d.code || !enteredCodes.has(String(d.code).toUpperCase())) continue;
    }
    const reason = eligibility(d, ctx);
    if (reason) {
      if (d.method === "code") rejected.push({ code: d.code, reason });
      continue;
    }
    const { amount, freeShipping } = computeAmount(d, items, subtotal);
    if (amount <= 0 && !freeShipping) {
      if (d.method === "code") rejected.push({ code: d.code, reason: "No discount for this cart" });
      continue;
    }
    candidates.push({
      discountId: sid(d._id || d.id || ""),
      code: d.code || null,
      title: d.title,
      type: d.type,
      method: d.method,
      allowStacking: !!d.allowStacking,
      priority: d.priority || 0,
      amount,
      freeShipping,
    });
  }

  if (candidates.length === 0) {
    return { applied: [], rejected, discountTotal: 0, freeShipping: false };
  }

  // Strategy: best single discount vs. the combined set of stackable ones; pick
  // whichever saves the customer more.
  const bestSingle = [...candidates].sort(
    (a, b) => valueOf(b, shippingFee) - valueOf(a, shippingFee)
  )[0];

  const stackables = candidates.filter((c) => c.allowStacking);
  const singleValue = valueOf(bestSingle, shippingFee);
  const stackValue = stackables.reduce((s, c) => s + valueOf(c, shippingFee), 0);

  let applied = stackables.length >= 2 && stackValue >= singleValue ? stackables : [bestSingle];

  // Never discount more than the subtotal.
  let discountTotal = applied.reduce((s, c) => s + c.amount, 0);
  if (discountTotal > subtotal) discountTotal = subtotal;
  const freeShipping = applied.some((c) => c.freeShipping);

  return { applied, rejected, discountTotal: round(discountTotal), freeShipping };
}
