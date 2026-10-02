import { describe, expect, it } from 'vitest';

import type { Employee } from './api.js';
import { editFormFor, employeePatch } from './employee-patch.js';

const row: Employee = {
  id: 'emp-1',
  code: 'E-001',
  fullName: 'Rina Akter',
  designation: 'Cashier',
  department: null,
  branchId: 'branch-a',
  userId: null,
  joinDate: '2026-01-10',
  leaveDate: null,
  status: 'active',
  calendarId: null,
  payoutMethod: 'cash',
  payoutRefMasked: null,
  nationalIdMasked: null,
  phoneMasked: null,
};

describe('employeePatch', () => {
  it('sends nothing for an untouched form, and says so', () => {
    const result = employeePatch(row, editFormFor(row), true);
    expect(result.problem).toBe('nothingChanged');
    expect(result.patch).toEqual({});
  });

  it('sends only the fields that changed', () => {
    const form = { ...editFormFor(row), designation: 'Senior cashier', branchId: 'branch-b' };
    expect(employeePatch(row, form, false)).toEqual({
      patch: { designation: 'Senior cashier', branchId: 'branch-b' },
      problem: null,
    });
  });

  it('never sends a payroll field for an editor without update Payroll', () => {
    // A branch manager's edit that echoed the payout method would be refused for a field
    // they never touched (D-363), so nothing payroll-shaped leaves at all.
    const form = {
      ...editFormFor(row),
      fullName: 'Rina Akter Khan',
      payoutMethod: 'bkash' as const,
      payoutRef: '01712345678',
      userId: 'usr_1',
    };
    expect(employeePatch(row, form, false)).toEqual({
      patch: { fullName: 'Rina Akter Khan' },
      problem: null,
    });
  });

  it('lets any editor set the phone and national ID, as the add form does', () => {
    // The server stores both encrypted for anyone who may edit the record; only payout
    // details and the linked sign-in are payroll's (D-363).
    const form = { ...editFormFor(row), phone: '01800000000', nationalId: '1990123456789' };
    expect(employeePatch(row, form, false)).toEqual({
      patch: { nationalId: '1990123456789', phone: '01800000000' },
      problem: null,
    });
  });

  it('treats empty personal fields as unchanged and empty text as cleared', () => {
    const form = { ...editFormFor(row), designation: '  ', nationalId: '', phone: '' };
    expect(employeePatch(row, form, true)).toEqual({
      patch: { designation: null },
      problem: null,
    });
  });

  it('asks for an account number when payout moves off cash with none on file', () => {
    const form = { ...editFormFor(row), payoutMethod: 'bank' as const };
    expect(employeePatch(row, form, true).problem).toBe('payoutRefRequired');
    const withRef = { ...form, payoutRef: '1234567890' };
    expect(employeePatch(row, withRef, true)).toEqual({
      patch: { payoutMethod: 'bank', payoutRef: '1234567890' },
      problem: null,
    });
  });

  it('links and unlinks a sign-in', () => {
    const linked = employeePatch(row, { ...editFormFor(row), userId: 'usr_9' }, true);
    expect(linked.patch).toEqual({ userId: 'usr_9' });
    const withLink = { ...row, userId: 'usr_9' };
    const unlinked = employeePatch(withLink, { ...editFormFor(withLink), userId: '' }, true);
    expect(unlinked.patch).toEqual({ userId: null });
  });

  it('refuses an empty name', () => {
    expect(employeePatch(row, { ...editFormFor(row), fullName: ' ' }, true).problem).toBe(
      'nameRequired',
    );
  });
});
