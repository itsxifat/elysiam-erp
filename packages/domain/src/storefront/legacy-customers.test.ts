import { describe, expect, it } from 'vitest';

import { legacyPhone, planLegacyCustomers } from './legacy-customers.js';

const HASH = `$2a$12$${'a'.repeat(53)}`;

describe('the old site’s customers (D-531)', () => {
  const rows = [
    {
      _id: { $oid: 'u1' },
      name: 'Rahim',
      email: 'Rahim@Example.com',
      password: HASH,
      role: 'customer',
      emailVerified: true,
      phone: '01711000001',
      createdAt: { $date: '2024-05-01T10:00:00Z' },
    },
    {
      _id: { $oid: 'u2' },
      name: 'Admin',
      email: 'boss@example.com',
      password: HASH,
      role: 'admin',
    },
    { _id: { $oid: 'u3' }, name: 'Guest', isGuest: true, phone: '+8801711000002' },
    { _id: { $oid: 'u4' }, name: 'Gina', email: 'gina@example.com', emailVerified: true },
    { _id: { $oid: 'u5' }, name: 'Dup', email: 'rahim@example.com', password: HASH },
    { _id: { $oid: 'u6' }, name: 'Nobody' },
    {
      _id: { $oid: 'u7' },
      name: 'Plain',
      email: 'plain@example.com',
      password: 'not-bcrypt',
      phone: '12345',
    },
    'not an object',
    { _id: 'u9', name: 'Known', email: 'known@example.com', password: HASH, phone: '01711000009' },
  ];

  it('imports customers and guests, skips staff, and reports the rest by row', () => {
    const plan = planLegacyCustomers(rows, {
      accountEmails: new Set(['known@example.com']),
      buyerPhones: new Set(['01711000009']),
    });
    expect(plan.accounts.map((account) => account.email)).toEqual([
      'rahim@example.com',
      'gina@example.com',
      'plain@example.com',
    ]);
    expect(plan.accounts[0]).toMatchObject({
      legacyId: 'u1',
      passwordHash: HASH,
      emailVerified: true,
      phone: '01711000001',
    });
    expect(plan.accounts[0]?.createdAt?.toISOString()).toBe('2024-05-01T10:00:00.000Z');
    expect(plan.accounts[1]?.passwordHash).toBeNull();
    expect(plan.accounts[2]?.passwordHash).toBeNull();
    expect(plan.buyers.map((buyer) => buyer.phone)).toEqual(['01711000001', '01711000002']);
    expect(plan.skipped).toEqual([
      { row: 2, reason: 'staff' },
      { row: 5, reason: 'duplicate_email' },
      { row: 6, reason: 'no_identity' },
      { row: 8, reason: 'not_an_object' },
      { row: 9, reason: 'already_imported' },
    ]);
    expect(plan.warnings).toEqual([
      { row: 7, reason: 'unusable_phone' },
      { row: 7, reason: 'unusable_password_hash' },
    ]);
    expect(plan.counts).toMatchObject({
      rows: 9,
      accounts: 3,
      googleOnly: 2,
      staff: 1,
      guests: 1,
      invalid: 2,
    });
    // The report says rows and reasons, never a name, an email or a phone.
    expect(JSON.stringify([plan.skipped, plan.warnings, plan.counts])).not.toMatch(/@|0171|Rahim/);
  });

  it('reads the old site’s phone forms', () => {
    expect(legacyPhone('+880 1711-000001')).toBe('01711000001');
    expect(legacyPhone('৮৮০১৭১১০০০০০১')).toBe('01711000001');
    expect(legacyPhone('0212345678')).toBeNull();
  });
});
