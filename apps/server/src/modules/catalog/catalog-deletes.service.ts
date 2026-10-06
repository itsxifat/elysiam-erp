import { Injectable } from '@nestjs/common';
import type { EmptyCategoryInput, UsageEntry, UsageKind, UsageReport } from '@elysium/contracts';
import { withOrg, type Tx } from '@elysium/db';
import { skuCodePrefix } from '@elysium/domain';

import type { AuditableRequest } from '../../platform/audit/audit.interceptor.js';
import { AuditService } from '../../platform/audit/audit.service.js';
import type { ActiveContext } from '../../platform/http/context.js';
import {
  blocking,
  describeUses,
  mergeUses,
  type ReferenceUse,
} from '../../platform/references/references.js';
import { CatalogError } from './catalog.errors.js';
import * as del from './catalog-deletes.repository.js';
import type { ArchiveValueInput, ReorderValuesInput } from './catalog-deletes.schemas.js';
import type { CategoryRow } from './catalog.repository.js';
import { CatalogReferences } from './ports/catalog-references.port.js';

/**
 * Deleting and archiving catalog rows (M39a, D-621 to D-626).
 *
 * ## The rule
 *
 * A row nothing uses is really deleted; a row anything uses is archived instead, and the
 * answer says what uses it. "Uses" is asked, not assumed: the catalog counts its own rows
 * (a category's products and subcategories, the variants carrying a size), and every module
 * that points at catalog rows answers for its own tables through `CatalogReferences`
 * (stock, orders, the till, supply, couriers, promotions, the website, marketing).
 *
 * ## The order inside every delete
 *
 * 1. Lock the rows about to go (`for update`, in id order).
 * 2. Count: the catalog's own uses, then every module's.
 * 3. Refuse with `CATALOG_IN_USE` and the counts in words when anything keeps the row.
 * 4. Let each module release what exists only because of the row (old site ids).
 * 5. Delete; the database cascades the dependants 0119 allows (price history, empty stock
 *    rows, a product's images and a SKU's values) and refuses anything else (23503, mapped to
 *    the same `CATALOG_IN_USE`).
 * 6. Write the audit row **with the deleted row's content**, in the same transaction: after
 *    a hard delete nothing else holds it.
 *
 * A reference committing at the same moment as a delete either committed before the lock
 * (and is counted) or waits on it and then fails on its foreign key: nothing dangles.
 *
 * Discount scopes are never rewritten (their terms are frozen, D-541): a category, product
 * or SKU a live discount names stays until the discount is archived.
 */
@Injectable()
export class CatalogDeletesService {
  constructor(
    private readonly references: CatalogReferences,
    private readonly audit: AuditService,
  ) {}

  // --- usage ---------------------------------------------------------------------------------

  async categoryUsage(context: ActiveContext, id: string): Promise<UsageReport> {
    return withOrg(context, async (tx) => {
      const category = await del.categoryImage(tx, context.orgId, id);
      if (category === undefined) throw notFound('category');
      const uses = await this.categoryUses(tx, context.orgId, id);
      return report('category', id, category.name, !category.is_active, uses, {
        emptiable: true,
      });
    });
  }

  async attributeUsage(context: ActiveContext, id: string): Promise<UsageReport> {
    return withOrg(context, async (tx) => {
      const attribute = await del.lockAttribute(tx, context.orgId, id, false);
      if (attribute === undefined) throw notFound('list');
      const variants = await del.variantsUsing(tx, context.orgId, { attributeId: id });
      const uses = mergeUses([
        ...variantUse(variants),
        ...(await this.references.references(tx, context.orgId, 'attribute', [id])),
      ]);
      return {
        ...report('attribute', id, attribute.name, !attribute.is_active, uses),
        activeVariants: variants.active,
      };
    });
  }

  async valueUsage(
    context: ActiveContext,
    attributeId: string,
    valueId: string,
  ): Promise<UsageReport> {
    return withOrg(context, async (tx) => {
      const [value] = await del.lockValues(tx, context.orgId, attributeId, valueId, false);
      if (value === undefined) throw notFound('value');
      const variants = await del.variantsUsing(tx, context.orgId, { valueId });
      const uses = mergeUses([
        ...variantUse(variants),
        ...(await this.references.references(tx, context.orgId, 'attribute_value', [valueId])),
      ]);
      return {
        ...report('attribute_value', valueId, value.label, !value.is_active, uses),
        activeVariants: variants.active,
      };
    });
  }

