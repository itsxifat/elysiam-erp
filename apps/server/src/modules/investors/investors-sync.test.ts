import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { APPROVAL_TYPES, ERROR_CODES, SERVER_DERIVED_AMOUNT_TYPES } from '@elysium/contracts';
import { schema } from '@elysium/db';
import { describe, expect, it } from 'vitest';

/**
 * The investor lists that live in places which cannot import each other.
 *
 * Three of them, and each has a failure mode that is silent rather than loud:
 *
 * 1. **Error codes.** A code the database raises that is not in `ERROR_CODES`
 *    reaches a caller as a 500 and a constraint name, because
 *    `databaseInvestorsCode` only translates codes it can find in that list.
 * 2. **Approval types.** They exist in `@elysium/contracts` (which the service
 *    reads), in the Drizzle enum (which the CHECKs are generated from) and in
 *    migration 0058 (which the database actually runs). If any pair drifts, the
 *    service and the database disagree about which requests can exist, and the
 *    database is the one that is wrong silently.
 * 3. **The threshold exemption.** Both investor types must stay in
 *    `SERVER_DERIVED_AMOUNT_TYPES`: with a person-typed amount, that list is the
 *    only thing standing between an org admin's generous threshold and
 *    auto-approved payments out of investor capital (D-019, D-072).
 */

const INVESTOR_CODES = [
  'INVESTOR_NOT_FOUND',
  'INVESTOR_INACTIVE',
  'INVESTOR_IMMUTABLE',
  'INVESTOR_SPLIT_INVALID',
  'INVESTOR_POSITION_INSUFFICIENT',
  'INVESTOR_CAPITAL_LOCKED',
  'INVESTOR_WITHDRAWAL_FROZEN',
  'INVESTOR_DISTRIBUTION_FROZEN',
  'INVESTOR_DOCUMENT_INVALID',
] as const;

const INVESTOR_APPROVAL_TYPES = ['investor_distribution', 'investor_withdrawal'] as const;

describe('the investor lists agree across the packages', () => {
  it('knows every error code the module and migration 0060 raise', () => {
    for (const code of INVESTOR_CODES) expect(ERROR_CODES).toContain(code);
  });

  it('raises only codes that exist, from every trigger in 0060', async () => {
    const sql = await readFile(
      path.resolve(
        import.meta.dirname,
        '../../../../../packages/db/migrations/0060_investors_integrity.sql',
      ),
      'utf8',
    );
    const raised = [...sql.matchAll(/raise exception '([A-Z_]+):/g)].map((match) => match[1] ?? '');
    expect(raised.length).toBeGreaterThan(0);
    for (const code of new Set(raised)) expect(ERROR_CODES).toContain(code);
  });

  it('has both investor approval types in the contracts and in the database enum', () => {
    for (const type of INVESTOR_APPROVAL_TYPES) {
      expect(APPROVAL_TYPES).toContain(type);
      expect(schema.approvalType.enumValues).toContain(type);
    }
  });

  it('adds both to the enum in migration 0058, and uses neither as a literal there', async () => {
    const sql = await readFile(
      path.resolve(
        import.meta.dirname,
        '../../../../../packages/db/migrations/0058_investors_schema.sql',
      ),
      'utf8',
    );
    for (const type of INVESTOR_APPROVAL_TYPES) {
      expect(sql).toContain(`ADD VALUE IF NOT EXISTS '${type}'`);
      /*
       * Exactly one mention each. PostgreSQL refuses to *use* an enum value added
       * by `ALTER TYPE` earlier in the same transaction, and the migrator runs a
       * file in one — so a CHECK or an index predicate naming either type here
       * would fail on a fresh database and nowhere else.
       */
      expect(sql.split(`'${type}'`)).toHaveLength(2);
    }
  });

  it('keeps both outside any threshold’s reach', () => {
    for (const type of INVESTOR_APPROVAL_TYPES) {
      expect(SERVER_DERIVED_AMOUNT_TYPES).toContain(type);
    }
  });
});
