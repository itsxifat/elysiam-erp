import {
  BadRequestException,
  ConflictException,
  HttpException,
  NotFoundException,
} from '@nestjs/common';
import type { ErrorCode } from '@elysium/contracts';
import {
  Code128Error,
  CsvError,
  Ean13Error,
  MoneyError,
  SkuCodeError,
  VariantMatrixError,
} from '@elysium/domain';

/**
 * Catalog failures, as the API reports them (architecture §23, D-087).
 *
 * Same shape as the ledger's: a stable `code` from
 * `packages/contracts/src/errors.ts` plus a message, so a client branches on the
 * code and never on the wording.
 *
 * The part worth reading is `databaseCatalogCode`. Migration 0026 raises
 * `CATALOG_SKU_IMMUTABLE` and `CATALOG_CATEGORY_CYCLE` from triggers, and
 * PostgreSQL's unique indexes raise 23505 for a duplicate SKU code or a
 * re-created variant. Both have to become the same codes the service raises, or
 * the same mistake answers differently depending on which layer noticed — and the
 * layer that notices depends on concurrency, so the client would see one code in
 * testing and the other under load.
 */

const STATUS: Readonly<Partial<Record<ErrorCode, number>>> = {
  CATALOG_NOT_FOUND: 404,
  CATALOG_DUPLICATE: 409,
  CATALOG_SKU_IMMUTABLE: 409,
  CATALOG_PRODUCT_IMMUTABLE: 409,
  CATALOG_CATEGORY_CYCLE: 409,
  CATALOG_IMPORT_REJECTED: 422,
};

export class CatalogError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'CatalogError';
  }
}

export function catalogHttpError(code: ErrorCode, message: string): HttpException {
  const body = { code, message };
  switch (STATUS[code] ?? 400) {
    case 404:
      return new NotFoundException(body);
    case 409:
      return new ConflictException(body);
    case 422:
      // A CSV whose rows are individually wrong is not a malformed request: the
      // body parsed, the file was read, and the answer is a report. 422 is what
      // lets the console show that report instead of a generic "bad request".
      return new HttpException(body, 422);
    default:
      return new BadRequestException(body);
  }
}

/** Codes migration 0026's triggers raise with a `CODE: message` prefix. */
const TRIGGER_CODES: readonly ErrorCode[] = [
  'CATALOG_SKU_IMMUTABLE',
  'CATALOG_PRODUCT_IMMUTABLE',
  'CATALOG_CATEGORY_CYCLE',
  'CATALOG_CATEGORY_INVALID',
];

/**
 * Which unique index a 23505 came from, as the user's problem rather than the
 * index's name.
 *
 * `skus_org_product_variant_idx` is the interesting one: it fires when two
 * requests extend the same product's matrix at once and both plan the same new
 * combination. That is not a caller error — it is check 1 holding — so it answers
 * `CATALOG_DUPLICATE` with a message about the variant rather than a 500.
 */
const CONSTRAINT_MESSAGES: Readonly<Record<string, string>> = {
  skus_org_code_idx: 'A SKU with that code already exists in this brand.',
  skus_org_product_variant_idx: 'That variant already exists for this product.',
  skus_org_barcode_idx: 'Another SKU already carries that barcode.',
  products_org_slug_idx: 'A product with that web address already exists.',
  products_org_sequence_idx: 'That product sequence number is taken.',
  categories_org_code_idx: 'A category with that code already exists.',
  categories_org_parent_slug_idx: 'A sibling category already uses that web address.',
  attributes_org_code_idx: 'An attribute with that code already exists.',
  attribute_values_org_attribute_code_idx: 'That attribute already has a value with that code.',
  product_images_org_product_file_idx: 'That image is already attached to this product.',
};

export function databaseCatalogCode(error: unknown): { code: ErrorCode; message: string } | null {
  for (let current: unknown = error; current instanceof Error; current = current.cause) {
    const prefixed = /^([A-Z_]+): (.*)$/s.exec(current.message);
    if (prefixed !== null) {
      const code = TRIGGER_CODES.find((candidate) => candidate === prefixed[1]);
      if (code !== undefined) return { code, message: prefixed[2] ?? current.message };
    }

    const sqlstate = (current as { code?: unknown }).code;
    if (
      sqlstate === '23514' &&
      (current as { constraint_name?: unknown }).constraint_name ===
        'sku_settings_barcode_sequence_range'
    ) {
      // The brand's internal barcode counter is at its end (D-603): never in practice, and
      // a refusal that says so rather than a 500 if it ever is.
      return {
        code: 'CATALOG_BARCODE_INVALID',
        message: 'This brand has used every internal barcode number; ask an admin to look.',
      };
    }
    if (sqlstate === '23505') {
      const constraint = (current as { constraint_name?: unknown }).constraint_name;
      const known = typeof constraint === 'string' ? CONSTRAINT_MESSAGES[constraint] : undefined;
      return {
        code: 'CATALOG_DUPLICATE',
        // Never the constraint name: an index name in an error body tells a
        // caller the shape of our schema and tells the user nothing.
        message: known ?? 'That value is already taken in this brand.',
      };
    }
  }
  return null;
}

export function toCatalogHttpError(error: unknown): unknown {
  if (error instanceof HttpException) return error;
  if (error instanceof CatalogError) return catalogHttpError(error.code, error.message);
  if (error instanceof SkuCodeError)
    return catalogHttpError('CATALOG_VARIANT_INVALID', error.message);
  if (error instanceof VariantMatrixError) {
    return catalogHttpError('CATALOG_VARIANT_INVALID', error.message);
  }
  if (error instanceof Code128Error)
    return catalogHttpError('CATALOG_VARIANT_INVALID', error.message);
  if (error instanceof Ean13Error)
    return catalogHttpError('CATALOG_BARCODE_INVALID', error.message);
  if (error instanceof CsvError) {
    return catalogHttpError(
      'CATALOG_IMPORT_REJECTED',
      `Line ${String(error.line)}: ${error.message}`,
    );
  }
  if (error instanceof MoneyError) return catalogHttpError('CATALOG_PRICE_INVALID', error.message);
  const fromDatabase = databaseCatalogCode(error);
  if (fromDatabase !== null) return catalogHttpError(fromDatabase.code, fromDatabase.message);
  return error;
}

export async function mapCatalogErrors<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    throw toCatalogHttpError(error);
  }
}
