import { Inject, Injectable, Logger } from '@nestjs/common';
import { withOrg, type Tx } from '@elysium/db';
import { businessDate, formatBdPhoneForDisplay, poisha } from '@elysium/domain';

import type { ActiveContext } from '../../platform/http/context.js';
import { CATALOG_API, type CatalogApi } from '../catalog/catalog.api.js';
import { FILES_API, type FilesApi } from '../files/files.api.js';
import { loadFonts, type FontFile } from '../files/pdf/fonts.js';
import { GotenbergClient, type GotenbergAsset } from '../files/pdf/gotenberg.client.js';
import {
  paperFor,
  renderBatchHtml,
  renderOrderDocumentHtml,
  type DocumentBrand,
  type DocumentPaper,
  type OrderDocumentData,
  type OrderDocumentKind,
} from './order-documents.js';
import { orderScopeSql } from './orders.service.js';
import * as repo from './orders.repository.js';
import { OrdersError } from './orders.errors.js';
import { BrandLogoRegistry } from './ports/brand-logo.port.js';
import { CourierBookingRegistry } from './ports/courier-booking.port.js';

export {
  renderBatchHtml,
  renderLabelHtml,
  renderOrderInvoiceHtml,
  renderPackingSlipHtml,
  type OrderDocumentKind,
} from './order-documents.js';

/**
 * The invoice, the packing slip and the parcel label, as PDFs (architecture §22, §9; M43).
 *
 * The pages are drawn by `order-documents.ts` (pure, so a test reads them without a
 * renderer). This gathers what they need in one transaction inside the caller's §6 scope,
 * reads the brand's logo after that transaction, and has M04's Gotenberg slice print them at
 * their exact paper size with Inter uploaded beside the page (D-753).
 *
 * The scope matters here more than on most reads: a document is the whole order, in a form
 * that can be saved and forwarded, so a sales agent must not be able to pull the invoice of an
 * order that is not theirs by guessing an id. The same `orderScopeSql` the JSON endpoints use,
 * so the two cannot disagree about who may see what.
 */

/** The logo's bytes, under the file name the page references beside `index.html`. */
interface Logo {
  readonly asset: GotenbergAsset;
}

/** Image types a logo may be, and the extension the page names it by. */
const LOGO_TYPES: Readonly<Record<string, string>> = {
  'image/webp': 'webp',
  'image/png': 'png',
  'image/jpeg': 'jpg',
};

interface Gathered {
  readonly brand: DocumentBrand;
  readonly data: OrderDocumentData;
  /** The logo's file id, read in the transaction and fetched after it (invariant 6). */
  readonly logoFileId: string | null;
}

function suffixOf(kind: OrderDocumentKind, paper: DocumentPaper): string {
  if (kind === 'packing_slip') return paper === 'a5' ? 'packing-slip-a5' : 'packing-slip';
  return kind;
}

function withLogo(brand: DocumentBrand, logo: Logo | null): DocumentBrand {
  return logo === null ? brand : { ...brand, logo: logo.asset.filename };
}

function assetsFor(fonts: readonly FontFile[], logo: Logo | null): GotenbergAsset[] {
  return [
    ...fonts.map((font) => ({
      filename: font.filename,
      bytes: font.bytes,
      contentType: 'font/woff2',
    })),
    ...(logo === null ? [] : [logo.asset]),
  ];
}

@Injectable()
export class DocumentsService {
  private readonly logger = new Logger(DocumentsService.name);

  constructor(
    private readonly gotenberg: GotenbergClient,
    @Inject(CATALOG_API) private readonly catalog: CatalogApi,
    @Inject(FILES_API) private readonly files: FilesApi,
    private readonly couriers: CourierBookingRegistry,
    private readonly logos: BrandLogoRegistry,
  ) {}

  /** The bytes, for the controller to send. */
  async render(
    context: ActiveContext,
    request: object,
    orderId: string,
    kind: OrderDocumentKind,
    paper: DocumentPaper = 'a4',
  ): Promise<{ bytes: Uint8Array; filename: string }> {
    const gathered = await this.gather(context, request, orderId);
    const [fonts, logo] = await Promise.all([
      loadFonts(),
      this.logo(context.orgId, gathered.logoFileId),
    ]);
    const html = renderOrderDocumentHtml(
      kind,
      withLogo(gathered.brand, logo),
      gathered.data,
      fonts,
      paper,
    );

    const bytes = await this.gotenberg.renderPdf({
      html,
      assets: assetsFor(fonts, logo),
      ...paperFor(kind, paper),
    });
    return { bytes, filename: `${gathered.data.orderNo}-${suffixOf(kind, paper)}.pdf` };
  }

  /**
   * Many orders' documents in one PDF (M11 bulk print).
   *
   * Every id goes through `gather`, which applies the caller's §6 scope to each one, and a
   * single id outside it refuses the whole batch as not found. Printing the rest silently
   * would hand back a PDF one page short with nothing to say which order is missing — and
   * a warehouse that trusts the page count ships one parcel without its invoice.
   *
   * Gathered one after another rather than in parallel: each is its own short transaction,
   * and a hundred concurrent ones would take a hundred pool connections away from the desk
   * for the length of a print.
   */
  async renderMany(
    context: ActiveContext,
    request: object,
    orderIds: readonly string[],
    kind: OrderDocumentKind,
    paper: DocumentPaper = 'a4',
  ): Promise<{ bytes: Uint8Array; filename: string }> {
    let first: Gathered | undefined;
    const documents: OrderDocumentData[] = [];
    for (const orderId of orderIds) {
      const gathered = await this.gather(context, request, orderId);
      first ??= gathered;
      documents.push(gathered.data);
    }
    if (first === undefined) throw new OrdersError('ORDER_NOT_FOUND', 'No orders to print.');

    const [fonts, logo] = await Promise.all([
      loadFonts(),
      this.logo(context.orgId, first.logoFileId),
    ]);
    const bytes = await this.gotenberg.renderPdf({
      html: renderBatchHtml({ kind, brand: withLogo(first.brand, logo), documents, fonts, paper }),
      assets: assetsFor(fonts, logo),
      ...paperFor(kind, paper),
      // A hundred pages is well past the single-document default of thirty seconds.
      timeoutMs: 120_000,
    });
    return {
      bytes,
      filename: `orders-${businessDate(new Date())}-${String(documents.length)}-${suffixOf(kind, paper)}.pdf`,
    };
  }

