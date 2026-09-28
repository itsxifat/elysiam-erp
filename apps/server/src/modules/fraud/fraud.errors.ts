import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  NotFoundException,
} from '@nestjs/common';
import type { ErrorCode } from '@elysium/contracts';
import { FraudBandsError } from '@elysium/domain/fraud';
import { OrderError } from '@elysium/domain';

/**
 * Fraud failures, as the API reports them (architecture §23, D-087).
 *
 * Same shape as the ledger's, the catalog's and inventory's: a stable `code` from
 * `packages/contracts/src/errors.ts` plus a message, so a client branches on the code
 * and never on the wording.
 *
 * Two mappings here are decisions rather than transcription:
 *
 * * **`ORDER_FRAUD_BLOCKED` is a 409, not a 403.** A 403 would mean "you may not do
 *   this", and the desk agent may: the request was refused because of the *buyer*, and
 *   an org_admin can override it. The order desk has to tell those apart to know
 *   whether to show an override box or hide the button.
 * * **`FRAUD_OVERRIDE_UNAUTHORISED` is a 403**, for the mirror-image reason: the buyer
 *   is beside the point, the caller is not an org_admin.
 *
 * `databaseFraudCode` exists because migration 0047 raises five of these codes from
 * triggers, and which layer notices depends on the path. The service checks the same
 * rules, but a data-fix script or a future admin screen reaches the table directly, and
 * a caller that saw a clean code in testing and a 500 in production would be debugging
 * the wrong thing.
 */

const STATUS: Readonly<Partial<Record<ErrorCode, number>>> = {
  FRAUD_OVERRIDE_UNAUTHORISED: 403,
  FRAUD_OVERRIDE_REASON_REQUIRED: 400,
  FRAUD_OVERRIDE_IMMUTABLE: 409,
  FRAUD_FLAG_IMMUTABLE: 409,
  FRAUD_FLAG_NOT_FOUND: 404,
  FRAUD_RULES_INVALID: 400,
  FRAUD_SIGNAL_KEY_IMMUTABLE: 409,
  FRAUD_ORDER_PHONE_IMMUTABLE: 409,
  ORDER_FRAUD_BLOCKED: 409,
  ORDER_PHONE_INVALID: 400,
};

export class FraudError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'FraudError';
  }
}

export function fraudHttpError(code: ErrorCode, message: string): HttpException {
  const body = { code, message };
  switch (STATUS[code] ?? 400) {
    case 403:
      return new ForbiddenException(body);
    case 404:
      return new NotFoundException(body);
    case 409:
      return new ConflictException(body);
    default:
      return new BadRequestException(body);
  }
}

/** The codes migration 0047 raises with a `CODE: message` prefix. */
const TRIGGER_CODES: readonly ErrorCode[] = [
  'FRAUD_SIGNAL_KEY_IMMUTABLE',
  'FRAUD_OVERRIDE_IMMUTABLE',
  'FRAUD_ORDER_PHONE_IMMUTABLE',
  'FRAUD_FLAG_IMMUTABLE',
  'FRAUD_RULES_INVALID',
];

/**
 * Constraint names from 0045, and what to say instead of them.
 *
 * Never the constraint name itself: it tells a caller the shape of our schema and tells
 * the person reading the screen nothing. `phone_signals_hash_shape` is the one that
 * would be most confusing — it means a hash arrived that this key could not have
 * produced, which is a bug on our side, not something the user typed.
 */
const CHECK_MESSAGES: Readonly<Record<string, { code: ErrorCode; message: string }>> = {
  phone_signals_hash_shape: {
    code: 'FRAUD_SIGNAL_KEY_IMMUTABLE',
    message: 'That phone signal key is not a valid hash.',
  },
  provider_checks_hash_shape: {
    code: 'FRAUD_SIGNAL_KEY_IMMUTABLE',
    message: 'That phone signal key is not a valid hash.',
  },
  phone_flags_hash_shape: {
    code: 'FRAUD_FLAG_IMMUTABLE',
    message: 'That phone signal key is not a valid hash.',
  },
  phone_flags_reason_length: {
    code: 'FRAUD_FLAG_IMMUTABLE',
    message: 'A flag needs a reason between 3 and 500 characters.',
  },
  overrides_reason_length: {
    code: 'FRAUD_OVERRIDE_REASON_REQUIRED',
    message: 'An override needs a reason of at least 10 characters.',
  },
  rules_bands_decrease: {
    code: 'FRAUD_RULES_INVALID',
    message: 'Band floors must decrease strictly: allow, then warn, then require advance.',
  },
  rules_bands_in_range: {
    code: 'FRAUD_RULES_INVALID',
    message: 'Band floors must be between 0 and 100.',
  },
  rules_provider_ttl_positive: {
    code: 'FRAUD_RULES_INVALID',
    message: 'A provider cache lifetime must be at least one minute.',
  },
};

export function databaseFraudCode(error: unknown): { code: ErrorCode; message: string } | null {
  for (let current: unknown = error; current instanceof Error; current = current.cause) {
    const prefixed = /^([A-Z_]+): (.*)$/s.exec(current.message);
    if (prefixed !== null) {
      const code = TRIGGER_CODES.find((candidate) => candidate === prefixed[1]);
      if (code !== undefined) return { code, message: prefixed[2] ?? current.message };
    }

    const sqlstate = (current as { code?: unknown }).code;
    const constraint = (current as { constraint_name?: unknown }).constraint_name;
    const name = typeof constraint === 'string' ? constraint : '';

    if (sqlstate === '23514' && Object.hasOwn(CHECK_MESSAGES, name)) {
      return CHECK_MESSAGES[name] ?? null;
    }
  }
  return null;
}

export function toFraudHttpError(error: unknown): unknown {
  if (error instanceof HttpException) return error;
  if (error instanceof FraudError) return fraudHttpError(error.code, error.message);
  if (error instanceof FraudBandsError) return fraudHttpError('FRAUD_RULES_INVALID', error.message);
  // A number the desk typed that is not a Bangladeshi mobile. Raised by
  // `normalizeBdPhone` inside the hash service, so it arrives here rather than from the
  // orders module.
  if (error instanceof OrderError) return fraudHttpError(error.code, error.message);
  const fromDatabase = databaseFraudCode(error);
  if (fromDatabase !== null) return fraudHttpError(fromDatabase.code, fromDatabase.message);
  return error;
}

export async function mapFraudErrors<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    throw toFraudHttpError(error);
  }
}
