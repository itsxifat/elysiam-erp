import {
  businessDateSchema,
  nonNegativePoishaSchema,
  type ORDER_CHANNELS,
} from '@elysium/contracts';
import {
  AGE_BANDS,
  CAMPAIGN_REF_KINDS,
  LEAD_DIMENSIONS,
  LEAD_STATUSES,
} from '@elysium/domain/marketing';
import { z } from 'zod';

/**
 * The marketing module's wire shapes (architecture §11, §23; M18), validated at the edge.
 *
 * Amounts are integer poisha as decimal strings. Dates are Asia/Dhaka calendar dates.
 */

const uuid = z.string().uuid();

/** The longest period the dashboard and the import take: a quarter, as the chart draws one. */
export const MAX_PERIOD_DAYS = 92;

function daysInclusive(from: string, to: string): number {
  return (
    Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1
  );
}

function checkPeriod(value: { from: string; to: string }, context: z.RefinementCtx, max: number) {
  const days = daysInclusive(value.from, value.to);
  if (days < 1) {
    context.addIssue({
      code: 'custom',
      path: ['to'],
      message: 'The period ends before it starts.',
    });
  } else if (days > max) {
    context.addIssue({
      code: 'custom',
      path: ['to'],
      message: `A period is at most ${String(max)} days.`,
    });
  }
}

const periodFields = { from: businessDateSchema, to: businessDateSchema };

const period = z
  .object(periodFields)
  .strict()
  .superRefine((value, context) => {
    checkPeriod(value, context, MAX_PERIOD_DAYS);
  });

export const periodSchema = period;
export type PeriodInput = z.infer<typeof periodSchema>;

export const PLATFORMS = ['meta', 'google', 'tiktok', 'other'] as const;

/** A Meta id is digits; a `utm_campaign` is whatever the link carried, within reason. */
export const campaignRefSchema = z
  .object({
    kind: z.enum(CAMPAIGN_REF_KINDS),
    value: z.string().trim().min(1).max(120),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.kind !== 'utm_campaign' && !/^[0-9]{1,30}$/.test(value.value)) {
      context.addIssue({ code: 'custom', path: ['value'], message: 'A Meta id is digits only.' });
    }
  });
export type CampaignRefInput = z.infer<typeof campaignRefSchema>;

const window = <
  T extends { startsOn?: string | null | undefined; endsOn?: string | null | undefined },
>(
  value: T,
  context: z.RefinementCtx,
) => {
  if (
    typeof value.startsOn === 'string' &&
    typeof value.endsOn === 'string' &&
    value.startsOn > value.endsOn
  ) {
    context.addIssue({
      code: 'custom',
      path: ['endsOn'],
      message: 'The campaign ends before it starts.',
    });
  }
};

export const createCampaignSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    platform: z.enum(PLATFORMS),
    productIds: z.array(uuid).max(100).optional(),
    startsOn: businessDateSchema.optional(),
    endsOn: businessDateSchema.optional(),
    refs: z.array(campaignRefSchema).max(50).optional(),
  })
  .strict()
  .superRefine(window);
export type CreateCampaignInput = z.infer<typeof createCampaignSchema>;

export const updateCampaignSchema = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    platform: z.enum(PLATFORMS).optional(),
    productIds: z.array(uuid).max(100).optional(),
    startsOn: businessDateSchema.nullable().optional(),
    endsOn: businessDateSchema.nullable().optional(),
    status: z.enum(['active', 'archived']).optional(),
  })
  .strict()
  .superRefine(window);
export type UpdateCampaignInput = z.infer<typeof updateCampaignSchema>;

export const campaignListSchema = z
  .object({ status: z.enum(['active', 'archived']).optional() })
  .strict();

/** One day's figure for one campaign. Entering it again replaces it. */
export const upsertSpendSchema = z
  .object({
    campaignId: uuid,
    spendDate: businessDateSchema,
    amountPoisha: nonNegativePoishaSchema,
    note: z.string().trim().max(500).optional(),
  })
  .strict();
export type UpsertSpendInput = z.infer<typeof upsertSpendSchema>;

