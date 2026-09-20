# Release verdict — the local closure checkpoint (draft, FC-06)

Drafted 2026-09-21 on branch `fc06` from `a9e62d8dc`, for the integrator to
finish. **The numbers marked _(fill)_ are the ones only the one frozen gate can
produce**; everything else is measured and carries its receipt. Nothing here
claims a run this wave did not execute, and nothing red has been rewritten into
a pass.

---

## Outcome

**What this checkpoint is.** The closure wave took the adversarial review's
three executed public-client failures, the two source-reviewed residuals behind
them, the remaining capability restrictions, the demonstrated duplications and
the evidence that described the tree inaccurately, and closed each at its own
owner. The public client API is unchanged: no verb, argument, result shape or
error identity moved, and no new public contract was created (D-64 closed the
one open contract question as an accepted restriction; D-65's would-be change
is recorded, not implemented).

**Valid operations that now execute and did not before.**

| behaviour | was | unit |
| --- | --- | --- |
| A nested payload whose member observes an earlier member's write, under root `updateMany` (and under every freshly expanded series member) | refused V7001, "Split these operations into separate queries" | FC-01 |
| An update whose correlated arm moves the key its own row references (`ON UPDATE CASCADE`), on a transport without `RETURNING` | `TypeError: UPDATE did not produce the required record` | FC-02A |
| A captured-set `deleteMany`/`updateMany` with a relation projection on a model that declares a scalar named `NOT` or `OR` | `EngineInvariantError: Raptor 3 filter operator is not implemented: OR` | FC-03 |
| A captured identity on a TEXT-stored `dateTime` written in any valid ISO spelling (with milliseconds, without, with an offset) | `TransactionError: updateMany selected-row cardinality changed during its locked mutation` | FC-02B |
| A relation-bearing `set` composition whose schedule legitimately violates a unique constraint | reported the avoidable refusal instead of the constraint | FC-01b (the fixed lane's own cell) |

**Silent corruption repaired (not a new capability).** A parent-held
`connectOrCreate` whose FOUND row's referenced column reads NULL used to write
that NULL — disconnecting the holder from the badge it was a member of, with the
sibling scalar committed beside it and no error. It now refuses by name, before
any write of the unit, with the sentence the retired engine used (FC-02C).

**What was deleted, and what it cost.** Two audited duplications went at their
rightful owners with no behaviour change — the engine's restatement of the
write-outcome composition (now one rule at `@errors`) and the scalar scratch
projection detour (`referenceProjection` and `lowerProjectionValues`, replaced by
`Queries.scalarQuery`) — together −24 engine token lines, which paid back most of
the +28 the repairs added. Net across the wave: **16,036 → 16,040 token lines**
(+4), charged total 23,831 → 23,833 (+2), physical +127 and bytes +8,322 of which
123 lines carry no parser token (docblock prose). Like for like the engine is
**0.3485** of the old engine's 46,021 charged token lines and **0.3989** with the
same integration files (49,887); physical **0.34 / 0.33** of the two recorded
old-engine readings, against plan §7's ≤ 0.70 — a target that had never been
reported with a number. Full table:
[`receipts/loc-recount.md`](receipts/loc-recount.md).

**The restrictions that remain are named, not residual.** FC-04 re-read the
inventory's closed set against source and changed zero production lines: every
retained limit is one of four kinds the engine cannot compose — a provider tier
it refuses to emulate, an exactness or portability guarantee it could only keep
by changing a value, a new public language, or an authority the transport does
not have. D-9's suppression limit was confirmed at its default and stated more
precisely than its inventory row ("an operation that owns no member rollback
region cannot suppress"); D-54's recursive read stays a declared private fit,
re-checked by the census on every run; D-59's two MySQL sentences stay
unreachable in any schema this ORM can push.

**Evidence and documents now say what the tree does.** The refusal census reads
the sentences a site builds and throws through the engine's failure owner (three
it could not read — two reported as sentence-less rethrows and one at no site at
all, all three inherited), and its counts are labelled as counts of SENTENCES
with the behavioural inventory named as the authority for capability. The
drivers guide's packaging promise follows dependencies instead of the verb name;
the engine guide's four contradicted active rules state the current one; the
CHANGELOG's refusal count and D1 witness sentence are exact; the harness cannot
register one file as both runner-only and credential-free, and a structural
measurement that names a stale instrumentation patch is refused before it
measures anything.

---

## Validation

**Apply first — the registrations the units owe** (each unit deliberately left
`scripts/raptor3-manifest.mjs` alone; FC-06 edited it only for the duplicate
registration and the patch assertion):

| file | cells | group |
| --- | ---: | --- |
| `tests/raptor3/g4/parity/fresh-member-placement.test.ts` | 16 | `G4_PARITY_COUNTS` |
| `tests/raptor3/g4/parity/prepared-set-predicates.test.ts` | 9 | `G4_PARITY_COUNTS` |
| `tests/raptor3/g4/parity/cascaded-current-identity.test.ts` | 21 | `G4_PARITY_COUNTS` |
| `tests/raptor3/g4/parity/reference-representability.test.ts` | 12 | `G4_PARITY_COUNTS` |
| `tests/raptor3/g4/parity/captured-identity-domains.test.ts` | 9 → **18** | `G4_PARITY_COUNTS` |
| `tests/raptor3/g4/parity/one-write-outcome-composition.test.ts` | 4 | `G4_PARITY_COUNTS` |
| `tests/raptor3/g4/parity/cacheable-read-vocabulary.test.ts` | 3 | `G4_PARITY_COUNTS` |
| `tests/providers/docker/mysql2-cascaded-identity.test.ts` | 4 | none — collected by `provider-mysql2`'s glob |
| `tests/providers/docker/pg-captured-set-concurrency.test.ts` | 10 | none — collected by `provider-pg`'s glob (FCPG's witness) |

