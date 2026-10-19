import { randomUUID } from 'node:crypto';

import { withOrg, withSystem } from '@elysium/db';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  ORG_A,
  ORG_B,
  startHttpHarness,
  type HttpHarness,
  type InjectedResponse,
  type RoleClient,
} from '../../testing/http-harness.js';
import { seedProductWithSkus } from '../inventory/inventory.testing.js';
import { seedCustomer, seedOrder } from '../orders/orders.testing.js';

/**
 * M49 on real Postgres, through the real routes (D-890 to D-895):
 *
 * 1. The customer card: a sales agent who cannot open a buyer on the buyer page (another agent's
 *    orders) can see and correct the buyer a chat is linked to, through the conversation: the
 *    details with the email, a number with its note, the address book. The buyer page shows the
 *    same record. Someone else's chat needs the go-ahead; an unlinked chat has no card to edit;
 *    another brand sees nothing. No email or address line reaches an audit row.
 * 2. Save as customer and link: a new buyer from the chat, linked; one of the people on the saved
 *    number linked only when they use it; Not this customer unlinks.
 * 3. The buyer page's address book: add, replace, make default, remove, the default moving on.
 * 4. The picker lists every match, a page at a time, with no product twice.
 */

let harness: HttpHarness;
let admin: RoleClient;
let salesA: RoleClient;
let salesB: RoleClient;
let adminB: RoleClient;
let sku = { id: '', code: '' };
let area = { districtId: 0, thanaId: 0 };

let phoneSeed = 30_000_000 + Math.floor(Math.random() * 60_000_000);
function freshPhone(): string {
  phoneSeed += 1;
  return `+88019${String(phoneSeed)}`;
}
const national = (e164: string) => `0${e164.slice(4)}`;

function json<T>(response: InjectedResponse, status = 200): T {
  expect(response.statusCode, response.body).toBe(status);
  return JSON.parse(response.body) as T;
}

interface Card {
  readonly id: string;
  readonly name: string;
  readonly email: string | null;
  readonly profession: string | null;
  readonly phones: readonly {
    readonly id: string;
    readonly phone: string;
    readonly rank: number;
    readonly note: string | null;
    readonly retired: unknown;
  }[];
  readonly addresses: readonly {
    readonly id: string;
    readonly label: string | null;
    readonly addressLine: string;
    readonly isDefault: boolean;
    readonly thanaName: string | null;
  }[];
}

interface Panel {
  readonly customer: { readonly id: string; readonly card: Card | null } | null;
  readonly candidates: readonly { readonly customerId: string; readonly name: string }[];
}

/** A chat on Messenger whose customer wrote `text` an hour ago, linked to `customerId` if given. */
async function chat(options: {
  readonly text: string;
  readonly phone?: string | null;
  readonly customerId?: string | null;
  readonly assignedTo?: string | null;
  readonly orgId?: string;
}): Promise<{ id: string; contactId: string }> {
  const orgId = options.orgId ?? ORG_A;
  return withSystem(
    async (tx) => {
      await tx.execute(sql`
        insert into inbox.channels (org_id, kind, external_id, enabled, updated_by)
        values (${orgId}, 'messenger', ${orgId === ORG_A ? '900000000004901' : '900000000004902'},
                true, 'usr_m49_suite')
        on conflict (org_id, kind) do nothing
      `);
      const channel = (
        await tx.execute<{ id: string }>(sql`
          select id from inbox.channels where org_id = ${orgId} and kind = 'messenger'
        `)
      )[0]?.id;
      const contact = (
        await tx.execute<{ id: string }>(sql`
          insert into inbox.contacts (org_id, display_name, phone_e164, customer_id)
          values (${orgId}, 'Chat person', ${options.phone ?? null}, ${options.customerId ?? null})
          returning id
        `)
      )[0]?.id;
      const identity = (
        await tx.execute<{ id: string }>(sql`
          insert into inbox.identities (org_id, contact_id, channel_id, external_user_id)
          values (${orgId}, ${contact}, ${channel}, ${`psid-${randomUUID()}`})
          returning id
        `)
      )[0]?.id;
      const conversation = (
        await tx.execute<{ id: string }>(sql`
          insert into inbox.conversations
            (org_id, channel_id, contact_id, identity_id, assigned_to, assigned_at,
             last_inbound_at, last_message_at, last_preview, last_direction, unread_count)
          values (${orgId}, ${channel}, ${contact}, ${identity}, ${options.assignedTo ?? null},
                  ${options.assignedTo == null ? null : sql`now()`},
                  now() - interval '1 hour', now() - interval '1 hour', ${options.text},
                  'inbound', 1)
          returning id
        `)
      )[0]?.id;
      await tx.execute(sql`
        insert into inbox.messages
          (org_id, conversation_id, direction, body, provider_message_id, status, occurred_at)
        values (${orgId}, ${conversation}, 'inbound', ${options.text}, ${`m_${randomUUID()}`},
                'received', now() - interval '1 hour')
      `);
      return { id: conversation ?? '', contactId: contact ?? '' };
    },
    { orgId },
  );
}

