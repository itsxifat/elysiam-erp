import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';

import { Injectable } from '@nestjs/common';
import { z } from 'zod';

/**
 * Application-level encryption for an employee's personal data
 * (architecture §12 "payout details … encrypted at application level",
 * invariant 10; M19 acceptance check 3).
 *
 * ## What this protects against, and what it does not
 *
 * It protects against everything that reads the database without going through the
 * application: a `pg_dump` in an email attachment, a `select *` in a psql session, a
 * CSV export, a restored backup on a developer's laptop, a read replica somebody
 * pointed a BI tool at. Those are the ways a national ID number actually leaks, and
 * they are all defeated by the database never holding the plaintext. Acceptance check
 * 3 is exactly this claim, and `hr.db.test.ts` proves it by reading the raw column.
 *
 * It does **not** protect against an attacker who has both the database and the
 * application's key. Nothing at this layer can: the application has to be able to
 * show an employee their own bank account number. Column encryption buys separation
 * of the two secrets, and that is the whole of what it buys — claiming more is how
 * teams end up with encrypted columns and no access control.
 *
 * ## AES-256-GCM, and the envelope
 *
 *     [ 1 byte version ][ 12 byte IV ][ ciphertext ][ 16 byte tag ]
 *
 * GCM rather than CBC because it authenticates: a flipped bit in a backup becomes a
 * decryption failure instead of a plausible-looking wrong account number, and a
 * ciphertext copied from one employee's row into another's is rejected because the
 * AAD does not match.
 *
 * **The AAD binds the ciphertext to its row and column.** Without it, moving
 * `payout_ref_cipher` from Rashed's row to Asha's would decrypt perfectly, and the
 * payroll payment would go to Rashed's bKash number under Asha's name. With it, the
 * tag check fails. The AAD is `org_id|employee_id|field`, none of which is secret —
 * AAD is authenticated, not encrypted, and that is what it is for.
 *
 * The version byte is not decoration: rotating to a new key or a new cipher means
 * reading both for a while, and a format with no version is a format that cannot be
 * changed.
 */

const VERSION = 1;
const IV_BYTES = 12;
const TAG_BYTES = 16;

const schema = z.object({
  /**
   * 32 bytes, base64. The one secret this module needs.
   *
   * Optional, and derived from `AUTH_SECRET` when absent — see `hrFieldKey`. A
   * required variable would mean every developer inventing a key before the server
   * boots, and a dev-only default would mean a hard-coded key in the repository,
   * which invariant 10 forbids outright.
   */
  HR_FIELD_KEY: z.string().min(1).optional(),
});

export type HrCryptoEnv = z.infer<typeof schema>;

let cachedEnv: HrCryptoEnv | undefined;

export function hrCryptoEnv(): HrCryptoEnv {
  cachedEnv ??= schema.parse(process.env);
  return cachedEnv;
}

/** Test-only: forget the parsed configuration so a suite can change it. */
export function resetHrCryptoEnv(): void {
  cachedEnv = undefined;
}

/**
 * The 32-byte key, from `HR_FIELD_KEY` or derived from `AUTH_SECRET`.
 *
 * Deriving rather than defaulting, for the reason `fileUrlSigningKey` gives: one
 * secret used for two purposes is one secret, and the cost of separating them is a
 * single HMAC at startup. The label is versioned so the derivation can change without
 * the root secret changing.
 *
 * A deployment that wants the two genuinely independent — so that rotating session
 * signing does not re-encrypt every employee row, and so that leaking `AUTH_SECRET`
 * does not leak personal data — sets `HR_FIELD_KEY`, and production should.
 */
export function hrFieldKey(authSecret: string, env: HrCryptoEnv = hrCryptoEnv()): Buffer {
  if (env.HR_FIELD_KEY !== undefined) {
    const key = Buffer.from(env.HR_FIELD_KEY, 'base64');
    if (key.length !== 32) {
      throw new Error('HR_FIELD_KEY must be 32 bytes of base64 (openssl rand -base64 32).');
    }
    return key;
  }
  return createHmac('sha256', authSecret).update('elysium:hr-field:v1').digest();
}