**Then the one frozen gate, on frozen production and harness identities**, in
the plan's order: the fixed lane; comparison/replay; generated and transport
contracts; the affected client/extension/codec suites; local SQLite and PGlite;
native local PostgreSQL and MySQL; the harness self-tests; the full typecheck;
build and package checks.

| lane | expected | result |
| --- | --- | --- |
| Fixed lane | 864 + the newly registered cells | _(fill)_ |
| Typecheck (`node scripts/run-typecheck.mjs`) | **0** | _(fill)_ |
| Census (`node scripts/raptor3-refusal-census.mjs`) | 23 unmatched candidate sentences at 30 sites, 75 inherited, 11 internal, 21 invariant, **193 sites** — the site total and the inherited count moved by FC-06's reading of the failure owner, the candidate count did not | _(fill)_ |
| Harness self-tests (`pnpm test:coverage:policy`) | coverage-policy 11, bounded-process, test-run-lock, refusal-census **7** | _(fill)_ |
| `scripts/raptor3-campaign-receipts.test.mjs` | **41** (39 + the two structural-patch cells) | _(fill)_ |
| Native PostgreSQL | including `pg-nested-write-races.test.ts:115`, the `batchPrimaryKeyDataflowContract` registration kept red at the cutover and **unmeasured since** — this gate is where it is answered | _(fill)_ |
| Native MySQL | including `mysql2-cascaded-identity.test.ts` (4 cells, FC-02A's non-RETURNING witness) | _(fill)_ |
| Package / build | unchanged contract | _(fill)_ |
| Bundles | the release tree read engine gzip 0.646, public PostgreSQL fixtures 0.735; re-measure only if the integrator's run needs them | _(fill)_ |
| Performance | the committed-tree comparator for the repaired parse cell (`fixed-collection-rowref-1000/parse`) and its full-read consumer, with the protocol's controls — P1's after-cells came from its worker in calibration mode on a dirty tree and are NOT a standard-protocol release report | _(fill)_ |

**What the units already measured** (do not re-run these to re-prove them; they
are listed so the gate can tell a regression from a known state):

| unit | its own discriminating runs |
| --- | --- |
| FC-01 | new pin 14 red at base → 16 green; `ordered-observation` 39, three `g29-dependency-*` 28 ×2, `nested-write-conformance-root-dependency` 30, `parent-held-lookup` 56, `supplier-continuation` 21, `shared-pk-update-root` 71 |
| FC-01b | the six `s2-changed-dependency` cells red at base both ways, green after; no engine file touched |
| FC-02A | new pin 5 red at base → 21 green; native MySQL 3 red / 4 green; `published-key` 12, `key-arithmetic` 21, `projection-preparation` 4 |
| FC-02B | `captured-identity-domains` 9 → 18 cells, 7 red at base → 17 green (×2 projects); datetime codec and decoder pins 125 |
| FC-02C | new pin 4 red at base → 12 green; `parent-held-lookup` 56, `correlated-membership` 10, `suppressed-membership-target` 14, `published-key` 24, `lane-x-set-mutations` 10, `nested-write-conformance-to-one` 19 |
| FC-03 | new pin 9 green, falsified three times; `batch-captured-bulk` 7, `integration-staleness` 5, `combinator-named-scalar` 4, `captured-identity-domains` 9 |
| FC-04 | new pin 3 green, falsified twice; `prep/g3p04-review-regressions` 5 ×2, `prep/suppression-replay` 5 ×2 |
| FC-05 | new pin 4 green at base and after, falsified three ways; `uncertain-outcome-meta` 8, `transport-witnesses` 7, `published-key` 12, `query-interceptors.core` 43 ×3 |
| FCPG | ten cells on native PostgreSQL 16.4 over two and three connections |
| FC-06 | census self-test 7, campaign receipts 41, coverage policy 11, the campaign self-test 42 under a bare project run, docs `blume validate` (11 warnings, identical before and after) |

---

## Risks

1. **D-65 is pending and it is a public-contract question.** On the batch route
   both consumers of a captured set leave one window between the last premise
   and the first write in which a row that stopped matching is still mutated and
   a member that joined is missed — silently, with the row count right. The
   interactive route holds the premise to the effect. The integrator's
   recommended default is recorded (B for consumer 1, A documented for consumer
   2); nothing is implemented, and `requireCapturedSet`'s over-promising comment
   is deliberately left alone so the wording does not pick a reading.
2. **Two measured compatibility residuals from FC-02C** — a `connectOrCreate`
   CREATE arm that spells the referenced field NULL, and the child-held
   direction — still write that NULL. Both have receipts; neither is pinned;
   both need a bounded decision rather than an invented stricter rule.
3. **D-64's own pin executes in no vitest project.** The build contract is
   stated in code, tests, the CHANGELOG and the guides, but the cell the ruling
   cites is in the unregistered `g4/review/cutover/` tree. A future change that
   restored a write's `buildStatement()` would pass the gate.
4. **Hosted qualification is deferred, and a local lane is not a hosted one.**
   The live Neon suite is credential-gated and was not run; D1's local
   Workers-pool suite is not a hosted D1 receipt, so D1's
   ordered-committed-segments declaration stays unwitnessed on the real
   transport. Test source presence is not a passing receipt.
5. **Two retained limits are argued, not measured** — FC-01's surviving
   placement limit (instrumented to zero hits) and FC-02A's widened
   current-values parameter for a NON-key arithmetic input (unreachable today
   because arithmetic on a relation key field is refused at admission).
6. **Performance evidence is one run short.** P1's repair is real and its
   falsifier reddens twelve decode pins, but its ratios came from the
   protocol's worker in calibration mode on a dirty tree; the committed-tree
   comparator run is owed. D-60's restated preparation costs and D-62's
   accepted `bulk-update-returning-100/full` movement stand as documented
   costs, the latter unbisected.
7. **A count of sentences is not a count of capabilities.** The census now says
   so in its own report, and the behavioural closure inventory
   (`g4/release/closure/fc00/inventory.md`, 102 rows) is the authority for what
   this engine supports. Quoting "23" as a capability number in a release note
   would be the same mistake this unit removed from the tooling.
8. **Two known tooling limits stay.** The source-cost tool still cannot run in a
   tree whose `git status` exceeds 1 MiB (it ran cleanly here), and the docs
   site's `blume check` is red at 324 pre-existing TypeScript errors, every one
   of them in the preserved `docs/architecture/raptor3-evidence/**` snapshots
   and none in `content/`.
