-- The payroll approval has to be an approval *of this run* (M19; D-072, D-078).
--
-- ## What the other layers already do, and what they cannot
--
-- `ApprovalsService.request` refuses a `payroll_run` request from a role that may not
-- raise one (D-072: hr and org_admin), and `decide` refuses a checker who may not
-- decide one (D-062: hr and org_admin, never a branch manager). The payroll service
-- raises the request with `amountDerivedByServer: true` and the net total it computed
-- itself, so the org's threshold may apply to it — that is the whole reason the flag
-- exists.
--
-- What no layer above the database can check is whether the request a run points at
-- is *for* that run at that amount. `approval_requests.amount_poisha` is supplied by
-- the requesting module, and the approvals module cannot look at a payroll run and
-- know what it is worth. The gap matters here more than anywhere else in the system:
-- a run that named a ৳2,000 request while paying out ৳7,73,148 would be approved by
-- whoever glanced at the small number.
--
-- So the link is checked from the payroll side, where both rows are visible: a run
-- that names an approval must name a `payroll_run` request, in the same org, for the
-- same net amount. The trigger sits on `hr.payroll_runs` rather than on the request
-- because the request is written first — the service raises the approval, then records
-- what it is for.
--
-- This is deliberately not redundant with D-078 ("the executor reads the approval's
-- amount and nothing else"). D-078 governs what gets *paid*; this governs what was
-- *judged*. Without it, a mismatched pair is approved and then refuses to post, and
-- what is left is a pending run nobody can clear.

create or replace function hr.assert_run_approval() returns trigger
language plpgsql as $$
declare
  req record;
begin
  if new.approval_request_id is null then
    -- 0053's status CHECK already refuses `pending_approval`, `posted` and `paid`
    -- without an approval; a draft or a cancelled run has nothing to compare.
    return new;
  end if;

  select type::text as type, amount_poisha, amount_derived_by_server, branch_id
    into req
  from approvals.approval_requests
  where org_id = new.org_id and id = new.approval_request_id;

  if not found then
    raise exception 'PAYROLL_APPROVAL_INVALID: that approval request does not exist in this organization.';
  end if;
  if req.type <> 'payroll_run' then
    raise exception 'PAYROLL_APPROVAL_INVALID: a payroll run needs a payroll_run request, not a %.', req.type;
  end if;
  if req.amount_poisha is distinct from new.net_poisha then
    raise exception 'PAYROLL_APPROVAL_INVALID: that approval is for a different amount than the run it would post.';
  end if;
  /*
   * The amount must be the server's, not a number somebody typed (D-072).
   *
   * `payroll_run` is in SERVER_DERIVED_AMOUNT_TYPES, so a request raised through the
   * generic `POST /v1/approvals` is held for an org admin regardless of threshold —
   * but "held" is about who decides, not about what the amount is. A run pointed at
   * such a request would be posting an amount a person chose. Refused here, because
   * the flag is the only evidence of where the number came from.
   */
  if req.amount_derived_by_server is not true then
    raise exception 'PAYROLL_APPROVAL_INVALID: a payroll run must be approved against the amount the system computed, not one that was typed.';
  end if;
  /*
   * A payroll run is org-level, so its approval must be too.
   *
   * §12 has one run per org per month and its journal splits the expense by branch
   * from each payslip. A branch-scoped request would be decidable by that branch's
   * manager under D-062's branch tier — and paying every brand's staff is not a
   * branch item. `payroll_run` is absent from BRANCH_ITEM_APPROVAL_TYPES for the same
   * reason; this is that absence made unbypassable.
   */
  if req.branch_id is not null then
    raise exception 'PAYROLL_APPROVAL_INVALID: a payroll run covers the whole organization, so its approval cannot be scoped to one branch.';
  end if;

  return new;
end;
$$;--> statement-breakpoint

create trigger payroll_runs_assert_approval
before insert or update of approval_request_id, net_poisha
on hr.payroll_runs
for each row execute function hr.assert_run_approval();--> statement-breakpoint

-- A run's stored totals must be the sum of its own payslips.
--
-- `payroll_runs.net_poisha` is what the approval is compared against, and it is a
-- column rather than a derivation on purpose (a checker agreed to a number, and the
-- number has to exist). The cost of that choice is that it can disagree with the
-- lines, and everything downstream — the approval, the journal, the payment — trusts
-- it. So the two are reconciled at the end of the statement that submits the run.
--
-- A *constraint* trigger, deferred to commit, because the run's totals and its lines
-- are written in one transaction and requiring a particular order would make every
-- call site depend on an invisible rule. Deferred also means the check sees the
-- finished set of lines rather than a partial one.
create or replace function hr.assert_run_totals_match_lines() returns trigger
language plpgsql as $$
declare
  agg record;
begin
  if new.status = 'draft' then
    -- A draft has no lines yet. Its totals are zero by default and are written by
    -- the submit, which is the transition this check applies to.
    return new;
  end if;

  select count(*)::int as n,
         coalesce(sum(gross_poisha), 0) as gross,
         coalesce(sum(deductions_poisha), 0) as deductions,
         coalesce(sum(net_poisha), 0) as net
    into agg
  from hr.payroll_lines
  where org_id = new.org_id and run_id = new.id;

  if agg.n <> new.employee_count
     or agg.gross <> new.gross_poisha
     or agg.deductions <> new.deductions_poisha
     or agg.net <> new.net_poisha then
    raise exception 'PAYROLL_TOTALS_MISMATCH: the run''s totals (% employees, net %) do not match its payslips (% employees, net %).',
      new.employee_count, new.net_poisha, agg.n, agg.net;
  end if;

  return new;
end;
$$;--> statement-breakpoint

create constraint trigger payroll_runs_totals_match_lines
after insert or update on hr.payroll_runs
deferrable initially deferred
for each row execute function hr.assert_run_totals_match_lines();--> statement-breakpoint

-- Σ of a payslip's component rows is the payslip.
--
-- The payslip PDF is rendered from the components and the net is printed from the
-- line, so a component set that does not add up to the line is a document that
-- contradicts itself — handed to the employee it is about. Deferred for the same
-- reason as above: the line and its components are one insert batch.
create or replace function hr.assert_line_components_match() returns trigger
language plpgsql as $$
declare
  earn bigint;
  deduct bigint;
begin
  select coalesce(sum(case when direction = 'earning' then amount_poisha else 0 end), 0),
         coalesce(sum(case when direction = 'deduction' then amount_poisha else 0 end), 0)
    into earn, deduct
  from hr.payroll_line_components
  where org_id = new.org_id and line_id = new.id;

  if earn <> new.gross_poisha or deduct <> new.deductions_poisha then
    raise exception 'PAYROLL_TOTALS_MISMATCH: that payslip''s lines add up to % earnings and % deductions, but the payslip says % and %.',
      earn, deduct, new.gross_poisha, new.deductions_poisha;
  end if;
  return new;
end;
$$;--> statement-breakpoint

create constraint trigger payroll_lines_components_match
after insert on hr.payroll_lines
deferrable initially deferred
for each row execute function hr.assert_line_components_match();--> statement-breakpoint

-- A loan deduction on a payslip must be the instalment it says it is.
--
-- Two facts have to agree: the amount recorded against the instalment, and the
-- `loan_deduction_poisha` on the payslip that the journal credits
-- `employee_loan_receivable` with. If they diverge, the ledger clears a different
-- amount of the employee's loan than the payslip took off their pay — and both
-- documents look right on their own.
create or replace function hr.assert_line_loans_match() returns trigger
language plpgsql as $$
declare
  taken bigint;
begin
  select coalesce(sum(amount_poisha), 0) into taken
  from hr.payroll_loan_deductions
  where org_id = new.org_id and line_id = new.id;

  if taken <> new.loan_deduction_poisha then
    raise exception 'PAYROLL_TOTALS_MISMATCH: that payslip deducts % for loans but names instalments totalling %.',
      new.loan_deduction_poisha, taken;
  end if;
  return new;
end;
$$;--> statement-breakpoint

create constraint trigger payroll_lines_loans_match
after insert on hr.payroll_lines
deferrable initially deferred
for each row execute function hr.assert_line_loans_match();
