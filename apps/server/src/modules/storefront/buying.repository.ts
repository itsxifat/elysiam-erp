import { sql } from 'drizzle-orm';
import type { Tx } from '@elysium/db';

/**
 * The storefront module's own tables for buying (M34, D-520 to D-539): shopper accounts and
 * their one-time codes, the website's record of each order it placed, order view tokens, the
 * checkout's idempotency keys, the brand's SSLCommerz account and its payment sessions.
 *
 * Raw SQL, parameterised, filtering on `org_id` though RLS already does. Nothing here reads
 * another module's tables (invariant 12): orders, buyers, stock and the ledger are asked
 * through their `*.api.ts`.
 */

const iso = (value: Date | string | null): string | null =>
  value === null ? null : new Date(value).toISOString();

// --- accounts -----------------------------------------------------------------------------------

export interface AccountRow extends Record<string, unknown> {
  readonly id: string;
  readonly email: string;
  readonly email_verified_at: Date | string | null;
  readonly password_hash: string | null;
  readonly google_sub: string | null;
  readonly name: string;
  readonly phone_e164: string | null;
  readonly customer_id: string | null;
  readonly locale: string;
  readonly addresses: unknown;
  readonly last_sign_in_at: Date | string | null;
  readonly source: string;
  readonly created_at: Date | string;
  readonly updated_at: Date | string;
}

const ACCOUNT_COLUMNS = sql`id, email, email_verified_at, password_hash, google_sub, name, phone_e164,
  customer_id, locale, addresses, last_sign_in_at, source, created_at, updated_at`;

export async function accountByEmail(
  tx: Tx,
  orgId: string,
  email: string,
  options: { readonly forUpdate?: boolean } = {},
): Promise<AccountRow | undefined> {
  const rows = await tx.execute<AccountRow>(sql`
    select ${ACCOUNT_COLUMNS} from storefront.customer_accounts
    where org_id = ${orgId} and email = ${email}
    ${options.forUpdate === true ? sql`for update` : sql``}
  `);
  return rows[0];
}

export async function accountById(
  tx: Tx,
  orgId: string,
  id: string,
  options: { readonly forUpdate?: boolean } = {},
): Promise<AccountRow | undefined> {
  const rows = await tx.execute<AccountRow>(sql`
    select ${ACCOUNT_COLUMNS} from storefront.customer_accounts
    where org_id = ${orgId} and id = ${id}
    ${options.forUpdate === true ? sql`for update` : sql``}
  `);
  return rows[0];
}

export async function accountByGoogleSub(
  tx: Tx,
  orgId: string,
  sub: string,
): Promise<AccountRow | undefined> {
  const rows = await tx.execute<AccountRow>(sql`
    select ${ACCOUNT_COLUMNS} from storefront.customer_accounts
    where org_id = ${orgId} and google_sub = ${sub}
    for update
  `);
  return rows[0];
}

/** Insert an account; undefined when the email is already taken (a racing sign-up). */
export async function insertAccount(
  tx: Tx,
  input: {
    readonly orgId: string;
    readonly email: string;
    readonly passwordHash: string | null;
    readonly googleSub: string | null;
    readonly name: string;
    readonly phoneE164: string | null;
    readonly customerId: string | null;
    readonly locale: string;
    readonly source: 'website' | 'google' | 'legacy_import';
    readonly emailVerifiedAt: Date | null;
    readonly createdAt?: Date | null;
  },
): Promise<string | undefined> {
  const rows = await tx.execute<{ id: string }>(sql`
    insert into storefront.customer_accounts
      (org_id, email, password_hash, google_sub, name, phone_e164, customer_id, locale, source,
       email_verified_at, created_at)
    values (${input.orgId}, ${input.email}, ${input.passwordHash}, ${input.googleSub},
            ${input.name}, ${input.phoneE164}, ${input.customerId}::uuid, ${input.locale},
            ${input.source}, ${input.emailVerifiedAt?.toISOString() ?? null}::timestamptz,
            coalesce(${input.createdAt?.toISOString() ?? null}::timestamptz, now()))
    on conflict (org_id, email) do nothing
    returning id
  `);
  return rows[0]?.id;
}

