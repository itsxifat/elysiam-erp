import { poisha, sub, takaParts, type Poisha } from '@elysium/domain';

import { itemsOf, type Context } from './context.js';
import { account } from './setup.js';

/**
 * Marketing, the order desk, couriers and COD (D-384).
 *
 * Every order is taken by the preview's own sales login, so its desk, its target and its
 * "my orders" are full when the owner signs in as it; the warehouse login packs, books and
 * ships; accounts' work is a robot's. Buyers and phone numbers are made up (invariant 10):
 * `Demo Buyer <name>` on `+8801980000NNN`, a range kept for the preview.
 */

type Final =
  | 'pending'
  | 'confirmed'
  | 'on_hold'
  | 'packed'
  | 'cancelled'
  | 'shipped_own'
  | 'in_transit'
  | 'delivered_own'
  | 'delivered'
  | 'delivered_settled'
  | 'returned';

interface OrderPlan {
  readonly key: string;
  readonly buyer: string;
  readonly phone: number;
  readonly district: string;
  readonly thana?: string;
  readonly line: string;
  readonly channel: string;
  readonly courier: 'demo' | 'own';
  readonly items: readonly (readonly [slug: string, size: string, qty: number])[];
  readonly final: Final;
  readonly promo?: boolean;
  readonly campaign?: string;
  readonly advance?: 'verified' | 'waiting';
  /** Left out of the agent's hands: the unassigned queue. */
  readonly queue?: boolean;
}

const ORDERS: readonly OrderPlan[] = [
  {
    key: 'o1',
    buyer: 'Nadia',
    phone: 101,
    district: 'Dhaka',
    thana: 'Dhanmondi',
    line: 'House 12, Road 7A',
    channel: 'facebook',
    courier: 'own',
    items: [['classic-cotton-tee', 'M', 2]],
    final: 'delivered_own',
    campaign: 'eid-festive',
  },
  {
    key: 'o2',
    buyer: 'Arif',
    phone: 102,
    district: 'Dhaka',
    thana: 'Gulshan',
    line: 'Flat 5C, Road 45',
    channel: 'facebook',
    courier: 'demo',
    items: [
      ['festive-cotton-panjabi', 'L', 1],
      ['classic-cotton-tee', 'L', 1],
    ],
    final: 'delivered_settled',
    promo: true,
  },
  {
    key: 'o3',
    buyer: 'Sumaiya',
    phone: 103,
    district: 'Chattogram',
    line: 'Lane 3, Nasirabad',
    channel: 'phone',
    courier: 'demo',
    items: [['premium-polo-shirt', 'M', 2]],
    final: 'delivered_settled',
    advance: 'verified',
  },
  {
    key: 'o4',
    buyer: 'Tanvir',
    phone: 104,
    district: 'Sylhet',
    line: 'Zindabazar, 2nd floor',
    channel: 'whatsapp',
    courier: 'demo',
    items: [['slim-fit-denim', 'L', 1]],
    final: 'delivered',
    campaign: 'eid-festive',
  },
  {
    key: 'o5',
    buyer: 'Farhana',
    phone: 105,
    district: 'Rajshahi',
    line: 'Shaheb Bazar, House 9',
    channel: 'instagram',
    courier: 'demo',
    items: [['linen-casual-shirt', 'M', 1]],
    final: 'in_transit',
    campaign: 'winter-preview',
  },
  {
    key: 'o6',
    buyer: 'Rakib',
    phone: 106,
    district: 'Dhaka',
    thana: 'Mirpur',
    line: 'Section 10, Block C',
    channel: 'facebook',
    courier: 'own',
    items: [['hooded-sweatshirt', 'XL', 1]],
    final: 'shipped_own',
  },
  {
    key: 'o7',
    buyer: 'Jannat',
    phone: 107,
    district: 'Khulna',
    line: 'Sonadanga R/A, Road 4',
    channel: 'facebook',
    courier: 'demo',
    items: [
      ['classic-cotton-tee', 'S', 1],
      ['premium-polo-shirt', 'L', 1],
    ],
    final: 'returned',
    campaign: 'eid-festive',
  },
  {
    key: 'o8',
    buyer: 'Imran',
    phone: 108,
    district: 'Dhaka',
    thana: 'Uttara',
    line: 'Sector 7, Road 12',
    channel: 'phone',
    courier: 'demo',
    items: [['festive-cotton-panjabi', 'M', 1]],
    final: 'packed',
  },
  {
    key: 'o9',
    buyer: 'Mitu',
    phone: 109,
    district: 'Gazipur',
    line: 'Tongi, Station Road',
    channel: 'facebook',
    courier: 'own',
    items: [
      ['linen-casual-shirt', 'L', 1],
      ['classic-cotton-tee', 'M', 1],
    ],
    final: 'confirmed',
  },
  {
    key: 'o10',
    buyer: 'Shakil',
    phone: 110,
    district: 'Narayanganj',
    line: 'Chashara, Holding 22',
    channel: 'whatsapp',
    courier: 'own',
    items: [['premium-polo-shirt', 'XL', 1]],
    final: 'on_hold',
  },
  {
    key: 'o11',
    buyer: 'Ruma',
    phone: 111,
    district: 'Dhaka',
    thana: 'Dhanmondi',
    line: 'Road 27, House 3',
    channel: 'facebook',
    courier: 'own',
    items: [['slim-fit-denim', 'M', 1]],
    final: 'cancelled',
  },
  {
    key: 'o12',
    buyer: 'Habib',
    phone: 112,
    district: 'Cumilla',
    line: 'Kandirpar, Shop 14',
    channel: 'facebook',
    courier: 'demo',
    items: [['festive-cotton-panjabi', 'XL', 1]],
    final: 'pending',
    advance: 'waiting',
  },
  {
    key: 'o13',
    buyer: 'Nadia',
    phone: 101,
    district: 'Dhaka',
    thana: 'Dhanmondi',
    line: 'House 12, Road 7A',
    channel: 'facebook',
    courier: 'own',
    items: [['hooded-sweatshirt', 'M', 1]],
    final: 'pending',
  },
  {
    key: 'o14',
    buyer: 'Sabbir',
    phone: 114,
    district: 'Bogura',
    line: 'Satmatha, College Road',
    channel: 'website',
    courier: 'demo',
    items: [['classic-cotton-tee', 'XL', 2]],
    final: 'pending',
    queue: true,
  },
  {
    key: 'o15',
    buyer: 'Laboni',
    phone: 115,
    district: 'Barishal',
    line: 'Sadar Road, House 40',
    channel: 'website',
    courier: 'own',
    items: [['linen-casual-shirt', 'XL', 1]],
    final: 'pending',
    queue: true,
  },
];