  async productUsage(context: ActiveContext, id: string): Promise<UsageReport> {
    return withOrg(context, async (tx) => {
      const product = await del.productSummary(tx, context.orgId, id);
      if (product === undefined) throw notFound('product');
      const uses = await this.productUses(tx, context.orgId, id, product.skuIds);
      return report('product', id, product.name, product.status === 'archived', uses);
    });
  }

  async skuUsage(context: ActiveContext, id: string): Promise<UsageReport> {
    return withOrg(context, async (tx) => {
      const sku = await del.skuLabel(tx, context.orgId, id);
      if (sku === undefined) throw notFound('variant');
      const uses = await this.references.references(tx, context.orgId, 'sku', [id]);
      return report('sku', id, sku.label, sku.status === 'archived', uses);
    });
  }

  // --- categories ----------------------------------------------------------------------------

  /** Delete a category nothing uses: no product (any status), subcategory or menu entry. */
  async deleteCategory(context: ActiveContext, request: AuditableRequest, id: string) {
    return withOrg(context, async (tx) => {
      const category = await del.lockCategory(tx, context.orgId, id);
      if (category === undefined) throw notFound('category');
      const uses = await this.categoryUses(tx, context.orgId, id);
      if (uses.length > 0) {
        throw inUse(
          `${category.name} is used by ${describeUses(uses)}.`,
          blocking(uses).length === 0
            ? 'Empty it into another category first, or archive it.'
            : 'Archive it instead.',
        );
      }
      await this.references.release(tx, context.orgId, 'category', [id]);
      if (!(await del.deleteCategory(tx, context.orgId, id))) throw notFound('category');
      await this.audit.record(tx, {
        orgId: context.orgId,
        actorUserId: context.userId,
        operation: 'delete',
        action: 'catalog.category.deleted',
        entityType: 'Category',
        entityId: id,
        before: { ...category },
        after: null,
        requestId: context.requestId,
        request,
      });
      return { id, deleted: true };
    });
  }

  /**
   * Empty a category, then delete it, in one transaction (D-623).
   *
   * Its products go to `targetCategoryId` (or to no category); its subcategories move up to
   * its own parent, a slug that would collide there taking the next free `-2`, `-3`; its menu
   * entries are re-pointed at the target, or removed when there is none (the website module
   * does that, and audits what it removed). A live discount naming the category refuses the
   * whole thing: a discount's scope is its terms, and terms are never rewritten.
   */
  async emptyAndDeleteCategory(
    context: ActiveContext,
    request: AuditableRequest,
    id: string,
    input: EmptyCategoryInput,
  ) {
    return withOrg(context, async (tx) => {
      const targetId = input.targetCategoryId;
      // The parent first, `for share`: the subcategories move up to it, and their foreign keys
      // would otherwise take its KEY SHARE after this category's own lock, the opposite order
      // to the parent's own empty-and-delete, which locks it and then its children.
      const unlocked = await del.categoryImage(tx, context.orgId, id);
      if (unlocked === undefined) throw notFound('category');
      if (unlocked.parent_id !== null) {
        await del.lockCategory(tx, context.orgId, unlocked.parent_id, 'share');
      }
      // The target and this category in id order, so two opposite empties (A into B, B into
      // A) queue instead of deadlocking (ledger audit).
      if (targetId !== null && targetId < id) {
        await del.lockCategory(tx, context.orgId, targetId, 'share');
      }
      const category = await del.lockCategory(tx, context.orgId, id);
      if (category === undefined) throw notFound('category');

      if (targetId !== null) {
        if (await del.isInSubtree(tx, context.orgId, id, targetId)) {
          throw new CatalogError(
            'CATALOG_CATEGORY_INVALID',
            'Choose a category outside the one being deleted for its products.',
          );
        }
        const target = await del.lockCategory(tx, context.orgId, targetId, 'share');
        if (target === undefined) throw notFound('category');
        // Archived, or under an archived one: the products would leave the website unasked.
        await assertCategoryLive(
          tx,
          context.orgId,
          target,
          'Restore it, or choose another category for the products.',
        );
      }

      const uses = await this.categoryUses(tx, context.orgId, id);
      const keeping = blocking(uses);
      if (keeping.length > 0) {
        throw inUse(
          `${category.name} is used by ${describeUses(keeping)}, which cannot be moved.`,
          keepingHint(keeping),
        );
      }

      const movedProducts = await del.moveCategoryProducts(tx, context.orgId, id, targetId);
      const movedChildren = await this.moveChildrenUp(tx, context.orgId, category);
      const menuEntries = await this.references.moveCategory(tx, context.orgId, id, targetId, {
        userId: context.userId,
        requestId: context.requestId,
      });

      // One row per product moved, so each product's own history shows the change (D-622).
      for (const productId of movedProducts) {
        await this.audit.record(tx, {
          orgId: context.orgId,
          actorUserId: context.userId,
          operation: 'update',
          action: 'catalog.product.category_moved',
          entityType: 'Product',
          entityId: productId,
          before: { categoryId: id },
          after: { categoryId: targetId, because: `${category.name} was emptied and deleted` },
          requestId: context.requestId,
        });
      }

      await this.references.release(tx, context.orgId, 'category', [id]);
      if (!(await del.deleteCategory(tx, context.orgId, id))) throw notFound('category');
      await this.audit.record(tx, {
        orgId: context.orgId,
        actorUserId: context.userId,
        operation: 'delete',
        action: 'catalog.category.emptied_and_deleted',
        entityType: 'Category',
        entityId: id,
        before: { ...category },
        after: {
          targetCategoryId: targetId,
          movedProductIds: movedProducts,
          movedSubcategories: movedChildren,
          menuEntries,
        },
        requestId: context.requestId,
        request,
      });
      return {
        id,
        deleted: true,
        movedProducts: movedProducts.length,
        movedSubcategories: movedChildren.length,
        menuEntries,
      };
    });
  }

