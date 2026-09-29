/**
 * How much discount a person may give at a till (architecture §6, §14).
 *
 * §14 says "discounts within the user's permission" and §6 has no column for it,
 * so this table is the proposal (ASSUMED, recorded as a decision row): a percent
 * ceiling per membership role, in basis points. It belongs beside `CHECKER_TYPES`
 * in `packages/contracts/src/permissions/matrix.ts`, which is where it moves at
 * integration; it is a pure lookup either way.
 *
 * **The server enforces it; the till only displays it.** The PWA is told its
 * ceiling so the cashier sees the limit before typing, but a sale that arrives
 * with more is never posted — it is held for a manager whose own ceiling covers
 * it (`saleHoldReasons`). A limit the UI hides a button for is not a limit.
 *
 * Absent roles hold zero. A role added to the membership list later gives no
 * discount until somebody decides it should.
 */
export const POS_DISCOUNT_CEILING_BPS: Readonly<Record<string, number>> = {
  // An org admin may give anything, including a free replacement.
  org_admin: 10_000,
  // The showroom's own manager: a fifth off, enough for a damaged-box or a
  // regular-customer discount, not enough to empty a rail.
  branch_manager: 2_000,
  // Showroom sales staff, once §6 grants them the till (proposal): a token 5%.
  sales: 500,
};

/** Who is asking, as the request context holds it (D-075: scope per role). */
export interface DiscountAuthority {
  readonly isSuperAdmin: boolean;
  readonly roles: readonly string[];
  readonly branchIdsByRole: Readonly<Partial<Record<string, readonly string[]>>>;
}

/**
 * The highest ceiling any of the caller's roles grants **at this branch**.
 *
 * Per role, never merged across roles (D-075): a user who is `branch_manager` at
 * Gulshan and `sales` at Dhanmondi gets 20% at Gulshan and 5% at Dhanmondi, not
 * 20% at both. A role with an empty branch list reaches the whole org; a role with
 * no entry at all reaches nothing, which is the fail-closed reading of a context
 * that forgot to say.
 */
export function discountCeilingBps(
  authority: DiscountAuthority,
  branchId: string,
  table: Readonly<Record<string, number>> = POS_DISCOUNT_CEILING_BPS,
): number {
  if (authority.isSuperAdmin) return 10_000;
  let best = 0;
  for (const role of authority.roles) {
    const ceiling = table[role] ?? 0;
    if (ceiling <= best) continue;
    const scope = authority.branchIdsByRole[role];
    if (scope === undefined) continue;
    if (scope.length === 0 || scope.includes(branchId)) best = ceiling;
  }
  return best;
}
