# V1 Release Closure

## Status

Release-readiness record, updated 2026-08-30. The database namespace, exact
decimal, authenticated migration V1, stable GeoPoint, approximate-number
rename, and upstream defect-closure programs are merged into `main`.

The remaining release program is operational: close the final public package
contract, enforce provider evidence, install the publication pipeline, and
complete the RC-to-stable rehearsal. [Releasing VibORM](../../RELEASING.md) is
the maintainer-owned publication and recovery runbook.

## Verdict

VibORM has enough ORM capability for V1. No further large query-engine,
relation, scalar, or migration program is required before the release.

The remaining work is a release-closure program:

1. cut the final public package and API contract;
2. prove or accurately tier every advertised provider;
3. install an enforceable build and publication pipeline;
4. make the public documentation executable; and
5. complete one release-candidate rehearsal.

Full-text search, recursive queries, complete RBAC, and the other deferred
features in this record are not V1 blockers.

## 1. Migration estate integrity — implemented

The canonical implementation program is
[Migration V1: Authenticated State Graph and Safe Push](./migration-v1-plan.md),
backed by the current Prisma/Drizzle/source research in
[Migration V1 Systems Research](./migration-v1-systems-research.md).

The implemented system replaces the mutable global journal and latest snapshot
with an immutable target descriptor, content-addressed snapshots and SQL,
atomically published state manifests, a database current-state marker, and an
append-only execution ledger. It also closes SQL framing, branch convergence,
live drift, non-transactional recovery, baseline, rollback, and stale push
consent as one coherent program.

That dedicated implementation supersedes the namespace plan's proposed
version-3 journal shape, but retains its exact migration target, bound driver,
pinned session, lock, containment, and reset decisions. V1 is unreleased, so it
ships no legacy journal reader or conversion layer.

## 2. Final public API cut

V1 must contain one current language rather than compatibility surfaces already
scheduled for deletion.

Remove or explicitly adjudicate before the API freeze:

- the deprecated string overloads of `$queryRaw` and `$executeRaw`;
- the deprecated exported `QueryMetadata` alias;
- legacy migration resolver APIs beside the unified resolver language;
- legacy cache-key helpers that are not a supported extension-author surface;
- broad migration internals such as the raw differ, serializer, snapshot, and
  DDL machinery; and
- every other public symbol whose only reason is pre-V1 compatibility.

The exact retained exports must be intentional and pinned through the built
package. Add a golden entry-point/member inventory and declaration comparison so
an accidental export becomes a failing change rather than a new public promise.

### GeoPoint scalar — implemented

`s.point()` and `v.point()` now form one stable GeoPoint language with exact
public values, query operators, provider tiers, migration behavior, result
types, executed provider evidence, and public documentation. Conditional and
preview providers remain named as such; their narrower evidence must not be
promoted by the release pipeline.

## 3. Provider qualification and support tiers

V1 must not advertise every stock driver as equally proven when their evidence
differs.

The current provider matrix gives broad shared contracts to the principal local
and Docker providers. Its documented boundaries remain:

- D1 proves its Workers transport and native batch boundary but lacks a shared
  schema-lifecycle fixture;
- hosted Neon HTTP and PlanetScale tests are read-only sentinels;
- Bun SQL and Bun SQLite principally prove their runtime boundary; and
- some postgres.js behavior delegates to the canonical PostgreSQL fixture.

Before V1, choose one honest outcome per provider:

1. run representative schema, CRUD, relation, scalar, transaction/batch, raw,
   error, namespace, decimal, and migration contracts on the actual provider; or
2. label the provider preview/experimental and state its narrower evidence.

The release support table must distinguish database-family equivalence from a
provider contract actually executed on that provider.

### LibSQL migration safety

The LibSQL migration driver records that native `ALTER COLUMN` validates future
writes but not existing rows. Tightening nullability, type, or another constraint
can therefore leave stored rows outside the declared model domain.

Before LibSQL can claim full production migration support, each affected change
must either:

- prevalidate all existing rows and then alter;
- use the proven SQLite reconstruction path; or
- refuse before effects with the exact unsupported transition.

V1 must not publish a non-null result type over a table that migration work left
with existing null values.

### Runtime and compiler floors

Define and test the actual support contract:

- the Node.js versions supported by the root package and each Node-only driver;
- the minimum TypeScript version required by emitted declarations;
- ESM-only packaging;
- Bun versions for both Bun providers; and
- the Workers compatibility date/runtime used by D1.

The package now promises Node `>=22` and TypeScript `5.8+`. Both floors are
tested against the built declarations; TypeScript 5.0 was measured and refused
the public client types with TS2589/TS2590, so the earlier claim was retired.

## 4. Release and publication pipeline

V1 requires the automated release gate specified by
[Releasing VibORM](../../RELEASING.md). Publication uses a manually authorized
workflow on protected `main`, one exact tested tarball, npm OIDC trusted
publishing, registry verification, and a final immutable GitHub release.

Required jobs are:

