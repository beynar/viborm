# RQ-00 — contract and baseline ledger

**Status (2026-09-22): independently reviewed and accepted.** This is the
execution-ready handoff for RQ-01. It freezes the approved contract; it does
not claim that public recursion is implemented or qualified.

Canonical contract: [recursive-query.md](../../../../features-docs/recursive-query.md).
Historical baseline evidence remains in
[compact-found-consumption.md](../compact-found-consumption.md); its 41 archived
payloads are not copied or relabeled here.

## Frozen baseline

| Fact | Recorded value |
| --- | --- |
| Current source | `076fad02b1c77435ce7389a51996163c66aad819` |
| Measured checkpoint | `bd264d329221f1c6257aac264fedd59c413707e6` |
| Common parent / subject | `8346e15daa8688fc5d834ccfe0321491580ef993` / `refactor(raptor3): share rules and fuse exact found consumption` |
| Runtime | `/Users/arnaud/.vite-plus/js_runtime/node/24.21.0/bin/node`; Node `24.21.0`; Darwin arm64; V8 `13.6.233.17-node.53`; modules `137`; N-API `10` |
| Package manager | pnpm `10.11.0` |
| Dependency identity | `pnpm-lock.yaml` SHA-256 `c366c9806e268e19970626c34e0c5ea1bb74cc7c24b388fa072d580d7bf9aceb` |
| Installed execution/toolchain pins | PGlite `0.3.2`; better-sqlite3 `12.6.0`; mysql2 `3.16.1`; pg `8.22.0`; postgres `3.4.8`; Vitest `3.1.4`; TypeScript `5.9.3`; Decimal.js `10.6.0` |

The current and measured commits have identical objects for `src`
(`2f7858ad676d67f9d299b25c3f49bd54f5b75a92`), `tests`
(`4b02232da30b128a8d697c8eeac1459d39b703fc`), `scripts`
(`b8f91796272dc51e94efc79f7e760defe24ed344`) and `benchmarks`
(`63f383607dadd33c8a87a98e728d5a20b47a8baa`). Their working-tree content also
matches both commits. `package.json`, `pnpm-lock.yaml`, `vitest.workspace.ts`
and `tsconfig.json` match both commits. Thus the accepted checkpoint's full
type, provider, source and performance receipts remain the baseline; RQ-00 did
not spend resources repeating them.

## Public placement matrix

| Public call or position | `select` | `include` | RQ contract |
| --- | --- | --- | --- |
| `findUnique`, `findUniqueOrThrow` | Supported | Supported | `recurse` may modify an eligible relation node at the root or below another ordinary relation node. |
| `findFirst`, `findFirstOrThrow` | Supported | Supported | Same; root pagination remains ordinary and does not become recursive pagination. |
| `findMany` | Supported | Supported | Same for every returned root; roots remain independent occurrences. |
| `create`, `update`, `upsert` | Supported | Supported | Same projection language on the existing post-write readback route. No recursion is admitted in mutation `data`. |
| `delete` | Supported | Supported | Same projection language on the existing pre-delete snapshot route. |
| `createMany`, `updateMany`, `deleteMany` | Scalar-only; recursion forbidden | Forbidden | Their optional row result is scalar-only. Relation keys and `_count` remain invalid in `select`; `include` remains invalid. |
| `count`, `exist`, `aggregate`, `groupBy` | Forbidden | Forbidden | These operations do not admit an ordinary row-relation projection, so they do not acquire recursion. |
| Nested ordinary relation node | Supported | Supported | Any supported placement may alternate `select` and `include` through ordinary nodes. Other eligible recursive slots may occur in the repeated node projection. |
| Asking slot inside its own repeated node | Forbidden | Forbidden | Admission must reject an explicit second producer of that same output key. |
| Top-level operation key / mutation input | Forbidden | Forbidden | There is no top-level `recurse`, recursive mutation language, public CTE verb or fallback route. |

