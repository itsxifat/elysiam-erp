import { daysBetween, isIsoDate, isMonth } from '@elysium/domain';
import { z } from 'zod';

/**
 * What the mother's API accepts, validated at the edge with these and nothing else
 * (CLAUDE.md "Validate at the edge"). The console builds its forms on the same schemas.
 */

/** A brand's slug: the brand ERP's `ERP_BRAND_SLUG` and its org's slug (D-481, D-473). */
export const BRAND_SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** The longest range one request may ask for: a little over a year, for a year-on-year view. */
export const MAX_RANGE_DAYS = 400;

const isoDate = z
  .string()
  .refine((value) => isIsoDate(value), { message: 'Expected a YYYY-MM-DD date.' });

export const rangeQuerySchema = z
  .object({ from: isoDate, to: isoDate })
  .refine((range) => range.from <= range.to, {
    message: 'The range must not end before it starts.',
    path: ['to'],
  })
  .refine((range) => daysBetween(range.from, range.to) < MAX_RANGE_DAYS, {
    message: `A range may span at most ${String(MAX_RANGE_DAYS)} days.`,
    path: ['to'],
  });
export type RangeQuery = z.infer<typeof rangeQuerySchema>;

export const monthQuerySchema = z.object({
  month: z.string().refine((value) => isMonth(value), { message: 'Expected a YYYY-MM month.' }),
});
export type MonthQuery = z.infer<typeof monthQuerySchema>;

/**
 * The brand's read connection: a Postgres URL for the brand database's read-only reporting
 * role, `erp_analytics`, and no other (D-481). Refusing every other user here means a
 * pasted owner or app connection string is never stored, so the mother can never hold a
 * key that writes to a brand.
 */
export const READ_ROLE = 'erp_analytics';

/** The only query parameters a brand's read connection may carry. */
const CONNECTION_PARAMETERS: ReadonlySet<string> = new Set(['sslmode', 'sslrootcert']);

export const readConnectionSchema = z
  .string()
  .trim()
  .max(1_000)
  .refine(
    (value) => {
      try {
        const url = new URL(value);
        return (
          (url.protocol === 'postgres:' || url.protocol === 'postgresql:') &&
          url.hostname !== '' &&
          url.pathname.length > 1
        );
      } catch {
        return false;
      }
    },
    { message: 'Expected a postgres:// connection string with a host and a database.' },
  )
  .refine(
    (value) => {
      try {
        return decodeURIComponent(new URL(value).username) === READ_ROLE;
      } catch {
        return false;
      }
    },
    { message: `The connection must sign in as ${READ_ROLE}, the brand's read-only role.` },
  )
  // The driver sends unknown query parameters at sign-in, after the user it was given:
  // `?user=erp_owner` would sign in as that role. Only the TLS settings may follow.
  .refine(
    (value) => {
      try {
        return [...new URL(value).searchParams.keys()].every((key) =>
          CONNECTION_PARAMETERS.has(key),
        );
      } catch {
        return false;
      }
    },
    { message: 'Only sslmode and sslrootcert may follow the connection string.' },
  );

/** Where the brand's staff console answers: https, or http on a local machine. */
export const adminUrlSchema = z
  .string()
  .trim()
  .max(300)
  .refine(
    (value) => {
      try {
        const url = new URL(value);
        if (url.search !== '' || url.hash !== '') return false;
        if (url.protocol === 'https:') return true;
        return (
          url.protocol === 'http:' && (url.hostname === 'localhost' || url.hostname === '127.0.0.1')
        );
      } catch {
        return false;
      }
    },
    { message: 'Expected an https:// address with no query or fragment.' },
  );

export const brandCreateSchema = z.object({
  slug: z
    .string()
    .trim()
    .min(2)
    .max(40)
    .regex(BRAND_SLUG, 'Lower-case letters, digits and dashes.'),
  displayName: z.string().trim().min(1).max(120),
  adminUrl: adminUrlSchema,
  readConnection: readConnectionSchema,
});
export type BrandCreateInput = z.infer<typeof brandCreateSchema>;

/**
 * What an owner may change about a brand from the console. Strict: a brand's read
 * connection (and its owner-link key) change only on the server, by the operator's
 * `brands set-connection` and `brands rotate-key` (D-700), so a body naming
 * `readConnection` is refused rather than quietly ignored.
 */
