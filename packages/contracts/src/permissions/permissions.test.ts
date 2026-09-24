import { AbilityBuilder, createMongoAbility, subject as tag } from '@casl/ability';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { MEMBERSHIP_ROLES, type MembershipRole } from '../iam.js';
import { canReadCost, defineAbilityFor, effectiveScope } from './ability.js';
import { COST_READING_ROLES, MATRIX } from './matrix.js';
import { assertNoCostFields, findCostFields, serializeFor } from './serialize.js';
import {
  ACTIONS,
  COST_FIELDS,
  RESELLER_VISIBLE_FIELDS,
  SUBJECTS,
  type Action,
  type Subject,
} from './subjects.js';

/**
 * The permission matrix (architecture §6, invariant 5).
 *
 * Everything here is adversarial in the same way M01's isolation tests were:
 * the assertions that matter are negatives — "this role cannot see cost" —
 * and a negative passes just as happily when the code is broken, the payload
 * is empty, or the field was never there. So each one is paired with a
 * positive control that would fail if the mechanism stopped working at all.
 */

const CONTEXT = { userId: 'usr_1', branchIds: [] as string[], isSuperAdmin: false };

function abilityFor(roles: readonly MembershipRole[], isSuperAdmin = false) {
  return defineAbilityFor({ ...CONTEXT, roles, isSuperAdmin });
}

describe('the matrix is well formed', () => {
  it('names only actions and subjects that exist', () => {
    // A typo'd action reads as "this role cannot do that" and denies silently;
    // a typo'd subject matches nothing and a guard checking it lets everything
    // through. Both are invisible at runtime, so they are caught here.
    for (const [role, rules] of Object.entries(MATRIX)) {
      for (const rule of rules) {
        const actions = Array.isArray(rule.action) ? rule.action : [rule.action];
        for (const action of actions) {
          expect(ACTIONS, `${role} has unknown action ${action}`).toContain(action);
        }
        expect(SUBJECTS, `${role} has unknown subject ${rule.subject}`).toContain(rule.subject);
      }
    }
  });

  it('covers every role, so a new role cannot be silently unlisted', () => {
    for (const role of MEMBERSHIP_ROLES) {
      expect(MATRIX, `no matrix entry for ${role}`).toHaveProperty(role);
    }
  });

  it('never grants `all` scope to an ordinary role', () => {
    // Cross-org reach is §5 exception 3 and belongs to super_admin alone. A
    // rule with scope `all` in this table would hand it to a tenant role.
    for (const [role, rules] of Object.entries(MATRIX)) {
      for (const rule of rules) {
        expect(rule.scope, `${role} has cross-org scope on ${rule.subject}`).not.toBe('all');
      }
    }
  });
});

describe('check 1: every role × capability, as the matrix declares it', () => {
  // The generated suite the milestone asks for: one assertion per cell, built
  // from the matrix rather than written out, so the test cannot drift from it.
  interface Cell {
    readonly role: MembershipRole;
    readonly subject: Subject;
    readonly action: Action;
  }

  const cells: Cell[] = MEMBERSHIP_ROLES.flatMap((role) =>
    SUBJECTS.flatMap((subj) => ACTIONS.map((action) => ({ role, subject: subj, action }))),
  );

  it('asserts allowed or forbidden for all of them', () => {
    expect(cells.length).toBeGreaterThan(1_000);

    const wrong: string[] = [];
    for (const cell of cells) {
      const ability = abilityFor([cell.role]);
      const actual = ability.can(cell.action, cell.subject);
      // Scoped rules carry conditions, so an untagged subject answers false
      // even when the rule exists. Compare against the scope instead.
      const scope = effectiveScope([cell.role], cell.action, cell.subject);
      const shouldBeUnconditional = scope === 'org';

      if (shouldBeUnconditional && !actual) {
        wrong.push(`${cell.role} should be able to ${cell.action} ${cell.subject}`);
      }
      if (scope === null && actual) {
        wrong.push(`${cell.role} should NOT be able to ${cell.action} ${cell.subject}`);
      }
    }

    expect(wrong, wrong.slice(0, 10).join('\n')).toEqual([]);
  });

  it('is not vacuous: the roles differ from each other', () => {
    // If every cell answered the same way the suite above would pass and prove
    // nothing. These are the distinctions §6 actually makes.
    expect(abilityFor(['accounts']).can('read', 'Cost')).toBe(true);
    expect(abilityFor(['sales']).can('read', 'Cost')).toBe(false);
    expect(abilityFor(['org_admin']).can('delete', 'Order')).toBe(true);
    expect(abilityFor(['warehouse']).can('delete', 'Order')).toBe(false);
    expect(abilityFor(['hr']).can('read', 'Employee')).toBe(true);
    expect(abilityFor(['reseller']).can('read', 'Employee')).toBe(false);
    expect(abilityFor(['investor']).can('read', 'LedgerReport')).toBe(false);
  });

  it('gives a super admin everything, including subjects added later', () => {
    const root = abilityFor([], true);
    for (const subj of SUBJECTS) {
      for (const action of ACTIONS) {
        expect(root.can(action, subj), `super_admin denied ${action} ${subj}`).toBe(true);
      }
    }
  });

  it('gives a user with no roles nothing at all', () => {
    const nobody = abilityFor([] as MembershipRole[]);
    for (const subj of SUBJECTS) {
      for (const action of ACTIONS) {
        expect(nobody.can(action, subj), `a roleless user could ${action} ${subj}`).toBe(false);
      }
    }
  });
});

