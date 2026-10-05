import { Injectable, Module } from '@nestjs/common';
import type { MembershipRole } from '@elysium/contracts';
import type { Tx } from '@elysium/db';
import { maskEmail } from '@elysium/domain';

import { activeMembers, ownersAmong } from './users.repository.js';

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