/** `+8801980000NNN`: made up, and the same shape a real Bangladeshi mobile has. */
export function demoPhone(n: number): string {
  return `+8801980000${String(n).padStart(3, '0')}`;
}

// ---------------------------------------------------------------------------------------

async function ensureMarketing(ctx: Context): Promise<void> {
  const marketing = (await ctx.people.as('marketing')).client;
  const campaigns = itemsOf<{ id: string; name: string }>(
    await marketing.get('/v1/marketing/campaigns'),
  );
  const plans = [
    {
      name: 'Eid Festive Collection',
      platform: 'meta',
      startsOn: ctx.daysAgo(20),
      refs: [
        { kind: 'utm_campaign', value: 'eid-festive' },
        { kind: 'meta_campaign', value: '120200000000001' },
      ],
      daily: 250_000,
      days: 14,
    },
    {
      name: 'Winter Preview',
      platform: 'google',
      startsOn: ctx.daysAgo(7),
      refs: [{ kind: 'utm_campaign', value: 'winter-preview' }],
      daily: 120_000,
      days: 7,
    },
  ];
  const ids: string[] = [];
  for (const plan of plans) {
    const found = campaigns.find((row) => row.name === plan.name);
    const id =
      found?.id ??
      (
        await marketing.post<{ id: string }>('/v1/marketing/campaigns', {
          name: plan.name,
          platform: plan.platform,
          startsOn: plan.startsOn,
          refs: plan.refs,
        })
      ).id;
    ids.push(id);
    // Ad spend typed in per day, as a marketer copies it from the ads manager. An upsert
    // per campaign and day, so a re-run writes the same figures again.
    for (let day = plan.days; day >= 1; day -= 1) {
      const wobble = ((day * 37) % 9) * 10_000;
      await marketing.put('/v1/marketing/spend', {
        campaignId: id,
        spendDate: ctx.daysAgo(day),
        amountPoisha: String(plan.daily + wobble),
      });
    }
  }
  ctx.ids.campaignId = ids[0] ?? '';

  const codes = itemsOf<{ code: string }>(await marketing.get('/v1/promo/codes'));
  if (!codes.some((row) => row.code === ctx.ids.promoCode)) {
    await marketing.post('/v1/promo/codes', {
      code: ctx.ids.promoCode,
      kind: 'percent',
      valueBps: 1000,
      maxDiscountPoisha: '50000',
      minOrderPoisha: '100000',
      totalLimit: 500,
      perCustomerLimit: 1,
      validFrom: ctx.daysAgo(20),
      validTo: ctx.daysAgo(-30),
      campaignId: ctx.ids.campaignId,
    });
  }

  const leads = itemsOf<unknown>(await marketing.get('/v1/marketing/leads'));
  if (leads.length === 0) {
    const plansForLeads = [
      { n: 201, status: 'new', size: 'M', ageBand: '25_34' },
      { n: 202, status: 'contacted', size: 'L', ageBand: '18_24' },
      { n: 203, status: 'converted', size: 'XL', ageBand: '35_44' },
      { n: 204, status: 'lost', size: 'M', ageBand: '25_34' },
    ];
    for (const lead of plansForLeads) {
      await marketing.post('/v1/marketing/leads', {
        phone: demoPhone(lead.n),
        name: `Demo Lead ${String(lead.n - 200)}`,
        channel: 'facebook',
        campaignId: ctx.ids.campaignId,
        size: lead.size,
        ageBand: lead.ageBand,
        status: lead.status,
      });
      ctx.count('leads');
    }
  }

  // The two SMS templates the system sends by itself: a buyer's birthday offer and a loan
  // instalment reminder. SMS goes to a stand-in in the preview; nothing leaves the PC.
  await marketing.put('/v1/notify/templates', {
    key: 'occasion.birthday',
    category: 'marketing',
    bodyEn: 'Happy birthday, {name}! Here is your 10% off code: {code}',
  });
  await marketing.put('/v1/notify/templates', {
    key: 'loan.instalment_due',
    category: 'transactional',
    bodyEn: 'Reminder: {lender} instalment {seq} of Tk {amount} is due on {due}.',
  });
}

