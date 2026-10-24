import type { ConnectCourierInput, CourierAccount, CourierProvider } from '../courier/api.js';
import type { CourierParty, ZoneRow } from './api.js';
import type { CourierSetupKey } from './couriers-messages.js';

/**
 * Settings → Couriers' pure parts (D-913): which couriers "Add courier" offers, which fields
 * each asks for, the body it sends, and the rows the list shows.
 */

/** The three couriers the owner named, in the order he named them. */
export const PRIMARY_PROVIDERS = ['steadfast', 'pathao', 'carrybee'] as const;

/** The test adapter: real accounts never use it, so "Add courier" never offers it. */
const TEST_PROVIDER = 'fake';

export type ConnectKind = 'api' | 'panel';

/** `api` books through the courier's API; `panel` (Carrybee) is booked in its own panel. */
export function connectOf(provider: CourierProvider | undefined): ConnectKind {
  return provider?.connect ?? 'api';
}

/**
 * Step 1's choices: Steadfast, Pathao and Carrybee first, whether or not they are switched on
 * here (a switched-off one says so and cannot be chosen), then any other courier this server
 * has switched on. Never the test adapter.
 */
export function providerChoices(providers: readonly CourierProvider[]): readonly CourierProvider[] {
  const primary: readonly string[] = PRIMARY_PROVIDERS;
  const first = PRIMARY_PROVIDERS.flatMap((code) => {
    const provider = providers.find((entry) => entry.code === code);
    return provider === undefined ? [] : [provider];
  });
  const others = providers.filter(
    (entry) => !primary.includes(entry.code) && entry.code !== TEST_PROVIDER && entry.enabled,
  );
  return [...first, ...others];
}

export interface CredentialField {
  readonly name: string;
  /** Null for a field this screen has no plain label for: the server's field name is shown. */
  readonly labelKey: CourierSetupKey | null;
  /** A secret is a password input, never prefilled, never shown back. */
  readonly secret: boolean;
  readonly optional: boolean;
  readonly type: 'text' | 'password' | 'email';
  readonly autoComplete: 'new-password' | 'off';
}

const FIELD_LABELS: Readonly<Record<string, CourierSetupKey>> = {
  apiKey: 'courier.setup.field.apiKey',
  secretKey: 'courier.setup.field.secretKey',
  clientId: 'courier.setup.field.clientId',
  clientSecret: 'courier.setup.field.clientSecret',
  storeId: 'courier.setup.field.storeId',
  username: 'courier.setup.field.username',
  password: 'courier.setup.field.password',
  accessToken: 'courier.setup.field.accessToken',
};

/** Identifiers, not secrets: typed in the clear so a typo can be seen. */
const PLAIN_FIELDS = new Set(['clientId', 'storeId', 'username']);

/**
 * Optional extras a courier's adapter accepts beyond `credentialFields`: Pathao's password
 * grant (pathao.adapter sends it only when both are there).
 */
const OPTIONAL_FIELDS: Readonly<Record<string, readonly string[]>> = {
  pathao: ['username', 'password'],
};

/** Typed into Advanced → Webhook secret, not here: the providers list leaves it out too. */
const NOT_A_KEY = 'webhookToken';

function fieldOf(name: string, optional: boolean): CredentialField {
  const secret = !PLAIN_FIELDS.has(name);
  return {
    name,
    labelKey: FIELD_LABELS[name] ?? null,
    secret,
    optional,
    type: name === 'username' ? 'email' : secret ? 'password' : 'text',
    // Never the browser's saved sign-in: that would be the console's own email and password.
    autoComplete: secret ? 'new-password' : 'off',
  };
}

/** The fields step 2 asks for: none for a courier booked in its own panel. */
export function credentialFieldsOf(provider: CourierProvider): readonly CredentialField[] {
  if (connectOf(provider) === 'panel') return [];
  const required = provider.credentialFields.filter((name) => name !== NOT_A_KEY);
  const optional = (OPTIONAL_FIELDS[provider.code] ?? []).filter(
    (name) => !required.includes(name),
  );
  return [
    ...required.map((name) => fieldOf(name, false)),
    ...optional.map((name) => fieldOf(name, true)),
  ];
}