/** The spend screen lists up to a year at a time. */
export const spendListSchema = z
  .object({ ...periodFields, campaignId: uuid.optional() })
  .strict()
  .superRefine((value, context) => {
    checkPeriod(value, context, 366);
  });
export type SpendListInput = z.infer<typeof spendListSchema>;

export const metaImportSchema = period;

/**
 * The brand's Meta link. Every field optional, so the screen can save one switch.
 *
 * `token` is write-only: it is sealed on arrival and never comes back (§25). An empty
 * string is refused rather than read as "remove"; `clearToken` says that explicitly.
 */
export const metaConnectionSchema = z
  .object({
    adAccountId: z
      .string()
      .trim()
      .transform((value) => value.replace(/^act_/, ''))
      .pipe(z.string().regex(/^[0-9]{1,30}$/, 'An ad account id is digits (with or without act_).'))
      .nullable()
      .optional(),
    pixelId: z
      .string()
      .trim()
      .regex(/^[0-9]{1,30}$/, 'A pixel (dataset) id is digits only.')
      .nullable()
      .optional(),
    token: z.string().trim().min(20).max(1000).optional(),
    clearToken: z.literal(true).optional(),
    spendImportEnabled: z.boolean().optional(),
    capiEnabled: z.boolean().optional(),
    sendNameAndCity: z.boolean().optional(),
    testEventCode: z.string().trim().min(1).max(64).nullable().optional(),
  })
  .strict()
  .refine((value) => !(value.token !== undefined && value.clearToken === true), {
    message: 'Send a new token or clear it, not both.',
    path: ['token'],
  });
export type MetaConnectionInput = z.infer<typeof metaConnectionSchema>;

/**
 * A lead's channel: every order channel but the marketplace, whose orders arrive already
 * placed (D-556) and which `marketing.leads`' CHECK does not list.
 */
export const LEAD_CHANNELS = [
  'facebook',
  'whatsapp',
  'instagram',
  'tiktok',
  'landing_page',
  'website',
  'phone',
  'walk_in',
  'reseller',
] as const satisfies readonly (typeof ORDER_CHANNELS)[number][];

export const createLeadSchema = z
  .object({
    phone: z.string().min(6).max(32),
    name: z.string().trim().min(1).max(200).optional(),
    channel: z.enum(LEAD_CHANNELS),
    campaignId: uuid.optional(),
    skuId: uuid.optional(),
    size: z.string().trim().min(1).max(40).optional(),
    ageBand: z.enum(AGE_BANDS).optional(),
    profession: z.string().trim().min(1).max(80).optional(),
    status: z.enum(LEAD_STATUSES).optional(),
    notes: z.string().trim().max(1000).optional(),
  })
  .strict();
export type CreateLeadInput = z.infer<typeof createLeadSchema>;

export const updateLeadSchema = z
  .object({
    name: z.string().trim().min(1).max(200).nullable().optional(),
    campaignId: uuid.nullable().optional(),
    skuId: uuid.nullable().optional(),
    size: z.string().trim().min(1).max(40).nullable().optional(),
    ageBand: z.enum(AGE_BANDS).nullable().optional(),
    profession: z.string().trim().min(1).max(80).nullable().optional(),
    status: z.enum(LEAD_STATUSES).optional(),
    notes: z.string().trim().max(1000).nullable().optional(),
  })
  .strict();
export type UpdateLeadInput = z.infer<typeof updateLeadSchema>;

export const leadListSchema = z
  .object({
    status: z.enum(LEAD_STATUSES).optional(),
    limit: z.coerce.number().int().min(1).max(200).default(100),
  })
  .strict();

/** Segments over the leads created in a period (Dhaka dates), or over all of them. */
export const segmentQuerySchema = z
  .object({
    dimension: z.enum(LEAD_DIMENSIONS),
    from: businessDateSchema.optional(),
    to: businessDateSchema.optional(),
  })
  .strict();
export type SegmentQueryInput = z.infer<typeof segmentQuerySchema>;

export const capiListSchema = z
  .object({
    status: z.enum(['queued', 'sent', 'failed', 'skipped']).optional(),
    limit: z.coerce.number().int().min(1).max(200).default(100),
  })
  .strict();

export const idParamSchema = uuid;