export const brandUpdateSchema = z
  .strictObject({
    displayName: z.string().trim().min(1).max(120).optional(),
    adminUrl: adminUrlSchema.optional(),
    isActive: z.boolean().optional(),
  })
  .refine((value) => Object.values(value).some((field) => field !== undefined), {
    message: 'Change at least one field.',
  });
export type BrandUpdateInput = z.infer<typeof brandUpdateSchema>;

/** The operator's `brands set-connection` on the server (D-700): a new read connection. */
export const brandConnectionSchema = z.object({ readConnection: readConnectionSchema });
export type BrandConnectionInput = z.infer<typeof brandConnectionSchema>;

export const pullRequestSchema = z.object({
  /** Every day the brand has, rather than the recent window (D-484). */
  full: z.boolean().default(false),
});

/**
 * Control, zero-width, line-separator and direction-override characters: never in a
 * person's name, which is shown on every screen and signed into owner links that write it
 * into a brand (the M40 audit's N7). The zero-width joiner and non-joiner stay: Bangla
 * spelling uses them.
 */
const UNPRINTABLE = /[\p{Cc}\u200b\u200e\u200f\u2028-\u202e\u2060-\u2069\ufeff]/u;

/** A person's name, as an owner types it for themselves or for someone they invite. */
export const personNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .refine((value) => !UNPRINTABLE.test(value), {
    message: 'Letters, digits, spaces and punctuation only.',
  });

export const inviteOwnerSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  name: personNameSchema,
});
export type InviteOwnerInput = z.infer<typeof inviteOwnerSchema>;

export const twoFactorResetRequestSchema = z.object({
  reason: z.string().trim().min(3).max(500),
});

export const activityQuerySchema = z.object({
  /** The id of the last row already shown; older rows follow. */
  before: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export const uuidParamSchema = z.string().uuid();

// --- my account (M40, D-701 to D-705) ----------------------------------------------------

/** Better Auth's limits as the mother sets them (`minPasswordLength`, its default maximum). */
export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 128;

/** A password typed to confirm a change: checked against the stored one, never parsed. */
const typedPassword = z.string().min(1).max(PASSWORD_MAX_LENGTH);

export const accountNameSchema = z.object({ name: personNameSchema });
export type AccountNameInput = z.infer<typeof accountNameSchema>;

/** A 6-digit code from an authenticator app, spaces allowed while typing. */
export const totpCodeSchema = z
  .string()
  .transform((value) => value.replace(/\s/g, ''))
  .pipe(z.string().regex(/^\d{6}$/, 'Expected the 6-digit code.'));

/**
 * Proof of the second factor held now: the app's 6-digit code, or one of the recovery
 * codes (`xxxxx-xxxxx`), which is then used up.
 */
export const currentCodeSchema = z
  .string()
  .trim()
  .min(6)
  .max(32)
  .transform((value) => (/^[\d\s]+$/.test(value) ? value.replace(/\s/g, '') : value));

/**
 * Both factors (D-702, D-703, D-705): what every change to how a person signs in asks for,
 * so a stolen session that has learnt the password still cannot take the account.
 */
export const factorProofSchema = z.object({
  password: typedPassword,
  code: currentCodeSchema,
});
export type FactorProofInput = z.infer<typeof factorProofSchema>;

/** Setting two-step sign-in up on a new phone, step 1: the password and the code held now. */
export const newAuthenticatorSchema = factorProofSchema;
/** New recovery codes: the password and the code held now. */
export const backupCodesRenewSchema = factorProofSchema;

export const passwordChangeSchema = z
  .object({
    currentPassword: typedPassword,
    /** The code held now: the app's, or a recovery code. */
    code: currentCodeSchema,
    newPassword: z.string().min(PASSWORD_MIN_LENGTH).max(PASSWORD_MAX_LENGTH),
    /** End every other session of this person; this one stays signed in. */
    signOutOtherDevices: z.boolean().default(true),
  })
  .refine((value) => value.newPassword !== value.currentPassword, {
    message: 'The new password must differ from the current one.',
    path: ['newPassword'],
  });
export type PasswordChangeInput = z.infer<typeof passwordChangeSchema>;

/** Step 2: the first code the new phone shows, and whether to end the other sessions. */
export const confirmAuthenticatorSchema = z.object({
  code: totpCodeSchema,
  signOutOtherDevices: z.boolean().default(false),
});
export type ConfirmAuthenticatorInput = z.infer<typeof confirmAuthenticatorSchema>;

/** A Better Auth session id, as the devices list hands it out. Never a session token. */
export const sessionIdParamSchema = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
