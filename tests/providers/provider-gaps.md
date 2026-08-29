# Provider coverage boundaries

The provider matrix is executable documentation. It records every shared
driver contract as `run` or `waive`; this file explains the remaining fixture
boundaries.

- **D1 binding:** local Workers-pool tests prove bound parameters, normalized
  rows, and native-batch rollback. Shared relational contracts still need a
  D1-specific schema lifecycle fixture.
- **Neon HTTP:** a credential-free deterministic fetch fixture crosses the real
  Neon SDK decoder and proves typed decimal scalar/list materialization. The
  credential-gated endpoint remains connectivity-only; PostgreSQL SQL semantics
  are owned by the shared PostgreSQL contracts rather than simulated by the
  fixture.
- **PlanetScale:** the ordinary endpoint sentinel is connectivity-only. A
  separate credential-gated, read-only fixture proves decimal introspection,
  exact typed scalar/list reads, filtering, ordering, and aggregates when its
  URL, namespace, and table variables are all configured. It does not prove
  effectful decimal arithmetic or VibORM-driven schema setup.
- **Bun SQL / Bun SQLite:** the probes execute in Bun and validate the platform
  boundary. Bun SQL fixed-decimal evidence additionally needs
  `PG_TEST_CONNECTION_STRING`; Bun SQLite needs no external service. Their
  broader SQL behavior is owned by the canonical PostgreSQL and SQLite provider
  contracts.

The repository does not expose a `d1-http` driver. Adding such a suite would
first require an authorized production API change, which this reorganization
does not make.

Missing credentials, Docker endpoints, or Bun produce named skips. A provider
must never disappear silently from direct execution.
