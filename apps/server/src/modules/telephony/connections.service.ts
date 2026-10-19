import { randomUUID } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';
import type {
  TelephonyConnectionCreateInput,
  TelephonyConnectionUpdateInput,
} from '@elysium/contracts/telephony';
import { withOrg } from '@elysium/db';
import { customerPhoneFrom, envoBaseUrl, type BaseUrlProblem } from '@elysium/domain/telephony';

import type { AuditableRequest } from '../../platform/audit/audit.interceptor.js';
import { AuditService } from '../../platform/audit/audit.service.js';
import { sealedBoxConfigured } from '../../platform/crypto/sealed-box.js';
import type { ActiveContext } from '../../platform/http/context.js';
import { IAM_API, type IamApi } from '../iam/iam.api.js';
import {
  EnvoError,
  type EnvoConnection,
  type EnvoExtension,
  type EnvoGateway,
  type EnvoLiveCall,
  liveCallOnPhoneOf,
} from './providers/envo-gateway.js';
import { ENVO_WEBHOOK_PREFIX } from './raw-body.js';
import { TELEPHONY_CONFIG, type TelephonyConfig } from './telephony.config.js';
import { mapTelephonyErrors, TelephonyError } from './telephony.errors.js';
import { connectionBinding, openSecret, sealSecret } from './telephony-secrets.js';
import * as repo from './telephony.repository.js';
import { callingPeople } from './telephony.roles.js';
import { ENVO_GATEWAY } from './telephony.tokens.js';

/** Envo allows 120 requests a minute per key: presence is asked at most every ten seconds. */
const EXTENSIONS_CACHE_MS = 10_000;
const LIVE_CACHE_MS = 5_000;

const BASE_URL_PROBLEMS: Readonly<Record<BaseUrlProblem, string>> = {
  invalid: 'The base URL is not a web address.',
  not_https: 'The base URL must start with https://.',
  not_origin: 'The base URL is the address alone, like https://envo.enfinito.cloud, with no path.',
  host_refused: 'The base URL must name a public host, not an IP address or a local name.',
};

function iso(value: Date | string | null): string | null {
  return value === null ? null : new Date(value).toISOString();
}

/** A connection as Settings → Calls shows it. Never a secret, only whether it is set. */
export function connectionView(row: repo.ConnectionRow, orgId: string) {
  return {
    id: row.id,
    name: row.name,
    baseUrl: row.base_url,
    enabled: row.enabled,
    apiKeySet: row.api_key_fingerprint !== null,
    apiKeyFingerprint: row.api_key_fingerprint,
    webhookSecretSet: row.webhook_secret_fingerprint !== null,
    webhookSecretFingerprint: row.webhook_secret_fingerprint,
    /** Where Envo's webhook points: this API's address plus this path. */
    webhookPath: `${ENVO_WEBHOOK_PREFIX}${orgId}/${row.id}`,
    envoServer:
      row.envo_server_id === null
        ? null
        : { id: row.envo_server_id, name: row.envo_server_name ?? '' },
    lastTest:
      row.last_tested_at === null
        ? null
        : {
            at: iso(row.last_tested_at),
            ok: row.last_test_ok === true,
            error: row.last_test_error,
          },
    lastWebhook:
      row.last_webhook_at === null
        ? null
        : { at: iso(row.last_webhook_at), event: row.last_webhook_event },
    lastSignatureFailure:
      row.last_signature_failure_at === null
        ? null
        : { at: iso(row.last_signature_failure_at), reason: row.last_signature_failure_reason },
    lastSync:
      row.last_synced_at === null
        ? null
        : { at: iso(row.last_synced_at), error: row.last_sync_error },
  };
}

/** Envo's refusal as the API's (a clear reason, never the key). */
export function envoFailure(error: unknown): TelephonyError {
  if (error instanceof EnvoError) {
    return new TelephonyError(
      error.kind === 'unreachable' || error.kind === 'unexpected' || error.kind === 'rate_limited'
        ? 'TELEPHONY_ENVO_UNREACHABLE'
        : 'TELEPHONY_ENVO_REFUSED',
      error.message,
    );
  }
  return new TelephonyError('TELEPHONY_ENVO_UNREACHABLE', 'Envo could not be asked.');
}