export type ConnectionProblem = 'missing' | 'pairNeeded';

/**
 * The `POST /v1/courier/connections` body, or why it cannot be sent yet.
 *
 * Every required key must be typed. Optional ones are sent only when typed, and Pathao's
 * email and password go together or not at all. Keys are trimmed (a pasted key often carries
 * a space); a password is sent exactly as typed.
 */
export function connectionBody(
  provider: CourierProvider,
  values: Readonly<Record<string, string>>,
  isDefault: boolean,
):
  | { readonly ok: true; readonly body: ConnectCourierInput }
  | { readonly ok: false; readonly problem: ConnectionProblem } {
  const fields = credentialFieldsOf(provider);
  const credentials: Record<string, string> = {};
  for (const field of fields) {
    const raw = values[field.name] ?? '';
    if (raw.trim() === '') {
      if (!field.optional) return { ok: false, problem: 'missing' };
      continue;
    }
    credentials[field.name] = field.name === 'password' ? raw : raw.trim();
  }
  const optional = fields.filter((field) => field.optional).map((field) => field.name);
  const typed = optional.filter((name) => Object.hasOwn(credentials, name)).length;
  if (typed !== 0 && typed !== optional.length) return { ok: false, problem: 'pairNeeded' };
  return { ok: true, body: { provider: provider.code, credentials, isDefault } };
}

/** "Make default" alone: the keys already saved stay, nothing new is typed. */
export function makeDefaultBody(providerCode: string): ConnectCourierInput {
  return { provider: providerCode, credentials: {}, isDefault: true };
}

/** The brand's default courier as the server reads the delivery zones (D-913). */
export interface DefaultState {
  /** Null when there is none, or when the zones disagree. */
  readonly courierId: string | null;
  readonly name: string | null;
  /** The active zones name different couriers (§9's per-zone defaults). */
  readonly mixed: boolean;
}

/**
 * The default as `GET /v1/courier/accounts` states it. An older server sends only each
 * account's `isDefault`: then a row marked default is the default and nothing is known of the
 * zones, so `mixed` is false and a brand with no default row reads as having none.
 */
export function defaultStateOf(
  list:
    | {
        readonly defaultCourierId?: string | null;
        readonly defaultCourierName?: string | null;
        readonly zonesMixed?: boolean;
      }
    | undefined,
  rows: readonly CourierRow[],
): DefaultState {
  if (list?.defaultCourierId !== undefined) {
    return {
      courierId: list.defaultCourierId,
      name: list.defaultCourierName ?? null,
      mixed: list.zonesMixed === true,
    };
  }
  const row = rows.find((entry) => entry.isDefault);
  return { courierId: row?.courierId ?? null, name: row?.name ?? null, mixed: false };
}

/**
 * Where "Use as the default courier" starts for a courier being added: on only when the brand
 * has no default courier at all. Never when the zones name different couriers (turning it on
 * would replace each zone's own choice), nor when a courier with no row here is the default
 * (the brand's own rider): those are choices someone made, and one Save must not undo them.
 */
export function defaultSwitchStartsOn(state: DefaultState): boolean {
  return state.courierId === null && !state.mixed;
}

export type DefaultWarning =
  { readonly kind: 'mixed' } | { readonly kind: 'replaces'; readonly current: string };

/**
 * What turning the switch on replaces, said under it before Save: every zone's own courier
 * when the zones differ, or the courier new orders go to now. Null when nothing is replaced.
 */
export function defaultWarning(
  state: DefaultState,
  courierId: string | null,
  unknownName: string,
): DefaultWarning | null {
  if (state.mixed) return { kind: 'mixed' };
  if (state.courierId !== null && state.courierId !== courierId) {
    return { kind: 'replaces', current: state.name ?? unknownName };
  }
  return null;
}

export type CourierRowState = 'connected' | 'notConnected' | 'panel' | 'off';

export interface CourierRow {
  readonly key: string;
  readonly courierId: string;
  readonly name: string;
  readonly providerCode: string;
  readonly provider: CourierProvider | undefined;
  readonly state: CourierRowState;
  readonly isDefault: boolean;
  /** The API account behind the row; null for a courier booked in its own panel. */
  readonly account: CourierAccount | null;
}

