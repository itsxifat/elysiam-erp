# Milestone plans

The `/milestone` skill writes one plan here per milestone (`M07.md`, …) before any code changes, and the human approves it.

Keep plans after the work is merged. They record what was intended, and later sessions read them when resuming a milestone.

## Keeping them true

- Every milestone that has been started has a file here. In continuous build mode the approval pause is skipped, but the plan file is not.
- Each plan ends with a dated `## Status on <date>` section. Update it whenever the milestone's state changes: built, verified, audited, or a gap found.
- An agent given a milestone writes the plan file first.

## Plans written after the build

M07, M09, M10, M11, M12, M13, M15, M19 and M25 were built by parallel agents between 2026-09-26 and 2026-09-29 without plan files. Their plans were written on 2026-09-30 from the code, the migrations and the decision rows, and each says so at the top. They record the plan as it was executed, including the defects found in review.

## Index

| Plan | Milestone                          | State on 2026-10-02                                    |
| ---- | ---------------------------------- | ------------------------------------------------------ |
| M00  | Repo bootstrap and toolchain       | done                                                   |
| M01  | Database core and isolation        | done                                                   |
| M02a | Identity, auth, request context    | done                                                   |
| M02b | Permissions, audit, approvals      | done                                                   |
| M03  | Ledger core                        | done                                                   |
| M04  | Platform services                  | done                                                   |
| M05  | Console shell and UI kit           | done; quality checks run against the real stack        |
| M06  | Catalog                            | built, re-audit owed                                   |
| M07  | Stock ledger and costing           | built, re-audit owed                                   |
| M08  | Accounts and wallets               | done; money screens and wallet setup added 2026-10-01  |
| M09  | Suppliers and purchasing           | built, re-audit owed                                   |
| M10  | Order core                         | built, re-audit owed                                   |
| M11  | Order desk, buyer list, intake     | done; acceptance-auditor READY                         |
| M12  | Courier v1 and COD reconciliation  | built, Steadfast adapter unverified                    |
| M13  | Fraud check v1                     | removed by the owner, code deleted (D-291)             |
| M14a | Data migration, opening balances   | done; both auditors READY, accountant sign-off owed    |
| M15  | Multi-courier, tracking            | built, Pathao and RedX adapters unverified (D-200)     |
| M16  | Buyer profiles, notify, promo      | done; both auditors READY                              |
| M17  | Advance payments, return reasons   | built and verified; both auditors run (see the plan)   |
| M18  | Marketing                          | built and verified; Meta adapters unverified (D-257)   |
| M19  | HR, attendance, payroll            | built, re-audit owed                                   |
| M20  | Targets, bonus rules, productivity | done; ledger audit fixed, acceptance-auditor READY     |
| M23  | Branches and showroom POS          | done; integrated, ledger audit fixed                   |
| M24  | Analytics, dashboards, leaderboard | done; ledger audit fixed, acceptance-auditor READY     |
| M25  | Investors                          | done; portal pages built 2026-10-02 (see the plan)     |
| M26  | Company loans                      | built and verified; both auditors run (see the plan)   |
| —    | Preview kit (`preview-kit.md`)     | done; ledger audit fixed and re-audited (see the plan) |

Not a milestone: `gaps-orders-settings.md`, the console gaps M30's research found (order lifecycle buttons, courier statuses that ship an order, the settings screens, HR's pay picker; D-390 to D-396); `m30-followups.md`, M30 part 1's open medium findings, its two named races and the console gaps its guides found (D-411 to D-419); `catalog-stock-ux.md`, the owner's "no easy way" to add products, manage stock and the catalog: a product page that is the hub, a one-form new product, catalog setup, a product importer and easier stock screens (D-420 to D-432); built and verified 2026-10-03, ledger-auditor 0 critical, 0 warnings; and `design-refresh.md`, the owner-requested redesign of the console, the investor portal and the till: the tokens, the shell, the command palette, the kit components and the main screens (D-440 to D-449 and D-451 to D-463; D-450 is the reseller hotfix).

