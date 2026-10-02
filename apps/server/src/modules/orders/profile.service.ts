import { Inject, Injectable } from '@nestjs/common';
import { withOrg } from '@elysium/db';
import { poisha } from '@elysium/domain';
import { averageOrderValue, favourites } from '@elysium/domain/crm';

import type { ActiveContext } from '../../platform/http/context.js';
import { CATALOG_API, type CatalogApi } from '../catalog/catalog.api.js';
import * as crm from './crm.repository.js';
import { toCustomerView, CustomersService, type CustomerView } from './customers.service.js';
import * as repo from './orders.repository.js';
import { mapOrderErrors, OrdersError } from './orders.errors.js';
import { orderScopeSql } from './orders.service.js';

/**
 * A buyer's profile (architecture §10 "Buyer stats"; M16).
 *
 * Who may read it is `GET /v1/customers/:id`'s rule, applied by the same check
 * (`assertReachable`): a buyer outside the caller's §6 reach is a 404. Inside it, the
 * profile shows two kinds of thing, scoped differently, the way the desk's lookup does:
 *
 * - **The buyer's totals** — counters, segment, favourites, greetings — are brand-wide.
 *   They are what the buyer is to the brand, they name no other agent's order, and a sales
 *   agent deciding whether to offer a discount needs the whole history, not their slice.
 * - **The orders listed** are only those the caller could open anyway (`orderScopeSql`),
 *   so the profile is not a way round the order list's scope.
 */

const RECENT_ORDERS = 10;

export interface BuyerProfile {
  readonly customer: CustomerView;
  /** Lifetime value over delivered orders; null with nothing delivered. */
  readonly averageOrderPoisha: string | null;
  readonly favourites: {
    readonly categories: readonly { readonly name: string; readonly units: number }[];
    readonly sizes: readonly { readonly label: string; readonly units: number }[];
  };
  readonly segment: {
    readonly segment: string;
    readonly recency: number;
    readonly frequency: number;
    readonly monetary: number;
    readonly computedOn: string;
  } | null;
  readonly greetings: readonly {
    readonly occasion: string;
    readonly year: number;
    readonly sentAt: string;
  }[];
  readonly recentOrders: readonly {
    readonly id: string;
    readonly orderNo: string;
    readonly status: string;
    readonly channel: string;
    readonly codAmountPoisha: string;
    readonly createdAt: string;
  }[];
}

@Injectable()
export class BuyerProfileService {
  constructor(
    private readonly customers: CustomersService,
    @Inject(CATALOG_API) private readonly catalog: CatalogApi,
  ) {}

  async profile(
    context: ActiveContext,
    request: object,
    customerId: string,
  ): Promise<BuyerProfile> {
    const scope = orderScopeSql(context, request);
    return mapOrderErrors(async () =>
      withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
        await this.customers.assertReachable(tx, context, request, customerId);
        const row = await repo.customerById(tx, context.orgId, customerId);
        if (row === undefined) throw new OrdersError('CUSTOMER_NOT_FOUND', 'No such buyer.');

        const [kept, segment, greetings, recent] = await Promise.all([
          crm.keptUnitsBySku(tx, context.orgId, customerId),
          crm.segmentOf(tx, context.orgId, customerId),
          crm.occasionsOf(tx, context.orgId, customerId),
          crm.recentOrders(tx, context.orgId, customerId, scope, RECENT_ORDERS),
        ]);
        const facets = new Map(
          (
            await this.catalog.skuFacets(
              tx,
              context.orgId,
              kept.map((line) => line.sku_id),
            )
          ).map((facet) => [facet.skuId, facet]),
        );

        const customer = toCustomerView(row);
        const aov = averageOrderValue(poisha(row.ltv_poisha), row.delivered_count);
        return {
          customer,
          averageOrderPoisha: aov === null ? null : String(aov),
          favourites: {
            categories: favourites(
              kept.map((line) => ({
                key: facets.get(line.sku_id)?.categoryName ?? null,
                units: line.units,
              })),
            ).map(({ key, units }) => ({ name: key, units })),
            sizes: favourites(
              kept.map((line) => ({
                key: facets.get(line.sku_id)?.sizeLabel ?? null,
                units: line.units,
              })),
            ).map(({ key, units }) => ({ label: key, units })),
          },
          segment:
            segment === undefined
              ? null
              : {
                  segment: segment.segment,
                  recency: segment.recency,
                  frequency: segment.frequency,
                  monetary: segment.monetary,
                  computedOn: segment.computed_on,
                },
          greetings: greetings.map((greeting) => ({
            occasion: greeting.occasion,
            year: greeting.year,
            sentAt: new Date(greeting.created_at).toISOString(),
          })),
          recentOrders: recent.map((order) => ({
            id: order.id,
            orderNo: order.order_no,
            status: order.status,
            channel: order.channel,
            codAmountPoisha: order.cod_amount_poisha,
            createdAt: new Date(order.created_at).toISOString(),
          })),
        };
      }),
    );
  }
}