export async function markVerified(tx: Tx, orgId: string, id: string): Promise<void> {
  await tx.execute(sql`
    update storefront.customer_accounts
    set email_verified_at = coalesce(email_verified_at, now()), updated_at = now()
    where org_id = ${orgId} and id = ${id}
  `);
}

export async function setPasswordHash(
  tx: Tx,
  orgId: string,
  id: string,
  hash: string,
): Promise<void> {
  await tx.execute(sql`
    update storefront.customer_accounts set password_hash = ${hash}, updated_at = now()
    where org_id = ${orgId} and id = ${id}
  `);
}

/** Re-register an unverified account with a new password and name (no verified one, ever). */
export async function refreshUnverified(
  tx: Tx,
  input: {
    readonly orgId: string;
    readonly id: string;
    readonly passwordHash: string;
    readonly name: string;
    readonly phoneE164: string | null;
    readonly locale: string;
  },
): Promise<boolean> {
  const rows = await tx.execute<{ id: string }>(sql`
    update storefront.customer_accounts
    set password_hash = ${input.passwordHash}, name = ${input.name},
        phone_e164 = coalesce(${input.phoneE164}, phone_e164), locale = ${input.locale},
        updated_at = now()
    where org_id = ${input.orgId} and id = ${input.id} and email_verified_at is null
    returning id
  `);
  return rows.length > 0;
}

export async function linkGoogle(tx: Tx, orgId: string, id: string, sub: string): Promise<boolean> {
  const rows = await tx.execute<{ id: string }>(sql`
    update storefront.customer_accounts set google_sub = ${sub}, updated_at = now()
    where org_id = ${orgId} and id = ${id} and email_verified_at is not null
      and (google_sub is null or google_sub = ${sub})
    returning id
  `);
  return rows.length > 0;
}

export async function touchSignIn(tx: Tx, orgId: string, id: string): Promise<void> {
  await tx.execute(sql`
    update storefront.customer_accounts set last_sign_in_at = now()
    where org_id = ${orgId} and id = ${id}
  `);
}

export async function updateProfile(
  tx: Tx,
  input: {
    readonly orgId: string;
    readonly id: string;
    readonly name?: string | undefined;
    /** Undefined keeps; null clears. */
    readonly phoneE164?: string | null | undefined;
    readonly customerId?: string | null | undefined;
    readonly locale?: string | undefined;
    readonly addresses?: unknown;
  },
): Promise<void> {
  await tx.execute(sql`
    update storefront.customer_accounts set
      name = ${input.name === undefined ? sql`name` : sql`${input.name}`},
      phone_e164 = ${input.phoneE164 === undefined ? sql`phone_e164` : sql`${input.phoneE164}`},
      customer_id = ${input.customerId === undefined ? sql`customer_id` : sql`${input.customerId}::uuid`},
      locale = ${input.locale === undefined ? sql`locale` : sql`${input.locale}`},
      addresses = ${input.addresses === undefined ? sql`addresses` : sql`${JSON.stringify(input.addresses)}::jsonb`},
      updated_at = now()
    where org_id = ${input.orgId} and id = ${input.id}
  `);
}

export interface AccountListRow extends AccountRow {
  readonly order_count: number;
}

/** The console's list: newest first, optionally narrowed by an email or name fragment. */
export async function listAccounts(
  tx: Tx,
  orgId: string,
  input: {
    readonly q?: string | undefined;
    readonly customerId?: string | undefined;
    readonly limit: number;
    readonly offset: number;
  },
): Promise<{ rows: AccountListRow[]; total: number }> {
  const pattern = input.q === undefined ? null : `%${input.q.replace(/[\\%_]/g, '\\$&')}%`;
  const where = sql`a.org_id = ${orgId}
    ${pattern === null ? sql`` : sql`and (a.email ilike ${pattern} or a.name ilike ${pattern})`}
    ${input.customerId === undefined ? sql`` : sql`and a.customer_id = ${input.customerId}::uuid`}`;
  const rows = await tx.execute<AccountListRow>(sql`
    select a.id, a.email, a.email_verified_at, null::text as password_hash,
           a.google_sub is not null as google_linked, a.google_sub, a.name, a.phone_e164,
           a.customer_id, a.locale, '[]'::jsonb as addresses, a.last_sign_in_at, a.source,
           a.created_at, a.updated_at,
           (select count(*)::int from storefront.web_orders w
             where w.org_id = a.org_id and w.account_id = a.id) as order_count
    from storefront.customer_accounts a
    where ${where}
    order by a.created_at desc, a.id desc
    limit ${input.limit} offset ${input.offset}
  `);
  const total = await tx.execute<{ n: number }>(sql`
    select count(*)::int as n from storefront.customer_accounts a where ${where}
  `);
  return { rows: [...rows], total: total[0]?.n ?? 0 };
}

