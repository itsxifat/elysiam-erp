import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { DeskProfileInput, PresenceBeat } from '@elysium/contracts';
import { withOrg, type Tx } from '@elysium/db';
import {
  PRESENCE_AWAY_AFTER_MS,
  PRESENCE_BEAT_MS,
  PRESENCE_IDLE_AFTER_MS,
  lastActiveFrom,
  presenceState,
  type PresenceReading,
  type PresenceState,
} from '@elysium/domain/assignment';

import type { AuditableRequest } from '../../platform/audit/audit.interceptor.js';
import { AuditService } from '../../platform/audit/audit.service.js';
import { assertInScope, scopeHasNoRowDimension } from '../../platform/auth/scope.js';
import { emit } from '../../platform/events/outbox.js';
import type { ActiveContext } from '../../platform/http/context.js';
import { TEAM_API, type TeamApi, type TeamMember } from './team.api.js';
import * as repo from './team.repository.js';

/**
 * Presence and desk profiles over HTTP (M41, D-713, D-714).
 *
 * ## A beat that changes nothing writes no audit row
 *
 * The console reports every thirty seconds. Recording each report in the brand's audit log
 * would be a hundred rows an hour per person saying "still here", and bury the log's real
 * changes. So a report is audited only when it changes something a supervisor would ask about:
 * the person became active, idle or away, or switched "Not taking orders". Those are written in
 * the same transaction as the change and raise `team.presence_changed` for the team board. A
 * report that only moves the last-seen instant is like a session's last-active stamp (D-713):
 * the controller tells the audit net there is nothing to record, the way the intake does for a
 * replay.
 *
 * ## Only the caller's own presence
 *
 * `Presence` is held at `own` by every role that has it. There is no route that reports or
 * pauses for somebody else: the row is always the caller's, and the scope check says so.
 */

export interface PresenceView extends PresenceReading {
  readonly lastSeenAt: string | null;
  readonly beatMs: number;
  readonly awayAfterMs: number;
  readonly idleAfterMs: number;
}

export interface BeatOutcome {
  readonly view: PresenceView;
  /** Whether the report changed the person's state, and was audited. */
  readonly changed: boolean;
}

export interface DeskProfileView {
  readonly userId: string;
  readonly name: string;
  readonly roles: readonly string[];
  readonly workTypes: readonly string[];
  readonly hubLocationId: string | null;
  readonly defaultProfile: boolean;
  readonly presence: PresenceReading;
}

function viewOf(reading: PresenceReading, lastSeenAt: Date | null): PresenceView {
  return {
    ...reading,
    lastSeenAt: lastSeenAt === null ? null : lastSeenAt.toISOString(),
    beatMs: PRESENCE_BEAT_MS,
    awayAfterMs: PRESENCE_AWAY_AFTER_MS,
    idleAfterMs: PRESENCE_IDLE_AFTER_MS,
  };
}

/** What a stored row last said, read at `now`: its own state, or away if it went quiet. */
function previousState(row: repo.PresenceRow | undefined, now: Date): PresenceState {
  if (row === undefined) return 'away';
  const seen = new Date(row.last_seen_at).getTime();
  return now.getTime() - seen > PRESENCE_AWAY_AFTER_MS ? 'away' : row.state;
}

@Injectable()
export class TeamService {
  constructor(
    @Inject(TEAM_API) private readonly team: TeamApi,
    private readonly audit: AuditService,
  ) {}

