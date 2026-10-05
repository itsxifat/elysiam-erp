import { isBcryptHash, normaliseEmail } from './accounts.js';

/**
 * The old website's customers, as the ERP takes them (M34, D-531; the only old data ever
 * imported, and only if the owner chooses, D-561).
 *
 * The input is a `mongoexport --jsonArray` of the old site's `users` collection. What comes in:
 *
 * - **Customers** (role `customer`, or no role) become website accounts: the email, the name,
 *   the phone, the old bcrypt hash unchanged (so the password keeps working), whether the email
 *   was verified. One with no password is a Google sign-up: it keeps no password and links to
 *   Google the first time its owner signs in with it (the email is the link, and only a
 *   verified one).
 * - **Guests** (`isGuest`, no password) were order holders that never signed up: they cannot
 *   sign in, so no account; their phone becomes a buyer for the order desk.
 * - **Staff** (`staff`, `moderator`, `admin`, `superadmin`) are not imported: staff are invited
 *   to the ERP.
 *
 * Every customer with a usable Bangladeshi mobile is also a buyer (`sales.customers`, by
 * phone), and the account is linked to it. Nothing else of the old site comes across: no
 * orders, no history, no addresses' order snapshots (D-561).
 *
 * This file only decides; it reads no database. The importer passes in what the brand already
 * has (emails with an account, phones with a buyer) so a second run is a no-op.
 */

export const STAFF_ROLES = ['staff', 'moderator', 'admin', 'superadmin'] as const;

export interface LegacyAccount {
  /** The old `_id`, kept in `legacy_ids` as kind `customer`. */
  readonly legacyId: string;
  readonly email: string;
  readonly name: string;
  readonly phone: string | null;
  /** The old bcrypt hash, unchanged; null for a Google sign-up or an unusable hash. */
  readonly passwordHash: string | null;
  readonly emailVerified: boolean;
  readonly createdAt: Date | null;
}

export interface LegacyBuyer {
  readonly legacyId: string;
  /** The national form, `01XXXXXXXXX`; the importer normalises it to E.164. */
  readonly phone: string;
  readonly name: string;
}

export interface LegacyRowNote {
  /** 1-based position in the file. Never the row's content (invariant 10). */
  readonly row: number;
  readonly reason:
    | 'staff'
    | 'not_an_object'
    | 'no_identity'
    | 'duplicate_email'
    | 'already_imported'
    | 'unusable_password_hash'
    | 'unusable_phone';
}

export interface LegacyCustomerPlan {
  readonly accounts: readonly LegacyAccount[];
  /** Buyers to create: phones not already a buyer, once each. */
  readonly buyers: readonly LegacyBuyer[];
  /** Rows not imported, and why. */
  readonly skipped: readonly LegacyRowNote[];
  /** Rows imported with something left behind (a hash that is not bcrypt, a phone that is not a mobile). */
  readonly warnings: readonly LegacyRowNote[];
  readonly counts: {
    readonly rows: number;
    readonly accounts: number;
    readonly accountsWithPassword: number;
    readonly googleOnly: number;
    readonly verified: number;
    readonly buyers: number;
    readonly staff: number;
    readonly guests: number;
    readonly duplicates: number;
    readonly alreadyImported: number;
    readonly invalid: number;
  };
}

/** `"..."`, `{ "$oid": "..." }`: the old `_id` as text, or null. */
function idOf(value: unknown): string | null {
  if (typeof value === 'string' && value.trim() !== '') return value.trim().slice(0, 64);
  if (typeof value === 'object' && value !== null) {
    const oid = (value as { $oid?: unknown }).$oid;
    if (typeof oid === 'string' && oid !== '') return oid.slice(0, 64);
  }
  return null;
}

