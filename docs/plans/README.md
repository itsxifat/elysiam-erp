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

| Plan | Milestone                         | State on 2026-10-02                                   |
| ---- | --------------------------------- | ----------------------------------------------------- |
| M00  | Repo bootstrap and toolchain      | done                                                  |
| M01  | Database core and isolation       | done                                                  |
| M02a | Identity, auth, request context   | done                                                  |
| M02b | Permissions, audit, approvals     | done                                                  |
| M03  | Ledger core                       | done                                                  |
| M04  | Platform services                 | done                                                  |
| M05  | Console shell and UI kit          | done; quality checks run against the real stack       |
| M06  | Catalog                           | built, re-audit owed                                  |
| M07  | Stock ledger and costing          | built, re-audit owed                                  |
| M08  | Accounts and wallets              | done; money screens and wallet setup added 2026-10-01 |
| M09  | Suppliers and purchasing          | built, re-audit owed                                  |
| M10  | Order core                        | built, re-audit owed                                  |
| M11  | Order desk, buyer list, intake    | done; acceptance-auditor READY                        |
| M12  | Courier v1 and COD reconciliation | built, Steadfast adapter unverified                   |
| M13  | Fraud check v1                    | removed by the owner, code deleted (D-291)            |
| M14a | Data migration, opening balances  | done; both auditors READY, accountant sign-off owed   |
| M15  | Multi-courier, tracking           | built, Pathao and RedX adapters unverified (D-200)    |
| M16  | Buyer profiles, notify, promo     | done; both auditors READY                             |
| M17  | Advance payments, return reasons  | built and verified; both auditors run (see the plan)  |
| M18  | Marketing                         | built and verified; Meta adapters unverified (D-257)  |
| M19  | HR, attendance, payroll           | built, re-audit owed                                  |
| M23  | Branches and showroom POS         | done; integrated, ledger audit fixed                  |
| M25  | Investors                         | built, investor portal pages missing                  |
| M26  | Company loans                     | built and verified; both auditors run (see the plan)  |

Not started: M14b, M20, M24, M30. Removed from scope by the owner: M27 Chatwoot and M29 landing page builder (D-290), M13 fraud check with its code (D-291), M28 activity extension (D-292). M21 and M22, the Beownz reseller platform, are out of scope by the client's instruction.

The plain-language summary with percentages is `docs/build-status.md`.
