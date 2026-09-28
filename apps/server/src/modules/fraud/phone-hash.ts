import { createHmac, timingSafeEqual } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';
import { normalizeBdPhone } from '@elysium/domain';

import { FRAUD_CONFIG, type FraudConfig } from './fraud.config.js';

/**
 * The phone HMAC (architecture §10, invariant 10).
 *
 * `phone_hash = HMAC-SHA256(server_secret, e164)`. One function, one place, and the
 * reasons for each part:
 *
 * * **HMAC, not a digest.** A bare SHA-256 of a Bangladeshi mobile is reversible in
 *   practice. Every one is `01`, an operator digit and eight more digits — under a
 *   billion candidates, which a laptop enumerates in minutes. A rainbow table of the
 *   whole national number space fits on a phone. The key is the only thing that makes
 *   a leaked copy of `fraud.phone_signals` useless, and that table is readable by
 *   every org by design, which raises the stakes rather than lowering them.
 * * **Normalised first.** The hash is an identity, so `01712345678` and
 *   `+8801712345678` must produce the same one. They do not, as strings — so
 *   `normalizeBdPhone` runs first, and a number it refuses never reaches the digest.
 *   Skipping that step is the bug that splits one buyer's history across four rows,
 *   each of which looks plausible and none of which can be traced back, because the
 *   input cannot be recovered from a hash.
 * * **Lowercase hex, 64 characters.** Matched by a check constraint in migration
 *   0045, so a truncated or upper-cased hash is refused by the database rather than
 *   quietly becoming a second person.
 *
 * Nothing here logs. Not the number, not the hash, not the key. §25 masks phone
 * numbers in logs; a hash is not a phone number but it is a stable identifier for one
 * person across five brands, which is the thing a log aggregator should not hold. The
 * service raises no log lines at all, so there is nothing to forget to mask.
 */
@Injectable()
export class PhoneHashService {
  private readonly key: Buffer;

  constructor(@Inject(FRAUD_CONFIG) config: FraudConfig) {
    // Held as a Buffer rather than the string, so the secret is not sitting in the
    // string-interning table where a heap dump lists it beside its neighbours.
    this.key = Buffer.from(config.FRAUD_PHONE_HASH_KEY, 'utf8');
  }

  /**
   * Hash a phone number in any of the spellings `normalizeBdPhone` accepts.
   *
   * Throws `ORDER_PHONE_INVALID` (through the domain) for anything that is not a
   * Bangladeshi mobile. Deliberately: a landline or a typo hashed anyway would create
   * a signals row for a number no courier will ever deliver to, and it would sit
   * there forever accumulating nothing.
   */
  hash(phone: string): string {
    const e164 = normalizeBdPhone(phone);
    return createHmac('sha256', this.key).update(e164, 'utf8').digest('hex');
  }

  /**
   * Whether a hash is one this key would produce for that number.
   *
   * Compared in constant time. The comparison is not secret, but the habit is cheap
   * and this is the one place in the module where a timing side channel could tell an
   * attacker with write access to some other table whether a guessed number matches a
   * stored row.
   */
  matches(phone: string, candidate: string): boolean {
    const expected = Buffer.from(this.hash(phone), 'utf8');
    const given = Buffer.from(candidate, 'utf8');
    return expected.length === given.length && timingSafeEqual(expected, given);
  }
}

/** The shape 0045's check constraint accepts. Exported for the tests and the repository. */
export const PHONE_HASH_PATTERN = /^[0-9a-f]{64}$/;

export function isPhoneHash(value: string): boolean {
  return PHONE_HASH_PATTERN.test(value);
}
