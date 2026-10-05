import { Inject, Injectable } from '@nestjs/common';
import { withOrg, type Tx } from '@elysium/db';
import { businessDate } from '@elysium/domain';
import { discountCeilingBps, POS_DISCOUNT_CEILING_BPS } from '@elysium/domain/pos';
import { sql } from 'drizzle-orm';

import type { AuditableRequest } from '../../platform/audit/audit.interceptor.js';
import { AuditService } from '../../platform/audit/audit.service.js';
import { assertInScope, scopeWhere } from '../../platform/auth/scope.js';
import type { ActiveContext } from '../../platform/http/context.js';
import { WALLETS_API, type WalletsApi } from '../wallets/wallets.api.js';
import { POS_CATALOG, type PosCatalogPort } from './ports/pos-catalog.port.js';
import { POS_STOCK, type PosStockPort } from './ports/pos-stock.port.js';
import { PROMO_CODES, type PromoCodePort } from './ports/promo-code.port.js';
import { posHttpError } from './pos.errors.js';
import * as repo from './pos.repository.js';
import type { CreateRegisterInput, UpdateRegisterInput } from './pos.schemas.js';
import { branchIsActive } from './references.repository.js';

/**
 * Registers, and everything a till loads before it can sell (§14).
 *
 * `session` and `catalog` are what the PWA caches for offline use: the register,
 * its shift, the cashier's discount ceiling, the receipt header and the price
 * list. None of it carries cost (invariant 5) — the price list is the catalog's
 * selling price and an availability count, nothing else.
 */

export interface RegisterView {
  readonly id: string;
  readonly branchId: string;
  readonly branchName: string;
  readonly locationId: string;
  readonly locationName: string;
  readonly code: string;
  readonly name: string;
  readonly isActive: boolean;
  readonly cashWalletId: string;
  readonly bkashWalletId: string | null;
  readonly cardWalletId: string | null;
  readonly tenders: readonly ('cash' | 'bkash' | 'card')[];
}

export function registerView(row: repo.RegisterRow): RegisterView {
  return {
    id: row.id,
    branchId: row.branch_id,
    branchName: row.branch_name,
    locationId: row.location_id,
    locationName: row.location_name,
    code: row.code,
    name: row.name,
    isActive: row.is_active,
    cashWalletId: row.cash_wallet_id,
    bkashWalletId: row.bkash_wallet_id,
    cardWalletId: row.card_wallet_id,
    tenders: [
      'cash',
      ...(row.bkash_wallet_id === null ? [] : (['bkash'] as const)),
      ...(row.card_wallet_id === null ? [] : (['card'] as const)),
    ],
  };
}

@Injectable()
export class RegistersService {
  constructor(
    private readonly audit: AuditService,
    @Inject(WALLETS_API) private readonly wallets: WalletsApi,
    @Inject(POS_CATALOG) private readonly catalog: PosCatalogPort,
    @Inject(POS_STOCK) private readonly stock: PosStockPort,
    @Inject(PROMO_CODES) private readonly promo: PromoCodePort,
  ) {}

