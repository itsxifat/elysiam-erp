import {
  CUSTOMER_PHONE_KINDS,
  CUSTOMER_PHONE_RELATIONS,
  CUSTOMER_PHONE_RETIRE_REASONS,
  CUSTOMER_PHONE_SOURCES,
} from '@elysium/contracts/customers';
import { PHONE_KINDS, PHONE_RELATIONS, PHONE_RETIRE_REASONS, PHONE_SOURCES } from '@elysium/domain';
import { describe, expect, it } from 'vitest';

/** M48: the contract's closed lists are the domain's (the two packages cannot import each other). */
describe('customer number lists', () => {
  it('match between the contracts and the domain', () => {
    expect([...CUSTOMER_PHONE_KINDS]).toEqual([...PHONE_KINDS]);
    expect([...CUSTOMER_PHONE_RELATIONS]).toEqual([...PHONE_RELATIONS]);
    expect([...CUSTOMER_PHONE_SOURCES]).toEqual([...PHONE_SOURCES]);
    expect([...CUSTOMER_PHONE_RETIRE_REASONS]).toEqual([...PHONE_RETIRE_REASONS]);
  });
});