  /** Archive (hide from new products, take its products off the website) or restore. */
  async setCategoryArchived(
    context: ActiveContext,
    request: AuditableRequest,
    id: string,
    archived: boolean,
  ) {
    return withOrg(context, async (tx) => {
      const category = await del.lockCategory(tx, context.orgId, id);
      if (category === undefined) throw notFound('category');
      if (category.is_active === !archived) return { id, archived };
      const products = await del.productsInCategory(tx, context.orgId, id);
      await del.setCategoryActive(tx, context.orgId, id, !archived);
      await this.audit.record(tx, {
        orgId: context.orgId,
        actorUserId: context.userId,
        operation: 'update',
        action: archived ? 'catalog.category.archived' : 'catalog.category.restored',
        entityType: 'Category',
        entityId: id,
        before: { isActive: category.is_active },
        after: { isActive: !archived, productsInIt: products.count },
        requestId: context.requestId,
        request,
      });
      return { id, archived };
    });
  }

  // --- lists and values ----------------------------------------------------------------------

  /** Delete a list nobody's variants use, with its values. */
  async deleteAttribute(context: ActiveContext, request: AuditableRequest, id: string) {
    return withOrg(context, async (tx) => {
      const attribute = await del.lockAttribute(tx, context.orgId, id);
      if (attribute === undefined) throw notFound('list');
      const values = await del.lockValues(tx, context.orgId, id);
      const variants = await del.variantsUsing(tx, context.orgId, { attributeId: id });
      const uses = mergeUses([
        ...variantUse(variants),
        ...(await this.references.references(tx, context.orgId, 'attribute', [id])),
      ]);
      if (uses.length > 0) {
        throw inUse(
          `${attribute.name} is on ${describeUses(uses)}.`,
          'Archive it to hide it from new products; existing variants keep it.',
        );
      }
      await this.references.release(tx, context.orgId, 'attribute', [id]);
      if (!(await del.deleteAttributeWithValues(tx, context.orgId, id))) throw notFound('list');
      await this.audit.record(tx, {
        orgId: context.orgId,
        actorUserId: context.userId,
        operation: 'delete',
        action: 'catalog.attribute.deleted',
        entityType: 'Attribute',
        entityId: id,
        // Locked in id order (deadlocks), recorded in the list's own order.
        before: {
          ...attribute,
          values: [...values]
            .sort((a, b) => a.position - b.position || a.code.localeCompare(b.code))
            .map((value) => ({ ...value })),
        },
        after: null,
        requestId: context.requestId,
        request,
      });
      return { id, deleted: true };
    });
  }

