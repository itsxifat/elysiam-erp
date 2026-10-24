import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  defineAbilityFor,
  type LabelSettingsInput,
  type PrintJobsQuery,
  type PrintRequestInput,
  type ReadyForLabelQuery,
  type StationResultInput,
} from '@elysium/contracts';
import { withGlobal, withOrg, type Tx } from '@elysium/db';
import {
  PRINT_MAX_ATTEMPTS,
  PRINT_SENDING_STALE_MS,
  autoPrintOn,
  isReprint,
  pickTerminal,
  printSummary,
  printerOnline,
  printerShownState,
} from '@elysium/domain/packing';
import { sql } from 'drizzle-orm';

import { AuditService } from '../../platform/audit/audit.service.js';
import type { AuditableRequest } from '../../platform/audit/audit.interceptor.js';
import { open as openSealed } from '../../platform/crypto/sealed-box.js';
import { emit } from '../../platform/events/outbox.js';
import type { ActiveContext } from '../../platform/http/context.js';
import { enqueue } from '../../platform/jobs/enqueue.js';
import { GotenbergClient } from '../files/pdf/gotenberg.client.js';
import { IAM_API, type IamApi } from '../iam/iam.api.js';
import { ORDERS_API, type OrdersApi } from '../orders/orders.api.js';
import * as repo from './labels.repository.js';
import { PACKING_QUEUES, type AutoPrintPayload, type SendPrintPayload } from './packing.queues.js';
import { destinationRefusal } from './printers/destination.js';
import {
  ippGetPrinterAttributes,
  ippPrintJob,
  ippPrinterState,
  ippSucceeded,
  parseIppResponse,
} from './printers/ipp.js';
import { renderForPrinter, testPage, type PrintPage } from './printers/render.js';
import { PRINTER_TRANSPORT, PrinterIoError, type PrinterTransport } from './printers/transport.js';
import { printerPasswordBinding } from './printers.service.js';
import { mapPackingErrors, PackingError } from './station.errors.js';
import { TerminalsService } from './terminals.service.js';

const iso = (value: Date | string | null): string | null =>
  value === null ? null : new Date(value).toISOString();

const at = (value: Date | string | null): Date | null => (value === null ? null : new Date(value));

/** The order statuses a label or slip is printed at: still at the hub. */
const PRINTABLE_STATUSES: readonly string[] = ['confirmed', 'packed'];

type PrintedDocument = 'label' | 'packing_slip';

/** A refusal a person can act on, never a printer's raw reply. */
class PrintFailure extends Error {
  constructor(
    message: string,
    /** Retrying cannot help (the address is refused, the document is gone). */
    readonly final: boolean,
  ) {
    super(message);
    this.name = 'PrintFailure';
  }
}

/** The paper an order's slip is drawn on for a printer: A4 on A4 paper, otherwise A5. */
function slipPaperFor(printer: repo.PrinterRow): 'a4' | 'a5' {
  return printer.width_um >= 200_000 ? 'a4' : 'a5';
}

