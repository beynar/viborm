# Provider coverage boundaries

The provider matrix is executable documentation. It records every shared
driver contract as `run` or `waive`; this file explains the remaining fixture
boundaries.

- **D1 binding:** local Workers-pool tests prove bound parameters, normalized
  rows, and native-batch rollback. Shared relational contracts still need a
  D1-specific schema lifecycle fixture.
- **Neon HTTP:** a credential-gated, read-only endpoint sentinel proves the
  transport and result contract. It does not create shared contract tables.
- **PlanetScale:** a credential-gated, read-only endpoint sentinel proves the
  transport and result contract. It does not create shared contract tables.
- **Bun SQL / Bun SQLite:** the probes execute in Bun and validate the platform
  boundary. Their SQL behavior is owned by the canonical PostgreSQL and SQLite
  provider contracts.

The repository does not expose a `d1-http` driver. Adding such a suite would
first require an authorized production API change, which this reorganization
does not make.

Missing credentials, Docker endpoints, or Bun produce named skips. A provider
must never disappear silently from direct execution.
