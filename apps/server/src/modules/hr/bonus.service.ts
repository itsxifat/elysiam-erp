import { ForbiddenException, Injectable, type OnModuleInit } from '@nestjs/common';
import { withOrg, type Tx } from '@elysium/db';
import {
  bonusRuleToJson,
  evaluateBonus,
  parseBonusRule,
  type BonusRule,
} from '@elysium/domain/targets';

import type { AuditableRequest } from '../../platform/audit/audit.interceptor.js';
import { AuditService } from '../../platform/audit/audit.service.js';
import { assertInScope } from '../../platform/auth/scope.js';
import type { ActiveContext } from '../../platform/http/context.js';
import { ApprovalsService, type ApprovalExecutor } from '../approvals/approvals.service.js';
import { HrError, mapHrErrors } from './hr.errors.js';
import * as hrRepo from './hr.repository.js';
import { approvalStatus, PayrollService } from './payroll.service.js';
import * as repo from './performance.repository.js';
import type { CreateBonusRuleInput } from './performance.schemas.js';
import { TargetsService } from './targets.service.js';

/**
 * Bonus rules: versioned JSON, previewed, approved by a second person, applied to payroll
 * (architecture §12; M20; D-274, D-275).
 *
 * ## The life of a version
 *
 * `draft → pending_approval → approved → superseded`, or `→ rejected`. A version's JSON
 * never changes after insert (0083): an edit is a new version, so the terms a checker
 * approved are exactly the terms that pay. Submitting raises a `bonus_rule` request through
 * the approvals module — a type no threshold can exempt (D-071) — and the executor below
 * approves **only the version that names that request**, so a `bonus_rule` request raised
 * by hand through `POST /v1/approvals` activates nothing.
 *
 * ## Paying it
 *
 * `applyToRun` evaluates every approved version against the run month's employee targets
 * (team targets pay nothing yet, D-273) and writes each non-zero result as an ordinary
 * `bonus` input on the draft payroll run, with an award row saying why. From there it is
 * M19's: the run computes, freezes, is approved by a checker and posts (Dr bonus expense).
 * Applying again replaces the rule-made inputs and leaves hand-typed ones alone; once the
 * run is submitted, 0055 and 0083 refuse both.
 */

export interface VersionView {
  readonly id: string;
  readonly ruleId: string;
  readonly version: number;
  readonly status: string;
  readonly definition: unknown;
  readonly approvalId: string | null;
  readonly approvalStatus: string | null;
  readonly decidedAt: string | null;
  readonly createdBy: string;
  readonly createdAt: string;
}

export interface RuleView {
  readonly id: string;
  readonly name: string;
  readonly metric: string;
  readonly versions: readonly VersionView[];
}

export interface PreviewRow {
  readonly targetId: string;
  readonly employeeId: string;
  readonly employeeCode: string | null;
  readonly employeeName: string | null;
  readonly targetValue: string;
  readonly achieved: string;
  readonly pctBps: number;
  readonly amountPoisha: string;
  readonly capped: boolean;
}

export interface AwardView {
  readonly id: string;
  readonly employeeId: string;
  readonly employeeCode: string;
  readonly employeeName: string;
  readonly targetId: string;
  readonly ruleVersionId: string;
  readonly ruleName: string;
  readonly version: number;
  readonly payrollInputId: string;
  readonly targetValue: string;
  readonly achieved: string;
  readonly pctBps: number;
  readonly amountPoisha: string;
}

/** A payroll input label is at most 60 characters (0053). */
function inputLabel(name: string, version: number): string {
  const label = `Target bonus: ${name} v${String(version)}`;
  return label.length <= 60 ? label : `${label.slice(0, 57)}...`;
}

@Injectable()
export class BonusRulesService implements OnModuleInit {
  constructor(
    private readonly approvals: ApprovalsService,
    private readonly audit: AuditService,
    private readonly targets: TargetsService,
    private readonly payroll: PayrollService,
  ) {}

  onModuleInit(): void {
    this.approvals.registerExecutor('bonus_rule', this.execute);
  }

  // --- rules and versions ---------------------------------------------------------