  async setAttributeArchived(
    context: ActiveContext,
    request: AuditableRequest,
    id: string,
    archived: boolean,
  ) {
    return withOrg(context, async (tx) => {
      const attribute = await del.lockAttribute(tx, context.orgId, id);
      if (attribute === undefined) throw notFound('list');
      if (attribute.is_active === !archived) return { id, archived };
      await del.setAttributeActive(tx, context.orgId, id, !archived);
      await this.audit.record(tx, {
        orgId: context.orgId,
        actorUserId: context.userId,
        operation: 'update',
        action: archived ? 'catalog.attribute.archived' : 'catalog.attribute.restored',
        entityType: 'Attribute',
        entityId: id,
        before: { isActive: attribute.is_active },
        after: { isActive: !archived },
        requestId: context.requestId,
        request,
      });
      return { id, archived };
    });
  }

  /** Delete a value no variant carries (a typo, never used). */
  async deleteValue(
    context: ActiveContext,
    request: AuditableRequest,
    attributeId: string,
    valueId: string,
  ) {
    return withOrg(context, async (tx) => {
      const [value] = await del.lockValues(tx, context.orgId, attributeId, valueId);
      if (value === undefined) throw notFound('value');
      const variants = await del.variantsUsing(tx, context.orgId, { valueId });
      const uses = mergeUses([
        ...variantUse(variants),
        ...(await this.references.references(tx, context.orgId, 'attribute_value', [valueId])),
      ]);
      if (uses.length > 0) {
        throw inUse(
          `${value.label} is on ${describeUses(uses)}.`,
          'Archive it to hide it from new products; existing variants keep it.',
        );
      }
      await this.references.release(tx, context.orgId, 'attribute_value', [valueId]);
      if (!(await del.deleteValue(tx, context.orgId, attributeId, valueId))) {
        throw notFound('value');
      }
      await this.audit.record(tx, {
        orgId: context.orgId,
        actorUserId: context.userId,
        operation: 'delete',
        action: 'catalog.attribute_value.deleted',
        entityType: 'AttributeValue',
        entityId: valueId,
        before: { ...value },
        after: null,
        requestId: context.requestId,
        request,
      });
      return { id: valueId, deleted: true };
    });
  }

  /**
   * Archive a value, and with `archiveVariants` every active variant carrying it, in one
   * call (D-624): "we no longer make XXL" in one step. Each archived variant gets its own
   * audit row; its stock stays where it is.
   */
  async archiveValue(
    context: ActiveContext,
    request: AuditableRequest,
    attributeId: string,
    valueId: string,
    input: ArchiveValueInput,
  ) {
    return withOrg(context, async (tx) => {
      const [value] = await del.lockValues(tx, context.orgId, attributeId, valueId);
      if (value === undefined) throw notFound('value');
      if (value.is_active) await del.setValueActive(tx, context.orgId, attributeId, valueId, false);
      const archived = input.archiveVariants
        ? await del.archiveSkusWithValue(tx, context.orgId, valueId)
        : [];
      await this.audit.record(tx, {
        orgId: context.orgId,
        actorUserId: context.userId,
        operation: 'update',
        action: 'catalog.attribute_value.archived',
        entityType: 'AttributeValue',
        entityId: valueId,
        before: { isActive: value.is_active },
        after: { isActive: false, archivedVariants: archived.map((sku) => sku.code) },
        requestId: context.requestId,
        request,
      });
      for (const sku of archived) {
        await this.audit.record(tx, {
          orgId: context.orgId,
          actorUserId: context.userId,
          operation: 'update',
          action: 'catalog.sku.archived',
          entityType: 'Sku',
          entityId: sku.id,
          before: { status: 'active' },
          after: { status: 'archived', because: `${value.label} was archived` },
          requestId: context.requestId,
        });
      }
      return { id: valueId, archived: true, archivedVariants: archived.length };
    });
  }

