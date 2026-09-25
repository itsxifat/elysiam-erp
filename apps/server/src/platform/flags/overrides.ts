import { FEATURE_FLAG_KEYS, isFeatureFlagKey, type FeatureFlagKey } from './flag-keys.js';

/**
 * The per-environment half of D-031.
 *
 * `FEATURE_FLAGS=courier.auto_book=on,inbox.chatwoot=off` in the deployment's
 * environment. It applies to every org in that deployment and it **beats the
 * database row**, which is the decision worth explaining:
 *
 * - It is the kill switch. When a half-launched module is melting production at
 *   two in the morning, the lever has to be one that works when the thing that
 *   is broken might be the code path that writes flag rows — or the database
 *   the operator would have to reach to write them.
 * - It is how staging enables a dark module for all five orgs without seeding
 *   five rows into a database that gets reset.
 *
 * The cost is honest: flipping it needs a restart, and a row that disagrees
 * looks ignored. Both are visible — `FeatureFlagState.source` says
 * `environment`, so the admin screen can show *why* a flag is not obeying the
 * database, which is the part an operator would otherwise have to guess.
 *
 * Parsing is strict. An unknown key or an unparseable value throws at boot
 * rather than being skipped, because a mistyped kill switch that silently does
 * nothing is exactly the failure this mechanism exists to prevent.
 */

export type FlagOverrides = ReadonlyMap<FeatureFlagKey, boolean>;

const TRUE = new Set(['on', 'true', '1', 'yes', 'enabled']);
const FALSE = new Set(['off', 'false', '0', 'no', 'disabled']);

/** The variable that carries the overrides. */
export const FLAG_OVERRIDES_ENV = 'FEATURE_FLAGS';

export function parseFlagOverrides(raw: string | undefined): FlagOverrides {
  const overrides = new Map<FeatureFlagKey, boolean>();
  if (raw === undefined || raw.trim() === '') return overrides;

  for (const clause of raw.split(',')) {
    const text = clause.trim();
    if (text === '') continue;

    const separator = text.indexOf('=');
    if (separator === -1) {
      throw new Error(
        `${FLAG_OVERRIDES_ENV}: "${text}" is not key=value. Write e.g. "courier.auto_book=on".`,
      );
    }

    const key = text.slice(0, separator).trim();
    const value = text
      .slice(separator + 1)
      .trim()
      .toLowerCase();

    if (!isFeatureFlagKey(key)) {
      throw new Error(
        `${FLAG_OVERRIDES_ENV}: "${key}" is not a known flag. Known flags: ${FEATURE_FLAG_KEYS.join(', ')}.`,
      );
    }
    if (!TRUE.has(value) && !FALSE.has(value)) {
      throw new Error(
        `${FLAG_OVERRIDES_ENV}: "${key}" is set to "${value}", which is neither on nor off.`,
      );
    }
    if (overrides.has(key)) {
      throw new Error(
        `${FLAG_OVERRIDES_ENV}: "${key}" is set twice. One of the two is being ignored, and nobody can tell which.`,
      );
    }

    overrides.set(key, TRUE.has(value));
  }

  return overrides;
}

/** Read the overrides out of the process environment. */
export function flagOverridesFromEnv(env: NodeJS.ProcessEnv = process.env): FlagOverrides {
  return parseFlagOverrides(env[FLAG_OVERRIDES_ENV]);
}
