/**
 * The website's content rules (M33, D-501, D-502, D-504): tags, links, size charts, the
 * category tree and the menu. Pure, so the console's editors and the server's checks are
 * the same rule.
 */

// --- tags -----------------------------------------------------------------------------------

export const TAGS_PER_PRODUCT_MAX = 30;
export const TAG_LENGTH_MAX = 40;
const TAG = /^[\p{L}\p{N}][\p{L}\p{N} &'-]*$/u;

/**
 * A product's tags as stored: trimmed, lower-case, single-spaced, without repeats, at most
 * thirty, in the order first given. Anything that is not a word (punctuation only, too long)
 * is dropped. Idempotent, so normalising stored tags again changes nothing.
 */
export function normaliseTags(input: readonly string[]): string[] {
  const out: string[] = [];
  for (const raw of input) {
    const tag = raw.trim().toLowerCase().replace(/\s+/g, ' ');
    if (tag === '' || tag.length > TAG_LENGTH_MAX || !TAG.test(tag)) continue;
    if (!out.includes(tag)) out.push(tag);
    if (out.length === TAGS_PER_PRODUCT_MAX) break;
  }
  return out;
}

// --- links ----------------------------------------------------------------------------------

/**
 * Whether a link a member of staff typed is safe to put on the website: a path on the site
 * itself (`/shop?category=men`) or an `https://` address.
 *
 * Everything else is refused, and the reasons are concrete: `javascript:` and `data:` run
 * code in a shopper's browser; `//evil.example` is a path to the eye and another site to the
 * browser; `http://` sends a shopper off TLS. The website renders these links into its own
 * pages, so the ERP is the last place a typo can be caught.
 */
export function isSafeSiteLink(href: string): boolean {
  const link = href.trim();
  if (link === '' || link.length > 500 || link !== href) return false;
  // eslint-disable-next-line no-control-regex
  if (/[\s\u0000-\u001f\u007f\\]/.test(link)) return false;
  if (link.startsWith('/')) return !link.startsWith('//');
  if (!link.startsWith('https://')) return false;
  try {
    const url = new URL(link);
    return (
      url.protocol === 'https:' && url.hostname !== '' && url.username === '' && url.password === ''
    );
  } catch {
    return false;
  }
}

// --- size charts ----------------------------------------------------------------------------

export const SIZE_CHART_COLUMNS_MAX = 12;
export const SIZE_CHART_ROWS_MAX = 60;
export const SIZE_CHART_CELL_MAX = 40;

export interface SizeChartShape {
  readonly columns: readonly string[];
  readonly rows: readonly (readonly string[])[];
}

/** What is wrong with a size chart, in plain words; empty when it is fine. */
export function sizeChartProblems(chart: SizeChartShape): string[] {
  const problems: string[] = [];
  if (chart.columns.length === 0 || chart.columns.length > SIZE_CHART_COLUMNS_MAX) {
    problems.push(`A size chart has 1 to ${String(SIZE_CHART_COLUMNS_MAX)} columns.`);
  }
  if (chart.columns.some((column) => column.trim() === '' || column.length > SIZE_CHART_CELL_MAX)) {
    problems.push('Every column needs a heading of at most 40 characters.');
  }
  if (chart.rows.length > SIZE_CHART_ROWS_MAX) {
    problems.push(`A size chart has at most ${String(SIZE_CHART_ROWS_MAX)} rows.`);
  }
  if (chart.rows.some((row) => row.length !== chart.columns.length)) {
    problems.push('Every row has one cell per column.');
  }
  if (chart.rows.some((row) => row.some((cell) => cell.length > SIZE_CHART_CELL_MAX))) {
    problems.push('A cell holds at most 40 characters.');
  }
  return problems;
}

// --- the category tree ----------------------------------------------------------------------

export interface CategoryNode {
  readonly id: string;
  readonly parentId: string | null;
  readonly name: string;
  readonly slug: string;
  readonly position: number;
  /** Switched on in the ERP and shown on the website: both, or the category is hidden. */
  readonly visible: boolean;
}

export type CategoryTree<T extends CategoryNode> = T & {
  readonly children: readonly CategoryTree<T>[];
};

const ORPHANED = 'orphaned:';

function byPlace(a: CategoryNode, b: CategoryNode): number {
  return a.position - b.position || a.name.localeCompare(b.name) || a.id.localeCompare(b.id);
}

/**
 * The visible categories as a tree, siblings by position then name.
 *
 * A hidden category hides everything under it: a shopper who cannot reach "Menswear" must
 * not find "Menswear › Shirts" orphaned at the top level. A category whose parent is missing
 * from the rows is treated the same way, as hidden.
 */
export function buildCategoryTree<T extends CategoryNode>(rows: readonly T[]): CategoryTree<T>[] {
  const children = new Map<string | null, T[]>();
  const known = new Set(rows.map((row) => row.id));
  for (const row of rows) {
    // A row whose parent is not among the rows hangs off a key nothing ever grows from.
    const parent = row.parentId === null ? null : known.has(row.parentId) ? row.parentId : ORPHANED;
    const list = children.get(parent) ?? [];
    list.push(row);
    children.set(parent, list);
  }
  const grow = (parent: string | null, depth: number): CategoryTree<T>[] =>
    depth > 8
      ? []
      : (children.get(parent) ?? [])
          .filter((row) => row.visible)
          .sort(byPlace)
          .map((row) => ({ ...row, children: grow(row.id, depth + 1) }));
  return grow(null, 0);
}

/** A category and every visible category under it, as ids. Empty when it is hidden. */
export function visibleSubtreeIds(rows: readonly CategoryNode[], rootId: string): string[] {
  const found = (
    nodes: readonly CategoryTree<CategoryNode>[],
  ): CategoryTree<CategoryNode> | null => {
    for (const node of nodes) {
      if (node.id === rootId) return node;
      const inner = found(node.children);
      if (inner !== null) return inner;
    }
    return null;
  };
  const root = found(buildCategoryTree(rows));
  if (root === null) return [];
  const ids: string[] = [];
  const walk = (node: CategoryTree<CategoryNode>): void => {
    ids.push(node.id);
    node.children.forEach(walk);
  };
  walk(root);
  return ids;
}

// --- the menu -------------------------------------------------------------------------------

export const NAV_KINDS = ['link', 'category', 'dropdown'] as const;
export type NavKind = (typeof NAV_KINDS)[number];

export interface NavItemRow {
  readonly id: string;
  readonly parentId: string | null;
  readonly kind: NavKind;
  readonly label: string | null;
  readonly href: string | null;
  readonly categoryId: string | null;
  readonly highlighted: boolean;
  readonly isActive: boolean;
  readonly position: number;
}

export interface NavCategoryRef {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
}

export interface NavEntry {
  readonly id: string;
  readonly kind: NavKind;
  readonly label: string;
  readonly href: string | null;
  readonly category: NavCategoryRef | null;
  readonly highlighted: boolean;
  /** A dropdown's own items, in order. */
  readonly children: readonly NavEntry[];
  /** A category item's visible subcategories, two levels deep (the old site's menu). */
  readonly subcategories: readonly NavSubcategory[];
}

export interface NavSubcategory extends NavCategoryRef {
  readonly children: readonly NavSubcategory[];
}

/** The menu's shape rules: what the editor and the server both refuse. */
export function navProblems(items: readonly NavItemRow[]): string[] {
  const problems: string[] = [];
  const byId = new Map(items.map((item) => [item.id, item]));
  for (const item of items) {
    if (item.kind === 'link' && (item.href === null || !isSafeSiteLink(item.href))) {
      problems.push('A link item needs a path on the site or an https:// address.');
    }
    if (item.kind === 'category' && item.categoryId === null) {
      problems.push('A category item needs a category.');
    }
    if ((item.kind === 'link' || item.kind === 'dropdown') && (item.label ?? '').trim() === '') {
      problems.push('A link or dropdown item needs a label.');
    }
    if (item.parentId !== null) {
      const parent = byId.get(item.parentId);
      if (parent === undefined) problems.push('An item sits under an item that does not exist.');
      else if (parent.kind !== 'dropdown') problems.push('Only a dropdown holds other items.');
      else if (parent.parentId !== null) problems.push('The menu is two levels deep at most.');
      if (item.kind === 'dropdown') problems.push('A dropdown cannot sit inside another.');
    }
  }
  return [...new Set(problems)];
}

/**
 * The menu as the website draws it: active items only, in order, category items labelled
 * and expanded from the visible category tree, dropdowns holding their own items.
 *
 * An item pointing at a hidden category is left out, and so is a dropdown left empty — a
 * menu heading that opens onto nothing reads as a broken site.
 */
export function buildNav(
  items: readonly NavItemRow[],
  categories: readonly CategoryNode[],
): NavEntry[] {
  const tree = buildCategoryTree(categories);
  const visible = new Map<string, CategoryTree<CategoryNode>>();
  const index = (nodes: readonly CategoryTree<CategoryNode>[]): void => {
    for (const node of nodes) {
      visible.set(node.id, node);
      index(node.children);
    }
  };
  index(tree);

  const sub = (node: CategoryTree<CategoryNode>, depth: number): NavSubcategory[] =>
    depth >= 2
      ? []
      : node.children.map((child) => ({
          id: child.id,
          name: child.name,
          slug: child.slug,
          children: sub(child, depth + 1),
        }));

  const ordered = (parentId: string | null) =>
    items
      .filter((item) => item.parentId === parentId && item.isActive)
      .sort((a, b) => a.position - b.position || a.id.localeCompare(b.id));

  const entry = (item: NavItemRow, depth: number): NavEntry | null => {
    if (item.kind === 'category') {
      const node = item.categoryId === null ? undefined : visible.get(item.categoryId);
      if (node === undefined) return null;
      const label = (item.label ?? '').trim();
      return {
        id: item.id,
        kind: 'category',
        label: label === '' ? node.name : label,
        href: item.href !== null && isSafeSiteLink(item.href) ? item.href : null,
        category: { id: node.id, name: node.name, slug: node.slug },
        highlighted: item.highlighted,
        children: [],
        subcategories: sub(node, 0),
      };
    }
    if (item.kind === 'link') {
      if (item.href === null || !isSafeSiteLink(item.href)) return null;
      return {
        id: item.id,
        kind: 'link',
        label: (item.label ?? '').trim(),
        href: item.href,
        category: null,
        highlighted: item.highlighted,
        children: [],
        subcategories: [],
      };
    }
    if (depth > 0) return null;
    const children = ordered(item.id)
      .map((child) => entry(child, depth + 1))
      .filter((child): child is NavEntry => child !== null);
    if (children.length === 0) return null;
    return {
      id: item.id,
      kind: 'dropdown',
      label: (item.label ?? '').trim(),
      href: null,
      category: null,
      highlighted: item.highlighted,
      children,
      subcategories: [],
    };
  };

  return ordered(null)
    .map((item) => entry(item, 0))
    .filter((item): item is NavEntry => item !== null);
}
