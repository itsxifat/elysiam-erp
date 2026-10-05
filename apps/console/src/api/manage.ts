import type { UsageReport } from '@elysium/contracts';

import { api } from '../api.js';

/**
 * The delete, archive, restore and "what uses it" calls behind every Delete-or-archive
 * dialog (M39a, D-621 to D-634).
 *
 * One function per route, typed to what the server returns. A usage report is what the
 * dialog reads first (`GET …/usage`); the delete itself asks again inside its transaction,
 * so a report that went stale between the two is refused with an `*_IN_USE` code and the
 * dialog reloads the report.
 *
 * For M39b's product page and product list: `productUsage` / `deleteProduct` and
 * `skuUsage` / `deleteSku`, with `<DeleteOrArchive>` from `ui/delete-or-archive.tsx`;
 * archiving a product or a variant stays the existing `PATCH` (status `archived`).
 */

export type { UsageEntry, UsageReason, UsageReport } from '@elysium/contracts';

const enc = encodeURIComponent;

export interface Deleted {
  readonly id: string;
  readonly deleted: true;
}

// --- the catalog ---------------------------------------------------------------------------

export const categoryUsage = (id: string) =>
  api.get<UsageReport>(`/v1/catalog/categories/${enc(id)}/usage`);
export const deleteCategory = (id: string) =>
  api.delete<Deleted>(`/v1/catalog/categories/${enc(id)}`);
export const emptyAndDeleteCategory = (id: string, targetCategoryId: string | null) =>
  api.post<Deleted & { movedProducts: number; movedSubcategories: number; menuEntries: number }>(
    `/v1/catalog/categories/${enc(id)}/empty-and-delete`,
    { targetCategoryId },
  );
export const archiveCategory = (id: string) =>
  api.post<{ id: string; archived: boolean }>(`/v1/catalog/categories/${enc(id)}/archive`);
export const restoreCategory = (id: string) =>
  api.post<{ id: string; archived: boolean }>(`/v1/catalog/categories/${enc(id)}/restore`);

export const attributeUsage = (id: string) =>
  api.get<UsageReport>(`/v1/catalog/attributes/${enc(id)}/usage`);
export const deleteAttribute = (id: string) =>
  api.delete<Deleted>(`/v1/catalog/attributes/${enc(id)}`);
export const archiveAttribute = (id: string) =>
  api.post<{ id: string; archived: boolean }>(`/v1/catalog/attributes/${enc(id)}/archive`);
export const restoreAttribute = (id: string) =>
  api.post<{ id: string; archived: boolean }>(`/v1/catalog/attributes/${enc(id)}/restore`);
export const reorderValues = (attributeId: string, valueIds: readonly string[]) =>
  api.put<{ id: string; ordered: number }>(
    `/v1/catalog/attributes/${enc(attributeId)}/values/order`,
    { valueIds },
  );

export const valueUsage = (attributeId: string, valueId: string) =>
  api.get<UsageReport>(`/v1/catalog/attributes/${enc(attributeId)}/values/${enc(valueId)}/usage`);
export const deleteValue = (attributeId: string, valueId: string) =>
  api.delete<Deleted>(`/v1/catalog/attributes/${enc(attributeId)}/values/${enc(valueId)}`);
export const archiveValue = (attributeId: string, valueId: string, archiveVariants: boolean) =>
  api.post<{ id: string; archived: boolean; archivedVariants: number }>(
    `/v1/catalog/attributes/${enc(attributeId)}/values/${enc(valueId)}/archive`,
    { archiveVariants },
  );
export const restoreValue = (attributeId: string, valueId: string) =>
  api.post<{ id: string; archived: boolean }>(
    `/v1/catalog/attributes/${enc(attributeId)}/values/${enc(valueId)}/restore`,
  );

/** For M39b: what uses a product (its SKUs included), and deleting one nothing uses. */
export const productUsage = (id: string) =>
  api.get<UsageReport>(`/v1/catalog/products/${enc(id)}/usage`);
export const deleteProduct = (id: string) =>
  api.delete<Deleted & { deletedVariants: number }>(`/v1/catalog/products/${enc(id)}`);
/** For M39b: what uses one variant, and deleting one nothing uses. */
export const skuUsage = (id: string) => api.get<UsageReport>(`/v1/catalog/skus/${enc(id)}/usage`);
export const deleteSku = (id: string) => api.delete<Deleted>(`/v1/catalog/skus/${enc(id)}`);

// --- stock locations -----------------------------------------------------------------------

export const locationUsage = (id: string) =>
  api.get<UsageReport>(`/v1/inventory/locations/${enc(id)}/usage`);
export const deleteLocation = (id: string) =>
  api.delete<Deleted>(`/v1/inventory/locations/${enc(id)}`);
export const archiveLocation = (id: string) =>
  api.post<{ id: string; archived: boolean }>(`/v1/inventory/locations/${enc(id)}/archive`);