The operation list comes from
[`find.ts`](../../../../src/validation/model/args/find.ts),
[`mutation.ts`](../../../../src/validation/model/args/mutation.ts),
[`bulk-write-projection.ts`](../../../../src/validation/model/args/bulk-write-projection.ts)
and the public aliases/result cardinalities in
[`client/types.ts`](../../../../src/client/types.ts). Ordinary nested node
vocabulary comes from
[`select-include.ts`](../../../../src/validation/relations/select-include.ts).

### Relation-node vocabulary

| Slot | Admitted with `recurse` | Still refused with `recurse` |
| --- | --- | --- |
| Singular | `select`, `include`, `omit` | `where`, `orderBy`, `take`, `skip`, `cursor`, `distinct`, `preventCycles` |
| Collection | `where`, `orderBy`, `select`, `include`, `omit` | `take`, `skip`, `cursor`, `distinct` |

Without `recurse`, the existing collection node keeps `take`, `skip`, `cursor`
and `distinct`. `true`, `{}` and omitted nested `depth` normalize to 100;
numeric depth is an integer 1–1000; `depth: false` is exhaustive. Graph
`preventCycles` defaults to true and may be false only for bounded traversal.
`recurse: undefined` is ordinary omission; public `recurse: false` is invalid.

## Contract and ownership matrix

| Contract area | Frozen behavior | Implementation owner | Required witness |
| --- | --- | --- | --- |
| Eligibility and identity (§2.1) | Actual self-model identity, complete primary row key; FK-owning `toOne`, proven one-to-one inverse, child-direction FK `toMany`, or paired self-junction `toMany`/`toMany`. Reject non-self, variants, unresolved topology and incomplete keys. Preserve physical identity domains. | [`relation-resolution.ts`](../../../../src/schema/validation/relation-resolution.ts) supplies `ResolvedSlot`; extend the existing static membership view and prepared relation admission, never rescan topology. | Runtime positives for every shape; compound/mapped/alternate-reference keys; structurally identical non-self negative; static positive and fail-closed probes. |
| Syntax and normalization (§2.2) | One normalized cutoff/cycle meaning; reject invalid numbers, FK cycle options, and exhaustive graph without prevention before cache/provider work. | Existing relation-node schemas in [`select-include.ts`](../../../../src/validation/relations/select-include.ts), then prepared relation projection. | Public-call type and runtime admission table, including non-fresh inputs and no-dispatch negatives. |
| Projection/filter/order (§2.3) | Repeat one ordinary node projection at every level; collection filter applies at every hop; sibling order is per parent with provider ordering and complete-key tie-break. | Existing ordinary relation projection, predicate and order owners in Raptor 3; adapters spell SQL. | Mixed select/include/omit, ordinary→recursive→ordinary, second recursive slot, filtering and provider-order fixtures. |
| Cutoff and natural ends (§2.4) | At numeric cutoff omit the repeated key without reading another hop. Before cutoff preserve `[]` or permitted `null`; required missing singular target remains an integrity error. | Prepared recurrence descriptor plus projection decoder occurrence assembly. | Depth 1/2/1000, natural leaves before cutoff, singular optional/required, statement invariant. |
| Cycles and occurrences (§2.4) | FK cycle in-window raises attributed `QueryEngineError`; graph prevention is active-path edge pruning; disabled bounded graph recurrence repeats occurrences. Never globally deduplicate paths or roots. | SQL discovers compact facts; iterative decoder owns enter/leave path state and fresh public occurrences. | FK self-loop/later cycle, junction self-loop/diamond/overlapping roots, prevention on/off, fresh objects and mutable scalars. |
| Operation lifecycle (§2.5) | Use ordinary read, post-write readback and pre-delete snapshot routes. One recursive projected read is one provider statement independent of data depth. | Existing operation routing and DML readback owners; no recursive `RETURNING`. | Every supported verb in the placement matrix; callback transaction and supported array preparation; statement counts against ordinary relation readback. |
| Lazy/extensions boundary (§2.5) | Read-only build and admission stay lazy; complete array preparation does not dispatch. Request extensions cannot inject or replace protected `recurse`; query/statement/observation behavior stays ordinary. | Client admission, extension chain and existing operation route. | Build-only/no-dispatch, extension refusal and lifecycle traces. |
| SQL facts (§3.2) | Carry compact root/predecessor/child identities and continuation fields; depth only when bounded; no JSON, paths, aggregates or ordering in recursive member; one top-level recursive-table reference. | Raptor 3 query construction plus existing adapter CTE/identifier/ordering APIs. | SQLite, PGlite, native PostgreSQL and native MySQL SQL/execution witnesses; stable statement/bind growth. |
| Provider carrier (§3.3) | Validate dense node/edge facts and endpoints before publication; keep transport borrowed; unfold fresh public occurrences iteratively. | Existing `ProjectionShape` decoder branch and scalar/ordinary projection decoder. | Malformed carrier cuts, 1000+ path without JS stack dependence, codec freshness and occurrence independence. |
| Public result/type text (§3.4) | Infer an ordinary node once, wrap it with finite key-specific recurrence, preserve outer operation cardinality, and render schema-only types without a driver. | [`result-types.ts`](../../../../src/client/result-types.ts), schema-only `ExpectedResultShape`, and existing type printer. | Public API typo probes at each node level; cutoff union/fixed-depth results; built-package type-text fixture. |
| Cache (§3.4) | Replace the private recursive refusal with iterative snapshot/materialization of the finite public result; preserve fresh values, keys, invalidation and hit/miss parity. | Existing cache result codec and canonical-key owners; the present refusal is in [`client-route.ts`](../../../../src/query-engine/raptor3/route/client-route.ts). | Cold/hit mutation-detachment, deep path, cycle-policy, transaction bypass and unchanged non-recursive cache controls. |

