/**
 * M25's investor rules (architecture §7's posting-rules table, §15): capital
 * arriving, profit declared, and either kind of money paid out.
 *
 * An aggregator beside the three rule files rather than three lines in
 * `./index.ts`, because that barrel is edited by several milestones in this
 * working tree at once and a second write to it silently discards the first. It
 * is also what `@elysium/domain/posting/investors` resolves to, so the server
 * module can import the rules before the barrel has been merged. The integrator
 * adds **one** line to `./index.ts` — `export * from './investors.js';` — and not
 * the three files individually: exporting both would give the root barrel two
 * paths to each name, which TypeScript refuses as ambiguous.
 */
export * from './investor-capital.js';
export * from './investor-payment.js';
export * from './profit-distribution.js';