export const restoreLocation = (id: string) =>
  api.post<{ id: string; archived: boolean }>(`/v1/inventory/locations/${enc(id)}/restore`);

// --- suppliers -----------------------------------------------------------------------------

export const supplierUsage = (id: string) =>
  api.get<UsageReport>(`/v1/supply/suppliers/${enc(id)}/usage`);
export const deleteSupplier = (id: string) =>
  api.delete<Deleted>(`/v1/supply/suppliers/${enc(id)}`);
/** Deactivate and reactivate stay the supplier's own PATCH. */
export const setSupplierActive = (id: string, isActive: boolean) =>
  api.patch<unknown>(`/v1/supply/suppliers/${enc(id)}`, { isActive });

// --- discounts and flash sales -------------------------------------------------------------

export const discountUsage = (id: string) =>
  api.get<UsageReport>(`/v1/promo/codes/${enc(id)}/usage`);
export const deleteDiscount = (id: string) => api.delete<Deleted>(`/v1/promo/codes/${enc(id)}`);
export const archiveDiscount = (id: string) =>
  api.patch<{ id: string; status: string }>(`/v1/promo/codes/${enc(id)}`, { status: 'archived' });
/** An archived discount comes back paused. */
export const restoreDiscount = (id: string) =>
  api.post<{ id: string; status: string }>(`/v1/promo/codes/${enc(id)}/restore`);

export const flashSaleUsage = (id: string) =>
  api.get<UsageReport>(`/v1/promo/flash-sales/${enc(id)}/usage`);
export const deleteFlashSale = (id: string) =>
  api.delete<Deleted>(`/v1/promo/flash-sales/${enc(id)}`);
export const archiveFlashSale = (id: string) =>
  api.post<{ id: string; archived: boolean }>(`/v1/promo/flash-sales/${enc(id)}/archive`);
export const restoreFlashSale = (id: string) =>
  api.post<{ id: string; archived: boolean }>(`/v1/promo/flash-sales/${enc(id)}/restore`);

// --- SMS templates and ad campaigns --------------------------------------------------------

export const templateUsage = (id: string) =>
  api.get<UsageReport>(`/v1/notify/templates/${enc(id)}/usage`);
export const deleteTemplate = (id: string) =>
  api.delete<Deleted>(`/v1/notify/templates/${enc(id)}`);

export const campaignUsage = (id: string) =>
  api.get<UsageReport>(`/v1/marketing/campaigns/${enc(id)}/usage`);
export const deleteCampaign = (id: string) =>
  api.delete<Deleted>(`/v1/marketing/campaigns/${enc(id)}`);
/** Archive and restore stay the campaign's own PATCH. */
export const setCampaignStatus = (id: string, status: 'active' | 'archived') =>
  api.patch<unknown>(`/v1/marketing/campaigns/${enc(id)}`, { status });

// --- the website ---------------------------------------------------------------------------

export const sizeChartUsage = (id: string) =>
  api.get<UsageReport>(`/v1/storefront/size-charts/${enc(id)}/usage`);
export const deleteSizeChart = (id: string) =>
  api.delete<{ id: string }>(`/v1/storefront/size-charts/${enc(id)}`);
export const emptyAndDeleteSizeChart = (id: string, replacementId: string | null) =>
  api.post<Deleted & { movedProducts: number }>(
    `/v1/storefront/size-charts/${enc(id)}/empty-and-delete`,
    { replacementId },
  );

export interface NavItemUsage {
  readonly id: string;
  readonly kind: 'link' | 'category' | 'dropdown';
  readonly label: string | null;
  readonly children: number;
  readonly childLabels: readonly string[];
}
export const navItemUsage = (id: string) =>
  api.get<NavItemUsage>(`/v1/storefront/nav-items/${enc(id)}/usage`);

// --- branches ------------------------------------------------------------------------------

export interface BranchHolds {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly isActive: boolean;
  readonly canDeactivate: boolean;
  readonly holds: {
    readonly registers: number;
    readonly openShifts: number;
    readonly walletsWithMoney: number;
    readonly employees: number;
    readonly stockPlaces: number;
  };
}
export const branchHolds = (id: string) =>
  api.get<BranchHolds>(`/v1/pos/branches/${enc(id)}/holds`);
export const updateBranch = (id: string, patch: { name?: string; isActive?: boolean }) =>
  api.patch<{ id: string; name: string; isActive: boolean }>(`/v1/pos/branches/${enc(id)}`, patch);

// --- expense and income heads --------------------------------------------------------------

export interface Head {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly kind: 'income' | 'expense';
  readonly isActive: boolean;
  readonly isSystem: boolean;
}
export const listHeads = () => api.get<{ items: Head[] }>('/v1/accounts/heads');
export const createHead = (input: { name: string; kind: 'income' | 'expense' }) =>
  api.post<Head>('/v1/accounts/heads', input);
export const updateHead = (id: string, patch: { name?: string; isActive?: boolean }) =>
  api.patch<Head>(`/v1/accounts/heads/${enc(id)}`, patch);