// --- one-time codes -----------------------------------------------------------------------------

export interface CodeRow extends Record<string, unknown> {
  readonly id: string;
  readonly account_id: string;
  readonly purpose: string;
  readonly code_hash: string;
  readonly expires_at: Date | string;
  readonly attempts: number;
  readonly consumed_at: Date | string | null;
}

/** A new code for a purpose; every older live one of the same purpose is consumed. */
export async function issueCode(
  tx: Tx,
  input: {
    readonly orgId: string;
    readonly accountId: string;
    readonly purpose: 'verify_email' | 'reset_password';
    readonly codeHash: string;
    readonly expiresAt: Date;
  },
): Promise<void> {
  await tx.execute(sql`
    update storefront.account_codes set consumed_at = now(), updated_at = now()
    where org_id = ${input.orgId} and account_id = ${input.accountId}
      and purpose = ${input.purpose} and consumed_at is null
  `);
  await tx.execute(sql`
    insert into storefront.account_codes (org_id, account_id, purpose, code_hash, expires_at)
    values (${input.orgId}, ${input.accountId}, ${input.purpose}, ${input.codeHash},
            ${input.expiresAt.toISOString()}::timestamptz)
  `);
}

/** The newest code of a purpose for an account, locked: what a verification compares against. */
export async function latestCode(
  tx: Tx,
  orgId: string,
  accountId: string,
  purpose: string,
): Promise<CodeRow | undefined> {
  const rows = await tx.execute<CodeRow>(sql`
    select id, account_id, purpose, code_hash, expires_at, attempts, consumed_at
    from storefront.account_codes
    where org_id = ${orgId} and account_id = ${accountId} and purpose = ${purpose}
    order by created_at desc, id desc limit 1
    for update
  `);
  return rows[0];
}

export async function codeByHash(
  tx: Tx,
  orgId: string,
  purpose: string,
  hash: string,
): Promise<CodeRow | undefined> {
  const rows = await tx.execute<CodeRow>(sql`
    select id, account_id, purpose, code_hash, expires_at, attempts, consumed_at
    from storefront.account_codes
    where org_id = ${orgId} and purpose = ${purpose} and code_hash = ${hash}
    for update
  `);
  return rows[0];
}

export async function countTry(tx: Tx, orgId: string, id: string): Promise<void> {
  await tx.execute(sql`
    update storefront.account_codes set attempts = attempts + 1, updated_at = now()
    where org_id = ${orgId} and id = ${id}
  `);
}

export async function consumeCode(tx: Tx, orgId: string, id: string): Promise<boolean> {
  const rows = await tx.execute<{ id: string }>(sql`
    update storefront.account_codes set consumed_at = now(), updated_at = now()
    where org_id = ${orgId} and id = ${id} and consumed_at is null
    returning id
  `);
  return rows.length > 0;
}

/** Every live code of a purpose for an account, consumed (a reset ends every other reset link). */
export async function consumeAll(
  tx: Tx,
  orgId: string,
  accountId: string,
  purpose: string,
): Promise<void> {
  await tx.execute(sql`
    update storefront.account_codes set consumed_at = now(), updated_at = now()
    where org_id = ${orgId} and account_id = ${accountId} and purpose = ${purpose}
      and consumed_at is null
  `);
}

// --- website orders -----------------------------------------------------------------------------

export interface WebOrderRow extends Record<string, unknown> {
  readonly order_id: string;
  readonly account_id: string | null;
  readonly email: string | null;
  readonly locale: string;
  readonly payment_method: string;
  readonly phone_e164: string;
  readonly created_at: Date | string;
}