/** A short CSV cell: quoted, and never read as a formula by a spreadsheet. */
function csvCell(value: string | number | null): string {
  if (value === null) return '';
  const text = String(value);
  const safe = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

/**
 * The print queue (M46, D-813 to D-819): what is printed, where, by whom and why, and the log
 * of every print.
 *
 * A print is a row first (`packing.print_jobs`), written in the transaction that asks for it,
 * with its delivery queued in that same transaction: a pg-boss `labels.send` for a network
 * printer (the worker renders and sends it, no transaction open, invariant 6), or a
 * `labels.job_changed` event for a browser print station, which fetches and prints it and says
 * how it went. The auto-print rule runs as `labels.auto_print`, enqueued in the courier's booking
 * transaction (D-817). The log is the rows: nothing about a print is written anywhere else.
 */
@Injectable()
export class PrintingService {
  private readonly logger = new Logger(PrintingService.name);

  constructor(
    @Inject(ORDERS_API) private readonly orders: OrdersApi,
    @Inject(IAM_API) private readonly iam: IamApi,
    @Inject(PRINTER_TRANSPORT) private readonly transport: PrinterTransport,
    private readonly gotenberg: GotenbergClient,
    private readonly terminals: TerminalsService,
    private readonly audit: AuditService,
  ) {}

  // --- the brand's rule (D-817) -----------------------------------------------------------

  async settings(context: ActiveContext) {
    return withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
      const [row, printers] = await Promise.all([
        repo.labelSettingsOf(tx, context.orgId),
        repo.printersOf(tx, context.orgId),
      ]);
      const live = printers.filter((printer) => printer.enabled).length;
      return {
        autoPrint: autoPrintOn(row?.auto_print ?? null, live),
        /** The saved switch, or null: the ASSUMED default (on once a printer exists). */
        autoPrintSetting: row?.auto_print ?? null,
        autoSlip: row?.auto_slip ?? false,
        printers: live,
        canEdit: defineAbilityFor(context).can('update', 'PackingTerminal'),
        updatedAt: row === undefined ? null : iso(row.updated_at),
      };
    });
  }

  async saveSettings(context: ActiveContext, request: AuditableRequest, input: LabelSettingsInput) {
    return withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
      const before = await repo.labelSettingsOf(tx, context.orgId);
      const row = await repo.saveLabelSettings(tx, {
        orgId: context.orgId,
        autoPrint: input.autoPrint,
        autoSlip: input.autoSlip,
        userId: context.userId,
      });
      await this.audit.record(tx, {
        orgId: context.orgId,
        actorUserId: context.userId,
        operation: 'update',
        action: 'labels.settings_saved',
        entityType: 'label_settings',
        entityId: context.orgId,
        before: { autoPrint: before?.auto_print ?? null, autoSlip: before?.auto_slip ?? false },
        after: { autoPrint: row.auto_print, autoSlip: row.auto_slip },
        request,
      });
      return {
        autoPrint: row.auto_print ?? false,
        autoSlip: row.auto_slip,
        updatedAt: iso(row.updated_at),
      };
    });
  }

  // --- printing (D-818) -------------------------------------------------------------------

  /**
   * Print these orders' documents now: every lot, or the ones named. A document already printed
   * for an order and lot is a reprint and needs a reason; the whole request is refused, naming
   * them, rather than printing half of it. The printer is the one named, or the terminal's (the
   * one named, else the label terminal this computer is bound to), else the order's own
   * (the auto-print rule's choice).
   */
  async print(
    context: ActiveContext,
    request: AuditableRequest,
    input: PrintRequestInput,
    token: string | null,
  ) {
    return mapPackingErrors(() =>
      withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
        // A label desk prints on its own printers; a packing desk on its own when it has one for
        // the document (its slip printer), else where the order's labels print (D-802).
        const here = await this.terminals.resolve(tx, context, token, 'any');
        const ids = [...new Set(input.orderIds)];
        const visible = await this.orders.visibleOrderIds(tx, context.orgId, ids, request);
        if (ids.some((id) => !visible.has(id))) {
          throw new PackingError('NOT_FOUND', 'No such order.');
        }
        // One print of an order's pages at a time, in the lock order every path takes (the
        // order's row, then its lots; ledger audit W1, W3), so two presses of Print, or a print
        // beside the automatic one, see each other and the second needs a reason.
        for (const id of [...ids].sort()) await this.lockOrder(tx, context.orgId, id);
        const facts = await this.orders.packingFacts(tx, context.orgId, ids);
        for (const order of facts) {
          if (!PRINTABLE_STATUSES.includes(order.status)) {
            throw new PackingError(
              'PACKING_NOT_PACKABLE',
              `Order ${order.orderNo} is ${order.status}: its labels are printed while it is at the hub.`,
            );
          }
        }
        const [lots, printed, labelOrders, printers, terminals, openJobs] = await Promise.all([
          repo.lotCounts(tx, context.orgId, ids),
          repo.printedCounts(tx, context.orgId, ids, { pending: true }),
          repo.labelOrderOf(tx, context.orgId, ids),
          repo.printersOf(tx, context.orgId),
          repo.terminalsOf(tx, context.orgId),
          repo.openJobsByTerminal(tx, context.orgId),
        ]);
        const stationSeen = await this.stationsSeen(tx, context.orgId);

        interface Planned {
          order: (typeof facts)[number];
          document: PrintedDocument;
          lot: number;
          lotCount: number;
          printedBefore: number;
        }
        const planned: Planned[] = [];
        for (const order of facts) {
          const lotCount = lots.get(order.id) ?? 1;
          const chosen = input.lots ?? Array.from({ length: lotCount }, (_, index) => index + 1);
          for (const lot of chosen) {
            if (lot > lotCount) {
              throw new PackingError(
                'LOTS_LOCKED',
                `Order ${order.orderNo} is in ${String(lotCount)} ${lotCount === 1 ? 'lot' : 'lots'}: there is no lot ${String(lot)}.`,
              );
            }
            for (const document of input.documents) {
              planned.push({
                order,
                document,
                lot,
                lotCount,
                printedBefore: printed.get(`${order.id}:${document}:${String(lot)}`) ?? 0,
              });
            }
          }
        }
        const reprints = planned.filter((entry) => isReprint(entry.printedBefore));
        if (reprints.length > 0 && input.reason === undefined) {
          const first = reprints[0];
          throw new PackingError(
            'PRINT_REASON_REQUIRED',
            first === undefined
              ? 'Say why it is printed again.'
              : `Order ${first.order.orderNo}'s ${first.document === 'label' ? 'label' : 'slip'} was printed before. Say why it is printed again.`,
          );
        }

        const jobs: repo.JobRow[] = [];
        for (const entry of planned) {
          const printer = this.choosePrinter({
            printers,
            terminals,
            openJobs,
            stationSeen,
            document: entry.document,
            printerId: input.printerId,
            terminalId:
              input.terminalId ??
              (here === null
                ? undefined
                : here.terminal.kind === 'label' ||
                    printers.some(
                      (printer) =>
                        printer.terminal_id === here.terminal.id &&
                        printer.enabled &&
                        printer.documents.includes(entry.document),
                    )
                  ? here.terminal.id
                  : undefined),
            locationId: entry.order.locationId,
          });
          const job = await repo.insertJob(tx, {
            orgId: context.orgId,
            orderId: entry.order.id,
            orderNo: entry.order.orderNo,
            document: entry.document,
            lotNo: entry.lot,
            lotCount: entry.lotCount,
            printerId: printer.id,
            terminalId: printer.terminal_id,
            source: isReprint(entry.printedBefore) ? 'reprint' : 'manual',
            reason: isReprint(entry.printedBefore) ? (input.reason ?? null) : null,
            requestedBy: context.userId,
            copies: input.copies ?? printer.copies,
            consignmentNo:
              labelOrders.get(entry.order.id)?.consignmentNo ??
              entry.order.parcel?.consignmentNo ??
              null,
            autoKey: null,
          });
          if (job === undefined) throw new Error('a print job was not written');
          openJobs.set(printer.terminal_id, (openJobs.get(printer.terminal_id) ?? 0) + 1);
          await this.dispatch(tx, context.orgId, job, printer);
          jobs.push(job);
        }
        await this.audit.record(tx, {
          orgId: context.orgId,
          actorUserId: context.userId,
          operation: 'create',
          action: reprints.length > 0 ? 'labels.reprint_requested' : 'labels.print_requested',
          entityType: 'print_job',
          entityId: jobs[0]?.id ?? context.orgId,
          after: {
            jobs: jobs.map((job) => ({
              id: job.id,
              orderId: job.order_id,
              document: job.document,
              lot: job.lot_no,
              printerId: job.printer_id,
              source: job.source,
            })),
            reason: input.reason ?? null,
            terminalId: here?.terminal.id ?? null,
          },
          request,
        });
        return { jobs: jobs.map((job) => this.presentJob(job, new Map(), printers, terminals)) };
      }),
    );
  }

  /** A test page on one printer (D-815): `update PackingTerminal`. */
  async testPrint(context: ActiveContext, request: AuditableRequest, printerId: string) {
    return mapPackingErrors(() =>
      withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
        const printer = await repo.printerById(tx, context.orgId, printerId);
        if (printer?.deleted_at !== null) {
          throw new PackingError('NOT_FOUND', 'No such printer.');
        }
        const job = await repo.insertJob(tx, {
          orgId: context.orgId,
          orderId: null,
          orderNo: '',
          document: 'test',
          lotNo: 1,
          lotCount: 1,
          printerId: printer.id,
          terminalId: printer.terminal_id,
          source: 'test',
          reason: null,
          requestedBy: context.userId,
          copies: 1,
          consignmentNo: null,
          autoKey: null,
        });
        if (job === undefined) throw new Error('a test print was not written');
        await this.dispatch(tx, context.orgId, job, printer);
        await this.audit.record(tx, {
          orgId: context.orgId,
          actorUserId: context.userId,
          operation: 'create',
          action: 'labels.test_print_requested',
          entityType: 'print_job',
          entityId: job.id,
          after: { printerId: printer.id },
          request,
        });
        return { jobId: job.id, state: job.state };
      }),
    );
  }

  async retry(context: ActiveContext, request: AuditableRequest, jobId: string) {
    return mapPackingErrors(() =>
      withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
        const job = await this.jobInScope(tx, context, request, jobId, true);
        const printer = await repo.printerById(tx, context.orgId, job.printer_id);
        if (printer?.deleted_at !== null || !printer.enabled) {
          throw new PackingError(
            'PRINT_NO_PRINTER',
            'That printer is no longer in use. Print it again elsewhere.',
          );
        }
        const queued = await repo.requeueFailed(tx, context.orgId, jobId);
        if (queued === undefined) {
          throw new PackingError('PRINT_JOB_STATE', 'Only a failed print can be tried again.');
        }
        await this.dispatch(tx, context.orgId, queued, printer);
        await this.audit.record(tx, {
          orgId: context.orgId,
          actorUserId: context.userId,
          operation: 'update',
          action: 'labels.job_retried',
          entityType: 'print_job',
          entityId: jobId,
          before: { state: job.state, attempts: job.attempts },
          after: { state: 'queued' },
          request,
        });
        return { id: jobId, state: queued.state };
      }),
    );
  }

  async cancel(context: ActiveContext, request: AuditableRequest, jobId: string) {
    return mapPackingErrors(() =>
      withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
        const job = await this.jobInScope(tx, context, request, jobId, true);
        const cancelled = await repo.cancelJob(
          tx,
          context.orgId,
          jobId,
          new Date(Date.now() - PRINT_SENDING_STALE_MS),
        );
        if (cancelled === undefined) {
          throw new PackingError(
            'PRINT_JOB_STATE',
            'Only a waiting or failed print can be cancelled.',
          );
        }
        await this.changed(tx, context.orgId, cancelled, null);
        await this.audit.record(tx, {
          orgId: context.orgId,
          actorUserId: context.userId,
          operation: 'update',
          action: 'labels.job_cancelled',
          entityType: 'print_job',
          entityId: jobId,
          before: { state: job.state },
          after: { state: 'cancelled' },
          request,
        });
        return { id: jobId, state: cancelled.state };
      }),
    );
  }

  // --- the queue and the log (D-818) ------------------------------------------------------

  async jobs(
    context: ActiveContext,
    request: object,
    query: PrintJobsQuery,
    before?: { readonly createdAt: string; readonly id: string },
  ) {
    return withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
      const page = await repo.jobsPage(tx, context.orgId, {
        ...query,
        before,
        orderInScope: this.orders.orderInScopeSql(context.orgId, sql`j.order_id`, request),
        testPages: defineAbilityFor(context).can('read', 'PackingTerminal'),
      });
      const [names, printers, terminals] = await Promise.all([
        this.names(tx, context.orgId),
        repo.printersOf(tx, context.orgId),
        repo.terminalsOf(tx, context.orgId),
      ]);
      // A deleted printer still names its old jobs.
      const missing = [...new Set(page.rows.map((row) => row.printer_id))].filter(
        (id) => !printers.some((printer) => printer.id === id),
      );
      for (const id of missing) {
        const old = await repo.printerById(tx, context.orgId, id);
        if (old !== undefined) printers.push(old);
      }
      return {
        total: page.total,
        items: page.rows.map((row) => this.presentJob(row, names, printers, terminals)),
      };
    });
  }

  /** The log as CSV (D-818): the same filter, at most ten thousand rows, newest first. */
  async exportCsv(context: ActiveContext, request: object, query: PrintJobsQuery) {
    const rows: string[] = [
      [
        'created_at',
        'order_no',
        'document',
        'lot',
        'lots',
        'printer',
        'terminal',
        'source',
        'requested_by',
        'reason',
        'copies',
        'state',
        'attempts',
        'printed_at',
        'error',
      ].join(','),
    ];
    let before: { createdAt: string; id: string } | undefined;
    for (let read = 0; read < 10_000; read += 200) {
      const page = await this.jobs(context, request, { ...query, limit: 200, offset: 0 }, before);
      const lastItem = page.items.at(-1);
      before =
        lastItem === undefined ? undefined : { createdAt: lastItem.createdAt, id: lastItem.id };
      for (const item of page.items) {
        rows.push(
          [
            item.createdAt,
            item.orderNo,
            item.document,
            item.lot,
            item.lotCount,
            item.printer.name,
            item.terminal.name,
            item.source,
            item.requestedBy?.name ?? (item.source === 'auto' ? 'auto' : ''),
            item.reason,
            item.copies,
            item.state,
            item.attempts,
            item.printedAt,
            item.lastError,
          ]
            .map((cell) => csvCell(cell))
            .join(','),
        );
      }
      if (page.items.length < 200) break;
    }
    return `${rows.join('\r\n')}\r\n`;
  }

  /**
   * Orders with a consignment and a lot whose label has not printed, inside the caller's scope,
   * at their location (or every location), oldest booking first (D-817). Confirmed orders only.
   */
  async ready(context: ActiveContext, request: object, query: ReadyForLabelQuery) {
    return withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
      const rows = await repo.labelOrdersReady(tx, context.orgId, {
        locationId: query.locationId,
        limit: query.limit,
        orderInScope: this.orders.orderInScopeSql(context.orgId, sql`lo.order_id`, request),
      });
      const ids = rows.map((row) => row.order_id);
      const [facts, printed] = await Promise.all([
        this.orders.packingFacts(tx, context.orgId, ids),
        repo.printedCounts(tx, context.orgId, ids),
      ]);
      const factOf = new Map(facts.map((fact) => [fact.id, fact]));
      return {
        items: rows.flatMap((row) => {
          const order = factOf.get(row.order_id);
          if (order?.status !== 'confirmed') return [];
          return [
            {
              orderId: row.order_id,
              orderNo: order.orderNo,
              consignmentNo: row.consignment_no,
              courier: order.parcel?.courierName ?? null,
              customer: order.recipient.name,
              locationId: order.locationId,
              bookedAt: iso(row.booked_at),
              lotCount: row.lot_count,
              labelsPrinted: row.labels_printed,
              pieces: order.lines.reduce((sum, line) => sum + line.qty, 0),
              codPoisha: order.codAmountPoisha.toString(),
              lots: Array.from({ length: row.lot_count }, (_, index) => ({
                lot: index + 1,
                label: printed.get(`${row.order_id}:label:${String(index + 1)}`) ?? 0,
                slip: printed.get(`${row.order_id}:packing_slip:${String(index + 1)}`) ?? 0,
              })),
            },
          ];
        }),
      };
    });
  }

  /**
   * One order's prints (D-818): each lot's label and slip, how many times and the newest, and
   * the whole history. "Printed 3 times, last 17 Oct 14:02 by Rahim at Label 1."
   */
  async orderPrints(context: ActiveContext, request: object, orderId: string) {
    return mapPackingErrors(() =>
      withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
        if (!(await this.orders.orderVisibleTo(tx, context.orgId, orderId, request))) {
          throw new PackingError('NOT_FOUND', 'No such order.');
        }
        const [jobs, lotCount, names, printers, terminals, handover] = await Promise.all([
          repo.jobsOfOrders(tx, context.orgId, [orderId]),
          repo.lotCountOf(tx, context.orgId, orderId),
          this.names(tx, context.orgId),
          repo.printersOf(tx, context.orgId),
          repo.terminalsOf(tx, context.orgId),
          repo.handoverScansOf(tx, context.orgId, [orderId]),
        ]);
        const terminalName = new Map(terminals.map((terminal) => [terminal.id, terminal.name]));
        const summaryOf = (document: PrintedDocument, lot: number) => {
          const summary = printSummary(
            jobs
              // Pages printed for another lot count are history, not this lot's page (D-805).
              .filter(
                (job) =>
                  job.document === document && job.lot_no === lot && job.lot_count === lotCount,
              )
              .map((job) => ({
                state: job.state,
                at: new Date(job.printed_at ?? job.created_at),
                byName: job.requested_by === null ? null : (names.get(job.requested_by) ?? null),
                auto: job.source === 'auto',
                terminalName: terminalName.get(job.terminal_id) ?? null,
              })),
          );
          return {
            count: summary.count,
            last:
              summary.last === null
                ? null
                : {
                    at: summary.last.at.toISOString(),
                    by: summary.last.auto ? null : summary.last.byName,
                    auto: summary.last.auto,
                    terminal: summary.last.terminalName,
                  },
          };
        };
        return {
          orderId,
          lotCount,
          lots: Array.from({ length: lotCount }, (_, index) => ({
            lot: index + 1,
            label: summaryOf('label', index + 1),
            slip: summaryOf('packing_slip', index + 1),
            handedAt: iso(handover.find((scan) => scan.lot_no === index + 1)?.scanned_at ?? null),
          })),
          history: [...jobs]
            .reverse()
            .map((job) => this.presentJob(job, names, printers, terminals)),
        };
      }),
    );
  }

  // --- the auto-print rule (D-817), in the worker ----------------------------------------

  /** An order got its consignment: print each lot's label (and slip) on its label terminal. */
  async autoPrint(orgId: string, payload: AutoPrintPayload): Promise<void> {
    await withOrg({ orgId }, async (tx) => {
      await this.lockOrder(tx, orgId, payload.orderId);
      const [facts] = await this.orders.packingFacts(tx, orgId, [payload.orderId]);
      if (facts === undefined) return;
      await repo.fillLabelOrder(tx, {
        orgId,
        orderId: facts.id,
        orderNo: facts.orderNo,
        locationId: facts.locationId,
      });
      if (facts.status !== 'confirmed') return;
      const [settings, printers, terminals, openJobs, lotCount, already] = await Promise.all([
        repo.labelSettingsOf(tx, orgId),
        repo.printersOf(tx, orgId),
        repo.terminalsOf(tx, orgId),
        repo.openJobsByTerminal(tx, orgId),
        repo.lotCountOf(tx, orgId, facts.id),
        repo.printedCounts(tx, orgId, [facts.id], { pending: true }),
      ]);
      const live = printers.filter((printer) => printer.enabled);
      if (!autoPrintOn(settings?.auto_print ?? null, live.length)) return;
      const stationSeen = await this.stationsSeen(tx, orgId);
      const documents: PrintedDocument[] =
        settings?.auto_slip === true ? ['label', 'packing_slip'] : ['label'];
      let printerFor: repo.PrinterRow | undefined;
      try {
        printerFor = this.choosePrinter({
          printers,
          terminals,
          openJobs,
          stationSeen,
          document: 'label',
          printerId: undefined,
          terminalId: undefined,
          locationId: facts.locationId,
        });
      } catch {
        this.logger.warn(`auto-print: no label printer for an order of org ${orgId}`);
        return;
      }
      for (let lot = 1; lot <= lotCount; lot += 1) {
        for (const document of documents) {
          // The slip on the same terminal's slip printer, when it has one; else not at all.
          const printer =
            document === 'label'
              ? printerFor
              : live.find(
                  (candidate) =>
                    candidate.terminal_id === printerFor?.terminal_id &&
                    candidate.documents.includes('packing_slip'),
                );
          if (printer === undefined) continue;
          // Printed by hand already (or on its way): the rule does not print it again.
          if ((already.get(`${facts.id}:${document}:${String(lot)}`) ?? 0) > 0) continue;
          const job = await repo.insertJob(tx, {
            orgId,
            orderId: facts.id,
            orderNo: facts.orderNo,
            document,
            lotNo: lot,
            lotCount,
            printerId: printer.id,
            terminalId: printer.terminal_id,
            source: 'auto',
            reason: null,
            requestedBy: null,
            copies: printer.copies,
            consignmentNo: payload.consignmentNo,
            autoKey: `auto:${facts.id}:${payload.consignmentNo}:${document}:${String(lot)}`,
          });
          // Already queued by an earlier delivery of this job (its key): nothing more to do.
          if (job === undefined) continue;
          await this.dispatch(tx, orgId, job, printer);
          await this.audit.record(tx, {
            orgId,
            actorUserId: null,
            operation: 'create',
            action: 'labels.auto_print_queued',
            entityType: 'print_job',
            entityId: job.id,
            after: {
              orderId: facts.id,
              document,
              lot,
              lotCount,
              printerId: printer.id,
              terminalId: printer.terminal_id,
            },
          });
        }
      }
    });
  }

  // --- sending to a network printer (D-813), in the worker -------------------------------

  /**
   * Send one job: marked sending in its own short transaction, rendered and sent with none
   * open, then marked printed, or failed when the tries are spent. A failed try with tries left
   * goes back to queued and throws, so pg-boss sends it again after its delay.
   */
  async send(orgId: string, payload: SendPrintPayload): Promise<void> {
    const prepared = await withOrg({ orgId }, async (tx) => {
      const waiting = await repo.jobById(tx, orgId, payload.jobId);
      if (waiting === undefined) return null;
      const current = await repo.printerById(tx, orgId, waiting.printer_id);
      if (current?.connection === 'browser') return null;
      const job = await repo.markSending(tx, {
        orgId,
        id: payload.jobId,
        staleBefore: new Date(Date.now() - PRINT_SENDING_STALE_MS),
      });
      if (job === undefined) return null;
      const printer = await repo.printerById(tx, orgId, job.printer_id);
      const terminal = await repo.terminalById(tx, orgId, job.terminal_id);
      const sealed = await repo.printerSecret(tx, orgId, job.printer_id);
      return { job, printer, terminal, sealed };
    });
    if (prepared === null) return;
    const { job, printer, terminal } = prepared;

    let error: PrintFailure | null = null;
    try {
      if (printer?.deleted_at !== null || !printer.enabled) {
        throw new PrintFailure('The printer is switched off or deleted.', true);
      }
      if (printer.connection === 'browser' || printer.host === null) {
        throw new PrintFailure('A browser print station prints its own jobs.', true);
      }
      const refusal = destinationRefusal(printer.host);
      if (refusal !== null) throw new PrintFailure(refusal, true);
      const page = await this.pageFor(orgId, job, printer, terminal?.name ?? '');
      const rendered = await renderForPrinter(this.gotenberg, page, {
        language: printer.language,
        widthUm: printer.width_um,
        heightUm: printer.height_um,
        dpi: printer.dpi,
        copies: job.copies,
      });
      if (printer.connection === 'raw') {
        await this.transport.sendRaw(printer.host, printer.port ?? 9100, rendered.bytes, 30_000);
      } else {
        const port = printer.port ?? 631;
        const scheme = printer.connection === 'ipps' ? 'ipps' : 'ipp';
        const body = ippPrintJob(
          {
            printerUri: `${scheme}://${printer.host}:${String(port)}${printer.ipp_path}`,
            user: 'erp',
            jobName:
              job.document === 'test'
                ? 'Test print'
                : `${job.order_no} ${job.document === 'label' ? 'label' : 'slip'} ${String(job.lot_no)}/${String(job.lot_count)}`,
            copies: job.copies,
          },
          rendered.bytes,
        );
        const auth =
          prepared.sealed === null || printer.username === ''
            ? null
            : {
                user: printer.username,
                password: openSealed(
                  Buffer.from(prepared.sealed),
                  printerPasswordBinding(orgId, printer.id),
                ),
              };
        const answer = parseIppResponse(
          await this.transport.ipp(
            {
              tls: printer.connection === 'ipps',
              host: printer.host,
              port,
              path: printer.ipp_path,
            },
            body,
            auth,
            60_000,
          ),
        );
        if (!ippSucceeded(answer.statusCode)) {
          throw new PrintFailure(
            `The printer refused the job (IPP status 0x${answer.statusCode.toString(16).padStart(4, '0')}).`,
            answer.statusCode >= 0x0400 && answer.statusCode < 0x0500,
          );
        }
      }
    } catch (caught) {
      error =
        caught instanceof PrintFailure
          ? caught
          : caught instanceof PrinterIoError
            ? new PrintFailure(caught.message, false)
            : new PrintFailure(
                'The page could not be made ready for the printer. Try again; if it fails again, tell the supervisor.',
                false,
              );
      if (!(caught instanceof PrintFailure) && !(caught instanceof PrinterIoError)) {
        this.logger.warn(
          `print job ${job.id} failed: ${caught instanceof Error ? caught.message : String(caught)}`,
        );
      }
    }

    const final = error !== null && (error.final || job.attempts >= PRINT_MAX_ATTEMPTS);
    await withOrg({ orgId }, async (tx) => {
      if (error === null) {
        const done = await repo.markPrinted(tx, { orgId, id: job.id });
        if (done !== undefined) await this.printed(tx, orgId, done, null);
        return;
      }
      const failed = await repo.markAttemptFailed(tx, {
        orgId,
        id: job.id,
        error: error.message,
        final,
      });
      if (failed !== undefined && final) await this.failed(tx, orgId, failed, null);
    });
    // Tries left: pg-boss sends it again after its delay (the row is queued again).
    if (error !== null && !final) throw new Error(`print job ${job.id}: ${error.message}`);
  }

  /** Every enabled network printer, asked how it is (D-815). */
  async probeAll(): Promise<void> {
    const orgIds = await withGlobal(async (tx) =>
      (
        await tx.execute<{ id: string }>(
          sql`select id from org.organizations where is_active order by slug`,
        )
      ).map((row) => row.id),
    );
    for (const orgId of orgIds) {
      const printers = await withOrg({ orgId }, (tx) => repo.printersOf(tx, orgId));
      for (const printer of printers) {
        if (!printer.enabled || printer.connection === 'browser' || printer.host === null) continue;
        let status: 'online' | 'offline' | 'error' = 'offline';
        let detail: string | null = null;
        const refusal = destinationRefusal(printer.host);
        if (refusal !== null) {
          status = 'error';
          detail = 'address refused';
        } else if (printer.connection === 'raw') {
          status = (await this.transport.probeRaw(printer.host, printer.port ?? 9100, 3_000))
            ? 'online'
            : 'offline';
        } else {
          try {
            const port = printer.port ?? 631;
            const scheme = printer.connection === 'ipps' ? 'ipps' : 'ipp';
            const answer = parseIppResponse(
              await this.transport.ipp(
                {
                  tls: printer.connection === 'ipps',
                  host: printer.host,
                  port,
                  path: printer.ipp_path,
                },
                ippGetPrinterAttributes({
                  printerUri: `${scheme}://${printer.host}:${String(port)}${printer.ipp_path}`,
                  user: 'erp',
                }),
                null,
                3_000,
              ),
            );
            const read = ippPrinterState(answer);
            status = read.state;
            detail = read.detail;
            const formats = (answer.attributes.get('document-format-supported') ?? []).map(String);
            if (formats.length > 0 && !formats.includes('application/pdf')) {
              status = 'error';
              detail = 'this printer does not take PDF';
            }
          } catch {
            status = 'offline';
          }
        }
        await withOrg({ orgId }, (tx) =>
          repo.reportPrinterStatus(tx, { orgId, id: printer.id, status, detail }),
        );
      }
    }
  }

  // --- the browser print station (D-816) -------------------------------------------------

  /** The station's queue: its terminal's waiting jobs on its browser printers. */
  async stationJobs(context: ActiveContext, request: object, token: string | null) {
    return mapPackingErrors(() =>
      withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
        const here = await this.atLabelTerminal(tx, context, token);
        const jobs = await repo.stationJobs(
          tx,
          context.orgId,
          here.terminal.id,
          // Another computer's job being sent is its own to finish (D-826 W2): listing it here
          // made this station ask for it again and again (D-900's review).
          here.deviceId,
          this.orders.orderInScopeSql(context.orgId, sql`j.order_id`, request),
        );
        const printers = await repo.printersOf(tx, context.orgId);
        const terminals = await repo.terminalsOf(tx, context.orgId);
        return {
          terminal: { id: here.terminal.id, name: here.terminal.name },
          items: jobs.map((job) => this.presentJob(job, new Map(), printers, terminals)),
        };
      }),
    );
  }

  /** One job's PDF for the station to print: the job is then being sent. */
  async stationDocument(
    context: ActiveContext,
    request: object,
    token: string | null,
    jobId: string,
  ) {
    return mapPackingErrors(async () => {
      const prepared = await withOrg(
        { orgId: context.orgId, userId: context.userId },
        async (tx) => {
          const here = await this.atLabelTerminal(tx, context, token);
          const job = await this.jobInScope(tx, context, request, jobId, true);
          if (job.terminal_id !== here.terminal.id) {
            throw new PackingError('NOT_FOUND', 'No such print job at this terminal.');
          }
          const printer = await repo.printerById(tx, context.orgId, job.printer_id);
          if (printer?.connection !== 'browser') {
            throw new PackingError('NOT_FOUND', 'No such print job at this terminal.');
          }
          // Claimed for this computer: queued, or its own claim again after a reload (W2, W3).
          const sending = await repo.claimForStation(tx, {
            orgId: context.orgId,
            id: jobId,
            deviceId: here.deviceId,
          });
          if (sending === undefined) {
            throw new PackingError('PRINT_JOB_STATE', 'This print is finished or cancelled.');
          }
          return { job: sending, printer, terminal: here.terminal };
        },
      );
      // Rendered after the transaction (invariant 6: Gotenberg is a call).
      const page = await this.pageFor(
        context.orgId,
        prepared.job,
        prepared.printer,
        prepared.terminal.name,
      );
      const rendered = await renderForPrinter(this.gotenberg, page, {
        language: 'pdf',
        widthUm: prepared.printer.width_um,
        heightUm: prepared.printer.height_um,
        dpi: prepared.printer.dpi,
        copies: 1,
      });
      return {
        bytes: rendered.bytes,
        filename: `${prepared.job.order_no === '' ? 'test' : prepared.job.order_no}-${prepared.job.document}-${String(prepared.job.lot_no)}.pdf`,
        copies: prepared.job.copies,
      };
    });
  }

  /** The station says how it went: printed, or failed (and the label team is told). */
  async stationResult(
    context: ActiveContext,
    request: AuditableRequest,
    token: string | null,
    jobId: string,
    input: StationResultInput,
  ) {
    return mapPackingErrors(() =>
      withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
        const here = await this.atLabelTerminal(tx, context, token);
        const job = await this.jobInScope(tx, context, request, jobId, true);
        const printer = await repo.printerById(tx, context.orgId, job.printer_id);
        // Only a browser printer's job, and only the one this computer claimed (W2).
        if (job.terminal_id !== here.terminal.id || printer?.connection !== 'browser') {
          throw new PackingError('NOT_FOUND', 'No such print job at this terminal.');
        }
        if (job.state === 'printed' && input.result === 'printed') {
          return { id: jobId, state: job.state, repeated: true };
        }
        const done =
          input.result === 'printed'
            ? await repo.markPrinted(tx, {
                orgId: context.orgId,
                id: jobId,
                deviceId: here.deviceId,
                confirmedBy: context.userId,
              })
            : await repo.markAttemptFailed(tx, {
                orgId: context.orgId,
                id: jobId,
                error: input.error ?? 'The print station could not print it.',
                final: true,
                deviceId: here.deviceId,
                confirmedBy: context.userId,
              });
        if (done === undefined) {
          throw new PackingError('PRINT_JOB_STATE', 'This print is finished or cancelled.');
        }
        if (input.result === 'printed') await this.printed(tx, context.orgId, done, context.userId);
        else await this.failed(tx, context.orgId, done, context.userId);
        await this.audit.record(tx, {
          orgId: context.orgId,
          actorUserId: context.userId,
          operation: 'update',
          action: input.result === 'printed' ? 'labels.station_printed' : 'labels.station_failed',
          entityType: 'print_job',
          entityId: jobId,
          before: { state: job.state },
          after: { state: done.state, deviceId: here.deviceId },
          request,
        });
        return { id: jobId, state: done.state, repeated: false };
      }),
    );
  }

  // --- the parts ---------------------------------------------------------------------------

  /** The order's row, then its lots: the lock order every lots and print path takes (W1). */
  private async lockOrder(tx: Tx, orgId: string, orderId: string): Promise<void> {
    await this.orders.bookingSnapshot(tx, orgId, orderId, { forUpdate: true });
    await repo.lockOrderLots(tx, orgId, orderId);
  }

  private async atLabelTerminal(tx: Tx, context: ActiveContext, token: string | null) {
    const here = await this.terminals.resolve(tx, context, token, 'label');
    if (here === null) {
      throw new PackingError(
        'TERMINAL_DEVICE_INVALID',
        'This computer is not bound to a label terminal. A supervisor binds it on the Terminals tab.',
      );
    }
    return here;
  }

  /** The page a job prints: its order's slip or label for its lot, or a test page. */
  private async pageFor(
    orgId: string,
    job: repo.JobRow,
    printer: repo.PrinterRow,
    terminalName: string,
  ): Promise<PrintPage> {
    if (job.document === 'test' || job.order_id === null) {
      return testPage({
        printerName: printer.name,
        terminalName,
        widthUm: printer.width_um,
        heightUm: printer.height_um,
        dpi: printer.dpi,
        at: new Date().toLocaleString('en-GB', { timeZone: 'Asia/Dhaka' }),
      });
    }
    try {
      return await this.orders.documentForPrint({
        orgId,
        orderId: job.order_id,
        kind: job.document,
        lot: job.lot_count > 1 ? { no: job.lot_no, count: job.lot_count } : null,
        paper: slipPaperFor(printer),
      });
    } catch (error) {
      if ((error as { status?: unknown }).status === 404) {
        throw new PrintFailure('The order is gone.', true);
      }
      throw error;
    }
  }

  /**
   * The printer a document prints on: the one named (it must print that document), else the
   * named terminal's, else the order's label terminal — the online one with the shortest queue
   * among the active label terminals at its location or serving every location (D-817).
   */
  private choosePrinter(input: {
    readonly printers: readonly repo.PrinterRow[];
    readonly terminals: readonly repo.TerminalRow[];
    readonly openJobs: ReadonlyMap<string, number>;
    readonly stationSeen: ReadonlyMap<string, Date>;
    readonly document: PrintedDocument;
    readonly printerId: string | undefined;
    readonly terminalId: string | undefined;
    readonly locationId: string | null;
  }): repo.PrinterRow {
    const now = new Date();
    const active = new Map(
      input.terminals
        .filter((terminal) => terminal.active)
        .map((terminal) => [terminal.id, terminal]),
    );
    const usable = input.printers.filter(
      (printer) =>
        printer.enabled &&
        printer.deleted_at === null &&
        active.has(printer.terminal_id) &&
        printer.documents.includes(input.document),
    );
    const online = (printer: repo.PrinterRow) =>
      printerOnline({
        connection: printer.connection,
        enabled: printer.enabled,
        status: printer.status,
        statusAt: at(printer.status_at),
        stationSeenAt: input.stationSeen.get(printer.terminal_id) ?? null,
        now,
      });
    if (input.printerId !== undefined) {
      const named = usable.find((printer) => printer.id === input.printerId);
      if (named === undefined) {
        throw new PackingError(
          'PRINT_NO_PRINTER',
          `That printer does not print ${input.document === 'label' ? 'labels' : 'slips'}, or is switched off.`,
        );
      }
      return named;
    }
    const pickFrom = (printers: readonly repo.PrinterRow[]) => printers.find(online) ?? printers[0];
    if (input.terminalId !== undefined) {
      const at = usable.filter((printer) => printer.terminal_id === input.terminalId);
      const chosen = pickFrom(at);
      if (chosen === undefined) {
        throw new PackingError(
          'PRINT_NO_PRINTER',
          `This terminal has no printer for ${input.document === 'label' ? 'labels' : 'slips'}. Add one on the Printers tab.`,
        );
      }
      return chosen;
    }
    const candidates = [...active.values()]
      .filter(
        (terminal) =>
          terminal.kind === 'label' &&
          (terminal.location_id === null || terminal.location_id === input.locationId) &&
          usable.some((printer) => printer.terminal_id === terminal.id),
      )
      .map((terminal) => ({
        id: terminal.id,
        name: terminal.name,
        online: usable.some((printer) => printer.terminal_id === terminal.id && online(printer)),
        queued: input.openJobs.get(terminal.id) ?? 0,
      }));
    const terminal = pickTerminal(candidates);
    const chosen =
      terminal === null
        ? undefined
        : pickFrom(usable.filter((printer) => printer.terminal_id === terminal.id));
    if (chosen === undefined) {
      throw new PackingError(
        'PRINT_NO_PRINTER',
        `No label terminal at this order's location has a printer for ${input.document === 'label' ? 'labels' : 'slips'}.`,
      );
    }
    return chosen;
  }

  /** When each terminal's browser last checked in: a browser printer is online while it does. */
  private async stationsSeen(tx: Tx, orgId: string): Promise<Map<string, Date>> {
    const seen = new Map<string, Date>();
    for (const device of await repo.devicesOf(tx, orgId)) {
      if (device.last_seen_at === null) continue;
      const when = new Date(device.last_seen_at);
      const before = seen.get(device.terminal_id);
      if (before === undefined || when > before) seen.set(device.terminal_id, when);
    }
    return seen;
  }

  /** Hand a queued job to its printer, in the caller's transaction (invariant 6). */
  private async dispatch(
    tx: Tx,
    orgId: string,
    job: repo.JobRow,
    printer: repo.PrinterRow,
  ): Promise<void> {
    if (printer.connection !== 'browser') {
      const payload: SendPrintPayload = { jobId: job.id };
      await enqueue(tx, PACKING_QUEUES.send.name, payload, { orgId, ref: job.id });
    }
    await this.changed(tx, orgId, job, null);
  }

  private async changed(
    tx: Tx,
    orgId: string,
    job: repo.JobRow,
    reason: string | null,
  ): Promise<void> {
    await emit(
      tx,
      'labels.job_changed',
      {
        jobId: job.id,
        terminalId: job.terminal_id,
        printerId: job.printer_id,
        state: job.state,
        reason: reason?.slice(0, 200) ?? null,
      },
      { orgId },
    );
  }

  /** A job printed: the order moves on at the hub (D-819), the team hears it, the log says so. */
  private async printed(
    tx: Tx,
    orgId: string,
    job: repo.JobRow,
    confirmedBy: string | null,
  ): Promise<void> {
    if (job.order_id !== null && job.document !== 'test') {
      await this.orders.markSlipsPrinted(tx, orgId, [job.order_id]);
    }
    await this.changed(tx, orgId, job, null);
    if (confirmedBy === null) {
      await this.audit.record(tx, {
        orgId,
        actorUserId: null,
        operation: 'update',
        action: 'labels.job_printed',
        entityType: 'print_job',
        entityId: job.id,
        after: { state: 'printed', attempts: job.attempts, printerId: job.printer_id },
      });
    }
  }

  /** A job failed for good: the label team is told (D-813), the log keeps why. */
  private async failed(
    tx: Tx,
    orgId: string,
    job: repo.JobRow,
    confirmedBy: string | null,
  ): Promise<void> {
    await this.changed(tx, orgId, job, job.last_error);
    if (confirmedBy === null) {
      await this.audit.record(tx, {
        orgId,
        actorUserId: null,
        operation: 'update',
        action: 'labels.job_failed',
        entityType: 'print_job',
        entityId: job.id,
        after: { state: 'failed', attempts: job.attempts, error: job.last_error },
      });
    }
  }

  private async jobInScope(
    tx: Tx,
    context: ActiveContext,
    request: object,
    jobId: string,
    forUpdate: boolean,
  ): Promise<repo.JobRow> {
    const job = await repo.jobById(tx, context.orgId, jobId, { forUpdate });
    if (
      job === undefined ||
      (job.order_id !== null &&
        !(await this.orders.orderVisibleTo(tx, context.orgId, job.order_id, request)))
    ) {
      throw new PackingError('NOT_FOUND', 'No such print job.');
    }
    return job;
  }

  private async names(tx: Tx, orgId: string): Promise<Map<string, string>> {
    return new Map(await this.iam.nameBook(tx, orgId));
  }

  private presentJob(
    job: repo.JobRow,
    names: ReadonlyMap<string, string>,
    printers: readonly repo.PrinterRow[],
    terminals: readonly repo.TerminalRow[],
  ) {
    const printer = printers.find((one) => one.id === job.printer_id);
    const terminal = terminals.find((one) => one.id === job.terminal_id);
    return {
      id: job.id,
      orderId: job.order_id,
      orderNo: job.order_no,
      document: job.document,
      lot: job.lot_no,
      lotCount: job.lot_count,
      printer: {
        id: job.printer_id,
        name: printer?.name ?? '',
        connection: printer?.connection ?? null,
        state:
          printer === undefined
            ? 'unknown'
            : printerShownState({
                connection: printer.connection,
                enabled: printer.enabled,
                status: printer.status,
                statusAt: at(printer.status_at),
                stationSeenAt: null,
                now: new Date(),
              }),
      },
      terminal: { id: job.terminal_id, name: terminal?.name ?? '' },
      source: job.source,
      reason: job.reason,
      requestedBy:
        job.requested_by === null
          ? null
          : { id: job.requested_by, name: names.get(job.requested_by) ?? null },
      confirmedBy:
        job.confirmed_by === null
          ? null
          : { id: job.confirmed_by, name: names.get(job.confirmed_by) ?? null },
      copies: job.copies,
      consignmentNo: job.consignment_no,
      state: job.state,
      attempts: job.attempts,
      lastError: job.last_error,
      createdAt: iso(job.created_at) ?? '',
      printedAt: iso(job.printed_at),
      failedAt: iso(job.failed_at),
    };
  }
}
