---
paths:
  - "apps/server/src/**"
  - "packages/db/**"
  - "packages/contracts/src/permissions/**"
---
# Tenancy and permission rules
- Every new tenant table needs:
  - `org_id NOT NULL` with an FK and an index
  - RLS set to ENABLE and FORCE, with the standard isolation policy
  - the minimum grants for `erp_app`; append-only tables get INSERT and SELECT only
  - coverage by the RLS guard test, which enumerates every table automatically
- Tenant queries run inside `withOrg()`. Raw SQL lives only in repositories, is parameterized, and is never built by string interpolation.
- The `erp_analytics` pool is only for the analytics module and super-admin consolidated reads.
- Every route declares its ability check. Every response passes through `serializeFor()`. New sensitive fields go into the protected-field lists in `packages/contracts`.
- Money-moving actions go through the approvals module whenever the org's threshold requires it.
- Every mutation must write an audit entry. The interceptor does this, so never bypass it.
- Realtime events go only through the outbox. Their payloads contain ids plus only fields that every recipient role may see.
- External calls never happen inside a transaction. Enqueue a job with `enqueue(tx, …)` instead.
