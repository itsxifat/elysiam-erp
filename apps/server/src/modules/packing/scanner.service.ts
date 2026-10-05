import { HttpException, HttpStatus, Inject, Injectable } from '@nestjs/common';
import { defineAbilityFor, scopeFilterFor } from '@elysium/contracts';
import {
  mustEnrolTwoFactor,
  resolveContext,
  withOrg,
  type RequestContext,
  type Tx,
} from '@elysium/db';
import { add, formatBdPhoneForDisplay, poisha, sub } from '@elysium/domain';
import { takaDecimal, wireMoney } from '@elysium/domain/storefront';
import { sql } from 'drizzle-orm';

import { AuditService } from '../../platform/audit/audit.service.js';
import { attachScope, scopeWhere } from '../../platform/auth/scope.js';
import type { ActiveContext } from '../../platform/http/context.js';
import { CATALOG_API, type CatalogApi } from '../catalog/catalog.api.js';
import { IAM_API, type IamApi } from '../iam/iam.api.js';
import { ORDERS_API, type OrdersApi, type PackingFacts } from '../orders/orders.api.js';
import { STOREFRONT_API, type StorefrontApi } from '../storefront/storefront.api.js';
import {
  DEVICE_TOKEN_DAYS,
  deviceTokenHash,
  newDeviceToken,
  orgIdOfDeviceToken,
} from './device-token.js';
import * as repo from './packing.repository.js';

/** A device's sign-in, verified for this request. */
export interface DeviceCaller {
  readonly orgId: string;
  readonly userId: string;
  readonly deviceId: string;
  readonly context: RequestContext;
}

function refusal(status: number, code: string, message: string): HttpException {
  return new HttpException({ code, message }, status);
}

const iso = (value: Date | string | null): string | null =>
  value === null ? null : new Date(value).toISOString();

/**
 * The packing scanner (M35b, D-554): the phones staff pack parcels with, and the console's Scan
 * page.
 *
 * A device signs in once and holds a 30-day token (kept as a hash, revocable). On every request
 * the person behind it is read again — an account switched off, a role taken away or a second
 * factor now required stops the phone at once — and the lookup is bound by the same `read
 * Order` scope the order desk's is (§6). A scanned code is an order number, a courier's
 * tracking code or consignment number; the answer is the packing list in the old app's shape.
 */
@Injectable()
export class ScannerService {
  constructor(
    @Inject(ORDERS_API) private readonly orders: OrdersApi,
    @Inject(CATALOG_API) private readonly catalog: CatalogApi,
    @Inject(IAM_API) private readonly iam: IamApi,
    @Inject(STOREFRONT_API) private readonly storefront: StorefrontApi,
    private readonly audit: AuditService,
  ) {}

  /** A new device for a person in a brand: the token, shown once (D-554). */
  async issue(input: {
    readonly orgId: string;
    readonly userId: string;
    readonly label: string;
    readonly via: 'password' | 'console';
    readonly actorUserId: string;
  }) {
    const token = newDeviceToken(input.orgId);
    const device = await withOrg({ orgId: input.orgId, userId: input.actorUserId }, async (tx) => {
      const row = await repo.insertDevice(tx, {
        orgId: input.orgId,
        userId: input.userId,
        label: input.label,
        tokenSha256: deviceTokenHash(token),
        via: input.via,
        days: DEVICE_TOKEN_DAYS,
      });
      await this.audit.record(tx, {
        orgId: input.orgId,
        actorUserId: input.actorUserId,
        operation: 'create',
        action: 'packing.scanner_signed_in',
        entityType: 'scanner_device',
        entityId: row.id,
        after: { userId: input.userId, label: input.label, via: input.via },
      });
      return row;
    });
    return { token, device: this.deviceView(device, null) };
  }

