import { randomUUID } from 'node:crypto';

import { Injectable } from '@nestjs/common';
import {
  PRINTER_MEDIUM_UM,
  defineAbilityFor,
  type PrinterCreateInput,
  type PrinterUpdateInput,
} from '@elysium/contracts';
import { withOrg, type Tx } from '@elysium/db';
import { printerShownState } from '@elysium/domain/packing';

import { AuditService } from '../../platform/audit/audit.service.js';
import type { AuditableRequest } from '../../platform/audit/audit.interceptor.js';
import { seal, sealedBoxConfigured } from '../../platform/crypto/sealed-box.js';
import type { ActiveContext } from '../../platform/http/context.js';
import { enqueue } from '../../platform/jobs/enqueue.js';
import * as repo from './labels.repository.js';
import { PACKING_QUEUES, type SendPrintPayload } from './packing.queues.js';
import { mapPackingErrors, PackingError } from './station.errors.js';

const iso = (value: Date | string | null): string | null =>
  value === null ? null : new Date(value).toISOString();

/** What a printer's sealed password is bound to: this brand, this printer's row, this field. */
export function printerPasswordBinding(orgId: string, printerId: string) {
  return { orgId, row: `printer:${printerId}`, field: 'password' } as const;
}

/** A printer's settings as the audit records them: never the password, its fingerprint only. */
function auditFacts(row: repo.PrinterRow | undefined) {
  if (row === undefined) return null;
  return {
    terminalId: row.terminal_id,
    name: row.name,
    connection: row.connection,
    language: row.language,
    host: row.host,
    port: row.port,
    medium: row.medium,
    dpi: row.dpi,
    documents: row.documents,
    enabled: row.enabled,
    sealedFingerprint: row.password_fingerprint,
  };
}

/** The paper in micrometres: a named medium's, or the custom size. */
function paperOf(input: PrinterCreateInput | PrinterUpdateInput): {
  width: number;
  height: number;
} {
  if (input.medium === 'custom') {
    return {
      width: Math.round((input.widthMm ?? 100) * 1000),
      height: Math.round((input.heightMm ?? 150) * 1000),
    };
  }
  return PRINTER_MEDIUM_UM[input.medium];
}

/**
 * Labels → Printers (M46, D-810, D-814): the brand's printers, each on a terminal. Supervisors
 * (`update PackingTerminal`) see the addresses and change them; warehouse sees names and states.
 * An IPPS printer's password is sealed with the brand's credentials key (the cameras' box,
 * D-669), bound to the printer's row, write-only and shown as a fingerprint. A printer whose
 * address moves to another host or port is asked for its password again.
 */
@Injectable()
export class PrintersService {
  constructor(private readonly audit: AuditService) {}