/** Which field a ciphertext belongs to. Part of the AAD, so it cannot be swapped. */
export type HrEncryptedField = 'payout_ref' | 'national_id' | 'phone';

export interface HrFieldOwner {
  readonly orgId: string;
  readonly employeeId: string;
}

export class HrDecryptionFailed extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HrDecryptionFailed';
  }
}

function aad(owner: HrFieldOwner, field: HrEncryptedField): Buffer {
  return Buffer.from(`${owner.orgId}|${owner.employeeId}|${field}`, 'utf8');
}

@Injectable()
export class HrCrypto {
  constructor(private readonly key: Buffer) {
    if (key.length !== 32) throw new Error('The HR field key must be 32 bytes.');
  }

  encrypt(plain: string, owner: HrFieldOwner, field: HrEncryptedField): Buffer {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv, {
      authTagLength: TAG_BYTES,
    });
    cipher.setAAD(aad(owner, field));
    const body = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    return Buffer.concat([Buffer.of(VERSION), iv, body, cipher.getAuthTag()]);
  }

  decrypt(envelope: Buffer, owner: HrFieldOwner, field: HrEncryptedField): string {
    if (envelope.length < 1 + IV_BYTES + TAG_BYTES) {
      throw new HrDecryptionFailed('That encrypted field is too short to be one.');
    }
    if (envelope[0] !== VERSION) {
      throw new HrDecryptionFailed(
        `Encrypted field version ${String(envelope[0])} is not one this build can read.`,
      );
    }
    const iv = envelope.subarray(1, 1 + IV_BYTES);
    const tag = envelope.subarray(envelope.length - TAG_BYTES);
    const body = envelope.subarray(1 + IV_BYTES, envelope.length - TAG_BYTES);

    const decipher = createDecipheriv('aes-256-gcm', this.key, iv, {
      authTagLength: TAG_BYTES,
    });
    decipher.setAAD(aad(owner, field));
    decipher.setAuthTag(tag);
    try {
      return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
    } catch {
      /*
       * Deliberately says nothing about why.
       *
       * A wrong key, a tampered ciphertext and a ciphertext belonging to another
       * employee are all the same answer here, because distinguishing them for the
       * caller distinguishes them for an attacker too — and the third case is the
       * one an attacker would be probing for.
       */
      throw new HrDecryptionFailed('That encrypted field could not be read.');
    }
  }
}

/** The Nest injection token, so the module can build it from the parsed secret. */
export const HR_CRYPTO = Symbol('HrCrypto');

/**
 * `01712******78` — what a screen may show (invariant 10).
 *
 * Keeps the first three and the last two, the same shape `maskPhone` in
 * `packages/domain/src/audit` uses for log lines, so a phone number looks the same
 * wherever it appears. Short values are masked entirely rather than partially: the
 * last two digits of a four-digit value is half of it.
 */
export function maskTail(value: string, keepLead = 0, keepTail = 4): string {
  const trimmed = value.replace(/\s+/g, '');
  if (trimmed.length <= keepLead + keepTail) return '*'.repeat(trimmed.length);
  const lead = trimmed.slice(0, keepLead);
  const tail = trimmed.slice(trimmed.length - keepTail);
  // Capped at eight stars so the mask stays inside the column's length CHECK in
  // migration 0053 — the CHECK is a guard against a plaintext in the mask column,
  // and a mask that trips it would be a very confusing error to debug.
  const stars = '*'.repeat(Math.min(8, Math.max(1, trimmed.length - lead.length - tail.length)));
  return `${lead}${stars}${tail}`;
}

/** A bank account or mobile-wallet number: last four digits only. */
export function maskPayoutRef(value: string): string {
  return maskTail(value, 0, 4);
}

/** A national ID: last four digits only. Never the first digits, which encode a district. */
export function maskNationalId(value: string): string {
  return maskTail(value, 0, 4);
}

/** A Bangladeshi mobile number: the operator prefix and the last two digits. */
export function maskEmployeePhone(value: string): string {
  return maskTail(value, 3, 2);
}