No §2 behavior or public placement is assigned to a new engine, schema kind,
driver flag, global visited set, recursion-specific extension hook, or fallback.

## Private pins that are historical, not the public oracle

| Existing pin | Private expectation | Public replacement |
| --- | --- | --- |
| [`prep/recursive-read-fit.test.ts`](../../../../tests/raptor3/prep/recursive-read-fit.test.ts), “defines depth zero…”; [`g4/read-recursive-fit.test.ts`](../../../../tests/raptor3/g4/read-recursive-fit.test.ts), root ordering case | `depth: 0` is legal and publishes root rows with `children: []` / `parent: null`. | Public numeric depth starts at 1. Direct related records are level 1; 0 is rejected before dispatch. Outer roots come from the normal operation, not a seed list. |
| `prep/recursive-read-fit.test.ts`, “stops a complete-key revisit…”; [`recursive-carrier.review.test.ts`](../../../../tests/raptor3/g4/review/unit02-phase2/recursive-carrier.review.test.ts), “stops a real cycle path-locally” | All private self-FK revisits are silently path-pruned. | FK cycles encountered inside the requested window fail with an attributed `QueryEngineError`. Only junction graph traversal uses configurable active-path pruning. |
| `prep/recursive-read-fit.test.ts`, depth-zero and cycle cases | A cutoff or pruned revisit initializes the terminal relation key to `[]` or `null`. | Numeric cutoff omits the repeated property. A natural end before cutoff still publishes `[]` or allowed `null`; graph-pruned edges simply do not appear. |
| All private `Queries.recursive(model, { seeds, relation, depth, args })` lanes | A private root-only verb returns seed-ordered root arrays and chooses the traversed relation by string. | `recurse` modifies the actual relation node under normal client `select`/`include`; the normal operation owns outer cardinality and result shape, and the resolved slot owns the property name. |