export async function insertWebOrder(
  tx: Tx,
  input: {
    readonly orgId: string;
    readonly orderId: string;
    readonly accountId: string | null;
    readonly email: string | null;
    readonly locale: string;
    readonly paymentMethod: 'cod' | 'sslcommerz';
    readonly phoneE164: string;
  },
): Promise<void> {
  await tx.execute(sql`
    insert into storefront.web_orders
      (org_id, order_id, account_id, email, locale, payment_method, phone_e164)
    values (${input.orgId}, ${input.orderId}, ${input.accountId}::uuid, ${input.email},
            ${input.locale}, ${input.paymentMethod}, ${input.phoneE164})
  `);
}

export async function webOrder(
  tx: Tx,
  orgId: string,
  orderId: string,
): Promise<WebOrderRow | undefined> {
  const rows = await tx.execute<WebOrderRow>(sql`
    select order_id, account_id, email, locale, payment_method, phone_e164, created_at
    from storefront.web_orders where org_id = ${orgId} and order_id = ${orderId}
  `);
  return rows[0];
}

/** An account's orders, newest first, after a `(created_at, order_id)` cursor. */
export async function webOrdersOfAccount(
  tx: Tx,
  orgId: string,
  accountId: string,
  input: { readonly before: { at: string; id: string } | null; readonly limit: number },
): Promise<WebOrderRow[]> {
  const after =
    input.before === null
      ? sql``
      : sql`and (created_at, order_id) < (${input.before.at}::timestamptz, ${input.before.id}::uuid)`;
  const rows = await tx.execute<WebOrderRow>(sql`
    select order_id, account_id, email, locale, payment_method, phone_e164, created_at
    from storefront.web_orders
    where org_id = ${orgId} and account_id = ${accountId} ${after}
    order by created_at desc, order_id desc
    limit ${input.limit}
  `);
  return [...rows];
}

/**
 * Claim past guest orders into a verified account (D-523, the domain's `claimsGuestOrder`):
 * those that gave this email. Never by phone (M34 ledger audit W5).
 */
export async function claimGuestOrders(
  tx: Tx,
  input: {
    readonly orgId: string;
    readonly accountId: string;
    readonly email: string;
  },
): Promise<number> {
  const rows = await tx.execute<{ order_id: string }>(sql`
    update storefront.web_orders set account_id = ${input.accountId}, updated_at = now()
    where org_id = ${input.orgId} and account_id is null
      and email = ${input.email}
    returning order_id
  `);
  return rows.length;
}

export async function insertViewToken(
  tx: Tx,
  input: {
    readonly orgId: string;
    readonly orderId: string;
    readonly tokenSha256: string;
    readonly purpose: 'confirmation' | 'email';
  },
): Promise<void> {
  await tx.execute(sql`
    insert into storefront.order_view_tokens (org_id, order_id, token_sha256, purpose)
    values (${input.orgId}, ${input.orderId}, ${input.tokenSha256}, ${input.purpose})
  `);
}

export async function orderIdForToken(
  tx: Tx,
  orgId: string,
  tokenSha256: string,
): Promise<string | undefined> {
  const rows = await tx.execute<{ order_id: string }>(sql`
    select order_id from storefront.order_view_tokens
    where org_id = ${orgId} and token_sha256 = ${tokenSha256}
  `);
  return rows[0]?.order_id;
}

// --- the checkout's idempotency key -------------------------------------------------------------

/**
 * Claim a checkout key in the checkout's own transaction. A copy of the same request running
 * at the same time waits here on the unique index until the first commits, then finds its row
 * (undefined); a first that rolled back leaves the key free.
 */
export async function claimCheckout(
  tx: Tx,
  input: {
    readonly orgId: string;
    readonly siteKeyId: string;
    readonly idempotencyKey: string;
    readonly requestSha256: string;
  },
): Promise<string | undefined> {
  const rows = await tx.execute<{ id: string }>(sql`
    insert into storefront.checkout_submissions
      (org_id, site_key_id, idempotency_key, request_sha256)
    values (${input.orgId}, ${input.siteKeyId}, ${input.idempotencyKey}, ${input.requestSha256})
    on conflict (org_id, site_key_id, idempotency_key) do nothing
    returning id
  `);
  return rows[0]?.id;
}

export async function completeCheckout(
  tx: Tx,
  orgId: string,
  id: string,
  orderId: string,
): Promise<void> {
  await tx.execute(sql`
    update storefront.checkout_submissions set order_id = ${orderId}, updated_at = now()
    where org_id = ${orgId} and id = ${id} and order_id is null
  `);
}

