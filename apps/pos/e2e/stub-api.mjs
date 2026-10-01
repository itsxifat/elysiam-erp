import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';

import { posSyncSchema } from '@elysium/contracts';

/**
 * A stand-in for the API, for the till's browser tests (M23 checks 1 and 4).
 *
 * The console's specs stub the API with `page.route`. The till cannot: it runs
 * behind a service worker, and the spec takes the browser *genuinely* offline —
 * both of which make in-page route interception the wrong tool. So this is a real
 * HTTP server the browser either reaches or does not.
 *
 * It implements the **contract** of `POST /v1/pos/sync`, not its accounting: a
 * document is applied the first time its id arrives and answered as a replay every
 * time after, a mutation without the CSRF double-submit token is refused, a safe
 * request issues that token, and a sync body is validated with the server's own
 * schema (`posSyncSchema` from `@elysium/contracts`) — so a document the real
 * server would refuse is refused here too, and the spec sees it. The accounting — stock levels and wallet
 * balances read back from `ledger.journal_lines` — is proved against the real
 * server and a real PostgreSQL in `apps/server/src/modules/pos/pos.db.test.ts`.
 * What this lets the browser test prove is the till's half: what it sends, how
 * often, and that nothing is lost in between.
 *
 * `/__test/*` is the spec's window into the server: what arrived, in what order,
 * and a switch that makes the next sync arrive and then lose its reply.
 */

const PORT = Number(process.env.STUB_API_PORT ?? 3975);
const ORIGIN = process.env.POS_ORIGIN ?? 'http://localhost:5176';
const CSRF_COOKIE = 'elysium_csrf';
const CSRF_HEADER = 'x-elysium-csrf';

const REGISTER = {
  id: '7d0c5f2e-5b1a-4c2f-9e1b-0a1b2c3d4e01',
  branchId: '7d0c5f2e-5b1a-4c2f-9e1b-0a1b2c3d4e02',
  branchName: 'Gulshan showroom',
  locationId: '7d0c5f2e-5b1a-4c2f-9e1b-0a1b2c3d4e03',
  locationName: 'Gulshan floor',
  code: 'GUL1',
  name: 'Gulshan till 1',
  isActive: true,
  cashWalletId: '7d0c5f2e-5b1a-4c2f-9e1b-0a1b2c3d4e04',
  bkashWalletId: '7d0c5f2e-5b1a-4c2f-9e1b-0a1b2c3d4e05',
  cardWalletId: '7d0c5f2e-5b1a-4c2f-9e1b-0a1b2c3d4e06',
  tenders: ['cash', 'bkash', 'card'],
};

const PRICE_LIST = [
  {
    id: 'a1b2c3d4-0000-4000-8000-00000000000a',
    code: 'ELY-SHRT-0001',
    barcode: '8941234567890',
    name: 'Oxford shirt',
    pricePoisha: '150000',
    available: 10,
  },
  {
    id: 'a1b2c3d4-0000-4000-8000-00000000000b',
    code: 'ELY-SCRF-0002',
    barcode: null,
    name: 'Silk scarf',
    pricePoisha: '45050',
    available: 10,
  },
  // None on the shelf as far as the server knows: a sale of it is a shortfall.
  {
    id: 'a1b2c3d4-0000-4000-8000-00000000000c',
    code: 'ELY-BELT-0003',
    barcode: null,
    name: 'Leather belt',
    pricePoisha: '90000',
    available: 0,
  },
];

function freshState() {
  return {
    shift: null,
    /** Every sync request that reached the server, in order: the ids it carried. */
    deliveries: [],
    /** Documents applied, by id. A document is applied exactly once. */
    applied: new Map(),
    stock: new Map(PRICE_LIST.map((item) => [item.id, item.available])),
    wallets: { cash: 0n, bkash: 0n, card: 0n },
    dropNextSyncReply: false,
    csrfRefusals: 0,
    /** Sync bodies the contract refused, with the first problems in each. */
    invalidSyncs: [],
    requests: [],
  };
}

let state = freshState();

function cookies(request) {
  const jar = new Map();
  for (const part of (request.headers.cookie ?? '').split(';')) {
    const index = part.indexOf('=');
    if (index > 0) jar.set(part.slice(0, index).trim(), part.slice(index + 1).trim());
  }
  return jar;
}

function send(response, status, body, extra = {}) {
  response.writeHead(status, {
    'content-type': 'application/json',
    'access-control-allow-origin': ORIGIN,
    'access-control-allow-credentials': 'true',
    'access-control-allow-headers': `content-type,${CSRF_HEADER}`,
    'access-control-allow-methods': 'GET,POST,PATCH,OPTIONS',
    ...extra,
  });
  response.end(
    body === null
      ? ''
      : JSON.stringify(body, (_, value) => (typeof value === 'bigint' ? value.toString() : value)),
  );
}

/** Apply one document the first time it is seen; answer a replay ever after. */
function applyDocument(document) {
  const existing = state.applied.get(document.id);
  if (existing !== undefined) {
    return { ...existing.result, replayed: true };
  }
  let result;
  if (document.kind === 'sale') {
    const short = document.lines.filter((line) => (state.stock.get(line.skuId) ?? 0) < line.qty);
    if (short.length > 0) {
      result = {
        id: document.id,
        kind: 'sale',
        outcome: 'held',
        replayed: false,
        reviewItemId: `review-${document.id}`,
        reasons: ['stock_shortfall'],
        journalId: null,
        error: null,
      };
    } else {
      for (const line of document.lines)
        state.stock.set(line.skuId, state.stock.get(line.skuId) - line.qty);
      for (const tender of document.tenders)
        state.wallets[tender.tender] += BigInt(tender.amountPoisha);
      result = {
        id: document.id,
        kind: 'sale',
        outcome: 'posted',
        replayed: false,
        reviewItemId: null,
        reasons: [],
        journalId: `journal-${document.id}`,
        error: null,
      };
    }
  } else {
    result = {
      id: document.id,
      kind: 'return',
      outcome: 'posted',
      replayed: false,
      reviewItemId: null,
      reasons: [],
      journalId: `journal-${document.id}`,
      error: null,
    };
  }
  state.applied.set(document.id, { document, result });
  return result;
}