  /**
   * The device a bearer token names, and the person's live context; null for any token that
   * is unknown, revoked, expired, or whose person may no longer act here or read orders.
   */
  async verify(token: string, requestId: string): Promise<DeviceCaller | null> {
    const orgId = orgIdOfDeviceToken(token);
    if (orgId === null) return null;
    const device = await withOrg({ orgId }, (tx) =>
      repo.deviceByToken(tx, orgId, deviceTokenHash(token)),
    );
    if (device?.revoked_at !== null) return null;
    if (new Date(device.expires_at).getTime() <= Date.now()) return null;
    const context = await resolveContext({ userId: device.user_id, orgId, requestId });
    if (context === null) return null;
    if (await mustEnrolTwoFactor(device.user_id)) return null;
    if (!defineAbilityFor(context).can('read', 'Order')) return null;
    await withOrg({ orgId }, (tx) => repo.touchDevice(tx, orgId, device.id));
    return { orgId, userId: device.user_id, deviceId: device.id, context };
  }

  /** Hang the caller's `read Order` scope on the request, as the guard does for a session. */
  scope(request: object, caller: { readonly context: RequestContext }): void {
    const ctx = caller.context;
    attachScope(
      request,
      'read',
      'Order',
      scopeFilterFor(
        {
          roles: ctx.roles,
          isSuperAdmin: ctx.isSuperAdmin,
          userId: ctx.userId,
          branchIds: ctx.branchIds,
          branchIdsByRole: ctx.branchIdsByRole,
        },
        'read',
        'Order',
      ),
    );
  }

  /** The packing list a scanned code names, inside the caller's scope (the old app's shape). */
  async shipment(orgId: string, request: object, code: string, scannedBy: string | null) {
    const trimmed = code.trim();
    return withOrg({ orgId }, async (tx) => {
      const candidates = await this.orders.orderIdsForShipmentCode(tx, orgId, trimmed);
      let orderId: string | null = null;
      for (const id of candidates) {
        if (await this.orders.orderVisibleTo(tx, orgId, id, request)) {
          orderId = id;
          break;
        }
      }
      if (orderId === null) {
        // Nothing, or nothing the caller may see: one answer for both. No row is returned,
        // so the scope has nothing left to narrow.
        scopeWhere(request, { createdBy: sql`null`, assignedTo: sql`null`, branchId: sql`null` });
        return { found: false, code: trimmed };
      }
      const [facts] = await this.orders.packingFacts(tx, orgId, [orderId]);
      if (facts === undefined) return { found: false, code: trimmed };
      return {
        found: true,
        code: trimmed,
        scannedBy,
        order: await this.packingList(tx, orgId, facts),
      };
    });
  }

  private async packingList(tx: Tx, orgId: string, facts: PackingFacts) {
    const skuIds = [...new Set(facts.lines.map((line) => line.skuId))];
    const [skuFacts, stickers] = await Promise.all([
      this.catalog.webSkuFacts(tx, orgId, skuIds),
      this.catalog.stickerData(tx, orgId, skuIds),
    ]);
    const byId = new Map(skuFacts.map((fact) => [fact.id, fact]));
    const barcodes = new Map(stickers.map((sticker) => [sticker.skuId, sticker.barcode]));
    const productIds = [...new Set(skuFacts.map((fact) => fact.productId))];
    const images = await this.catalog.webImages(tx, orgId, productIds);
    const firstImage = new Map<string, string>();
    for (const image of images) {
      if (!firstImage.has(image.productId)) firstImage.set(image.productId, image.fileId);
    }
    const urls = await this.storefront.publicImageUrls(tx, orgId, [...firstImage.values()]);
    const total = add(
      sub(poisha(facts.itemsPoisha), poisha(facts.discountPoisha)),
      poisha(facts.deliveryChargePoisha),
    );
    const paid = facts.codAmountPoisha === 0n && total > 0n;
    const label = (skuId: string, kind: string): string =>
      byId.get(skuId)?.values.find((value) => value.kind === kind)?.label ?? '';
    const items = facts.lines.map((line) => {
      const productId = byId.get(line.skuId)?.productId;
      const fileId = productId === undefined ? undefined : firstImage.get(productId);
      return {
        skuId: line.skuId,
        name: line.productName,
        image: fileId === undefined ? '' : (urls.get(fileId) ?? ''),
        sku: line.skuCode,
        barcode: barcodes.get(line.skuId) ?? null,
        size: label(line.skuId, 'size'),
        color: label(line.skuId, 'colour'),
        quantity: line.qty,
        returnedQuantity: line.returnedQty,
      };
    });
    const recipient = facts.recipient;
    return {
      id: facts.id,
      orderNumber: facts.orderNo,
      status: facts.status,
      channel: facts.channel,
      createdAt: facts.createdAt.toISOString(),
      paymentMethod: paid ? 'prepaid' : 'cod',
      paid,
      // Decimal taka strings, as the scanner app prints them; the exact pair beside them.
      codAmount: takaDecimal(poisha(facts.codAmountPoisha)),
      totalAmount: takaDecimal(poisha(total)),
      cod: wireMoney(facts.codAmountPoisha),
      total: wireMoney(total),
      notes: facts.notes ?? '',
      courier: facts.parcel?.courierName ?? null,
      consignmentId: facts.parcel?.consignmentNo ?? null,
      trackingCode: facts.parcel?.trackingCode ?? '',
      recipient: {
        name: recipient.name,
        phone: formatBdPhoneForDisplay(recipient.phoneE164),
        address: [recipient.addressLine, recipient.area, recipient.thanaEn, recipient.districtEn]
          .filter((part): part is string => part !== null && part !== '')
          .join(', '),
      },
      itemCount: items.length,
      totalUnits: items.reduce((sum, item) => sum + item.quantity, 0),
      items,
    };
  }