describe('scope is enforced, not merely recorded', () => {
  it('limits `own` to rows the user created or was assigned', () => {
    const ability = abilityFor(['sales']);

    expect(ability.can('read', tag('Order', { createdBy: 'usr_1' }))).toBe(true);
    expect(ability.can('read', tag('Order', { assignedTo: 'usr_1' }))).toBe(true);
    expect(ability.can('read', tag('Order', { createdBy: 'usr_2' }))).toBe(false);
  });

  it('does not express `own` as a $or, because CASL silently denies those', () => {
    // Pinning a dependency behaviour, not our code. CASL's default matcher has
    // no top-level $or and does not throw on one — it evaluates to false. A
    // rule written that way denies every row it was meant to allow, and the
    // obvious fix (drop the condition) turns an `own` rule into an `org` one.
    const { can, build } = new AbilityBuilder(createMongoAbility);
    can('read', 'Order', { $or: [{ createdBy: 'usr_1' }, { assignedTo: 'usr_1' }] });
    const naive = build();

    expect(naive.can('read', tag('Order', { createdBy: 'usr_1' }))).toBe(false);
    // ...whereas ours, built as separate rules, allows it.
    expect(abilityFor(['sales']).can('read', tag('Order', { createdBy: 'usr_1' }))).toBe(true);
  });

  it('limits `branch` to the branches in scope', () => {
    const ability = defineAbilityFor({
      ...CONTEXT,
      roles: ['branch_manager'],
      branchIds: ['branch-a'],
    });

    expect(ability.can('read', tag('Stock', { branchId: 'branch-a' }))).toBe(true);
    expect(ability.can('read', tag('Stock', { branchId: 'branch-b' }))).toBe(false);
  });

  it('treats an empty branch scope as the whole org, not as no branches', () => {
    // §6. The opposite reading — `branch_id in ()` — hides every row from a
    // branch manager who has not been assigned one, which looks like a
    // permissions bug and gets "fixed" by widening the rule.
    const ability = defineAbilityFor({ ...CONTEXT, roles: ['branch_manager'], branchIds: [] });

    expect(ability.can('read', tag('Stock', { branchId: 'branch-a' }))).toBe(true);
    expect(ability.can('read', tag('Stock', { branchId: 'branch-z' }))).toBe(true);
  });

  it('unions the scopes of several roles rather than taking the first', () => {
    expect(effectiveScope(['sales'], 'read', 'Order')).toBe('own');
    expect(effectiveScope(['sales', 'branch_manager'], 'read', 'Order')).toBe('branch');
    expect(effectiveScope(['sales', 'org_admin'], 'read', 'Order')).toBe('org');
  });
});