  async restoreValue(
    context: ActiveContext,
    request: AuditableRequest,
    attributeId: string,
    valueId: string,
  ) {
    return withOrg(context, async (tx) => {
      const [value] = await del.lockValues(tx, context.orgId, attributeId, valueId);
      if (value === undefined) throw notFound('value');
      if (!value.is_active) {
        await del.setValueActive(tx, context.orgId, attributeId, valueId, true);
        await this.audit.record(tx, {
          orgId: context.orgId,
          actorUserId: context.userId,
          operation: 'update',
          action: 'catalog.attribute_value.restored',
          entityType: 'AttributeValue',
          entityId: valueId,
          before: { isActive: false },
          after: { isActive: true },
          requestId: context.requestId,
          request,
        });
      }
      return { id: valueId, archived: false };
    });
  }

  /** A list's values in a new order (S, M, L, XL on every screen and sticker). */
  async reorderValues(
    context: ActiveContext,
    request: AuditableRequest,
    attributeId: string,
    input: ReorderValuesInput,
  ) {
    return withOrg(context, async (tx) => {
      const attribute = await del.lockAttribute(tx, context.orgId, attributeId);
      if (attribute === undefined) throw notFound('list');
      const values = await del.lockValues(tx, context.orgId, attributeId);
      const known = new Set(values.map((value) => value.id));
      if (
        input.valueIds.length !== values.length ||
        input.valueIds.some((valueId) => !known.has(valueId))
      ) {
        // A partial list would leave the rest at old positions, in an order nobody asked for.
        throw new CatalogError(
          'CATALOG_VARIANT_INVALID',
          `Send every value of ${attribute.name} exactly once, in the order they should appear.`,
        );
      }
      await del.reorderValues(tx, context.orgId, attributeId, input.valueIds);
      await this.audit.record(tx, {
        orgId: context.orgId,
        actorUserId: context.userId,
        operation: 'update',
        action: 'catalog.attribute_values.reordered',
        entityType: 'Attribute',
        entityId: attributeId,
        before: {
          order: [...values]
            .sort((a, b) => a.position - b.position || a.code.localeCompare(b.code))
            .map((value) => value.code),
        },
        after: {
          order: input.valueIds.map(
            (valueId) => values.find((value) => value.id === valueId)?.code ?? valueId,
          ),
        },
        requestId: context.requestId,
        request,
      });
      return { id: attributeId, ordered: input.valueIds.length };
    });
  }

  // --- products and SKUs ---------------------------------------------------------------------

  /**
   * Delete a product nothing references (D-625): a mistake or a duplicate draft.
   *
   * Every SKU is asked about as well as the product; one stock movement, order line, till
   * line, supply line, courier return line, flash sale item, lead or live discount anywhere
   * keeps the whole product (archive it instead). Its images, SKU values, price history and
   * empty stock rows go with it; the files themselves stay in storage.
   */
  async deleteProduct(context: ActiveContext, request: AuditableRequest, id: string) {
    return withOrg(context, async (tx) => {
      const product = await del.lockProduct(tx, context.orgId, id);
      if (product === undefined) throw notFound('product');
      const skus = await del.lockSkus(tx, context.orgId, { productId: id });
      const skuIds = skus.map((sku) => sku.id);
      const uses = await this.productUses(tx, context.orgId, id, skuIds);
      if (uses.length > 0) {
        throw inUse(
          `${product.name} is used by ${describeUses(uses)}.`,
          'Archive it instead: it leaves the desk, the till and the website, and its history stays.',
        );
      }
      const images = await del.imageFileIds(tx, context.orgId, id);
      await this.references.release(tx, context.orgId, 'sku', skuIds);
      await this.references.release(tx, context.orgId, 'product', [id]);
      await del.deleteSkus(tx, context.orgId, skuIds);
      if (!(await del.deleteProduct(tx, context.orgId, id))) throw notFound('product');
      await this.audit.record(tx, {
        orgId: context.orgId,
        actorUserId: context.userId,
        operation: 'delete',
        action: 'catalog.product.deleted',
        entityType: 'Product',
        entityId: id,
        before: {
          ...product,
          skus: skus.map((sku) => ({ ...sku })),
          imageFileIds: images,
        },
        after: null,
        requestId: context.requestId,
        request,
      });
      return { id, deleted: true, deletedVariants: skus.length };
    });
  }

