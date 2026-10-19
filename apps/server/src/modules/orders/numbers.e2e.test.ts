import { withOrg, withSystem } from '@elysium/db';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { onCustomerMerged } from '../../platform/events/customer-merged.js';
import {
  ORG_A,
  ORG_B,
  auditRowsFor,
  startHttpHarness,
  type HttpHarness,
  type InjectedResponse,
  type RoleClient,
} from '../../testing/http-harness.js';
import { seedProductWithSkus } from '../inventory/inventory.testing.js';
import { moveCallsToCustomer } from '../telephony/telephony.repository.js';

/**
 * M48 on real Postgres, through the real routes (D-870 to D-889): a buyer's several numbers, one
 * number naming several people, the automatic pick and its flag, orders for someone else, retiring
 * a number, changing an order's buyer, and merging two records of one person, with RLS on the new
 * table and a telephony call following the merge.
 */

let harness: HttpHarness;
let admin: RoleClient;
let sales: RoleClient;
let skuId = '';

const ADDRESS = { districtId: 47, thanaId: 365, addressLine: 'House 7, Road 3, Savar' };

let phoneSeed = 20_000_000 + Math.floor(Math.random() * 60_000_000);
function freshPhone(): string {
  phoneSeed += 1;
  return `+88018${String(phoneSeed)}`;
}

function json<T>(response: InjectedResponse, status = 200): T {
  expect(response.statusCode, response.body).toBe(status);
  return JSON.parse(response.body) as T;
}

interface Phone {
  readonly id: string;
  readonly phone: string;
  readonly rank: number;
  readonly relation: string;
  readonly note: string | null;
  readonly needsDetails: boolean;
  readonly retired: unknown;
}

interface Customer {
  readonly id: string;
  readonly phone: string;
  readonly mergedIntoCustomerId: string | null;
  readonly phones: readonly Phone[];
  readonly stats: { readonly orders: number };
}

interface Order {
  readonly id: string;
  readonly customer: { readonly id: string };
  readonly shipTo: { readonly name: string; readonly phone: string };
  readonly placedFor: string;
  readonly placedForNote: string | null;
  readonly recipientCustomerId: string | null;
  readonly buyerCheck: string | null;
}

async function person(phone: string, name: string): Promise<string> {
  const created = json<{ id: string }>(
    // Only sales may create a buyer (§6); everyone with `update Customer` reaches one with no orders.
    await sales.client.request('POST', '/v1/customers', { body: { phone, name, newPerson: true } }),
    201,
  );
  return created.id;
}

async function customer(id: string, as: RoleClient = admin): Promise<Customer> {
  return json<Customer>(await as.client.request('GET', `/v1/customers/${id}`));
}

async function order(body: Record<string, unknown>, as: RoleClient = admin): Promise<Order> {
  const created = json<{ id: string }>(
    await as.client.request('POST', '/v1/orders', {
      body: { channel: 'phone', lines: [{ skuId, qty: 1 }], ...body },
    }),
    201,
  );
  return json<Order>(await admin.client.request('GET', `/v1/orders/${created.id}`));
}

beforeAll(async () => {
  harness = await startHttpHarness('orders-numbers');
  admin = await harness.asRole('org_admin', ORG_A);
  sales = await harness.asRole('sales', ORG_A);
  const { skus } = await seedProductWithSkus(ORG_A, 'numbers', 1);
  skuId = skus[0]?.id ?? '';
}, 120_000);

afterAll(async () => {
  await harness.close();
});

