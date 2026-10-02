import { effectiveScope } from '@elysium/contracts';
import { Button, EmptyState, ErrorState, Money, PermissionGate, StatusBadge } from '@elysium/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';

import { ApiError } from '../../api.js';
import { useAbility, useSession } from '../../auth/session.js';
import {
  createEmployee,
  listBranchOptions,
  listEmployees,
  listLoginOptions,
  listStructures,
  setStructure,
  updateEmployee,
  type BranchOption,
  type Employee,
  type EmploymentStatus,
  type PayoutMethod,
} from './api.js';
import {
  editFormFor,
  employeePatch,
  type EmployeeEditForm,
  type EmployeePatchProblem,
} from './employee-patch.js';
import { control, Field, HrNav, numericControl } from './hr-nav.js';
import { useHrT, type HrMessageKey } from './messages.js';
import { takaToPoisha } from '@elysium/ui';

/**
 * The staff list, and the two forms that create a person and set their pay (§12, §6).
 *
 * ## The privacy line, on screen
 *
 * The form asks for a national ID, a bank or bKash number and a phone number, and the table
 * shows only masks — because that is all the server will ever send back (invariant 10). The
 * hint under each of those fields says so, which is not decoration: the person typing it
 * needs to know they will not be able to read it back, or they will type it into the note
 * field next time.
 *
 * ## Salary is a separate grant and a separate form
 *
 * §6's employees row gives a branch manager their branch's staff records; it does not give
 * them the power to set what those staff are paid. So the salary form is gated on
 * `create Payroll` while the employee form is gated on `create Employee`, and a branch
 * manager sees one and not the other. Collapsing them into one screen-level gate is the
 * mistake `subjects.ts` warns about.
 *
 * A raise is a **new version with a later start date**, never an edit — the form says so in
 * its hint, and the server refuses an edit to a structure a payslip has used. Past payslips
 * have to keep the figures they were paid on.
 *
 * ## Branch and edit (m30-followups)
 *
 * The add form offers the branches the caller may add to (`GET /v1/hr/branch-options`): a
 * branch manager's own, every branch for HR. Without it a branch manager's add carried no
 * branch and their own scope refused it. Each row's Edit panel changes the record after the
 * add; the payroll half of it (payout, personal numbers, the linked sign-in) is shown only
 * to `update Payroll`, and the panel sends only what changed (`employee-patch.ts`).
 */

const STATUS_TONE: Readonly<Record<EmploymentStatus, 'success' | 'warning' | 'neutral'>> = {
  active: 'success',
  suspended: 'warning',
  resigned: 'neutral',
  terminated: 'neutral',
};

const PAYOUT_METHODS: readonly PayoutMethod[] = ['cash', 'bank', 'bkash', 'nagad'];
const STATUSES: readonly EmploymentStatus[] = ['active', 'suspended', 'resigned', 'terminated'];

