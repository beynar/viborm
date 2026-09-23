# Release unit "N4" — an invariant is not a refusal (D-52)

Integrator: Fable, in the worktree `/private/tmp/viborm-n4` on branch `n4`
from `bf7ac30b4` (unit S). Plan §4 of
`docs/architecture/raptor3-nesting-and-refusals-plan.md`, rulings D-52 (execute
the boundaries and reclassify; reduce the census) and D-54 (the recursive read
stays private). Five Opus groups, one per owner, each with its own note beside
this one: `note-A1.md` (`shared/query.ts`, `route/client-route.ts`),
`note-A2.md` (`commands/`), `note-A3.md` (`shared/operation-context.ts`),
`note-A4.md` (`shared/storage.ts`), `note-A5.md` (the census tool). Their
receipts under `receipts-A3/` and `receipts-A4/`. The census itself:
`census.md`, regenerated on the final tree with
`node scripts/raptor3-refusal-census.mjs --out docs/architecture/raptor3-evidence/g4/release/n4/census.md`.

## 1. The truth

The census the plan started from (`g4/release/plan/refusals-map.md`) counted
55 sentences the candidate spells and the shipped engine does not, and it could
not tell three things apart: a sentence a caller reaches with an admitted
payload (a refusal, a contract), a state the code cannot be in when it is right
(an invariant, established upstream by a type or an earlier owner), and a
sentence inside a mechanism no public argument reaches (the private
recursive-read fit, D-54). This unit makes the distinction **by construction**
and then rules every row at its owner.

**The one invariant owner.** `src/query-engine/raptor3/shared/invariant.ts`
(29 lines): `EngineInvariantError` — deliberately not a `VibORMError`, so no
public error class and no message text is what tells an invariant from a
refusal — `assertInvariant(condition, message): asserts condition`, and
`unreachable(value: never, message): never` for a `switch` the compiler has
closed. Every group imported it; nobody re-declared it.

**The census tool.** `scripts/raptor3-refusal-census.mjs` (new, 785 lines)
replaces the four frozen receipt scripts. It parses TypeScript (a throw is a
`ThrowStatement`, a sentence is its message argument — so the eight doc-comment
fragments that made the first census say 63 / 59 / 55 cannot be produced),
matches against the shipped corpus pinned at `0cc61e61f` (the shipped owners
were retired at `356254a2d`; without the pin — `--shipped-rev bf7ac30b4` on the
final tree — it reads 85 public sentences and 9 registered), reads a sentence
built by a local factory, a function of the file, a method of the throw's own
class, a `const` bound to one of those or a named constant as the throw site's
own (the review found #24/#36, G3P-04's sentence and three module constants
hidden as rethrows), and reports three outcomes apart: **invariant** when the site throws
through `shared/invariant.ts` (resolved through the file's own import),
**internal** when the site lies inside a declared private fit whose privacy the
run re-checks by grepping the tree for the fit's entry symbols (a public caller
contradicts the fit, the sentences go back to public, the run exits non-zero),
**refusal** otherwise — registered when the shipped engine spells it, public
when it does not.

| | base `bf7ac30b4` | this unit |
|---|---|---|
| invariant sentences (sites) | 0 | **21** (22) |
| internal — D-54's recursive read | 11 | 11 |
| refusal — registered (inherited contracts) | 71 | 71 |
| refusal — public | **47** (55 at the map) | **23** (30 sites) |
| total sites | 189 | 188 |

