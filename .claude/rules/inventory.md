---
paths:
  - 'apps/server/src/modules/inventory/**'
  - 'packages/domain/src/inventory/**'
  - 'packages/db/src/schema/inventory/**'
---

# Inventory rules

- Every stock change does two things in the same transaction: inserts a `stock_movements` row and updates `stock_levels`.
- Reserve stock with the conditional UPDATE (`on_hand - reserved >= qty`).
  - Zero rows updated means `STOCK_INSUFFICIENT`.
  - Never read and then write.
- WAC is per org and SKU.
  - It changes only on supply receipts and customer returns (at dispatch cost).
  - Transfers never change cost.
- Movement kinds are a closed enum. Adding a kind requires two doc updates: architecture §8 and a row in decisions.md.
- Any concurrency-sensitive change needs a test that runs parallel transactions against real Postgres (Testcontainers).
- Cost and stock value are returned only to roles with `read:cost`.