function stateOf(account: CourierAccount | null, provider: CourierProvider | undefined) {
  if (provider !== undefined && connectOf(provider) === 'panel') return 'panel' as const;
  if (!provider?.enabled) return 'off' as const;
  if (!account?.isActive) return 'notConnected' as const;
  const keyed = account.hasCredentials === true || provider.credentialFields.length === 0;
  return keyed ? ('connected' as const) : ('notConnected' as const);
}

/**
 * The list: every courier account, and every courier party with no account that a provider
 * here can connect (Carrybee's party, made when it was added).
 *
 * The default is the server's word: `defaultCourierId` when it sends one, else each account's
 * `isDefault`. A party with no account has neither, so it reads as the default when no
 * account is and every active delivery zone defaults to it (§9's zone default courier).
 */
export function courierRows(input: {
  readonly accounts: readonly CourierAccount[];
  readonly defaultCourierId?: string | null | undefined;
  readonly providers: readonly CourierProvider[];
  readonly parties: readonly CourierParty[];
  readonly zones: readonly ZoneRow[];
  readonly unknownName: string;
}): readonly CourierRow[] {
  const providerOf = (code: string) =>
    input.providers.find((entry) => entry.code.toLowerCase() === code.toLowerCase());
  const partyName = (courierId: string) =>
    input.parties.find((party) => party.id === courierId)?.name;
  const anAccountIsDefault = input.accounts.some((account) => account.isDefault === true);
  const activeZones = input.zones.filter((zone) => zone.isActive);
  const zonesDefaultTo = (courierId: string) =>
    activeZones.length > 0 && activeZones.every((zone) => zone.defaultCourierId === courierId);
  const isDefault = (courierId: string, account: CourierAccount | null): boolean => {
    if (input.defaultCourierId !== undefined) return input.defaultCourierId === courierId;
    if (account !== null) return account.isDefault === true;
    return !anAccountIsDefault && zonesDefaultTo(courierId);
  };

  const rows: CourierRow[] = input.accounts.map((account) => {
    const provider = providerOf(account.providerCode);
    return {
      key: `account:${account.id}`,
      courierId: account.courierId,
      name:
        account.name ??
        provider?.name ??
        partyName(account.courierId) ??
        (account.label === '' ? input.unknownName : account.label),
      providerCode: account.providerCode,
      provider,
      state: stateOf(account, provider),
      isDefault: isDefault(account.courierId, account),
      account,
    };
  });

  const covered = new Set(input.accounts.map((account) => account.courierId));
  for (const party of input.parties) {
    if (!party.isActive || covered.has(party.id)) continue;
    const provider = providerOf(party.code);
    if (provider === undefined || provider.code === TEST_PROVIDER) continue;
    rows.push({
      key: `party:${party.id}`,
      courierId: party.id,
      name: party.name,
      providerCode: provider.code,
      provider,
      state: stateOf(null, provider),
      isDefault: isDefault(party.id, null),
      account: null,
    });
  }

  return rows.sort(
    (a, b) => Number(b.isDefault) - Number(a.isDefault) || a.name.localeCompare(b.name),
  );
}

/**
 * Which actions a row offers a person who may change couriers. "Make default" also needs the
 * delivery zones' `update Catalog` (`mayChangeDefault`), as the server asks: the default is
 * every zone's courier.
 */
export function rowActions(
  row: CourierRow,
  mayChangeDefault = true,
): {
  readonly makeDefault: boolean;
  readonly keys: 'change' | 'connect' | null;
  readonly advanced: boolean;
} {
  const usable = row.state === 'connected' || row.state === 'panel';
  let keys: 'change' | 'connect' | null = null;
  if (row.provider !== undefined && row.state !== 'off' && connectOf(row.provider) === 'api') {
    if (credentialFieldsOf(row.provider).length > 0) {
      keys = row.account?.hasCredentials === true ? 'change' : 'connect';
    } else if (row.state === 'notConnected') {
      keys = 'connect';
    }
  }
  return {
    makeDefault: usable && !row.isDefault && mayChangeDefault,
    keys,
    advanced: row.account !== null,
  };
}