/**
 * Settings → Calls (M47, D-830, D-846, D-847): the brand's Envo connections with their sealed,
 * write-only API key and webhook secret, the Test, the webhook address and what Envo last sent;
 * each connection's extensions with live presence, given to the brand's people. Envo is asked
 * after the transaction that read the connection has committed, never inside one (invariant 6).
 */
@Injectable()
export class TelephonyConnectionsService {
  private readonly extensionsCache = new Map<
    string,
    { readonly at: number; readonly value: readonly EnvoExtension[] }
  >();
  private readonly liveCache = new Map<
    string,
    { readonly at: number; readonly value: readonly EnvoLiveCall[] }
  >();

  constructor(
    private readonly audit: AuditService,
    @Inject(ENVO_GATEWAY) private readonly gateway: EnvoGateway,
    @Inject(TELEPHONY_CONFIG) private readonly config: TelephonyConfig,
    @Inject(IAM_API) private readonly iam: IamApi,
  ) {}

  private baseUrl(input: string): string {
    const checked = envoBaseUrl(input, { allowPlainHttp: this.config.TELEPHONY_ALLOW_PLAIN_HTTP });
    if (!checked.ok)
      throw new TelephonyError('TELEPHONY_INVALID', BASE_URL_PROBLEMS[checked.problem]);
    return checked.origin;
  }

