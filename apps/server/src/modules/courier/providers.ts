import type { CourierConnectKind } from '@elysium/contracts';

import type { CourierAdapterRegistry } from './adapters/courier-adapter.js';
import { serverEnv } from '../../platform/config/env.js';
import { adapterEnabled } from './courier.config.js';

/**
 * The couriers Settings → Couriers offers (D-913).
 *
 * Two kinds. A courier with an adapter is connected through its API: its keys are checked
 * against the courier and its parcels are booked from here. A courier with **no public API** is
 * offered all the same, because a brand still sends parcels with it: choosing it makes its
 * courier party, so an order can be given it and its parcels handed over and settled, and its
 * parcels are booked by hand in the courier's own merchant panel. Nothing is invented for it —
 * no endpoint, no field — which is what CLAUDE.md asks of an integration with no documentation.
 */
export interface PanelCourier {
  readonly code: string;
  readonly name: string;
}

/** Carrybee publishes no API documentation (merchant.carrybee.com only): booked in its panel. */
export const PANEL_COURIERS: readonly PanelCourier[] = [{ code: 'carrybee', name: 'Carrybee' }];

/**
 * Whether a courier is offered here. The fake adapter (§21: tests and local development) is not
 * offered by a production process: on a brand's own ERP it would be a "Fake" choice beside
 * Steadfast. It stays registered, so a preview's demo that set it up the old way still runs.
 */
export function courierOffered(code: string): boolean {
  return code !== 'fake' || serverEnv().NODE_ENV !== 'production';
}

/** The order the screen lists them in: the brands' couriers first, then any other adapter. */
const ORDER = ['steadfast', 'pathao', 'carrybee', 'redx'];

export interface CourierProviderView {
  readonly code: string;
  readonly name: string;
  readonly connect: CourierConnectKind;
  /** False for an unverified adapter whose switch is off: connecting it is refused. */
  readonly enabled: boolean;
  /** The keys the screen asks for, in order. Empty for a panel courier. */
  readonly credentialFields: readonly string[];
  /** Kept from D-395's account form. */
  readonly verified: boolean;
  readonly supportsWebhook: boolean;
}

/**
 * Every courier a brand can choose, for `GET /v1/courier/providers`.
 *
 * `credentialFields` leaves out `webhookToken`: it is the webhook secret, which the account
 * form asks for as its own field and connecting does not ask for at all.
 */
export function courierProviders(adapters: CourierAdapterRegistry): CourierProviderView[] {
  const items: CourierProviderView[] = [
    ...adapters
      .all()
      .filter((adapter) => courierOffered(adapter.code))
      .map((adapter) => ({
        code: adapter.code,
        name: adapter.name,
        connect: 'api' as const,
        enabled: adapterEnabled(adapter),
        credentialFields: adapter.credentialFields.filter((field) => field !== 'webhookToken'),
        verified: adapter.verified,
        supportsWebhook: adapter.supportsWebhook,
      })),
    ...PANEL_COURIERS.filter((courier) => adapters.get(courier.code) === undefined).map(
      (courier) => ({
        code: courier.code,
        name: courier.name,
        connect: 'panel' as const,
        enabled: true,
        credentialFields: [],
        verified: false,
        supportsWebhook: false,
      }),
    ),
  ];
  const rank = (code: string): number => {
    const index = ORDER.indexOf(code);
    return index === -1 ? ORDER.length : index;
  };
  return items.sort((left, right) => rank(left.code) - rank(right.code));
}

/** A courier's own name for its code: the adapter's, a panel courier's, or the code itself. */
export function courierName(adapters: CourierAdapterRegistry, code: string): string {
  return (
    adapters.get(code)?.name ??
    PANEL_COURIERS.find((courier) => courier.code === code)?.name ??
    code
  );
}