  /** Delete one variant nothing references (one added by mistake). */
  async deleteSku(context: ActiveContext, request: AuditableRequest, id: string) {
    return withOrg(context, async (tx) => {
      const owner = await del.skuLabel(tx, context.orgId, id);
      if (owner === undefined) throw notFound('variant');
      // The product first, then the SKU: the same order a product delete takes them in.
      if ((await del.lockProduct(tx, context.orgId, owner.productId)) === undefined) {
        throw notFound('variant');
      }
      const [sku] = await del.lockSkus(tx, context.orgId, { skuId: id });
      if (sku === undefined) throw notFound('variant');
      const uses = await this.references.references(tx, context.orgId, 'sku', [id]);
      if (uses.length > 0) {
        throw inUse(
          `${sku.code} is used by ${describeUses(uses)}.`,
          'Archive it instead: its stock and history stay, and it cannot be sold.',
        );
      }
      await this.references.release(tx, context.orgId, 'sku', [id]);
      if ((await del.deleteSkus(tx, context.orgId, [id])) !== 1) throw notFound('variant');
      await this.audit.record(tx, {
        orgId: context.orgId,
        actorUserId: context.userId,
        operation: 'delete',
        action: 'catalog.sku.deleted',
        entityType: 'Sku',
        entityId: id,
        before: { ...sku, productName: owner.productName },
        after: null,
        requestId: context.requestId,
        request,
      });
      return { id, deleted: true };
    });
  }

  // --- internals -----------------------------------------------------------------------------

  /** The catalog's own uses of a category (movable) plus every module's. */
  private async categoryUses(tx: Tx, orgId: string, id: string): Promise<UsageEntry[]> {
    const products = await del.productsInCategory(tx, orgId, id);
    const children = await del.childCategories(tx, orgId, id);
    return mergeUses([
      { reason: 'products', count: products.count, examples: products.examples, movable: true },
      {
        reason: 'subcategories',
        count: children.length,
        examples: children.slice(0, 5).map((child) => ({ id: child.id, label: child.name })),
        movable: true,
      },
      ...(await this.references.references(tx, orgId, 'category', [id])),
    ]);
  }

  private async productUses(
    tx: Tx,
    orgId: string,
    id: string,
    skuIds: readonly string[],
  ): Promise<UsageEntry[]> {
    return mergeUses([
      ...(await this.references.references(tx, orgId, 'product', [id])),
      ...(await this.references.references(tx, orgId, 'sku', skuIds)),
    ]);
  }

  /**
   * Move a category's children up to its parent. A slug already taken there gets the next
   * free `-2`, `-3`; the subtree's paths follow through 0026's trigger.
   */
  private async moveChildrenUp(
    tx: Tx,
    orgId: string,
    category: del.CategoryImage,
  ): Promise<{ id: string; slug: string }[]> {
    const children = await del.childCategories(tx, orgId, category.id, true);
    if (children.length === 0) return [];
    const taken = await del.siblingSlugs(
      tx,
      orgId,
      category.parent_id,
      children.map((child) => child.id).concat(category.id),
    );
    const moved: { id: string; slug: string }[] = [];
    for (const child of children) {
      const slug = nextFreeSlug(child.slug, taken);
      taken.add(slug);
      await del.reparentCategory(tx, orgId, child.id, category.parent_id, slug);
      moved.push({ id: child.id, slug });
    }
    return moved;
  }
}

// --- helpers CatalogService uses on its create path ------------------------------------------

/**
 * Refuse a category that is archived, or under an archived one, for a new or moved product:
 * the website would not show the product (D-623).
 */
export async function assertCategoryLive(
  tx: Tx,
  orgId: string,
  category: Pick<CategoryRow, 'id' | 'name'> | undefined,
  forWhat = 'Restore it in Catalog setup, or choose another category.',
): Promise<void> {
  if (category === undefined) return;
  const archived = await del.archivedAtOrAbove(tx, orgId, category.id);
  if (archived !== undefined) {
    throw new CatalogError(
      'CATALOG_CATEGORY_INVALID',
      archived.id === category.id
        ? `${category.name} is archived. ${forWhat}`
        : `${category.name} is under ${archived.name}, which is archived. ${forWhat}`,
    );
  }
}

