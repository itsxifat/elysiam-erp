import { describe, expect, it } from 'vitest';

import { managersFor } from './stuck.service.js';

/**
 * Who hears that a parcel never reached its courier (D-903): the org admins by their role's room,
 * and the branch managers whose stuck queue will show the parcel (§6's branch scope), by name.
 */
describe('the branch managers a not-received alert reaches', () => {
  const managers = [
    { userId: 'usr_dhaka', branchIds: ['br-dhaka'] },
    { userId: 'usr_ctg', branchIds: ['br-ctg'] },
    { userId: 'usr_both', branchIds: ['br-dhaka', 'br-ctg'] },
    { userId: 'usr_brand', branchIds: [] },
  ];

  it('the managers of the parcel’s branch and the brand-wide ones, and no other', () => {
    expect(managersFor(managers, 'br-dhaka').sort()).toEqual([
      'usr_both',
      'usr_brand',
      'usr_dhaka',
    ]);
    expect(managersFor(managers, 'br-ctg').sort()).toEqual(['usr_both', 'usr_brand', 'usr_ctg']);
  });

  it('only the brand-wide ones for a parcel of no branch', () => {
    expect(managersFor(managers, null)).toEqual(['usr_brand']);
  });

  it('each person once, however many of their roles reach the branch', () => {
    expect(
      managersFor(
        [
          { userId: 'usr_twice', branchIds: ['br-dhaka'] },
          { userId: 'usr_twice', branchIds: [] },
        ],
        'br-dhaka',
      ),
    ).toEqual(['usr_twice']);
  });
});
