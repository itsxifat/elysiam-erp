import { Injectable } from '@nestjs/common';
import { withOrg } from '@elysium/db';
import { poisha } from '@elysium/domain';
import { defineAbilityFor } from '@elysium/contracts';

import { assertInScope } from '../../platform/auth/scope.js';
import type { ActiveContext } from '../../platform/http/context.js';
import { fontFaceCss, loadFonts } from '../files/pdf/fonts.js';
import { GotenbergClient } from '../files/pdf/gotenberg.client.js';
import { HrError, mapHrErrors } from './hr.errors.js';
import * as repo from './hr.repository.js';
import { PayrollService } from './payroll.service.js';
import { renderPayslipHtml, type PayslipBrand } from './payslip.template.js';

/**
 * The payslip PDF (architecture §12, §22; `files.policy.ts`).
 *
 * ## Who may read one
 *
 * `files.policy.ts` maps the `payslip` purpose onto `read Payroll`, which §6 gives hr,
 * accounts and org_admin and nobody else — and adds "or the person it is about", which
 * is how the files module already treats a private object. Both halves are enforced
 * here: the route declares `read Employee`, the weakest grant every staff role holds, and
 * this service then requires **either** `read Payroll` **or** that the payslip is the
 * caller's own employee record. A sales agent asking for the warehouse manager's payslip
 * gets the same 404 they would get for a payslip that does not exist.
 *
 * ## Why it is rendered on demand and not stored
 *
 * §22's rule is authorize-then-sign, because a signed URL is a bearer token that no later
 * check can take back. A payslip rendered on demand has no URL to leak at all: the
 * authorisation and the bytes happen in one request, and there is no object in the private
 * bucket to garbage-collect, to forget to delete when an employee leaves, or to find in a
 * bucket listing. The payslip is also entirely derived from `hr.payroll_lines`, which is
 * append-only — so a stored copy would be a second source of truth for a document whose
 * first source cannot change (recorded as D-189).
 *
 * The cost is a Gotenberg round trip per download, which for a document nobody fetches
 * more than once a month is the right trade.
 */
@Injectable()
export class PayslipService {
  constructor(
    private readonly payroll: PayrollService,
    private readonly gotenberg: GotenbergClient,
  ) {}

  /**
   * The rendered payslip, and the filename to offer it under.
   *
   * The filename carries the employee code and the month rather than a uuid: the file
   * lands in a Downloads folder beside eleven others, and `payslip-EMP-014-2026-03.pdf`
   * is the difference between a document somebody can find and one they re-download.
   */
  async render(
    context: ActiveContext,
    request: object,
    runId: string,
    employeeId: string,
  ): Promise<{ pdf: Uint8Array; filename: string }> {
    return mapHrErrors(async () => {
      await this.authorize(context, request, employeeId);

      const { run, payslip } = await this.payroll.payslip(context, runId, employeeId);
      /*
       * Only a posted or paid run has a payslip worth handing over.
       *
       * A draft has no frozen lines at all, and a run waiting for a checker has lines
       * that nobody has agreed to yet — handing one out would be telling an employee
       * what they are going to be paid before the company has decided.
       */
      if (run.status !== 'posted' && run.status !== 'paid') {
        throw new HrError(
          'PAYROLL_TRANSITION_INVALID',
          'That payroll run has not been approved yet, so it has no payslips to issue.',
        );
      }

      const brand = await withOrg({ orgId: context.orgId, userId: context.userId }, (tx) =>
        repo.orgBrand(tx, context.orgId),
      );
      const employee = await withOrg({ orgId: context.orgId, userId: context.userId }, (tx) =>
        repo.employeeById(tx, context.orgId, employeeId),
      );

      const fonts = await loadFonts();
      const html = renderPayslipHtml({
        brand: brandFor(brand),
        data: {
          month: run.month,
          employeeCode: payslip.employeeCode,
          employeeName: payslip.employeeName,
          designation: employee?.designation ?? null,
          joinDate: employee?.join_date ?? '',
          workingDays: payslip.workingDays,
          presentDays: payslip.presentDays,
          absentDays: payslip.absentDays,
          halfDays: payslip.halfDays,
          earnings: payslip.components
            .filter((component) => component.direction === 'earning')
            .map((component) => ({
              label: component.label,
              amountPoisha: poisha(BigInt(component.amountPoisha)),
            })),
          deductions: payslip.components
            .filter((component) => component.direction === 'deduction')
            .map((component) => ({
              label: component.label,
              amountPoisha: poisha(BigInt(component.amountPoisha)),
            })),
          grossPoisha: poisha(BigInt(payslip.grossPoisha)),
          deductionsPoisha: poisha(BigInt(payslip.deductionsPoisha)),
          netPoisha: poisha(BigInt(payslip.netPoisha)),
          loanShortfallPoisha: poisha(BigInt(payslip.loanShortfallPoisha)),
          runStatus: run.status,
          paidOn: run.paid_on,
        },
        fonts,
      });

      const pdf = await this.gotenberg.renderPdf({
        html,
        assets: fonts.map((font) => ({
          filename: font.filename,
          bytes: font.bytes,
          contentType: 'font/woff2',
        })),
      });

      return { pdf, filename: `payslip-${payslip.employeeCode}-${run.month}.pdf` };
    });
  }