describe('several numbers per person (D-870 to D-873)', () => {
  it('backfills nothing twice, writes the first number, adds one with a note and ranks them', async () => {
    const own = freshPhone();
    const id = await person(own, 'Nasrin Akter');
    const first = await customer(id);
    expect(first.phones).toHaveLength(1);
    expect(first.phones[0]).toMatchObject({ phone: own, rank: 1, relation: 'own' });
    expect(first.phones[0]?.needsDetails).toBe(true);

    // Staff must say why.
    const office = freshPhone();
    const noNote = await admin.client.request('POST', `/v1/customers/${id}/phones`, {
      body: { phone: office, relation: 'work' },
    });
    expect(noNote.statusCode).toBe(400);
    const added = json<{ phones: Phone[] }>(
      await admin.client.request('POST', `/v1/customers/${id}/phones`, {
        body: {
          phone: office,
          kind: 'office',
          relation: 'work',
          note: 'Her office, weekdays 10 to 5',
        },
      }),
      201,
    );
    expect(added.phones.map((phone) => [phone.phone, phone.rank])).toEqual([
      [own, 1],
      [office, 2],
    ]);

    // Make primary: the buyer row's copy follows, in the same transaction.
    const officeId = added.phones[1]?.id ?? '';
    json(
      await admin.client.request('PATCH', `/v1/customers/${id}/phones/${officeId}`, {
        body: { rank: 1 },
      }),
    );
    const after = await customer(id);
    expect(after.phone).toBe(office);
    expect(after.phones.find((phone) => phone.rank === 1)?.phone).toBe(office);

    const audit = await auditRowsFor(ORG_A, id);
    const addedRow = audit.find((row) => row.action === 'customer.phone_added');
    // Invariant 10: the note's length, never its text; the number masked by its field name.
    expect(JSON.stringify(addedRow?.after)).not.toContain('weekdays');
    expect(JSON.stringify(addedRow?.after)).not.toContain(office);
  });

  it('keeps every brand’s numbers to itself (RLS ENABLE + FORCE)', async () => {
    const phone = freshPhone();
    const id = await person(phone, 'Rls Probe');
    const [flags] = await withSystem((tx) =>
      tx.execute<{ rls: boolean; forced: boolean }>(sql`
        select relrowsecurity as rls, relforcerowsecurity as forced from pg_class
        where oid = 'sales.customer_phones'::regclass
      `),
    );
    expect(flags).toEqual({ rls: true, forced: true });
    const seen = await withOrg({ orgId: ORG_B, userId: 'usr_numbers_test' }, (tx) =>
      tx.execute<{ n: number }>(sql`
        select count(*)::int as n from sales.customer_phones where customer_id = ${id}
      `),
    );
    expect(seen[0]?.n).toBe(0);
    await expect(
      withOrg({ orgId: ORG_B, userId: 'usr_numbers_test' }, (tx) =>
        tx.execute(sql`
          insert into sales.customer_phones (org_id, customer_id, phone_e164, rank, source)
          values (${ORG_A}, ${id}, ${freshPhone()}, 2, 'import')
        `),
      ),
    ).rejects.toThrow();
  });
});

describe('one number, several people (D-874 to D-877)', () => {
  it('lists everyone on the number, picks the primary own one automatically and flags the order', async () => {
    const home = freshPhone();
    const father = await person(home, 'Abdul Karim');
    const daughter = await person(freshPhone(), 'Sumaiya Karim');
    json(
      await admin.client.request('POST', `/v1/customers/${daughter}/phones`, {
        body: { phone: home, kind: 'home', relation: 'household', note: 'Home phone, evenings' },
      }),
      201,
    );

    const lookup = json<{
      customer: { id: string };
      candidates: { customerId: string; suggested: boolean }[];
    }>(await admin.client.request('GET', `/v1/customers/lookup?phone=${encodeURIComponent(home)}`));
    expect(lookup.candidates.map((candidate) => candidate.customerId).sort()).toEqual(
      [father, daughter].sort(),
    );
    expect(lookup.candidates.find((candidate) => candidate.suggested)?.customerId).toBe(father);
    // The chooser's pick shows that person instead.
    const chosen = json<{ customer: { id: string } }>(
      await admin.client.request(
        'GET',
        `/v1/customers/lookup?phone=${encodeURIComponent(home)}&customerId=${daughter}`,
      ),
    );
    expect(chosen.customer.id).toBe(daughter);

    // An order by phone alone is the automatic path: the father, flagged for the desk.
    const automatic = await order({ customer: { phone: home, name: 'Karim', address: ADDRESS } });
    expect(automatic.customer.id).toBe(father);
    expect(automatic.buyerCheck).toBe('shared_number');
    const flagged = json<{ items: { id: string }[] }>(
      await admin.client.request('GET', '/v1/orders?buyerCheck=shared_number&limit=100'),
    );
    expect(flagged.items.map((item) => item.id)).toContain(automatic.id);

    // A person chose the buyer: nothing to check.
    const chosenOrder = await order({ customerId: daughter, shipTo: { ...ADDRESS } });
    expect(chosenOrder.buyerCheck).toBeNull();

    // "The buyer is right" clears it, for whoever may work the order.
    json(await sales.client.request('POST', `/v1/orders/${automatic.id}/buyer-checked`), 201);
    const cleared = json<Order>(await admin.client.request('GET', `/v1/orders/${automatic.id}`));
    expect(cleared.buyerCheck).toBeNull();

    // Search finds the daughter by her secondary number.
    const found = json<{ items: { id: string }[] }>(
      await admin.client.request('GET', `/v1/customers?q=${encodeURIComponent(home.slice(4))}`),
    );
    expect(found.items.map((item) => item.id)).toEqual(expect.arrayContaining([father, daughter]));
  });

  it('stops matching a retired number but keeps it in the person’s history', async () => {
    const shop = freshPhone();
    const owner = await person(shop, 'Shop Owner');
    const clerk = await person(freshPhone(), 'Shop Clerk');
    const added = json<{ phones: Phone[] }>(
      await admin.client.request('POST', `/v1/customers/${clerk}/phones`, {
        body: { phone: shop, kind: 'shop', relation: 'work', note: 'The shop’s phone' },
      }),
      201,
    );
    const shopOnClerk = added.phones.find((phone) => phone.phone === shop)?.id ?? '';

    // The last number of a person cannot be retired.
    const ownerPhones = (await customer(owner)).phones;
    const last = await admin.client.request(
      'POST',
      `/v1/customers/${owner}/phones/${ownerPhones[0]?.id ?? ''}/retire`,
      { body: { reason: 'changed_number' } },
    );
    expect(last.statusCode).toBe(400);

    json(
      await admin.client.request('POST', `/v1/customers/${clerk}/phones/${shopOnClerk}/retire`, {
        body: { reason: 'not_theirs', note: 'Left the shop' },
      }),
      201,
    );
    const lookup = json<{ candidates: { customerId: string }[] }>(
      await admin.client.request('GET', `/v1/customers/lookup?phone=${encodeURIComponent(shop)}`),
    );
    expect(lookup.candidates.map((candidate) => candidate.customerId)).toEqual([owner]);
    const history = (await customer(clerk)).phones.find((phone) => phone.id === shopOnClerk);
    expect(history?.retired).not.toBeNull();
  });
});

