import { api } from '../../api.js';

/**
 * `/v1/hr` targets, bonus rules and productivity (M20), typed to what
 * `performance.controller.ts` returns.
 *
 * Hand-written for the reason `api.ts` beside it gives. A target's value and achieved
 * figure are strings in the metric's own unit — orders, or poisha for
 * `delivered_revenue` — so a revenue figure goes through `<Money>` and a count does not.
 */

export type TargetMetric = 'confirmed_orders' | 'delivered_orders' | 'delivered_revenue';

export const TARGET_METRICS: readonly TargetMetric[] = [
  'confirmed_orders',
  'delivered_orders',
  'delivered_revenue',
];

export interface TargetWeek {
  readonly weekNo: number;
  readonly startsOn: string;
  readonly endsOn: string;
  readonly workingDays: number;
  readonly planned: string;
  readonly achieved: string;
}

export interface Target {
  readonly id: string;
  readonly month: string;
  readonly metric: TargetMetric;
  readonly scope: 'employee' | 'team';
  readonly employeeId: string | null;
  readonly employeeCode: string | null;
  readonly employeeName: string | null;
  readonly teamName: string | null;
  readonly branchId: string | null;
  readonly targetValue: string;
  readonly achieved: string;
  /** Achieved over target in basis points: 10,000 is 100%. */
  readonly pctBps: number;
  readonly progressAt: string | null;
  readonly status: 'active' | 'cancelled';
  readonly note: string | null;
  readonly members: readonly {
    readonly employeeId: string;
    readonly code: string;
    readonly name: string;
  }[];
  readonly weeks: readonly TargetWeek[];
}

export interface DeskFigures {
  readonly pickups: number;
  readonly medianPickupSeconds: number | null;
  readonly p90PickupSeconds: number | null;
  readonly handledOrders: number;
  readonly activeHours: number;
  readonly ordersPerActiveHour: number | null;
}

export interface ProductivityRow extends DeskFigures {
  readonly employeeId: string;
  readonly employeeCode: string;
  readonly employeeName: string;
  readonly branchId: string | null;
}

export interface MyPerformance {
  readonly month: string;
  readonly employee: { readonly id: string; readonly code: string; readonly name: string } | null;
  readonly targets: readonly Target[];
  readonly productivity: DeskFigures | null;
}

export interface BonusVersion {
  readonly id: string;
  readonly ruleId: string;
  readonly version: number;
  readonly status: 'draft' | 'pending_approval' | 'approved' | 'rejected' | 'superseded';
  readonly definition: unknown;
  readonly approvalId: string | null;
  readonly approvalStatus: string | null;
  readonly decidedAt: string | null;
  readonly createdAt: string;
}

export interface BonusRule {
  readonly id: string;
  readonly name: string;
  readonly metric: TargetMetric;
  readonly versions: readonly BonusVersion[];
}

export interface BonusPreview {
  readonly month: string;
  readonly totalPoisha: string;
  readonly items: readonly {
    readonly targetId: string;
    readonly employeeId: string;
    readonly employeeCode: string | null;
    readonly employeeName: string | null;
    readonly targetValue: string;
    readonly achieved: string;
    readonly pctBps: number;
    readonly amountPoisha: string;
    readonly capped: boolean;
  }[];
}

export interface BonusAward {
  readonly id: string;
  readonly employeeId: string;
  readonly employeeCode: string;
  readonly employeeName: string;
  readonly ruleName: string;
  readonly version: number;
  readonly targetValue: string;
  readonly achieved: string;
  readonly pctBps: number;
  readonly amountPoisha: string;
}

function query(params: Record<string, string | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') search.set(key, value);
  }
  const text = search.toString();
  return text === '' ? '' : `?${text}`;
}

export function getMyPerformance(month: string): Promise<MyPerformance> {
  return api.get(`/v1/hr/performance/me${query({ month })}`);
}

export function listTargets(input: { readonly month?: string; readonly status?: string }): Promise<{
  items: Target[];
}> {
  return api.get(`/v1/hr/targets${query({ month: input.month, status: input.status })}`);
}

export function createTarget(input: {
  readonly scope: 'employee';
  readonly month: string;
  readonly metric: TargetMetric;
  readonly employeeId: string;
  readonly targetValue: string;
  readonly note?: string;
}): Promise<Target> {
  return api.post('/v1/hr/targets', input);
}

export function cancelTarget(id: string): Promise<Target> {
  return api.post(`/v1/hr/targets/${id}/cancel`);
}

export function refreshTargets(): Promise<{ updated: number }> {
  return api.post('/v1/hr/targets/refresh');
}

export function getProductivity(from: string, to: string): Promise<{ items: ProductivityRow[] }> {
  return api.get(`/v1/hr/productivity${query({ from, to })}`);
}

export function listBonusRules(): Promise<{ items: BonusRule[] }> {
  return api.get('/v1/hr/bonus-rules');
}

export function createBonusRule(input: {
  readonly name: string;
  readonly definition: Record<string, unknown>;
}): Promise<BonusRule> {
  return api.post('/v1/hr/bonus-rules', input);
}

export function addBonusVersion(
  ruleId: string,
  definition: Record<string, unknown>,
): Promise<BonusRule> {
  return api.post(`/v1/hr/bonus-rules/${ruleId}/versions`, { definition });
}

export function previewBonusVersion(versionId: string, month: string): Promise<BonusPreview> {
  return api.get(`/v1/hr/bonus-rules/versions/${versionId}/preview${query({ month })}`);
}

export function submitBonusVersion(versionId: string): Promise<BonusRule> {
  return api.post(`/v1/hr/bonus-rules/versions/${versionId}/submit`, {});
}

export function listRunBonuses(runId: string): Promise<{ items: BonusAward[] }> {
  return api.get(`/v1/hr/payroll/runs/${runId}/bonuses`);
}

export function applyRunBonuses(
  runId: string,
): Promise<{ items: BonusAward[]; totalPoisha: string }> {
  return api.post(`/v1/hr/payroll/runs/${runId}/bonuses`);
}
