import { addDays, businessDate } from '@elysium/domain';
import type { BrandLiveResult, ConnectionTestWire, OwnerLinkWire } from '@elysium/mother-shared';

import { recordAudit, type Actor } from '../audit/audit.js';
import { mintOwnerLink, ownerLinkUrl } from '../crypto/owner-link.js';
import type { SecretsKey } from '../crypto/secrets.js';
import { MotherError } from '../http/errors.js';
import type { BrandPools } from './pools.js';
import {
  classifyBrandError,
  expectedBrandSchema,
  readLive,
  readOnly,
  readOrg,
  readVersion,
  sameSchema,
} from './reader.js';
import { ownerLinkKeyOf, requireBrand } from './registry.js';

/**
 * What a brand's page reads straight from the brand when it opens (D-481), the connection
 * test, and the owner sign-in link (D-490).
 */

export async function brandLive(
  pools: BrandPools,
  brandId: string,
  clock: () => Date = () => new Date(),
): Promise<BrandLiveResult> {
  const brand = await requireBrand(brandId);
  if (!brand.is_active) return { ok: false, error: { code: 'inactive' } };
  const today = businessDate(clock());
  try {
    const sql = pools.for(brand);
    return await readOnly(sql, async (tx): Promise<BrandLiveResult> => {
      const version = await readVersion(tx);
      if (!sameSchema(version, expectedBrandSchema())) {
        return { ok: false, error: { code: 'version_mismatch' } };
      }
      const org = await readOrg(tx, brand.slug);
      if (org === undefined || org.isTraining) {
        return { ok: false, error: { code: 'brand_not_found' } };
      }
      const rows = await readLive(tx, org.id, { from: addDays(today, -29), asOf: today });
      return {
        ok: true,
        live: {
          readAt: clock().toISOString(),
          latestOrders: rows.latestOrders.map((row) => ({
            orderNo: row.order_no,
            status: row.status,
            channel: row.channel,
            createdAt: new Date(row.created_at).toISOString(),
            totalPoisha: row.total_poisha,
          })),
          topProducts: rows.topProducts.map((row) => ({
            skuCode: row.sku_code,
            productName: row.product_name,
            units: row.units,
          })),
          lowStock: rows.lowStock.map((row) => ({
            skuCode: row.sku_code,
            productName: row.product_name,
            location: row.location,
            available: row.available,
            reorderLevel: row.reorder_level,
          })),
          wallets: rows.wallets.map((row) => ({
            code: row.code,
            name: row.name,
            subtype: row.subtype,
            balancePoisha: row.balance_poisha,
          })),
          courierCod: rows.courierCod.map((row) => ({
            courier: row.courier ?? '',
            heldPoisha: row.held_poisha,
          })),
          staff: {
            headcount: rows.staffHeadcount,
            people: rows.staff.map((row) => ({
              code: row.code,
              fullName: row.full_name,
              designation: row.designation,
              branch: row.branch,
              status: row.status,
            })),
          },
        },
      };
    });
  } catch (error) {
    const code = classifyBrandError(error);
    return { ok: false, error: { code } };
  }
}

/** Can the mother reach this brand, read its version, and find its org? */
export async function testConnection(
  pools: BrandPools,
  brandId: string,
  actor: Actor,
): Promise<ConnectionTestWire> {
  const brand = await requireBrand(brandId);
  const expected = expectedBrandSchema();
  let result: ConnectionTestWire;
  try {
    const sql = pools.for(brand);
    result = await readOnly(sql, async (tx): Promise<ConnectionTestWire> => {
      const version = await readVersion(tx);
      const org = await readOrg(tx, brand.slug);
      const brandFound = org !== undefined && !org.isTraining;
      const same = sameSchema(version, expected);
      return {
        ok: same && brandFound,
        code: !same ? 'version_mismatch' : brandFound ? 'ok' : 'brand_not_found',
        brandMigrations: version.count,
        expectedMigrations: expected.count,
        brandFound,
      };
    });
  } catch (error) {
    const code = classifyBrandError(error);
    result = {
      ok: false,
      code: code === 'permission_denied' ? 'version_mismatch' : code,
      brandMigrations: null,
      expectedMigrations: expected.count,
      brandFound: false,
    };
  }
  await recordAudit({
    actorUserId: actor.userId,
    action: 'brand.connection_tested',
    entityType: 'brand',
    entityId: brand.id,
    detail: { slug: brand.slug, result: result.code },
    ipAddress: actor.ipAddress,
    requestId: actor.requestId,
  });
  return result;
}

/**
 * A one-time link that signs this owner into the brand's ERP (D-473, D-490). Audited with
 * its `jti` before it is handed out, so every link the brand ever sees has a row here.
 */
export async function ownerLinkFor(
  secrets: SecretsKey,
  brandId: string,
  actor: Actor,
  clock: () => Date = () => new Date(),
): Promise<OwnerLinkWire> {
  const brand = await requireBrand(brandId);
  if (!brand.is_active) {
    throw new MotherError('BRAND_INACTIVE', 'This brand is switched off in the registry.');
  }
  const privateKeyDer = ownerLinkKeyOf(secrets, brand);
  const nowSeconds = Math.floor(clock().getTime() / 1000);
  const minted = mintOwnerLink({
    privateKeyDer,
    audience: brand.slug,
    email: actor.email,
    name: actor.name,
    nowSeconds,
  });
  await recordAudit({
    actorUserId: actor.userId,
    action: 'brand.owner_link.issued',
    entityType: 'brand',
    entityId: brand.id,
    detail: {
      slug: brand.slug,
      jti: minted.claims.jti,
      expiresAt: new Date(minted.claims.exp * 1000).toISOString(),
      keyFingerprint: brand.owner_link_key_fingerprint,
    },
    ipAddress: actor.ipAddress,
    requestId: actor.requestId,
  });
  return {
    url: ownerLinkUrl(brand.admin_url, minted.token),
    expiresAt: new Date(minted.claims.exp * 1000).toISOString(),
  };
}
