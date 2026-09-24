import { AbilityBuilder, createMongoAbility, subject as tag } from '@casl/ability';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { approvalRequestSchema, NEVER_AUTO_APPROVE_TYPES, thresholdSchema } from '../approvals.js';
import { MEMBERSHIP_ROLES, type MembershipRole } from '../iam.js';
import {
  canReadCost,
  defineAbilityFor as defineAbilityForStrict,
  effectiveScope,
  rowInScope,
  scopeFilterFor as scopeFilterForStrict,
  uniformBranchScope,
  type AbilityContext,
} from './ability.js';
import {
  canDecideType,
  canRequestType,
  CHECKER_TYPES,
  checkerTier,
  COST_READING_ROLES,
  MATRIX,
  REQUESTER_TYPES,
} from './matrix.js';
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

/**
 * Most tests here give every role the same branches, so they build contexts
 * without a per-role map and this fills it in. The per-role and fail-closed
 * cases pass their own map explicitly (D-075).
 */
type LooseContext = Omit<AbilityContext, 'branchIdsByRole'> & {
  branchIdsByRole?: AbilityContext['branchIdsByRole'];
};

function full(context: LooseContext): AbilityContext {
  return {
    ...context,
    branchIdsByRole:
      context.branchIdsByRole ?? uniformBranchScope(context.roles, context.branchIds),
  };
}

