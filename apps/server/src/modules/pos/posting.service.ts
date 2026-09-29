import { HttpException, Inject, Injectable } from '@nestjs/common';
import type { Tx } from '@elysium/db';
import {
  businessDate,
  LedgerError,
  poisha,
  withinPostingWindow,
  type AccountSubtype,
  type PostingAccount,
} from '@elysium/domain';
import {
  PosError,
  postingDateFor,
  qtyBySku,
  refundFor,
  type HoldReason,
  type Tender,
} from '@elysium/domain/pos';
import { posReturnDraft, posSaleDraft, type PosTenderLine } from '@elysium/domain/posting/pos';

import { LEDGER_API, type LedgerApi } from '../ledger/ledger.api.js';
import { WALLETS_API, type WalletsApi } from '../wallets/wallets.api.js';
import { isStockShortfall, POS_STOCK, type PosStockPort } from './ports/pos-stock.port.js';
import * as repo from './pos.repository.js';

/**
 * Turning a held till document into stock movements and one journal (§7, §8, §14).
 *
 * Every sale and return arrives as `held` and is posted from here — by the sync
 * that delivered it when nothing stands in the way, or later by the manager who
 * resolves its review item. One path, so a sale posted at 11:02 by the till and a
 * sale posted at 17:40 by a manager produce the same movements and the same
 * journal shape, keyed the same way.
 *
 * ## The savepoint
 *
 * The attempt runs inside `tx.transaction(...)`, which Drizzle issues as a
 * SAVEPOINT. A shortfall is discovered by the database refusing the level update
 * (invariant 3: never negative, never into reserved units), and PostgreSQL aborts
 * the transaction on any refused statement. Without the savepoint that abort would
 * take the sale row with it and the till's sale would vanish — exactly the
 * "silently dropped" §14 forbids. With it, only the attempt rolls back; the held
 * sale stays, and the caller records why.
 *
 * ## What is and is not trusted from the till
 *
 * Quantities, prices and tenders are the receipt, so they are the till's. The cost
 * is never the till's: it is what each movement recorded, read back from the
 * movement under inventory's own lock. The journal's key is derived from the
 * till's sale id, so a document posted twice reaches the ledger with one key.
 */

export type PostOutcome =
  | {
      readonly kind: 'posted';
      readonly journalId: string | null;
      readonly postedOn: string;
      readonly cogsPoisha: bigint;
    }
  | {
      readonly kind: 'held';
      readonly reasons: readonly HoldReason[];
      readonly detail: Record<string, unknown>;
    };

interface Actor {
  readonly orgId: string;
  readonly userId: string;
}

@Injectable()
export class PosPostingService {
  constructor(
    @Inject(LEDGER_API) private readonly ledger: LedgerApi,
    @Inject(WALLETS_API) private readonly wallets: WalletsApi,
    @Inject(POS_STOCK) private readonly stock: PosStockPort,
  ) {}

  async postSale(tx: Tx, actor: Actor, sale: repo.SaleRow, now: Date): Promise<PostOutcome> {
    const lines = await repo.saleLines(tx, actor.orgId, sale.id);
    const tenders = await repo.saleTenders(tx, actor.orgId, sale.id);
    const postedOn = postingDateFor(sale.occurred_at, now);
    // The instant the movements carry, so a late sale's stock leaves on the day its
    // journal says it did rather than on a day whose count is already closed.
    const movedAt = withinPostingWindow(sale.occurred_at, now) ? sale.occurred_at : now;
    const netPoisha = poisha(sale.net_poisha);

    try {
      return await tx.transaction(async (savepoint) => {
        const moved = await this.stock.sellAtPos(savepoint, actor, {
          saleId: sale.id,
          locationId: sale.location_id,
          occurredAt: movedAt,
          lines: [...qtyBySku(lines.map((line) => ({ skuId: line.sku_id, qty: line.qty })))].map(
            ([skuId, qty]) => ({ skuId, qty }),
          ),
        });
        const costBySku = new Map(moved.lines.map((line) => [line.skuId, line.unitCostPoisha]));

        let cogs = 0n;
        for (const line of lines) {
          const unitCost = costBySku.get(line.sku_id);
          if (unitCost === undefined) {
            throw new Error(`the stock port returned no cost for SKU ${line.sku_id}`);
          }
          cogs += unitCost * BigInt(line.qty);
          await repo.setSaleLineCost(savepoint, actor.orgId, sale.id, line.line_no, unitCost);
        }

        let journalId: string | null = null;
        if (netPoisha > 0n || cogs > 0n) {
          const [revenue, cogsAccount, inventory] = await Promise.all([
            this.account(savepoint, actor.orgId, 'sales_revenue'),
            this.account(savepoint, actor.orgId, 'cogs'),
            this.account(savepoint, actor.orgId, 'inventory'),
          ]);
          const posted = await this.ledger.post(
            savepoint,
            actor,
            posSaleDraft({
              saleId: sale.id,
              businessDate: postedOn,
              tenders: await this.tenderAccounts(savepoint, actor.orgId, tenders),
              salesRevenue: revenue,
              cogs: cogsAccount,
              inventory,
              netPoisha,
              costPoisha: poisha(cogs),
              branchId: sale.branch_id,
              memo: memoFor('POS sale', sale.receipt_no, sale.business_date, postedOn),
            }),
          );
          journalId = posted.journalId;
        }

        await repo.markPosted(savepoint, 'sales', actor.orgId, sale.id, {
          postedOn,
          cogsPoisha: cogs,
          journalId,
        });
        return { kind: 'posted', journalId, postedOn, cogsPoisha: cogs } as const;
      });
    } catch (error) {
      if (isStockShortfall(error)) {
        return this.shortfall(tx, actor.orgId, sale.location_id, lines);
      }
      if (isPeriodClosed(error)) {
        return { kind: 'held', reasons: ['outside_posting_window'], detail: { postedOn } };
      }
      throw error;
    }
  }

