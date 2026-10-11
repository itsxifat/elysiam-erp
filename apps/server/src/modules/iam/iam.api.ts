import { Injectable, Module } from '@nestjs/common';
import type { MembershipRole } from '@elysium/contracts';
import type { Tx } from '@elysium/db';
import { maskEmail } from '@elysium/domain';
import type { TrustTally } from '@elysium/domain/iam';

import { isActiveOrgAdmin, lockTrust, loadTrust } from './trust.repository.js';
import {
  activeMembers,
  activeRoleBranches,
  membershipsOfUser,
  ownersAmong,
} from './users.repository.js';

/**
 * Identity's service interface for other modules (invariant 12, D-419).
 *
 * What another module needs from identity is "who in this brand could I link to this
 * record": the employee form's sign-in picker and the investor's portal sign-in. Reading
 * `iam.memberships` and `iam.users` straight from those modules would be new coupling the
 * module-boundaries ratchet refuses, so they ask here.
 *
 * Deliberately narrow. A person comes back as an id, a name, the roles they hold in the
 * brand and a **masked** email (`r***@brand.test`): enough to tell two people of the same
 * name apart, and not a staff directory. Nothing about their sign-in (second factor, last
 * sign-in, resets) leaves; that is the staff screen's, behind `read User`.
 *
 * Every method takes the caller's `Tx`, so the read joins the caller's `withOrg`
 * transaction and is bound by its RLS context: another brand's memberships do not exist
 * there.
 */
export interface BrandMember {
  readonly userId: string;
  readonly name: string;
  readonly emailMasked: string;
  readonly roles: readonly MembershipRole[];
}

/** An owner on a record (D-473): their name only for another owner, else null ("Owner"). */
export interface OwnerOnRecord {
  readonly userId: string;
  readonly name: string | null;
}

export interface IamApi {
  /**
   * Which of these people are owners (M31, D-473), for a record that names who did what.
   * An owner's name goes only to another owner; everyone else is told "Owner" (`name`
   * null). Everyone not listed is a person the caller names the usual way.
   */
  ownersAmong(
    tx: Tx,
    userIds: readonly string[],
    viewer: { readonly isOwner?: boolean | undefined },
  ): Promise<readonly OwnerOnRecord[]>;

  /**
   * People with an enabled account and an active role in this brand, by name. With
   * `roles`, only those holding one of them, and only those roles are reported: the
   * caller asks for exactly the people its own grants concern.
   */
  activeMembers(
    tx: Tx,
    orgId: string,
    options?: { readonly roles?: readonly MembershipRole[] },
  ): Promise<readonly BrandMember[]>;

  /**
   * Whether the brand's independent admins trust this person now (D-654 to D-656), for an
   * approval decision about to set aside the grant lineage. Counted live, in the caller's
   * transaction, holding the candidate's trust lock and the active admin memberships for
   * share until it commits, so a withdrawn vote or a deactivated voter cannot cross it.
   *
   * `requesterId`'s own vote never counts here (the ledger audit of 2026-10-07): a super
   * admin's single vote trusts anyone (D-657), but it must not let the person they vouched
   * for approve that super admin's own request, or maker ≠ checker is one person again. And
   * trust is an org admin's (D-654): a checker whose admin role is gone keeps none.
   */
  checkerTrust(
    tx: Tx,
    orgId: string,
    userId: string,
    options?: { readonly requesterId?: string },
  ): Promise<TrustTally>;

  /**
   * The active roles one person holds in this brand, each with the branches it is limited to
   * (empty: the whole brand), for a caller deciding whether that person would reach a row
   * (M41: who may be handed an order, D-712).
   */
  roleScopes(
    tx: Tx,
    orgId: string,
    userId: string,
  ): Promise<readonly { readonly role: MembershipRole; readonly branchIds: readonly string[] }[]>;

  /**
   * Each active member's branches (D-726): the union of the branches their active roles are
   * limited to, or null when any of their roles reaches the whole brand. For a caller placing
   * people in branches (the team board), never for deciding what a person may do.
   */
  memberBranches(tx: Tx, orgId: string): Promise<ReadonlyMap<string, readonly string[] | null>>;
}

export const IAM_API = Symbol('IAM_API');

@Injectable()
export class IamApiService implements IamApi {
  async ownersAmong(
    tx: Tx,
    userIds: readonly string[],
    viewer: { readonly isOwner?: boolean | undefined },
  ): Promise<readonly OwnerOnRecord[]> {
    const rows = await ownersAmong(tx, userIds);
    return rows.map((row) => ({
      userId: row.id,
      name: viewer.isOwner === true ? row.name : null,
    }));
  }

  async activeMembers(
    tx: Tx,
    orgId: string,
    options: { readonly roles?: readonly MembershipRole[] } = {},
  ): Promise<readonly BrandMember[]> {
    const rows = await activeMembers(tx, orgId, options.roles);
    return rows.map((row) => ({
      userId: row.user_id,
      name: row.name,
      emailMasked: maskEmail(row.email),
      roles: row.roles,
    }));
  }

  async memberBranches(
    tx: Tx,
    orgId: string,
  ): Promise<ReadonlyMap<string, readonly string[] | null>> {
    const reach = new Map<string, Set<string> | null>();
    for (const row of await activeRoleBranches(tx, orgId)) {
      const known = reach.get(row.user_id);
      if (known === null) continue;
      if (row.branch_ids.length === 0) {
        reach.set(row.user_id, null);
        continue;
      }
      const branches = known ?? new Set<string>();
      for (const id of row.branch_ids) branches.add(id);
      reach.set(row.user_id, branches);
    }
    return new Map(
      [...reach].map(([userId, branches]) => [
        userId,
        branches === null ? null : [...branches].sort(),
      ]),
    );
  }

  async roleScopes(
    tx: Tx,
    orgId: string,
    userId: string,
  ): Promise<readonly { readonly role: MembershipRole; readonly branchIds: readonly string[] }[]> {
    const rows = await membershipsOfUser(tx, orgId, userId);
    return rows
      .filter((row) => row.is_active)
      .map((row) => ({ role: row.role, branchIds: row.branch_ids }));
  }

  async checkerTrust(
    tx: Tx,
    orgId: string,
    userId: string,
    options: { readonly requesterId?: string } = {},
  ): Promise<TrustTally> {
    await lockTrust(tx, orgId, userId, 'shared');
    const facts = await loadTrust(tx, orgId, { lock: true });
    const voters = (facts.votes.get(userId) ?? []).filter((id) => id !== options.requesterId);
    const tally = facts.graph.tally(userId, voters);
    if (!(await isActiveOrgAdmin(tx, orgId, userId))) return { ...tally, trusted: false };
    return tally;
  }
}

/**
 * The interface on its own, without the Better Auth instance `IamModule.register` needs.
 *
 * `IamModule` is dynamic because the composition root hands it the auth instance; a module
 * that only wants to ask who is in a brand should not have to carry that, nor be able to.
 */
@Module({
  providers: [{ provide: IAM_API, useClass: IamApiService }],
  exports: [IAM_API],
})
export class IamDirectoryModule {}