// ---------------------------------------------------------------------------------------

interface Area {
  thanaId: number;
  thanaEn: string;
  districtId: number;
  districtEn: string;
}

function pickArea(areas: readonly Area[], district: string, thana?: string): Area {
  const inDistrict = areas.filter((area) =>
    area.districtEn.toLowerCase().startsWith(district.toLowerCase()),
  );
  const exact =
    thana === undefined
      ? undefined
      : inDistrict.find((area) => area.thanaEn.toLowerCase().includes(thana.toLowerCase()));
  const found = exact ?? inDistrict[0] ?? areas[0];
  if (found === undefined) throw new Error('preview: no delivery areas are seeded.');
  return found;
}

interface Placed {
  readonly plan: OrderPlan;
  readonly id: string;
  readonly orderNo: string;
  consignmentId?: string;
}

async function placeOrders(ctx: Context): Promise<Placed[]> {
  const sales = await ctx.people.as('sales');
  const admin = await ctx.people.robot('admin');
  const areas = itemsOf<Area>(
    (await sales.client.get<{ areas: Area[] }>('/v1/delivery-zones/areas')).areas,
  );
  const placed: Placed[] = [];
  for (const plan of ORDERS) {
    const area = pickArea(areas, plan.district, plan.thana);
    const who = plan.queue === true ? admin.client : sales.client;
    const source =
      plan.campaign === undefined
        ? undefined
        : { utmSource: plan.channel, utmMedium: 'paid_social', utmCampaign: plan.campaign };
    const created = await who.post<{ id: string; orderNo: string }>('/v1/orders', {
      channel: plan.channel,
      customer: {
        phone: demoPhone(plan.phone),
        name: `Demo Buyer ${plan.buyer}`,
        address: { districtId: area.districtId, thanaId: area.thanaId, addressLine: plan.line },
      },
      locationId: ctx.ids.warehouseId,
      courierId: plan.courier === 'demo' ? ctx.ids.demoCourierId : ctx.ids.ownRiderId,
      lines: plan.items.map(([slug, size, qty]) => ({ skuId: ctx.sku(slug, size).id, qty })),
      ...(plan.promo === true ? { promoCode: ctx.ids.promoCode } : {}),
      ...(source === undefined ? {} : { source }),
      ...(plan.queue === true ? {} : { assignedTo: sales.userId }),
      notes: 'Preview demo order',
    });
    placed.push({ plan, id: created.id, orderNo: created.orderNo });
    ctx.count('orders');
  }
  return placed;
}

