/**
 * Posting rules (architecture §7 "Posting rules (canonical)").
 *
 * One pure function per business event, each returning a `JournalDraft` for
 * `ledger.post`. Each has a fast-check test proving it balances for random
 * inputs and a worked example with hand-computed numbers
 * (.claude/rules/money-and-ledger.md). M03 ships the first, to prove the
 * pipeline; the owning milestones add the rest.
 */
export * from './cash-in.js';