describe('orders for someone else (D-878 to D-881)', () => {
  it('keeps the buyer apart from the recipient, and adds the number to the buyer only when ticked', async () => {
    const son = await person(freshPhone(), 'Rafiq Hasan');
    const mothersPhone = freshPhone();
    const forMother = await order({
      customerId: son,
      placedFor: 'someone_else',
      placedForNote: 'Son ordering for his mother',
      saveRecipient: true,
      shipTo: { ...ADDRESS, name: 'Mother of Rafiq', phone: mothersPhone },
    });
    expect(forMother.customer.id).toBe(son);
    expect(forMother.placedFor).toBe('someone_else');
    expect(forMother.placedForNote).toBe('Son ordering for his mother');
    expect(forMother.shipTo).toMatchObject({ name: 'Mother of Rafiq', phone: mothersPhone });
    expect(forMother.recipientCustomerId).not.toBeNull();
    expect(forMother.recipientCustomerId).not.toBe(son);
    expect((await customer(son)).phones.map((phone) => phone.phone)).not.toContain(mothersPhone);

    const ticked = await order({
      customerId: son,
      placedFor: 'someone_else',
      placedForNote: 'His mother again',
      addRecipientNumberToBuyer: true,
      shipTo: { ...ADDRESS, name: 'Mother of Rafiq', phone: mothersPhone },
    });
    expect(ticked.customer.id).toBe(son);
    const onSon = (await customer(son)).phones.find((phone) => phone.phone === mothersPhone);
    expect(onSon).toMatchObject({ relation: 'someone_else', note: 'His mother again' });

    // Someone else's order needs the recipient's name and phone.
    const missing = await admin.client.request('POST', '/v1/orders', {
      body: {
        channel: 'phone',
        customerId: son,
        placedFor: 'someone_else',
        shipTo: { ...ADDRESS },
        lines: [{ skuId, qty: 1 }],
      },
    });
    expect(missing.statusCode).toBe(400);
  });
});

