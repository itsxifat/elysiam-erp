import { describe, expect, it } from 'vitest';

import type { AvailableOrg, InvestorRow, StatementEntry, WithdrawalStatus } from './api.js';
import { portalCatalogue } from './messages.js';
import {
  brandToOpen,
  distributionsOf,
  investorOrgs,
  ownInvestor,
  readableDate,
  WITHDRAWAL_STATUS_LABEL,
  WITHDRAWAL_STATUS_TONE,
} from './model.js';

/**
 * The investor portal's pure decisions (M25).
 *
 * Which rows an investor may see is the server's decision, proven over HTTP in
 * `investors.e2e.test.ts` and in a browser by `e2e/investor.stack.ts` (check 1). These are
 * the client's own: which brand opens, which row is "mine" for a person who is also staff,
 * where the distributions come from, how a date reads, and a catalogue with nothing missing
 * on either side.
 */

const org = (orgId: string, roles: string[]): AvailableOrg => ({
  orgId,
  slug: orgId,
  displayName: orgId,
  roles,
});

describe('the brands an investor may open', () => {
  const orgs = [
    org('elysium', ['accounts']),
    org('oura', ['investor']),
    org('orvo', ['sales', 'investor']),
  ];

  it('are the brands where the sign-in holds the investor role', () => {
    expect(investorOrgs(orgs).map((entry) => entry.orgId)).toEqual(['oura', 'orvo']);
    expect(investorOrgs([org('elysium', ['org_admin'])])).toEqual([]);
  });

  it('keeps the active brand when it is an investor brand', () => {
    expect(brandToOpen(investorOrgs(orgs), 'orvo')).toBeNull();
  });

  it('moves off a brand where the person is only staff, or out of no brand at all', () => {
    expect(brandToOpen(investorOrgs(orgs), 'elysium')).toBe('oura');
    expect(brandToOpen(investorOrgs(orgs), null)).toBe('oura');
    expect(brandToOpen([], null)).toBeNull();
  });
});

describe('the caller’s own investor row', () => {
  const row = (id: string, userId: string | null): InvestorRow => ({
    id,
    code: id.toUpperCase(),
    name: id,
    userId,
    status: 'active',
    joinedOn: '2025-01-01',
    position: {
      contributedPoisha: '0',
      capitalWithdrawnPoisha: '0',
      capitalPoisha: '0',
      lockedPoisha: '0',
      withdrawableCapitalPoisha: '0',
      declaredPoisha: '0',
      profitPaidPoisha: '0',
      payablePoisha: '0',
    },
  });

  it('is the row linked to the signed-in user, not the first row of the list', () => {
    // An accounts user who is also an investor in the same brand reads every row.
    const rows = [row('inv-a', 'usr_a'), row('inv-b', 'usr_b'), row('inv-c', null)];
    expect(ownInvestor(rows, 'usr_b')?.id).toBe('inv-b');
  });

  it('is nothing when no row is linked to them', () => {
    expect(ownInvestor([row('inv-a', 'usr_a')], 'usr_x')).toBeNull();
    expect(ownInvestor([], 'usr_x')).toBeNull();
  });
});

describe('distributions', () => {
  it('are the declared-profit entries of the investor’s own statement', () => {
    const entries: StatementEntry[] = [
      { date: '2026-08-02', kind: 'contribution', amountPoisha: '100000000', reference: 'c1' },
      { date: '2026-09-01', kind: 'distribution', amountPoisha: '3000000', reference: 'd1' },
      { date: '2026-09-05', kind: 'profit_paid', amountPoisha: '1000000', reference: 'w1' },
      { date: '2026-10-01', kind: 'distribution', amountPoisha: '2000000', reference: 'd2' },
    ];
    expect(distributionsOf(entries).map((entry) => entry.reference)).toEqual(['d1', 'd2']);
    expect(distributionsOf([])).toEqual([]);
  });
});

describe('dates', () => {
  it('reads a business date in either language', () => {
    expect(readableDate('2026-09-17', 'en')).toBe('17 Sep 2026');
    expect(readableDate('2026-09-17', 'bn')).toMatch(/^১৭ /);
  });

  it('reads a timestamp as its Asia/Dhaka calendar day (invariant 8)', () => {
    // 20:00 UTC on 30 September is 02:00 on 1 October in Dhaka.
    expect(readableDate('2026-09-30T20:00:00.000Z', 'en')).toBe('1 Oct 2026');
    expect(readableDate('2026-09-30 20:00:00+00', 'en')).toBe('1 Oct 2026');
  });

  it('shows what it cannot read as it came, rather than failing the page', () => {
    expect(readableDate('soon', 'en')).toBe('soon');
  });
});

describe('withdrawal statuses', () => {
  const statuses: WithdrawalStatus[] = ['requested', 'reviewed', 'approved', 'paid', 'rejected'];

  it('each have a word and a tone, and paid is the only success', () => {
    for (const status of statuses) {
      expect(WITHDRAWAL_STATUS_LABEL[status]).toMatch(/^investors\.status/);
      expect(WITHDRAWAL_STATUS_TONE[status]).toBeDefined();
    }
    expect(statuses.filter((status) => WITHDRAWAL_STATUS_TONE[status] === 'success')).toEqual([
      'paid',
    ]);
  });
});

describe('the catalogue', () => {
  const en = portalCatalogue('en');
  const bn = portalCatalogue('bn');

  it('has every key in both languages', () => {
    expect(Object.keys(bn)).toEqual(Object.keys(en));
    for (const [key, value] of Object.entries({ ...en, ...bn })) {
      expect(value.trim(), key).not.toBe('');
    }
  });

  it('has a Bangla sentence, not an English one, for every portal string', () => {
    for (const key of Object.keys(en) as (keyof typeof en)[]) {
      if (!key.startsWith('portal.')) continue;
      expect(bn[key], key).not.toBe(en[key]);
    }
  });
});