export function PeoplePage() {
  const t = useHrT();
  const ability = useAbility();
  const queryClient = useQueryClient();

  const session = useSession();
  const mayRead = ability.can('read', 'Employee');
  const mayCreate = ability.can('create', 'Employee');
  const mayUpdate = ability.can('update', 'Employee');
  const maySetSalary = ability.can('create', 'Payroll');
  const mayEditPayroll = ability.can('update', 'Payroll');
  /*
   * Whether the caller may keep a person outside every branch. Only an org-wide reach can:
   * a branch manager's add or move to "no branch" is outside their own scope, and the
   * server refuses it as it would a row it cannot see.
   */
  const orgWide =
    session.context?.isSuperAdmin === true ||
    effectiveScope(session.roles, 'create', 'Employee') === 'org';

  const [search, setSearch] = useState('');
  const [status, setStatus] = useState<string>('');
  const [panel, setPanel] = useState<{ kind: 'salary' | 'edit'; id: string } | null>(null);

  const branchOptions = useQuery({
    queryKey: ['hr', 'branch-options'],
    queryFn: listBranchOptions,
    enabled: mayCreate || mayUpdate,
    staleTime: 5 * 60_000,
  });
  const branches = branchOptions.data?.items ?? [];

  const toggle = (kind: 'salary' | 'edit', id: string) => {
    setPanel(panel?.kind === kind && panel.id === id ? null : { kind, id });
  };

  const employees = useQuery({
    queryKey: ['hr', 'employees', search, status],
    queryFn: () =>
      listEmployees({
        q: search === '' ? undefined : search,
        status: status === '' ? undefined : status,
      }),
    enabled: mayRead,
  });

  const items = employees.data?.items ?? [];

  return (
    <PermissionGate
      allowed={mayRead}
      explain={{ title: t('hr.deniedTitle'), detail: t('hr.deniedPeople') }}
    >
      <div className="space-y-6">
        <header>
          <h1 className="text-lg font-semibold tracking-tight">{t('hr.people')}</h1>
          <p className="text-sm text-muted-foreground">{t('hr.peopleHint')}</p>
        </header>

        <HrNav />

        <div className="flex flex-wrap items-end gap-3">
          <Field label={t('hr.search')} id="people-search">
            <input
              id="people-search"
              value={search}
              className={`${control} sm:w-72`}
              onChange={(event) => setSearch(event.target.value)}
            />
          </Field>
          <Field label={t('hr.colStatus')} id="people-status">
            <select
              id="people-status"
              value={status}
              className={`${control} sm:w-44`}
              onChange={(event) => setStatus(event.target.value)}
            >
              <option value="">{t('hr.allStatuses')}</option>
              {STATUSES.map((one) => (
                <option key={one} value={one}>
                  {t(`hr.status.${one}` as HrMessageKey)}
                </option>
              ))}
            </select>
          </Field>
        </div>

        <PermissionGate allowed={mayCreate}>
          <NewEmployeeForm branches={branches} orgWide={orgWide} />
        </PermissionGate>

        {employees.isError ? (
          <ErrorState
            title={t('hr.errorTitle')}
            detail={t('hr.errorDetail')}
            action={
              <Button size="sm" variant="secondary" onClick={() => void employees.refetch()}>
                {t('hr.retry')}
              </Button>
            }
          />
        ) : items.length === 0 && !employees.isLoading ? (
          // "Add the first employee" is an instruction only a creator can follow. A role that
          // reads its own record sees an empty list because of row scope, not because the
          // brand has no staff, and telling it to add someone is both wrong and impossible.
          <EmptyState
            title={t('hr.emptyTitle')}
            detail={t(mayCreate ? 'hr.emptyPeople' : 'hr.emptyPeopleReadOnly')}
          />
        ) : (
          <section aria-label={t('hr.people')} className="space-y-2">
            <table className="w-full text-sm">
              <caption className="sr-only">{t('hr.people')}</caption>
              <thead>
                <tr className="border-b border-border text-left text-xs text-muted-foreground">
                  <th scope="col" className="py-2">
                    {t('hr.colCode')}
                  </th>
                  <th scope="col" className="py-2">
                    {t('hr.colName')}
                  </th>
                  <th scope="col" className="py-2">
                    {t('hr.colDesignation')}
                  </th>
                  <th scope="col" className="py-2">
                    {t('hr.colJoined')}
                  </th>
                  <th scope="col" className="py-2">
                    {t('hr.colPayout')}
                  </th>
                  <th scope="col" className="py-2">
                    {t('hr.colPhone')}
                  </th>
                  <th scope="col" className="py-2">
                    {t('hr.colStatus')}
                  </th>
                  <th scope="col" className="py-2" />
                </tr>
              </thead>
              <tbody>
                {items.map((employee) => (
                  <tr key={employee.id} className="h-9 border-b border-border/60">
                    <td className="py-2 tabular-nums">{employee.code}</td>
                    <td className="py-2">{employee.fullName}</td>
                    <td className="py-2 text-muted-foreground">{employee.designation ?? '—'}</td>
                    <td className="py-2 tabular-nums">{employee.joinDate}</td>
                    <td className="py-2">
                      {t(`hr.payout.${employee.payoutMethod}` as HrMessageKey)}
                      {employee.payoutRefMasked === null ? null : (
                        <span className="ml-1 text-muted-foreground tabular-nums">
                          {employee.payoutRefMasked}
                        </span>
                      )}
                    </td>
                    {/* Masked at rest, never unmasked on the way out (invariant 10). */}
                    <td className="py-2 text-muted-foreground tabular-nums">
                      {employee.phoneMasked ?? '—'}
                    </td>
                    <td className="py-2">
                      <StatusBadge tone={STATUS_TONE[employee.status]}>
                        {t(`hr.status.${employee.status}` as HrMessageKey)}
                      </StatusBadge>
                    </td>
                    <td className="py-2 text-right whitespace-nowrap">
                      {mayUpdate ? (
                        <Button
                          size="sm"
                          variant="ghost"
                          aria-expanded={panel?.kind === 'edit' && panel.id === employee.id}
                          onClick={() => toggle('edit', employee.id)}
                        >
                          {t('hr.edit')}
                        </Button>
                      ) : null}
                      <Button
                        size="sm"
                        variant="ghost"
                        aria-expanded={panel?.kind === 'salary' && panel.id === employee.id}
                        onClick={() => toggle('salary', employee.id)}
                      >
                        {t('hr.salary')}
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            {panel?.kind === 'salary' ? (
              <SalaryPanel
                employee={items.find((one) => one.id === panel.id)}
                mayEdit={maySetSalary}
                onSaved={() => void queryClient.invalidateQueries({ queryKey: ['hr'] })}
              />
            ) : null}
            {panel?.kind === 'edit' ? (
              <EditPanelFor
                employee={items.find((one) => one.id === panel.id)}
                branches={branches}
                orgWide={orgWide}
                mayEditPayroll={mayEditPayroll}
                onClose={() => setPanel(null)}
              />
            ) : null}
          </section>
        )}
      </div>
    </PermissionGate>
  );
}

function NewEmployeeForm({
  branches,
  orgWide,
}: {
  readonly branches: readonly BranchOption[];
  readonly orgWide: boolean;
}) {
  const t = useHrT();
  const queryClient = useQueryClient();

  /*
   * The branch, chosen for the caller when there is only one they could pick: a showroom
   * manager with one branch should not have to choose it. `null` until they choose, so
   * the default can follow the options as they load.
   */
  const [chosenBranch, setChosenBranch] = useState<string | null>(null);
  const branchId =
    chosenBranch ?? (!orgWide && branches.length === 1 ? (branches[0]?.id ?? '') : '');
  const [code, setCode] = useState('');
  const [fullName, setFullName] = useState('');
  const [designation, setDesignation] = useState('');
  const [joinDate, setJoinDate] = useState('');
  const [payoutMethod, setPayoutMethod] = useState<PayoutMethod>('cash');
  const [payoutRef, setPayoutRef] = useState('');
  const [nationalId, setNationalId] = useState('');
  const [phone, setPhone] = useState('');

  const submit = useMutation({
    mutationFn: () =>
      createEmployee({
        code: code.trim(),
        fullName: fullName.trim(),
        joinDate,
        ...(designation.trim() === '' ? {} : { designation: designation.trim() }),
        ...(branchId === '' ? {} : { branchId }),
        payoutMethod,
        ...(payoutRef.trim() === '' ? {} : { payoutRef: payoutRef.trim() }),
        ...(nationalId.trim() === '' ? {} : { nationalId: nationalId.trim() }),
        ...(phone.trim() === '' ? {} : { phone: phone.trim() }),
      }),
    onSuccess: () => {
      setCode('');
      setFullName('');
      setDesignation('');
      setPayoutRef('');
      setNationalId('');
      setPhone('');
      void queryClient.invalidateQueries({ queryKey: ['hr', 'employees'] });
    },
  });

  const ready =
    code.trim() !== '' &&
    fullName.trim() !== '' &&
    joinDate !== '' &&
    (orgWide || branchId !== '') &&
    (payoutMethod === 'cash' || payoutRef.trim() !== '') &&
    !submit.isPending;

  return (
    <form
      className="grid gap-3 rounded-lg border border-border bg-card p-4 sm:grid-cols-3"
      onSubmit={(event) => {
        event.preventDefault();
        submit.mutate();
      }}
    >
      <Field label={t('hr.field.code')} id="employee-code">
        <input
          id="employee-code"
          value={code}
          required
          maxLength={32}
          className={control}
          onChange={(event) => setCode(event.target.value)}
        />
      </Field>
      <Field label={t('hr.field.name')} id="employee-name">
        <input
          id="employee-name"
          value={fullName}
          required
          maxLength={160}
          className={control}
          onChange={(event) => setFullName(event.target.value)}
        />
      </Field>
      <Field label={t('hr.field.designation')} id="employee-designation">
        <input
          id="employee-designation"
          value={designation}
          maxLength={80}
          className={control}
          onChange={(event) => setDesignation(event.target.value)}
        />
      </Field>
      <Field label={t('hr.field.branch')} id="employee-branch">
        <BranchSelect
          id="employee-branch"
          value={branchId}
          branches={branches}
          orgWide={orgWide}
          required={!orgWide}
          onChange={setChosenBranch}
        />
      </Field>
      <Field label={t('hr.field.joinDate')} id="employee-join">
        <input
          id="employee-join"
          type="date"
          value={joinDate}
          required
          className={control}
          onChange={(event) => setJoinDate(event.target.value)}
        />
      </Field>
      <Field label={t('hr.field.payoutMethod')} id="employee-payout">
        <select
          id="employee-payout"
          value={payoutMethod}
          className={control}
          onChange={(event) => setPayoutMethod(event.target.value as PayoutMethod)}
        >
          {PAYOUT_METHODS.map((method) => (
            <option key={method} value={method}>
              {t(`hr.payout.${method}` as HrMessageKey)}
            </option>
          ))}
        </select>
      </Field>
      <Field label={t('hr.field.payoutRef')} id="employee-payout-ref" hint={t('hr.privacyHint')}>
        <input
          id="employee-payout-ref"
          value={payoutRef}
          // Required by the server for anything other than cash, and disabled here so the
          // form does not invite a number that would be refused.
          required={payoutMethod !== 'cash'}
          disabled={payoutMethod === 'cash'}
          maxLength={40}
          inputMode="numeric"
          autoComplete="off"
          className={numericControl}
          onChange={(event) => setPayoutRef(event.target.value)}
        />
      </Field>
      <Field label={t('hr.field.nationalId')} id="employee-nid" hint={t('hr.privacyHint')}>
        <input
          id="employee-nid"
          value={nationalId}
          maxLength={40}
          inputMode="numeric"
          autoComplete="off"
          className={numericControl}
          onChange={(event) => setNationalId(event.target.value)}
        />
      </Field>
      <Field label={t('hr.field.phone')} id="employee-phone" hint={t('hr.privacyHint')}>
        <input
          id="employee-phone"
          value={phone}
          maxLength={40}
          inputMode="tel"
          autoComplete="off"
          className={numericControl}
          onChange={(event) => setPhone(event.target.value)}
        />
      </Field>

      <div className="flex items-end gap-3 sm:col-span-3">
        <Button type="submit" size="sm" disabled={!ready}>
          {t('hr.newEmployee')}
        </Button>
        {submit.error === null ? null : (
          <p role="alert" className="text-sm text-destructive">
            {submit.error instanceof ApiError ? submit.error.message : t('hr.saveFailed')}
          </p>
        )}
      </div>
    </form>
  );
}

/**
 * The branch picker both forms share.
 *
 * "No branch" is offered only to an org-wide caller; a branch manager is asked to choose
 * one of theirs. A record's current branch that is not on the list (a branch since closed)
 * is kept as an option, so opening the form does not quietly move the person.
 */
function BranchSelect({
  id,
  value,
  branches,
  orgWide,
  required,
  onChange,
}: {
  readonly id: string;
  readonly value: string;
  readonly branches: readonly BranchOption[];
  readonly orgWide: boolean;
  readonly required: boolean;
  readonly onChange: (branchId: string) => void;
}) {
  const t = useHrT();
  const unlisted = value !== '' && !branches.some((branch) => branch.id === value);
  return (
    <select
      id={id}
      value={value}
      required={required}
      className={control}
      onChange={(event) => onChange(event.target.value)}
    >
      {orgWide ? (
        <option value="">{t('hr.noBranch')}</option>
      ) : (
        <option value="" disabled>
          {t('hr.chooseBranch')}
        </option>
      )}
      {unlisted ? <option value={value}>{t('hr.unlistedBranch')}</option> : null}
      {branches.map((branch) => (
        <option key={branch.id} value={branch.id}>
          {branch.code} · {branch.name}
        </option>
      ))}
    </select>
  );
}

const PROBLEM_MESSAGE: Readonly<Record<EmployeePatchProblem, HrMessageKey>> = {
  nothingChanged: 'hr.editNothingChanged',
  nameRequired: 'hr.editNameRequired',
  payoutRefRequired: 'hr.editPayoutRefRequired',
};

/** The edit panel for one row, keyed on it so opening another employee starts a fresh form. */
function EditPanelFor({
  employee,
  ...rest
}: {
  readonly employee: Employee | undefined;
  readonly branches: readonly BranchOption[];
  readonly orgWide: boolean;
  readonly mayEditPayroll: boolean;
  readonly onClose: () => void;
}) {
  if (employee === undefined) return null;
  return <EditPanel key={employee.id} employee={employee} {...rest} />;
}

/**
 * Change an employee after they were added (m30-followups).
 *
 * Everyone who may update the record sees the record half: name, designation, department,
 * branch, status and leaving date. The payroll half — how and where they are paid, their
 * phone and national ID, and the sign-in linked to them — is shown only to `update Payroll`
 * (D-363), and is write-only: an empty field keeps what is on file, because the server never
 * sends the plain value back to fill it.
 */
function EditPanel({
  employee,
  branches,
  orgWide,
  mayEditPayroll,
  onClose,
}: {
  readonly employee: Employee;
  readonly branches: readonly BranchOption[];
  readonly orgWide: boolean;
  readonly mayEditPayroll: boolean;
  readonly onClose: () => void;
}) {
  const t = useHrT();
  const queryClient = useQueryClient();
  const [form, setForm] = useState<EmployeeEditForm>(() => editFormFor(employee));
  const [problem, setProblem] = useState<EmployeePatchProblem | null>(null);
  const [saved, setSaved] = useState(false);

  const logins = useQuery({
    queryKey: ['hr', 'login-options'],
    queryFn: listLoginOptions,
    enabled: mayEditPayroll,
    staleTime: 60_000,
  });

  function set<K extends keyof EmployeeEditForm>(key: K, value: EmployeeEditForm[K]): void {
    setSaved(false);
    setProblem(null);
    setForm((current) => ({ ...current, [key]: value }));
  }

  const save = useMutation({
    mutationFn: async (): Promise<Employee | null> => {
      const result = employeePatch(employee, form, mayEditPayroll);
      if (result.problem !== null) {
        setProblem(result.problem);
        return null;
      }
      return updateEmployee(employee.id, result.patch);
    },
    onSuccess: (updated) => {
      if (updated === null) return;
      setSaved(true);
      setForm(editFormFor(updated));
      void queryClient.invalidateQueries({ queryKey: ['hr'] });
    },
  });

  const loginItems = logins.data?.items ?? [];
  const currentLoginUnlisted =
    form.userId !== '' && !loginItems.some((login) => login.userId === form.userId);
  const prefix = `employee-edit-${employee.id}`;
  const keep = (masked: string | null) => `${masked ?? '—'} · ${t('hr.keepHint')}`;

  return (
    <section
      aria-label={`${t('hr.editTitle')} — ${employee.fullName}`}
      className="space-y-3 rounded-lg border border-border bg-card p-4"
    >
      <header>
        <h2 className="text-sm font-semibold">
          {t('hr.editTitle')} — {employee.fullName}
        </h2>
        <p className="text-xs text-muted-foreground">{t('hr.editHint')}</p>
      </header>

      <form
        className="grid gap-3 sm:grid-cols-3"
        onSubmit={(event) => {
          event.preventDefault();
          save.mutate();
        }}
      >
        <Field label={t('hr.field.name')} id={`${prefix}-name`}>
          <input
            id={`${prefix}-name`}
            value={form.fullName}
            required
            maxLength={160}
            className={control}
            onChange={(event) => set('fullName', event.target.value)}
          />
        </Field>
        <Field label={t('hr.field.designation')} id={`${prefix}-designation`}>
          <input
            id={`${prefix}-designation`}
            value={form.designation}
            maxLength={80}
            className={control}
            onChange={(event) => set('designation', event.target.value)}
          />
        </Field>
        <Field label={t('hr.field.department')} id={`${prefix}-department`}>
          <input
            id={`${prefix}-department`}
            value={form.department}
            maxLength={80}
            className={control}
            onChange={(event) => set('department', event.target.value)}
          />
        </Field>
        <Field label={t('hr.field.branch')} id={`${prefix}-branch`}>
          <BranchSelect
            id={`${prefix}-branch`}
            value={form.branchId}
            branches={branches}
            orgWide={orgWide}
            required={!orgWide}
            onChange={(value) => set('branchId', value)}
          />
        </Field>
        <Field label={t('hr.colStatus')} id={`${prefix}-status`}>
          <select
            id={`${prefix}-status`}
            value={form.status}
            className={control}
            onChange={(event) => set('status', event.target.value as EmploymentStatus)}
          >
            {STATUSES.map((one) => (
              <option key={one} value={one}>
                {t(`hr.status.${one}` as HrMessageKey)}
              </option>
            ))}
          </select>
        </Field>
        <Field label={t('hr.field.leaveDate')} id={`${prefix}-leave`}>
          <input
            id={`${prefix}-leave`}
            type="date"
            value={form.leaveDate}
            className={control}
            onChange={(event) => set('leaveDate', event.target.value)}
          />
        </Field>

        {mayEditPayroll ? (
          <>
            <Field label={t('hr.field.payoutMethod')} id={`${prefix}-payout`}>
              <select
                id={`${prefix}-payout`}
                value={form.payoutMethod}
                className={control}
                onChange={(event) => set('payoutMethod', event.target.value as PayoutMethod)}
              >
                {PAYOUT_METHODS.map((method) => (
                  <option key={method} value={method}>
                    {t(`hr.payout.${method}` as HrMessageKey)}
                  </option>
                ))}
              </select>
            </Field>
            <Field
              label={t('hr.field.payoutRef')}
              id={`${prefix}-payout-ref`}
              hint={keep(employee.payoutRefMasked)}
            >
              <input
                id={`${prefix}-payout-ref`}
                value={form.payoutRef}
                disabled={form.payoutMethod === 'cash'}
                maxLength={40}
                inputMode="numeric"
                autoComplete="off"
                className={numericControl}
                onChange={(event) => set('payoutRef', event.target.value)}
              />
            </Field>
            <Field label={t('hr.field.login')} id={`${prefix}-login`}>
              <select
                id={`${prefix}-login`}
                value={form.userId}
                className={control}
                onChange={(event) => set('userId', event.target.value)}
              >
                <option value="">{t('hr.notLinked')}</option>
                {currentLoginUnlisted ? (
                  <option value={form.userId}>{t('hr.unlistedLogin')}</option>
                ) : null}
                {loginItems.map((login) => {
                  const elsewhere =
                    login.linkedEmployeeId !== null && login.linkedEmployeeId !== employee.id;
                  return (
                    <option key={login.userId} value={login.userId} disabled={elsewhere}>
                      {login.name} · {login.emailMasked}
                      {elsewhere ? ` (${t('hr.linkedElsewhere')})` : ''}
                    </option>
                  );
                })}
              </select>
            </Field>
          </>
        ) : null}

        {/* Personal details any editor of the record may set, as on the add form. */}
        <Field label={t('hr.field.phone')} id={`${prefix}-phone`} hint={keep(employee.phoneMasked)}>
          <input
            id={`${prefix}-phone`}
            value={form.phone}
            maxLength={40}
            inputMode="tel"
            autoComplete="off"
            className={numericControl}
            onChange={(event) => set('phone', event.target.value)}
          />
        </Field>
        <Field
          label={t('hr.field.nationalId')}
          id={`${prefix}-nid`}
          hint={keep(employee.nationalIdMasked)}
        >
          <input
            id={`${prefix}-nid`}
            value={form.nationalId}
            maxLength={40}
            inputMode="numeric"
            autoComplete="off"
            className={numericControl}
            onChange={(event) => set('nationalId', event.target.value)}
          />
        </Field>

        <div className="flex flex-wrap items-end gap-3 sm:col-span-3">
          <Button type="submit" size="sm" disabled={save.isPending}>
            {t('hr.save')}
          </Button>
          <Button type="button" size="sm" variant="ghost" onClick={onClose}>
            {t('hr.cancel')}
          </Button>
          {problem === null ? null : (
            <p role="alert" className="text-sm text-destructive">
              {t(PROBLEM_MESSAGE[problem])}
            </p>
          )}
          {save.error === null ? null : (
            <p role="alert" className="text-sm text-destructive">
              {save.error instanceof ApiError ? save.error.message : t('hr.saveFailed')}
            </p>
          )}
          {saved ? (
            <p role="status" className="text-sm text-muted-foreground">
              {t('hr.saved')}
            </p>
          ) : null}
        </div>
      </form>
    </section>
  );
}

function SalaryPanel({
  employee,
  mayEdit,
  onSaved,
}: {
  readonly employee: Employee | undefined;
  readonly mayEdit: boolean;
  readonly onSaved: () => void;
}) {
  const t = useHrT();
  const [effectiveFrom, setEffectiveFrom] = useState('');
  const [basic, setBasic] = useState('');
  const [allowanceLabel, setAllowanceLabel] = useState('');
  const [allowance, setAllowance] = useState('');

  const structures = useQuery({
    queryKey: ['hr', 'salary', employee?.id],
    queryFn: () => listStructures(employee?.id ?? ''),
    enabled: employee !== undefined,
  });

  const save = useMutation({
    mutationFn: () => {
      const basicPoisha = takaToPoisha(basic);
      if (basicPoisha === null) throw new ApiError(400, null, t('hr.saveFailed'));
      const allowancePoisha = allowance.trim() === '' ? null : takaToPoisha(allowance);
      return setStructure(employee?.id ?? '', {
        effectiveFrom,
        basicPoisha,
        components:
          allowancePoisha === null
            ? []
            : [
                {
                  direction: 'earning',
                  // A stable code the payslip groups by; the label is what people read.
                  code: 'house_rent',
                  label: allowanceLabel.trim() === '' ? 'House rent' : allowanceLabel.trim(),
                  amountPoisha: allowancePoisha,
                },
              ],
      });
    },
    onSuccess: () => {
      setBasic('');
      setAllowance('');
      void structures.refetch();
      onSaved();
    },
  });

  if (employee === undefined) return null;

  return (
    <section
      aria-label={t('hr.salary')}
      className="space-y-3 rounded-lg border border-border bg-card p-4"
    >
      <header>
        <h2 className="text-sm font-semibold">
          {t('hr.salary')} — {employee.fullName}
        </h2>
        <p className="text-xs text-muted-foreground">{t('hr.salaryHint')}</p>
      </header>

      <table className="w-full text-sm">
        <caption className="sr-only">{t('hr.salary')}</caption>
        <thead>
          <tr className="border-b border-border text-left text-xs text-muted-foreground">
            <th scope="col" className="py-2">
              {t('hr.field.effectiveFrom')}
            </th>
            <th scope="col" className="py-2">
              {t('hr.colComponent')}
            </th>
            <th scope="col" className="py-2 text-right">
              {t('hr.colAmount')}
            </th>
            <th scope="col" className="py-2">
              {t('hr.colProrated')}
            </th>
          </tr>
        </thead>
        <tbody>
          {(structures.data?.items ?? []).flatMap((structure) => [
            <tr key={structure.id} className="h-9 border-b border-border/60">
              <td className="py-2 tabular-nums">{structure.effectiveFrom}</td>
              <td className="py-2">{t('hr.field.basic')}</td>
              <td className="py-2 text-right">
                <Money poisha={structure.basicPoisha} />
              </td>
              <td className="py-2 text-muted-foreground">{t('hr.yes')}</td>
            </tr>,
            ...structure.components.map((component) => (
              <tr
                key={`${structure.id}-${component.code}`}
                className="h-9 border-b border-border/60"
              >
                <td className="py-2" />
                <td className="py-2 text-muted-foreground">
                  {component.label} (
                  {t(component.direction === 'earning' ? 'hr.earning' : 'hr.deduction')})
                </td>
                <td className="py-2 text-right">
                  <Money poisha={component.amountPoisha} />
                </td>
                <td className="py-2 text-muted-foreground">
                  {component.prorated ? t('hr.yes') : t('hr.no')}
                </td>
              </tr>
            )),
          ])}
        </tbody>
      </table>

      <PermissionGate allowed={mayEdit}>
        <form
          className="grid gap-3 sm:grid-cols-4"
          onSubmit={(event) => {
            event.preventDefault();
            save.mutate();
          }}
        >
          <Field label={t('hr.field.effectiveFrom')} id="salary-from">
            <input
              id="salary-from"
              type="date"
              value={effectiveFrom}
              required
              className={control}
              onChange={(event) => setEffectiveFrom(event.target.value)}
            />
          </Field>
          <Field label={t('hr.field.basic')} id="salary-basic">
            <input
              id="salary-basic"
              value={basic}
              required
              inputMode="decimal"
              className={numericControl}
              onChange={(event) => setBasic(event.target.value)}
            />
          </Field>
          <Field label={t('hr.field.allowance')} id="salary-allowance-label">
            <input
              id="salary-allowance-label"
              value={allowanceLabel}
              maxLength={60}
              className={control}
              onChange={(event) => setAllowanceLabel(event.target.value)}
            />
          </Field>
          <Field label={t('hr.colAmount')} id="salary-allowance">
            <input
              id="salary-allowance"
              value={allowance}
              inputMode="decimal"
              className={numericControl}
              onChange={(event) => setAllowance(event.target.value)}
            />
          </Field>
          <div className="flex items-end gap-3 sm:col-span-4">
            <Button
              type="submit"
              size="sm"
              disabled={effectiveFrom === '' || basic.trim() === '' || save.isPending}
            >
              {t('hr.save')}
            </Button>
            {save.error === null ? null : (
              <p role="alert" className="text-sm text-destructive">
                {save.error instanceof ApiError ? save.error.message : t('hr.saveFailed')}
              </p>
            )}
          </div>
        </form>
      </PermissionGate>
    </section>
  );
}