  async list(context: ActiveContext, request: object): Promise<{ items: RegisterView[] }> {
    const scope = scopeWhere(request, { branchId: sql`r.branch_id` });
    return withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => ({
      items: (await repo.registers(tx, context.orgId, scope)).map(registerView),
    }));
  }

  async create(
    context: ActiveContext,
    request: AuditableRequest,
    input: CreateRegisterInput,
  ): Promise<RegisterView> {
    assertInScope(request, { branchId: input.branchId });
    return withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
      await assertBranchActive(tx, context.orgId, input.branchId);
      await this.assertWallets(tx, context.orgId, input.branchId, input);
      const id = await repo.insertRegister(tx, {
        orgId: context.orgId,
        branchId: input.branchId,
        locationId: input.locationId,
        code: input.code,
        name: input.name,
        cashWalletId: input.cashWalletId,
        bkashWalletId: input.bkashWalletId ?? null,
        cardWalletId: input.cardWalletId ?? null,
        createdBy: context.userId,
      });
      if (id === undefined) {
        throw posHttpError('POS_REGISTER_INVALID', 'A register with that code already exists.');
      }
      const row = await repo.registerById(tx, context.orgId, id);
      if (row === undefined)
        throw new Error('a register inserted in this transaction is not visible');
      await this.audit.record(tx, {
        orgId: context.orgId,
        actorUserId: context.userId,
        operation: 'create',
        action: 'pos.register.created',
        entityType: 'PosRegister',
        entityId: id,
        before: null,
        after: { ...registerView(row) },
        requestId: context.requestId,
        request,
      });
      return registerView(row);
    });
  }

  async update(
    context: ActiveContext,
    request: AuditableRequest,
    id: string,
    patch: UpdateRegisterInput,
  ): Promise<RegisterView> {
    return withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
      const before = await this.inScope(tx, context, request, id);
      if (patch.isActive === true) {
        await assertBranchActive(tx, context.orgId, before.branch_id);
      }
      await this.assertWallets(tx, context.orgId, before.branch_id, {
        bkashWalletId: patch.bkashWalletId,
        cardWalletId: patch.cardWalletId,
      });
      await repo.updateRegister(tx, context.orgId, id, patch);
      const after = await repo.registerById(tx, context.orgId, id);
      if (after === undefined) throw new Error('a register vanished inside its own transaction');
      await this.audit.record(tx, {
        orgId: context.orgId,
        actorUserId: context.userId,
        operation: 'update',
        action: 'pos.register.updated',
        entityType: 'PosRegister',
        entityId: id,
        before: { ...registerView(before) },
        after: { ...registerView(after) },
        requestId: context.requestId,
        request,
      });
      return registerView(after);
    });
  }

  /**
   * What a till needs to start selling: its register, its open shift, the
   * cashier's discount ceiling at this branch, and the receipt header.
   *
   * The ceiling is *displayed* by the till and *enforced* by the sync — a sale
   * above it is held for a manager whatever the till showed (D-075: per role, at
   * this branch).
   */
  async session(context: ActiveContext, request: object, registerId: string) {
    return withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
      const register = await this.inScope(tx, context, request, registerId);
      const shift = await repo.openShiftOn(tx, context.orgId, register.id);
      const header = await repo.receiptHeader(tx, context.orgId, register.branch_id);
      const brand = header?.brand ?? {};
      const now = new Date();
      return {
        register: registerView(register),
        openShift:
          shift === undefined
            ? null
            : {
                id: shift.id,
                shiftNo: shift.shift_no,
                openedBy: shift.opened_by,
                openedAt: shift.opened_at,
                mine: shift.opened_by === context.userId,
              },
        discountCeilingBps: discountCeilingBps(context, register.branch_id),
        discountCeilings: POS_DISCOUNT_CEILING_BPS,
        receiptHeader: {
          displayName: header?.display_name ?? '',
          legalName: stringOr(brand, 'legal_name') ?? header?.legal_name ?? '',
          branchName: header?.branch_name ?? register.branch_name,
          address: stringOr(brand, 'address') ?? header?.branch_address ?? null,
          phone: header?.branch_phone ?? null,
          vatNo: stringOr(brand, 'vat_no'),
          footer: stringOr(brand, 'invoice_footer'),
        },
        serverTime: now.toISOString(),
        businessDate: businessDate(now),
        userId: context.userId,
      };
    });
  }

  /** One page of the offline price list, with what the register's shelf holds. */
  async priceList(
    context: ActiveContext,
    request: object,
    registerId: string,
    page: { after?: string | undefined; limit: number },
  ) {
    return withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
      const register = await this.inScope(tx, context, request, registerId);
      const skus = await this.catalog.sellableSkus(tx, context.orgId, {
        afterCode: page.after ?? null,
        limit: page.limit,
      });
      const available = await this.stock.availability(
        tx,
        context.orgId,
        register.location_id,
        skus.map((sku) => sku.id),
      );
      return {
        items: skus.map((sku) => ({
          id: sku.id,
          code: sku.code,
          barcode: sku.barcode,
          name: sku.productName,
          pricePoisha: sku.pricePoisha.toString(),
          available: available.get(sku.id) ?? 0,
        })),
        next: skus.length === page.limit ? (skus.at(-1)?.code ?? null) : null,
      };
    });
  }

  /**
   * A promo code, asked online. While `PROMO_CODES` is `NoPromoCodes`, every answer is
   * no — see the port for why the default refuses, and D-209 for why M16 left it bound.
   */
  async checkPromo(
    context: ActiveContext,
    request: object,
    input: { registerId: string; code: string; basketPoisha: string },
  ) {
    return withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
      const register = await this.inScope(tx, context, request, input.registerId);
      const verdict = await this.promo.validate(tx, {
        orgId: context.orgId,
        branchId: register.branch_id,
        code: input.code,
        basketPoisha: BigInt(input.basketPoisha),
      });
      return verdict.valid
        ? {
            valid: true,
            discountPoisha: verdict.discountPoisha.toString(),
            promotionId: verdict.promotionId,
          }
        : { valid: false, reason: verdict.reason };
    });
  }

  private async inScope(
    tx: Tx,
    context: ActiveContext,
    request: object,
    id: string,
  ): Promise<repo.RegisterRow> {
    const register = await repo.registerById(tx, context.orgId, id);
    if (register === undefined) throw posHttpError('POS_REGISTER_NOT_FOUND', 'No such register.');
    try {
      assertInScope(request, { branchId: register.branch_id });
    } catch {
      // Another branch's till reads as a missing one: anything else is an oracle.
      throw posHttpError('POS_REGISTER_NOT_FOUND', 'No such register.');
    }
    return register;
  }

  /**
   * Each named wallet is a live wallet of this org (`WalletsApi`), and the cash one
   * is this branch's own. Migration 0070 checks the same thing against the tables;
   * this answers first, with a message a person can act on.
   */
  private async assertWallets(
    tx: Tx,
    orgId: string,
    branchId: string,
    wallets: {
      cashWalletId?: string | undefined;
      bkashWalletId?: string | null | undefined;
      cardWalletId?: string | null | undefined;
    },
  ): Promise<void> {
    const checks: [string | null | undefined, readonly string[], string][] = [
      [wallets.cashWalletId, ['wallet_cash'], 'cash'],
      [wallets.bkashWalletId, ['wallet_bkash', 'wallet_mfs_other'], 'bKash'],
      [wallets.cardWalletId, ['wallet_bank'], 'card'],
    ];
    for (const [walletId, subtypes, label] of checks) {
      if (walletId === undefined || walletId === null) continue;
      const account = await this.wallets.walletAccount(tx, orgId, walletId);
      const branchOk =
        label === 'cash'
          ? account?.branchId === branchId
          : account?.branchId == null || account.branchId === branchId;
      if (account === null || !subtypes.includes(account.subtype) || !branchOk) {
        throw posHttpError(
          'POS_REGISTER_INVALID',
          label === 'cash'
            ? 'The cash tender must be this branch’s own hand-cash wallet.'
            : `The ${label} tender must be an active ${label === 'card' ? 'bank' : 'mobile'} wallet of this org or branch.`,
        );
      }
    }
  }
}

function stringOr(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

/** A switched-off branch takes no new till and no till switched back on (M39a, D-633). */
async function assertBranchActive(tx: Tx, orgId: string, branchId: string): Promise<void> {
  if (!(await branchIsActive(tx, orgId, branchId))) {
    throw posHttpError('POS_REGISTER_INVALID', 'That branch is switched off.');
  }
}