- public type tests;
- core and coverage gates;
- package build and packed-install tests;
- documentation validation and executable examples;
- local PGlite, SQLite3, and LibSQL providers;
- Docker PostgreSQL, postgres.js, and MySQL2 providers;
- Bun SQL and Bun SQLite runtime jobs;
- the D1 Workers job;
- the deterministic Neon HTTP transport contract; and
- Node 22/24 plus TypeScript 5.8/current package-floor probes.

Hosted Neon remains conditional and PlanetScale remains preview in the public
support tables, so absent hosted credentials do not produce a counterfeit
green release job. Their hosted legs become required when those tiers are
promoted. Fixed-decimal, namespace, and GeoPoint performance evidence belongs
to the V1 RC report; noisy cross-provider benchmarks are not rerun as a package
publication authority.

Protect `main` with the required release checks. Publication must build from a
clean protected commit, inspect the tarball, install that exact tarball in fresh
consumer projects, run the CLI, and only then publish it. `dist` from a
developer worktree must never be accepted as publication input. The workflow
creates the version tag only after npm accepts and verifies the package.

MIT, the root `LICENSE`, repository/homepage/issue metadata, changelog,
deterministic package allowlist, and size budgets are now checked release
facts. npm trusted publishing, the protected GitHub environment, branch rules,
and immutable releases remain one-time repository settings documented in the
maintainer runbook.

## 5. Executable documentation and release candidate

Navigation and frontmatter validation do not prove that a code example compiles.
The public quick start currently calls `push(orm, schema)`, although the second
argument is the push options object.

Create an example gate that compiles or executes the canonical snippets for:

- installation and each supported driver;
- schema declaration and relations;
- push and file migrations;
- CRUD, nested writes, raw SQL, transactions, and extensions;
- fixed decimals and decimal arrays;
- PostgreSQL/MySQL namespaces;
- cache and instrumentation; and
- Schema JSON.

The documentation freeze must publish:

- one current capability matrix;
- one provider support-tier matrix;
- exact provider transaction and migration limitations;
- the extension trust and RBAC non-claim;
- a V1 error-code reference;
- physical naming and namespace rules; and
- a `0.1.0` to `1.0.0` upgrade guide covering every breaking API and storage
  change, without adding compatibility aliases merely for the guide.

Publish `1.0.0-rc.1` under the `next` tag before `latest`. Rehearse fresh install,
upgrade, push, generate, apply, down, reset, tampered-estate refusal, and
interrupted-generation recovery on PostgreSQL, MySQL, and SQLite plus at least
one edge provider. Fix release blockers, repeat the rehearsal, then publish
`1.0.0`.

## Explicit post-V1 work

These are valuable capabilities, but none is required for a truthful V1:

- full-text search and relevance ordering;
- recursive queries;
- complete graph-wide RBAC;
- arbitrary extension-driven input/result type mutation and computed fields;
- database introspection into TypeScript schemas (`db pull`);
- Studio and first-class seeding commands;
- views and read-only models;
- first-class reusable prepared-query handles;
- cross-namespace relations, per-query namespace switching, or SQLite
  attachments;
- CJS packaging;
- broader Prisma parity where VibORM already documents and rejects a smaller
  safe subset; and
- lifting the remaining classified write-engine refusals.

The residual `UnsupportedOperationError` census is not a release backlog. Those
sites are retained only where the engine lacks a required identity, atomicity
proof, or non-contradictory assignment. Each must remain fail-closed and
falsified, but their mere existence does not block V1.

## Remaining execution order

1. Freeze the final export inventory and remove or explicitly retain every
   transitional public spelling.
2. Establish the release-blocking provider matrix and prove every required job
   executes rather than silently skips.
3. Install CI, exact-tarball publication, package metadata, the chosen license,
   trusted publishing, and immutable releases.
4. Make the remaining documentation examples executable and publish the
   `0.1.0` upgrade guide.
5. Run `1.0.0-rc.1`, repair only release blockers, and repeat the complete gate
   with a later RC when needed.
6. Publish `1.0.0` through the same gate.

## Completion criteria

VibORM is ready for V1 only when all of these are true:

1. Namespace and fixed-decimal completion criteria are fully green.
2. Exact state, SQL, transition, parameter, and snapshot bytes are
   authenticated before effects.
3. The state graph, current marker, and append-only ledger agree with the live
   managed schema.
4. Interrupted state publication is atomic in visibility and recoverable.
5. Generated and manual SQL cannot be split by textual delimiter accidents.
6. Push consent is plan-specific, reset dry-run is effect-free, and final live
   state is verified.
7. LibSQL cannot publish a stricter model domain over unvalidated existing rows.
8. No intentionally transitional API remains in the V1 public surface.
9. `point` is either removed or supported as a complete stable scalar.
10. Every advertised provider has executed evidence matching its support tier.
11. Runtime, compiler, module, and platform floors are accurate and tested.
12. Required CI and branch-protection gates enforce the release contract.
13. The packed tarball and CLI pass fresh-consumer installation tests.
14. License and package metadata are internally consistent.
15. Canonical documentation examples compile or execute.
16. The `0.1.0` to V1 upgrade guide covers every breaking contract.
17. One complete release-candidate rehearsal succeeds on the declared provider
    matrix.
18. No open correctness, data-loss, security, or publication blocker remains.

At that point, further feature development should not delay V1.
