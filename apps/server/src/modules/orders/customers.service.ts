import { Inject, Injectable } from '@nestjs/common';
import { withOrg, type Tx } from '@elysium/db';
import { maskPhone, normalizeBdPhone, poisha, type PhoneSource } from '@elysium/domain';
import { sql } from 'drizzle-orm';

import type { AuditableRequest } from '../../platform/audit/audit.interceptor.js';
import { AuditService } from '../../platform/audit/audit.service.js';
import { assertInScope, scopeOf, scopeWhere } from '../../platform/auth/scope.js';
import type { ActiveContext } from '../../platform/http/context.js';
import { IAM_API, type IamApi } from '../iam/iam.api.js';
import { addNumber, phoneViews, pickPersonByPhone } from './numbers.helpers.js';
import * as repo from './orders.repository.js';
import { mapOrderErrors, OrdersError } from './orders.errors.js';
import type { CreateCustomerInput, CustomerQuery, UpdateCustomerInput } from './orders.schemas.js';

/**
 * Buyers (architecture §9 "Customers").
 *
 * The one decision in this file that everything else follows from: a customer is
 * identified by their phone number, normalised through `normalizeBdPhone`, and the
 * upsert is keyed on that. Get it wrong once and the same person becomes two rows with
 * two order histories, and a split buyer's delivery ratio is computed from half the
 * evidence. The unique index and the
 * `customers_phone_e164` CHECK are the two backstops behind it.
 *
 * Invariant 10 applies to every log line and audit row in here. The phone number is the
 * personal datum this system holds most of, and the audit interceptor's `redact` already
 * masks fields whose *name* looks like a phone — so the audit payloads below name the
 * field `phone`, not `buyerContact`, precisely so that machinery catches it. Where a
 * number appears in a message, it goes through `maskPhone` first.
 */

export interface CustomerView {
  readonly id: string;
  readonly phone: string;
  readonly name: string;
  readonly birthday: string | null;
  readonly anniversary: string | null;
  readonly gender: string | null;
  readonly ageBand: string | null;
  readonly profession: string | null;
  readonly tags: readonly string[];
  readonly notes: string | null;
  /** M48 (D-884): set on a record merged into another, which the screens follow. */
  readonly mergedIntoCustomerId: string | null;
  readonly stats: {
    readonly orders: number;
    readonly delivered: number;
    readonly returned: number;
    readonly cancelled: number;
    readonly ltvPoisha: string;
    readonly firstOrderAt: string | null;
    readonly lastOrderAt: string | null;
  };
}

/** The wire shape of one buyer, shared with the profile. */
export function toCustomerView(row: repo.CustomerRow): CustomerView {
  return {
    id: row.id,
    phone: row.phone_e164,
    name: row.name,
    birthday: row.birthday,
    anniversary: row.anniversary,
    gender: row.gender,
    ageBand: row.age_band,
    profession: row.profession,
    tags: Array.isArray(row.tags) ? (row.tags as string[]) : [],
    notes: row.notes,
    mergedIntoCustomerId: row.merged_into_customer_id,
    stats: {
      orders: row.orders_total,
      delivered: row.delivered_count,
      returned: row.returned_count,
      cancelled: row.cancelled_count,
      ltvPoisha: String(row.ltv_poisha),
      // Text from the driver, normalised to ISO 8601 for the wire (§23).
      firstOrderAt: row.first_order_at === null ? null : new Date(row.first_order_at).toISOString(),
      lastOrderAt: row.last_order_at === null ? null : new Date(row.last_order_at).toISOString(),
    },
  };
}

@Injectable()
export class CustomersService {
  constructor(
    private readonly audit: AuditService,
    @Inject(IAM_API) private readonly iam: IamApi,
  ) {}

