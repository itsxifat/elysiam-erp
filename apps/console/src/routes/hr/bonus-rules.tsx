import { Button, EmptyState, ErrorState, Money, PermissionGate, StatusBadge } from '@elysium/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';

import { ApiError } from '../../api.js';
import { useAbility } from '../../auth/session.js';
import { control, Field } from './hr-nav.js';
import {
  addBonusVersion,
  createBonusRule,
  listBonusRules,
  previewBonusVersion,
  submitBonusVersion,
  type BonusRule,
  type BonusVersion,
  type TargetMetric,
} from './performance-api.js';
import { usePerfT, type PerfMessageKey } from './performance-messages.js';
import {
  currentMonth,
  metricKey,
  PerformanceNav,
  percentText,
  TargetFigure,
} from './performance-shared.js';

/**
 * Bonus rules (§12; M20; D-274, D-275).
 *
 * A rule is JSON in §12's shape, written here, checked by the server's parser (which says
 * exactly what is wrong), previewed against a month's targets, and sent to a second person.
 * Only an approved version pays, and only when HR applies the rules to a draft payroll run.
 * Editing a rule adds a version; the approved one stays in force until its successor is
 * approved.
 */

const EXAMPLE = JSON.stringify(
  {
    metric: 'delivered_orders',
    tiers: [
      { gte_pct: 100, amount_poisha: 200000 },
      { gte_pct: 120, per_unit_above_target_poisha: 5000 },
    ],
  },
  null,
  2,
);

const VERSION_TONE: Readonly<Record<string, 'neutral' | 'warning' | 'success' | 'danger'>> = {
  draft: 'neutral',
  pending_approval: 'warning',
  approved: 'success',
  rejected: 'danger',
  superseded: 'neutral',
};