/** A buyer whose only order is salesB's, so salesA cannot open them on the buyer page. */
async function salesBsBuyer(phone: string, name: string): Promise<string> {
  const customerId = await seedCustomer(ORG_A, { phoneE164: phone, name });
  await seedOrder(ORG_A, {
    status: 'pending',
    customerId,
    createdBy: salesB.userId,
    assignedTo: salesB.userId,
    lines: [
      {
        skuId: sku.id,
        skuCode: sku.code,
        productName: 'Card product',
        qty: 1,
        unitPricePoisha: 150_000n,
      },
    ],
  });
  return customerId;
}

const at = (id: string, suffix = '') => `/v1/inbox/conversations/${id}${suffix}`;

async function panel(id: string, as: RoleClient = salesA): Promise<Panel> {
  return json<Panel>(await as.client.request('GET', at(id, '/panel')));
}

beforeAll(async () => {
  harness = await startHttpHarness('inbox-customer-card');
  admin = await harness.asRole('org_admin', ORG_A);
  salesA = await harness.asRole('sales', ORG_A);
  salesB = await harness.asRole('sales', ORG_A);
  adminB = await harness.asRole('org_admin', ORG_B);
  const seeded = await seedProductWithSkus(ORG_A, 'cardprod', 1);
  sku = { id: seeded.skus[0]?.id ?? '', code: seeded.skus[0]?.code ?? '' };
  area = await withSystem(async (tx) => {
    const rows = await tx.execute<{ district_id: number; thana_id: number }>(sql`
      select district_id, id as thana_id from ref.thanas order by id limit 1
    `);
    return { districtId: rows[0]?.district_id ?? 1, thanaId: rows[0]?.thana_id ?? 1 };
  });
}, 120_000);

afterAll(async () => {
  await harness.close();
});