  /**
   * `read Payroll`, or it is your own payslip.
   *
   * The ability is rebuilt from the request context rather than read off the route,
   * because the route's declared ability is the coarse one that opens the door — the same
   * arrangement `files.service.ts` uses, where `read FileObject` opens the endpoint and
   * the purpose decides the row (D-115).
   */
  private async authorize(
    context: ActiveContext,
    request: object,
    employeeId: string,
  ): Promise<void> {
    const ability = defineAbilityFor(context);
    /*
     * A `read Payroll` holder reaches every payslip in the brand. §6 grants it at org scope
     * only (hr, accounts, org_admin), so the route's `read Employee` scope filter is `all` for
     * them and `ScopeInterceptor` needs nothing applied.
     */
    if (ability.can('read', 'Payroll')) return;

    const own = await withOrg({ orgId: context.orgId, userId: context.userId }, (tx) =>
      repo.employeeByUser(tx, context.orgId, context.userId),
    );
    if (own?.id === employeeId) {
      /*
       * The scope has to be *applied*, not merely satisfied.
       *
       * The route declares `read Employee`, which for a warehouse packer or a sales agent is
       * `own` scope — a filter, not a blanket grant. `ScopeInterceptor` refuses to send a
       * response for a scoped caller whose handler applied nothing, and it does that *after*
       * the handler has succeeded: without this line an employee reading their own payslip got
       * a 500 while everybody who was refused got a correct 404, so every test passed. Which
       * is exactly the failure mode that backstop exists to make loud.
       */
      assertInScope(request, {
        branchId: own.branch_id,
        createdBy: own.created_by,
        assignedTo: own.user_id,
      });
      return;
    }

    // 404, not 403. A payslip somebody may not read should be indistinguishable from one
    // that does not exist, or the refusal tells them who works here and what they earn
    // exists to be asked about.
    throw new HrError('HR_NOT_FOUND', 'No such payslip.');
  }
}

function brandFor(
  row: { display_name: string; legal_name: string; brand: unknown } | undefined,
): PayslipBrand {
  const brand = (row?.brand ?? {}) as { address?: unknown; accentHue?: unknown };
  return {
    displayName: row?.display_name ?? 'Elysium',
    legalName: row?.legal_name ?? row?.display_name ?? 'Elysium',
    address: typeof brand.address === 'string' ? brand.address : undefined,
    accentHue: typeof brand.accentHue === 'number' ? brand.accentHue : undefined,
  };
}

/** Re-exported so a test can assert the font CSS reaches the document. */
export { fontFaceCss };