/** `"2024-…"`, `{ "$date": "…" }` or `{ "$date": { "$numberLong": "…" } }`. */
function dateOf(value: unknown): Date | null {
  let raw: unknown = value;
  if (typeof raw === 'object' && raw !== null && '$date' in raw) raw = raw.$date;
  if (typeof raw === 'object' && raw !== null && '$numberLong' in raw) {
    raw = Number(raw.$numberLong);
  }
  if (typeof raw !== 'string' && typeof raw !== 'number') return null;
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** The old site's `normalizeBdPhone` result shape, `01XXXXXXXXX`, or null. */
export function legacyPhone(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const ascii = value
    .replace(/[০-৯]/g, (digit) => String(digit.charCodeAt(0) - 0x09e6))
    .replace(/[\s-]/g, '');
  const national = ascii.replace(/^\+?880/, '0');
  return /^01[3-9]\d{8}$/.test(national) ? national : null;
}

function nameOf(value: unknown, fallback: string): string {
  const name = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
  const placeholders = new Set([
    '',
    'guest',
    'guest customer',
    'customer',
    'n/a',
    'na',
    '-',
    'unknown',
  ]);
  return (placeholders.has(name.toLowerCase()) ? fallback : name).slice(0, 120) || fallback;
}

export function planLegacyCustomers(
  rows: readonly unknown[],
  existing: {
    /** Emails that already have a website account in the brand. */
    readonly accountEmails: ReadonlySet<string>;
    /** National phones (`01…`) that are already a buyer in the brand. */
    readonly buyerPhones: ReadonlySet<string>;
  },
): LegacyCustomerPlan {
  const accounts: LegacyAccount[] = [];
  const buyers: LegacyBuyer[] = [];
  const skipped: LegacyRowNote[] = [];
  const warnings: LegacyRowNote[] = [];
  const seenEmails = new Set<string>();
  const seenPhones = new Set<string>();
  let staff = 0;
  let guests = 0;

  rows.forEach((value, index) => {
    const row = index + 1;
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      skipped.push({ row, reason: 'not_an_object' });
      return;
    }
    const record = value as Record<string, unknown>;
    const role = typeof record.role === 'string' ? record.role : 'customer';
    if ((STAFF_ROLES as readonly string[]).includes(role)) {
      staff += 1;
      skipped.push({ row, reason: 'staff' });
      return;
    }
    const legacyId = idOf(record._id) ?? `row-${String(row)}`;
    const email = typeof record.email === 'string' ? normaliseEmail(record.email) : null;
    const rawPhone = record.phone;
    const phone = legacyPhone(rawPhone);
    if (phone === null && typeof rawPhone === 'string' && rawPhone.trim() !== '') {
      warnings.push({ row, reason: 'unusable_phone' });
    }
    const password = typeof record.password === 'string' ? record.password : null;
    const isGuest = record.isGuest === true && password === null;
    if (isGuest) guests += 1;

    if (email === null && phone === null) {
      skipped.push({ row, reason: 'no_identity' });
      return;
    }

    const name = nameOf(record.name, email?.slice(0, email.indexOf('@')) ?? 'Customer');
    if (phone !== null && !seenPhones.has(phone) && !existing.buyerPhones.has(phone)) {
      seenPhones.add(phone);
      buyers.push({ legacyId, phone, name });
    }
    if (isGuest || email === null) return;

    if (seenEmails.has(email)) {
      skipped.push({ row, reason: 'duplicate_email' });
      return;
    }
    seenEmails.add(email);
    if (existing.accountEmails.has(email)) {
      skipped.push({ row, reason: 'already_imported' });
      return;
    }
    let passwordHash: string | null = null;
    if (password !== null) {
      if (isBcryptHash(password)) passwordHash = password;
      else warnings.push({ row, reason: 'unusable_password_hash' });
    }
    accounts.push({
      legacyId,
      email,
      name,
      phone,
      passwordHash,
      emailVerified: record.emailVerified === true,
      createdAt: dateOf(record.createdAt),
    });
  });

  const count = (reason: LegacyRowNote['reason']) =>
    skipped.filter((note) => note.reason === reason).length;
  return {
    accounts,
    buyers,
    skipped,
    warnings,
    counts: {
      rows: rows.length,
      accounts: accounts.length,
      accountsWithPassword: accounts.filter((account) => account.passwordHash !== null).length,
      googleOnly: accounts.filter((account) => account.passwordHash === null).length,
      verified: accounts.filter((account) => account.emailVerified).length,
      buyers: buyers.length,
      staff,
      guests,
      duplicates: count('duplicate_email'),
      alreadyImported: count('already_imported'),
      invalid: count('no_identity') + count('not_an_object'),
    },
  };
}