describe('the customer card through the conversation (D-890, D-891, D-894)', () => {
  it('lets the chat’s agent correct a buyer they cannot open on the buyer page', async () => {
    const phone = freshPhone();
    const customerId = await salesBsBuyer(phone, 'Rumana Haque');
    const conversation = await chat({ text: `amar number ${national(phone)}`, phone, customerId });

    // The buyer page stays the buyer's reach: salesA cannot open or change this buyer there.
    expect((await salesA.client.request('GET', `/v1/customers/${customerId}`)).statusCode).toBe(
      404,
    );
    const refused = await salesA.client.request('PATCH', `/v1/customers/${customerId}`, {
      body: { email: 'rumana@example.com' },
    });
    expect(refused.statusCode).toBe(404);

    // The panel shows the whole card.
    const before = await panel(conversation.id);
    expect(before.customer?.card).toMatchObject({ id: customerId, name: 'Rumana Haque' });
    expect(before.customer?.card?.phones.map((row) => row.phone)).toEqual([phone]);

    // Details, a number with its note, an address: all through the conversation.
    json(
      await salesA.client.request('PATCH', at(conversation.id, '/customer'), {
        body: { name: 'Rumana Haque Mitu', email: 'Rumana@Example.com', profession: 'Doctor' },
      }),
    );
    const office = freshPhone();
    const noNote = await salesA.client.request('POST', at(conversation.id, '/customer/phones'), {
      body: { phone: national(office), relation: 'work' },
    });
    expect(noNote.statusCode).toBe(400);
    json(
      await salesA.client.request('POST', at(conversation.id, '/customer/phones'), {
        body: { phone: national(office), relation: 'work', note: 'Chamber phone, after 6 pm' },
      }),
      201,
    );
    json(
      await salesA.client.request('POST', at(conversation.id, '/customer/addresses'), {
        body: { ...area, label: 'Chamber', addressLine: 'Green Road 12, 3rd floor' },
      }),
      201,
    );

    const after = (await panel(conversation.id)).customer?.card;
    expect(after).toMatchObject({
      name: 'Rumana Haque Mitu',
      email: 'rumana@example.com',
      profession: 'Doctor',
    });
    expect(after?.phones.filter((row) => row.retired === null).map((row) => row.phone)).toEqual([
      phone,
      office,
    ]);
    // The seeded buyer had a default address already; the new one joins the book beside it.
    const chamber = after?.addresses.find((row) => row.label === 'Chamber');
    expect(chamber).toMatchObject({ addressLine: 'Green Road 12, 3rd floor', isDefault: false });
    expect(chamber?.thanaName).not.toBeNull();
    expect(after?.addresses.filter((row) => row.isDefault)).toHaveLength(1);

    // The buyer page shows the same record.
    const page = json<Card>(await admin.client.request('GET', `/v1/customers/${customerId}`));
    expect(page.email).toBe('rumana@example.com');
    expect(page.addresses.map((row) => row.addressLine)).toContain('Green Road 12, 3rd floor');

    // Make the office number primary, then retire the old one, from the chat.
    const officeId = after?.phones.find((row) => row.phone === office)?.id ?? '';
    const ownId = after?.phones.find((row) => row.phone === phone)?.id ?? '';
    json(
      await salesA.client.request('PATCH', at(conversation.id, `/customer/phones/${officeId}`), {
        body: { rank: 1 },
      }),
    );
    json(
      await salesA.client.request('POST', at(conversation.id, `/customer/phones/${ownId}/retire`), {
        body: { reason: 'changed_number' },
      }),
      201,
    );
    const numbers = json<Card>(await admin.client.request('GET', `/v1/customers/${customerId}`));
    expect(numbers.phones.find((row) => row.retired === null)).toMatchObject({
      phone: office,
      rank: 1,
    });

    // Neither the email nor an address line reached an audit row (invariant 10).
    const leaked = await withSystem(
      async (tx) =>
        tx.execute<{ n: number }>(sql`
          select count(*)::int as n from audit.audit_log
          where org_id = ${ORG_A}
            and (coalesce(after::text, '') ilike '%rumana@example.com%'
                 or coalesce(after::text, '') ilike '%Green Road 12%')
        `),
      { orgId: ORG_A },
    );
    expect(leaked[0]?.n).toBe(0);
    const audited = await withSystem(
      async (tx) =>
        tx.execute<{ action: string }>(sql`
          select action from audit.audit_log
          where org_id = ${ORG_A} and actor_user_id = ${salesA.userId}
            and (entity_id = ${customerId} or entity_id = ${conversation.contactId})
        `),
      { orgId: ORG_A },
    );
    const actions = audited.map((row) => row.action);
    expect(actions).toContain('customer.updated');
    expect(actions).toContain('customer.address_added');
    expect(actions).toContain('inbox.customer.details');
  });

  it('asks for the go-ahead on someone else’s chat, refuses an unlinked one and another brand', async () => {
    const phone = freshPhone();
    const customerId = await seedCustomer(ORG_A, { phoneE164: phone, name: 'Owned chat buyer' });
    const owned = await chat({
      text: `call ${national(phone)}`,
      phone,
      customerId,
      assignedTo: salesB.userId,
    });
    const ask = await salesA.client.request('PATCH', at(owned.id, '/customer'), {
      body: { profession: 'Banker' },
    });
    expect(ask.statusCode).toBe(409);
    expect(ask.body).toContain('INBOX_OWNER_ACK_REQUIRED');
    json(
      await salesA.client.request('PATCH', at(owned.id, '/customer'), {
        body: { profession: 'Banker' },
        headers: { 'x-acknowledge-owner': '1' },
      }),
    );

    const unlinked = await chat({ text: 'hello' });
    const none = await salesA.client.request('PATCH', at(unlinked.id, '/customer'), {
      body: { profession: 'Banker' },
    });
    expect(none.statusCode).toBe(409);
    expect(none.body).toContain('INBOX_NO_CUSTOMER');

    // Another brand: the conversation is not there for them.
    const other = await adminB.client.request('PATCH', at(owned.id, '/customer'), {
      body: { profession: 'Pilot' },
    });
    expect(other.statusCode).toBe(404);
    const stored = await withOrg({ orgId: ORG_A }, async (tx) =>
      tx.execute<{ profession: string | null }>(sql`
        select profession from sales.customers where id = ${customerId}
      `),
    );
    expect(stored[0]?.profession).toBe('Banker');
  });
});

