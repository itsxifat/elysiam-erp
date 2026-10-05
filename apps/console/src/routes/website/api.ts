import type {
  Announcement,
  CategoryWebFieldsInput,
  HeroSlideInput,
  NavItemInput,
  PaymentMethods,
  ProductWebFieldsInput,
  PromoBanner,
  ShippingRuleInput,
  SiteInfo,
  SizeChartInput,
  SocialLinks,
  StorefrontSettingsPatch,
  Testimonial,
} from '@elysium/contracts';

import { api } from '../../api.js';

/**
 * The Website section's endpoints (M33, D-503 to D-508), typed to what the server returns.
 *
 * Bodies are the shared contract types, so a form cannot send what the server refuses. A
 * website key's secret is in exactly one response type, `IssuedSiteKey`: the issue call's.
 */

export interface WebsiteSettings {
  readonly siteInfo: SiteInfo;
  readonly social: SocialLinks;
  readonly announcement: Announcement;
  readonly promoBanner: PromoBanner;
  readonly testimonials: readonly Testimonial[];
  readonly shipping: ShippingRuleInput;
  readonly payments: PaymentMethods;
  readonly webLocationIds: readonly string[];
  readonly options: {
    readonly locations: readonly {
      readonly id: string;
      readonly code: string;
      readonly name: string;
      readonly kind: string;
      readonly isActive: boolean;
    }[];
    readonly deliveryZones: readonly {
      readonly id: string;
      readonly code: string;
      readonly nameEn: string;
      readonly nameBn: string;
      readonly chargePoisha: string;
      readonly isActive: boolean;
    }[];
  };
  readonly updatedAt: string | null;
}

export function getSettings(): Promise<WebsiteSettings> {
  return api.get('/v1/storefront/settings');
}

export function saveSettings(patch: StorefrontSettingsPatch): Promise<WebsiteSettings> {
  return api.patch('/v1/storefront/settings', patch);
}

export interface HeroSlide {
  readonly id: string;
  readonly desktopFileId: string;
  readonly mobileFileId: string | null;
  readonly link: string;
  readonly altText: string | null;
  readonly position: number;
  readonly isActive: boolean;
}

export function listSlides(): Promise<{ items: readonly HeroSlide[] }> {
  return api.get('/v1/storefront/hero-slides');
}
export function createSlide(input: HeroSlideInput): Promise<HeroSlide> {
  return api.post('/v1/storefront/hero-slides', input);
}
export function updateSlide(id: string, input: HeroSlideInput): Promise<HeroSlide> {
  return api.put(`/v1/storefront/hero-slides/${id}`, input);
}
export function deleteSlide(id: string): Promise<{ id: string }> {
  return api.delete(`/v1/storefront/hero-slides/${id}`);
}
export function reorderSlides(ids: readonly string[]): Promise<{ items: readonly HeroSlide[] }> {
  return api.put('/v1/storefront/hero-slides/order', { ids });
}

export interface NavItem {
  readonly id: string;
  readonly parentId: string | null;
  readonly kind: 'link' | 'category' | 'dropdown';
  readonly label: string | null;
  readonly href: string | null;
  readonly categoryId: string | null;
  readonly highlighted: boolean;
  readonly isActive: boolean;
  readonly position: number;
}

export interface NavCategory {
  readonly id: string;
  readonly parentId: string | null;
  readonly name: string;
  readonly slug: string;
  readonly isActive: boolean;
  readonly webVisible: boolean;
}

export function listNav(): Promise<{
  items: readonly NavItem[];
  categories: readonly NavCategory[];
}> {
  return api.get('/v1/storefront/nav-items');
}
export function createNavItem(input: NavItemInput): Promise<NavItem> {
  return api.post('/v1/storefront/nav-items', input);
}
export function updateNavItem(id: string, input: NavItemInput): Promise<NavItem> {
  return api.put(`/v1/storefront/nav-items/${id}`, input);
}
export function deleteNavItem(id: string): Promise<{ id: string }> {
  return api.delete(`/v1/storefront/nav-items/${id}`);
}
export function layoutNav(
  items: readonly { id: string; parentId: string | null; position: number }[],
): Promise<{ items: readonly NavItem[] }> {
  return api.put('/v1/storefront/nav-items/layout', { items });
}

export interface SizeChart {
  readonly id: string;
  readonly name: string;
  readonly columns: readonly string[];
  readonly rows: readonly (readonly string[])[];
  readonly updatedAt: string;
}

export function listSizeCharts(): Promise<{ items: readonly SizeChart[] }> {
  return api.get('/v1/storefront/size-charts');
}
export function createSizeChart(input: SizeChartInput): Promise<SizeChart> {
  return api.post('/v1/storefront/size-charts', input);
}
export function updateSizeChart(id: string, input: SizeChartInput): Promise<SizeChart> {
  return api.put(`/v1/storefront/size-charts/${id}`, input);
}
export function deleteSizeChart(id: string): Promise<{ id: string }> {
  return api.delete(`/v1/storefront/size-charts/${id}`);
}

export interface SiteKey {
  readonly id: string;
  readonly label: string;
  readonly keyId: string;
  readonly lastUsedAt: string | null;
  readonly revokedAt: string | null;
  readonly createdAt: string;
}

export interface IssuedSiteKey extends SiteKey {
  /** In this response only, ever. */
  readonly secret: string;
}

export function listKeys(): Promise<{ items: readonly SiteKey[]; configured: boolean }> {
  return api.get('/v1/storefront/site-keys');
}
export function issueKey(label: string): Promise<IssuedSiteKey> {
  return api.post('/v1/storefront/site-keys', { label });
}
export function revokeKey(id: string): Promise<SiteKey> {
  return api.post(`/v1/storefront/site-keys/${id}/revoke`);
}

export function saveProductWebFields(
  productId: string,
  input: ProductWebFieldsInput,
): Promise<{ productId: string; web: unknown }> {
  return api.put(`/v1/storefront/products/${productId}`, input);
}

export function saveCategoryWebFields(
  categoryId: string,
  input: CategoryWebFieldsInput,
): Promise<unknown> {
  return api.put(`/v1/storefront/categories/${categoryId}`, input);
}

/** A short-lived address for one stored image, to preview it here (§22). */
export function previewUrl(fileId: string): Promise<{ url: string }> {
  return api.get(`/v1/files/${fileId}/download`);
}