  async list(context: ActiveContext) {
    return mapTelephonyErrors(() =>
      withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => ({
        provider: this.gateway.provider,
        credentialsKey: sealedBoxConfigured(),
        connections: (await repo.connectionsOf(tx, context.orgId)).map((row) =>
          connectionView(row, context.orgId),
        ),
      })),
    );
  }

  async create(
    context: ActiveContext,
    request: AuditableRequest,
    input: TelephonyConnectionCreateInput,
  ) {
    return mapTelephonyErrors(() =>
      withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
        if (!sealedBoxConfigured()) {
          throw new TelephonyError(
            'TELEPHONY_CREDENTIALS_MISSING',
            'This installation has no credentials key, so an Envo key cannot be kept.',
          );
        }
        const baseUrl = this.baseUrl(input.baseUrl);
        const id = randomUUID();
        const apiKey = sealSecret(input.apiKey, connectionBinding(context.orgId, id, 'api_key'));
        const webhookSecret =
          input.webhookSecret === undefined
            ? null
            : sealSecret(
                input.webhookSecret,
                connectionBinding(context.orgId, id, 'webhook_secret'),
              );
        const taken = (await repo.connectionsOf(tx, context.orgId)).some(
          (row) => row.name.toLowerCase() === input.name.toLowerCase(),
        );
        if (taken) {
          throw new TelephonyError('TELEPHONY_INVALID', 'Another connection has that name.');
        }
        await repo.insertConnection(tx, {
          id,
          orgId: context.orgId,
          name: input.name,
          baseUrl,
          enabled: input.enabled,
          apiKey,
          webhookSecret,
          by: context.userId,
        });
        // `keyPrint`, not `apiKeyFingerprint`: the audit's redactor masks keys naming a key, a
        // secret or a token, and the fingerprint is what a reader of the log needs.
        await this.audit.record(tx, {
          orgId: context.orgId,
          actorUserId: context.userId,
          operation: 'create',
          action: 'telephony.connection.created',
          entityType: 'telephony_connection',
          entityId: id,
          after: {
            name: input.name,
            baseUrl,
            enabled: input.enabled,
            keyPrint: apiKey.fingerprint,
            hookPrint: webhookSecret?.fingerprint ?? null,
          },
          requestId: context.requestId,
          request,
        });
        const row = await repo.connectionById(tx, context.orgId, id);
        if (row === undefined) throw new Error('the connection was not saved');
        return connectionView(row, context.orgId);
      }),
    );
  }

  async update(
    context: ActiveContext,
    request: AuditableRequest,
    id: string,
    input: TelephonyConnectionUpdateInput,
  ) {
    return mapTelephonyErrors(() =>
      withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
        const before = await repo.connectionById(tx, context.orgId, id, { lock: true });
        if (before === undefined) {
          throw new TelephonyError('TELEPHONY_NOT_FOUND', 'No such connection.');
        }
        if (
          (input.apiKey !== undefined || input.webhookSecret !== undefined) &&
          !sealedBoxConfigured()
        ) {
          throw new TelephonyError(
            'TELEPHONY_CREDENTIALS_MISSING',
            'This installation has no credentials key, so an Envo key cannot be kept.',
          );
        }
        const baseUrl = this.baseUrl(input.baseUrl);
        // The sealed key goes only to the host it was pasted for (D-830): a new address needs the
        // key pasted again, or editing the address would be a way to read the write-only key.
        if (baseUrl !== before.base_url && input.apiKey === undefined) {
          throw new TelephonyError(
            'TELEPHONY_INVALID',
            'A new base URL needs its API key: paste the key again for the new address.',
          );
        }
        const taken = (await repo.connectionsOf(tx, context.orgId)).some(
          (row) => row.id !== id && row.name.toLowerCase() === input.name.toLowerCase(),
        );
        if (taken) {
          throw new TelephonyError('TELEPHONY_INVALID', 'Another connection has that name.');
        }
        const apiKey =
          input.apiKey === undefined
            ? undefined
            : sealSecret(input.apiKey, connectionBinding(context.orgId, id, 'api_key'));
        const webhookSecret =
          input.webhookSecret === undefined
            ? undefined
            : sealSecret(
                input.webhookSecret,
                connectionBinding(context.orgId, id, 'webhook_secret'),
              );
        await repo.updateConnection(tx, context.orgId, id, {
          name: input.name,
          baseUrl,
          enabled: input.enabled,
          ...(apiKey === undefined ? {} : { apiKey }),
          ...(webhookSecret === undefined ? {} : { webhookSecret }),
          forgetServer: baseUrl !== before.base_url || apiKey !== undefined,
          by: context.userId,
        });
        this.extensionsCache.delete(id);
        this.liveCache.delete(id);
        await this.audit.record(tx, {
          orgId: context.orgId,
          actorUserId: context.userId,
          operation: 'update',
          action: 'telephony.connection.updated',
          entityType: 'telephony_connection',
          entityId: id,
          before: {
            name: before.name,
            baseUrl: before.base_url,
            enabled: before.enabled,
            keyPrint: before.api_key_fingerprint,
            hookPrint: before.webhook_secret_fingerprint,
          },
          after: {
            name: input.name,
            baseUrl,
            enabled: input.enabled,
            keyPrint: apiKey?.fingerprint ?? before.api_key_fingerprint,
            hookPrint: webhookSecret?.fingerprint ?? before.webhook_secret_fingerprint,
          },
          requestId: context.requestId,
          request,
        });
        const row = await repo.connectionById(tx, context.orgId, id);
        if (row === undefined) throw new Error('the connection disappeared');
        return connectionView(row, context.orgId);
      }),
    );
  }

  /** The connection's base URL and opened key, read in a short transaction of its own. */
  async credentials(
    context: { readonly orgId: string; readonly userId: string },
    id: string,
    options: { readonly requireEnabled: boolean },
  ): Promise<{ readonly row: repo.ConnectionRow; readonly envo: EnvoConnection }> {
    const row = await withOrg({ orgId: context.orgId, userId: context.userId }, (tx) =>
      repo.connectionById(tx, context.orgId, id),
    );
    if (row === undefined) throw new TelephonyError('TELEPHONY_NOT_FOUND', 'No such connection.');
    return { row, envo: this.open(row, context.orgId, options) };
  }

  open(
    row: repo.ConnectionRow,
    orgId: string,
    options: { readonly requireEnabled: boolean },
  ): EnvoConnection {
    if (options.requireEnabled && !row.enabled) {
      throw new TelephonyError(
        'TELEPHONY_NOT_READY',
        `The ${row.name} connection is switched off in Settings → Calls.`,
      );
    }
    const apiKey = openSecret(row.api_key_sealed, connectionBinding(orgId, row.id, 'api_key'));
    if (apiKey === null) {
      throw new TelephonyError(
        'TELEPHONY_NOT_READY',
        `The ${row.name} connection has no API key that opens; paste it again in Settings → Calls.`,
      );
    }
    return { baseUrl: row.base_url, apiKey };
  }

  /**
   * The Test: Envo's `/ping` (the key, its scopes and its SIP server), its extensions and its
   * numbers, asked after the connection was read. The outcome is kept on the connection either
   * way, and a refusal comes back with Envo's reason (acceptance check 1).
   */
  async test(context: ActiveContext, request: AuditableRequest, id: string) {
    return mapTelephonyErrors(async () => {
      const { row, envo } = await this.credentials(context, id, { requireEnabled: false });
      let outcome:
        | {
            readonly ok: true;
            readonly ping: Awaited<ReturnType<EnvoGateway['ping']>>;
            readonly extensions: readonly EnvoExtension[];
            readonly numbers: Awaited<ReturnType<EnvoGateway['numbers']>>;
          }
        | { readonly ok: false; readonly error: TelephonyError };
      try {
        const ping = await this.gateway.ping(envo);
        const [extensions, numbers] = await Promise.all([
          this.gateway.extensions(envo),
          this.gateway.numbers(envo),
        ]);
        this.extensionsCache.set(id, { at: Date.now(), value: extensions });
        outcome = { ok: true, ping, extensions, numbers };
      } catch (error) {
        outcome = { ok: false, error: envoFailure(error) };
      }
      await withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
        await repo.recordTest(
          tx,
          context.orgId,
          id,
          outcome.ok
            ? {
                ok: true,
                serverId: outcome.ping.sipServer?.id ?? null,
                serverName: outcome.ping.sipServer?.name ?? null,
              }
            : { ok: false, error: outcome.error.message },
        );
        await this.audit.record(tx, {
          orgId: context.orgId,
          actorUserId: context.userId,
          operation: 'update',
          action: 'telephony.connection.tested',
          entityType: 'telephony_connection',
          entityId: id,
          after: outcome.ok
            ? {
                ok: true,
                sipServer: outcome.ping.sipServer?.name ?? null,
                extensions: outcome.extensions.length,
                numbers: outcome.numbers.length,
              }
            : { ok: false, reason: outcome.error.message },
          requestId: context.requestId,
          request,
        });
      });
      if (!outcome.ok) throw outcome.error;
      const scopes = outcome.ping.scopes;
      return {
        ok: true as const,
        connection: row.name,
        sipServer: outcome.ping.sipServer,
        keyName: outcome.ping.keyName,
        scopes,
        missingScopes: ['read', 'calls', 'webphone'].filter((scope) => !scopes.includes(scope)),
        extensions: outcome.extensions,
        numbers: outcome.numbers,
      };
    });
  }

  private async liveExtensions(
    id: string,
    envo: EnvoConnection,
  ): Promise<readonly EnvoExtension[]> {
    const cached = this.extensionsCache.get(id);
    if (cached !== undefined && Date.now() - cached.at < EXTENSIONS_CACHE_MS) return cached.value;
    const value = await this.gateway.extensions(envo);
    this.extensionsCache.set(id, { at: Date.now(), value });
    return value;
  }

  /**
   * One extension as Envo lists it (cached ten seconds), null when Envo does not list it, or
   * `unknown` when Envo could not be asked. For the console's phone: whether it can start.
   */
  async extensionInEnvo(
    id: string,
    envo: EnvoConnection,
    extension: string,
  ): Promise<EnvoExtension | null | 'unknown'> {
    try {
      const listed = await this.liveExtensions(id, envo);
      return listed.find((row) => row.extension === extension) ?? null;
    } catch {
      return 'unknown';
    }
  }

  /**
   * A connection's extensions (D-847): Envo's list with live presence, each with the person it is
   * given to, and the brand's people who place calls. Envo being unreachable still shows the
   * assignments, with the reason.
   */
  async extensions(context: ActiveContext, id: string) {
    return mapTelephonyErrors(async () => {
      const read = await withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
        const row = await repo.connectionById(tx, context.orgId, id);
        if (row === undefined)
          throw new TelephonyError('TELEPHONY_NOT_FOUND', 'No such connection.');
        const [assignments, members] = await Promise.all([
          repo.assignmentsOf(tx, context.orgId),
          callingPeople(this.iam, tx, context.orgId),
        ]);
        return { row, assignments, members };
      });
      let live: readonly EnvoExtension[] | null = null;
      let liveError: string | null = null;
      try {
        live = await this.liveExtensions(
          id,
          this.open(read.row, context.orgId, { requireEnabled: false }),
        );
      } catch (error) {
        liveError = (error instanceof TelephonyError ? error : envoFailure(error)).message;
      }
      const names = new Map(read.members.map((member) => [member.userId, member.name]));
      const mine = read.assignments.filter((assignment) => assignment.connection_id === id);
      const byExtension = new Map(mine.map((assignment) => [assignment.extension, assignment]));
      // `current: false`: still given to someone who no longer places calls here (deactivated,
      // or their calling role taken away). Their calls are nobody's until a supervisor takes the
      // extension off them (D-846).
      const person = (userId: string) => ({
        id: userId,
        name: names.get(userId) ?? null,
        current: names.has(userId),
      });
      const listed = new Set((live ?? []).map((extension) => extension.extension));
      return {
        connectionId: id,
        live: live !== null,
        liveError,
        extensions: [
          ...(live ?? []).map((extension) => {
            const assignment = byExtension.get(extension.extension);
            return {
              ...extension,
              inEnvo: true,
              assignee: assignment === undefined ? null : person(assignment.user_id),
            };
          }),
          // Given to someone here but not (or no longer, or not right now) in Envo's list.
          ...mine
            .filter((assignment) => !listed.has(assignment.extension))
            .map((assignment) => ({
              extension: assignment.extension,
              name: assignment.extension,
              enabled: false,
              dnd: false,
              webPhone: false,
              online: false,
              status: 'unknown',
              inEnvo: live === null,
              assignee: person(assignment.user_id),
            })),
        ].sort((a, b) => a.extension.localeCompare(b.extension, 'en', { numeric: true })),
        people: read.members.map((member) => {
          const theirs = read.assignments.find(
            (assignment) => assignment.user_id === member.userId,
          );
          return {
            id: member.userId,
            name: member.name,
            roles: member.roles,
            extension:
              theirs === undefined
                ? null
                : { connectionId: theirs.connection_id, extension: theirs.extension },
          };
        }),
      };
    });
  }

  /** Give an extension to a person (D-846): one person per extension, one extension per person. */
  async assign(
    context: ActiveContext,
    request: AuditableRequest,
    id: string,
    extension: string,
    userId: string,
  ) {
    return mapTelephonyErrors(() =>
      withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
        const row = await repo.connectionById(tx, context.orgId, id, { lock: true });
        if (row === undefined)
          throw new TelephonyError('TELEPHONY_NOT_FOUND', 'No such connection.');
        const members = await callingPeople(this.iam, tx, context.orgId);
        const member = members.find((candidate) => candidate.userId === userId);
        if (member === undefined) {
          throw new TelephonyError(
            'TELEPHONY_INVALID',
            'That person cannot be given an extension: only sales, branch managers and admins place calls.',
          );
        }
        const book = await this.iam.nameBook(tx, context.orgId);
        const nameOf = (who: string) => book.get(who) ?? 'A colleague';
        const holder = await repo.assignmentOfExtension(tx, context.orgId, id, extension);
        if (holder?.user_id === userId) return { extension, userId, changed: false };
        if (holder !== undefined) {
          throw new TelephonyError(
            'TELEPHONY_EXTENSION_TAKEN',
            `Extension ${extension} is ${nameOf(holder.user_id)}’s. Take it off them first.`,
          );
        }
        const theirs = await repo.assignmentOfUser(tx, context.orgId, userId);
        if (theirs !== undefined) {
          throw new TelephonyError(
            'TELEPHONY_EXTENSION_TAKEN',
            `${member.name} already has extension ${theirs.extension}. Take it off them first.`,
          );
        }
        const assignmentId = await repo.insertAssignment(tx, {
          orgId: context.orgId,
          connectionId: id,
          extension,
          userId,
          by: context.userId,
        });
        if (assignmentId === null) {
          throw new TelephonyError(
            'TELEPHONY_EXTENSION_TAKEN',
            'Someone else was just given that extension, or that person another one.',
          );
        }
        await this.audit.record(tx, {
          orgId: context.orgId,
          actorUserId: context.userId,
          operation: 'create',
          action: 'telephony.extension.assigned',
          entityType: 'telephony_extension',
          entityId: assignmentId,
          after: { connectionId: id, extension, userId },
          requestId: context.requestId,
          request,
        });
        return { extension, userId, changed: true };
      }),
    );
  }

  /** Take an extension off its person (D-846), audited with who had it. */
  async unassign(context: ActiveContext, request: AuditableRequest, id: string, extension: string) {
    return mapTelephonyErrors(() =>
      withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
        const holder = await repo.assignmentOfExtension(tx, context.orgId, id, extension);
        if (holder === undefined || !(await repo.deleteAssignment(tx, context.orgId, holder.id))) {
          throw new TelephonyError('TELEPHONY_NOT_FOUND', 'Nobody has that extension.');
        }
        await this.audit.record(tx, {
          orgId: context.orgId,
          actorUserId: context.userId,
          operation: 'delete',
          action: 'telephony.extension.unassigned',
          entityType: 'telephony_extension',
          entityId: holder.id,
          before: { connectionId: id, extension, userId: holder.user_id },
          requestId: context.requestId,
          request,
        });
        return { extension, userId: holder.user_id };
      }),
    );
  }

  /** Who has which extension, brand-wide: the Staff screen's column. */
  async assignments(context: ActiveContext) {
    return mapTelephonyErrors(() =>
      withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
        const [rows, connections] = await Promise.all([
          repo.assignmentsOf(tx, context.orgId),
          repo.connectionsOf(tx, context.orgId),
        ]);
        const names = new Map(connections.map((row) => [row.id, row.name]));
        return {
          items: rows.map((row) => ({
            userId: row.user_id,
            connectionId: row.connection_id,
            connectionName: names.get(row.connection_id) ?? '',
            extension: row.extension,
          })),
        };
      }),
    );
  }

  /** Envo's calls in progress on a connection, asked at most every five seconds. */
  private async liveCallsOf(id: string, envo: EnvoConnection): Promise<readonly EnvoLiveCall[]> {
    const cached = this.liveCache.get(id);
    if (cached !== undefined && Date.now() - cached.at < LIVE_CACHE_MS) return cached.value;
    const value = await this.gateway.liveCalls(envo);
    this.liveCache.set(id, { at: Date.now(), value });
    return value;
  }

  /**
   * Whether Envo shows a call from this mobile on this extension's own phone right now, ringing
   * or talking (the screen pop's word before Envo's `call.started` is applied, D-843); false when
   * Envo cannot be asked. Asked with no transaction open (invariant 6), cached five seconds.
   */
  async callFromOnPhone(
    row: repo.ConnectionRow,
    orgId: string,
    phoneE164: string,
    extension: string,
  ): Promise<boolean> {
    let calls: readonly EnvoLiveCall[];
    try {
      calls = await this.liveCallsOf(row.id, this.open(row, orgId, { requireEnabled: true }));
    } catch {
      return false;
    }
    return calls.some(
      (call) => customerPhoneFrom(call.from) === phoneE164 && liveCallOnPhoneOf(call, extension),
    );
  }

  /** The connection's calls in progress (`/calls/live`), each with the ERP's call when it has one. */
  async live(context: ActiveContext, id: string) {
    return mapTelephonyErrors(async () => {
      const { envo } = await this.credentials(context, id, { requireEnabled: false });
      let calls: readonly EnvoLiveCall[];
      try {
        calls = await this.liveCallsOf(id, envo);
      } catch (error) {
        throw envoFailure(error);
      }
      const known = await withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
        const names = await this.iam.nameBook(tx, context.orgId);
        const rows = await Promise.all(
          calls.map(async (call) => {
            const row = await repo.callByEnvoIdReadOnly(tx, context.orgId, id, call.id);
            return [call.id, row] as const;
          }),
        );
        return { names, rows: new Map(rows) };
      });
      return {
        items: calls.map((call) => {
          const row = known.rows.get(call.id);
          return {
            id: call.id,
            from: call.from,
            to: call.to,
            state: call.state,
            startedAt: call.startedAt,
            durationSec: call.durationSec,
            call:
              row === undefined
                ? null
                : {
                    id: row.id,
                    person:
                      row.user_id === null
                        ? null
                        : { id: row.user_id, name: known.names.get(row.user_id) ?? null },
                    customerName: row.customer_name,
                    orderNo: row.order_no,
                  },
          };
        }),
      };
    });
  }

  /** A supervisor ends a call in progress (Envo's `/calls/hangup`), audited after Envo agreed. */
  async hangup(context: ActiveContext, request: AuditableRequest, id: string, callId: string) {
    return mapTelephonyErrors(async () => {
      const { envo } = await this.credentials(context, id, { requireEnabled: false });
      let channels: number;
      try {
        channels = await this.gateway.hangup(envo, callId);
      } catch (error) {
        throw envoFailure(error);
      }
      this.liveCache.delete(id);
      await withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
        await this.audit.record(tx, {
          orgId: context.orgId,
          actorUserId: context.userId,
          operation: 'update',
          action: 'telephony.call.hung_up',
          entityType: 'telephony_connection',
          entityId: id,
          after: { envoCallId: callId, channels },
          requestId: context.requestId,
          request,
        });
      });
      return { envoCallId: callId, channels };
    });
  }
}