  async list(context: ActiveContext) {
    return withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
      const canEdit = defineAbilityFor(context).can('update', 'PackingTerminal');
      const [printers, devices] = await Promise.all([
        repo.printersOf(tx, context.orgId),
        repo.devicesOf(tx, context.orgId),
      ]);
      const seen = new Map<string, Date>();
      for (const device of devices) {
        if (device.last_seen_at === null) continue;
        const when = new Date(device.last_seen_at);
        const before = seen.get(device.terminal_id);
        if (before === undefined || when > before) seen.set(device.terminal_id, when);
      }
      return {
        canEdit,
        credentialsKey: sealedBoxConfigured(),
        printers: printers.map((row) =>
          this.present(row, canEdit, seen.get(row.terminal_id) ?? null),
        ),
      };
    });
  }

  async create(context: ActiveContext, request: AuditableRequest, input: PrinterCreateInput) {
    return mapPackingErrors(async () => {
      this.assertKeyFor(input.password);
      return withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
        await this.assertTerminal(tx, context.orgId, input.terminalId);
        const id = randomUUID();
        const paper = paperOf(input);
        const row = await repo.insertPrinter(tx, {
          id,
          orgId: context.orgId,
          terminalId: input.terminalId,
          name: input.name,
          connection: input.connection,
          language: input.language,
          host: input.host,
          port: input.connection === 'browser' ? null : (input.port ?? this.defaultPort(input)),
          ippPath: input.ippPath,
          dpi: input.dpi,
          medium: input.medium,
          widthUm: paper.width,
          heightUm: paper.height,
          documents: input.documents,
          copies: input.copies,
          username: input.username,
          enabled: input.enabled,
          userId: context.userId,
          password: this.sealed(context.orgId, id, input.password),
        });
        await this.audit.record(tx, {
          orgId: context.orgId,
          actorUserId: context.userId,
          operation: 'create',
          action: 'labels.printer_added',
          entityType: 'printer',
          entityId: row.id,
          after: auditFacts(row),
          request,
        });
        return this.present(row, true, null);
      });
    });
  }

  async update(
    context: ActiveContext,
    request: AuditableRequest,
    id: string,
    input: PrinterUpdateInput,
  ) {
    return mapPackingErrors(async () => {
      this.assertKeyFor(input.password);
      return withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
        const before = await repo.printerById(tx, context.orgId, id, { forUpdate: true });
        if (before?.deleted_at !== null) {
          throw new PackingError('NOT_FOUND', 'No such printer.');
        }
        await this.assertTerminal(tx, context.orgId, input.terminalId);
        const port =
          input.connection === 'browser' ? null : (input.port ?? this.defaultPort(input));
        // A stored password goes only where it went before (as a camera's, M38c W2).
        if (
          input.password === undefined &&
          before.password_fingerprint !== null &&
          (before.host !== input.host || before.port !== port || input.connection !== 'ipps')
        ) {
          throw new PackingError(
            'PRINTER_INVALID',
            'The printer’s address changed: enter its password again, or remove it.',
          );
        }
        const paper = paperOf(input);
        const after = await repo.updatePrinter(tx, {
          id,
          orgId: context.orgId,
          terminalId: input.terminalId,
          name: input.name,
          connection: input.connection,
          language: input.language,
          host: input.host,
          port,
          ippPath: input.ippPath,
          dpi: input.dpi,
          medium: input.medium,
          widthUm: paper.width,
          heightUm: paper.height,
          documents: input.documents,
          copies: input.copies,
          username: input.username,
          enabled: input.enabled,
          userId: context.userId,
          password:
            input.password === undefined
              ? undefined
              : this.sealed(context.orgId, id, input.password),
        });
        if (after === undefined) throw new PackingError('NOT_FOUND', 'No such printer.');
        // A browser station that becomes a network printer sends what waited for the station
        // (ledger audit N3); the other way, the station picks its waiting jobs up itself.
        if (before.connection === 'browser' && after.connection !== 'browser') {
          for (const job of await repo.queuedJobsOfPrinter(tx, context.orgId, id)) {
            const payload: SendPrintPayload = { jobId: job.id };
            await enqueue(tx, PACKING_QUEUES.send.name, payload, {
              orgId: context.orgId,
              ref: job.id,
            });
          }
        }
        await this.audit.record(tx, {
          orgId: context.orgId,
          actorUserId: context.userId,
          operation: 'update',
          action: 'labels.printer_updated',
          entityType: 'printer',
          entityId: id,
          before: auditFacts(before),
          after: auditFacts(after),
          request,
        });
        return this.present(after, true, null);
      });
    });
  }

  /** Delete a printer from use: switched off for good, its password wiped; its log stays. */
  async remove(context: ActiveContext, request: AuditableRequest, id: string) {
    return mapPackingErrors(() =>
      withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
        const before = await repo.printerById(tx, context.orgId, id, { forUpdate: true });
        if (before?.deleted_at !== null) {
          throw new PackingError('NOT_FOUND', 'No such printer.');
        }
        if (!(await repo.deletePrinter(tx, { orgId: context.orgId, id, userId: context.userId }))) {
          throw new PackingError('CONFLICT', 'This printer changed; try again.');
        }
        await this.audit.record(tx, {
          orgId: context.orgId,
          actorUserId: context.userId,
          operation: 'delete',
          action: 'labels.printer_deleted',
          entityType: 'printer',
          entityId: id,
          before: auditFacts(before),
          after: { deleted: true, enabled: false, sealedFingerprint: null },
          request,
        });
        return { id, deleted: true as const };
      }),
    );
  }

  private defaultPort(input: PrinterCreateInput | PrinterUpdateInput): number {
    return input.connection === 'raw' ? 9100 : 631;
  }

  private async assertTerminal(tx: Tx, orgId: string, terminalId: string): Promise<void> {
    const terminal = await repo.terminalById(tx, orgId, terminalId, { forShare: true });
    if (terminal === undefined) throw new PackingError('TERMINAL_NOT_FOUND', 'No such terminal.');
  }

  /** A password to keep needs the brand's credentials key; refused, never stored in the clear. */
  private assertKeyFor(password: string | null | undefined): void {
    if (typeof password === 'string' && !sealedBoxConfigured()) {
      throw new PackingError(
        'WEBSITE_CREDENTIALS_MISSING',
        'This server has no STOREFRONT_CREDENTIALS_KEY, so the printer’s password cannot be kept.',
      );
    }
  }

  private sealed(
    orgId: string,
    printerId: string,
    password: string | null | undefined,
  ): repo.SealedSecret | null {
    if (typeof password !== 'string') return null;
    const box = seal(password, printerPasswordBinding(orgId, printerId));
    return { sealed: box.ciphertext, fingerprint: box.fingerprint, keyId: box.keyId };
  }

  private present(row: repo.PrinterRow, canEdit: boolean, stationSeenAt: Date | null) {
    const base = {
      id: row.id,
      terminalId: row.terminal_id,
      name: row.name,
      connection: row.connection,
      language: row.language,
      medium: row.medium,
      widthMm: row.width_um / 1000,
      heightMm: row.height_um / 1000,
      dpi: row.dpi,
      documents: row.documents,
      copies: row.copies,
      enabled: row.enabled,
      state: printerShownState({
        connection: row.connection,
        enabled: row.enabled,
        status: row.status,
        statusAt: row.status_at === null ? null : new Date(row.status_at),
        stationSeenAt,
        now: new Date(),
      }),
      statusDetail: row.status_detail,
      statusAt: iso(row.status_at),
    };
    if (!canEdit) return base;
    return {
      ...base,
      host: row.host,
      port: row.port,
      ippPath: row.ipp_path,
      username: row.username,
      passwordSet: row.password_fingerprint !== null,
      passwordFingerprint: row.password_fingerprint,
      updatedAt: iso(row.updated_at),
    };
  }
}
