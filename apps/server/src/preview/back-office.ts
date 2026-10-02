import { allocate, mulQty, percentOf, poisha, sum } from '@elysium/domain';

import type { PreviewClient } from './client.js';
import { itemsOf, type Context } from './context.js';
import { account } from './setup.js';

/**
 * Money, people and the showroom till (D-385): investors' capital, wallets' cash
 * movements, a company loan, employees and payroll, a target and a bonus rule, and a day
 * of till sales.
 *
 * Several approvals are deliberately left waiting, so the owner has something real to
 * approve: a supplier payment, September's payroll, an investor's withdrawal, a stock
 * write-off and an advance claim (the last two from the other parts).
 */

/** A minimal one-page PDF: the files module sniffs `%PDF-` and the trailer. */
function demoPdf(title: string): Buffer {
  const text = title.replace(/[()\\]/g, '');
  const stream = `BT /F1 18 Tf 72 720 Td (${text}) Tj ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${String(stream.length)} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let body = '%PDF-1.4\n';
  const offsets: number[] = [];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(body));
    body += `${String(index + 1)} 0 obj\n${object}\nendobj\n`;
  }
  const xref = Buffer.byteLength(body);
  body += `xref\n0 ${String(objects.length + 1)}\n0000000000 65535 f \n`;
  for (const offset of offsets) body += `${String(offset).padStart(10, '0')} 00000 n \n`;
  body += `trailer\n<< /Size ${String(objects.length + 1)} /Root 1 0 R >>\nstartxref\n${String(xref)}\n%%EOF\n`;
  return Buffer.from(body, 'latin1');
}

/** The files module's upload: a ticket, the bytes to the signed URL, then finalize. */
async function upload(
  ctx: Context,
  client: PreviewClient,
  input: { purpose: string; originalName: string; bytes: Buffer },
): Promise<string> {
  const ticket = await client.post<{
    fileId: string;
    url: string;
    headers: Record<string, string>;
  }>('/v1/files', {
    purpose: input.purpose,
    contentType: 'application/pdf',
    originalName: input.originalName,
    visibility: 'private',
    sizeBytes: input.bytes.byteLength,
  });
  const target = new URL(ticket.url);
  const put = await ctx.runtime.server.inject({
    method: 'PUT',
    url: `${target.pathname}${target.search}`,
    headers: { ...ticket.headers, host: target.host },
    payload: input.bytes,
  });
  if (put.statusCode !== 200) {
    throw new Error(
      `preview: uploading ${input.originalName} answered ${String(put.statusCode)}: ${put.body}`,
    );
  }
  await client.post(`/v1/files/${ticket.fileId}/finalize`);
  return ticket.fileId;
}

// ---------------------------------------------------------------------------------------

/** Investors' money is the brand's starting capital: it goes in before anything is bought. */
export async function ensureInvestors(ctx: Context): Promise<void> {
  const accounts = (await ctx.people.robot('accounts')).client;
  const bank = account(ctx, '1100');
  const existing = itemsOf<{ id: string; code: string }>(await accounts.get('/v1/investors'));
  const investorUserId = await ctx.people.idOf('investor');

  const plans = [
    { code: 'INV-01', name: 'Preview Investor', userId: investorUserId, shareBps: 6000 },
    { code: 'INV-02', name: 'Demo Partner', shareBps: 4000 },
  ];
  const ids: Record<string, string> = {};
  for (const plan of plans) {
    const found = existing.find((row) => row.code === plan.code);
    ids[plan.code] =
      found?.id ??
      (
        await accounts.post<{ id: string }>('/v1/investors', {
          ...plan,
          joinedOn: '2025-01-01',
          notes: 'Preview demo investor',
        })
      ).id;
  }
  const first = ids['INV-01'] ?? '';
  const second = ids['INV-02'] ?? '';

  const contributions = [
    { name: 'investment:1', investorId: first, amountPoisha: '100000000' },
    {
      name: 'investment:2',
      investorId: first,
      amountPoisha: '20000000',
      lockInUntil: '2027-12-31',
    },
    { name: 'investment:3', investorId: second, amountPoisha: '50000000' },
  ];
  for (const contribution of contributions) {
    await accounts.post('/v1/investors/investments', {
      investmentId: ctx.id(contribution.name),
      investorId: contribution.investorId,
      walletAccountId: bank,
      amountPoisha: contribution.amountPoisha,
      ...(contribution.lockInUntil === undefined ? {} : { lockInUntil: contribution.lockInUntil }),
      memo: 'Capital for the new season',
    });
  }

  const documents = itemsOf<unknown>(
    await accounts.get(`/v1/investors/documents?investorId=${first}`),
  );
  if (documents.length === 0) {
    const fileId = await upload(ctx, accounts, {
      purpose: 'investor-document',
      originalName: 'investment-agreement-demo.pdf',
      bytes: demoPdf('Investment agreement - preview demo, not a real document'),
    });
    await accounts.post('/v1/investors/documents', {
      investorId: first,
      investmentId: ctx.id('investment:1'),
      kind: 'agreement',
      title: 'Investment agreement (demo)',
      fileId,
    });
    ctx.count('investor documents');
  }
}

/**
 * Last month's profit shared out, and a withdrawal request left for the owner.
 *
 * Checked before it is sent: a distribution's id is its idempotency key, and the same id
 * from a different person (a later run's robot) is a conflict rather than a replay.
 */
export async function shareProfit(ctx: Context): Promise<void> {
  const accounts = (await ctx.people.robot('accounts')).client;
  const month = ctx.monthsAgo(1);
  const distributionId = ctx.id(`distribution:${month}`);
  const declaredAlready = itemsOf<{ id: string }>(
    await accounts.get('/v1/investors/distributions'),
  ).some((row) => row.id === distributionId);
  if (!declaredAlready) {
    const admin = (await ctx.people.robot('admin')).client;
    const declared = await accounts.post<{ status: string; approvalId?: string | null }>(
      '/v1/investors/distributions',
      {
        distributionId,
        month,
        totalPoisha: '5000000',
        basis: 'share_bps',
        memo: `Profit share for ${month}`,
      },
    );
    if (declared.status === 'pending_approval' && declared.approvalId != null) {
      await admin.post(`/v1/approvals/${declared.approvalId}/decide`, {
        decision: 'approved',
        note: 'Matches the month’s accounts',
      });
    }
  }
  const investors = itemsOf<{ id: string; code: string }>(await accounts.get('/v1/investors'));
  const first = investors.find((row) => row.code === 'INV-01');
  if (first === undefined) return;
  const requested = itemsOf<unknown>(
    await accounts.get(`/v1/investors/withdrawals?investorId=${first.id}`),
  );
  if (requested.length === 0) {
    await accounts.post('/v1/investors/withdrawals', {
      withdrawalId: ctx.id('withdrawal:1'),
      investorId: first.id,
      kind: 'profit',
      amountPoisha: '1000000',
      reason: 'Investor asked for part of the profit share',
    });
  }
}

// ---------------------------------------------------------------------------------------

export async function ensureCash(ctx: Context): Promise<void> {
  const accounts = (await ctx.people.robot('accounts')).client;
  const wallet = (code: string) => ctx.ids.wallets[code] ?? '';
  const categories = itemsOf<{ id: string; code: string; subtype: string; name: string }>(
    await accounts.get('/v1/accounts/categories'),
  );
  // By code, never by position: the list is ordered by code, and the owner reads this
  // profit and loss line by line (the seeded chart, coa-template.ts).
  const category = (code: string) => categories.find((row) => row.code === code);
  const income = category('4300');
  const utilities = category('5810');
  const miscellaneous = category('5890');
  for (const [code, found] of [
    ['4300', income],
    ['5810', utilities],
    ['5890', miscellaneous],
  ] as const) {
    if (found === undefined) ctx.note(`no category account ${code}; its cash entry is skipped`);
  }

  await accounts.post('/v1/accounts/transfers', {
    transferId: ctx.id('transfer:bank-to-office'),
    fromWalletId: wallet('1100'),
    toWalletId: wallet('1010-HQ'),
    amountPoisha: '2000000',
    memo: 'Office cash for the week',
  });
  await accounts.post('/v1/accounts/transfers', {
    transferId: ctx.id('transfer:bank-to-bkash'),
    fromWalletId: wallet('1100'),
    toWalletId: wallet('1110'),
    amountPoisha: '1500000',
    memo: 'bKash float for refunds',
  });
  if (income !== undefined) {
    await accounts.post('/v1/accounts/cash-entries', {
      entryId: ctx.id('cash:scrap'),
      walletId: wallet('1010-HQ'),
      kind: 'cash_in',
      categoryAccountId: income.id,
      amountPoisha: '120000',
      memo: 'Sold leftover fabric offcuts',
    });
  }
  if (utilities !== undefined) {
    await accounts.post('/v1/accounts/cash-entries', {
      entryId: ctx.id('cash:utilities'),
      walletId: wallet('1010-HQ'),
      kind: 'cash_out',
      categoryAccountId: utilities.id,
      amountPoisha: '450000',
      memo: 'Electricity and internet bill',
    });
  }
  if (miscellaneous !== undefined) {
    await accounts.post('/v1/accounts/cash-entries', {
      entryId: ctx.id('cash:packing-team-tea'),
      walletId: wallet('1010-HQ'),
      kind: 'cash_out',
      categoryAccountId: miscellaneous.id,
      amountPoisha: '80000',
      memo: 'Tea and snacks for the packing team',
    });
  }
}

export async function ensureLoan(ctx: Context): Promise<void> {
  const accounts = (await ctx.people.robot('accounts')).client;
  const admin = (await ctx.people.robot('admin')).client;
  const lenders = itemsOf<{ id: string; name: string }>(await accounts.get('/v1/loans/lenders'));
  const lenderId =
    lenders.find((row) => row.name === 'Demo Bank Ltd')?.id ??
    (
      await accounts.post<{ id: string }>('/v1/loans/lenders', {
        name: 'Demo Bank Ltd',
        kind: 'bank',
        notes: 'Preview demo lender',
      })
    ).id;
  const loan = await accounts.post<{
    loan?: { id: string };
    id?: string;
    instalments: { id: string; seq: number }[];
  }>('/v1/loans', {
    loanId: ctx.id('loan:1'),
    lenderId,
    principalPoisha: '30000000',
    rateBps: 1200,
    method: 'reducing',
    tenureMonths: 6,
    walletAccountId: account(ctx, '1100'),
    reference: 'TL-DEMO-001',
    reminderDays: 3,
  });
  const loanId = loan.loan?.id ?? loan.id ?? ctx.id('loan:1');
  const statement = await accounts.get<{
    instalments: { id: string; seq: number; state?: string }[];
  }>(`/v1/loans/${loanId}`);
  const firstInstalment = statement.instalments.find((row) => row.seq === 1);
  if (firstInstalment !== undefined && firstInstalment.state !== 'paid') {
    const paid = await accounts.post<{ status: string; approvalId?: string | null }>(
      `/v1/loans/${loanId}/payments`,
      {
        paymentId: ctx.id('loan:1:payment:1'),
        instalmentId: firstInstalment.id,
        walletAccountId: account(ctx, '1100'),
        memo: 'First instalment, paid early',
      },
    );
    if (paid.status === 'pending_approval' && paid.approvalId != null) {
      await admin.post(`/v1/approvals/${paid.approvalId}/decide`, {
        decision: 'approved',
        note: 'Instalment matches the schedule',
      });
    }
  }
}

// ---------------------------------------------------------------------------------------

interface Employee {
  id: string;
  code: string;
}

export async function ensurePeople(ctx: Context): Promise<void> {
  const hr = (await ctx.people.as('hr')).client;
  const calendars = itemsOf<{ id: string; code: string }>(await hr.get('/v1/hr/calendars'));
  const standard = calendars.find((row) => row.code === 'STD');
  if (standard !== undefined) {
    for (const [holidayDate, label] of [
      ['2026-12-16', 'Victory Day'],
      ['2026-12-25', 'Christmas Day'],
      ['2027-02-21', 'Language Martyrs Day'],
    ] as const) {
      await hr.post(`/v1/hr/calendars/${standard.id}/holidays`, { holidayDate, label });
    }
  }

  const plans = [
    {
      code: 'ELB-001',
      fullName: 'Preview Sales Agent',
      login: 'sales',
      designation: 'Order Desk Agent',
      department: 'Sales',
      branch: 'hq',
      basic: 2_200_000n,
    },
    {
      code: 'ELB-002',
      fullName: 'Preview Warehouse',
      login: 'warehouse',
      designation: 'Warehouse Lead',
      department: 'Operations',
      branch: 'hq',
      basic: 2_000_000n,
    },
    {
      code: 'ELB-003',
      fullName: 'Preview Branch Manager',
      login: 'branch',
      designation: 'Showroom Manager',
      department: 'Retail',
      branch: 'showroom',
      basic: 3_500_000n,
    },
    {
      code: 'ELB-004',
      fullName: 'Preview Marketing',
      login: 'marketing',
      designation: 'Digital Marketer',
      department: 'Marketing',
      branch: 'hq',
      basic: 2_800_000n,
    },
    {
      code: 'ELB-005',
      fullName: 'Demo Staff Rafi',
      designation: 'Showroom Sales',
      department: 'Retail',
      branch: 'showroom',
      basic: 1_500_000n,
    },
    {
      code: 'ELB-006',
      fullName: 'Demo Staff Lima',
      designation: 'Customer Care',
      department: 'Sales',
      branch: 'hq',
      basic: 1_600_000n,
    },
  ] as const;

  const existing = itemsOf<Employee>(await hr.get('/v1/hr/employees?pageSize=200'));
  for (const plan of plans) {
    const found = existing.find((row) => row.code === plan.code);
    let id = found?.id;
    if (id === undefined) {
      const userId = 'login' in plan ? await ctx.people.idOf(plan.login) : undefined;
      id = (
        await hr.post<{ id: string }>('/v1/hr/employees', {
          code: plan.code,
          fullName: plan.fullName,
          designation: plan.designation,
          department: plan.department,
          joinDate: '2025-01-15',
          branchId: plan.branch === 'hq' ? ctx.ids.hqBranchId : ctx.ids.showroomBranchId,
          payoutMethod: 'cash',
          ...(userId === undefined ? {} : { userId }),
        })
      ).id;
      await hr.post(`/v1/hr/employees/${id}/salary`, {
        effectiveFrom: '2026-07-01',
        basicPoisha: String(plan.basic),
        components: [
          {
            direction: 'earning',
            code: 'house_rent',
            label: 'House rent',
            // House rent at half the basic, as Bangladeshi salary structures usually set it.
            amountPoisha: String(percentOf(poisha(plan.basic), 5000)),
          },
          {
            direction: 'earning',
            code: 'transport',
            label: 'Transport',
            amountPoisha: '150000',
          },
        ],
      });
      ctx.count('employees');
    }
    ctx.ids.employees[plan.code] = id;
  }

  // Last month's exceptions: everything not written down counts as present.
  const last = ctx.monthsAgo(1);
  const day = (n: number) => `${last}-${String(n).padStart(2, '0')}`;
  const employee = (code: string) => ctx.ids.employees[code] ?? '';
  await hr.put('/v1/hr/attendance', {
    entries: [
      {
        employeeId: employee('ELB-005'),
        businessDate: day(8),
        status: 'absent',
        note: 'No call, no show',
      },
      {
        employeeId: employee('ELB-005'),
        businessDate: day(15),
        status: 'late',
        checkIn: '10:40',
        checkOut: '19:00',
      },
      {
        employeeId: employee('ELB-006'),
        businessDate: day(10),
        status: 'leave_paid',
        note: 'Family wedding',
      },
      {
        employeeId: employee('ELB-002'),
        businessDate: day(22),
        status: 'half_day',
        checkIn: '09:00',
        checkOut: '13:00',
      },
      {
        employeeId: employee('ELB-001'),
        businessDate: day(3),
        status: 'late',
        checkIn: '09:55',
        checkOut: '18:30',
      },
    ],
  });
}

/** August paid, September waiting for the org admin; a staff loan deducted from both. */
export async function ensurePayroll(ctx: Context): Promise<void> {
  const hr = (await ctx.people.as('hr')).client;
  const accounts = (await ctx.people.robot('accounts')).client;
  const admin = (await ctx.people.robot('admin')).client;
  const runs = itemsOf<unknown>(await hr.get('/v1/hr/payroll/runs'));
  if (runs.length > 0) return;

  const august = ctx.monthsAgo(2);
  const september = ctx.monthsAgo(1);
  const loan = await hr.post<{ id: string }>('/v1/hr/loans', {
    employeeId: ctx.ids.employees['ELB-005'],
    principalPoisha: '600000',
    instalmentCount: 3,
    firstMonth: august,
    note: 'Advance for a family emergency',
  });
  await accounts.post(`/v1/hr/loans/${loan.id}/disburse`, {
    walletAccountId: account(ctx, '1010-HQ'),
  });

  const paid = await hr.post<{ id: string }>('/v1/hr/payroll/runs', {
    month: august,
    unrecordedPolicy: 'present',
    memo: `Salaries for ${august}`,
  });
  const submitted = await hr.post<{ approvalId: string }>(`/v1/hr/payroll/runs/${paid.id}/submit`, {
    reason: 'Monthly salaries',
  });
  await admin.post(`/v1/approvals/${submitted.approvalId}/decide`, {
    decision: 'approved',
    note: 'Checked against attendance',
  });
  await accounts.post(`/v1/hr/payroll/runs/${paid.id}/pay`, {
    walletAccountId: account(ctx, '1100'),
    memo: `Salaries for ${august}, bank transfer`,
  });

  const waiting = await hr.post<{ id: string }>('/v1/hr/payroll/runs', {
    month: september,
    unrecordedPolicy: 'present',
    memo: `Salaries for ${september}`,
  });
  await hr.post(`/v1/hr/payroll/runs/${waiting.id}/inputs`, {
    employeeId: ctx.ids.employees['ELB-001'],
    kind: 'bonus',
    label: 'Best agent of the month',
    amountPoisha: '200000',
  });
  await hr.post(`/v1/hr/payroll/runs/${waiting.id}/submit`, { reason: 'Monthly salaries' });
  ctx.count('payroll runs', 2);
}

/** This month's target for the sales agent, and a bonus rule approved by a second person. */
export async function ensureTargets(ctx: Context): Promise<void> {
  const hr = (await ctx.people.as('hr')).client;
  const admin = (await ctx.people.robot('admin')).client;
  const month = ctx.today().slice(0, 7);
  const targets = itemsOf<unknown>(await hr.get(`/v1/hr/targets?month=${month}`));
  if (targets.length === 0) {
    await hr.post('/v1/hr/targets', {
      scope: 'employee',
      month,
      metric: 'confirmed_orders',
      employeeId: ctx.ids.employees['ELB-001'],
      targetValue: '40',
    });
    await hr.post('/v1/hr/targets', {
      scope: 'employee',
      month,
      metric: 'delivered_revenue',
      employeeId: ctx.ids.employees['ELB-001'],
      targetValue: '15000000',
    });
    ctx.count('targets', 2);
  }
  await hr.post('/v1/hr/targets/refresh', {});

  const rules = itemsOf<{ id: string; name: string }>(await hr.get('/v1/hr/bonus-rules'));
  if (!rules.some((row) => row.name === 'Desk confirmations')) {
    const rule = await hr.post<{ id: string; versions: { id: string }[] }>('/v1/hr/bonus-rules', {
      name: 'Desk confirmations',
      definition: {
        metric: 'confirmed_orders',
        tiers: [
          { gte_pct: 100, amount_poisha: 200000 },
          { gte_pct: 120, per_unit_above_target_poisha: 5000 },
        ],
        cap_poisha: '1000000',
      },
    });
    const version = rule.versions[0];
    if (version !== undefined) {
      const submitted = await hr.post<{ versions: { id: string; approvalId: string | null }[] }>(
        `/v1/hr/bonus-rules/versions/${version.id}/submit`,
        { reason: 'Bonus for the desk this season' },
      );
      const approvalId = submitted.versions.find((entry) => entry.id === version.id)?.approvalId;
      if (approvalId != null) {
        await admin.post(`/v1/approvals/${approvalId}/decide`, {
          decision: 'approved',
          note: 'Agreed with the owner',
        });
      }
    }
  }
}

// ---------------------------------------------------------------------------------------

interface TillSale {
  readonly receipt: string;
  readonly items: readonly (readonly [slug: string, size: string, qty: number])[];
  readonly tenders: readonly ('cash' | 'bkash' | 'card')[];
}

const TILL_SALES: readonly TillSale[] = [
  { receipt: 'DHN1-1-0001', items: [['classic-cotton-tee', 'M', 2]], tenders: ['cash'] },
  { receipt: 'DHN1-1-0002', items: [['festive-cotton-panjabi', 'L', 1]], tenders: ['bkash'] },
  {
    receipt: 'DHN1-1-0003',
    items: [
      ['premium-polo-shirt', 'L', 1],
      ['linen-casual-shirt', 'M', 1],
    ],
    tenders: ['cash', 'card'],
  },
];

/** A till in the showroom, a shift with three sales, closed with the drawer counted. */
export async function ensureTill(ctx: Context): Promise<void> {
  const admin = (await ctx.people.robot('admin')).client;
  const branch = (await ctx.people.as('branch')).client;
  const registers = itemsOf<{ id: string; code: string }>(await admin.get('/v1/pos/registers'));
  const registerId =
    registers.find((row) => row.code === 'DHN1')?.id ??
    (
      await admin.post<{ id: string }>('/v1/pos/registers', {
        branchId: ctx.ids.showroomBranchId,
        locationId: ctx.ids.showroomId,
        code: 'DHN1',
        name: 'Dhanmondi till 1',
        cashWalletId: ctx.ids.wallets['1010-DHN'],
        cardWalletId: ctx.ids.wallets['1100'],
        bkashWalletId: ctx.ids.wallets['1110'],
      })
    ).id;

  const shifts = itemsOf<unknown>(await branch.get('/v1/pos/shifts'));
  if (shifts.length > 0) return;
  const shiftId = ctx.id('shift:1');
  await branch.post('/v1/pos/shifts', { shiftId, registerId, openingFloatPoisha: '500000' });

  const documents = TILL_SALES.map((sale, index) => {
    const lines = sale.items.map(([slug, size, qty], lineIndex) => {
      const sku = ctx.sku(slug, size);
      return {
        lineNo: lineIndex + 1,
        skuId: sku.id,
        qty,
        unitPricePoisha: sku.pricePoisha,
        discountPoisha: '0',
      };
    });
    const net = sum(lines.map((line) => mulQty(poisha(line.unitPricePoisha), line.qty)));
    // Split evenly across the tenders, to the poisha, by the one allocation rule.
    const shares = allocate(
      net,
      sale.tenders.map(() => 1),
    );
    const tenders = sale.tenders.map((tender, tenderIndex) => ({
      tender,
      amountPoisha: String(shares[tenderIndex] ?? 0n),
      ...(tender === 'cash'
        ? {}
        : { reference: `PV${String(index + 1)}${String(tenderIndex + 1)}TRX` }),
    }));
    const cash = tenders.find((tender) => tender.tender === 'cash');
    return {
      kind: 'sale',
      id: ctx.id(`sale:${sale.receipt}`),
      registerId,
      shiftId,
      receiptNo: sale.receipt,
      occurredAt: new Date().toISOString(),
      lines,
      tenders,
      ...(cash === undefined ? {} : { cashReceivedPoisha: cash.amountPoisha }),
      totals: { grossPoisha: String(net), discountPoisha: '0', netPoisha: String(net) },
    };
  });
  const synced = await branch.post<{ results: { outcome: string; reasons?: unknown }[] }>(
    '/v1/pos/sync',
    { documents },
  );
  for (const result of synced.results) {
    if (result.outcome !== 'posted') {
      ctx.note(`A till sale was ${result.outcome}: ${JSON.stringify(result.reasons ?? null)}`);
    }
  }
  ctx.count('till sales', synced.results.filter((result) => result.outcome === 'posted').length);

  const shift = await branch.get<{ drawer?: { expectedCashPoisha: string } }>(
    `/v1/pos/shifts/${shiftId}`,
  );
  await branch.post(`/v1/pos/shifts/${shiftId}/close`, {
    countedCashPoisha: shift.drawer?.expectedCashPoisha ?? '500000',
    note: 'Counted at closing time',
  });
}