| Plan            | Milestone                                   | State on 2026-10-02                                    |
| --------------- | ------------------------------------------- | ------------------------------------------------------ |
| M00             | Repo bootstrap and toolchain                | done                                                   |
| M01             | Database core and isolation                 | done                                                   |
| M02a            | Identity, auth, request context             | done                                                   |
| M02b            | Permissions, audit, approvals               | done                                                   |
| M03             | Ledger core                                 | done                                                   |
| M04             | Platform services                           | done                                                   |
| M05             | Console shell and UI kit                    | done; quality checks run against the real stack        |
| M06             | Catalog                                     | built, re-audit owed                                   |
| M07             | Stock ledger and costing                    | built, re-audit owed                                   |
| M08             | Accounts and wallets                        | done; money screens and wallet setup added 2026-10-01  |
| M09             | Suppliers and purchasing                    | built, re-audit owed                                   |
| M10             | Order core                                  | built, re-audit owed                                   |
| M11             | Order desk, buyer list, intake              | done; acceptance-auditor READY                         |
| M12             | Courier v1 and COD reconciliation           | built, Steadfast adapter unverified                    |
| M13             | Fraud check v1                              | removed by the owner, code deleted (D-291)             |
| M14a            | Data migration, opening balances            | done; both auditors READY, accountant sign-off owed    |
| M15             | Multi-courier, tracking                     | built, Pathao and RedX adapters unverified (D-200)     |
| M16             | Buyer profiles, notify, promo               | done; both auditors READY                              |
| M17             | Advance payments, return reasons            | built and verified; both auditors run (see the plan)   |
| M18             | Marketing                                   | built and verified; Meta adapters unverified (D-257)   |
| M19             | HR, attendance, payroll                     | built, re-audit owed                                   |
| M20             | Targets, bonus rules, productivity          | done; ledger audit fixed, acceptance-auditor READY     |
| M23             | Branches and showroom POS                   | done; integrated, ledger audit fixed                   |
| M24             | Analytics, dashboards, leaderboard          | done; ledger audit fixed, acceptance-auditor READY     |
| M25             | Investors                                   | done; portal pages built 2026-10-02 (see the plan)     |
| M26             | Company loans                               | built and verified; both auditors run (see the plan)   |
| gaps-users-auth | Staff accounts and sign-in (M30 admin gaps) | built and verified; ledger audit and re-audit fixed    |
| M30             | Hardening and launch readiness              | part 1 built; ledger audit fixed; part 2 needs staging |
| m30-followups   | M30's open mediums, races and console gaps  | built and verified; ledger audit and re-audit fixed    |

Part-built: M30 (part 2 waits for staging, D-360) and M14b. Removed from scope by the owner: M27 Chatwoot and M29 landing page builder (D-290), M13 fraud check with its code (D-291), M28 activity extension (D-292). M21 and M22, the Beownz reseller platform, are out of scope by the client's instruction.

The plain-language summary with percentages is `docs/build-status.md`.

## Wave 3 (D-469, from 2026-10-05)

One ERP per brand, the mother ERP, and each brand's website run from its ERP. Overview:
`wave3.md`.

| Plan | Milestone                                     | State on 2026-10-05                            |
| ---- | --------------------------------------------- | ---------------------------------------------- |
| M31  | One ERP per brand (brand edition)             | done (merged 2954f50)                          |
| M32  | The mother ERP                                | done 2026-10-08; not deployed (needs a server) |
| M33  | Website catalog and content from the ERP      | done (merged faf12bd)                          |
| M34  | Website buying: checkout, accounts, payment   | built (branch `m34-buying`)                    |
| M35  | Website offers, landing pages, tracking, ncom | M35a done (merged 4e500db), M35b planned       |
| M36  | New Elysium website on the ERP                | planned (starts empty; optional customers)     |
| M37  | Go live: brand servers, mother, switch-over   | planned                                        |
| M38  | Barcode stickers, strict stock, scan-to-pack  | done 2026-10-08; live on both brands           |
