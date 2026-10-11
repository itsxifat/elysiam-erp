import { Inject, Injectable } from '@nestjs/common';
import type { MembershipRole } from '@elysium/contracts';
import type { Tx } from '@elysium/db';
import {
  defaultWorkTypes,
  WORK_TYPES,
  type PresenceFacts,
  type WorkType,
} from '@elysium/domain/assignment';

import { IAM_API, type IamApi } from '../iam/iam.api.js';
import * as repo from './team.repository.js';

/**
 * The team's service interface for other modules (M41, D-713, D-714; invariant 12).
 *
 * What the orders module (and, from M42, the inbox) needs to offer work fairly: every active
 * person in the brand with their roles, the work types and hub on their desk profile, and the
 * facts their presence is derived from. The derivation itself (`presenceState`) is the
 * caller's, at the instant it decides, so two readers never disagree about "now".
 *
 * Every method takes the caller's `Tx`, so the read joins the caller's `withOrg` transaction
 * and is bound by its RLS context.
 */
export interface TeamMember {
  readonly userId: string;
  readonly name: string;
  readonly roles: readonly MembershipRole[];
  readonly workTypes: readonly WorkType[];
  /** The hub's stock location; null for none, which the hub reads as every location. */
  readonly hubLocationId: string | null;
  /** No desk profile saved: the role's defaults apply (D-714). */
  readonly defaultProfile: boolean;
  /**
   * The branches their roles are limited to, or null when a role reaches the whole brand
   * (D-726: a branch manager's team board lists the people of their branches).
   */
  readonly branchIds: readonly string[] | null;
  readonly presence: PresenceFacts;
}

export interface TeamApi {
  /** Every person with an active role in the brand, with their desk and their presence. */
  members(tx: Tx, orgId: string): Promise<readonly TeamMember[]>;
  /** The stock location of the hub this person works at, from their desk profile; null if none. */
  hubLocationOf(tx: Tx, orgId: string, userId: string): Promise<string | null>;
}

export const TEAM_API = Symbol('TEAM_API');

const dateOf = (value: Date | string | null | undefined): Date | null =>
  value === null || value === undefined ? null : new Date(value);

export function workTypesOf(stored: readonly string[]): readonly WorkType[] {
  return WORK_TYPES.filter((type) => stored.includes(type));
}

@Injectable()
export class TeamApiService implements TeamApi {
  constructor(@Inject(IAM_API) private readonly iam: IamApi) {}

  async hubLocationOf(tx: Tx, orgId: string, userId: string): Promise<string | null> {
    return (await repo.deskProfileOf(tx, orgId, userId))?.hub_location_id ?? null;
  }

  async members(tx: Tx, orgId: string): Promise<readonly TeamMember[]> {
    const [people, profiles, presence, branches] = await Promise.all([
      this.iam.activeMembers(tx, orgId),
      repo.allDeskProfiles(tx, orgId),
      repo.allPresence(tx, orgId),
      this.iam.memberBranches(tx, orgId),
    ]);
    const profileOf = new Map(profiles.map((row) => [row.user_id, row]));
    const presenceOf = new Map(presence.map((row) => [row.user_id, row]));
    return people.map((person) => {
      const profile = profileOf.get(person.userId);
      const seen = presenceOf.get(person.userId);
      return {
        userId: person.userId,
        name: person.name,
        roles: person.roles,
        workTypes:
          profile === undefined ? defaultWorkTypes(person.roles) : workTypesOf(profile.work_types),
        hubLocationId: profile?.hub_location_id ?? null,
        defaultProfile: profile === undefined,
        branchIds: branches.get(person.userId) ?? null,
        presence: {
          lastSeenAt: dateOf(seen?.last_seen_at),
          lastActiveAt: dateOf(seen?.last_active_at),
          paused: seen?.paused ?? false,
        },
      };
    });
  }
}
