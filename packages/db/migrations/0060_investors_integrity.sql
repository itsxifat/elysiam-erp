-- What the investors schema refuses, in the database (M25; architecture §7, §15).
--
-- Every rule below is also checked by the service that writes these rows. The
-- duplication is deliberate and it is the same argument invariants 1 and 2 rest
-- on: a service can be refactored, called from a worker, or bypassed by the next
-- module that needs "just one row"; a trigger cannot. This is investor money, so
-- the database holds the arithmetic too.
--
-- Each raises a message beginning with a code from
-- `packages/contracts/src/errors.ts`, so the module's `databaseInvestorsCode()`
-- turns a refusal into a 4xx a caller can act on rather than a 500 and a
-- constraint name.

-- 1. A distribution's lines sum to exactly its declared total.
--
-- Deferred to commit, because the lines are written after the row they belong to
-- — the same shape as the ledger's own balance check (0014). Two triggers, for the
-- same reason: the one on `distributions` catches a distribution inserted with no
-- lines at all (no line trigger would ever fire for it), the one on
-- `distribution_lines` catches every line added afterwards.
--
-- This is the split invariant, in the database. The journal is one debit for the
-- total and one credit per investor, so shares that do not sum to the total cannot
-- post — and a poisha quietly dropped by a future caller that computed the split
-- itself would otherwise reach a person as "the distribution could not be
-- declared" with no way to find out why. Here it names the numbers.
create or replace function investors.assert_distribution_split() returns trigger
language plpgsql as $$
declare
  v_distribution uuid;
  v_total bigint;
  v_allocated bigint;
  v_lines integer;
  v_status text;
begin
  -- An `if`, not a `case` expression. PL/pgSQL evaluates a `case` as one SQL
  -- expression, so `case … then new.id else new.distribution_id end` fails at
  -- runtime on whichever table lacks the other's column — "record new has no
  -- field distribution_id", from the trigger that is supposed to protect the
  -- split. Two branches, two statements.
  if tg_table_name = 'distributions' then
    v_distribution := new.id;
  else
    v_distribution := new.distribution_id;
  end if;

  select total_poisha, status::text into v_total, v_status
  from investors.distributions
  where id = v_distribution;

  -- The distribution was deleted in this transaction, which nothing may do
  -- anyway; there is nothing left to check.
  if not found then
    return null;
  end if;

  -- A rejected declaration has no money in it: its lines are the record of what
  -- was proposed, and holding them to the total would make a rejection
  -- unrecordable.
  if v_status = 'rejected' then
    return null;
  end if;

  select count(*), coalesce(sum(amount_poisha), 0) into v_lines, v_allocated
  from investors.distribution_lines
  where distribution_id = v_distribution;

  if v_lines = 0 then
    raise exception 'INVESTOR_SPLIT_INVALID: distribution % has no investors', v_distribution
      using errcode = 'check_violation';
  end if;
  if v_allocated <> v_total then
    raise exception 'INVESTOR_SPLIT_INVALID: distribution % allocates % poisha of a declared %',
      v_distribution, v_allocated, v_total
      using errcode = 'check_violation';
  end if;

  return null;
end;
$$;--> statement-breakpoint

drop trigger if exists distributions_split_balanced on "investors"."distributions";--> statement-breakpoint
create constraint trigger distributions_split_balanced
  after insert on "investors"."distributions"
  deferrable initially deferred
  for each row execute function investors.assert_distribution_split();--> statement-breakpoint

drop trigger if exists distribution_lines_split_balanced on "investors"."distribution_lines";--> statement-breakpoint
create constraint trigger distribution_lines_split_balanced
  after insert on "investors"."distribution_lines"
  deferrable initially deferred
  for each row execute function investors.assert_distribution_split();--> statement-breakpoint

-- 2. A distribution line's investor belongs to the distribution's own org, and the
-- line cannot be added to a distribution that has already been decided.
--
-- The second half is the one that matters: a line inserted after the journal was
-- posted would make the recorded shares disagree with the credits on an immutable
-- journal, and the deferred check above would not catch it — it runs in the
-- transaction that adds the line, which would then fail *for the wrong reason*
-- (the sum) instead of saying the distribution is closed.
create or replace function investors.assert_distribution_line() returns trigger
language plpgsql as $$
declare
  v_status text;
begin
  select status::text into v_status
  from investors.distributions
  where org_id = new.org_id and id = new.distribution_id;

  if not found then
    raise exception 'INVESTOR_NOT_FOUND: no such distribution in this organization'
      using errcode = 'foreign_key_violation';
  end if;
  if v_status <> 'pending_approval' then
    raise exception 'INVESTOR_DISTRIBUTION_FROZEN: distribution % is % and its shares are fixed',
      new.distribution_id, v_status
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;--> statement-breakpoint

create trigger distribution_lines_assert_shape
before insert on "investors"."distribution_lines"
for each row execute function investors.assert_distribution_line();--> statement-breakpoint

