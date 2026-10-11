import { Inject, Injectable, Module } from '@nestjs/common';
import { withOrg, type Tx } from '@elysium/db';
import { normalizeBdPhone } from '@elysium/domain';
import {
  legacyPhone,
  planLegacyCustomers,
  type LegacyCustomerPlan,
} from '@elysium/domain/storefront';
import { sql } from 'drizzle-orm';

import { ORDERS_API, type OrdersApi } from '../orders/orders.api.js';
import { OrdersModule } from '../orders/orders.module.js';
import * as buying from './buying.repository.js';
import * as repo from './storefront.repository.js';

/** Who an imported row is written by: the implementation team's command, never a person. */
export const LEGACY_IMPORT_ACTOR = 'system:legacy-customers';

export class LegacyImportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LegacyImportError';
  }
}

export interface LegacyImportReport {
  readonly plan: LegacyCustomerPlan;
  readonly written: { readonly accounts: number; readonly buyers: number } | null;
}

/** The file as rows: a JSON array of objects (`mongoexport --jsonArray`). */
export function parseUsersFile(text: string): unknown[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.replace(/^\uFEFF/, ''));
  } catch {
    throw new LegacyImportError(
      'The file is not JSON. Export it with `mongoexport --collection users --jsonArray`.',
    );
  }
  if (!Array.isArray(parsed)) {
    throw new LegacyImportError('The file is not a JSON array; export it with `--jsonArray`.');
  }
  return parsed;
}

/**
 * The optional import of the old website's customers (M34, D-531; D-561: the only old data the
 * new website ever takes, and only if the owner chooses).
 *
 * `pnpm migration legacy-customers --org <slug> dry-run|commit --file <users.json>`. A dry run
 * reports what it would write and what it leaves out, by row and reason, never a name, an email
 * or a phone (invariant 10). A commit writes it all in one transaction, inside the brand's
 * `withOrg()`, or nothing: website accounts (the old bcrypt hashes unchanged), buyers by phone
 * through the orders module (invariant 12), each account linked to its buyer, and every old id in
 * `legacy_ids` (kind `customer`). Run twice, the second finds everything there and writes nothing.
 */
@Injectable()
export class LegacyCustomersImporter {
  constructor(@Inject(ORDERS_API) private readonly orders: OrdersApi) {}

  async dryRun(orgId: string, text: string): Promise<LegacyImportReport> {
    const rows = parseUsersFile(text);
    return withOrg({ orgId, userId: LEGACY_IMPORT_ACTOR }, async (tx) => ({
      plan: await this.plan(tx, orgId, rows),
      written: null,
    }));
  }

  async commit(orgId: string, text: string): Promise<LegacyImportReport> {
    const rows = parseUsersFile(text);
    return withOrg({ orgId, userId: LEGACY_IMPORT_ACTOR }, async (tx) => {
      // One import at a time per brand, so two operators cannot race the same file.
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`legacy-customers:${orgId}`}))`);
      const plan = await this.plan(tx, orgId, rows);
      const actor = { orgId, userId: LEGACY_IMPORT_ACTOR };

      await this.orders.importBuyers(
        tx,
        actor,
        plan.buyers.map((buyer) => ({
          phoneE164: normalizeBdPhone(buyer.phone),
          name: buyer.name,
          delivered: 0,
          returned: 0,
          cancelled: 0,
          spentPoisha: 0n,
        })),
      );

      const legacy: { kind: string; legacyId: string; erpId: string }[] = [];
      for (const account of plan.accounts) {
        const phoneE164 = account.phone === null ? null : normalizeBdPhone(account.phone);
        const customerId =
          phoneE164 === null
            ? null
            : ((await this.orders.buyerIdByPhone(tx, orgId, phoneE164)) ?? null);
        const id = await buying.insertAccount(tx, {
          orgId,
          email: account.email,
          passwordHash: account.passwordHash,
          googleSub: null,
          name: account.name,
          phoneE164,
          customerId,
          locale: 'en',
          source: 'legacy_import',
          emailVerifiedAt: account.emailVerified ? (account.createdAt ?? new Date()) : null,
          createdAt: account.createdAt,
        });
        if (id === undefined) {
          throw new LegacyImportError(
            'An account appeared while the import ran; nothing was written. Run it again.',
          );
        }
        legacy.push({ kind: 'customer', legacyId: account.legacyId, erpId: id });
      }
      // A guest's old id names the buyer it became.
      for (const buyer of plan.buyers) {
        if (legacy.some((entry) => entry.legacyId === buyer.legacyId)) continue;
        const customerId = await this.orders.buyerIdByPhone(
          tx,
          orgId,
          normalizeBdPhone(buyer.phone),
        );
        if (customerId !== undefined) {
          legacy.push({ kind: 'customer', legacyId: buyer.legacyId, erpId: customerId });
        }
      }
      for (let start = 0; start < legacy.length; start += 500) {
        await repo.insertLegacyIds(tx, orgId, legacy.slice(start, start + 500));
      }
      return { plan, written: { accounts: plan.accounts.length, buyers: plan.buyers.length } };
    });
  }

  private async plan(tx: Tx, orgId: string, rows: readonly unknown[]): Promise<LegacyCustomerPlan> {
    const emails = new Set<string>();
    const phones = new Set<string>();
    for (const row of rows) {
      if (typeof row !== 'object' || row === null) continue;
      const record = row as Record<string, unknown>;
      if (typeof record.email === 'string') emails.add(record.email.trim().toLowerCase());
      const phone = legacyPhone(record.phone);
      if (phone !== null) phones.add(normalizeBdPhone(phone));
    }
    const existingEmails = new Set<string>();
    for (const email of emails) {
      if ((await buying.accountByEmail(tx, orgId, email)) !== undefined) existingEmails.add(email);
    }
    const buyerPhones = await this.orders.buyerPhones(tx, orgId, [...phones]);
    return planLegacyCustomers(rows, {
      accountEmails: existingEmails,
      buyerPhones: new Set([...buyerPhones].map((phone) => `0${phone.slice(4)}`)),
    });
  }
}

/** What `pnpm migration legacy-customers` boots: the importer and the orders module it asks. */
@Module({
  imports: [OrdersModule],
  providers: [LegacyCustomersImporter],
})
export class LegacyCustomersModule {}