  async list(context: ActiveContext, request: object, query: CustomerQuery) {
    /*
     * §6 gives sales `read Customer` at `own` scope: "customers of own orders".
     *
     * A customer row has no `created_by` of its own that means anything useful — the
     * agent who first took their call is not who owns the relationship — so the scope is
     * applied through the orders the caller owns. That is why the filter is an EXISTS
     * over `sales.orders` rather than a column on `sales.customers`: the scope is a fact
     * about the orders, and mapping it onto a customer column would have made "own"
     * either meaningless or wrong.
     */
    const orderScope = scopeWhere(request, {
      createdBy: sql`o.created_by`,
      assignedTo: sql`o.assigned_to`,
      branchId: sql`o.branch_id`,
    });
    // As in `assertVisible`: the EXISTS is what "customers of own orders" means, and a
    // caller whose cell is `org` must still see a buyer who has not ordered yet.
    const visible =
      scopeOf(request).kind === 'all'
        ? sql`true`
        : sql`(
            exists (
              select 1 from sales.orders o
              where o.org_id = c.org_id and o.customer_id = c.id and ${orderScope}
            )
            or not exists (
              select 1 from sales.orders o
              where o.org_id = c.org_id and o.customer_id = c.id
            )
          )`;

    return withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
      const rows = await tx.execute<repo.CustomerRow>(sql`
        select c.id, c.phone_e164, c.name, c.birthday, c.anniversary, c.gender,
               c.age_band, c.profession, c.tags, c.notes, c.orders_total, c.delivered_count,
               c.returned_count, c.cancelled_count, c.ltv_poisha, c.first_order_at, c.last_order_at,
               c.merged_into_customer_id
        from sales.customers c
        where c.org_id = ${context.orgId}
          -- M48 (D-884): a merged record is reached through the one it joined.
          and c.merged_into_customer_id is null
          and ${
            query.q === undefined
              ? sql`true`
              : // M48 (D-877): any number the person uses now, not only the primary.
                sql`(c.name ilike ${`%${query.q}%`} or exists (
                    select 1 from sales.customer_phones p
                    where p.org_id = c.org_id and p.customer_id = c.id and p.retired_at is null
                      and p.phone_e164 ilike ${`%${query.q}%`}))`
          }
          and ${visible}
        order by c.last_order_at desc nulls last, c.created_at desc
        limit ${query.limit} offset ${query.offset}
      `);
      return { items: [...rows].map(toCustomerView) };
    });
  }

  /**
   * The same EXISTS, for one buyer.
   *
   * A list that filters and a `GET /:id` that does not is the commonest shape of this
   * bug: the index respects §6 and the detail page hands over any row to anyone who can
   * guess a uuid. So every single-buyer path goes through here, and a buyer outside the
   * caller's reach is reported as missing rather than as forbidden — the same answer RLS
   * gives across orgs, so the error cannot be used to enumerate buyers.
   */
  private async assertVisible(
    tx: Tx,
    context: ActiveContext,
    request: object,
    customerId: string,
  ): Promise<void> {
    const orderScope = scopeWhere(request, {
      createdBy: sql`o.created_by`,
      assignedTo: sql`o.assigned_to`,
      branchId: sql`o.branch_id`,
    });
    /*
     * An org-wide caller sees every buyer, including one with no orders yet.
     *
     * The EXISTS is how "customers of own orders" is expressed, and applying it to a
     * caller whose cell is `org` would hide a buyer somebody has only just entered —
     * which reads as the create endpoint having failed. `scopeWhere` above has already
     * marked the scope applied, so short-circuiting here is safe.
     */
    if (scopeOf(request).kind === 'all') return;

    const rows = await tx.execute<{ mine: boolean; anyone: boolean }>(sql`
      select
        exists (
          select 1 from sales.orders o
          where o.org_id = ${context.orgId} and o.customer_id = ${customerId} and ${orderScope}
        ) as mine,
        exists (
          select 1 from sales.orders o
          where o.org_id = ${context.orgId} and o.customer_id = ${customerId}
        ) as anyone
    `);
    /*
     * Mine, or nobody's yet.
     *
     * The literal reading of "customers of own orders" hides a buyer who has no orders at
     * all — including the one this agent created thirty seconds ago, which makes
     * create-a-buyer-then-take-their-order fail on its second step and reads as the create
     * endpoint having silently failed. A buyer nobody has ordered for is nobody's, so
     * admitting them takes nothing from anyone; the moment another agent's order exists for
     * them, `mine` is the only thing that lets this caller through.
     */
    if (rows[0]?.mine !== true && rows[0]?.anyone !== false) {
      throw new OrdersError('CUSTOMER_NOT_FOUND', 'No such buyer.');
    }
  }

  /**
   * The same check, for the order endpoints.
   *
   * Public because taking an order for an existing buyer reads that buyer — their name and
   * their number come back on the order — so the id in the body has to pass the same test
   * `GET /v1/customers/:id` applies. Without it, guessing a uuid inside your own org was a
   * way to read a buyer §6 does not give you.
   */
  async assertReachable(
    tx: Tx,
    context: ActiveContext,
    request: object,
    customerId: string,
  ): Promise<void> {
    await this.assertVisible(tx, context, request, customerId);
  }

  async get(context: ActiveContext, request: object, id: string) {
    return mapOrderErrors(async () =>
      withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
        await this.assertVisible(tx, context, request, id);
        const row = await repo.customerById(tx, context.orgId, id);
        if (row === undefined) throw new OrdersError('CUSTOMER_NOT_FOUND', 'No such buyer.');
        return {
          ...toCustomerView(row),
          // M48 (D-870): every number, with its rank, kind, relation and the staff's note.
          phones: await phoneViews(tx, this.iam, context.orgId, id),
          addresses: (await repo.listAddresses(tx, context.orgId, id)).map((address) => ({
            id: address.id,
            label: address.label,
            districtId: address.district_id,
            thanaId: address.thana_id,
            area: address.area,
            addressLine: address.address_line,
            isDefault: address.is_default,
          })),
        };
      }),
    );
  }

  async create(context: ActiveContext, request: AuditableRequest, input: CreateCustomerInput) {
    return mapOrderErrors(async () =>
      withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
        /*
         * D-061: a `create` has no row to filter, so the scope is checked against the row
         * about to exist. §6 gives `create Customer` to `sales` at `own` and to nobody
         * else, and a buyer a sales agent creates is by definition theirs — so this
         * passes for the grant that exists and refuses anything wider that is added
         * later without thinking about it.
         */
        assertInScope(request, { createdBy: context.userId, assignedTo: context.userId });
        // The first number is the staff's when they wrote why; else as the desk's (D-871).
        const customer = await this.upsert(tx, context, input, {
          source: input.phoneNote === undefined ? 'order' : 'staff',
        });
        await this.audit.record(tx, {
          orgId: context.orgId,
          actorUserId: context.userId,
          operation: 'create',
          action: 'customer.created',
          entityType: 'customer',
          entityId: customer.id,
          // Named `phone` on purpose: the audit redactor masks by field name, so calling
          // it anything else is how a full number ends up in an append-only table.
          after: { phone: input.phone, name: input.name },
          request,
        });
        return { id: customer.id, phone: customer.phoneE164, created: customer.created };
      }),
    );
  }

  async update(
    context: ActiveContext,
    request: AuditableRequest,
    id: string,
    patch: UpdateCustomerInput,
  ) {
    return mapOrderErrors(async () =>
      withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
        await this.assertVisible(tx, context, request, id);
        const before = await repo.customerById(tx, context.orgId, id);
        if (before === undefined) throw new OrdersError('CUSTOMER_NOT_FOUND', 'No such buyer.');

        const changed = await repo.updateCustomer(tx, context.orgId, id, {
          name: patch.name,
          birthday: patch.birthday,
          anniversary: patch.anniversary,
          gender: patch.gender,
          ageBand: patch.ageBand,
          profession: patch.profession,
          tags: patch.tags,
          notes: patch.notes,
        });
        if (!changed) throw new OrdersError('CUSTOMER_NOT_FOUND', 'No such buyer.');

        if (patch.address !== undefined) {
          await assertArea(tx, patch.address);
          await repo.insertAddress(tx, {
            orgId: context.orgId,
            customerId: id,
            label: null,
            districtId: patch.address.districtId,
            thanaId: patch.address.thanaId,
            area: patch.address.area ?? null,
            addressLine: patch.address.addressLine,
            isDefault: true,
          });
        }

        await this.audit.record(tx, {
          orgId: context.orgId,
          actorUserId: context.userId,
          operation: 'update',
          action: 'customer.updated',
          entityType: 'customer',
          entityId: id,
          before: { name: before.name },
          after: { name: patch.name ?? before.name },
          request,
        });
        const row = await repo.customerById(tx, context.orgId, id);
        return row === undefined ? { id } : toCustomerView(row);
      }),
    );
  }

  /**
   * Find or create a buyer by their phone number, inside a caller's transaction.
   *
   * Used by order creation as well as by the endpoint, which is why it takes the `tx`:
   * a new buyer and their first order have to commit together, or a failed order leaves
   * a customer row nobody asked for and the next attempt reports the phone as taken.
   *
   * Find-then-insert rather than `on conflict do update`: an existing buyer's name is
   * **not** overwritten by whatever the caller typed on this call. An agent taking a
   * rushed order types "Rahim" for a buyer saved as "Md. Rahim Uddin"; an upsert would
   * quietly degrade every buyer record over time, in a column nobody audits.
   *
   * M48 (D-875, D-876): one number may be several people's. "Find" is the automatic pick (the
   * person whose primary own number it is, else whoever ordered last); `shared` says it had to
   * choose, so the order is flagged for the desk. `newPerson` is the desk's "a new person on this
   * number": a new buyer even though someone already uses it.
   */
  async upsert(
    tx: Tx,
    context: ActiveContext,
    input: CreateCustomerInput,
    options: { readonly source?: PhoneSource } = {},
  ): Promise<{
    id: string;
    phoneE164: string;
    created: boolean;
    name: string;
    shared: boolean;
  }> {
    const phoneE164 = normalizeBdPhone(input.phone);
    const existing =
      input.newPerson === true ? undefined : await pickPersonByPhone(tx, context.orgId, phoneE164);
    const existingRow =
      existing === undefined
        ? undefined
        : await repo.customerById(tx, context.orgId, existing.customerId);
    if (existing !== undefined && existingRow !== undefined) {
      if (input.address !== undefined) {
        await assertArea(tx, input.address);
        await repo.insertAddress(tx, {
          orgId: context.orgId,
          customerId: existingRow.id,
          label: null,
          districtId: input.address.districtId,
          thanaId: input.address.thanaId,
          area: input.address.area ?? null,
          addressLine: input.address.addressLine,
          isDefault: true,
        });
      }
      return {
        id: existingRow.id,
        phoneE164,
        created: false,
        name: existingRow.name,
        shared: existing.shared,
      };
    }

    const id = await repo.insertCustomer(tx, {
      orgId: context.orgId,
      phoneE164,
      name: input.name,
      birthday: input.birthday ?? null,
      anniversary: input.anniversary ?? null,
      gender: input.gender ?? null,
      ageBand: input.ageBand ?? null,
      profession: input.profession ?? null,
      tags: input.tags ?? [],
      notes: input.notes ?? null,
    });
    // The new person's first number (D-870): theirs unless the desk said whose it is.
    await addNumber(tx, {
      orgId: context.orgId,
      customerId: id,
      phoneE164,
      relation: input.phoneRelation ?? 'own',
      note: input.phoneNote,
      source: options.source ?? 'order',
      addedByUserId: context.userId,
    });
    if (input.address !== undefined) {
      await assertArea(tx, input.address);
      await repo.insertAddress(tx, {
        orgId: context.orgId,
        customerId: id,
        label: null,
        districtId: input.address.districtId,
        thanaId: input.address.thanaId,
        area: input.address.area ?? null,
        addressLine: input.address.addressLine,
        isDefault: true,
      });
    }
    return { id, phoneE164, created: true, name: input.name, shared: false };
  }

  /** The buyer a caller named, or a clear refusal that names no number. */
  async require(tx: Tx, orgId: string, id: string): Promise<repo.CustomerRow> {
    const row = await repo.customerById(tx, orgId, id);
    if (row === undefined) {
      throw new OrdersError('CUSTOMER_NOT_FOUND', 'No such buyer in this brand.');
    }
    return row;
  }

  /** Buyer counters after a transition. Kept here so one file owns the buyer's stats. */
  async applyStats(
    tx: Tx,
    orgId: string,
    customerId: string,
    delta: {
      readonly orders?: number;
      readonly delivered?: number;
      readonly returned?: number;
      readonly cancelled?: number;
      readonly ltvPoisha?: bigint;
      /** A `Date`, or the text a row handed back — `OrderRow.created_at` is the latter. */
      readonly orderedAt?: Date | string;
    },
  ): Promise<void> {
    await repo.bumpCustomerStats(tx, orgId, customerId, delta);
  }

  /** For a message that has to mention a number at all (invariant 10). */
  static describePhone(phone: string): string {
    return maskPhone(phone);
  }

  /** Narrows a decimal string to `Poisha` for callers that need the branded type. */
  static asPoisha(value: string) {
    return poisha(BigInt(value));
  }
}

/** An address's district and thana, checked against the reference data (M30, D2). */
async function assertArea(
  tx: Tx,
  address: { readonly districtId: number; readonly thanaId: number },
): Promise<void> {
  if (!(await repo.areaExists(tx, address.districtId, address.thanaId))) {
    throw new OrdersError(
      'VALIDATION_FAILED',
      'That thana is not one of the district’s. Choose the district, then a thana in it.',
    );
  }
}
