import { businessDateSchema } from '@elysium/contracts';
import { z } from 'zod';

import { MAX_ROLLUP_DAYS } from './rollup.service.js';

/**
 * The analytics module's wire shapes (M24), validated at the edge. Dates are Asia/Dhaka
 * calendar dates; a month is `YYYY-MM`.
 */

/** The longest period a dashboard or an export sums: a year and a day, so a leap year fits. */
export const MAX_DASHBOARD_DAYS = 366;

function daysInclusive(from: string, to: string): number {
  return (
    Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1
  );
}

function period(max: number) {
  return z
    .object({ from: businessDateSchema, to: businessDateSchema })
    .strict()
    .superRefine((value, context) => {
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
    });
}

export const dashboardQuerySchema = period(MAX_DASHBOARD_DAYS);
export type DashboardQuery = z.infer<typeof dashboardQuerySchema>;

export const refreshSchema = period(MAX_ROLLUP_DAYS);
export type RefreshInput = z.infer<typeof refreshSchema>;

export const exportQuerySchema = z
  .object({
    from: businessDateSchema,
    to: businessDateSchema,
    format: z.enum(['csv', 'xlsx']).default('csv'),
  })
  .strict()
  .superRefine((value, context) => {
    const days = daysInclusive(value.from, value.to);
    if (days < 1 || days > MAX_DASHBOARD_DAYS) {
      context.addIssue({
        code: 'custom',
        path: ['to'],
        message: `An export covers 1 to ${String(MAX_DASHBOARD_DAYS)} days.`,
      });
    }
  });
export type ExportQuery = z.infer<typeof exportQuerySchema>;

export const monthQuerySchema = z
  .object({ month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'A month is YYYY-MM.') })
  .strict();
export type MonthQuery = z.infer<typeof monthQuerySchema>;
