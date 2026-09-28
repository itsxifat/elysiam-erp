import { Injectable } from '@nestjs/common';
import { canReadCost } from '@elysium/contracts';
import { withOrg } from '@elysium/db';

import type { ActiveContext } from '../../platform/http/context.js';
import * as repo from './supply.repository.js';
import { foldBalances } from './suppliers.service.js';
import { mapSupplyErrors, SupplyError } from './supply.errors.js';
import type { StatementQuery } from './supply.schemas.js';

/**
 * The supplier statement (M09 Build list; check 2).
 *
 * Every line in it is a `ledger.journal_lines` row for the supplier party on one of the
 * two supplier accounts. Nothing is summed from `supply.*`: not the opening balance, not
 * the running balance, not the closing figure. That is the entire reason check 2 can be
 * a real check — the statement and `GET /v1/ledger/party-balances` are computed by
 * different code in different modules over the same rows, and the test asserts they
 * agree to the poisha. A statement built from supply entries and payments instead would
 * agree with the ledger only until the first journal posted by a path this module does
 * not know about, and then disagree silently.
 *
 * Two closing balances rather than one net figure, because they are different facts:
 * what is owed (`supplier_payable`, a liability, so credits are what is owed) and what
 * is held unspent (`supplier_advance`, an asset, so debits are what is held). Netting
 * them would hide an advance sitting with a supplier the brand also owes money to —
 * which is exactly the position that needs watching.
 *
 * A caller without `read:cost` gets no statement at all, not a redacted one. §6 names
 * supplier balances as protected fields and every line of this document is one; D-085
 * made the same call for the ledger's own party statements.
 */

const MAX_LINES = 2_000;

@Injectable()
export class StatementsService {
  async statement(context: ActiveContext, supplierId: string, query: StatementQuery) {
    if (!canReadCost(context.roles, context.isSuperAdmin)) {
      throw new SupplyError(
        'FORBIDDEN',
        'A supplier statement is a balance the brand owes, which §6 protects like cost.',
      );
    }

    return mapSupplyErrors(async () =>
      withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
        const supplier = await repo.supplierById(tx, context.orgId, supplierId);
        if (supplier === undefined) {
          throw new SupplyError('SUPPLY_NOT_FOUND', 'No such supplier.');
        }

        const [openingRows, lines, closingRows] = await Promise.all([
          repo.statementOpening(tx, context.orgId, supplierId, query.from),
          repo.statementLines(
            tx,
            context.orgId,
            supplierId,
            { from: query.from, to: query.to },
            MAX_LINES + 1,
          ),
          repo.supplierBalances(tx, context.orgId, { asOf: query.to, supplierId }),
        ]);

        const opening = foldBalances(openingRows).get(supplierId) ?? {
          duePoisha: '0',
          advancePoisha: '0',
        };
        const closing = foldBalances(closingRows).get(supplierId) ?? {
          duePoisha: '0',
          advancePoisha: '0',
        };

        const truncated = lines.length > MAX_LINES;
        const shown = lines.slice(0, MAX_LINES);

        let due = BigInt(opening.duePoisha);
        let advance = BigInt(opening.advancePoisha);
        let debits = 0n;
        let credits = 0n;

        const items = shown.map((line) => {
          const debit = BigInt(line.debit_poisha);
          const credit = BigInt(line.credit_poisha);
          debits += debit;
          credits += credit;
          // Each account's normal side. Getting one backwards produces a statement that
          // runs the right way for payments and the wrong way for receipts, which reads
          // as plausible and is not.
          if (line.subtype === 'supplier_payable') due += credit - debit;
          else advance += debit - credit;

          return {
            journalId: line.journal_id,
            lineNo: line.line_no,
            businessDate: line.business_date,
            sourceType: line.source_type,
            account: line.subtype,
            memo: line.memo,
            debitPoisha: line.debit_poisha,
            creditPoisha: line.credit_poisha,
            runningDuePoisha: due.toString(),
            runningAdvancePoisha: advance.toString(),
          };
        });

        return {
          supplier: { id: supplier.id, code: supplier.code, name: supplier.name },
          from: query.from ?? null,
          to: query.to,
          openingDuePoisha: opening.duePoisha,
          openingAdvancePoisha: opening.advancePoisha,
          totalDebitPoisha: debits.toString(),
          totalCreditPoisha: credits.toString(),
          /*
           * The closing balances come from the same grouped query the ledger's party
           * balances use, **not** from the running totals above.
           *
           * The running total is what a person reads down the page; this is what the
           * books say. They are equal whenever the range covers everything, and the
           * moment they are not — a truncated range, a journal dated inside the range
           * but posted against an account this statement does not show — the honest
           * closing figure is the ledger's.
           */
          closingDuePoisha: closing.duePoisha,
          closingAdvancePoisha: closing.advancePoisha,
          truncated,
          items,
        };
      }),
    );
  }
}
