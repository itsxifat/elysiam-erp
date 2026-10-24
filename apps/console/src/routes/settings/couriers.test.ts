import { describe, expect, it } from 'vitest';

import type { CourierAccount, CourierProvider } from '../courier/api.js';
import type { CourierParty, ZoneRow } from './api.js';
import {
  connectionBody,
  courierRows,
  credentialFieldsOf,
  defaultStateOf,
  defaultSwitchStartsOn,
  defaultWarning,
  makeDefaultBody,
  providerChoices,
  rowActions,
} from './couriers-logic.js';
import { courierSetupMessages, withName } from './couriers-messages.js';

/**
 * Settings → Couriers made simple (D-913): the three choices, only the chosen courier's keys,
 * the body `POST /v1/courier/connections` receives, and the rows the list shows.
 */

const STEADFAST: CourierProvider = {
  code: 'steadfast',
  name: 'Steadfast',
  connect: 'api',
  verified: false,
  enabled: true,
  supportsWebhook: true,
  credentialFields: ['apiKey', 'secretKey'],
};
const PATHAO: CourierProvider = {
  code: 'pathao',
  name: 'Pathao',
  connect: 'api',
  verified: false,
  enabled: true,
  supportsWebhook: true,
  credentialFields: ['clientId', 'clientSecret', 'storeId'],
};
const CARRYBEE: CourierProvider = {
  code: 'carrybee',
  name: 'Carrybee',
  connect: 'panel',
  verified: false,
  enabled: true,
  supportsWebhook: false,
  credentialFields: [],
};
const REDX: CourierProvider = {
  code: 'redx',
  name: 'RedX',
  verified: false,
  enabled: false,
  supportsWebhook: false,
  credentialFields: ['accessToken'],
};
const FAKE: CourierProvider = {
  code: 'fake',
  name: 'Fake',
  verified: true,
  enabled: true,
  supportsWebhook: true,
  credentialFields: [],
};

function account(overrides: Partial<CourierAccount>): CourierAccount {
  return {
    id: 'acc-1',
    courierId: 'courier-steadfast',
    label: 'Steadfast',
    providerCode: 'steadfast',
    isActive: true,
    verified: false,
    hasCredentials: true,
    ...overrides,
  };
}

function zone(overrides: Partial<ZoneRow>): ZoneRow {
  return {
    id: 'z',
    code: 'inside_dhaka',
    nameEn: 'Inside Dhaka',
    nameBn: '',
    chargePoisha: '6000',
    defaultCourierId: null,
    position: 0,
    isActive: true,
    ...overrides,
  };
}

const party = (id: string, code: string, name: string): CourierParty => ({
  id,
  code,
  name,
  isActive: true,
});

describe('step 1 offers Steadfast, Pathao and Carrybee', () => {
  it('in that order, never the test courier, and another courier only when switched on', () => {
    const codes = (providers: readonly CourierProvider[]) =>
      providerChoices(providers).map((entry) => entry.code);
    expect(codes([FAKE, REDX, CARRYBEE, PATHAO, STEADFAST])).toEqual([
      'steadfast',
      'pathao',
      'carrybee',
    ]);
    expect(codes([STEADFAST, { ...REDX, enabled: true }])).toEqual(['steadfast', 'redx']);
  });

  it('keeps a switched-off one of the three, so the screen can say it is off', () => {
    const choices = providerChoices([{ ...PATHAO, enabled: false }, STEADFAST]);
    expect(choices.map((entry) => [entry.code, entry.enabled])).toEqual([
      ['steadfast', true],
      ['pathao', false],
    ]);
  });
});

describe('step 2 asks only for that courier’s keys', () => {
  it('Steadfast: the API key and the secret key, both secret', () => {
    const fields = credentialFieldsOf(STEADFAST);
    expect(fields.map((field) => [field.name, field.type, field.optional])).toEqual([
      ['apiKey', 'password', false],
      ['secretKey', 'password', false],
    ]);
    expect(fields.every((field) => field.autoComplete === 'new-password')).toBe(true);
  });

  it('Pathao: client id, client secret and store id, then an optional email and password', () => {
    expect(
      credentialFieldsOf(PATHAO).map((field) => [field.name, field.type, field.optional]),
    ).toEqual([
      ['clientId', 'text', false],
      ['clientSecret', 'password', false],
      ['storeId', 'text', false],
      ['username', 'email', true],
      ['password', 'password', true],
    ]);
  });

  it('Carrybee: nothing to type', () => {
    expect(credentialFieldsOf(CARRYBEE)).toEqual([]);
  });

  it('never asks for the webhook token here, and labels every field it knows in plain words', () => {
    const fields = credentialFieldsOf({
      ...STEADFAST,
      credentialFields: ['apiKey', 'secretKey', 'webhookToken'],
    });
    expect(fields.map((field) => field.name)).toEqual(['apiKey', 'secretKey']);
    for (const provider of [STEADFAST, PATHAO, REDX]) {
      for (const field of credentialFieldsOf(provider)) {
        expect(field.labelKey).not.toBeNull();
        expect(courierSetupMessages.en[field.labelKey ?? 'courier.setup.add']).toBeTruthy();
      }
    }
  });
});