-- 3. A contribution's wallet account really is a wallet, and the investor is
-- active.
--
-- The wallet check is the cheap half. The active check is the point: capital
-- posted against an investor who has exited would credit equity to somebody the
-- org has settled with, and nothing downstream would question it — the journal
-- balances and the party exists.
create or replace function investors.assert_investment() returns trigger
language plpgsql as $$
declare
  v_subtype text;
  v_status text;
begin
  select subtype::text into v_subtype
  from ledger.accounts
  where org_id = new.org_id and id = new.wallet_account_id;

  if not found then
    raise exception 'LEDGER_ACCOUNT_INVALID: no such ledger account in this organization'
      using errcode = 'foreign_key_violation';
  end if;
  if v_subtype not like 'wallet\_%' then
    raise exception 'LEDGER_ACCOUNT_INVALID: capital arrives in a wallet, not a % account', v_subtype
      using errcode = 'check_violation';
  end if;

  select status::text into v_status
  from investors.investors
  where org_id = new.org_id and id = new.investor_id;

  -- `not found` as well as the status: a null `v_status` would make the
  -- comparison below NULL, which is not `true`, so the check would pass.
  if not found then
    raise exception 'INVESTOR_NOT_FOUND: no such investor in this organization'
      using errcode = 'foreign_key_violation';
  end if;
  if v_status <> 'active' then
    raise exception 'INVESTOR_INACTIVE: investor % has exited', new.investor_id
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;--> statement-breakpoint

create trigger investments_assert_shape
before insert on "investors"."investments"
for each row execute function investors.assert_investment();--> statement-breakpoint

-- 4. A withdrawal's wallet account is a wallet, and the amount, the investor and
-- the kind are fixed from the moment the row exists.
--
-- Freezing the terms is what makes the approval mean something. Without it,
-- UPDATE — which the row needs for its four-step path — would also let the amount
-- be raised after a checker approved the smaller one, and the payment would post
-- the new number. `approvals.approval_requests` freezes the request's own terms
-- (0009); this freezes the row the request points at, which is where the money
-- actually comes from.
create or replace function investors.assert_withdrawal_path() returns trigger
language plpgsql as $$
declare
  v_allowed boolean;
  v_subtype text;
begin
  if new.wallet_account_id is not null then
    select subtype::text into v_subtype
    from ledger.accounts
    where org_id = new.org_id and id = new.wallet_account_id;

    if not found then
      raise exception 'LEDGER_ACCOUNT_INVALID: no such ledger account in this organization'
        using errcode = 'foreign_key_violation';
    end if;
    if v_subtype not like 'wallet\_%' then
      raise exception 'LEDGER_ACCOUNT_INVALID: an investor is paid from a wallet, not a % account',
        v_subtype
        using errcode = 'check_violation';
    end if;
  end if;

  if tg_op = 'INSERT' then
    if new.status <> 'requested' then
      raise exception 'INVESTOR_WITHDRAWAL_FROZEN: a withdrawal starts as requested'
        using errcode = 'check_violation';
    end if;
    return new;
  end if;

  -- The terms a checker saw. `is distinct from` rather than `<>`, so a column
  -- going null or leaving null is caught too.
  if new.investor_id is distinct from old.investor_id
     or new.kind is distinct from old.kind
     or new.amount_poisha is distinct from old.amount_poisha
     or new.requested_by is distinct from old.requested_by
     or new.requested_at is distinct from old.requested_at then
    raise exception 'INVESTOR_WITHDRAWAL_FROZEN: the investor, kind and amount of a withdrawal are fixed'
      using errcode = 'check_violation';
  end if;

  -- The only transitions there are. Everything else — paid back to reviewed, a
  -- rejected row revived, an approval swapped for another — is refused, including
  -- for the owner role.
  v_allowed := (old.status = 'requested' and new.status in ('reviewed', 'rejected'))
            or (old.status = 'reviewed' and new.status in ('approved', 'rejected'))
            or (old.status = 'approved' and new.status = 'paid');

  if not v_allowed then
    raise exception 'INVESTOR_WITHDRAWAL_FROZEN: a % withdrawal cannot become %',
      old.status, new.status
      using errcode = 'check_violation';
  end if;

  if old.approval_request_id is not null
     and new.approval_request_id is distinct from old.approval_request_id then
    raise exception 'INVESTOR_WITHDRAWAL_FROZEN: the approval that decided this withdrawal is fixed'
      using errcode = 'check_violation';
  end if;
  -- Frozen once set rather than always, because review is what sets it. After
  -- that it is the account a checker approved a payment *from*: if it could still
  -- change on the way to `paid`, "approve this payment" would not have said which
  -- money leaves, and only the service would have stood between an approval for a
  -- bank transfer and a payment out of the showroom till.
  if old.wallet_account_id is not null
     and new.wallet_account_id is distinct from old.wallet_account_id then
    raise exception 'INVESTOR_WITHDRAWAL_FROZEN: the account a withdrawal is paid from is fixed once reviewed'
      using errcode = 'check_violation';
  end if;
  if old.journal_id is not null and new.journal_id is distinct from old.journal_id then
    raise exception 'INVESTOR_WITHDRAWAL_FROZEN: the journal of a paid withdrawal is fixed'
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;--> statement-breakpoint

