import type { OrderLabelSize } from '@elysium/contracts';

import { ApiError, api, csrfToken, CSRF_HEADER } from '../../api.js';
import { env } from '../../env.js';

/**
 * The Scan page and the label sheet (M35b, D-554, D-555), typed to what the server returns.
 *
 * The lookup answers in the packing scanner app's own shape (the old site's), so the page and
 * the phone read one packing list.
 */

export interface PackingItem {
  readonly skuId: string;
  readonly name: string;
  /** A public image address, or '' when the product has none on the website. */
  readonly image: string;
  readonly sku: string;
  readonly barcode: string | null;
  readonly size: string;
  readonly color: string;
  readonly quantity: number;
  readonly returnedQuantity: number;
}

export interface PackingOrder {
  readonly id: string;
  readonly orderNumber: string;
  readonly status: string;
  readonly channel: string;
  readonly createdAt: string;
  readonly paymentMethod: 'cod' | 'prepaid';
  readonly paid: boolean;
  readonly cod: { readonly poisha: string; readonly taka: string };
  readonly total: { readonly poisha: string; readonly taka: string };
  readonly notes: string;
  readonly courier: string | null;
  readonly consignmentId: string | null;
  readonly trackingCode: string;
  readonly recipient: { readonly name: string; readonly phone: string; readonly address: string };
  readonly itemCount: number;
  readonly totalUnits: number;
  readonly items: readonly PackingItem[];
}

export type ShipmentLookup =
  | { readonly found: false; readonly code: string }
  | { readonly found: true; readonly code: string; readonly order: PackingOrder };

export function lookupShipment(code: string): Promise<ShipmentLookup> {
  return api.get(`/v1/scanner/lookup?code=${encodeURIComponent(code)}`);
}

export interface ScannerDevice {
  readonly id: string;
  readonly userId: string;
  readonly userName: string | null;
  readonly label: string;
  readonly via: 'password' | 'console';
  readonly lastUsedAt: string | null;
  readonly expiresAt: string | null;
  readonly revokedAt: string | null;
  readonly createdAt: string | null;
  readonly active: boolean;
}

export function listDevices(): Promise<{ items: readonly ScannerDevice[]; everyone: boolean }> {
  return api.get('/v1/scanner/devices');
}

/** The sign-in code is in this answer only: the server keeps its hash. */
export function pairDevice(deviceName: string): Promise<{ token: string; device: ScannerDevice }> {
  return api.post('/v1/scanner/devices', deviceName === '' ? {} : { deviceName });
}

export function revokeDevice(id: string): Promise<{ id: string; revoked: boolean }> {
  return api.post(`/v1/scanner/devices/${id}/revoke`);
}

/**
 * The label sheet, as a PDF blob. Not through `api.post`, which parses JSON; a refusal still
 * comes back as problem+json and its message is kept.
 */
export async function orderLabelsPdf(input: {
  readonly orderIds: readonly string[];
  readonly size: OrderLabelSize;
  readonly layout: 'portrait' | 'landscape';
  readonly showShopName: boolean;
  readonly showQr: boolean;
  readonly showPrices: boolean;
  readonly showCod: boolean;
}): Promise<Blob> {
  const token = csrfToken();
  const response = await fetch(new URL('/v1/packing/labels', env.VITE_API_URL), {
    method: 'POST',
    credentials: 'include',
    headers: {
      'content-type': 'application/json',
      ...(token === '' ? {} : { [CSRF_HEADER]: token }),
    },
    body: JSON.stringify(input),
  });
  if (!response.ok) {
    const problem = (await response.json().catch(() => null)) as {
      code?: string;
      detail?: string;
      message?: string;
    } | null;
    throw new ApiError(
      response.status,
      problem?.code ?? null,
      problem?.detail ?? problem?.message ?? response.statusText,
    );
  }
  return response.blob();
}
