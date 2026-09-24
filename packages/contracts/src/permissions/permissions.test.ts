import { AbilityBuilder, createMongoAbility, subject as tag } from '@casl/ability';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { APPROVAL_TYPES } from '../approvals.js';
import { MEMBERSHIP_ROLES, type MembershipRole } from '../iam.js';
import { canReadCost, defineAbilityFor, effectiveScope } from './ability.js';
import {
  canDecideType,
  CHECKER_TYPES,
  COST_READING_ROLES,
  isLimitedChecker,
  LIMITED_CHECKER_ROLES,
  MATRIX,
} from './matrix.js';
import {
  SPEC_6_CHECKERS,
  SPEC_6_GRANTS,
  SUPER_ADMIN_ONLY_APPROVAL_TYPES,
} from './spec-6.fixture.js';
import { assertNoCostFields, findCostFields, serializeFor } from './serialize.js';
import {
  ACTIONS,
  COST_FIELDS,
  RESELLER_VISIBLE_FIELDS,
  SUBJECTS,
  type Action,
  type Scope,
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

/** `MATRIX` flattened to one `role|action|subject|scope` line per grant. */
function grantsOf(): string[] {
  const grants: string[] = [];
  for (const [role, rules] of Object.entries(MATRIX)) {
    for (const rule of rules) {
      const actions = Array.isArray(rule.action) ? rule.action : [rule.action];
      for (const action of actions) grants.push(`${role}|${action}|${rule.subject}|${rule.scope}`);
    }
  }
  return grants.sort();
}

describe('the matrix says what §6 says', () => {
  /*
   * The one suite here that is not a tautology.
   *
   * Everything else in this file asks whether CASL agrees with `MATRIX`, which
   * is worth asking and says nothing about whether `MATRIX` is *right*. Six
   * real deviations passed that question green — accounts holding write on
   * staff records, a sales agent with no unassigned-order queue, a branch
   * manager able to approve a write-off of any size, and three more. So this
   * compares the code against a hand transcription of §6's grid, with §6's own
   * wording quoted beside each block, and a difference in either direction is
   * a failure. Widening is the dangerous one; narrowing is how a role quietly
   * stops being able to do its job.
   */
  it('grants exactly what the §6 transcription lists, no more and no less', () => {
    const actual = grantsOf();
    const expected = [...SPEC_6_GRANTS].sort();

    const extra = actual.filter((grant) => !expected.includes(grant));
    const missing = expected.filter((grant) => !actual.includes(grant));

    expect(extra, `granted but not in §6: ${extra.join(', ')}`).toEqual([]);
    expect(missing, `in §6 but not granted: ${missing.join(', ')}`).toEqual([]);
  });

  it('has a transcription with no duplicate lines, which would hide a missing one', () => {
    expect(new Set(SPEC_6_GRANTS).size).toBe(SPEC_6_GRANTS.length);
  });

  it('would notice a widened rule', () => {
    // The control. If the comparison above were vacuous — comparing a list to
    // itself, or comparing nothing — this would still pass, so it is asserted
    // against a deliberately corrupted copy rather than against the real one.
    const widened = grantsOf().filter((grant) => grant !== 'sales|read|Customer|own');
    widened.push('sales|read|Customer|org');
    expect(widened.filter((g) => !SPEC_6_GRANTS.includes(g))).toEqual(['sales|read|Customer|org']);
  });

  it('matches §6 on which approval types each role may decide', () => {
    for (const [role, expected] of Object.entries(SPEC_6_CHECKERS)) {
      expect(
        [...(CHECKER_TYPES[role as MembershipRole] ?? [])].sort(),
        // §6's own word for this cell, printed on failure — because unlike the
        // grants above, both sides of this comparison are readings of it.
        `${role}: §6 says "${expected.cell}"`,
      ).toEqual([...expected.types].sort());
    }
  });

  it('gives no role a checker type outside §6\u2019s maker-checker list', () => {
    // Membership in the list is one question; being a type at all is another.
    // A typo here is a grant nobody can exercise, which is harmless — but a
    // *real* type appearing in a role that §6 does not give it is the shape
    // `closing_variance` had under `accounts`, and it is the reason this
    // comparison alone was not enough.
    for (const [role, types] of Object.entries(CHECKER_TYPES)) {
      for (const type of types) {
        expect(APPROVAL_TYPES, `${role} may decide unknown type ${type}`).toContain(type);
      }
    }
  });

  it('keeps a till reconciliation out of the payments column', () => {
    /*
     * Pinned by name, because the generic comparison above could not see it.
     *
     * §6's maker-checker list names "daily closing variances" separately from
     * "supplier payments above the threshold". With it in the accounts list,
     * the team that books the cash entry also approved the till shortfall —
     * `accounts` holds create and update on `Wallet` at org scope — and
     * `isLimitedChecker` uncapped any branch manager who also held `accounts`,
     * on the one type where the branch *is* the till.
     */
    expect(canDecideType(['accounts'], 'closing_variance', false)).toBe(false);
    expect(isLimitedChecker(['branch_manager', 'accounts'], 'closing_variance', false)).toBe(true);
    // The positive control: accounts still checks what §6 does give them.
    expect(canDecideType(['accounts'], 'supplier_payment', false)).toBe(true);
  });

  it('caps a role whose only route to a type is a limited one', () => {
    // A branch manager alone is capped on the types §6 gives them.
    expect(isLimitedChecker(['branch_manager'], 'stock_write_off', false)).toBe(true);
    // Additive roles: the wider one applies, as it does for scope.
    expect(isLimitedChecker(['branch_manager', 'org_admin'], 'stock_write_off', false)).toBe(false);
    // Not a checker for this type at all: there is nothing to cap, and the
    // type check refuses them before an amount is ever considered.
    expect(isLimitedChecker(['branch_manager'], 'payroll_run', false)).toBe(false);
    expect(isLimitedChecker(['sales'], 'stock_write_off', false)).toBe(false);
    // A super admin is never capped (§5 exception 3).
    expect(isLimitedChecker(['branch_manager'], 'stock_write_off', true)).toBe(false);
  });

  it('matches §6 on which checkers are capped by an amount', () => {
    const limited = Object.entries(SPEC_6_CHECKERS)
      .filter(([, cell]) => cell.limited)
      .map(([role]) => role)
      .sort();
    expect([...LIMITED_CHECKER_ROLES].sort()).toEqual(limited);
  });

  it('leaves a super-admin-only approval type out of every other list', () => {
    for (const type of SUPER_ADMIN_ONLY_APPROVAL_TYPES) {
      for (const role of MEMBERSHIP_ROLES) {
        expect(canDecideType([role], type, false), `${role} could decide ${type}`).toBe(false);
      }
      expect(canDecideType([], type, true), 'a super admin must still be able to').toBe(true);
    }
  });

  it('routes every approval type §6 names to at least one checker', () => {
    // The mirror of the test above: a type nobody can decide, and that is not
    // deliberately super-admin-only, is a request that can never be answered.
    for (const type of APPROVAL_TYPES) {
      if (SUPER_ADMIN_ONLY_APPROVAL_TYPES.includes(type)) continue;
      const checkers = MEMBERSHIP_ROLES.filter((role) => canDecideType([role], type, false));
      expect(checkers.length, `no role can decide ${type}`).toBeGreaterThan(0);
    }
  });

  it('gives every approval type in the enum a place in the contract', () => {
    // The two lists are edited in different files by different milestones.
    const listed = new Set<string>(Object.values(SPEC_6_CHECKERS).flatMap((cell) => cell.types));
    for (const type of SUPER_ADMIN_ONLY_APPROVAL_TYPES) listed.add(type);
    expect([...listed].sort()).toEqual([...APPROVAL_TYPES].sort());
  });
});

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

  it('grants `all` scope for one documented cell and nothing else', () => {
    /*
     * Cross-org reach is §5 exception 3 and belongs to super_admin. §18 makes
     * exactly one carve-out: an org admin sees other orgs' **normalized
     * metrics and ranks only**, never their raw financials (D-023), read
     * through `erp_analytics` rather than through a tenant query.
     *
     * So this is an allow-list of one rather than a blanket refusal. Written
     * as `not.toBe('all')` it would have had to be deleted to add the
     * leaderboard, and deleting it takes the check with it.
     */
    const ALLOWED_CROSS_ORG = ['org_admin|read|Leaderboard'];

    const crossOrg: string[] = [];
    for (const [role, rules] of Object.entries(MATRIX)) {
      for (const rule of rules) {
        if (rule.scope !== 'all') continue;
        const actions = Array.isArray(rule.action) ? rule.action : [rule.action];
        for (const action of actions) crossOrg.push(`${role}|${action}|${rule.subject}`);
      }
    }

    expect(crossOrg.sort()).toEqual(ALLOWED_CROSS_ORG);
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

  /*
   * A row that a scope should let in, and one it should keep out.
   *
   * Every cell is asserted through a *tagged* subject, because that is the
   * call the guard and the query builder actually make. The earlier version
   * only looked at `scope === 'org'` and `scope === null`, so every `own` and
   * `branch` cell fell between the two branches and asserted nothing at all —
   * 38 of them, covering every rule where scope is the only thing standing
   * between a sales agent and the whole org's orders.
   */
  const MINE = 'usr_1';
  const BRANCH = 'branch-a';

  function rowsFor(scope: Exclude<Scope, 'all'>): {
    allowed: Record<string, unknown>[];
    denied: Record<string, unknown>[];
  } {
    if (scope === 'own') {
      return {
        allowed: [{ createdBy: MINE }, { assignedTo: MINE }],
        denied: [{ createdBy: 'usr_2', assignedTo: 'usr_2' }, { assignedTo: null }],
      };
    }
    if (scope === 'own_or_unassigned') {
      return {
        allowed: [{ createdBy: MINE }, { assignedTo: MINE }, { assignedTo: null }],
        denied: [{ createdBy: 'usr_2', assignedTo: 'usr_2' }],
      };
    }
    if (scope === 'branch') {
      return { allowed: [{ branchId: BRANCH }], denied: [{ branchId: 'branch-z' }] };
    }
    // `org` carries no condition, so every row matches and none is refused.
    return { allowed: [{ id: 'x' }, { createdBy: 'usr_2', branchId: 'branch-z' }], denied: [] };
  }

  it('asserts allowed or forbidden for all of them, scope included', () => {
    expect(cells.length).toBeGreaterThan(1_000);

    const abilities = new Map<MembershipRole, ReturnType<typeof defineAbilityFor>>(
      MEMBERSHIP_ROLES.map((role) => [
        role,
        defineAbilityFor({ ...CONTEXT, roles: [role], branchIds: [BRANCH] }),
      ]),
    );

    const wrong: string[] = [];
    let scopedRefusals = 0;

    for (const cell of cells) {
      const can = abilities.get(cell.role);
      if (can === undefined) throw new Error(`no ability built for ${cell.role}`);
      const scope = effectiveScope([cell.role], cell.action, cell.subject);
      const where = `${cell.role} ${cell.action} ${cell.subject}`;

      if (scope === null) {
        // Denied means denied for *any* row, not merely for the bare string.
        // A rule that leaked in carrying a condition answers false untagged
        // and true for a row that matches it — which is the shape of every
        // scoped rule in the table.
        if (can.can(cell.action, cell.subject)) wrong.push(`${where}: should be denied`);
        for (const row of [{ createdBy: MINE }, { branchId: BRANCH }, { id: 'x' }]) {
          if (can.can(cell.action, tag(cell.subject, row))) {
            wrong.push(`${where}: denied, but allowed ${JSON.stringify(row)}`);
          }
        }
        continue;
      }

      if (scope === 'all') {
        // §18's leaderboard, unconditional like `org`.
        if (!can.can(cell.action, cell.subject)) wrong.push(`${where}: should be allowed`);
        continue;
      }

      const { allowed, denied } = rowsFor(scope);
      for (const row of allowed) {
        if (!can.can(cell.action, tag(cell.subject, row))) {
          wrong.push(`${where} (${scope}): refused ${JSON.stringify(row)}`);
        }
      }
      for (const row of denied) {
        scopedRefusals += 1;
        if (can.can(cell.action, tag(cell.subject, row))) {
          wrong.push(`${where} (${scope}): allowed ${JSON.stringify(row)}`);
        }
      }
    }

    expect(wrong, wrong.slice(0, 10).join('\n')).toEqual([]);
    // The guard against this test's own previous version: scoped cells must
    // have been exercised, not skipped by a branch that never fired.
    expect(scopedRefusals, 'no scoped cell was asserted at all').toBeGreaterThan(30);
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

    expect(ability.can('read', tag('Customer', { createdBy: 'usr_1' }))).toBe(true);
    expect(ability.can('read', tag('Customer', { assignedTo: 'usr_1' }))).toBe(true);
    expect(ability.can('read', tag('Customer', { createdBy: 'usr_2' }))).toBe(false);
  });

  it('adds the unassigned queue for orders, and only for orders', () => {
    // §6 gives sales "own + unassigned queue". Customers are plain `own`, so
    // the wider rule must not have leaked across subjects.
    const ability = abilityFor(['sales']);

    expect(ability.can('read', tag('Order', { createdBy: 'usr_1', assignedTo: null }))).toBe(true);
    expect(ability.can('read', tag('Order', { createdBy: 'usr_2', assignedTo: null }))).toBe(true);
    expect(ability.can('read', tag('Order', { createdBy: 'usr_2', assignedTo: 'usr_2' }))).toBe(
      false,
    );
    expect(ability.can('read', tag('Customer', { createdBy: 'usr_2', assignedTo: null }))).toBe(
      false,
    );
  });

  it('does not read a row that merely omits assignedTo as unassigned', () => {
    // `{ assignedTo: null }` in Mongo-query semantics also matches a row with
    // no such key — which is every partial projection. That would have made
    // any Order-shaped object missing the column readable by every agent.
    const ability = abilityFor(['sales']);

    expect(ability.can('read', tag('Order', { createdBy: 'usr_2' }))).toBe(false);
    // The positive control: with the key present and null it is the queue.
    expect(ability.can('read', tag('Order', { createdBy: 'usr_2', assignedTo: null }))).toBe(true);
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

    // `Order`, not `Stock`: §6 gives a branch manager stock availability
    // org-wide, so `Stock` would assert nothing about scope here.
    expect(ability.can('read', tag('Order', { branchId: 'branch-a' }))).toBe(true);
    expect(ability.can('read', tag('Order', { branchId: 'branch-b' }))).toBe(false);
  });

  it('treats an empty branch scope as the whole org, not as no branches', () => {
    // §6. The opposite reading — `branch_id in ()` — hides every row from a
    // branch manager who has not been assigned one, which looks like a
    // permissions bug and gets "fixed" by widening the rule.
    const ability = defineAbilityFor({ ...CONTEXT, roles: ['branch_manager'], branchIds: [] });

    expect(ability.can('read', tag('Order', { branchId: 'branch-a' }))).toBe(true);
    expect(ability.can('read', tag('Order', { branchId: 'branch-z' }))).toBe(true);
  });

  it('unions the scopes of several roles rather than taking the first', () => {
    expect(effectiveScope(['sales'], 'read', 'Customer')).toBe('own');
    expect(effectiveScope(['sales'], 'read', 'Order')).toBe('own_or_unassigned');
    expect(effectiveScope(['sales', 'branch_manager'], 'read', 'Order')).toBe('branch');
    expect(effectiveScope(['sales', 'org_admin'], 'read', 'Order')).toBe('org');
    // The new scope has to rank between `own` and `branch`, or a sales agent
    // who is also a branch manager loses the queue, or gains the org.
    expect(effectiveScope(['reseller', 'sales'], 'read', 'Order')).toBe('own_or_unassigned');
  });
});

describe('the protected-field lists are lists, and their contents are the control', () => {
  /*
   * Invariant 5 rests entirely on `COST_FIELDS`, and nothing asserted what was
   * in it. The tests below hardcode `unitCostPoisha`, `wacPoisha` and
   * `cogsPoisha` — so deleting `grossProfitPoisha`, `stockValuePoisha`,
   * `supplyLinePricePoisha` or `supplierBalancePoisha`, or any of their
   * snake_case twins, fails nothing and quietly hands margin to every role in
   * the system. The property test cannot see it either: its generator draws
   * key names from `COST_FIELDS`, so a removed entry stops being sampled
   * rather than starting to fail.
   *
   * §6 names five cost concepts plus supply line prices and supplier balances.
   * Both spellings of each, because raw SQL returns snake_case and the ORM
   * returns camelCase, and a response can carry either.
   */
  const EXPECTED_COST_FIELDS = [
    'unitCostPoisha',
    'unit_cost_poisha',
    'wacPoisha',
    'wac_poisha',
    'cogsPoisha',
    'cogs_poisha',
    'grossProfitPoisha',
    'gross_profit_poisha',
    'stockValuePoisha',
    'stock_value_poisha',
    'supplyLinePricePoisha',
    'supply_line_price_poisha',
    'supplierBalancePoisha',
    'supplier_balance_poisha',
  ];

  it('protects exactly the cost fields §6 names, in both spellings', () => {
    expect([...COST_FIELDS].sort()).toEqual([...EXPECTED_COST_FIELDS].sort());
  });

  it('strips every one of them, so membership is not merely declarative', () => {
    // A field can be on the list and still survive if the pruner never reaches
    // its shape. One payload with all of them, nested, through a role with no
    // `read:cost`.
    const row = Object.fromEntries(COST_FIELDS.map((field) => [field, '1']));
    const out = serializeFor({ roles: ['sales'], isSuperAdmin: false }, 'Order', {
      items: [{ sku: 'A', ...row }],
    });

    expect(findCostFields(out)).toEqual([]);
    // The positive control: the payload was not simply emptied.
    expect(JSON.stringify(out)).toContain('"sku":"A"');
  });

  it('has a snake_case twin for every camelCase name, and the reverse', () => {
    // The pairing is the rule, and a single-spelling entry is the bug: raw SQL
    // returns snake_case and the ORM returns camelCase, so a response can
    // carry either and half a pair protects half the responses.
    const toSnake = (field: string) => field.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
    const listed = new Set<string>(COST_FIELDS);

    for (const field of COST_FIELDS) {
      expect(listed.has(toSnake(field)), `${field} has no snake_case twin`).toBe(true);
    }
  });

  it('lets a reseller see exactly the fields §6 allows, and no more', () => {
    // The same argument for the allow-list: §6 names SKU id, SKU code, product
    // name, images, attributes, reseller price and available quantity. An
    // entry added here widens what the least trusted principal sees, which is
    // the one list where a silent addition is worse than a silent removal.
    expect([...RESELLER_VISIBLE_FIELDS].sort()).toEqual(
      [
        'attributes',
        'availableQty',
        'id',
        'images',
        'name',
        'resellerPricePoisha',
        'sku',
        'skuCode',
        'skuId',
      ].sort(),
    );
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

  it('never exposes cost inside an allow-listed subtree', () => {
    const out = serializeFor({ roles: ['reseller'], isSuperAdmin: false }, 'Catalog', {
      sku: { skuCode: 'LIVE-1', wacPoisha: '120000' },
      attributes: { colour: 'red', cogsPoisha: '120000' },
    });

    expect(() => {
      assertNoCostFields(out);
    }).not.toThrow();
    // The positive control: the non-cost parts of those subtrees survive.
    expect(out.sku).toEqual({ skuCode: 'LIVE-1' });
    expect(out.attributes).toEqual({ colour: 'red' });
  });

  it('gives a reseller no more than a staff role gets', () => {
    // The shape of the bug: the narrower path returned early, so the least
    // trusted principal received strictly more than `sales` did.
    const row = { sku: { skuCode: 'A', wacPoisha: '1' }, attributes: { cogsPoisha: '2' } };

    const reseller = serializeFor({ roles: ['reseller'], isSuperAdmin: false }, 'Catalog', row);
    const sales = serializeFor({ roles: ['sales'], isSuperAdmin: false }, 'Catalog', row);

    expect(findCostFields(reseller)).toEqual([]);
    expect(findCostFields(sales)).toEqual([]);
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

describe('a structure that contains itself', () => {
  /*
   * A cycle turned every walker here into a stack overflow — `RangeError:
   * Maximum call stack size exceeded` from `pruneDenied`, which is a 500 on
   * every response of that shape, produced by the one component whose job is
   * to make responses safe. Found by a test written for something else.
   *
   * Not exotic: an ORM with relations hands back parents holding children
   * holding the parent, and a hand-built response object that references its
   * own envelope does the same. `JSON.stringify` refuses such a value outright,
   * so dropping the back-reference costs nothing a response could have carried.
   */
  it('does not overflow the stack', () => {
    const node: Record<string, unknown> = { sku: 'A', wacPoisha: '120000' };
    node.self = node;

    expect(() =>
      serializeFor({ roles: ['sales'], isSuperAdmin: false }, 'Order', node),
    ).not.toThrow();
  });

  it('still strips the cost that was next to the cycle', () => {
    // The cycle must not become a way to smuggle a field past the pruner.
    const node: Record<string, unknown> = { sku: 'A', wacPoisha: '120000' };
    node.self = node;

    const out = serializeFor({ roles: ['sales'], isSuperAdmin: false }, 'Order', node);
    expect(findCostFields(out)).toEqual([]);
    expect(out).toMatchObject({ sku: 'A' });
  });

  it('drops only the back-reference, not the whole branch', () => {
    const child: Record<string, unknown> = { sku: 'B' };
    const parent: Record<string, unknown> = { sku: 'A', child };
    child.parent = parent;

    const out = serializeFor({ roles: ['sales'], isSuperAdmin: false }, 'Order', parent) as Record<
      string,
      Record<string, unknown>
    >;

    expect(out.sku).toBe('A');
    expect(out.child?.sku).toBe('B');
    expect(out.child).not.toHaveProperty('parent');
  });

  it('keeps a value that appears twice without being circular', () => {
    /*
     * The distinction that makes the fix worth more than a visited-set.
     *
     * Tracking every object ever seen would drop the *second* appearance of a
     * shared child — which an ORM produces constantly, and which is perfectly
     * serializable. Only a reference on the current path is a cycle.
     */
    const shared = { sku: 'SHARED', name: 'Kurti' };
    const out = serializeFor({ roles: ['sales'], isSuperAdmin: false }, 'Order', {
      first: shared,
      second: shared,
    }) as Record<string, unknown>;

    expect(out.first).toEqual({ sku: 'SHARED', name: 'Kurti' });
    expect(out.second, 'the second appearance was dropped as if it were a cycle').toEqual({
      sku: 'SHARED',
      name: 'Kurti',
    });
  });

  it('survives one on the reseller allow-list path too', () => {
    const node: Record<string, unknown> = { sku: 'A', attributes: { colour: 'red' } };
    node.self = node;

    const out = serializeFor({ roles: ['reseller'], isSuperAdmin: false }, 'Catalog', node);
    expect(findCostFields(out)).toEqual([]);
    expect(out).toMatchObject({ sku: 'A' });
  });

  it('does not overflow the detector either', () => {
    // `findCostFields` recurses the same way, so it overflowed on the same
    // input — and it is what every "no cost leaked" assertion runs through.
    const node: Record<string, unknown> = { wacPoisha: '1' };
    node.self = node;

    expect(findCostFields(node)).toEqual(['$.wacPoisha']);
  });

  it('survives a cycle through an array', () => {
    const list: unknown[] = [{ sku: 'A' }];
    list.push(list);

    expect(() =>
      serializeFor({ roles: ['sales'], isSuperAdmin: false }, 'Order', { list }),
    ).not.toThrow();
    expect(findCostFields({ list })).toEqual([]);
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

  it('leaves no cost field for a RESELLER either, on the allow-list path', () => {
    // The generator only ever ran `sales` and `accounts` on subject `Order`, so
    // it could not see the reseller branch at all — and that branch returned
    // before the deny-list ran. An allow-listed key exposes its subtree, and a
    // subtree can contain cost: `{ sku: { skuCode, wacPoisha } }` handed the
    // least trusted principal in the system more cost than `sales` got.
    fc.assert(
      fc.property(payload, (data) => {
        const out = serializeFor({ roles: ['reseller'], isSuperAdmin: false }, 'Catalog', data);
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

  it('sees cost inside a class instance, even though the pruner skips one', () => {
    // The pruners skip non-plain objects on purpose — walking a Buffer corrupts
    // it. A detector that shared that blind spot would leave both controls
    // blind in the same place, so this one looks everywhere.
    class Row {
      id = 'p1';
      wacPoisha = '120000';
    }
    expect(findCostFields({ lines: [new Row()] })).toEqual(['$.lines[0].wacPoisha']);
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