**What the 23 public sentences are.** Sixteen integrity facts, each the one
owner of an execution fact at a trust boundary: a provider row the codec was
not told about (`InvalidScalarResult` ×3, the binary and vector value domains),
a produced record the INSERT, `INSERT … ON CONFLICT`, `INSERT RETURNING`,
`UPDATE` or `UPDATE RETURNING` did not return, a missing last-insert-id, a
prepared result the driver omitted, an inserted-row count below the submitted
rows, a `createMany` read-back that matched more rows than were submitted, and
the captured set whose cardinality changed under its `updateMany` /
`deleteMany` (#24, #36 — now also the failure the batch premises carry).
Seven capability or provider limits, kept as the plan rules: GeoPoint distance
on an adapter without the tier (#3); `createMany({ select })` (#26) and the
interactive `create` (#33) on a provider without RETURNING whose generated key
is not one increment field; the cache codec for a verb the engine publishes no
read for (#51, its KEEP traced — three independently maintained operation
vocabularies, no type ties them); the borrowed `createMany skipDuplicates`
member on the atomic-batch leg, which no operation-owned rollback region can
protect (G3P-04, a ruled refusal the map never listed because its first census
read the method that builds it as a rethrow); and the two that stay boundaries
by measurement, #13 and #16 below.

**Executed (two capability boundaries).**

- **#23** `Cannot publish the updated value of 'X.f' … inside an atomic batch`.
  `update()`'s batch arm collects the demanded fields the integer scratch
  cannot carry into `observed` and, after the UPDATE is queued, takes an
  ORDERED OBSERVATION through the existing barrier (`flush`) at the row's
  post-update identity (`updatedIdentity`) — N1's mechanism, D-51's succession.
  The answer is the shipped engine's row, computed by the provider instead of
  in JavaScript. Pin `batch-observed-publication.test.ts` (10 cells; 4 red at
  the base with the refusal). The unit02 cells that recorded the refusal as an
  accepted divergence are re-expressed to the row (§5).
- **#25** `Driver 'X' cannot atomically capture selected updateMany /
  deleteMany rows`. `captureMutationIdentities` drops the refusal, takes
  `FOR UPDATE` only where a session holds it, and on the batch route reads
  through `flush` — the capture is a segment of its own. `requireCapturedSet`
  states the observation's premises INSIDE the mutation's batch — every
  captured identity still present and still a member (`requirePresent` with
  the selector) and, for an unlimited capture, no row joined it
  (`requireAbsent` of selector ∧ key ∉ captured) — and `capturedMutation` runs
  the mutation in that batch and answers its row count by its own position
  in the queue (`submit` answers the queued statements alone), stating #27's
  omitted-result fact where its siblings do. Its statement is the operation's
  SET WINDOW, as `setMutations` states it, so a write the provider rejects
  reports no record-series progress — a merely uncertain outcome is no series
  of its own (`failure`), the same on both routes of a bulk mutation. The
  cardinality sentences (#24, #36) stay as the detection they are, now also
  the failure the premises carry. Pin `batch-captured-bulk.test.ts` (7 cells;
  5 red at the base, the window cell red without `setWindow`).

**Deleted with their dead owners.**

- **#31** the `atomic-array` variant of `ExecutionBinding` and its constructor
  guard: nothing constructed it (`grep 'atomic-array' src/` — zero TypeScript
  hits; the route builds `borrowed-transaction` or no binding, the public array
  form is the client's own owner). The compiler states what the guard stated.
- **#32** `OperationContext.clear`, whole: not unreachable but IMPLEMENTED — a
  set's clear is placed as `{ kind: "remove", keep: [] }` and `remove` already
  nulls a non-junction edge's `clearability.columns`; `clear` was `remove`'s
  junction arm, duplicated and orphaned (no caller in `src` or `tests`).

**Closed by the type where the type could say it.** `admittedOperation`'s
switch over the client's `Operations` (16 members) — `default` is
`unreachable`, the return type loses `| undefined`, the `resolve` fallback and
its sentence go (#43). The relation body's switch over `RelationVerb`, derived
from its OWN two order arrays (`mutationOrder`, `collectionMutationOrder`, now
`as const`) — one authority, not a second list; the `string` → verb step
happens once, where the admitted payload is destructured (#47). `Aggregate`
derived from `AGGREGATES` at the one payload-keyed site (`isAggregate`), the
prepared target carrying it, `aggregateExpression`'s `default` `unreachable`
(#12). The delete series' `origin` required by type, supplied at its one
construction site (#44). `captureSeries` returns the `PreparedSeries` it set,
so `series()` reads the value instead of re-reading the map (#45, one site).

**Asserted where the type could not.** The filter, JSON and relation-quantifier
operator `default` arms (#15, #17, #18): closing their unions would need a
second enumeration of the admitted vocabulary inside the lowerer — the thing
AGENTS.md forbids — so the class carries the distinction and the text is
unchanged. The cache codec's scalar-less leaf (#50; `Leaf.type` is a `string`
because it also carries declared scalar names). The occurrence-tree facts of
`commands.ts` (#37–#42, #46, and #45's second site): each names the owner that
established it (`bindTree` sets `parent` while walking `children`;
`materializePlacement` resolves every capture target; a series is expanded
once; a member names the row it captured). The storage resolver's two sentences
(#48, #49): unreachable through the schema builder, established three ways —
by the call graph (every `bindMembership` caller reads the resolved slot and
`edge.kind` first; the one arm name a payload supplies is validation's literal
union), by exhausting the declaration surface (nine admitted schemas, every
`(model, field)` and `(model, relation, variant)` they can make the engine ask
about, 22 cells), and by running ~50 admitted operations with the resolver
instrumented (1,077 field asks over 18 pairs, 61 membership asks, nothing
reached either throw). The review reached #48 anyway, with a shape none of the
three had tried: a scalar literally named `AND`, `OR` or `NOT`. Validation
extends its combinator entries with the model's own fields, so the declared
field wins the key (`validation/model/core/where.ts`;
`validation/model/args/aggregate.ts` says so for `having`), while the engine read the combinator first, re-read the
admitted operator bag as a nested `where` and asked the resolver for a field
named `gt`. That is an engine defect at one owner, not a schema question:
`Queries.combinator` reads a combinator only where the model declares no field
by that name, in `prepareWhere` and `prepareHaving` alike, and the resolver's
sentence is the invariant the unit says it is. Pin
`combinator-named-scalar.test.ts` (4 cells — the scalar and the relation
halves — red at the base query owner with the resolver's sentence, the
relation cell red without the relations term). Nothing was refused at the schema. Two sentences
the map had no row for, ruled by the integrator on the same facts:
`Dependency read is not under the write's tree` (`commands.ts`, `depend`) —
two assertions, each naming its owner: the walk meets the read's path at the
root at the latest (`bindTree` hangs every occurrence from the one root), and
the meeting point is a proper ancestor of the reader because the pairing walk
(`visitPrecedingWrites`) hands `depend` only a write that precedes the read;
and `Raptor 3 variant integrity requires junction storage` (`query.ts`,
`orphanedMemberships`) — the probe's subjects are built only for a
junction-carried slot whose members bind junction memberships, one
construction site.

**Kept, integrity (nine in `operation-context.ts`, #28 in `commands.ts`, the
row-boundary facts in `query.ts`)**: each group's note names, per row, the one
execution fact the sentence alone owns. Two sentences the map had no row for
are kept on the same ground: `INSERT … ON CONFLICT did not produce the required
record` (#28's sibling, the spelled upsert's own cardinality) and `Driver
reported N of M inserted rows` (an affected-row count is execution semantics:
a driver that acknowledges fewer rows than submitted has not written the
request).

**Measured, not executed.**

- **#16** `G1 atomic output requires exact identity scratch or segmented
  RETURNING`. The ruling's shape — "a produced field that is not one increment
  key" — is **unreachable**: a referenced field that is not the parent's key is
  refused first by the create's own parent-id resolver, and a key field that is
  not generated is never absent from an admitted payload; so one produced field
  is always one increment key, which D-50 carries. What DOES reach the guard is
  MORE than one produced field — a composite primary key whose parts are both
  `increment` — which needs a **multi-column** store (`storeReturning` /
  `storeInsertedKey` take one `(key, column)` pair and wrap the INSERT), a
  change to the adapter seam (`adapter-core-types.ts`, `batch-refs.ts`, the
  PostgreSQL adapter) and two D-50 contract cells outside this unit. The D-50
  note had already recorded "widening the scratch to every produced column is
  a follow-up for a ruling"; the ruling that came named a shape that does not
  reach the guard. **A corrected ruling for Arnaud**, not a patch. The boundary
  is pinned as it stands (`postgres-declared-type-scratch.test.ts`, 3 cells,
  live PGlite; its second cell is the falsifiable one for whoever executes it).
- **#13** `Raptor 3 cannot name the updated value of 'X.f' under multiply /
  divide`. The map and the doc comment said the reachable shape was a decimal
  RELATION key; measured at the base it is not (a relation key beside a
  mutation of that relation must be a literal, `NestedWriteError` answers
  first). It IS reachable by a shape nobody had named: a decimal PRIMARY key on
  an upsert's found arm whose update names no relation, on a provider without
  RETURNING (`keyPortabilityRefusal` guards `update` / `updateMany` and the
  relation-naming found arm only). The same payload succeeds with RETURNING
  (600 → 1200), so it is a transport boundary, not an invariant — and plan §4's
  "executed through N1's ordered observation" is refined: what
  `updatedIdentity` needs is the row's ADDRESS after a write that moved its
  key, which no ordering of reads supplies. The execution is D-50's scratch
  read at the column's DECLARED type at `updatedIdentity`'s owner
  (`operation-context.ts`) — the same seam widening #16 needs, so the same
  ruling. Doc comment corrected to the measured shape; its cell in
  `key-arithmetic.test.ts` is green as recorded.

**The recursive read (11 sentences).** Untouched under D-54 and reported apart
as internal. Beyond the ruling: the four the map called invariants (#1, #2,
#19, #20) are not invariants an upstream owner established — they are the
ADMISSION the feature does not yet have, and converting them would be
ELEGANCE §5's forbidden move (an assertion establishing a missing fact), to be
reverted the day D-54 wires the verb.

## 2. Per row

The five group notes carry the per-row tables (disposition, what changed, the
fact it rests on). The tally against the map's 55 rows plus the four unmapped
sentences the census found:

| disposition | rows |
|---|---|
| closed by the type | #12, #43, #44, #45 (one site), #47 |
| asserted through the owner | #15, #17, #18, #37–#42, #45 (one site), #46, #48 (its one admitted reach closed at `Queries.combinator`), #49, #50; unmapped `Dependency read…` (two facts, two owners), `variant integrity requires junction storage` |
| deleted with a dead owner | #31, #32 |
| executed | #23, #25 |
| measured, boundary kept, ruling requested | #13, #16 |
| kept — integrity | #4, #11, #14, #21, #22, #24, #27, #28, #29, #30, #34, #35, #36; unmapped `INSERT … ON CONFLICT…`, `Driver reported N of M…` |
| kept — capability / provider limit | #3, #26, #33, #51 |
| internal (D-54) | #1, #2, #5–#10, #19, #20, #52 |
| gone with unit S | #53, #54, #55 |

## 3. Hunks

`git diff --numstat bf7ac30b4` on the final tree (production first):

| file | +/− | what |
|---|---|---|
| `shared/invariant.ts` | +29 (new) | the owner |
| `shared/operation-context.ts` | +174 / −104 | #23 observed publication; #25 `requireCapturedSet`, `capturedMutation` (the set window, the queue position, #27 stated), the capture through `flush`; #31 variant + guard deleted; #32 `clear` deleted |
| `shared/query.ts` | +81 / −18 | `Aggregate` + `isAggregate`; #15/#17/#18 by class; #13's doc comment; `orphanedMemberships` asserted; `combinator` — a declared field named like a combinator is that field |
| `shared/storage.ts` | +60 / −27 | #48/#49 asserted; `carrierColumns` once for the two views that spelled it separately |
| `commands/commands.ts` | +58 / −14 | #37–#42 asserted; `SelectedSeries` delete arm `origin`; `depend`'s two tree facts asserted |
| `commands/execution.ts` | +21 / −12 | `PreparedSeries` returned by `captureSeries`; #45/#46 |
| `commands/relation-body.ts` | +28 / −12 | the order arrays `as const`, `RelationVerb`, `relation(verb: RelationVerb)` with `unreachable`; `{ kind: "delete", origin }` |
| `commands/index.ts` | +13 / −12 | `admittedOperation` returns `Operation`, `unreachable`; `resolve` deleted |
| `route/client-route.ts` | +23 / −3 | #50 by class; #51's KEEP rationale at its site |
| `AGENTS.md` | +22 / −3 | the binding sentence; the paragraph "An invariant is not a refusal (N4, D-52)" |
| `scripts/raptor3-refusal-census.mjs` | +785 (new) | the census tool |
| `scripts/raptor3-manifest.mjs` | +4 | the three deterministic pins in `G4_PARITY_COUNTS`, the live one in `D50_PROVIDER_TESTS` |
| tests, new | +754 | `batch-observed-publication` (10), `batch-captured-bulk` (7), `combinator-named-scalar` (4), `postgres-declared-type-scratch` (3) |
| tests, re-expressed | 3 files | §5 |

Of the production additions, most lines are the comments that name, at each
converted site, the owner that established the fact. Executable change is
small: A1 +3 net code lines, A2 +6 (with `index.ts` −7), A4 +13 token-lines,
A3 +62 net (65 of them the two new methods of #25 and their reasoning, against
38 lines of dead owner deleted).

Biome (`npx biome check`, formatter never run on a file whose HEAD copy carries
a `format` diagnostic — `query.ts`, `index.ts`, `operation-context.ts`, the
review probe): every production file's diagnostic set is identical to its
`bf7ac30b4` copy, line numbers shifted only; the four new test files and the
census tool are clean; the three re-expressed test files lost their now-unused
imports and otherwise match HEAD.

## 4. Verification

| run | result |
|---|---|
| `node scripts/run-typecheck.mjs` (whole estate) | 0 diagnostics |
| the three deterministic pins, the N1 pin, `ownership/commands.test.ts`, `key-arithmetic.test.ts` (touched) | 135 / 135 |
| `postgres-declared-type-scratch.test.ts` (live PGlite) | 3 / 3 |
| the review probe (`review.workspace.ts`) | 2 / 2 |
| `pnpm test:all --only "Raptor 3 fixed"` | 787 / 787 (766 + the 21 new deterministic pin cells) |
| `node scripts/run-raptor3.mjs g1-compare` | 36 / 36 |
| `g2-baseline`, `g2-contracts`, `g3-transaction-array` | 216 / 216, 216 / 216, 4 / 4 |
| `pnpm test:core` | 8,434 / 8,434 |
| coverage floors (`test:coverage:query-engine-core`, `:policy`) | 87.81 / 91.37 / 90.54 / 87.81 held; policy lane green (floors 87 / 91 / 90 / 87; N1: 88.06 / 91.21 / 91.06 / 88.06 — the statement dip is #25's two new methods, whose stale-observation arms the SQLite stand-in reaches but the estate's RETURNING transports do not) |
| the extended-local estate vs the N1 head, by cell identity and message (`compare-cells.py`) | 99 failing cells → 99: **0 newly red, 0 newly green, 0 moved** (14 ordinary shards, 8 shared-family shards, 2 imported-PGlite shards, the provider stage) |
| the census (`census.md`) | 23 public / 21 invariant / 11 internal / 71 registered, from 47 / 0 / 11 / 71 |

The whole estate was measured twice: once on the tree the review read
(`scratchpad n4/estate-r1/`: fixed 782 / 782, core 8,434 / 8,434, floors
87.81 / 91.37 / 90.53 / 87.81, 99 → 99 cells with none newly red or green),
and again on the final tree after the review's resolutions (§7), which is the
run the table reports.

Falsification, per group (receipts under `receipts-A3/`, `receipts-A4/`, and
the group notes): #23's pin 4 / 10 red at the base with the refusal, #25's
5 / 6 red (`TransactionError: Driver 'sqlite3' cannot atomically capture…`),
both by the backup-copy recipe; A2's three compiler mutations (drop
`case "count"`, append a twelfth verb, spell a delete series without `origin`)
caught on the final tree and silent at the base; A4's classification cells red
at the base (a bare `Error`, no owner) and its 23 reachability cells green at
the base too — the sentences were already unreachable, the unit recorded it;
A5's four falsifications (the receipts' 59 reproduced minus the fragments a
parser cannot emit; the class not the wording — the same sentences count as
invariants only after the owner; the fit contradicted by widening its needle;
the corpus pin removed → 83 / 8 at A5's run, 85 public / 9 registered on the
final tree once the resolver reads named constants). The review's two resolutions carry their own:
the combinator pin is 6 / 6 red (its first 3 cells × 2 projects) with the base
`query.ts` in place — `'gt' is neither a declared scalar of
'n4_combinator_rows' …` — and green with this unit's; the window cell of
`batch-captured-bulk.test.ts` is red without `this.setWindow = member` and
green with it (`scratchpad n4/falsify/`, both files restored and diffed).
CS-02 (`cs02-structure-measure.test.ts`) is red in the N1 baseline and here
alike — not this unit's.

## 5. Recorded expectations re-expressed (the ruling named at each)

- `tests/raptor3/ownership/commands.test.ts` — "refuses atomic-array binding
  before admission or provider work" → "an atomic-array binding does not
  exist: the type refuses it before admission or provider work (N4)": the
  cell is the compile-time fact (`@ts-expect-error` on the deleted variant),
  which is the stronger form of what the runtime guard stated.
- `tests/raptor3/g4/unit02/key-arithmetic.test.ts` — the two R-D3 cells
  ("refuses a number key increment / multiply under a batch with its
  registered identity") → the row the provider computed (`id: 7`, `id: 12`),
  the shipped engine's answer that the file itself recorded as the accepted
  divergence (#23); the block's title and doc comment state the N4 answer and
  name the ruling.
- `tests/raptor3/g4/review/unit02-decisions/batch-publication-identity.review.test.ts`
  — "names every non-int domain with the same registered identity, and
  dispatches nothing" → "publishes every non-int domain through the ordered
  observation": all three domains answer the shipped row and dispatch their
  write (#23; its own workspace, not estate-registered).

No test was deleted, skipped or weakened.

## 6. Still red, unverified, blockers, open for Arnaud

**Blocker — #16 needs a corrected ruling** (§1): the ruling's premise is
contradicted by measurement; the reachable shape (a composite generated key)
needs a multi-column scratch store across the adapter seam and re-expresses
two D-50 contract cells. #13's execution is the same seam widening at
`updatedIdentity`'s owner. Both stay boundaries, pinned.

**For Arnaud's eye.** #23 changes ATOMICITY on the batch route for the shapes
it executes: the update's segment now commits before the consumer's write —
D-51's stated succession, but a real change for a caller who assumed one
batch. A4's schema-naming question: a scalar whose FIELD KEY is spelled like a
carrier column (`subject_type`, mapped elsewhere) is admitted and shadows the
carrier column in the physical-field view, while a scalar MAPPED onto it is
refused (`P008`); should `P008` also reserve carrier column names against
scalar keys? Reaches no sentence; pinned in `receipts-A4/`, not changed (a new
schema refusal is Arnaud's).

**Map corrections recorded.** #13's reachable shape (above). Rows #4 and #11
were reworded in the tree since the receipts froze (`InvalidScalarResult`
reasons); the census reads the reasons. Four sentences entered the candidate
after the freeze with no row (ruled above). The 63 / 59 / 55 discrepancy is
eight comment fragments.

**A DateTime primary key on #25's route (the review's measurement,
`receipts-review/datetime-key.probe.test.ts`, `d1-datetime.probe.test.ts`).**
A captured bulk mutation, or a root `delete` with an include, on a model
whose primary key is a `dateTime` answers the provider's bind error on the
batch route (`QueryError`, SQLite: "can only bind numbers, strings, bigints,
buffers, and null") where the base answered the refusal. The cause is not
#25's: the captured identities are DECODED row values, and
`Queries.scalarValue`'s datetime arm binds a `Date` as given — the same
payload fails the same way at the base on the live non-RETURNING capture
(`UPDATE … WHERE ("id" = ? OR "id" = ?)`), where no refusal stood in front.
A pre-existing identity-lowering defect at one owner, recorded for N5 with
the reviewer's probes as the shape (`scratchpad n5/owners-from-n4.md`); not
executed here because it is not this unit's fact, and not pinned as a
committed cell because the honest cell is red and the fixed stage is the
gate. Both pins use string keys; the domains #25 is measured for are strings.

**The premise segment grows with the captured set.** `requireCapturedSet`
states one presence premise per captured identity plus one complement, in the
mutation's own native batch: N + 2 statements and O(N) bound parameters for N
rows (the review measured 14 statements for 12 rows). No bound is measured
against D1's or Neon's per-request limits, and the base's answer was a clean
refusal. If a transport's limit is reached, the follow-up is one counting
premise over the captured identities, not a retreat to the refusal.

**A selected `deleteMany`'s published values are read before the atomic unit
on that route.** The delete arm reads the rows it publishes with a direct
dispatch before the capture's premises and the mutation are queued, so on a
batch-only transport that read is outside the batch: a NON-selector column
changed between the read and the batch is published as it was read (the
review's `stale-column` probe: `title` updated in between, the old titles
answered, both rows deleted, nothing raised). The premises claim what the
capture claims — identity present, still a member, none joined — not the
values of other columns; the live route reads under its own envelope.
Inherent to a non-RETURNING batch transport where the base refused the shape
rather than answering it.

**Unverified.** MySQL and Docker `pg` were not run (no containers up): #25's
execution is measured on a SQLite stand-in with `supportsReturning` forced
false; the real MySQL batch transport is unmeasured. #25's complement premise
has its unique coverage only where the capture's selector is not unique (a
bulk mutation on a non-RETURNING batch transport — the pinned fixture); on a
RETURNING batch transport only the root `delete` / `update` reaches the
capture and the complement is vacuous there. Rows #3, #4, #11, #14, #21, #22
are kept on their stated execution facts, not executed (each needs a
misbehaving driver or a race). #51's `…OrThrow` asymmetry across the three
vocabularies is read from source. #13's `list`-typed key disjunct is not
measured. `tests/contracts/engine/write` exceeds the runner's memory ceiling
on this machine (as at N1). The census tool is `.mjs` and outside the estate
typecheck (`allowJs: false`, as every script).

**Still red, not this unit's.** CS-02 (`core-structure/measurement/
cs02-structure-measure.test.ts`, red at the N1 head); the six generation
campaigns whose seed corpora are absent from a fresh worktree; the 99 estate
cells N5 owns (`scratchpad n5/red-cells.md`), plus the DateTime-key shape
above.

## 7. Review (Opus, two lenses in parallel)

**Round 1 — BLOCK (the classification lens) and REVISE (the execution
lens).** Every finding, and what was done:

- **[major] #48 is reachable** with a scalar named `AND` / `OR` / `NOT`
  (`receipts-review/probe-and-collision.log`, six payload shapes). Resolved at
  the engine's one owner, `Queries.combinator` (§1); pin
  `combinator-named-scalar.test.ts`; the note, plan and ledger restated.
- **[major] #24 / #36 were hidden from the census** by the local factory
  `changed()` — counted as rethrows, so the head was 22 public sentences, not
  20. Resolved in the tool (`factoryConstruction`: a local factory's
  construction is the throw site's own sentence); the counts restated
  everywhere (46 → 22 then, 47 → 23 after round 2); the "Sites without a
  sentence" prose corrected.
- **[minor]** the corpus-pin number (83) was measured on an intermediate tree
  → 78 on the tree round 1 read; with the resolver extended in round 2 the
  tree read 83 again, and 85 once round 3 taught it named constants (§1,
  `note-A5.md` addendum). The §3 hunk table was
  written before the tree it named → regenerated. `depend`'s one assertion
  rested on two facts with one owner named → two assertions, two owners
  (§1). `relation-body.ts`'s comment cited a schema path that does not exist
  → `validation/relations/**` and `primitives/object.ts`'s strict default.
  The plan's "non-junction arm" → junction arm. `census.md`'s 21st invariant
  site (the owner's own throw, no literal) → the prose says so.
- **[major] a DateTime primary key on #25's route** answers the provider's
  bind error where the base refused → disclosed (§6), the cause placed at its
  pre-existing owner, recorded for N5; not executed here.
- **[major] `capturedMutation`'s statement was outside the operation's set
  window**, so a write the provider rejected published record-series
  progress for a merely uncertain outcome — the one case `failure`'s own rule
  forbids. Resolved: the statement is the set window, as `setMutations`
  states it; a seventh cell pins it (red without the line).
- **[minor]** the response index added `continuationCount`, which `submit`
  already slices off (inert today, wrong the day a continuation precedes a
  captured mutation) → the queue position; the omitted-result fact (#27)
  stated at the site as its siblings state it. The re-expressed R-D3 block's
  title and doc comment still described the refusal → rewritten, the ruling
  named. The INT-key cell's assertion matched a table the cell never touches
  → made falsifiable (no read of the row between the scratch store and the
  UPDATE), and the observation cell now asserts the UPDATE's own native batch
  and the published row in the next. A fifth `incompletePreparation` site
  that `submit` already owned → deleted. The premise segment's linear growth
  → disclosed (§6).

**Round 2 — REVISE on both lenses, no resolution refuted.** The
classification lens found the resolver still blind to a sentence a METHOD
builds — G3P-04's `Raptor 3 borrowed createMany skipDuplicates requires an
operation-owned member rollback region.`, public, candidate-only, contracted
by three committed files, in no bucket — and the combinator pin blind to the
relation half of the fix. Resolved: the resolver follows a call to a local
factory, a function of the file or a method of the throw's own class to the
constructions its body returns, a `const` bound to one of those, and either
arm of a conditional (the counts restated: 47 → 23 public, the base's 46
was 47 by the same blindness); a fourth cell pins a RELATION
named `AND` (red without the relations term). The execution lens found four
stale numbers (the tool's size, `AGENTS.md`'s hunk, `note-A3.md`'s line
counts) and one undisclosed property of the captured batch route — a
selected `deleteMany` reads its published values before the atomic unit —
which §6 now states. Also corrected: the `validation/model/args/aggregate.ts`
path at three sites, `note-A5.md`'s stale corpus-pin number (83 was
measured on an intermediate tree; with the resolver extended it was 83
again — the addendum says which).

**Round 3 — REVISE, five minors, nothing refuted.** Two stale numbers (the
touched set is 135 / 135 with the fourth combinator cell; `query.ts` is
+81 / −18 after a wrapped comment), the round-1 bullet above still saying
78 of the final tree, and two limits of the census: a message argument that
is a named constant (`CURSOR_ORDER_REFUSAL`, `DISTANCE_NAME_COLLISION`, the
GeoPoint fallback behind `??`) was not rendered, so five sites and three
sentences sat in the rethrow bucket — the tool now reads a named constant
and either side of a `??` (all three registered: 68 → 71 registered, public
unchanged at 23, the corpus-pin reading 85 / 9); and a parameter or catch
clause shadowing an outer constant fooled the binding walk (no such site in
the tree; the walk now stops at the binder). The wordless prose names the
fourth category (a message computed at the site).

**Round 4 — ACCEPT.** All five round-3 resolutions measured and holding
(the touched set 135 / 135, the hunk table exact, the census byte-identical
at 23 / 21 / 11 / 71 / 188 with the three named-constant sentences registered
at their sites, the binding walk stopping at a parameter and at a catch
clause on the reviewer's own probe, the round-1 bullet scoped); two wording
nits applied (§4's corpus-pin number attributed to the run it belongs to;
`note-A5.md`'s addendum quoting the prose's four categories as written).
