/**
 * Every feature flag that exists (D-031).
 *
 * A closed registry, not a free-form string key, and reading an unlisted key
 * throws. The reason is the failure mode of the obvious alternative: if
 * `isEnabled('reseler.portal')` returned `false` for a typo, the feature would
 * be off in production, the flag row would look correct in the database, and
 * nothing anywhere would say why. A flag whose wrong spelling is
 * indistinguishable from "switched off" is worse than no flag.
 *
 * Each entry carries the milestone that will consume it, so a flag that outlives
 * its launch is visible as dead configuration rather than accumulating forever.
 * The rule is: a flag is added in the milestone that ships the code behind it,
 * and removed in the milestone after the feature is on everywhere.
 *
 * Defaults are what an org gets with no row in `org.feature_flags`. They are all
 * `false` today, which is the point of the table — §3's "ship unfinished modules
 * dark" means a module lands in the codebase, migrations and all, and stays
 * invisible per org until somebody turns it on.
 */

export interface FeatureFlagDefinition {
  /** What turning this on does, in one line, for whoever reads the admin screen. */
  readonly description: string;
  /** The milestone that owns the code behind it. */
  readonly milestone: string;
  /** What an org with no row gets. */
  readonly default: boolean;
}

export const FEATURE_FLAGS = {
  'courier.auto_book': {
    description:
      'Book the courier automatically when an order is confirmed, instead of waiting for the order desk to press Book.',
    milestone: 'M12',
    default: false,
  },
  'fraud.phone_check': {
    description:
      'Run the cross-org phone-hash fraud check during order intake and show its verdict on the order desk.',
    milestone: 'M13',
    default: false,
  },
  'reseller.portal': {
    description: 'Let this org’s resellers sign in to the partner portal and place orders.',
    milestone: 'M22',
    default: false,
  },
  'pos.offline_queue': {
    description:
      'Let the showroom POS keep selling while the network is down and sync the queue afterwards.',
    milestone: 'M23',
    default: false,
  },
  'inbox.chatwoot': {
    description: 'Show the unified inbox and let staff reply to customers from inside the console.',
    milestone: 'M27',
    default: false,
  },
} as const satisfies Record<string, FeatureFlagDefinition>;

export type FeatureFlagKey = keyof typeof FEATURE_FLAGS;

export const FEATURE_FLAG_KEYS = Object.keys(FEATURE_FLAGS) as readonly FeatureFlagKey[];

export function isFeatureFlagKey(value: string): value is FeatureFlagKey {
  return Object.prototype.hasOwnProperty.call(FEATURE_FLAGS, value);
}

/**
 * The state of one flag for one org, and where that state came from.
 *
 * `source` is not decoration. "Why is this on in production and off in
 * staging?" is the question a flag always eventually raises, and an answer that
 * says `environment` rather than `org` saves somebody reading the database and
 * concluding the code is broken.
 */
export interface FeatureFlagState {
  readonly key: FeatureFlagKey;
  readonly enabled: boolean;
  /** The row's `value` jsonb, for a flag that carries configuration. */
  readonly value: unknown;
  readonly source: 'default' | 'org' | 'environment';
}