The archived G3/G4 receipts remain byte-identical historical evidence for their
bounded SQL/codecs, mapped compound identities, filtering, ordering and
occurrence freshness. When the private root-only API is deleted, retire or
migrate its executable pins instead of retaining a compatibility interpreter.
Carry reusable behavioral coverage through public entry points, with every
intentional semantic change above named explicitly; do not relabel an old
receipt as a public-contract result.

## Registered providers and readiness

`node scripts/closure-final-inventory.mjs json` reports no unresolved spreads
and no registered-but-absent files. Current registered provider projects are:

| Project | Files | Credential class |
| --- | ---: | --- |
| `raptor3-provider` | 8 | local PGlite |
| `provider-pglite` | 6 | local |
| `provider-sqlite3` | 9 | local |
| `provider-libsql` | 6 | local |
| `provider-pg` | 7 | `PG_TEST_CONNECTION_STRING` |
| `provider-postgres` | 4 | `PG_TEST_CONNECTION_STRING` |
| `provider-mysql2` | 15 | `MYSQL_TEST_CONNECTION_STRING` |
| `provider-transaction-options` | 1 | `PG_TEST_CONNECTION_STRING` |
| `provider-neon-http` | 2 | hosted, deferred |
| `provider-planetscale` | 1 | hosted, deferred |
| `provider-bun` | 2 | platform |
| `provider-d1` | 1 | platform |

The current final inventory's native release stages are exactly the 15-file
`provider-mysql2` project and 7-file `provider-pg` project, one file per bounded
invocation. The adjacent registered local PostgreSQL projects contain
`postgres-pipelining`, `postgres-relations`, `postgres-serialization`,
`postgres`, and `transaction-options-live`. The registered MySQL list is the
11 `tests/providers/docker/mysql2*.test.ts` files plus
`decimal-wide-arithmetic-docker`, `decimal-list-defaults-mysql-docker`,
`mysql-defaults-docker` and `mysql-strict-mode-docker` (15 total because the
first group contains 11 files). The inventory script is the exact list owner;
later qualification must consume it rather than a hand-written glob.

Readiness inspection found Docker client/server `29.2.1` and four already
running local containers: PostgreSQL 16 on `127.0.0.1:53878`, PostGIS 16/3.4 on
`127.0.0.1:55732`, and MySQL 8 on `127.0.0.1:55731` and `127.0.0.1:64344`.
The two connection-string variables were absent from this shell. That does not
block RQ-00; required later native witnesses must bind silently to these
existing containers. They must not create replacement containers, use hosted
credentials, or print secret values.

## Focused baseline validation

All commands used the exact Node executable above with its directory first in
`PATH`, ran serially, and kept the existing 1,536 MiB process-group RSS ceiling.

| Command | Result | Resource receipt |
| --- | --- | --- |
| `node scripts/run-raptor3.mjs g3p05-recursive-read-fit` | 6/6 passed | 3.20 s wall; 451.8 MiB peak RSS; teardown verified |
| `node scripts/run-raptor3.mjs g4-read-recursive-fit` | 3/3 passed | 3.26 s wall; 470.5 MiB peak RSS; teardown verified |
| `node scripts/run-vitest-safe.mjs run --workspace vitest.workspace.ts --project=raptor3 --wall-limit-ms=120000 --heap-limit-mb=768 --rss-limit-mb=1536 tests/raptor3/g4/unit01/recursive-vocabulary.test.ts` | 1/1 passed | 3.00 s wall; 455.3 MiB peak RSS |

Total: **10/10 focused cells passed**. No full test, typecheck, build,
performance or native campaign was rerun: unchanged source/harness identity and
the accepted archived receipts are the evidence for those baseline facts.

## RQ-00 exit

The behavior/placement/owner inventory is complete and independently accepted;
there is no unresolved contract choice blocking RQ-01. Future implementation
must preserve this identity record, then bind new
qualification to the final integrated source rather than to RQ-00's unchanged
baseline.
