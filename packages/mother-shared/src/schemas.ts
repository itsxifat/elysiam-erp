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

export const brandUpdateSchema = z
  .object({
    displayName: z.string().trim().min(1).max(120).optional(),
    adminUrl: adminUrlSchema.optional(),
    readConnection: readConnectionSchema.optional(),
    isActive: z.boolean().optional(),
  })
  .refine((value) => Object.values(value).some((field) => field !== undefined), {
    message: 'Change at least one field.',
  });
export type BrandUpdateInput = z.infer<typeof brandUpdateSchema>;

export const pullRequestSchema = z.object({
  /** Every day the brand has, rather than the recent window (D-484). */
  full: z.boolean().default(false),
});

export const inviteOwnerSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  name: z.string().trim().min(1).max(200),
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
