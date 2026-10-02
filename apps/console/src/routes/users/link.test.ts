import { MEMBERSHIP_ROLES } from '@elysium/contracts';
import { describe, expect, it } from 'vitest';

import { passwordLinkPage, tokenFromHash } from '../../auth/password-link.js';
import { orderedRoles, passwordLinkUrl, rolesToSubmit } from './link.js';

describe('the staff screen helpers', () => {
  it('puts the token in the fragment, never the query string', () => {
    const link = passwordLinkUrl('https://erp.example.com', 'invite', 'abc+/=');
    expect(link).toBe('https://erp.example.com/accept-invite#token=abc%2B%2F%3D');
    expect(new URL(link).search).toBe('');
    expect(passwordLinkUrl('https://x', 'password', 't')).toBe('https://x/reset-password#token=t');
  });

  it('reads back exactly the token it wrote', () => {
    const link = new URL(passwordLinkUrl('https://x', 'password', 'abc+/= x'));
    expect(passwordLinkPage(link.pathname)).toBe('reset');
    expect(tokenFromHash(link.hash)).toBe('abc+/= x');
    expect(passwordLinkPage('/accept-invite/')).toBe('invite');
    expect(passwordLinkPage('/orders')).toBeNull();
    expect(tokenFromHash('')).toBeNull();
    expect(tokenFromHash('#token=')).toBeNull();
  });

  it('lists every role exactly once', () => {
    expect([...orderedRoles()].sort()).toEqual([...MEMBERSHIP_ROLES].sort());
  });

  it('refuses no roles, and a branch manager with no branch', () => {
    expect(rolesToSubmit(new Map()).problem).toBe('none');
    expect(rolesToSubmit(new Map([['branch_manager', []]])).problem).toBe('branch');
    expect(
      rolesToSubmit(
        new Map([
          ['sales', []],
          ['branch_manager', ['b1']],
        ]),
      ),
    ).toEqual({
      roles: [
        { role: 'branch_manager', branchIds: ['b1'] },
        { role: 'sales', branchIds: [] },
      ],
      problem: null,
    });
  });
});
