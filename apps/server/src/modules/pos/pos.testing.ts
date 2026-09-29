import { readFile } from 'node:fs/promises';
import path from 'node:path';

import type { Provider } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { withSystem, type Tx } from '@elysium/db';
import { sql } from 'drizzle-orm';

import { INVENTORY_API, type InventoryApi } from '../inventory/inventory.api.js';
import { MovementsService } from '../inventory/movements.service.js';
import { ClosingsService } from '../wallets/closings.service.js';
import { MovementsPosStock } from './ports/movements-pos-stock.js';
import { POS_CATALOG, type PosCatalogPort, type SellableSku } from './ports/pos-catalog.port.js';
import { POS_STOCK } from './ports/pos-stock.port.js';
import { POS_WALLET_CLOSING, type WalletClosingPort } from './ports/wallet-closing.port.js';

/**
 * Test-only setup for the POS suites, following `catalog.testing.ts`.
 *
 * Three jobs, all because of how this session is split rather than anything about
 * the POS:
 *
 * 1. **Apply M23's migrations.** The journal (`migrations/meta/_journal.json`) is
 *    integrated separately, so until it lists 0068–0070 `startTestDatabase()` does
 *    not run them. This runs the files that ship, split on the migrator's own
 *    marker, and returns early once the schema exists — a no-op after integration.
 * 2. **Bind the ports to the real services.** `POS_STOCK` and `POS_WALLET_CLOSING`
 *    refuse by default until inventory and wallets implement them. Here they are
 *    bound to the application's own `MovementsService` and `ClosingsService`
 *    instances — found through `ModuleRef`, which a test may do and production
 *    code may not — so the acceptance tests read real stock levels and real M08
 *    closings, not a double's bookkeeping.
 * 3. **A price list.** `POS_CATALOG`'s test double reads `catalog.skus` directly:
 *    a fixture, not a production path, which is why it is here.
 */

const MIGRATIONS = ['0068_pos_schema.sql', '0069_pos_policies.sql', '0070_pos_integrity.sql'] as const;

function migrationsDir(): string {
  return path.resolve(import.meta.dirname, '../../../../../packages/db/migrations');
}

export async function applyPosMigrations(): Promise<void> {
  const already = await withSystem(async (tx) => {
    const rows = await tx.execute<{ present: boolean }>(
      sql`select to_regnamespace('pos') is not null as present`,
    );
    return rows[0]?.present === true;
  });
  if (already) return;

  const directory = migrationsDir();
  for (const name of MIGRATIONS) {
    const contents = await readFile(path.join(directory, name), 'utf8');
    await withSystem(async (tx) => {
      for (const statement of contents.split('--> statement-breakpoint')) {
        const trimmed = statement.trim();
        if (trimmed === '') continue;
        await tx.execute(sql.raw(trimmed));
      }
    });
  }
}

/** Reads the catalog tables directly. Test fixture only. */
export class TableBackedPosCatalog implements PosCatalogPort {
  async sellableSkus(
    tx: Tx,
    orgId: string,
    page: { readonly afterCode: string | null; readonly limit: number },
  ): Promise<SellableSku[]> {
    const rows = await tx.execute<{
      id: string;
      code: string;
      barcode: string | null;
      product_name: string;
      price_poisha: string;
    }>(sql`
      select s.id, s.code, s.barcode, p.name as product_name, s.price_poisha::text as price_poisha
      from catalog.skus s
      join catalog.products p on p.org_id = s.org_id and p.id = s.product_id
      where s.org_id = ${orgId} and s.status = 'active' and p.status = 'active'
        and ${page.afterCode === null ? sql`true` : sql`s.code > ${page.afterCode}`}
      order by s.code
      limit ${page.limit}
    `);
    return rows.map((row) => ({
      id: row.id,
      code: row.code,
      barcode: row.barcode,
      productName: row.product_name,
      pricePoisha: BigInt(row.price_poisha),
    }));
  }
}

/** The providers a suite passes to `PosModule.register()`. */
export function posTestProviders(): Provider[] {
  return [
    {
      provide: POS_STOCK,
      inject: [ModuleRef],
      useFactory: (moduleRef: ModuleRef) =>
        new MovementsPosStock(
          () => moduleRef.get(MovementsService, { strict: false }),
          () => moduleRef.get<InventoryApi>(INVENTORY_API, { strict: false }),
        ),
    },
    {
      provide: POS_WALLET_CLOSING,
      inject: [ModuleRef],
      useFactory: (moduleRef: ModuleRef): WalletClosingPort => ({
        close: (context, request, input) =>
          moduleRef.get(ClosingsService, { strict: false }).close(context, request, input),
      }),
    },
    { provide: POS_CATALOG, useClass: TableBackedPosCatalog },
  ];
}