async function readBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString('utf8');
  return text === '' ? null : JSON.parse(text);
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? '/', `http://localhost:${String(PORT)}`);
  const path = url.pathname;
  const method = request.method ?? 'GET';

  if (method === 'OPTIONS') return send(response, 204, null);

  // --- the spec's controls: not part of the contract -----------------------------
  if (path === '/__test/reset') {
    state = freshState();
    return send(response, 200, { ok: true });
  }
  if (path === '/__test/drop-next-sync-reply') {
    state.dropNextSyncReply = true;
    return send(response, 200, { ok: true });
  }
  if (path === '/__test/state') {
    return send(response, 200, {
      deliveries: state.deliveries,
      applied: [...state.applied.values()].map((entry) => ({
        document: entry.document,
        outcome: entry.result.outcome,
      })),
      stock: Object.fromEntries(state.stock),
      wallets: state.wallets,
      csrfRefusals: state.csrfRefusals,
      invalidSyncs: state.invalidSyncs,
      requests: state.requests,
      shiftOpen: state.shift !== null,
    });
  }

  state.requests.push(`${method} ${path}`);
  const jar = cookies(request);
  const extra = {};

  // A safe request with no token issues one; a mutation must echo it (§25).
  if (method === 'GET' && !jar.has(CSRF_COOKIE)) {
    extra['set-cookie'] = `${CSRF_COOKIE}=${randomBytes(16).toString('hex')}; Path=/; SameSite=Lax`;
  }
  if (method !== 'GET') {
    const token = jar.get(CSRF_COOKIE);
    if (token === undefined || token === '' || request.headers[CSRF_HEADER] !== token) {
      state.csrfRefusals += 1;
      return send(response, 403, {
        code: 'FORBIDDEN',
        detail: 'CSRF token missing or mismatched.',
      });
    }
  }

  if (method === 'GET' && path === '/v1/me') {
    return send(
      response,
      200,
      { userId: 'usr_cashier', orgId: 'org', roles: ['branch_manager'] },
      extra,
    );
  }
  if (method === 'GET' && path === '/v1/pos/registers') {
    return send(response, 200, { items: [REGISTER] }, extra);
  }
  if (method === 'GET' && path === `/v1/pos/registers/${REGISTER.id}/session`) {
    return send(
      response,
      200,
      {
        register: REGISTER,
        openShift: state.shift,
        discountCeilingBps: 2000,
        receiptHeader: {
          displayName: 'Elysium',
          legalName: 'Elysium Lifestyle BD',
          branchName: 'Gulshan showroom',
          address: 'Road 11, Gulshan 1, Dhaka',
          phone: null,
          vatNo: null,
          footer: null,
        },
        serverTime: new Date().toISOString(),
        businessDate: new Date().toISOString().slice(0, 10),
        userId: 'usr_cashier',
      },
      extra,
    );
  }
  if (method === 'GET' && path === `/v1/pos/registers/${REGISTER.id}/price-list`) {
    return send(response, 200, { items: PRICE_LIST, next: null }, extra);
  }
  if (method === 'POST' && path === '/v1/pos/shifts') {
    const body = await readBody(request);
    state.shift = {
      id: body.shiftId,
      shiftNo: 1,
      openedBy: 'usr_cashier',
      openedAt: new Date().toISOString(),
      mine: true,
    };
    return send(response, 201, {
      id: body.shiftId,
      shiftNo: 1,
      status: 'open',
      openingFloatPoisha: body.openingFloatPoisha,
    });
  }
  if (method === 'POST' && path === '/v1/pos/sync') {
    const body = await readBody(request);
    const checked = posSyncSchema.safeParse(body);
    if (!checked.success) {
      const issues = checked.error.issues.slice(0, 5).map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
      }));
      state.invalidSyncs.push(issues);
      return send(response, 400, {
        code: 'VALIDATION_FAILED',
        detail: 'Not a valid sync.',
        issues,
      });
    }
    state.deliveries.push(body.documents.map((document) => document.id));
    const results = body.documents.map(applyDocument);
    if (state.dropNextSyncReply) {
      /*
       * The request arrived and was applied; the reply never makes it back — the
       * case the idempotency key exists for. Answered as a gateway timeout rather
       * than by cutting the socket: Chromium silently re-sends a request whose
       * keep-alive connection was reset before any response byte, so a cut socket
       * is retried *by the browser* and the till never learns anything went wrong.
       * A 504 is what a mobile carrier's proxy actually returns, and it is a
       * failure the till has to handle itself.
       */
      state.dropNextSyncReply = false;
      return send(response, 504, { code: 'SERVICE_UNAVAILABLE', detail: 'upstream timed out' });
    }
    return send(response, 200, { results });
  }

  return send(response, 404, { code: 'NOT_FOUND', detail: `${method} ${path}` }, extra);
});

server.listen(PORT, 'localhost');