describe('save as customer and link (D-892)', () => {
  it('saves the chat’s person as a new buyer, links people on the number, and unlinks', async () => {
    // A new customer from a chat with a saved number and address.
    const phone = freshPhone();
    const fresh = await chat({ text: `my number ${national(phone)}`, phone });
    await withSystem(
      async (tx) => {
        await tx.execute(sql`
          update inbox.contacts set district_id = ${area.districtId}, thana_id = ${area.thanaId},
                 address_line = 'Mirpur 10, Block C'
          where id = ${fresh.contactId}
        `);
      },
      { orgId: ORG_A },
    );
    const saved = json<{ customerId: string }>(
      await salesA.client.request('POST', at(fresh.id, '/customer'), {
        body: { name: 'Sabina Yasmin' },
      }),
      201,
    );
    const card = (await panel(fresh.id)).customer?.card;
    expect(card).toMatchObject({ id: saved.customerId, name: 'Sabina Yasmin', phone });
    expect(card?.addresses.map((row) => row.addressLine)).toEqual(['Mirpur 10, Block C']);
    const again = await salesA.client.request('POST', at(fresh.id, '/customer'), {
      body: { name: 'Twice' },
    });
    expect(again.statusCode).toBe(409);

    // A shared number: the people on it are offered, and one is linked.
    const shared = freshPhone();
    const mother = await seedCustomer(ORG_A, { phoneE164: shared, name: 'Mother' });
    const unrelated = await seedCustomer(ORG_A, { phoneE164: freshPhone(), name: 'Unrelated' });
    const sharedChat = await chat({ text: `ei number ${national(shared)}`, phone: shared });
    const offered = await panel(sharedChat.id);
    expect(offered.customer).toBeNull();
    expect(offered.candidates.map((row) => row.customerId)).toContain(mother);
    const wrong = await salesA.client.request('PUT', at(sharedChat.id, '/customer/link'), {
      body: { customerId: unrelated },
    });
    expect(wrong.statusCode).toBe(400);
    json(
      await salesA.client.request('PUT', at(sharedChat.id, '/customer/link'), {
        body: { customerId: mother },
      }),
    );
    expect((await panel(sharedChat.id)).customer?.id).toBe(mother);

    // Not this customer: the link goes, the number stays.
    json(await salesA.client.request('DELETE', at(sharedChat.id, '/customer/link')));
    const unlinked = await panel(sharedChat.id);
    expect(unlinked.customer).toBeNull();
    const contact = await withOrg({ orgId: ORG_A }, async (tx) =>
      tx.execute<{ phone_e164: string | null }>(sql`
        select phone_e164 from inbox.contacts where id = ${sharedChat.contactId}
      `),
    );
    expect(contact[0]?.phone_e164).toBe(shared);

    // The buyer page's Chats card lists the chats a buyer had.
    const chats = json<{ conversations: { id: string }[] }>(
      await salesA.client.request('GET', `/v1/inbox/customers/${saved.customerId}/chats`),
    );
    expect(chats.conversations.map((row) => row.id)).toEqual([fresh.id]);
  });
});