const defineAbilityFor = (context: LooseContext) => defineAbilityForStrict(full(context));
const scopeFilterFor = (context: LooseContext, action: Action, subj: Subject) =>
  scopeFilterForStrict(full(context), action, subj);

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

  it('asserts in-scope allowed and out-of-scope forbidden for every own and branch cell', () => {
    // The loop above can only speak to `org` and `null` cells: a scoped rule
    // answers false for a bare subject, so it compared scoped cells against
    // nothing at all. Here every such cell is tried against a row inside the
    // scope (must be allowed) and a row just outside it (must be denied) —
    // which is the whole meaning of `own` and `branch`.
    const scoped = cells.filter((cell) => {
      const scope = effectiveScope([cell.role], cell.action, cell.subject);
      return scope === 'own' || scope === 'branch';
    });
    // Not vacuous: §6 has plenty of both.
    expect(
      scoped.filter((c) => effectiveScope([c.role], c.action, c.subject) === 'own').length,
    ).toBeGreaterThan(5);
    expect(
      scoped.filter((c) => effectiveScope([c.role], c.action, c.subject) === 'branch').length,
    ).toBeGreaterThan(5);

    const wrong: string[] = [];
    for (const cell of scoped) {
      const ability = defineAbilityFor({
        userId: 'usr_1',
        branchIds: ['branch-a'],
        isSuperAdmin: false,
        roles: [cell.role],
      });
      const scope = effectiveScope([cell.role], cell.action, cell.subject);
      const label = `${cell.role} ${cell.action} ${cell.subject} (${String(scope)})`;

      const inside =
        scope === 'own'
          ? [{ createdBy: 'usr_1' }, { assignedTo: 'usr_1' }]
          : [{ branchId: 'branch-a' }];
      const outside =
        scope === 'own'
          ? [{ createdBy: 'usr_2' }, { assignedTo: 'usr_2' }, {}]
          : [{ branchId: 'branch-b' }, { branchId: null }, {}];

      for (const row of inside) {
        if (!ability.can(cell.action, tag(cell.subject, row))) {
          wrong.push(`${label} should allow ${JSON.stringify(row)}`);
        }
      }
      for (const row of outside) {
        if (ability.can(cell.action, tag(cell.subject, row))) {
          wrong.push(`${label} should deny ${JSON.stringify(row)}`);
        }
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

describe('scopeFilterFor: the list-query half of scope', () => {
  const base = { userId: 'usr_1', branchIds: ['branch-a'], isSuperAdmin: false };

  it('is the whole org for an org-scoped role, and nothing for no grant', () => {
    expect(scopeFilterFor({ ...base, roles: ['org_admin'] }, 'read', 'ApprovalRequest')).toEqual({
      kind: 'all',
    });
    expect(scopeFilterFor({ ...base, roles: ['investor'] }, 'read', 'ApprovalRequest')).toEqual({
      kind: 'none',
    });
    expect(scopeFilterFor({ ...base, roles: [], isSuperAdmin: true }, 'read', 'Order')).toEqual({
      kind: 'all',
    });
  });

  it('narrows a branch manager to their branches, and an agent to their own rows', () => {
    expect(
      scopeFilterFor({ ...base, roles: ['branch_manager'] }, 'read', 'ApprovalRequest'),
    ).toEqual({ kind: 'some', anyOf: [{ field: 'branchId', in: ['branch-a'] }] });

    const own = scopeFilterFor({ ...base, roles: ['sales'] }, 'read', 'Order');
    expect(own).toEqual({
      kind: 'some',
      anyOf: [
        { field: 'createdBy', equals: 'usr_1' },
        { field: 'assignedTo', equals: 'usr_1' },
      ],
    });
  });

  it('unions own and branch rather than taking the widest, which is wrong both ways', () => {
    // `effectiveScope` says "branch" for sales + branch_manager. A branch filter
    // alone would hide the agent's own orders in other branches; this keeps
    // both halves.
    const filter = scopeFilterFor({ ...base, roles: ['sales', 'branch_manager'] }, 'read', 'Order');
    expect(rowInScope(filter, { createdBy: 'usr_1', branchId: 'branch-z' })).toBe(true);
    expect(rowInScope(filter, { createdBy: 'usr_2', branchId: 'branch-a' })).toBe(true);
    expect(rowInScope(filter, { createdBy: 'usr_2', branchId: 'branch-z' })).toBe(false);
  });

  it('treats an empty branch scope as the whole org, as the ability does', () => {
    expect(
      scopeFilterFor({ ...base, branchIds: [], roles: ['branch_manager'] }, 'read', 'Stock'),
    ).toEqual({ kind: 'all' });
  });

  it('agrees with CASL on every row, for every role, action and subject', () => {
    // One definition feeds both the per-row check (CASL) and the list query
    // (this filter, rendered as SQL on the server). If the two ever disagreed a
    // row could be listable but not readable, or the reverse.
    const ids = fc.constantFrom('usr_1', 'usr_2', null);
    const branches = fc.constantFrom('branch-a', 'branch-b', null);

    fc.assert(
      fc.property(
        fc.subarray([...MEMBERSHIP_ROLES], { maxLength: 3 }),
        fc.constantFrom(...ACTIONS),
        fc.constantFrom(...SUBJECTS),
        fc.constantFrom<readonly string[]>([], ['branch-a'], ['branch-a', 'branch-b']),
        fc.record({ createdBy: ids, assignedTo: ids, branchId: branches }),
        (roles, action, subj, branchIds, row) => {
          const context = { userId: 'usr_1', branchIds, isSuperAdmin: false, roles };
          const casl = defineAbilityFor(context).can(action, tag(subj, { ...row }));
          expect(rowInScope(scopeFilterFor(context, action, subj), row)).toBe(casl);
        },
      ),
      { numRuns: 2_000 },
    );
  });
});

describe('checker tiers (§6 "branch items under threshold")', () => {
  it('puts a lone branch manager on the branch tier and anyone else on the org tier', () => {
    expect(checkerTier(['branch_manager'], 'stock_write_off', false)).toBe('branch');
    expect(checkerTier(['branch_manager', 'org_admin'], 'stock_write_off', false)).toBe('org');
    expect(checkerTier(['accounts'], 'supplier_payment', false)).toBe('org');
    expect(checkerTier(['branch_manager'], 'payroll_run', false)).toBeNull();
    expect(checkerTier([], 'period_reopen', true)).toBe('org');
    expect(checkerTier(['org_admin'], 'period_reopen', false)).toBeNull();
  });

  it('agrees with canDecideType about who may decide at all', () => {
    for (const role of MEMBERSHIP_ROLES) {
      for (const type of Object.values(CHECKER_TYPES).flat()) {
        expect(checkerTier([role], type, false) !== null).toBe(canDecideType([role], type, false));
      }
    }
  });
});

describe('ApprovalThreshold is org_admin only', () => {
  it.each(MEMBERSHIP_ROLES)('%s', (role) => {
    expect(abilityFor([role]).can('update', 'ApprovalThreshold')).toBe(role === 'org_admin');
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

  it('strips cost nested inside an allow-listed field (W8)', () => {
    // `attributes` exposes its subtree, and cost used to ride out inside it.
    const out = serializeFor({ roles: ['reseller'], isSuperAdmin: false }, 'CostedItem', {
      items: [{ sku: 'A', attributes: { colour: 'red', wacPoisha: '120000' } }],
    });

    expect(findCostFields(out)).toEqual([]);
    expect(out.items[0]?.attributes, 'the positive control').toEqual({ colour: 'red' });
  });

  it('walks a class instance rather than waving it through', () => {
    // It used to skip anything that was not a plain object, and JSON emits a
    // class instance's own fields — so a DTO class carried cost to sales.
    class ItemDto {
      constructor(
        readonly sku: string,
        readonly unitCostPoisha: bigint,
      ) {}
    }
    const out = serializeFor({ roles: ['sales'], isSuperAdmin: false }, 'CostedItem', {
      items: [new ItemDto('A', 1n)],
    });

    expect(findCostFields(out)).toEqual([]);
    expect(out.items[0]).toMatchObject({ sku: 'A' });
    // And the detector sees through one too, or the assertion above is hollow.
    expect(findCostFields({ items: [new ItemDto('A', 1n)] })).toEqual([
      '$.items[0].unitCostPoisha',
    ]);
  });

  it('judges an object by its toJSON, since that is what goes on the wire', () => {
    const wrapped = { toJSON: () => ({ sku: 'A', wacPoisha: 5n }) };
    const out = serializeFor({ roles: ['sales'], isSuperAdmin: false }, 'Order', { row: wrapped });

    expect(findCostFields(out)).toEqual([]);
    expect(JSON.stringify(out, (_k, v: unknown) => (typeof v === 'bigint' ? String(v) : v))).toBe(
      '{"row":{"sku":"A"}}',
    );
  });

  it('passes a Date and a typed array through untouched', () => {
    const when = new Date(0);
    const bytes = new Uint8Array([1, 2]);
    const out = serializeFor({ roles: ['sales'], isSuperAdmin: false }, 'Order', { when, bytes });
    expect(out.when).toBe(when);
    expect(out.bytes).toBe(bytes);
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

describe('branch scope belongs to the membership that granted it (W7, D-075)', () => {
  it('does not let a warehouse branch widen a branch manager’s reach', () => {
    // warehouse@B + branch_manager@A merged to [A, B], and the branch
    // manager's rules then reached B.
    const context = {
      userId: 'usr_1',
      isSuperAdmin: false,
      roles: ['warehouse', 'branch_manager'] as MembershipRole[],
      branchIds: ['branch-a', 'branch-b'],
      branchIdsByRole: { warehouse: ['branch-b'], branch_manager: ['branch-a'] },
    };

    // Wallet: branch_manager at branch scope, warehouse has no rule.
    const filter = scopeFilterFor(context, 'read', 'Wallet');
    expect(rowInScope(filter, { branchId: 'branch-a' })).toBe(true);
    expect(rowInScope(filter, { branchId: 'branch-b' })).toBe(false);

    const ability = defineAbilityFor(context);
    expect(ability.can('read', tag('Wallet', { branchId: 'branch-a' }))).toBe(true);
    expect(ability.can('read', tag('Wallet', { branchId: 'branch-b' }))).toBe(false);
  });
});

describe('a role with no scope entry reaches no branch (fail closed, D-075)', () => {
  it('denies every branch row, in CASL and in the list filter', () => {
    const context = {
      userId: 'usr_1',
      isSuperAdmin: false,
      roles: ['branch_manager'] as MembershipRole[],
      branchIds: [],
      branchIdsByRole: {},
    };

    const filter = scopeFilterFor(context, 'read', 'Wallet');
    expect(filter).toEqual({ kind: 'some', anyOf: [{ field: 'branchId', in: [] }] });
    expect(rowInScope(filter, { branchId: 'branch-a' })).toBe(false);
    expect(defineAbilityFor(context).can('read', tag('Wallet', { branchId: 'branch-a' }))).toBe(
      false,
    );

    // The positive control: mapped to [] it is the whole org (§6).
    const whole = { ...context, branchIdsByRole: { branch_manager: [] } };
    expect(scopeFilterFor(whole, 'read', 'Wallet')).toEqual({ kind: 'all' });
  });
});

describe('who may raise which request (W5, D-072)', () => {
  it('keeps payroll and payments away from roles §6 does not give them', () => {
    expect(canRequestType(['sales'], 'wallet_adjustment', false)).toBe(false);
    expect(canRequestType(['warehouse'], 'supplier_payment', false)).toBe(false);
    expect(canRequestType(['branch_manager'], 'payroll_run', false)).toBe(false);
    expect(canRequestType(['hr'], 'payroll_run', false)).toBe(true);
    expect(canRequestType(['warehouse'], 'stock_write_off', false)).toBe(true);
    expect(canRequestType(['accounts'], 'period_reopen', false)).toBe(true);
  });

  it('never lets anyone raise a threshold change through the generic route', () => {
    for (const role of MEMBERSHIP_ROLES) {
      expect(canRequestType([role], 'threshold_change', false)).toBe(false);
    }
    expect(canRequestType([], 'threshold_change', true)).toBe(false);
  });

  it('gives request ApprovalRequest to exactly the roles that can raise something', () => {
    for (const role of MEMBERSHIP_ROLES) {
      const listed = (REQUESTER_TYPES[role] ?? []).length > 0;
      expect(abilityFor([role]).can('request', 'ApprovalRequest'), role).toBe(listed);
    }
  });
});

describe('approval request and threshold schemas (C1, D-071)', () => {
  it('refuses a threshold on a type that must never be auto-approved', () => {
    for (const type of NEVER_AUTO_APPROVE_TYPES) {
      expect(thresholdSchema.safeParse({ type, thresholdPoisha: '1' }).success, type).toBe(false);
    }
    expect(
      thresholdSchema.safeParse({ type: 'wallet_adjustment', thresholdPoisha: '1' }).success,
    ).toBe(true);
  });

  it('refuses an amount on an amountless type, and a missing one elsewhere', () => {
    expect(
      approvalRequestSchema.safeParse({ type: 'period_reopen', amountPoisha: '0' }).success,
    ).toBe(false);
    expect(
      approvalRequestSchema.safeParse({ type: 'period_reopen', amountPoisha: null }).success,
    ).toBe(true);
    expect(approvalRequestSchema.safeParse({ type: 'wallet_adjustment' }).success).toBe(false);
    expect(
      approvalRequestSchema.safeParse({ type: 'wallet_adjustment', amountPoisha: '5' }).success,
    ).toBe(true);
  });
});
