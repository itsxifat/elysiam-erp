import { Inject, Injectable } from '@nestjs/common';
import {
  defineAbilityFor,
  type TerminalBindInput,
  type TerminalCamerasInput,
  type TerminalCreateInput,
  type TerminalKind,
  type TerminalMembersInput,
  type TerminalUpdateInput,
} from '@elysium/contracts';
import { withOrg, type Tx } from '@elysium/db';
import { presenceState } from '@elysium/domain/assignment';
import { cameraState } from '@elysium/domain/packing';
import { STATION_SEEN_MS, ordersPerHour, printerShownState } from '@elysium/domain/packing';

import { AuditService } from '../../platform/audit/audit.service.js';
import type { AuditableRequest } from '../../platform/audit/audit.interceptor.js';
import type { ActiveContext } from '../../platform/http/context.js';
import { IAM_API, type IamApi } from '../iam/iam.api.js';
import { TEAM_API, type TeamApi } from '../team/team.api.js';
import * as repo from './labels.repository.js';
import { mapPackingErrors, PackingError } from './station.errors.js';
import { newTerminalToken, orgIdOfTerminalToken, terminalTokenHash } from './terminal-token.js';

const iso = (value: Date | string | null): string | null =>
  value === null ? null : new Date(value).toISOString();

const at = (value: Date | string | null): Date | null => (value === null ? null : new Date(value));

/** Midnight in Asia/Dhaka today, as an instant (invariant 8): "today" for orders per hour. */
export function dhakaMidnight(now: Date): Date {
  const dhaka = new Date(now.getTime() + 6 * 3_600_000);
  return new Date(
    Date.UTC(dhaka.getUTCFullYear(), dhaka.getUTCMonth(), dhaka.getUTCDate()) - 6 * 3_600_000,
  );
}

/** The terminal a request was made at, as other services see it. */
export interface AtTerminal {
  readonly terminal: repo.TerminalRow;
  readonly deviceId: string;
}

/**
 * The hub's terminals (M46, D-801 to D-803, D-823): packing desks and label desks, who works at
 * each, the computers bound to them, a packing desk's cameras, and the live picture of each.
 *
 * Supervisors (`update PackingTerminal`: org_admin, branch_manager) set them up; warehouse reads
 * them and works at them. A computer is bound by a supervisor and keeps its token in the
 * browser; every terminal request carries it (`x-terminal-device`), and `resolve` turns it into
 * the terminal, refusing a revoked binding, a switched-off terminal, the wrong kind of terminal
 * and a person not assigned there (a supervisor may stand in anywhere).
 */
@Injectable()
export class TerminalsService {
  constructor(
    private readonly audit: AuditService,
    @Inject(IAM_API) private readonly iam: IamApi,
    @Inject(TEAM_API) private readonly team: TeamApi,
  ) {}