describe('the buyer page’s address book (D-894)', () => {
  it('adds, replaces, makes default and removes, keeping one default', async () => {
    const customerId = await seedCustomer(ORG_A, { phoneE164: freshPhone(), name: 'Book owner' });
    const url = `/v1/customers/${customerId}/addresses`;
    // The seeded buyer comes with one default address; a new one joins it, not as the default.
    const first = json<{ addresses: Card['addresses'] }>(
      await admin.client.request('POST', url, {
        body: { ...area, label: 'Home', addressLine: 'House 1, Road 1' },
      }),
      201,
    );
    expect(first.addresses.find((row) => row.label === 'Home')?.isDefault).toBe(false);
    expect(first.addresses.filter((row) => row.isDefault)).toHaveLength(1);
    const second = json<{ addresses: Card['addresses'] }>(
      await admin.client.request('POST', url, {
        body: { ...area, label: 'Office', addressLine: 'Tower 5, Gulshan' },
      }),
      201,
    );
    const office = second.addresses.find((row) => row.label === 'Office');
    expect(office?.isDefault).toBe(false);

    const replaced = json<{ addresses: Card['addresses'] }>(
      await admin.client.request('PUT', `${url}/${office?.id ?? ''}`, {
        body: { ...area, label: 'Office', addressLine: 'Tower 6, Gulshan', isDefault: true },
      }),
    );
    expect(replaced.addresses.filter((row) => row.isDefault).map((row) => row.label)).toEqual([
      'Office',
    ]);
    expect(replaced.addresses.find((row) => row.label === 'Office')?.addressLine).toBe(
      'Tower 6, Gulshan',
    );

    // Removing the default makes the oldest remaining address the default.
    const removed = json<{ addresses: Card['addresses'] }>(
      await admin.client.request('DELETE', `${url}/${office?.id ?? ''}`),
    );
    expect(removed.addresses).toHaveLength(2);
    expect(removed.addresses.filter((row) => row.isDefault)).toHaveLength(1);
    expect(removed.addresses.some((row) => row.label === 'Office')).toBe(false);

    const missing = await admin.client.request('DELETE', `${url}/${randomUUID()}`);
    expect(missing.statusCode).toBe(404);
    const otherBrand = await adminB.client.request('POST', url, {
      body: { ...area, addressLine: 'Somewhere else' },
    });
    expect(otherBrand.statusCode).toBe(404);
  });
});

describe('the picker lists every match (D-890)', () => {
  it('pages through all of them with no product twice', async () => {
    for (let index = 0; index < 25; index += 1) {
      await seedProductWithSkus(ORG_A, `zebra${String(index).padStart(2, '0')}`, 1);
    }
    const seen: string[] = [];
    let offset: number | null = 0;
    let pages = 0;
    while (offset !== null && pages < 5) {
      const query: string = offset === 0 ? '' : `&offset=${String(offset)}`;
      const page: { items: { id: string }[]; nextOffset: number | null } = json(
        await salesA.client.request('GET', `/v1/inbox/products?q=product%20zebra${query}`),
      );
      seen.push(...page.items.map((item: { id: string }) => item.id));
      offset = page.nextOffset;
      pages += 1;
    }
    expect(pages).toBe(2);
    expect(seen).toHaveLength(25);
    expect(new Set(seen).size).toBe(25);
  });
});