  /** The console's report about its own tab. */
  async beat(
    context: ActiveContext,
    request: AuditableRequest,
    input: PresenceBeat,
  ): Promise<BeatOutcome> {
    this.assertOwn(context, request);
    return withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
      const now = await repo.transactionNow(tx);
      const row = await repo.presenceForUpdate(tx, context.orgId, context.userId);
      const lastActiveAt = lastActiveFrom({
        previous: row?.last_active_at == null ? null : new Date(row.last_active_at),
        visible: input.visible,
        idleSeconds: input.idleSeconds,
        now,
      });
      const paused = row?.paused ?? false;
      const reading = presenceState({ lastSeenAt: now, lastActiveAt, paused }, now);
      // A fresh report is never "away"; the stored word is active or idle.
      const state = reading.state === 'active' ? 'active' : 'idle';
      await repo.savePresence(tx, {
        orgId: context.orgId,
        userId: context.userId,
        lastSeenAt: now,
        lastActiveAt,
        state,
        paused,
        pausedAt: row?.paused_at == null ? null : new Date(row.paused_at),
      });
      const before = previousState(row, now);
      const changed = before !== state;
      if (changed) {
        await this.recordChange(tx, context, request, {
          action: 'team.presence_changed',
          before: { state: before, paused },
          after: { state, paused },
        });
      }
      return { view: viewOf(reading, now), changed };
    });
  }

  /** "Not taking orders", on or off. A deliberate act, so always audited. */
  async pause(
    context: ActiveContext,
    request: AuditableRequest,
    paused: boolean,
  ): Promise<PresenceView> {
    this.assertOwn(context, request);
    return withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
      const now = await repo.transactionNow(tx);
      const row = await repo.presenceForUpdate(tx, context.orgId, context.userId);
      // Switching it is an input in the ERP's tab: the person is here, now.
      const lastActiveAt = now;
      const reading = presenceState({ lastSeenAt: now, lastActiveAt, paused }, now);
      const wasPaused = row?.paused ?? false;
      await repo.savePresence(tx, {
        orgId: context.orgId,
        userId: context.userId,
        lastSeenAt: now,
        lastActiveAt,
        state: 'active',
        paused,
        pausedAt: paused
          ? wasPaused && row?.paused_at != null
            ? new Date(row.paused_at)
            : now
          : null,
      });
      await this.recordChange(tx, context, request, {
        action: paused ? 'team.presence_paused' : 'team.presence_resumed',
        before: { state: previousState(row, now), paused: wasPaused },
        after: { state: 'active', paused },
      });
      return viewOf(reading, now);
    });
  }

  /** The caller's presence and desk, for the console's dock. */
  async me(context: ActiveContext, request: object) {
    this.assertOwn(context, request);
    return withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
      const now = await repo.transactionNow(tx);
      const members = await this.team.members(tx, context.orgId);
      const me = members.find((member) => member.userId === context.userId);
      const facts = me?.presence ?? { lastSeenAt: null, lastActiveAt: null, paused: false };
      return {
        presence: viewOf(presenceState(facts, now), facts.lastSeenAt),
        profile: {
          workTypes: me?.workTypes ?? [],
          hubLocationId: me?.hubLocationId ?? null,
          defaultProfile: me?.defaultProfile ?? true,
        },
      };
    });
  }

  /** Every staff member's desk profile, for the Staff page (`read User`). */
  async profiles(context: ActiveContext, request: object): Promise<{ items: DeskProfileView[] }> {
    scopeHasNoRowDimension(
      request,
      'a desk profile is a person’s, read by the org admin across the brand like the staff list',
    );
    return withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
      const now = await repo.transactionNow(tx);
      const members = await this.team.members(tx, context.orgId);
      return { items: members.map((member) => this.profileView(member, now)) };
    });
  }

  /** Save one person's desk profile (`update User`). */
  async saveProfile(
    context: ActiveContext,
    request: AuditableRequest,
    userId: string,
    input: DeskProfileInput,
  ): Promise<DeskProfileView> {
    scopeHasNoRowDimension(
      request,
      'a desk profile is a person’s, set by the org admin across the brand like their roles',
    );
    return withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
      const members = await this.team.members(tx, context.orgId);
      const member = members.find((one) => one.userId === userId);
      // The same answer for a stranger and for somebody else's staff (no oracle).
      if (member === undefined) throw new NotFoundException('No such person in this brand.');
      if (
        input.hubLocationId !== null &&
        !(await repo.isHubLocation(tx, context.orgId, input.hubLocationId))
      ) {
        throw new BadRequestException({
          code: 'STOCK_LOCATION_INVALID',
          message: 'A hub is an active warehouse or showroom of this brand.',
        });
      }
      const before = await repo.deskProfileForUpdate(tx, context.orgId, userId);
      await repo.saveDeskProfile(tx, {
        orgId: context.orgId,
        userId,
        workTypes: input.workTypes,
        hubLocationId: input.hubLocationId,
        updatedBy: context.userId,
      });
      await this.audit.record(tx, {
        orgId: context.orgId,
        actorUserId: context.userId,
        operation: before === undefined ? 'create' : 'update',
        action: 'team.desk_profile_saved',
        entityType: 'desk_profile',
        entityId: userId,
        before:
          before === undefined
            ? { workTypes: member.workTypes, hubLocationId: null, default: true }
            : { workTypes: before.work_types, hubLocationId: before.hub_location_id },
        after: { workTypes: input.workTypes, hubLocationId: input.hubLocationId },
        request,
      });
      const now = await repo.transactionNow(tx);
      return this.profileView(
        {
          ...member,
          workTypes: input.workTypes,
          hubLocationId: input.hubLocationId,
          defaultProfile: false,
        },
        now,
      );
    });
  }

  private profileView(member: TeamMember, now: Date): DeskProfileView {
    return {
      userId: member.userId,
      name: member.name,
      roles: member.roles,
      workTypes: member.workTypes,
      hubLocationId: member.hubLocationId,
      defaultProfile: member.defaultProfile,
      presence: presenceState(member.presence, now),
    };
  }

  private async recordChange(
    tx: Tx,
    context: ActiveContext,
    request: AuditableRequest,
    change: {
      readonly action: string;
      readonly before: { state: PresenceState; paused: boolean };
      readonly after: { state: 'active' | 'idle'; paused: boolean };
    },
  ): Promise<void> {
    await this.audit.record(tx, {
      orgId: context.orgId,
      actorUserId: context.userId,
      operation: 'update',
      action: change.action,
      entityType: 'presence',
      entityId: context.userId,
      before: change.before,
      after: change.after,
      request,
    });
    await emit(
      tx,
      'team.presence_changed',
      { userId: context.userId, state: change.after.state, paused: change.after.paused },
      { orgId: context.orgId },
    );
  }

  /** `Presence` is `own` for every role that holds it: the row is the caller's. */
  private assertOwn(context: ActiveContext, request: object): void {
    assertInScope(request, {
      createdBy: context.userId,
      assignedTo: context.userId,
      branchId: null,
    });
  }
}