describe('the connection body', () => {
  it('sends the typed keys, trimmed, with the default switch', () => {
    expect(connectionBody(STEADFAST, { apiKey: ' key-1 ', secretKey: 'sec-2' }, true)).toEqual({
      ok: true,
      body: {
        provider: 'steadfast',
        credentials: { apiKey: 'key-1', secretKey: 'sec-2' },
        isDefault: true,
      },
    });
  });

  it('refuses a missing key', () => {
    expect(connectionBody(STEADFAST, { apiKey: 'key-1', secretKey: '  ' }, false)).toEqual({
      ok: false,
      problem: 'missing',
    });
  });

  it('sends Pathao’s email and password together or not at all, the password as typed', () => {
    const keys = { clientId: 'c', clientSecret: 's', storeId: '42' };
    const without = connectionBody(PATHAO, keys, false);
    expect(without.ok && without.body.credentials).toEqual(keys);
    expect(connectionBody(PATHAO, { ...keys, username: 'a@b.test' }, false)).toEqual({
      ok: false,
      problem: 'pairNeeded',
    });
    const both = connectionBody(PATHAO, { ...keys, username: 'a@b.test', password: ' pw ' }, false);
    expect(both.ok && both.body.credentials).toEqual({
      ...keys,
      username: 'a@b.test',
      password: ' pw ',
    });
  });

  it('sends Carrybee with no keys, and nothing it was not asked for', () => {
    expect(connectionBody(CARRYBEE, { apiKey: 'stray' }, true)).toEqual({
      ok: true,
      body: { provider: 'carrybee', credentials: {}, isDefault: true },
    });
  });

  it('"Make default" alone sends no keys', () => {
    expect(makeDefaultBody('pathao')).toEqual({
      provider: 'pathao',
      credentials: {},
      isDefault: true,
    });
  });
});

describe('the list', () => {
  const providers = [STEADFAST, PATHAO, CARRYBEE, REDX, FAKE];

  it('shows each account by its courier’s name, connected or not, the default first', () => {
    const rows = courierRows({
      accounts: [
        account({ id: 'a1', name: 'Steadfast', isDefault: false }),
        account({
          id: 'a2',
          courierId: 'courier-pathao',
          providerCode: 'pathao',
          label: 'Pathao main',
          isDefault: true,
        }),
        account({
          id: 'a3',
          courierId: 'courier-redx',
          providerCode: 'redx',
          label: 'RedX',
        }),
      ],
      providers,
      parties: [],
      zones: [],
      unknownName: 'Courier',
    });
    expect(rows.map((row) => [row.name, row.state, row.isDefault])).toEqual([
      ['Pathao', 'connected', true],
      ['RedX', 'off', false],
      ['Steadfast', 'connected', false],
    ]);
  });

  it('an account without keys, or switched off, is not connected', () => {
    const rows = courierRows({
      accounts: [
        account({ id: 'a1', hasCredentials: false }),
        account({ id: 'a2', courierId: 'c2', providerCode: 'pathao', isActive: false }),
      ],
      providers,
      parties: [],
      zones: [],
      unknownName: 'Courier',
    });
    expect(rows.map((row) => row.state)).toEqual(['notConnected', 'notConnected']);
  });

  it('shows Carrybee from its courier party, booked in its panel', () => {
    const rows = courierRows({
      accounts: [account({ isDefault: true })],
      providers,
      parties: [
        party('courier-steadfast', 'steadfast', 'Steadfast'),
        party('courier-carrybee', 'carrybee', 'Carrybee'),
        party('own', 'own_rider', 'Own rider'),
      ],
      zones: [zone({ defaultCourierId: 'courier-carrybee' })],
      unknownName: 'Courier',
    });
    expect(rows.map((row) => [row.name, row.state, row.isDefault, row.account === null])).toEqual([
      ['Steadfast', 'connected', true, false],
      // An account is the default, so the zones' default does not make Carrybee a second one.
      ['Carrybee', 'panel', false, true],
    ]);
  });

  it('a panel courier is the default when no account is and every active zone defaults to it', () => {
    const rows = courierRows({
      accounts: [account({ isDefault: false })],
      providers,
      parties: [party('courier-carrybee', 'carrybee', 'Carrybee')],
      zones: [
        zone({ id: 'z1', defaultCourierId: 'courier-carrybee' }),
        zone({ id: 'z2', defaultCourierId: 'own', isActive: false }),
      ],
      unknownName: 'Courier',
    });
    expect(rows.map((row) => [row.name, row.isDefault])).toEqual([
      ['Carrybee', true],
      ['Steadfast', false],
    ]);
  });

  it('takes the server’s default courier id over everything else when it sends one', () => {
    const rows = courierRows({
      accounts: [account({ isDefault: true })],
      defaultCourierId: 'courier-carrybee',
      providers,
      parties: [party('courier-carrybee', 'carrybee', 'Carrybee')],
      zones: [],
      unknownName: 'Courier',
    });
    expect(rows.map((row) => [row.name, row.isDefault])).toEqual([
      ['Carrybee', true],
      ['Steadfast', false],
    ]);
  });
});

