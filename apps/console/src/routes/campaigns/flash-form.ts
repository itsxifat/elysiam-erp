import { poishaToTaka, takaToPoisha } from '@elysium/ui';

import type { FlashSale, FlashSaleBody } from './api.js';
import { dhakaLocalToIso, isoToDhakaLocal } from './dhaka-time.js';
import type { CampaignsMessageKey } from './messages.js';

/**
 * The flash-sale editor's form, checked before it is sent (M35a, D-542).
 *
 * The server checks again and is the authority (a SKU's sale price below its own price, a
 * limit not below what has sold); this names the field. Pure, so it is tested without a
 * browser.
 */

export interface FlashItemValues {
  readonly skuId: string;
  readonly skuCode: string;
  readonly productName: string;
  readonly variantLabel: string | null;
  readonly shelfPricePoisha: string;
  /** Taka, as typed. */
  readonly salePrice: string;
  readonly allStock: boolean;
  /** Units, as typed; ignored when `allStock`. */
  readonly limit: string;
  /** Read-only: what this SKU has sold on this sale. */
  readonly unitsSold: number;
}

export interface FlashFormValues {
  readonly title: string;
  readonly subtitle: string;
  readonly description: string;
  readonly slug: string;
  readonly bannerFileId: string | null;
  readonly enabled: boolean;
  readonly showOnHome: boolean;
  readonly priority: string;
  readonly startsAt: string;
  readonly endsAt: string;
  readonly items: readonly FlashItemValues[];
}

export const EMPTY_FLASH: FlashFormValues = {
  title: '',
  subtitle: '',
  description: '',
  slug: '',
  bannerFileId: null,
  enabled: false,
  showOnHome: true,
  priority: '0',
  startsAt: '',
  endsAt: '',
  items: [],
};

/** A stored sale as the form edits it. Switched-off SKUs that sold stay visible, off. */
export function flashValuesOf(sale: FlashSale): FlashFormValues {
  return {
    title: sale.title,
    subtitle: sale.subtitle,
    description: sale.description,
    slug: sale.slug,
    bannerFileId: sale.bannerFileId,
    enabled: sale.enabled,
    showOnHome: sale.showOnHome,
    priority: String(sale.priority),
    startsAt: isoToDhakaLocal(sale.startsAt),
    endsAt: isoToDhakaLocal(sale.endsAt),
    items: sale.items
      .filter((item) => item.enabled)
      .map((item) => ({
        skuId: item.skuId,
        skuCode: item.skuCode,
        productName: item.productName,
        variantLabel: item.variantLabel,
        shelfPricePoisha: item.shelfPricePoisha,
        salePrice: poishaToTaka(item.salePricePoisha),
        allStock: item.unitLimit === null,
        limit: item.unitLimit === null ? '' : String(item.unitLimit),
        unitsSold: item.unitsSold,
      })),
  };
}

export type FlashFormField = Exclude<keyof FlashFormValues, 'items'>;

export interface FlashFormErrors {
  readonly fields: Partial<Record<FlashFormField, CampaignsMessageKey>>;
  /** Per SKU id. */
  readonly items: Readonly<Record<string, CampaignsMessageKey>>;
}

const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export function checkFlashForm(
  values: FlashFormValues,
):
  | { readonly ok: true; readonly body: FlashSaleBody }
  | { readonly ok: false; readonly errors: FlashFormErrors } {
  const fields: Partial<Record<FlashFormField, CampaignsMessageKey>> = {};
  const items: Record<string, CampaignsMessageKey> = {};

  const title = values.title.trim();
  if (title === '' || title.length > 120) fields.title = 'campaigns.flash.form.titleRequired';
  const slug = values.slug.trim().toLowerCase();
  if (slug !== '' && (!SLUG.test(slug) || slug.length > 80)) {
    fields.slug = 'campaigns.flash.form.invalidSlug';
  }
  const priorityText = values.priority.trim() === '' ? '0' : values.priority.trim();
  const priority = /^-?\d{1,3}$/.test(priorityText) ? Number(priorityText) : Number.NaN;
  if (!(priority >= -100 && priority <= 100)) {
    fields.priority = 'campaigns.discounts.form.invalidPriority';
  }
  const startsAt = values.startsAt === '' ? null : dhakaLocalToIso(values.startsAt);
  const endsAt = values.endsAt === '' ? null : dhakaLocalToIso(values.endsAt);
  if (values.startsAt !== '' && startsAt === null) {
    fields.startsAt = 'campaigns.discounts.form.invalidTime';
  }
  if (values.endsAt !== '' && endsAt === null) {
    fields.endsAt = 'campaigns.discounts.form.invalidTime';
  }
  if (startsAt !== null && endsAt !== null && startsAt >= endsAt) {
    fields.endsAt = 'campaigns.codes.form.invalidWindow';
  }

  const lines: FlashSaleBody['items'][number][] = [];
  for (const item of values.items) {
    const price = takaToPoisha(item.salePrice);
    if (price === null || price.startsWith('-') || BigInt(price) === 0n) {
      items[item.skuId] = 'campaigns.flash.form.invalidPrice';
      continue;
    }
    if (BigInt(price) >= BigInt(item.shelfPricePoisha)) {
      items[item.skuId] = 'campaigns.flash.form.priceNotBelow';
      continue;
    }
    let unitLimit: number | null = null;
    if (!item.allStock) {
      const text = item.limit.trim();
      const limit = /^\d{1,7}$/.test(text) ? Number(text) : 0;
      if (limit < 1) {
        items[item.skuId] = 'campaigns.flash.form.invalidLimit';
        continue;
      }
      if (limit < item.unitsSold) {
        items[item.skuId] = 'campaigns.flash.form.limitBelowSold';
        continue;
      }
      unitLimit = limit;
    }
    lines.push({ skuId: item.skuId, salePricePoisha: price, unitLimit });
  }
  if (values.enabled && values.items.length === 0)
    fields.enabled = 'campaigns.flash.form.nothingOnSale';

  if (Object.keys(fields).length > 0 || Object.keys(items).length > 0) {
    return { ok: false, errors: { fields, items } };
  }
  return {
    ok: true,
    body: {
      title,
      subtitle: values.subtitle.trim(),
      description: values.description.trim(),
      ...(slug === '' ? {} : { slug }),
      bannerFileId: values.bannerFileId,
      enabled: values.enabled,
      showOnHome: values.showOnHome,
      priority,
      startsAt,
      endsAt,
      items: lines,
    },
  };
}

/** Percent off the shelf price, whole, for the editor's hint. Null when it is no discount. */
export function percentOff(shelfPoisha: string, saleTaka: string): number | null {
  const sale = takaToPoisha(saleTaka);
  const shelf = BigInt(shelfPoisha);
  if (sale === null || shelf <= 0n) return null;
  const price = BigInt(sale);
  if (price <= 0n || price >= shelf) return null;
  // Rounded half up on whole percents: a hint, not money.
  return Number(((shelf - price) * 200n + shelf) / (shelf * 2n));
}