  async postReturn(tx: Tx, actor: Actor, ret: repo.ReturnRow, now: Date): Promise<PostOutcome> {
    /*
     * The sale row is locked first. Two returns of the same receipt at two tills
     * would otherwise each read "one unit still returnable" and each refund it; the
     * lock makes the second wait and then see the first.
     */
    const sale = await repo.saleById(tx, actor.orgId, ret.sale_id, true);
    if (sale?.status !== 'posted') {
      return {
        kind: 'held',
        reasons: sale?.status === 'voided' ? ['return_mismatch'] : ['sale_not_posted'],
        detail: { saleStatus: sale?.status ?? null },
      };
    }

    const saleLines = new Map(
      (await repo.saleLines(tx, actor.orgId, sale.id)).map((line) => [line.line_no, line]),
    );
    const already = await repo.returnedQty(tx, actor.orgId, sale.id, ret.id);
    const lines = await repo.returnLines(tx, actor.orgId, ret.id);

    const costed: { lineNo: number; skuId: string; qty: number; unitCostPoisha: bigint }[] = [];
    for (const line of lines) {
      const sold = saleLines.get(line.sale_line_no);
      const verdict = sold === undefined ? null : this.checkReturnLine(sold, line, already);
      if (sold === undefined || verdict !== null || sold.unit_cost_poisha === null) {
        return {
          kind: 'held',
          reasons: ['return_mismatch'],
          detail: { lineNo: line.line_no, saleLineNo: line.sale_line_no, why: verdict ?? 'no such line' },
        };
      }
      already.set(line.sale_line_no, (already.get(line.sale_line_no) ?? 0) + line.qty);
      costed.push({
        lineNo: line.line_no,
        skuId: line.sku_id,
        qty: line.qty,
        unitCostPoisha: BigInt(sold.unit_cost_poisha),
      });
    }

    const postedOn = postingDateFor(ret.occurred_at, now);
    const movedAt = withinPostingWindow(ret.occurred_at, now) ? ret.occurred_at : now;
    const refund = poisha(ret.refund_poisha);
    const tenders = await repo.returnTenders(tx, actor.orgId, ret.id);

    try {
      return await tx.transaction(async (savepoint) => {
        await this.stock.receivePosReturn(savepoint, actor, {
          returnId: ret.id,
          locationId: ret.location_id,
          occurredAt: movedAt,
          lines: costed.map((line) => ({ ...line, unitCostPoisha: poisha(line.unitCostPoisha) })),
        });
        let cogs = 0n;
        for (const line of costed) {
          cogs += line.unitCostPoisha * BigInt(line.qty);
          await repo.setReturnLineCost(savepoint, actor.orgId, ret.id, line.lineNo, line.unitCostPoisha);
        }

        let journalId: string | null = null;
        if (refund > 0n || cogs > 0n) {
          const [revenue, cogsAccount, inventory] = await Promise.all([
            this.account(savepoint, actor.orgId, 'sales_revenue'),
            this.account(savepoint, actor.orgId, 'cogs'),
            this.account(savepoint, actor.orgId, 'inventory'),
          ]);
          const posted = await this.ledger.post(
            savepoint,
            actor,
            posReturnDraft({
              returnId: ret.id,
              businessDate: postedOn,
              refunds: await this.tenderAccounts(savepoint, actor.orgId, tenders),
              salesRevenue: revenue,
              cogs: cogsAccount,
              inventory,
              refundPoisha: refund,
              costPoisha: poisha(cogs),
              branchId: ret.branch_id,
              memo: memoFor('POS return', ret.receipt_no, ret.business_date, postedOn),
            }),
          );
          journalId = posted.journalId;
        }
        await repo.markPosted(savepoint, 'returns', actor.orgId, ret.id, {
          postedOn,
          cogsPoisha: cogs,
          journalId,
        });
        return { kind: 'posted', journalId, postedOn, cogsPoisha: cogs } as const;
      });
    } catch (error) {
      if (isPeriodClosed(error)) {
        return { kind: 'held', reasons: ['outside_posting_window'], detail: { postedOn } };
      }
      throw error;
    }
  }