describe('correcting mistakes (D-882 to D-886)', () => {
  it('lets a supervisor change an order’s buyer, moving the counts between them', async () => {
    const wrong = await person(freshPhone(), 'Wrong Buyer');
    const right = await person(freshPhone(), 'Right Buyer');
    const placed = await order({ customerId: wrong, shipTo: { ...ADDRESS } });
    expect((await customer(wrong)).stats.orders).toBe(1);

    const refused = await sales.client.request('POST', `/v1/orders/${placed.id}/buyer`, {
      body: { customerId: right, reason: 'Ordered by her husband' },
    });
    expect(refused.statusCode).toBe(403);

    json(
      await admin.client.request('POST', `/v1/orders/${placed.id}/buyer`, {
        body: { customerId: right, reason: 'Ordered by her husband' },
      }),
      201,
    );
    const moved = json<Order>(await admin.client.request('GET', `/v1/orders/${placed.id}`));
    expect(moved.customer.id).toBe(right);
    expect((await customer(wrong)).stats.orders).toBe(0);
    expect((await customer(right)).stats.orders).toBe(1);
    const audit = await auditRowsFor(ORG_A, placed.id);
    expect(audit.map((row) => row.action)).toContain('order.buyer_changed');
  });

  it('merges two records of one person: orders, numbers and a phone call follow the kept one', async () => {
    const keptPhone = freshPhone();
    const otherPhone = freshPhone();
    const kept = await person(keptPhone, 'Farhana Islam');
    const other = await person(otherPhone, 'Farhana I.');
    const otherOrder = await order({ customerId: other, shipTo: { ...ADDRESS } });

    // A call Envo told us about, linked to the duplicate record.
    const callId = await withSystem(
      async (tx) => {
        const [connection] = await tx.execute<{ id: string }>(sql`
          insert into telephony.connections (org_id, name, base_url, created_by, updated_by)
          values (${ORG_A}, 'Numbers test', 'https://envo.invalid', 'usr_numbers_test',
                  'usr_numbers_test')
          returning id
        `);
        const [call] = await tx.execute<{ id: string }>(sql`
          insert into telephony.calls (org_id, connection_id, first_seen, envo_call_id, direction,
                                       status, occurred_at, customer_id, customer_phone_e164)
          values (${ORG_A}, ${connection?.id ?? ''}, 'webhook', '1790000000.7', 'inbound',
                  'ringing', now(), ${other}, ${otherPhone})
          returning id
        `);
        return call?.id ?? '';
      },
      { orgId: ORG_A },
    );

    const refused = await sales.client.request('POST', `/v1/customers/${kept}/merge`, {
      body: { otherCustomerId: other, reason: 'The same person, entered twice' },
    });
    expect(refused.statusCode).toBe(403);
    json(
      await admin.client.request('POST', `/v1/customers/${kept}/merge`, {
        body: { otherCustomerId: other, reason: 'The same person, entered twice' },
      }),
      201,
    );

    const keptNow = await customer(kept);
    expect(keptNow.phones.map((phone) => [phone.phone, phone.rank])).toEqual([
      [keptPhone, 1],
      [otherPhone, 2],
    ]);
    expect(keptNow.stats.orders).toBe(1);
    const moved = json<Order>(await admin.client.request('GET', `/v1/orders/${otherOrder.id}`));
    expect(moved.customer.id).toBe(kept);
    expect((await customer(other)).mergedIntoCustomerId).toBe(kept);
    const lookup = json<{ candidates: { customerId: string }[] }>(
      await admin.client.request(
        'GET',
        `/v1/customers/lookup?phone=${encodeURIComponent(otherPhone)}`,
      ),
    );
    expect(lookup.candidates.map((candidate) => candidate.customerId)).toEqual([kept]);

    // Telephony hears `customer.merged` and moves its call (0160's trigger allows only this).
    const [event] = await withSystem(
      (tx) =>
        tx.execute<{ id: string; payload: unknown; created_at: string }>(sql`
          select id, payload, created_at from events.outbox
          where org_id = ${ORG_A} and name = 'customer.merged' and payload ->> 'mergedId' = ${other}
        `),
      { orgId: ORG_A },
    );
    expect(event).toBeDefined();
    await onCustomerMerged(
      'system:customer-merge',
      moveCallsToCustomer,
    )({
      id: event?.id ?? '',
      orgId: ORG_A,
      name: 'customer.merged',
      payload: event?.payload,
      rooms: [],
      attempts: 0,
      occurredAt: new Date(),
      actorUserId: null,
    });
    const [call] = await withSystem(
      (tx) =>
        tx.execute<{ customer_id: string }>(sql`
          select customer_id from telephony.calls where org_id = ${ORG_A} and id = ${callId}
        `),
      { orgId: ORG_A },
    );
    expect(call?.customer_id).toBe(kept);

    // A call's customer still moves only to the record it was merged into.
    await expect(
      withOrg({ orgId: ORG_A, userId: 'usr_numbers_test' }, (tx) =>
        tx.execute(sql`
          update telephony.calls set customer_id = ${other} where org_id = ${ORG_A} and id = ${callId}
        `),
      ),
    ).rejects.toThrow();
  });
});
