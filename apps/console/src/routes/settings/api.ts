import { api } from '../../api.js';

/**
 * The settings screens' endpoints, typed to what the controllers return (D-394).
 *
 * Every route here existed before the screen except `GET /v1/approvals/thresholds` and
 * `GET /v1/courier/providers`, which this pass added because the screens had a write and no
 * read. Courier accounts, branches, wallets and locations are read through their own
 * sections' clients.
 *
 * **No secret is ever in a response type.** A courier credential and a webhook secret are
 * write-only; a site key's secret is returned once, by the issue call, and by nothing else.
 */

export interface ThresholdRow {
  readonly type: string;
  /** Integer poisha in force, or null: no threshold, so every request is held. */
  readonly thresholdPoisha: string | null;
  /** Relaxations waiting for a second org admin (D-073). */
  readonly pending: readonly {
    readonly approvalId: string;
    readonly thresholdPoisha: string;
    readonly requestedBy: string;
  }[];
}

export function listThresholds(): Promise<{
  items: readonly ThresholdRow[];
  alwaysHeld: readonly string[];
}> {
  return api.get('/v1/approvals/thresholds');
}

export function setThreshold(
  type: string,
  thresholdPoisha: string,
): Promise<{ status: 'applied' | 'pending_approval'; approvalId?: string }> {
  return api.put('/v1/approvals/thresholds', { type, thresholdPoisha });
}

export interface ZoneRow {
  readonly id: string;
  readonly code: string;
  readonly nameEn: string;
  readonly nameBn: string;
  readonly chargePoisha: string;
  readonly defaultCourierId: string | null;
  readonly position: number;
  readonly isActive: boolean;
}

export interface CourierParty {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly isActive: boolean;
}

export function listZones(): Promise<{
  zones: readonly ZoneRow[];
  couriers: readonly CourierParty[];
}> {
  return api.get('/v1/delivery-zones');
}

export function saveZone(input: {
  readonly code: string;
  readonly nameEn: string;
  readonly chargePoisha: string;
  readonly defaultCourierId?: string;
  readonly position?: number;
  readonly isActive: boolean;
}): Promise<ZoneRow> {
  return api.put('/v1/delivery-zones', input);
}

export interface SiteKeyRow {
  readonly id: string;
  readonly label: string;
  readonly channel: 'landing_page' | 'website';
  readonly keyId: string;
  readonly lastUsedAt: string | null;
  readonly revokedAt: string | null;
  readonly createdAt: string;
}

export function listSiteKeys(): Promise<{ items: readonly SiteKeyRow[] }> {
  return api.get('/v1/intake/site-keys');
}

/** The one response that carries the secret: show it once and let it go. */
export function issueSiteKey(input: {
  readonly label: string;
  readonly channel: 'landing_page' | 'website';
}): Promise<SiteKeyRow & { readonly secret: string }> {
  return api.post('/v1/intake/site-keys', input);
}

export function revokeSiteKey(id: string): Promise<SiteKeyRow> {
  return api.post(`/v1/intake/site-keys/${id}/revoke`);
}

export interface RegisterRow {
  readonly id: string;
  readonly branchId: string;
  readonly branchName: string;
  readonly locationId: string;
  readonly locationName: string;
  readonly code: string;
  readonly name: string;
  readonly isActive: boolean;
  readonly tenders: readonly ('cash' | 'bkash' | 'card')[];
}

export function listRegisters(): Promise<{ items: readonly RegisterRow[] }> {
  return api.get('/v1/pos/registers');
}

export function createRegister(input: {
  readonly branchId: string;
  readonly locationId: string;
  readonly code: string;
  readonly name: string;
  readonly cashWalletId: string;
  readonly bkashWalletId?: string;
  readonly cardWalletId?: string;
}): Promise<RegisterRow> {
  return api.post('/v1/pos/registers', input);
}

export function setRegisterActive(id: string, isActive: boolean): Promise<RegisterRow> {
  return api.patch(`/v1/pos/registers/${id}`, { isActive });
}

export interface LocationRow {
  readonly id: string;
  readonly branchId: string | null;
  readonly code: string;
  readonly name: string;
  readonly kind: string;
  readonly isActive: boolean;
}

export function listLocations(): Promise<{ items: readonly LocationRow[] }> {
  return api.get('/v1/inventory/locations');
}