  /** Everything the page needs, in one transaction and inside the caller's scope. */
  async gather(context: ActiveContext, request: object, orderId: string): Promise<Gathered> {
    return withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
      const order = await repo.orderByIdInScope(
        tx,
        context.orgId,
        orderId,
        orderScopeSql(context, request),
      );
      if (order === undefined) throw new OrdersError('ORDER_NOT_FOUND', 'No such order.');

      const [lines, orgBrand, area] = await Promise.all([
        repo.orderLines(tx, context.orgId, order.id),
        repo.orgBrand(tx, context.orgId),
        repo.areaNames(tx, order.ship_district_id, order.ship_thana_id),
      ]);
      // Size and colour in their own columns, from the module that owns them (invariant 12).
      const variants = await this.catalog.variantParts(
        tx,
        context.orgId,
        lines.map((line) => line.sku_id),
      );
      const courier = await this.courierOf(tx, context.orgId, order.id, order.courier_id);
      const websiteLogo =
        (await this.logos.current()?.websiteLogoFileId(tx, context.orgId)) ?? null;

      const block = (orgBrand?.brand ?? {}) as {
        address?: unknown;
        vatNo?: unknown;
        invoiceFooter?: unknown;
        logoFileId?: unknown;
      };

      return {
        brand: {
          displayName: orgBrand?.display_name ?? '',
          legalName: orgBrand?.legal_name ?? '',
          address: typeof block.address === 'string' ? block.address : null,
          vatNo: typeof block.vatNo === 'string' ? block.vatNo : null,
          invoiceFooter: typeof block.invoiceFooter === 'string' ? block.invoiceFooter : null,
          logo: null,
        },
        // The brand block's logo (D-034) first, else the website's (D-754).
        logoFileId: typeof block.logoFileId === 'string' ? block.logoFileId : websiteLogo,
        data: {
          orderNo: order.order_no,
          // The order's Asia/Dhaka business date, not `created_at` formatted in UTC: an
          // order taken at 00:30 in Dhaka is that day's order, and the date on the
          // invoice has to be the date in the books (invariant 8).
          issuedOn: businessDate(new Date(order.created_at)),
          channel: order.channel,
          customerName: order.ship_name,
          customerPhone: formatBdPhoneForDisplay(order.ship_phone_e164),
          addressLine: order.ship_address_line,
          // English names only (D-750, D-756); `name_bn` stays in `ref` for the website.
          locality: [order.ship_area, area?.thana_en]
            .filter((part): part is string => part != null && part.trim() !== '')
            .join(', '),
          district: area?.district_en ?? '',
          lines: lines.map((line) => {
            const parts = variants.get(line.sku_id);
            return {
              name: line.product_name,
              sku: line.sku_code,
              size: parts?.size ?? null,
              colour: parts?.colour ?? null,
              other: parts?.other ?? null,
              qty: line.qty,
              unitPricePoisha: poisha(BigInt(line.unit_price_poisha)),
              lineDiscountPoisha: poisha(BigInt(line.discount_poisha)),
            };
          }),
          itemsPoisha: poisha(BigInt(order.items_poisha)),
          discountPoisha: poisha(BigInt(order.discount_poisha)),
          deliveryChargePoisha: poisha(BigInt(order.delivery_charge_poisha)),
          advancePaidPoisha: poisha(BigInt(order.advance_paid_poisha)),
          codAmountPoisha: poisha(BigInt(order.cod_amount_poisha)),
          notes: order.notes,
          courier,
        },
      };
    });
  }

  /**
   * The courier the parcel goes with: the booked parcel's, with its consignment and tracking
   * numbers, else the courier chosen on the order, else none.
   */
  private async courierOf(
    tx: Tx,
    orgId: string,
    orderId: string,
    plannedCourierId: string | null,
  ): Promise<OrderDocumentData['courier']> {
    const parcel = (await this.couriers.current()?.parcelTracking(tx, orgId, orderId)) ?? null;
    const courierId = parcel?.courierId ?? plannedCourierId;
    if (courierId === null) return null;
    const [party] = await repo.couriersByIds(tx, orgId, [courierId]);
    return {
      name: party?.name ?? 'Courier',
      consignmentNo: parcel?.consignmentNo ?? null,
      trackingCode: parcel?.trackingCode ?? null,
    };
  }

  /**
   * The brand's logo bytes, after the transaction (invariant 6): a stored public website
   * image of this brand, its card size. Anything else — none set, not found, storage down —
   * prints the brand's name alone rather than failing a print run over a picture (D-754).
   */
  private async logo(orgId: string, fileId: string | null): Promise<Logo | null> {
    if (fileId === null) return null;
    try {
      const image = await this.files.publicImage(orgId, fileId, 'card');
      const extension = image === null ? undefined : LOGO_TYPES[image.mime];
      if (image === null || extension === undefined) return null;
      return {
        asset: { filename: `logo.${extension}`, bytes: image.bytes, contentType: image.mime },
      };
    } catch (error) {
      this.logger.warn(
        `The brand logo could not be read for a document: ${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    }
  }
}