describe('the row actions', () => {
  const rowsOf = (accounts: CourierAccount[], parties: CourierParty[] = []) =>
    courierRows({
      accounts,
      providers: [STEADFAST, PATHAO, CARRYBEE, REDX],
      parties,
      zones: [],
      unknownName: 'Courier',
    });

  it('a connected courier can be made the default and have its keys changed', () => {
    const [row] = rowsOf([account({ isDefault: false })]);
    expect(row === undefined ? null : rowActions(row)).toEqual({
      makeDefault: true,
      keys: 'change',
      advanced: true,
    });
  });

  it('the default is not offered "Make default"; an unkeyed account offers Connect', () => {
    const [row] = rowsOf([account({ isDefault: true, hasCredentials: false })]);
    expect(row === undefined ? null : rowActions(row)).toEqual({
      makeDefault: false,
      keys: 'connect',
      advanced: true,
    });
  });

  it('Carrybee has no keys and no advanced settings, only "Make default"', () => {
    const [row] = rowsOf([], [party('cb', 'carrybee', 'Carrybee')]);
    expect(row === undefined ? null : rowActions(row)).toEqual({
      makeDefault: true,
      keys: null,
      advanced: false,
    });
  });

  it('a courier switched off on this server offers neither', () => {
    const [row] = rowsOf([account({ courierId: 'rx', providerCode: 'redx' })]);
    expect(row === undefined ? null : rowActions(row)).toEqual({
      makeDefault: false,
      keys: null,
      advanced: true,
    });
  });

  it('"Make default" is not offered to a role that cannot edit delivery zones', () => {
    const [row] = rowsOf([account({ isDefault: false })]);
    expect(row === undefined ? null : rowActions(row, false)).toEqual({
      makeDefault: false,
      keys: 'change',
      advanced: true,
    });
  });
});

describe('the default switch', () => {
  const OWN_RIDER = { courierId: 'own-rider', name: 'Own rider', mixed: false };

  it('reads the server’s zone default, even for a courier with no row (the own rider)', () => {
    const rows = courierRows({
      accounts: [account({ isDefault: false })],
      defaultCourierId: 'own-rider',
      providers: [STEADFAST],
      parties: [],
      zones: [],
      unknownName: 'Courier',
    });
    expect(rows.some((row) => row.isDefault)).toBe(false);
    expect(
      defaultStateOf(
        { defaultCourierId: 'own-rider', defaultCourierName: 'Own rider', zonesMixed: false },
        rows,
      ),
    ).toEqual(OWN_RIDER);
    expect(
      defaultStateOf({ defaultCourierId: null, defaultCourierName: null, zonesMixed: true }, rows),
    ).toEqual({ courierId: null, name: null, mixed: true });
  });

  it('an older server: the row marked default, else none, and nothing known of the zones', () => {
    const rows = courierRows({
      accounts: [account({ isDefault: true })],
      providers: [STEADFAST],
      parties: [],
      zones: [],
      unknownName: 'Courier',
    });
    expect(defaultStateOf({}, rows)).toEqual({
      courierId: 'courier-steadfast',
      name: 'Steadfast',
      mixed: false,
    });
    expect(defaultStateOf(undefined, [])).toEqual({ courierId: null, name: null, mixed: false });
  });

  it('starts on only when the brand has no default courier at all', () => {
    expect(defaultSwitchStartsOn({ courierId: null, name: null, mixed: false })).toBe(true);
    // The zones disagree: per-zone choices someone made, not "no default".
    expect(defaultSwitchStartsOn({ courierId: null, name: null, mixed: true })).toBe(false);
    // The own rider is the default though it has no row here.
    expect(defaultSwitchStartsOn(OWN_RIDER)).toBe(false);
  });

  it('warns what turning it on replaces', () => {
    expect(defaultWarning({ courierId: null, name: null, mixed: true }, null, 'Courier')).toEqual({
      kind: 'mixed',
    });
    expect(defaultWarning(OWN_RIDER, 'courier-pathao', 'Courier')).toEqual({
      kind: 'replaces',
      current: 'Own rider',
    });
    expect(defaultWarning(OWN_RIDER, 'own-rider', 'Courier')).toBeNull();
    expect(defaultWarning({ courierId: null, name: null, mixed: false }, null, 'Courier')).toBe(
      null,
    );
  });
});

describe('the strings', () => {
  it('say Carrybee’s one plain line with its name filled in twice', () => {
    expect(withName(courierSetupMessages.en['courier.setup.panelNote'], 'Carrybee')).toBe(
      'Carrybee has no API connection yet: book its parcels in Carrybee’s merchant panel.',
    );
  });
});