  /** Why a return line cannot post as it stands, or null when it can. */
  private checkReturnLine(
    sold: repo.SaleLineRow,
    line: repo.ReturnLineRow,
    already: ReadonlyMap<number, number>,
  ): string | null {
    if (sold.sku_id !== line.sku_id) return 'sku differs from the receipt';
    try {
      const refund = refundFor(
        {
          qty: sold.qty,
          netPoisha: poisha(sold.net_poisha),
          returnedQty: already.get(line.sale_line_no) ?? 0,
        },
        line.qty,
      );
      return refund === BigInt(line.refund_poisha) ? null : 'refund differs from the receipt';
    } catch (error) {
      if (error instanceof PosError) return 'more units than the receipt still allows';
      throw error;
    }
  }

  private async shortfall(
    tx: Tx,
    orgId: string,
    locationId: string,
    lines: readonly repo.SaleLineRow[],
  ): Promise<PostOutcome> {
    const wanted = qtyBySku(lines.map((line) => ({ skuId: line.sku_id, qty: line.qty })));
    const available = await this.stock.availability(tx, orgId, locationId, [...wanted.keys()]);
    return {
      kind: 'held',
      reasons: ['stock_shortfall'],
      detail: {
        // Quantities only: the review screen needs what was wanted and what the shelf
        // held, and nothing here is cost (invariant 5).
        short: [...wanted]
          .map(([skuId, qty]) => ({ skuId, wanted: qty, available: available.get(skuId) ?? 0 }))
          .filter((line) => line.available < line.wanted),
        checkedAt: businessDate(new Date()),
      },
    };
  }

  private async tenderAccounts(
    tx: Tx,
    orgId: string,
    tenders: readonly repo.TenderRow[],
  ): Promise<PosTenderLine[]> {
    const lines: PosTenderLine[] = [];
    for (const tender of tenders) {
      const account = await this.wallets.walletAccount(tx, orgId, tender.wallet_id);
      if (account === null) {
        throw new PosError(
          'POS_REGISTER_INVALID',
          `The register's ${tender.tender satisfies Tender} wallet is missing or deactivated.`,
        );
      }
      lines.push({ account, amountPoisha: poisha(tender.amount_poisha) });
    }
    return lines;
  }

  private async account(tx: Tx, orgId: string, subtype: AccountSubtype): Promise<PostingAccount> {
    const account = await this.ledger.accountBySubtype(tx, orgId, subtype);
    if (account === null) {
      // Seeded by the chart-of-accounts template (D-084). Missing means the chart is
      // broken, and saying so beats posting the value somewhere else.
      throw new PosError('POS_REGISTER_INVALID', `This organization has no ${subtype} account.`);
    }
    return account;
  }
}

function memoFor(what: string, receiptNo: string, soldOn: string, postedOn: string): string {
  return soldOn === postedOn ? `${what} ${receiptNo}` : `${what} ${receiptNo}, sold ${soldOn}`;
}

/** The ledger refused a date inside a closed month, from either layer (D-093). */
export function isPeriodClosed(error: unknown): boolean {
  for (let current: unknown = error; current instanceof Error; current = current.cause) {
    if (current instanceof LedgerError && current.code === 'PERIOD_CLOSED') return true;
    if ((current as { code?: unknown }).code === 'PERIOD_CLOSED') return true;
    // `LedgerService` answers with an HTTP error whose body carries the code.
    if (current instanceof HttpException) {
      const body = current.getResponse();
      if (typeof body === 'object' && (body as { code?: unknown }).code === 'PERIOD_CLOSED') {
        return true;
      }
    }
    if (current.message.startsWith('PERIOD_CLOSED:')) return true;
  }
  return false;
}
