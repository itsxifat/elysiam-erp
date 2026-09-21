import { timestamp, uuid } from 'drizzle-orm/pg-core';

/**
 * Columns every table carries.
 *
 * Timestamps are `timestamptz` without exception (CLAUDE.md invariant 8). A
 * business date is derived from these in the Asia/Dhaka calendar by the domain
 * layer; the database stores the instant, never a local wall-clock time.
 */
export const timestamps = {
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
};

export const primaryId = uuid('id').primaryKey().defaultRandom();