/** Advances: the agent records them; accounts checks one, and one waits for the owner. */
async function recordAdvances(ctx: Context, placed: readonly Placed[]): Promise<void> {
  const sales = (await ctx.people.as('sales')).client;
  const accounts = (await ctx.people.robot('accounts')).client;
  for (const order of placed) {
    if (order.plan.advance === undefined) continue;
    const advance = await sales.post<{ id: string }>(`/v1/orders/${order.id}/advances`, {
      method: 'bkash',
      transactionRef: `PV${order.orderNo.replace(/[^A-Z0-9]/gi, '')}7`,
      amountPoisha: '20000',
      note: 'Delivery charge paid ahead by bKash',
    });
    ctx.count('advances');
    if (order.plan.advance === 'verified') {
      await accounts.post(`/v1/order-advances/${advance.id}/verify`, {
        walletAccountId: account(ctx, '1110'),
      });
    }
  }
}

const AFTER_CONFIRM: readonly Final[] = [
  'confirmed',
  'on_hold',
  'packed',
  'cancelled',
  'shipped_own',
  'in_transit',
  'delivered_own',
  'delivered',
  'delivered_settled',
  'returned',
];
const AFTER_PACK: readonly Final[] = [
  'packed',
  'shipped_own',
  'in_transit',
  'delivered_own',
  'delivered',
  'delivered_settled',
  'returned',
];
const SHIPPED: readonly Final[] = [
  'shipped_own',
  'in_transit',
  'delivered_own',
  'delivered',
  'delivered_settled',
  'returned',
];

async function moveOrders(ctx: Context, placed: Placed[]): Promise<void> {
  const sales = (await ctx.people.as('sales')).client;
  const warehouse = (await ctx.people.as('warehouse')).client;

  for (const order of placed) {
    if (AFTER_CONFIRM.includes(order.plan.final)) {
      await sales.post(`/v1/orders/${order.id}/confirm`);
    }
  }
  for (const order of placed) {
    if (order.plan.final === 'on_hold') {
      await sales.post(`/v1/orders/${order.id}/hold`, {
        reason: 'Buyer asked to deliver after payday',
      });
    }
    if (order.plan.final === 'cancelled') {
      await sales.post(`/v1/orders/${order.id}/cancel`, {
        reason: 'Buyer changed their mind on the phone',
      });
    }
    if (AFTER_PACK.includes(order.plan.final)) {
      await warehouse.post(`/v1/orders/${order.id}/pack`);
    }
  }

  // Parcels with the demo courier, booked in one go as the warehouse does it. The booking
  // itself is a job: the fake courier answers in the worker, which runs in this process.
  const bookable = placed.filter(
    (order) => order.plan.courier === 'demo' && AFTER_PACK.includes(order.plan.final),
  );
  const booked = await warehouse.post<{
    results: { orderId: string; consignmentId: string | null; code?: string | null }[];
  }>('/v1/courier/parcels/bulk', { orderIds: bookable.map((order) => order.id) });
  for (const result of booked.results) {
    const order = placed.find((entry) => entry.id === result.orderId);
    if (order !== undefined && result.consignmentId !== null)
      order.consignmentId = result.consignmentId;
  }
  await ctx.settle();
  ctx.count('parcels', bookable.length);

  for (const order of placed) {
    if (!SHIPPED.includes(order.plan.final)) continue;
    await warehouse.post(`/v1/orders/${order.id}/ship`, {});
    if (order.consignmentId !== undefined) {
      await warehouse.post(`/v1/courier/parcels/${order.consignmentId}/handover`, {});
    }
  }

  for (const order of placed) {
    const parcel = order.consignmentId;
    switch (order.plan.final) {
      case 'delivered_own':
        await warehouse.post(`/v1/orders/${order.id}/deliver`, {});
        break;
      case 'in_transit':
        if (parcel !== undefined) {
          await warehouse.post(`/v1/courier/parcels/${parcel}/status`, {
            status: 'in_transit',
            rawStatus: 'In transit to hub',
            reason: 'Courier app shows the parcel at the sorting hub',
          });
        }
        break;
      case 'delivered':
      case 'delivered_settled':
        if (parcel !== undefined) {
          await warehouse.post(`/v1/courier/parcels/${parcel}/status`, {
            status: 'delivered',
            rawStatus: 'Delivered',
            reason: 'Rider confirmed delivery and cash collected',
          });
        }
        break;
      case 'returned':
        if (parcel !== undefined) {
          await warehouse.post(`/v1/courier/parcels/${parcel}/status`, {
            status: 'return_in_transit',
            rawStatus: 'Returning to merchant',
            reason: 'Buyer refused at the door',
          });
          await warehouse.post(`/v1/courier/parcels/${parcel}/receive-return`, {
            reason: 'Parcel came back unopened',
            returnReason: 'customer_refused',
            lines: order.plan.items.map(([slug, size, qty]) => ({
              skuId: ctx.sku(slug, size).id,
              sellableQty: qty,
              damagedQty: 0,
            })),
          });
        }
        break;
      case 'pending':
      case 'confirmed':
      case 'on_hold':
      case 'packed':
      case 'cancelled':
      case 'shipped_own':
        // Already where it belongs.
        break;
    }
  }
  await ctx.settle();
}