describe('check 2: cost fields reach accounts and nobody else', () => {
  const row = {
    id: 'item-1',
    sku: 'SKU-1',
    name: 'Kurti',
    unitCostPoisha: 120_000n,
    sellPricePoisha: 250_000n,
    availableQty: 4,
  };

  it.each(COST_READING_ROLES)('gives %s the cost', (role) => {
    const out = serializeFor({ roles: [role], isSuperAdmin: false }, 'CostedItem', row);
    expect(out).toHaveProperty('unitCostPoisha');
  });

  it.each(['sales', 'marketing', 'warehouse', 'reseller'] as const)('hides it from %s', (role) => {
    const out = serializeFor({ roles: [role], isSuperAdmin: false }, 'CostedItem', row);

    expect(() => {
      assertNoCostFields(out);
    }).not.toThrow();
    expect(out).not.toHaveProperty('unitCostPoisha');
  });

  it('still returns the fields those roles legitimately need', () => {
    // The positive control. "No cost fields" also passes on an empty object.
    const out = serializeFor({ roles: ['sales'], isSuperAdmin: false }, 'CostedItem', row);
    expect(out).toMatchObject({ sku: 'SKU-1', sellPricePoisha: 250_000n });
  });

  it('strips cost nested at any depth', () => {
    const nested = {
      order: {
        id: 'o1',
        lines: [
          { sku: 'a', unitCostPoisha: 1n },
          { sku: 'b', wacPoisha: 2n },
        ],
      },
    };

    const out = serializeFor({ roles: ['sales'], isSuperAdmin: false }, 'Order', nested);
    expect(() => {
      assertNoCostFields(out);
    }).not.toThrow();
    expect(JSON.stringify(out)).not.toContain('unitCost');
  });

  it('does not mutate the row it was given', () => {
    // The caller often still needs the cost — to post a journal from the same
    // row it just serialized a response from.
    const original = { ...row };
    serializeFor({ roles: ['sales'], isSuperAdmin: false }, 'CostedItem', row);
    expect(row).toEqual(original);
  });

  it('hides cost under snake_case too, since raw SQL returns those names', () => {
    const raw = { sku: 'SKU-1', unit_cost_poisha: 120_000n, wac_poisha: 99n };
    const out = serializeFor({ roles: ['sales'], isSuperAdmin: false }, 'CostedItem', raw);

    expect(out).not.toHaveProperty('unit_cost_poisha');
    expect(out).not.toHaveProperty('wac_poisha');
  });
});