  // --- the console ----------------------------------------------------------------------------

  /** The caller's own devices; every device of the brand for someone who manages staff. */
  async list(context: ActiveContext, everyone: boolean) {
    return withOrg(context, async (tx) => {
      const rows = await repo.devices(tx, context.orgId, everyone ? null : context.userId);
      const members = await this.iam.activeMembers(tx, context.orgId);
      const names = new Map(members.map((member) => [member.userId, member.name]));
      return {
        items: rows.map((row) => this.deviceView(row, names.get(row.user_id) ?? null)),
        everyone,
      };
    });
  }

  /** Pair a phone from a signed-in console (the old site's /scanner-connect): a code to paste. */
  async pair(context: ActiveContext, label: string | undefined) {
    if (!defineAbilityFor(context).can('read', 'Order')) {
      throw refusal(HttpStatus.FORBIDDEN, 'SCANNER_NOT_ALLOWED', 'Your role cannot read orders.');
    }
    return this.issue({
      orgId: context.orgId,
      userId: context.userId,
      label: label ?? 'Scanner',
      via: 'console',
      actorUserId: context.userId,
    });
  }

  /** End a device's sign-in: one's own, or anyone's for someone who manages staff. */
  async revoke(context: ActiveContext, id: string, anyone: boolean) {
    return withOrg(context, async (tx) => {
      const device = await repo.deviceById(tx, context.orgId, id);
      if (device === undefined || (!anyone && device.user_id !== context.userId)) {
        throw refusal(HttpStatus.NOT_FOUND, 'NOT_FOUND', 'No such scanner device.');
      }
      const revoked = await repo.revokeDevice(tx, context.orgId, id, context.userId);
      if (revoked) {
        await this.audit.record(tx, {
          orgId: context.orgId,
          actorUserId: context.userId,
          operation: 'update',
          action: 'packing.scanner_revoked',
          entityType: 'scanner_device',
          entityId: id,
          after: { userId: device.user_id },
        });
      }
      return { id, revoked: true };
    });
  }

  /** A device ends its own sign-in (the app's sign-out). */
  async signOut(caller: DeviceCaller) {
    await withOrg({ orgId: caller.orgId, userId: caller.userId }, async (tx) => {
      await repo.revokeDevice(tx, caller.orgId, caller.deviceId, caller.userId);
    });
    return { ok: true };
  }

  private deviceView(row: repo.DeviceRow, userName: string | null) {
    return {
      id: row.id,
      userId: row.user_id,
      userName,
      label: row.label,
      via: row.via,
      lastUsedAt: iso(row.last_used_at),
      expiresAt: iso(row.expires_at),
      revokedAt: iso(row.revoked_at),
      createdAt: iso(row.created_at),
      active: row.revoked_at === null && new Date(row.expires_at).getTime() > Date.now(),
    };
  }
}
