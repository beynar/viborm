# Nested Write Hosted Provider Gaps

Local conformance covers PGlite, batch-only PGlite, SQLite3, and LibSQL with
the shared `nested-write-behavior` spec. Batch-only PGlite exercises the same
planned nested-write path used by atomic batch drivers such as D1 and Neon HTTP.

MySQL is covered by `mysql2.test.ts` when a docker MySQL is available (set
`MYSQL_TEST_CONNECTION_STRING` and run `pnpm test:mysql`).

Hosted/external execution suites are not added in this phase because this
repository does not currently provide stable local fixtures or credentials for:

- D1
- Neon HTTP
- PlanetScale

These are hosted coverage blockers, not provider-specific public contract
differences. A hosted driver must prove the same atomic nested-write behavior in
a stable suite. A driver that supports neither callback transactions nor atomic
batch must reject nested writes before the parent mutation.

## Resolved: self-relation filters in updateMany/deleteMany on MySQL

MySQL error 1093 ("You can't specify target table for update in FROM clause")
used to break `updateMany`/`deleteMany` with self-relation filters (e.g.
`user.updateMany({ where: { reports: { some: ... } } })`). The query engine now
wraps relation-filter subqueries that select from the mutated table in a
derived table when `capabilities.supportsMutationTargetInSubquery` is false
(requires MySQL 8.0.14+ for outer references in derived tables). Covered by
the self-relation section of `relation-filter-mutation-behavior`, which runs
on all local drivers and on docker MySQL via `pnpm test:mysql`.
