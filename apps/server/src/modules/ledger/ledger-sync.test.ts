import { ERROR_CODES } from '@elysium/contracts';
import { COA_TEMPLATE, schema } from '@elysium/db';
import {
  ACCOUNT_CLASSES,
  ACCOUNT_SUBTYPE_NAMES,
  ACCOUNT_SUBTYPES,
  isAccountSubtype,
  PARTY_TYPES,
} from '@elysium/domain';
import { describe, expect, it } from 'vitest';

/**
 * The ledger's lists live in three packages that cannot import each other —
 * the database enums, the chart-of-accounts template, and the domain's
 * subtype table — so this test is what keeps them one list (D-084).
 */

describe('the database, the template and the domain agree', () => {
  it('has the same account classes, subtypes and party types in the enums as in the domain', () => {
    expect([...schema.accountClass.enumValues]).toEqual([...ACCOUNT_CLASSES]);
    expect([...schema.accountSubtype.enumValues]).toEqual([...ACCOUNT_SUBTYPE_NAMES]);
    expect([...schema.partyType.enumValues]).toEqual([...PARTY_TYPES]);
  });

  it('seeds every template account with the class, normal balance and party its subtype implies', () => {
    const wrong: string[] = [];
    for (const account of COA_TEMPLATE) {
      if (!isAccountSubtype(account.subtype)) {
        wrong.push(`${account.code}: unknown subtype ${account.subtype}`);
        continue;
      }
      const info = ACCOUNT_SUBTYPES[account.subtype];
      if (info.class !== account.class) wrong.push(`${account.code}: class ${account.class}`);
      if (info.normalBalance !== account.normalBalance) {
        wrong.push(`${account.code}: normal balance ${account.normalBalance}`);
      }
      if (info.party !== account.party)
        wrong.push(`${account.code}: party ${String(account.party)}`);
    }
    expect(wrong).toEqual([]);
  });

  it('has a unique code per template account, and every §7 subtype but the optional ones seeded', () => {
    const codes = COA_TEMPLATE.map((account) => account.code);
    expect(new Set(codes).size).toBe(codes.length);

    const seeded = new Set(COA_TEMPLATE.map((account) => account.subtype));
    const missing = ACCOUNT_SUBTYPE_NAMES.filter((name) => !seeded.has(name));
    // Hand cash is seeded per branch, and `wallet_mfs_other` is optional (§7).
    expect(missing.sort()).toEqual(['wallet_cash', 'wallet_mfs_other']);
  });

  it('knows every ledger error code the database can raise', () => {
    for (const code of [
      'PERIOD_CLOSED',
      'PERIOD_REOPEN_UNAUTHORISED',
      'JOURNAL_UNBALANCED',
      'JOURNAL_TOO_FEW_LINES',
      'JOURNAL_LINE_INVALID',
      'LEDGER_ACCOUNT_INVALID',
      'LEDGER_IMMUTABLE',
    ]) {
      expect(ERROR_CODES).toContain(code);
    }
  });
});