/** Refuse a new variant that would carry an archived size, colour or list (D-624). */
export async function assertValuesLive(
  tx: Tx,
  orgId: string,
  valueIds: readonly string[],
): Promise<void> {
  const archived = await del.archivedAmong(tx, orgId, [...new Set(valueIds)]);
  if (archived.length > 0) {
    const named = archived.map((value) => `${value.label} (${value.list})`).join(', ');
    throw new CatalogError(
      'CATALOG_VARIANT_INVALID',
      `${named} ${archived.length === 1 ? 'is' : 'are'} archived. Restore it in Catalog setup to make new variants with it.`,
    );
  }
}

/**
 * The slug a new product takes: the one asked for when it is free, else the same with the
 * product's own number appended (`mens-hawaiian-shirt-0042`, the number in its SKU codes),
 * else the next free `-2`, `-3` (D-626, D-653). Products may share a name: a brand sells the
 * same cut in many designs, so the name is not an identifier; the slug and the SKU are.
 */
export async function freeProductSlug(
  tx: Tx,
  orgId: string,
  slug: string,
  sequence: number,
): Promise<string> {
  const holder = await del.slugHolder(tx, orgId, slug);
  if (holder === undefined) return slug;
  const taken = await del.slugsLike(tx, orgId, slug);
  const numbered = withSuffix(slug, `-${String(sequence).padStart(4, '0')}`);
  return taken.has(numbered) ? nextFreeSlug(numbered, taken) : numbered;
}

function withSuffix(slug: string, suffix: string): string {
  return `${slug.slice(0, 120 - suffix.length).replace(/-+$/, '')}${suffix}`;
}

/** The prefix a product's existing SKU codes carry, read back (D-623). */
export async function existingPrefix(
  tx: Tx,
  orgId: string,
  productId: string,
  sequence: number,
): Promise<ReturnType<typeof skuCodePrefix>> {
  const code = await del.productCodePrefix(tx, orgId, productId);
  return code === undefined ? undefined : skuCodePrefix(code, sequence);
}

/** `slug`, else `slug-2`, `slug-3`, … the first not in `taken`, within 120 characters. */
export function nextFreeSlug(slug: string, taken: ReadonlySet<string>): string {
  if (!taken.has(slug)) return slug;
  for (let n = 2; ; n += 1) {
    const suffix = `-${String(n)}`;
    const candidate = `${slug.slice(0, 120 - suffix.length).replace(/-+$/, '')}${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
}

function variantUse(variants: {
  readonly count: number;
  readonly examples: readonly del.Named[];
}): ReferenceUse[] {
  return [
    {
      reason: 'variants',
      count: variants.count,
      examples: variants.examples.map((example) => ({ id: example.id, label: example.label })),
    },
  ];
}

function report(
  kind: UsageKind,
  id: string,
  label: string,
  archived: boolean,
  uses: UsageEntry[],
  options: { readonly emptiable?: boolean } = {},
): UsageReport {
  return {
    kind,
    id,
    label,
    archived,
    canDelete: uses.length === 0,
    canEmptyAndDelete: options.emptiable === true && uses.length > 0 && blocking(uses).length === 0,
    canArchive: !archived,
    uses,
  };
}

/**
 * What to do about the uses "Empty and delete" cannot move: a live discount is archived first
 * (its scope is its terms, D-541); a campaign link is edited or deleted first (a shared link
 * is never re-pointed, joined at the M35b merge). Archiving the category is always open.
 */
function keepingHint(keeping: readonly { readonly reason: string }[]): string {
  const steps: string[] = [];
  if (keeping.some((use) => use.reason === 'discounts')) steps.push('archive the discount');
  if (keeping.some((use) => use.reason === 'campaign_links')) {
    steps.push('point the campaign link elsewhere or delete it');
  }
  const first = steps.length === 0 ? '' : `${steps.join(' and ')} first, or `;
  const sentence = `${first}archive the category instead.`;
  return sentence.charAt(0).toUpperCase() + sentence.slice(1);
}

function inUse(what: string, instead: string): CatalogError {
  return new CatalogError('CATALOG_IN_USE', `${what} ${instead}`);
}

function notFound(what: string): CatalogError {
  return new CatalogError('CATALOG_NOT_FOUND', `No such ${what} in this brand's catalog.`);
}