/** A statement column: taka with two decimals, signed, from poisha. */
function taka(amount: Poisha): string {
  const parts = takaParts(amount);
  return `${parts.negative ? '-' : ''}${parts.taka.toString()}.${parts.poisha.toString().padStart(2, '0')}`;
}

/** The courier's COD statement for the settled parcels, imported and approved. */
async function settleCod(ctx: Context, placed: readonly Placed[]): Promise<void> {
  const accounts = (await ctx.people.robot('accounts')).client;
  const admin = (await ctx.people.robot('admin')).client;
  const rows: string[] = [];
  for (const order of placed) {
    if (order.plan.final !== 'delivered_settled' || order.consignmentId === undefined) continue;
    const { consignment } = await accounts.get<{
      consignment: {
        consignmentNo: string | null;
        collectedPoisha: string | null;
        codAmountPoisha: string;
      };
    }>(`/v1/courier/parcels/${order.consignmentId}`);
    const collected = poisha(consignment.collectedPoisha ?? consignment.codAmountPoisha);
    // The demo courier's delivery charge per parcel, deducted from what it pays over.
    const charge = poisha(6_000n);
    rows.push(
      [
        consignment.consignmentNo ?? '',
        order.orderNo,
        taka(collected),
        taka(charge),
        '0',
        '0',
        taka(sub(collected, charge)),
      ].join(','),
    );
  }
  if (rows.length === 0) return;
  const csv = [
    'consignment_id,invoice,cod_amount,delivery_charge,return_charge,other_charge,net_amount',
    ...rows,
  ].join('\n');
  const batch = await accounts.post<{ id: string }>('/v1/courier/settlements', {
    courierId: ctx.ids.demoCourierId,
    walletId: ctx.ids.wallets['1100'],
    fileName: `fake-${ctx.today()}-S1001.csv`,
    fileBase64: Buffer.from(csv, 'utf8').toString('base64'),
  });
  const approval = await accounts.post<{
    approvalId?: string | null;
    approvalRequestId?: string | null;
  }>(`/v1/courier/settlements/${batch.id}/approval`, {});
  const approvalId = approval.approvalId ?? approval.approvalRequestId;
  if (approvalId !== undefined && approvalId !== null) {
    await admin.post(`/v1/approvals/${approvalId}/decide`, {
      decision: 'approved',
      note: 'Statement matches the delivered parcels',
    });
  }
  ctx.count('settlements');
}

export async function runSales(ctx: Context): Promise<void> {
  await ensureMarketing(ctx);

  const warehouse = (await ctx.people.as('warehouse')).client;
  const existing = itemsOf<{ orderNo: string; id: string }>(
    await warehouse.get('/v1/orders?limit=5'),
  );
  const tracking = ORDERS.find((plan) => plan.final === 'in_transit');
  if (existing.length > 0) {
    ctx.note('Orders were already seeded; the order desk was left as it is.');
    // The parcel on its way is still the one to track: shipped, and the only Instagram order.
    const shipped = itemsOf<{ orderNo: string }>(
      await warehouse.get(`/v1/orders?status=shipped&channel=${tracking?.channel ?? 'instagram'}`),
    )[0];
    if (shipped !== undefined && tracking !== undefined) {
      ctx.summary.trackingOrder = {
        orderNo: shipped.orderNo,
        phoneLast4: demoPhone(tracking.phone).slice(-4),
        slug: ctx.orgSlug,
      };
    }
    return;
  }
  const placed = await placeOrders(ctx);
  await recordAdvances(ctx, placed);
  await moveOrders(ctx, placed);
  await settleCod(ctx, placed);

  const tracked = placed.find((order) => order.plan === tracking);
  if (tracked !== undefined) {
    ctx.summary.trackingOrder = {
      orderNo: tracked.orderNo,
      phoneLast4: demoPhone(tracked.plan.phone).slice(-4),
      slug: ctx.orgSlug,
    };
  }
}