export async function checkoutFor(
  tx: Tx,
  orgId: string,
  siteKeyId: string,
  idempotencyKey: string,
): Promise<{ readonly request_sha256: string; readonly order_id: string | null } | undefined> {
  const rows = await tx.execute<{ request_sha256: string; order_id: string | null }>(sql`
    select request_sha256, order_id from storefront.checkout_submissions
    where org_id = ${orgId} and site_key_id = ${siteKeyId} and idempotency_key = ${idempotencyKey}
  `);
  return rows[0];
}

// --- the SSLCommerz account ---------------------------------------------------------------------

export interface GatewaySettingsRow extends Record<string, unknown> {
  readonly enabled: boolean;
  readonly mode: 'sandbox' | 'live';
  readonly store_id: string;
  readonly password_sealed: Buffer;
  readonly key_id: string;
  readonly fingerprint: string;
  readonly updated_by: string;
  readonly updated_at: Date | string;
}

export async function gatewaySettings(
  tx: Tx,
  orgId: string,
): Promise<GatewaySettingsRow | undefined> {
  const rows = await tx.execute<GatewaySettingsRow>(sql`
    select enabled, mode, store_id, password_sealed, key_id, fingerprint, updated_by, updated_at
    from storefront.gateway_settings where org_id = ${orgId}
  `);
  const row = rows[0];
  if (row === undefined) return undefined;
  return { ...row, password_sealed: Buffer.from(row.password_sealed as unknown as Uint8Array) };
}

export async function upsertGatewaySettings(
  tx: Tx,
  input: {
    readonly orgId: string;
    readonly enabled: boolean;
    readonly mode: 'sandbox' | 'live';
    readonly storeId: string;
    readonly password?: {
      readonly sealed: Buffer;
      readonly keyId: string;
      readonly fingerprint: string;
    };
    readonly updatedBy: string;
  },
): Promise<boolean> {
  const password = input.password;
  if (password === undefined) {
    const rows = await tx.execute<{ org_id: string }>(sql`
      update storefront.gateway_settings
      set enabled = ${input.enabled}, mode = ${input.mode}, store_id = ${input.storeId},
          updated_by = ${input.updatedBy}, updated_at = now()
      where org_id = ${input.orgId}
      returning org_id
    `);
    return rows.length > 0;
  }
  await tx.execute(sql`
    insert into storefront.gateway_settings
      (org_id, enabled, mode, store_id, password_sealed, key_id, fingerprint, updated_by)
    values (${input.orgId}, ${input.enabled}, ${input.mode}, ${input.storeId}, ${password.sealed},
            ${password.keyId}, ${password.fingerprint}, ${input.updatedBy})
    on conflict (org_id) do update set
      enabled = excluded.enabled, mode = excluded.mode, store_id = excluded.store_id,
      password_sealed = excluded.password_sealed, key_id = excluded.key_id,
      fingerprint = excluded.fingerprint, updated_by = excluded.updated_by, updated_at = now()
  `);
  return true;
}

// --- payment sessions ---------------------------------------------------------------------------

export interface SessionRow extends Record<string, unknown> {
  readonly id: string;
  readonly order_id: string;
  readonly mode: 'sandbox' | 'live';
  readonly tran_id: string;
  readonly amount_poisha: string;
  readonly status: string;
  readonly gateway_url: string | null;
  readonly val_id: string | null;
  readonly validated_amount_poisha: string | null;
  readonly card_type: string | null;
  readonly risky: boolean;
  readonly failure_reason: string | null;
  readonly advance_id: string | null;
  readonly expires_at: Date | string;
  readonly settled_at: Date | string | null;
  readonly created_at: Date | string;
  readonly updated_at: Date | string;
}

const SESSION_COLUMNS = sql`id, order_id, mode, tran_id, amount_poisha::text as amount_poisha, status,
  gateway_url, val_id, validated_amount_poisha::text as validated_amount_poisha, card_type, risky,
  failure_reason, advance_id, expires_at, settled_at, created_at, updated_at`;