  /** Every terminal with its people, computers, cameras, printers and live state. */
  async list(context: ActiveContext) {
    return withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
      const now = new Date();
      const [
        terminals,
        members,
        devices,
        cameras,
        printers,
        openJobs,
        completed,
        openSessions,
        team,
      ] = await Promise.all([
        repo.terminalsOf(tx, context.orgId),
        repo.membersOf(tx, context.orgId),
        repo.devicesOf(tx, context.orgId),
        repo.camerasWithTerminals(tx, context.orgId),
        repo.printersOf(tx, context.orgId),
        repo.openJobsByTerminal(tx, context.orgId),
        repo.completedSince(tx, context.orgId, dhakaMidnight(now)),
        repo.openSessionsAtTerminals(tx, context.orgId),
        this.team.members(tx, context.orgId),
      ]);
      const person = new Map(team.map((member) => [member.userId, member]));
      const nameOf = (id: string | null) => (id === null ? null : (person.get(id)?.name ?? null));
      const canEdit = defineAbilityFor(context).can('update', 'PackingTerminal');
      return {
        canEdit,
        terminals: terminals.map((terminal) => {
          const here = devices.filter((device) => device.terminal_id === terminal.id);
          const seen = here
            .filter(
              (device) =>
                device.last_seen_at !== null &&
                now.getTime() - new Date(device.last_seen_at).getTime() <= STATION_SEEN_MS,
            )
            .map((device) => device.last_seen_at)
            .sort();
          const stationSeenAt = seen.length === 0 ? null : at(seen[seen.length - 1] ?? null);
          const working = here.filter(
            (device) =>
              device.last_user_id !== null &&
              device.last_seen_at !== null &&
              now.getTime() - new Date(device.last_seen_at).getTime() <= STATION_SEEN_MS,
          );
          return {
            id: terminal.id,
            kind: terminal.kind,
            name: terminal.name,
            locationId: terminal.location_id,
            active: terminal.active,
            members: members
              .filter((member) => member.terminal_id === terminal.id)
              .map((member) => ({ id: member.user_id, name: nameOf(member.user_id) })),
            devices: here.map((device) => ({
              id: device.id,
              label: device.label,
              lastSeenAt: iso(device.last_seen_at),
              lastUser:
                device.last_user_id === null
                  ? null
                  : { id: device.last_user_id, name: nameOf(device.last_user_id) },
            })),
            // Who is signed in at it now, and their presence (M41's, D-713).
            workingNow: working.map((device) => {
              const member =
                device.last_user_id === null ? undefined : person.get(device.last_user_id);
              return {
                id: device.last_user_id ?? '',
                name: member?.name ?? null,
                since: iso(device.user_since),
                deviceLabel: device.label,
                presence: member === undefined ? 'away' : presenceState(member.presence, now).state,
              };
            }),
            cameras: cameras
              .filter((camera) => camera.terminal_id === terminal.id)
              .map((camera) => ({
                id: camera.id,
                name: camera.name,
                state: cameraState({
                  enabled: camera.enabled,
                  lastSegmentAt: at(camera.last_segment_at),
                  now,
                }),
              })),
            printers: printers
              .filter((printer) => printer.terminal_id === terminal.id)
              .map((printer) => ({
                id: printer.id,
                name: printer.name,
                connection: printer.connection,
                documents: printer.documents,
                state: printerShownState({
                  connection: printer.connection,
                  enabled: printer.enabled,
                  status: printer.status,
                  statusAt: at(printer.status_at),
                  stationSeenAt,
                  now,
                }),
                detail: printer.status_detail,
              })),
            queued: openJobs.get(terminal.id) ?? 0,
            packingNow:
              openSessions
                .filter((session) => session.terminal_id === terminal.id)
                .map((session) => ({
                  orderNo: session.order_no,
                  by: nameOf(session.started_by),
                }))[0] ?? null,
            packedToday: completed.get(terminal.id) ?? 0,
            ordersPerHour: ordersPerHour({
              completed: completed.get(terminal.id) ?? 0,
              since: dhakaMidnight(now),
              now,
            }),
          };
        }),
        // Everyone who can be assigned: the people of the brand, by name.
        people: team
          .filter((member) =>
            member.roles.some((role) =>
              ['warehouse', 'branch_manager', 'org_admin'].includes(role),
            ),
          )
          .map((member) => ({ id: member.userId, name: member.name, roles: member.roles })),
      };
    });
  }

  async create(context: ActiveContext, request: AuditableRequest, input: TerminalCreateInput) {
    return mapPackingErrors(() =>
      withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
        const row = await repo.insertTerminal(tx, {
          orgId: context.orgId,
          kind: input.kind,
          name: input.name,
          locationId: input.locationId,
          active: input.active,
          userId: context.userId,
        });
        await this.audit.record(tx, {
          orgId: context.orgId,
          actorUserId: context.userId,
          operation: 'create',
          action: 'packing.terminal_added',
          entityType: 'packing_terminal',
          entityId: row.id,
          after: {
            kind: row.kind,
            name: row.name,
            locationId: row.location_id,
            active: row.active,
          },
          request,
        });
        return this.present(row);
      }),
    );
  }

  async update(
    context: ActiveContext,
    request: AuditableRequest,
    id: string,
    input: TerminalUpdateInput,
  ) {
    return mapPackingErrors(() =>
      withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
        const before = await repo.terminalById(tx, context.orgId, id, { forUpdate: true });
        if (before === undefined) throw new PackingError('TERMINAL_NOT_FOUND', 'No such terminal.');
        const after = await repo.updateTerminal(tx, {
          orgId: context.orgId,
          id,
          name: input.name,
          locationId: input.locationId,
          active: input.active,
          userId: context.userId,
        });
        if (after === undefined) throw new PackingError('TERMINAL_NOT_FOUND', 'No such terminal.');
        await this.audit.record(tx, {
          orgId: context.orgId,
          actorUserId: context.userId,
          operation: 'update',
          action: 'packing.terminal_updated',
          entityType: 'packing_terminal',
          entityId: id,
          before: { name: before.name, locationId: before.location_id, active: before.active },
          after: { name: after.name, locationId: after.location_id, active: after.active },
          request,
        });
        return this.present(after);
      }),
    );
  }

  /** Assign people to a terminal (D-802): staff of this brand, the whole list at once. */
  async setMembers(
    context: ActiveContext,
    request: AuditableRequest,
    id: string,
    input: TerminalMembersInput,
  ) {
    return mapPackingErrors(() =>
      withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
        const terminal = await repo.terminalById(tx, context.orgId, id, { forUpdate: true });
        if (terminal === undefined)
          throw new PackingError('TERMINAL_NOT_FOUND', 'No such terminal.');
        const staff = new Set(
          (await this.iam.activeMembers(tx, context.orgId))
            .filter((member) =>
              member.roles.some((role) => role !== 'reseller' && role !== 'investor'),
            )
            .map((member) => member.userId),
        );
        const unknown = input.userIds.filter((userId) => !staff.has(userId));
        if (unknown.length > 0) {
          throw new PackingError('NOT_FOUND', 'Only the brand’s own staff can work at a terminal.');
        }
        const changed = await repo.replaceMembers(tx, {
          orgId: context.orgId,
          terminalId: id,
          userIds: input.userIds,
          by: context.userId,
        });
        if (changed.added.length > 0 || changed.removed.length > 0) {
          await this.audit.record(tx, {
            orgId: context.orgId,
            actorUserId: context.userId,
            operation: 'update',
            action: 'packing.terminal_members_changed',
            entityType: 'packing_terminal',
            entityId: id,
            after: { added: changed.added, removed: changed.removed },
            request,
          });
        }
        return { terminalId: id, userIds: [...new Set(input.userIds)] };
      }),
    );
  }

  /** A packing terminal's cameras (D-804): the brand's cameras in use, at most eight. */
  async setCameras(
    context: ActiveContext,
    request: AuditableRequest,
    id: string,
    input: TerminalCamerasInput,
  ) {
    return mapPackingErrors(() =>
      withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
        const terminal = await repo.terminalById(tx, context.orgId, id, { forUpdate: true });
        if (terminal === undefined)
          throw new PackingError('TERMINAL_NOT_FOUND', 'No such terminal.');
        if (terminal.kind !== 'packing' && input.cameraIds.length > 0) {
          throw new PackingError('PACKING_CAMERA_INVALID', 'Only a packing terminal has cameras.');
        }
        const set = await repo.setTerminalCameras(tx, {
          orgId: context.orgId,
          terminalId: id,
          cameraIds: input.cameraIds,
        });
        if (set.length !== new Set(input.cameraIds).size) {
          throw new PackingError(
            'PACKING_CAMERA_INVALID',
            'That camera is not one of this brand’s cameras in use.',
          );
        }
        await this.audit.record(tx, {
          orgId: context.orgId,
          actorUserId: context.userId,
          operation: 'update',
          action: 'packing.terminal_cameras_changed',
          entityType: 'packing_terminal',
          entityId: id,
          after: { cameraIds: set },
          request,
        });
        return { terminalId: id, cameraIds: set };
      }),
    );
  }

  /**
   * "This computer is Packing 2" (D-803): a supervisor binds the browser they ask from. The token
   * is answered once; the browser keeps it and the server only its hash.
   */
  async bind(
    context: ActiveContext,
    request: AuditableRequest,
    id: string,
    input: TerminalBindInput,
  ) {
    return mapPackingErrors(() =>
      withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
        const terminal = await repo.terminalById(tx, context.orgId, id, { forShare: true });
        if (terminal?.active !== true) {
          throw new PackingError('TERMINAL_NOT_FOUND', 'No such terminal in use.');
        }
        const token = newTerminalToken(context.orgId);
        const device = await repo.insertDevice(tx, {
          orgId: context.orgId,
          terminalId: id,
          label: input.label,
          tokenSha256: terminalTokenHash(token),
          by: context.userId,
        });
        await this.audit.record(tx, {
          orgId: context.orgId,
          actorUserId: context.userId,
          operation: 'create',
          action: 'packing.terminal_device_bound',
          entityType: 'packing_terminal',
          entityId: id,
          after: { deviceId: device.id, label: device.label },
          request,
        });
        return {
          token,
          device: { id: device.id, label: device.label },
          terminal: this.present(terminal),
        };
      }),
    );
  }

  async revoke(context: ActiveContext, request: AuditableRequest, deviceId: string) {
    return mapPackingErrors(() =>
      withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
        const device = await repo.revokeDevice(tx, {
          orgId: context.orgId,
          id: deviceId,
          by: context.userId,
        });
        if (device === undefined) {
          throw new PackingError('TERMINAL_DEVICE_INVALID', 'No such bound computer.');
        }
        await this.audit.record(tx, {
          orgId: context.orgId,
          actorUserId: context.userId,
          operation: 'update',
          action: 'packing.terminal_device_revoked',
          entityType: 'packing_terminal',
          entityId: device.terminal_id,
          after: { deviceId, label: device.label },
          request,
        });
        return { id: deviceId, revoked: true as const };
      }),
    );
  }

  /**
   * A bound computer's check-in (D-803): the binding confirmed with the server, the person signed
   * in recorded as working there, and whether they are assigned to it. Every half minute.
   */
  async checkIn(context: ActiveContext, token: string | null) {
    return mapPackingErrors(() =>
      withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
        const found = await this.device(tx, context.orgId, token);
        const terminal = await repo.terminalById(tx, context.orgId, found.terminal_id);
        if (terminal?.active !== true) {
          throw new PackingError(
            'TERMINAL_DEVICE_INVALID',
            'This computer’s terminal is switched off.',
          );
        }
        await repo.touchDevice(tx, { orgId: context.orgId, id: found.id, userId: context.userId });
        const assigned = await repo.isMember(tx, context.orgId, terminal.id, context.userId);
        return {
          terminal: this.present(terminal),
          device: { id: found.id, label: found.label },
          assigned,
          supervisor: defineAbilityFor(context).can('update', 'PackingTerminal'),
        };
      }),
    );
  }

  /**
   * The terminal a request is made at (the `x-terminal-device` header), or null when the
   * computer is not bound. Refuses a revoked or unknown binding, a switched-off terminal, a
   * terminal of the other kind, and a person not assigned to it (a supervisor may stand in).
   */
  async resolve(
    tx: Tx,
    context: ActiveContext,
    token: string | null,
    /** The kind of work asked for; `any` for work either kind of desk does (printing, handover). */
    kind: TerminalKind | 'any',
  ): Promise<AtTerminal | null> {
    if (token === null) return null;
    const found = await this.device(tx, context.orgId, token);
    const terminal = await repo.terminalById(tx, context.orgId, found.terminal_id);
    if (terminal?.active !== true) {
      throw new PackingError(
        'TERMINAL_DEVICE_INVALID',
        'This computer’s terminal is switched off.',
      );
    }
    if (kind !== 'any' && terminal.kind !== kind) {
      throw new PackingError(
        'TERMINAL_DEVICE_INVALID',
        kind === 'packing'
          ? `This computer is ${terminal.name}, a label terminal. Pack at a packing terminal.`
          : `This computer is ${terminal.name}, a packing terminal. Print from a label terminal.`,
      );
    }
    if (
      !defineAbilityFor(context).can('update', 'PackingTerminal') &&
      !(await repo.isMember(tx, context.orgId, terminal.id, context.userId))
    ) {
      throw new PackingError(
        'TERMINAL_NOT_ASSIGNED',
        `You are not assigned to ${terminal.name}. Ask a supervisor to add you.`,
      );
    }
    return { terminal, deviceId: found.id };
  }

  private async device(tx: Tx, orgId: string, token: string | null): Promise<repo.DeviceRow> {
    // A token names its brand; one of another brand's is no binding here.
    if (token === null || orgIdOfTerminalToken(token) !== orgId) {
      throw new PackingError(
        'TERMINAL_DEVICE_INVALID',
        'This computer is not bound to a terminal.',
      );
    }
    const found = await repo.deviceByToken(tx, orgId, terminalTokenHash(token));
    if (found?.revoked_at !== null) {
      throw new PackingError(
        'TERMINAL_DEVICE_INVALID',
        'This computer’s binding was removed. A supervisor binds it again.',
      );
    }
    return found;
  }

  private present(row: repo.TerminalRow) {
    return {
      id: row.id,
      kind: row.kind,
      name: row.name,
      locationId: row.location_id,
      active: row.active,
      updatedAt: iso(row.updated_at),
    };
  }
}