describe('a reseller sees an allow-list, not a deny-list', () => {
  it('drops a field nobody has thought about yet', () => {
    // The asymmetry that matters: cost is a known set of columns to hide, but
    // what a partner may see is much smaller than what exists, so a column
    // added next year must default to hidden rather than to visible.
    const row = {
      id: 'i1',
      sku: 'SKU-1',
      name: 'Kurti',
      availableQty: 3,
      internalMarginNote: 'never show this',
      supplierName: 'nor this',
    };

    const out = serializeFor({ roles: ['reseller'], isSuperAdmin: false }, 'CostedItem', row);

    expect(out).toMatchObject({ sku: 'SKU-1', name: 'Kurti', availableQty: 3 });
    expect(out).not.toHaveProperty('internalMarginNote');
    expect(out).not.toHaveProperty('supplierName');
  });

  it('keeps the envelope a response is wrapped in', () => {
    // The bug the interceptor found: a naive allow-list deletes `items`,
    // because `items` is not a field of the entity — and the reseller gets an
    // empty object rather than a filtered catalog.
    const response = { items: [{ sku: 'A', name: 'Kurti', unitCostPoisha: 1n, note: 'internal' }] };
    const out = serializeFor({ roles: ['reseller'], isSuperAdmin: false }, 'CostedItem', response);

    expect(out.items).toHaveLength(1);
    expect(out.items[0]).toMatchObject({ sku: 'A', name: 'Kurti' });
    expect(out.items[0]).not.toHaveProperty('unitCostPoisha');
    expect(out.items[0]).not.toHaveProperty('note');
  });

  it('keeps a container name but never its disallowed contents', () => {
    const out = serializeFor({ roles: ['reseller'], isSuperAdmin: false }, 'CostedItem', {
      // `name` would be kept — it is on the allow-list. These are not.
      supplierDetails: { landedCost: 1, supplierPhone: '01712345689' },
    });

    expect(out.supplierDetails).toEqual({});
  });

  it('drops an array of scalars under a key nobody allowed', () => {
    // An audit reproduced this: `prune` applied its predicate to object keys
    // only, so every scalar inside an array survived. Arrays are exactly the
    // shape a catalog has — images, tags, attribute lists, cost tiers.
    const out = serializeFor({ roles: ['reseller'], isSuperAdmin: false }, 'Catalog', {
      wholesaleCostTiers: ['120000', '115000'],
      supplierPhones: ['01712345689'],
      sku: 'A',
    });

    expect(out.wholesaleCostTiers).toEqual([]);
    expect(out.supplierPhones).toEqual([]);
    expect(out.sku, 'the positive control').toBe('A');
  });

  it('keeps the whole subtree of a field the allow-list names', () => {
    // The other direction the same bug broke: `attributes` is on the list and
    // §6 says a reseller may see it, but keeping the container name kept only
    // the name and emptied the contents.
    const out = serializeFor({ roles: ['reseller'], isSuperAdmin: false }, 'Catalog', {
      attributes: { colour: 'red', size: 'M' },
      images: ['a.jpg', 'b.jpg'],
    });

    expect(out.attributes).toEqual({ colour: 'red', size: 'M' });
    expect(out.images).toEqual(['a.jpg', 'b.jpg']);
  });

  it('is not fooled by a Buffer or a Map on the way out', () => {
    // `typeof x === 'object'` is true of both, and walking a Buffer with
    // Object.entries turns a PDF into {"0":80,"1":68}. M22 returns Gotenberg
    // PDFs on this path.
    const pdf = Buffer.from('PDF');
    expect(serializeFor({ roles: ['sales'], isSuperAdmin: false }, 'Order', pdf)).toBe(pdf);

    const map = new Map([['a', 1]]);
    expect(serializeFor({ roles: ['sales'], isSuperAdmin: false }, 'Order', map)).toBe(map);
  });

  it('keeps every field the allow-list names', () => {
    const full = Object.fromEntries(RESELLER_VISIBLE_FIELDS.map((field) => [field, 'x']));
    const out = serializeFor({ roles: ['reseller'], isSuperAdmin: false }, 'Catalog', full);
    expect(Object.keys(out as object).sort()).toEqual([...RESELLER_VISIBLE_FIELDS].sort());
  });
});

describe('serializeFor, over arbitrary payloads', () => {
  /** Any JSON-ish structure, with cost field names sprinkled through it. */
  const payload = fc.letrec((tie) => ({
    node: fc.oneof(
      { depthSize: 'small' },
      fc.constant(null),
      fc.integer(),
      fc.string(),
      fc.array(tie('node'), { maxLength: 4 }),
      fc.dictionary(
        fc.oneof(fc.constantFrom(...COST_FIELDS), fc.string({ minLength: 1 })),
        tie('node'),
        { maxKeys: 5 },
      ),
    ),
  })).node;

  it('leaves no cost field anywhere, for any role without read:cost', () => {
    fc.assert(
      fc.property(payload, (data) => {
        const out = serializeFor({ roles: ['sales'], isSuperAdmin: false }, 'Order', data);
        expect(findCostFields(out)).toEqual([]);
      }),
      { numRuns: 300 },
    );
  });

  it('changes nothing for a role that may read cost', () => {
    fc.assert(
      fc.property(payload, (data) => {
        const out = serializeFor({ roles: ['accounts'], isSuperAdmin: false }, 'Order', data);
        expect(out).toEqual(data);
      }),
      { numRuns: 300 },
    );
  });

  it('would notice a cost field that slipped through', () => {
    // The detector has to work, or every assertion above is vacuous.
    expect(findCostFields({ a: { b: [{ wacPoisha: 1 }] } })).toEqual(['$.a.b[0].wacPoisha']);
    expect(() => {
      assertNoCostFields({ unitCostPoisha: 1 });
    }).toThrow(/unitCostPoisha/);
  });
});

describe('canReadCost matches the matrix', () => {
  it.each(MEMBERSHIP_ROLES)('agrees with COST_READING_ROLES for %s', (role) => {
    expect(canReadCost([role], false)).toBe(COST_READING_ROLES.includes(role));
  });

  it('is true for a super admin with no roles at all', () => {
    expect(canReadCost([], true)).toBe(true);
  });
});