function parseJson(text: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

export function BonusRulesPage() {
  const t = usePerfT();
  const ability = useAbility();
  const queryClient = useQueryClient();
  const mayRead = ability.can('read', 'Payroll');
  const mayWrite = ability.can('create', 'Payroll');

  const rules = useQuery({
    queryKey: ['performance', 'bonus-rules'],
    queryFn: listBonusRules,
    enabled: mayRead,
  });
  const invalidate = () =>
    void queryClient.invalidateQueries({ queryKey: ['performance', 'bonus-rules'] });
  const items = rules.data?.items ?? [];

  return (
    <PermissionGate
      allowed={mayRead}
      explain={{ title: t('perf.deniedTitle'), detail: t('perf.deniedDetail') }}
    >
      <div className="space-y-6">
        <header>
          <h1 className="text-lg font-semibold tracking-tight">{t('perf.bonusRules')}</h1>
          <p className="text-sm text-muted-foreground">{t('perf.bonusRulesHint')}</p>
        </header>

        <PerformanceNav />

        <PermissionGate allowed={mayWrite}>
          <NewRuleForm onCreated={invalidate} />
        </PermissionGate>

        {rules.isError ? (
          <ErrorState
            title={t('hr.errorTitle')}
            detail={t('hr.errorDetail')}
            action={
              <Button size="sm" variant="secondary" onClick={() => void rules.refetch()}>
                {t('hr.retry')}
              </Button>
            }
          />
        ) : items.length === 0 && !rules.isLoading ? (
          <EmptyState title={t('hr.emptyTitle')} detail={t('perf.emptyRules')} />
        ) : (
          items.map((rule) => (
            <RuleCard key={rule.id} rule={rule} mayWrite={mayWrite} onChanged={invalidate} />
          ))
        )}
      </div>
    </PermissionGate>
  );
}

function NewRuleForm({ onCreated }: { readonly onCreated: () => void }) {
  const t = usePerfT();
  const [name, setName] = useState('');
  const [definition, setDefinition] = useState(EXAMPLE);

  const create = useMutation({
    mutationFn: () => {
      const parsed = parseJson(definition);
      if (parsed === null) throw new ApiError(400, null, t('perf.invalidJson'));
      return createBonusRule({ name: name.trim(), definition: parsed });
    },
    onSuccess: () => {
      setName('');
      onCreated();
    },
  });

  return (
    <form
      className="grid gap-3 rounded-lg border border-border bg-card p-4"
      onSubmit={(event) => {
        event.preventDefault();
        create.mutate();
      }}
    >
      <div className="w-72">
        <Field label={t('perf.ruleName')} id="rule-name">
          <input
            id="rule-name"
            value={name}
            required
            maxLength={80}
            className={control}
            onChange={(event) => setName(event.target.value)}
          />
        </Field>
      </div>
      <DefinitionField id="rule-definition" value={definition} onChange={setDefinition} />
      <div className="flex items-center gap-3">
        <Button type="submit" size="sm" disabled={name.trim() === '' || create.isPending}>
          {t('perf.newRule')}
        </Button>
        {create.error === null ? null : (
          <p role="alert" className="text-sm text-destructive">
            {create.error instanceof ApiError ? create.error.message : t('hr.saveFailed')}
          </p>
        )}
      </div>
    </form>
  );
}

function DefinitionField({
  id,
  value,
  onChange,
}: {
  readonly id: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
}) {
  const t = usePerfT();
  return (
    <Field label={t('perf.definition')} id={id} hint={t('perf.definitionHint')}>
      <textarea
        id={id}
        value={value}
        rows={8}
        spellCheck={false}
        className="w-full rounded-md border border-border bg-background p-2 font-mono text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring"
        onChange={(event) => onChange(event.target.value)}
      />
    </Field>
  );
}

function RuleCard({
  rule,
  mayWrite,
  onChanged,
}: {
  readonly rule: BonusRule;
  readonly mayWrite: boolean;
  readonly onChanged: () => void;
}) {
  const t = usePerfT();
  const latest = rule.versions[0];
  const [editing, setEditing] = useState(false);
  const [definition, setDefinition] = useState(
    latest === undefined ? EXAMPLE : JSON.stringify(latest.definition, null, 2),
  );

  const add = useMutation({
    mutationFn: () => {
      const parsed = parseJson(definition);
      if (parsed === null) throw new ApiError(400, null, t('perf.invalidJson'));
      return addBonusVersion(rule.id, parsed);
    },
    onSuccess: () => {
      setEditing(false);
      onChanged();
    },
  });

  return (
    <section
      aria-label={rule.name}
      className="space-y-3 rounded-lg border border-border bg-card p-4"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h2 className="text-sm font-semibold">
          {rule.name}{' '}
          <span className="font-normal text-muted-foreground">· {t(metricKey(rule.metric))}</span>
        </h2>
        {mayWrite ? (
          <Button size="sm" variant="secondary" onClick={() => setEditing(!editing)}>
            {t('perf.newVersion')}
          </Button>
        ) : null}
      </div>

      {editing ? (
        <form
          className="space-y-3"
          onSubmit={(event) => {
            event.preventDefault();
            add.mutate();
          }}
        >
          <DefinitionField id={`version-${rule.id}`} value={definition} onChange={setDefinition} />
          <div className="flex items-center gap-3">
            <Button type="submit" size="sm" disabled={add.isPending}>
              {t('perf.newVersion')}
            </Button>
            {add.error === null ? null : (
              <p role="alert" className="text-sm text-destructive">
                {add.error instanceof ApiError ? add.error.message : t('hr.saveFailed')}
              </p>
            )}
          </div>
        </form>
      ) : null}

      <ul className="space-y-3">
        {rule.versions.map((version) => (
          <VersionRow
            key={version.id}
            version={version}
            metric={rule.metric}
            mayWrite={mayWrite}
            onChanged={onChanged}
          />
        ))}
      </ul>
    </section>
  );
}

function VersionRow({
  version,
  metric,
  mayWrite,
  onChanged,
}: {
  readonly version: BonusVersion;
  readonly metric: TargetMetric;
  readonly mayWrite: boolean;
  readonly onChanged: () => void;
}) {
  const t = usePerfT();
  const [month, setMonth] = useState(currentMonth());
  const [previewMonth, setPreviewMonth] = useState<string | null>(null);

  const preview = useQuery({
    queryKey: ['performance', 'bonus-preview', version.id, previewMonth],
    queryFn: () => previewBonusVersion(version.id, previewMonth ?? ''),
    enabled: previewMonth !== null,
  });
  const submit = useMutation({
    mutationFn: () => submitBonusVersion(version.id),
    onSuccess: onChanged,
  });

  return (
    <li className="space-y-2 border-t border-border/60 pt-3">
      <div className="flex flex-wrap items-center gap-3 text-sm">
        <span className="tabular-nums">
          {t('perf.version')} {version.version}
        </span>
        <StatusBadge tone={VERSION_TONE[version.status] ?? 'neutral'}>
          {t(`perf.version.${version.status}` as PerfMessageKey)}
        </StatusBadge>
        <input
          aria-label={t('perf.month')}
          type="month"
          value={month}
          className={`${control} w-36`}
          onChange={(event) => setMonth(event.target.value)}
        />
        <Button size="sm" variant="secondary" onClick={() => setPreviewMonth(month)}>
          {t('perf.preview')}
        </Button>
        {mayWrite && version.status === 'draft' ? (
          <Button size="sm" disabled={submit.isPending} onClick={() => submit.mutate()}>
            {t('perf.submit')}
          </Button>
        ) : null}
        {submit.error === null ? null : (
          <p role="alert" className="text-sm text-destructive">
            {submit.error instanceof ApiError ? submit.error.message : t('hr.saveFailed')}
          </p>
        )}
      </div>
      <pre className="overflow-x-auto rounded-md bg-muted p-2 font-mono text-xs">
        {JSON.stringify(version.definition, null, 2)}
      </pre>
      {preview.data === undefined ? null : (
        <table className="w-full text-sm">
          <caption className="sr-only">{t('perf.preview')}</caption>
          <thead>
            <tr className="border-b border-border text-left text-xs text-muted-foreground">
              <th scope="col" className="py-2">
                {t('perf.employee')}
              </th>
              <th scope="col" className="py-2 text-right">
                {t('perf.target')}
              </th>
              <th scope="col" className="py-2 text-right">
                {t('perf.achieved')}
              </th>
              <th scope="col" className="py-2 text-right">
                {t('perf.progress')}
              </th>
              <th scope="col" className="py-2 text-right">
                {t('perf.total')}
              </th>
            </tr>
          </thead>
          <tbody>
            {preview.data.items.map((item) => (
              <tr key={item.targetId} className="h-9 border-b border-border/60">
                <td className="py-2">
                  <span className="text-muted-foreground tabular-nums">{item.employeeCode}</span>{' '}
                  {item.employeeName}
                </td>
                <td className="py-2 text-right">
                  <TargetFigure metric={metric} value={item.targetValue} />
                </td>
                <td className="py-2 text-right">
                  <TargetFigure metric={metric} value={item.achieved} />
                </td>
                <td className="py-2 text-right tabular-nums">{percentText(item.pctBps)}</td>
                <td className="py-2 text-right">
                  <Money poisha={item.amountPoisha} />
                  {item.capped ? (
                    <span className="ml-1 text-xs text-muted-foreground">({t('perf.capped')})</span>
                  ) : null}
                </td>
              </tr>
            ))}
            <tr className="h-9">
              <td className="py-2 font-medium" colSpan={4}>
                {t('perf.total')}
              </td>
              <td className="py-2 text-right font-medium">
                <Money poisha={preview.data.totalPoisha} />
              </td>
            </tr>
          </tbody>
        </table>
      )}
    </li>
  );
}