  async list(context: ActiveContext): Promise<{ items: RuleView[] }> {
    return withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
      const rules = await repo.listRules(tx, context.orgId);
      const versions = await repo.versionsOf(
        tx,
        context.orgId,
        rules.map((rule) => rule.id),
      );
      const items: RuleView[] = [];
      for (const rule of rules) {
        const own: VersionView[] = [];
        for (const version of versions.filter((one) => one.rule_id === rule.id)) {
          own.push(await this.versionView(tx, context.orgId, version));
        }
        items.push({ id: rule.id, name: rule.name, metric: rule.metric, versions: own });
      }
      return { items };
    });
  }

  async create(
    context: ActiveContext,
    request: AuditableRequest,
    input: CreateBonusRuleInput,
  ): Promise<RuleView> {
    return mapHrErrors(() =>
      withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
        const rule = parseBonusRule(input.definition);
        assertInScope(request, { branchId: null, createdBy: context.userId });
        const ruleId = await repo.insertRule(tx, {
          orgId: context.orgId,
          name: input.name,
          metric: rule.metric,
          createdBy: context.userId,
        });
        const versionId = await repo.insertVersion(tx, {
          orgId: context.orgId,
          ruleId,
          definition: bonusRuleToJson(rule),
          createdBy: context.userId,
        });
        await this.audit.record(tx, {
          orgId: context.orgId,
          actorUserId: context.userId,
          operation: 'create',
          action: 'hr.bonus_rule.created',
          entityType: 'Payroll',
          entityId: ruleId,
          before: null,
          after: { name: input.name, versionId, definition: bonusRuleToJson(rule) },
          requestId: context.requestId,
          request,
        });
        return this.ruleView(tx, context.orgId, ruleId);
      }),
    );
  }

  async addVersion(
    context: ActiveContext,
    request: AuditableRequest,
    ruleId: string,
    definition: unknown,
  ): Promise<RuleView> {
    return mapHrErrors(() =>
      withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
        const existing = await repo.ruleById(tx, context.orgId, ruleId);
        if (existing === undefined) throw new HrError('HR_NOT_FOUND', 'No such bonus rule.');
        assertInScope(request, { branchId: null, createdBy: context.userId });
        const rule = parseBonusRule(definition);
        if (rule.metric !== existing.metric) {
          throw new HrError(
            'BONUS_RULE_INVALID',
            `This rule pays on ${existing.metric}; a version cannot change its metric. Create a new rule instead.`,
          );
        }
        const versionId = await repo.insertVersion(tx, {
          orgId: context.orgId,
          ruleId,
          definition: bonusRuleToJson(rule),
          createdBy: context.userId,
        });
        await this.audit.record(tx, {
          orgId: context.orgId,
          actorUserId: context.userId,
          operation: 'create',
          action: 'hr.bonus_rule.version_added',
          entityType: 'Payroll',
          entityId: versionId,
          before: null,
          after: { ruleId, definition: bonusRuleToJson(rule) },
          requestId: context.requestId,
          request,
        });
        return this.ruleView(tx, context.orgId, ruleId);
      }),
    );
  }

  /**
   * What one version would pay for a month's employee targets, now. Nothing is written.
   */
  async preview(
    context: ActiveContext,
    versionId: string,
    month: string,
  ): Promise<{ month: string; items: PreviewRow[]; totalPoisha: string }> {
    return mapHrErrors(() =>
      withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
        const version = await repo.versionById(tx, context.orgId, versionId);
        if (version === undefined) {
          throw new HrError('HR_NOT_FOUND', 'No such bonus rule version.');
        }
        const items = await this.evaluate(
          tx,
          context.orgId,
          month,
          parseBonusRule(version.definition),
        );
        const total = items.reduce((sum, item) => sum + BigInt(item.amountPoisha), 0n);
        return { month, items, totalPoisha: total.toString() };
      }),
    );
  }

  /** Every active employee target of the month on the rule's metric, evaluated. */
  private async evaluate(
    tx: Tx,
    orgId: string,
    month: string,
    rule: BonusRule,
  ): Promise<PreviewRow[]> {
    const targets = (await repo.activeTargets(tx, orgId, [month])).filter(
      (target) => target.scope === 'employee' && target.metric === rule.metric,
    );
    const progress = await this.targets.progressOf(tx, orgId, targets);
    return targets.map((target) => {
      const achieved = progress.get(target.id)?.achieved ?? 0n;
      const result = evaluateBonus(rule, { targetValue: BigInt(target.target_value), achieved });
      return {
        targetId: target.id,
        employeeId: target.employee_id ?? '',
        employeeCode: target.employee_code,
        employeeName: target.employee_name,
        targetValue: target.target_value,
        achieved: achieved.toString(),
        pctBps: result.pctBps,
        amountPoisha: result.amountPoisha.toString(),
        capped: result.capped,
      };
    });
  }

  /**
   * Send a draft version to a checker.
   *
   * Only the version's author may submit it (M20 ledger audit W1): the approvals module
   * refuses the requester as checker, so the author being the requester is what keeps the
   * person who wrote the terms from approving them. A version left pending by a decided
   * request is settled first — the approvals module runs nothing on a rejection — so the
   * rule is not stuck behind it; one still waiting for a decision is a refusal.
   */
  async submit(
    context: ActiveContext,
    request: AuditableRequest,
    versionId: string,
    reason: string | undefined,
  ): Promise<RuleView> {
    return mapHrErrors(async () => {
      const prepared = await withOrg(
        { orgId: context.orgId, userId: context.userId },
        async (tx) => {
          const version = await repo.versionById(tx, context.orgId, versionId, { forUpdate: true });
          if (version === undefined) {
            throw new HrError('HR_NOT_FOUND', 'No such bonus rule version.');
          }
          assertInScope(request, { branchId: null, createdBy: version.created_by });
          if (version.status !== 'draft') {
            throw new HrError('BONUS_RULE_FROZEN', 'Only a draft version can be submitted.');
          }
          if (version.created_by !== context.userId) {
            throw new ForbiddenException(
              'Only the person who wrote this version can send it for approval; somebody else then approves it.',
            );
          }
          await this.closeDecidedPending(tx, context, version.rule_id, request);
          if ((await repo.pendingVersionOf(tx, context.orgId, version.rule_id)) !== undefined) {
            throw new HrError(
              'BONUS_RULE_FROZEN',
              'Another version of this rule is already waiting for approval.',
            );
          }
          return version;
        },
      );

      const raised = await this.approvals.request(context, {
        type: 'bonus_rule',
        amountPoisha: null,
        payload: {
          ruleId: prepared.rule_id,
          ruleVersionId: prepared.id,
          name: prepared.rule_name,
          version: prepared.version,
          metric: prepared.metric,
        },
        ...(reason === undefined ? {} : { reason }),
        request,
      });

      return withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
        // Two submits of one draft both raise a request; the second finds no draft left
        // (ledger audit N1) and says so rather than auditing a submit that did nothing.
        if ((await repo.markSubmitted(tx, context.orgId, prepared.id, raised.id)) === 0) {
          throw new HrError('BONUS_RULE_FROZEN', 'That version has already been submitted.');
        }
        await this.audit.record(tx, {
          orgId: context.orgId,
          actorUserId: context.userId,
          operation: 'update',
          action: 'hr.bonus_rule.submitted',
          entityType: 'Payroll',
          entityId: prepared.id,
          before: { status: 'draft' },
          after: { status: 'pending_approval', approvalId: raised.id },
          requestId: context.requestId,
          request,
        });
        // A checker who decided between the request and the write above found no version to
        // approve; the decision is honoured here rather than at the rule's next submit.
        if ((await approvalStatus(tx, context.orgId, raised.id)) === 'approved') {
          const submitted = await repo.versionById(tx, context.orgId, prepared.id);
          if (submitted !== undefined) {
            await this.activate(tx, context, submitted, raised.id, request, 'late');
          }
        }
        return this.ruleView(tx, context.orgId, prepared.rule_id);
      });
    });
  }

  /**
   * Settle a pending version whose request is already decided: rejected or withdrawn closes
   * it, and approved — only possible when the checker decided in the moment between the
   * request and the submit's own write, so the executor found nothing (ledger audit N2) —
   * puts it into force now.
   */
  private async closeDecidedPending(
    tx: Tx,
    context: ActiveContext,
    ruleId: string,
    request: AuditableRequest,
  ): Promise<void> {
    const pending = await repo.pendingVersionOf(tx, context.orgId, ruleId);
    if (pending?.approval_request_id == null) return;
    const status = await approvalStatus(tx, context.orgId, pending.approval_request_id);
    if (status === 'rejected' || status === 'cancelled') {
      await repo.setVersionStatus(tx, context.orgId, pending.id, 'rejected');
    } else if (status === 'approved') {
      await this.activate(tx, context, pending, pending.approval_request_id, request, 'late');
    }
  }

  /**
   * Put a version into force: the one it replaces is superseded, and that one's bonuses on
   * draft runs go with it (ledger audit W4), so a run never pays terms that are no longer
   * the brand's. 0083 refuses this unless the version's own request is approved by
   * somebody other than its author.
   *
   * `late` is a decision found already made, by the author's submit or their next one,
   * rather than made now by the checker. The trail then says `activated`, so the author is
   * not recorded approving their own terms; the approvals module's own row names the
   * checker (ledger confirmation N-1).
   */
  private async activate(
    tx: Tx,
    context: ActiveContext,
    version: repo.VersionRow,
    approvalId: string,
    request: AuditableRequest | undefined,
    how: 'decided' | 'late' = 'decided',
  ): Promise<void> {
    const current = await repo.approvedVersionOf(tx, context.orgId, version.rule_id);
    let removed = 0;
    if (current !== undefined) {
      await repo.setVersionStatus(tx, context.orgId, current.id, 'superseded');
      removed = await repo.deleteDraftAwardInputs(tx, context.orgId, { ruleVersionId: current.id });
    }
    await repo.setVersionStatus(tx, context.orgId, version.id, 'approved');
    // How many draft-run bonuses the old terms lost, so a run that needs re-applying is
    // visible in the trail (ledger re-check note).
    await this.audit.record(tx, {
      orgId: context.orgId,
      actorUserId: context.userId,
      operation: 'update',
      action: how === 'late' ? 'hr.bonus_rule.activated' : 'hr.bonus_rule.approved',
      entityType: 'Payroll',
      entityId: version.id,
      before: { status: 'pending_approval', superseded: current?.id ?? null },
      after: { status: 'approved', approvalId, draftBonusesRemoved: removed },
      requestId: context.requestId,
      ...(request === undefined ? {} : { request }),
    });
  }

  /**
   * The approval's effect, in the approving transaction: the version that names this
   * request goes into force and the one it replaces is superseded. A request no version
   * names — raised by hand — does nothing at all.
   */
  private readonly execute: ApprovalExecutor = async (tx, { context, approval, request }) => {
    const version = await repo.versionByApproval(tx, context.orgId, approval.id);
    if (version?.status !== 'pending_approval') return;
    // The author approving their own terms (W1). Submit already makes the author the
    // requester, whom the approvals module refuses; this is the second lock, and 0083 the
    // third.
    if (version.created_by === context.userId) {
      throw new ForbiddenException('The person who wrote a bonus rule version cannot approve it.');
    }
    await this.activate(tx, context, version, approval.id, request);
  };

  // --- payroll ----------------------------------------------------------------------

  async runBonuses(context: ActiveContext, runId: string): Promise<{ items: AwardView[] }> {
    return mapHrErrors(() =>
      withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
        const run = await hrRepo.runById(tx, context.orgId, runId);
        if (run === undefined) throw new HrError('PAYROLL_NOT_FOUND', 'No such payroll run.');
        return { items: (await repo.awardsForRun(tx, context.orgId, runId)).map(awardView) };
      }),
    );
  }

  /**
   * Evaluate every approved rule against the run's month and write the results as the
   * run's rule-made bonus inputs, replacing any from an earlier apply.
   *
   * Only for employees the run will pay (ledger audit W3): a bonus for somebody with no
   * salary structure that month would be an input the run silently ignores, shown on this
   * screen and paid nowhere. Those are returned as `skipped`, so HR sees who and why.
   */
  async applyToRun(
    context: ActiveContext,
    request: AuditableRequest,
    runId: string,
  ): Promise<{
    items: AwardView[];
    totalPoisha: string;
    skipped: { employeeId: string; employeeCode: string | null; amountPoisha: string }[];
  }> {
    return mapHrErrors(() =>
      withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
        const run = await hrRepo.runForUpdate(tx, context.orgId, runId);
        if (run === undefined) throw new HrError('PAYROLL_NOT_FOUND', 'No such payroll run.');
        if (run.status !== 'draft') {
          throw new HrError(
            'PAYROLL_RUN_FROZEN',
            'That payroll run is no longer a draft, so its bonuses cannot change.',
          );
        }

        const removed = await repo.deleteRuleInputs(tx, context.orgId, runId);
        const payable = await this.payroll.payableEmployeeIds(tx, context.orgId, run);
        const skipped: { employeeId: string; employeeCode: string | null; amountPoisha: string }[] =
          [];
        let total = 0n;
        for (const version of await repo.approvedVersions(tx, context.orgId)) {
          const rule = parseBonusRule(version.definition);
          for (const row of await this.evaluate(tx, context.orgId, run.month, rule)) {
            const amount = BigInt(row.amountPoisha);
            if (amount <= 0n) continue;
            if (!payable.has(row.employeeId)) {
              skipped.push({
                employeeId: row.employeeId,
                employeeCode: row.employeeCode,
                amountPoisha: row.amountPoisha,
              });
              continue;
            }
            const inputId = await hrRepo.insertInput(tx, {
              orgId: context.orgId,
              runId,
              employeeId: row.employeeId,
              kind: 'bonus',
              label: inputLabel(version.rule_name, version.version),
              amountPoisha: amount,
              note: `${row.achieved} of ${row.targetValue} (${percentText(row.pctBps)})`,
              createdBy: context.userId,
            });
            await repo.insertAward(tx, {
              orgId: context.orgId,
              runId,
              employeeId: row.employeeId,
              targetId: row.targetId,
              ruleVersionId: version.id,
              payrollInputId: inputId,
              targetValue: BigInt(row.targetValue),
              achieved: BigInt(row.achieved),
              pctBps: row.pctBps,
              amountPoisha: amount,
              createdBy: context.userId,
            });
            total += amount;
          }
        }

        const awards = (await repo.awardsForRun(tx, context.orgId, runId)).map(awardView);
        await this.audit.record(tx, {
          orgId: context.orgId,
          actorUserId: context.userId,
          operation: 'update',
          action: 'hr.payroll_run.bonuses_applied',
          entityType: 'Payroll',
          entityId: runId,
          before: { ruleInputs: removed },
          after: { awards: awards.length, totalPoisha: total.toString(), skipped },
          requestId: context.requestId,
          request,
        });
        return { items: awards, totalPoisha: total.toString(), skipped };
      }),
    );
  }

  // --- views ---------------------------------------------------------------------------

  private async ruleView(tx: Tx, orgId: string, ruleId: string): Promise<RuleView> {
    const rule = await repo.ruleById(tx, orgId, ruleId);
    if (rule === undefined) throw new HrError('HR_NOT_FOUND', 'No such bonus rule.');
    const versions: VersionView[] = [];
    for (const version of await repo.versionsOf(tx, orgId, [ruleId])) {
      versions.push(await this.versionView(tx, orgId, version));
    }
    return { id: rule.id, name: rule.name, metric: rule.metric, versions };
  }

  private async versionView(tx: Tx, orgId: string, row: repo.VersionRow): Promise<VersionView> {
    return {
      id: row.id,
      ruleId: row.rule_id,
      version: row.version,
      status: row.status,
      definition: row.definition,
      approvalId: row.approval_request_id,
      approvalStatus:
        row.approval_request_id === null
          ? null
          : await approvalStatus(tx, orgId, row.approval_request_id),
      decidedAt: row.decided_at,
      createdBy: row.created_by,
      createdAt: row.created_at,
    };
  }
}

/** Basis points as a percentage with two decimals, in integers: 12345 is `123.45%`. */
function percentText(bps: number): string {
  return `${String(Math.trunc(bps / 100))}.${String(bps % 100).padStart(2, '0')}%`;
}

function awardView(row: repo.AwardRow): AwardView {
  return {
    id: row.id,
    employeeId: row.employee_id,
    employeeCode: row.employee_code,
    employeeName: row.employee_name,
    targetId: row.target_id,
    ruleVersionId: row.rule_version_id,
    ruleName: row.rule_name,
    version: row.version,
    payrollInputId: row.payroll_input_id,
    targetValue: row.target_value,
    achieved: row.achieved,
    pctBps: row.pct_bps,
    amountPoisha: row.amount_poisha,
  };
}