create trigger withdrawals_assert_path
before insert or update on "investors"."withdrawals"
for each row execute function investors.assert_withdrawal_path();--> statement-breakpoint

-- 5. A distribution moves along its own one-way path, and its total never changes.
--
-- Same argument as the withdrawal: the total is what a checker approved and what
-- the journal's debit line says, and the journal cannot be edited to follow it.
create or replace function investors.assert_distribution_path() returns trigger
language plpgsql as $$
begin
  if new.total_poisha is distinct from old.total_poisha
     or new.basis is distinct from old.basis
     or new.period_starts_on is distinct from old.period_starts_on
     or new.period_ends_on is distinct from old.period_ends_on then
    raise exception 'INVESTOR_DISTRIBUTION_FROZEN: the period, basis and total of a distribution are fixed'
      using errcode = 'check_violation';
  end if;
  if old.status <> 'pending_approval' then
    raise exception 'INVESTOR_DISTRIBUTION_FROZEN: a % distribution cannot be changed', old.status
      using errcode = 'check_violation';
  end if;
  if new.status not in ('declared', 'rejected') then
    raise exception 'INVESTOR_DISTRIBUTION_FROZEN: a waiting distribution is either declared or rejected'
      using errcode = 'check_violation';
  end if;
  if new.approval_request_id is distinct from old.approval_request_id then
    raise exception 'INVESTOR_DISTRIBUTION_FROZEN: the approval that decided this distribution is fixed'
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;--> statement-breakpoint

create trigger distributions_assert_path
before update on "investors"."distributions"
for each row execute function investors.assert_distribution_path();--> statement-breakpoint

-- 6. An investor's login is theirs alone, and an exited investor stays exited.
--
-- The unique index in 0058 already refuses two investors of one org sharing a
-- login. This adds the thing an index cannot say: the same login must not be
-- moved onto a *different* investor row later, because `own` scope resolves
-- through `user_id` and re-pointing it hands one person another person's history.
create or replace function investors.assert_investor_identity() returns trigger
language plpgsql as $$
begin
  if old.user_id is not null and new.user_id is distinct from old.user_id then
    raise exception 'INVESTOR_IMMUTABLE: an investor’s login cannot be moved once it is set'
      using errcode = 'check_violation';
  end if;
  if old.code is distinct from new.code then
    raise exception 'INVESTOR_IMMUTABLE: an investor’s code is fixed'
      using errcode = 'check_violation';
  end if;
  if old.status = 'exited' and new.status <> 'exited' then
    raise exception 'INVESTOR_IMMUTABLE: an investor who has exited is not reinstated; add a new one'
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;--> statement-breakpoint

create trigger investors_assert_identity
before update on "investors"."investors"
for each row execute function investors.assert_investor_identity();--> statement-breakpoint

-- 7. A document's investor, investment and file are fixed; only its title moves.
create or replace function investors.assert_document_frozen() returns trigger
language plpgsql as $$
begin
  if to_jsonb(new) - 'title' - 'updated_at' <> to_jsonb(old) - 'title' - 'updated_at' then
    raise exception 'INVESTOR_IMMUTABLE: only a document’s title may change'
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;--> statement-breakpoint

create trigger investor_documents_frozen
before update on "investors"."documents"
for each row execute function investors.assert_document_frozen();--> statement-breakpoint

-- 8. Nothing in this schema is ever deleted.
--
-- The grants in 0059 are the control; this is the backstop for a future grant
-- written by hand, and it applies to every role including the owner. An investor's
-- money is a record, and a record that can be removed is not one.
create or replace function investors.refuse_delete() returns trigger
language plpgsql as $$
begin
  raise exception 'INVESTOR_IMMUTABLE: rows in % are never deleted; mark exited or reverse instead',
    tg_table_name
    using errcode = 'check_violation';
end;
$$;--> statement-breakpoint

create trigger investors_refuse_delete before delete on "investors"."investors"
for each row execute function investors.refuse_delete();--> statement-breakpoint

create trigger investments_refuse_delete before delete on "investors"."investments"
for each row execute function investors.refuse_delete();--> statement-breakpoint

create trigger distributions_refuse_delete before delete on "investors"."distributions"
for each row execute function investors.refuse_delete();--> statement-breakpoint

create trigger distribution_lines_refuse_delete before delete on "investors"."distribution_lines"
for each row execute function investors.refuse_delete();--> statement-breakpoint

create trigger withdrawals_refuse_delete before delete on "investors"."withdrawals"
for each row execute function investors.refuse_delete();--> statement-breakpoint

create trigger investor_documents_refuse_delete before delete on "investors"."documents"
for each row execute function investors.refuse_delete();