export async function insertSession(
  tx: Tx,
  input: {
    readonly orgId: string;
    readonly orderId: string;
    readonly mode: 'sandbox' | 'live';
    readonly tranId: string;
    readonly amountPoisha: bigint;
    readonly expiresAt: Date;
  },
): Promise<string> {
  const rows = await tx.execute<{ id: string }>(sql`
    insert into storefront.payment_sessions
      (org_id, order_id, mode, tran_id, amount_poisha, expires_at)
    values (${input.orgId}, ${input.orderId}, ${input.mode}, ${input.tranId},
            ${input.amountPoisha.toString()}::bigint, ${input.expiresAt.toISOString()}::timestamptz)
    returning id
  `);
  const id = rows[0]?.id;
  if (id === undefined) throw new Error('inserting a payment session returned no id');
  return id;
}

export async function sessionById(
  tx: Tx,
  orgId: string,
  id: string,
  options: { readonly forUpdate?: boolean } = {},
): Promise<SessionRow | undefined> {
  const rows = await tx.execute<SessionRow>(sql`
    select ${SESSION_COLUMNS} from storefront.payment_sessions
    where org_id = ${orgId} and id = ${id}
    ${options.forUpdate === true ? sql`for update` : sql``}
  `);
  return rows[0];
}

export async function sessionByTranId(
  tx: Tx,
  orgId: string,
  tranId: string,
  options: { readonly forUpdate?: boolean } = {},
): Promise<SessionRow | undefined> {
  const rows = await tx.execute<SessionRow>(sql`
    select ${SESSION_COLUMNS} from storefront.payment_sessions
    where org_id = ${orgId} and tran_id = ${tranId}
    ${options.forUpdate === true ? sql`for update` : sql``}
  `);
  return rows[0];
}

export async function sessionsOfOrder(
  tx: Tx,
  orgId: string,
  orderId: string,
): Promise<SessionRow[]> {
  const rows = await tx.execute<SessionRow>(sql`
    select ${SESSION_COLUMNS} from storefront.payment_sessions
    where org_id = ${orgId} and order_id = ${orderId}
    order by created_at desc, id desc
  `);
  return [...rows];
}

export async function recentSessions(tx: Tx, orgId: string, limit: number): Promise<SessionRow[]> {
  const rows = await tx.execute<SessionRow>(sql`
    select ${SESSION_COLUMNS} from storefront.payment_sessions
    where org_id = ${orgId} order by created_at desc, id desc limit ${limit}
  `);
  return [...rows];
}

/** Move a session along its path (the trigger in 0114 refuses any other move). */
export async function moveSession(
  tx: Tx,
  input: {
    readonly orgId: string;
    readonly id: string;
    readonly from: readonly string[];
    readonly to: string;
    readonly gatewayUrl?: string | null;
    readonly sessionKey?: string | null;
    readonly valId?: string | null;
    readonly validatedAmountPoisha?: bigint | null;
    readonly cardType?: string | null;
    readonly bankTranId?: string | null;
    readonly risky?: boolean;
    readonly failureReason?: string | null;
    readonly advanceId?: string | null;
    readonly settled?: boolean;
  },
): Promise<boolean> {
  const set = (column: string, value: unknown, cast = '') =>
    value === undefined ? sql`` : sql`, ${sql.raw(column)} = ${value}${sql.raw(cast)}`;
  const rows = await tx.execute<{ id: string }>(sql`
    update storefront.payment_sessions set status = ${input.to}, updated_at = now()
      ${set('gateway_url', input.gatewayUrl)}
      ${set('session_key', input.sessionKey)}
      ${set('val_id', input.valId)}
      ${set(
        'validated_amount_poisha',
        input.validatedAmountPoisha === undefined || input.validatedAmountPoisha === null
          ? input.validatedAmountPoisha
          : input.validatedAmountPoisha.toString(),
        '::bigint',
      )}
      ${set('card_type', input.cardType)}
      ${set('bank_tran_id', input.bankTranId)}
      ${set('risky', input.risky)}
      ${set('failure_reason', input.failureReason)}
      ${set('advance_id', input.advanceId, '::uuid')}
      ${input.settled === true ? sql`, settled_at = now()` : sql``}
    where org_id = ${input.orgId} and id = ${input.id}
      and status = any (${sql.param([...input.from])}::text[])
    returning id
  `);
  return rows.length > 0;
}

export { iso };
