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
// M08's wallet movements (§7): cash out and petty cash, transfers between the
// org's own wallets, and a daily closing variance.
export * from './cash-out.js';
export * from './closing-variance.js';
export * from './wallet-transfer.js';
// M07's stock movements (§7): purchase cost entering the system, stock leaving it
// at weighted average, and the two adjustments that need an approval.
// M14a: the opening-balance journal, whose equity line is a declared plug (D-213).
export * from './opening-balance.js';
export * from './supply-received.js';
export * from './supplier-return.js';
export * from './handover.js';
export * from './stock-adjustment.js';
// M09's supplier cash (§7): an advance paid, an advance applied to a received
// supply, and a payment against what is owed. The receipt and the return live
// above, with the stock movements they are paired with.
export * from './supplier-payment.js';
// M10's order rules (§7): the journal that recognises revenue on delivery (D-003),
// the return that puts its value back, the exchange that turns a delivered sale into a
// credit, and the advance a low-trust buyer pays before the parcel moves.
export * from './order-delivered.js';
export * from './order-return.js';
export * from './order-exchange.js';
export * from './customer-advance.js';
// The aggregator, not the three files individually: exporting both would give the
// root barrel two paths to each name (TS2308).
export * from './investors.js';
// M12's courier settlement (§7): the charges the courier kept, and the net it paid across.
export * from './courier-settlement.js';
// M19's payroll journals (§7): the month's salary becoming a liability, the cash that
// settles it, and a staff loan going out to an employee.
export * from './payroll-posted.js';
export * from './employee-loan.js';
// M26's company loans (§7): the principal received from a lender, and an instalment
// repaid, split into what reduces the debt and the interest it cost.
export * from './company-loan.js';
