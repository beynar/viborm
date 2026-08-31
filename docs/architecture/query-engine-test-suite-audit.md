# Query-engine test-suite audit

## Contract inventory

The query-engine estate is organized by the proof it owns, not by the database
that happens to execute it.

| Proof family | Owner | Required boundary |
|---|---|---|
| SQL and fragment structure | builders, operation shells, fragment validator | compiler only |
| Scalar and bulk result shape | operation shell and result parser | direct execution plus structural controls |
| Nested create and selected update | record compilers and relation parts | transaction and atomic batch |
| Membership and junction effects | relation link/write/junction parts | transaction and atomic batch |
| Guards, pins, retries, wrong-row protection | executor and relation owner | committed staleness or corruption harness |
| Provider syntax and error attribution | adapter and driver boundary | matching provider |
| DDL, lifecycle, and destructive behavior | migration or driver owner | isolated database |

The fast query-engine layer contains representative structural and behavioral
sentinels. It is not a coverage substitute. The dedicated write-engine coverage
project selects the complete credential-free write estate, including core query
and architecture sentinels.

## Fixture policy

`usePGliteSchemaFamily` is the ordinary PGlite owner. It creates one database,
pushes one schema, records the public tables, truncates them with
`RESTART IDENTITY` before each test, and disconnects once after the suite.
`useBehaviorDatabase` routes PGlite behavior runners through this owner while
leaving external provider factories isolated.

Inside a parity test, every arm calls `reset()` before seeding. Across tests,
the family `beforeEach` owns the reset. A borrowed client never disconnects the
family database. Transaction and atomic-batch drivers remain distinct because
their guard, planning, and atomicity contracts differ.

Fresh databases are limited to these semantic classes:

- migration or DDL state;
- connection lifecycle or database-isolation behavior;
- destructive schema behavior;
- independently committed concurrency;
- staleness and race injection;
- rollback semantics whose observation would be invalid under reuse.

`staleness-injection.test.ts` is the canonical full fresh-database family.
Fresh cases also remain beside focused pin and replacement-race witnesses in
create, to-one create/update, parent lookup, and depth suites. A fresh database
is not used merely because a test is extended or complex.

## Coverage and runtime

The routing defect that produced the earlier 40% report is closed: the dedicated
project selects all local write files rather than six core sentinels. The
2026-08-07 authoritative run reports:

| Metric | Result |
|---|---:|
| Runnable tests | 2,388 passed |
| Provider-only tests | 209 skipped visibly |
| Statements / lines | 93.00% |
| Branches | 90.12% |
| Functions | 98.90% |
| Wall time | 223.53–232.92 seconds across two complete runs |
| Peak process-group RSS | 2,465.4 MiB worst observed |

The prior full run took roughly 13–14 minutes. The fast 68% selection was
rejected because it omitted meaningful behavior. The speedup instead comes from
changing fixture cardinality: repeated schema creation became one push per
compatible family while every test and execution substrate stayed selected.

The repository-wide coverage selection completed in 267.88 seconds, so it keeps
the full write-engine estate and uses the same five-minute wall limit. That
measurement ended red on one instrumentation attribution assertion outside the
query-engine scope; the focused instrumentation file passed immediately in
1.19 seconds. The timing budget is proven, but this audit does not claim that
unrelated combined-order failure is fixed.

Static source counts are not runtime lifecycle counts. The initial audit found
187 literal `new PGlite()` sites and 226 `await push()` sites in the write
estate; after the family migration those counts are 183 and 203. The much larger
runtime reduction comes from behavior runners and parity arms that previously
executed the same setup once per test or arm.

## Execution discipline

- Run large selections through the memory-capped launchers.
- Run only one Vitest, layer runner, or TypeScript process group at a time.
- The focused write command is `pnpm test:coverage:write-engine`; its disjoint
  projects are a memory boundary, and the merged report is authoritative.
- The dedicated command has a five-minute wall limit and one fork.
- Docker-only PostgreSQL and MySQL witnesses skip visibly when unavailable; a
  local skip is not a provider pass.
