# FC-04 — the remaining capability restrictions, re-examined after wave 1

Branch `fc-04` from `7c3c33a4e` (the wave-1 merge: FC-00, FC-01, FC-03, FC-02A,
FCPG; ledger through D-65). Worktree `/private/tmp/viborm-fc04`,
`TMPDIR=/private/tmp/viborm-fc04-tmp`, Node `v24.21.0` / Vitest `3.1.4`.

**Outcome in one line: no avoidable capability restriction remains in the agreed
inventory. Zero behavioural families enabled, zero production lines changed, one
retained limit given the executed witness it did not have.**

## The candidate set, and why it is closed

The brief names two sources, and FC-00's note fixes the same boundary ("FC-04
takes §I and §J as the closed set of limits to re-examine, and §N as the reason
not to work from the refusals map"):

| source | rows | disposition here |
| --- | --- | --- |
| class 2 not owned by FC-01/02/03 | **none** | E-1→FC-01, E-2→FC-02A, E-3→FC-03, F-4→FC-02B, F-6→FC-02C. Every class-2 row has an owner and none is this unit's. |
| class 4 whose accepted status the inventory questions | **D-9**, **J-13** | D-9 confirmed (§ below); J-13 retained and newly witnessed. |
| class 5 the brief's appendix answers | **L-1 (D-14)** | D-64: read-only build contract is an accepted restriction. **No work done**; not touched. |
| the other class-4 rows and **§I's** class-3 rows | §J J-1…J-12, D-7, D-8, G-5; §I I-1…I-19 | re-examined against source at this HEAD; each retained with the missing fact named below. |
| §N — the six stale refusals-map sentences | 6 | re-checked at this HEAD: all six still absent from `src/`; the two re-expressed invariants still present (`receipts/section-n-recheck.txt`). |

The inventory carries **24** class-3 rows; nineteen of them are §I's. The other
five — **C-3**, **C-7**, **C-15** (`inventory.md:112`, `:116`, `:124`), **F-5**
(`:165`) and **F-8** (`:168`) — lie outside FC-04's §I+§J boundary per
`fc00/note.md:79-81` and were **not** re-examined here: four are integrity
refusals (C-3, C-7, C-15 in §C; F-5 in §F) and F-8 is the evidence gap FC-03
answers. The table's class-3 row above covers §I only.

No fresh feature hunt was run, and no row outside the inventory was opened.

## Families enabled: none — and why that is a measurement, not a shrug

For each retained restriction the question the brief asks is whether the needed
fact is *already owned* by the occurrence, the prepared query, the current
binding or the execution boundary after the wave-1 repairs. It is not, in every
case, and the reason is one of four kinds — each of which is a fact the engine
cannot compose from what it holds:

1. **A provider tier the engine refuses to emulate** (J-6, J-7): a distance
   spelling, a physical point tier, pgvector. Composing owners cannot invent a
   provider capability; the standing rule is that the engine never emulates a
   tier in JavaScript.
2. **An exactness or portability guarantee** (J-5, J-10, J-11, J-12): the
   missing fact is a *value* the engine could only supply by rounding, widening
   or re-spelling what the user wrote — a numerical-semantics change, which the
   brief reserves as a decision.
3. **A new public language** (J-3/J-4 via L-3, J-9, and L-2): a server-side
   default spelling, a result alias, a recursive verb. Each needs a vocabulary
   no current owner has; D-59 already declined the first.
4. **An authority or mechanism the transport does not have** (D-9, J-1, I-18,
   I-19): a savepoint inside an atomic batch, a segmentable RETURNING, a
   rollback after a commit. These are substrate facts.

Rows in §I are a fifth kind and were not candidates at all: an integrity or
provider-result requirement is never removed (design contract), and each of the
nineteen still states a thing the driver did that the engine cannot accept —
none of them refuses an operation the engine could otherwise run.

The honest count, per the brief's instruction to count families separately from
sentences: **0 behavioural families enabled, 0 failure sites removed, 0 sentences
renamed.** The public census is byte-identical (23 sentences at 30 sites).

## D-9 — confirmed: the authority rule and a transport fact, not an unnamed gap

`Raptor 3 borrowed createMany skipDuplicates requires an operation-owned member
rollback region.` is built once, at `shared/operation-context.ts:601-616`
(`suppressionRefusal()`), and thrown at `:565` (`executeSkippableMember`) and
`:619` (`requireSuppression`). It has **three arms**, and the sentence's name
covers only the first:

| arm | condition (source) | what is missing | why nothing can compose it |
| --- | --- | --- | --- |
| **authority** | `ownership === "borrowed-transaction" && !this.memberRollback` (`:602`) | a member-scoped rollback region the *borrower* did not grant | the only borrowed binding without the grant is the array owner's sequential fallback (`route/client-route.ts:410-415`, `driverOverride`): there the array owner's transaction **is** the unit, so opening a region inside it would take lifecycle authority the design contract says borrowing never grants |
| **preparation** | `ownership === "batch-preparation"` (`:603`) | a savepoint that can be *prepared into* a batch | a prepared batch is dispatched as one unit; a conditional rollback point is not a statement the package can carry |
| **mechanism** | `this.usesBatch` (`:604`), i.e. `batch-preparation` **or** standalone on a driver with no transactions (`:413-415`) | a savepoint at all | the transport has none; this arm is reached with full standalone authority, so it is a substrate fact and not an authority one |

**The reach is narrow, and that is the point.** Suppression asks for a region
only where a whole record subtree must be undone: a relation-bearing
`createMany` or a nested one becomes a record series whose members carry
`suppression` (`commands/commands.ts:1697-1701`, `commands/relation-body.ts:393`)
and is checked at analysis (`commands/commands.ts:1334`). The relation-free
scalar path asks for it only on an adapter whose `skipDuplicatesStrategy` is
`recoverableUniqueError` — MySQL alone (`adapters/databases/mysql/mysql-adapter.ts:857`);
SQLite and PostgreSQL spell the skip in SQL (`ON CONFLICT DO NOTHING`) and never
reach the refusal (`shared/operation-context.ts:2098`, `:2113-2120`).

**The successful neighbour exists and is borrowed.** Inside
`$transaction(callback)` the route *transfers* the grant
(`route/client-route.ts:421-432`), so a borrowed `createMany skipDuplicates`
executes, one savepoint per suppressed member (`withMemberRollback`, `:580-600`).
So the limit is not "borrowed authority cannot suppress"; it is "an operation
that owns no region cannot suppress", which is exactly R-5's standing rule.

**Executed witnesses at this HEAD** (re-run, green — the arm the sentence names
asserts the effect, not just the throw):

- authority arm: `tests/raptor3/prep/g3p04-review-regressions.test.ts` — three
  cells refuse *before the parent scalar write*, with the exact sentence
  (`receipts/d9-authority.log`).
- mechanism arm: `tests/raptor3/prep/suppression-replay.test.ts` — the
  batch-only driver legs (`receipts/d9-mechanism.log`).
- the working neighbour: `tests/raptor3/g3/suppression-retry-contract.test.ts`
  pins one savepoint per suppressed member and the healthy suffix; the fixed
  lane's `tests/contracts/engine/write/create-many-skip-depth.test.ts` runs both
  substrates side by side (not run here — fixed lane).

**No new pin was written for D-9.** Its coverage exists and is nameable, and a
second pin would be a redundant guard. The inventory's witness column for D-9
(`g4/unit02/borrowed-envelope.test.ts`) is wrong: that file pins the borrowed
*envelope*, not suppression — the correction is in the guide addendum.

**Ruling status:** R-5's default applies (`remaining-decisions.md`: "confirmed as
an authority limit; FC-04 records it as such and does not implement it"). Making
the authority arm execute would mean an implicit savepoint inside a caller's
transaction, which the design contract forbids: a contract change, not a repair.

## J-13 — retained, and now measured

`The Raptor 3 route cannot encode a cached result for '…' on model '…': the verb
publishes no prepared read.` (`route/client-route.ts:210-215`).

**What is missing:** one upstream owner — or one type — reconciling the official
cache's `CACHEABLE_OPERATIONS` (`src/query-engine/cache-flow.ts:29-39`, nine
names, both `…OrThrow` variants among them) with the engine's own
`READ_OPERATIONS` (`src/query-engine/raptor3/shared/schema.ts:47-55`, seven).
The two lists live in different layers, nothing types them together, and the
whole reconciliation today is `admittedOperation`'s `…OrThrow` normalization
(`commands/index.ts:33-36`) feeding the read gate at `commands/index.ts:171`.

**Why composing current owners cannot supply it:** the fact wanted here is
"every verb the cache layer will offer me is a verb I publish a read for". That
is a statement about *another layer's* vocabulary; the route holds neither list
and cannot derive one from the other. Asserting it at the throw site would
establish a missing fact rather than state an established one (ELEGANCE §5), and
creating the missing owner is a cross-layer ownership change that would enable
no behaviour — because, measured, no cacheable verb reaches the refusal today.

**This limit restricts nothing, and that is now executed rather than read.** New
pin `tests/raptor3/g4/parity/cacheable-read-vocabulary.test.ts` (3 cells):

1. all nine cacheable names publish a codec, and each codec round-trips *that
   operation's own executed result* — `Date` leaves included, so a snapshot that
   lost the leaf codecs fails here. The nine names are a hand copy of a
   module-private set, so the cell also ties them to the gate that owns them:
   `validateCacheableOperation` (`cache-flow.ts:223`, exported) admits each, and
   the list it publishes when it refuses (`CacheOperationNotCacheableError`,
   `cache-flow.ts:228-230`, `errors/cache.ts:46`) is exactly those nine;
2. both `…OrThrow` names are served by their base read's codec (the two places
   the vocabularies differ) — `findUniqueOrThrow`/`findUnique` and
   `findFirstOrThrow`/`findFirst`, each with its absent arm and the base codec's
   snapshot equality;
3. a verb the cache layer never offers (`create`) reaches the boundary with its
   exact sentence and `UnsupportedOperationError` identity — and reaches it
   *before* anything is admitted or dispatched: the recording driver submitted
   no statement.

**Falsified in both directions** (backup copies, restored by `cp`, md5 verified):

- *removal* — dropping `"exist"` from the engine's `READ_OPERATIONS` turns cell 1
  red with `… cannot encode a cached result for 'exist' …`
  (`receipts/pin-falsified.log`), cells 2 and 3 green;
- *addition* — appending a tenth name to the cache layer's `CACHEABLE_OPERATIONS`
  (the direction that would crash a user's cached read) turns cell 1 red on the
  published vocabulary (`receipts/pin-falsified-addition.log`), cells 2 and 3
  green.

The pin discriminates the fact it claims, and a divergence introduced from
either side fails here rather than at a user's cached read.

The inventory's witness column for J-13 (`g4/parity/lane-x-route-seam.test.ts`)
is wrong: that file pins acknowledged-row counts and a short result window.
What the base receipt establishes is a **naming** fact, not a reachability one
(`receipts/cache-codec-coverage-at-base.txt`, retitled in the repair round): at
`7c3c33a4e` **no test named `cacheResultCodec()` or the refusal sentence**, and
none exercised the nine-name cacheable vocabulary or the refusal arm. The codec
itself was already reached — the official cache rail builds it eagerly on every
cached read (`client/client.ts:716` `readPendingCacheResult` →
`query-engine/pending-operation.ts:216-220`, `:519-521`), so the fixed lane's
`tests/contracts/public-client/official-cache-reads.test.ts:324` gets there
through `findUniqueOrThrow`, as do the other 24 `withCache` files for the verbs
they cache. What was missing is the vocabulary as a whole and the boundary's own
reach, which is what this pin adds.

## D-14 — class 4 under D-64, untouched

`buildStatement()` / `QueryEngine.build()` answer the one statement a READ
compiles to and refuse every write. D-64 (2026-09-21) records the read-only
contract as an **accepted capability restriction, not a recovered feature**, and
closes FC-00/FC-04's question. Per the brief, FC-04 did **no** work on it: the
build path, the D-14 pin and the CHANGELOG are untouched by this unit. The row
moves from class 5 to class 4 with D-64 as its ruling; FC-06 records it.

One accurate-claims observation for FC-06, which is not a change and not a
blocker: the pin D-64 cites,
`tests/raptor3/g4/review/cutover/d14-publication.review.test.ts`, **executes in
no vitest project** at this HEAD — it is absent from every `*_TESTS` group of
`scripts/raptor3-manifest.mjs` and excluded from `extended-local` by the
`tests/raptor3/g4/review/` prefix rule
(`scripts/credential-free-test-manifest.mjs:263`). Measured twice:
`receipts/d14-pin-no-lane.log` (the runner answers "No test files found") and
`receipts/project-membership.txt` (from the manifests themselves). The whole
`g4/review/unit02/` and `g4/review/cutover/` trees are in the same position;
`g4/review/unit01*` is registered. FC-04 did not touch the manifest.

## The retained limits — §J, row by row, against source at `7c3c33a4e`

| row | sentence / site at this HEAD | precisely what is missing | the owner that would have to supply it | retained because |
| --- | --- | --- | --- | --- |
| J-1 | `Raptor 3 G1 atomic output requires exact identity scratch or segmented RETURNING` (`operation-context.ts:2835`) | a typed scratch slot per produced domain, or a RETURNING the provider can segment inside one batch | the batch scratch (`batchRefs.storeInsertedKey`) | **D-55 binding.** The scratch carries ONE generated increment key because the dialect stores it from the statement that produced it; a second produced domain has no store. Widening it is a ruling, not a composition. |
| J-2 | `Raptor 3 cannot name the updated value of '…' under '…'` (`query.ts:1162`) | the rounded result of the provider's own `multiply`/`divide` on a decimal **relation** key, before the provider computes it | the provider | **D-56 binding.** Naming it would mean computing the provider's rounding in JavaScript — a numerical-semantics change. |
| J-3 | `Driver '…' cannot locate one selected createMany row after insertion.` (`operation-context.ts:2128`) | a database-side default spelling for a generated key that is not one `increment` column | the schema vocabulary (L-3) | **D-59 binding.** MySQL refuses two `AUTO_INCREMENT` columns at DDL (measured, errno 1075), so no schema this ORM can push reaches the alternative. |
| J-4 | `Raptor 3 interactive output requires RETURNING or one generated increment field` (`operation-context.ts:2755`) | as J-3 | as J-3 | **D-59 binding.** |
| J-5 | PK arithmetic portability / divide-by-zero / one operation per key (`schema.ts:204`, `query.ts:1052`) | portable arithmetic semantics for a key across providers | the providers | inherited; each is a *value* the engine could only produce by choosing a rounding or overflow rule the providers disagree on. |
| J-6 | `distance …` / `GeoPoint requires a provider with its physical point tier enabled.` / `within polygon` (`query.ts:2391`, `:863`, `:2176`) | a provider distance/point/polygon tier | the adapter, which reports it absent | the engine never emulates a tier in JavaScript (AGENTS.md); emulation would also change the meaning of `orderBy`. |
| J-7 | vector tier / nullable vector / dimension mismatch (`query.ts:2369`, `:2373`, `:2383`) | pgvector, or a declared dimension the value matches | the adapter and the schema | as J-6; the dimension arm is an exactness fact about the value, not a tier. |
| J-8 | `Cursor pagination supports direct scalar sort directions only…` (`query.ts:416-417`, raised `:2666`, `:2794`), `Cursor field '…' cannot be null.` (`:2902`), `Paginated scalar ordering requires a primary model identifier.` (`:2866`) | a **stable, row-addressable** total order the cursor predicate can name | `Queries.totalOrder` / `cursorCondition` | the cursor row is fetched as a derived row of the model's own columns; a relation `_count` and a vector distance are computed per query, are not columns of that row, and are not stable between the two reads — so the lexicographic window cannot be spelled against them even if they were computed. `identityOrder` (`:2858-2872`) already accepts a compound primary key and any row key; it refuses only a model with **no** unique identifier, which has no total order at all. |
| J-9 | `Distance select supports only one _distance field per select.` / `A distance result cannot be selected together with a model field named '_distance'.` (`query.ts:3695`, `:3702`, `:3716`) | a name the result shape can carry twice — i.e. a public alias | the public projection vocabulary | a new public language (and D-24 restored the registered sentence deliberately). |
| J-10 | field-reference comparability, incl. decimal precision/scale (`query.ts:1745`, `:1750`, `:1756`) | an exact comparison between two differently-declared decimals, or across models | the declaration | exactness over silent coercion; the alternative is a numerical-semantics change. |
| J-11 | decimal declaration and exactness, `having` `_sum` operand domain (`decimal.ts:56`, `:66`, `:85`; `query.ts:2269`) | an exact value to bind, or a wider exact cast domain the provider offers | the schema declaration and the provider | as J-10. |
| J-12 | JSON path grammar: `path` with a whole-column sentinel, operand kind, non-portable spellings (`query.ts:2301`, `:2323`) | one portable path spelling every provider can address | the adapters' JSON tier (D-22, Lane Q) | SQLite's JSONPath admits no escapes in a quoted label, so some keys are unaddressable there; a per-provider grammar would be two meanings for one filter. |
| J-13 | the route cache codec boundary (`client-route.ts:210-215`) | one upstream owner reconciling two layers' vocabularies | neither layer holds both lists | see above — and measured to restrict nothing today. |

### The class-4 rows recorded outside §J

- **D-7** (a later segment's failure leaves earlier segments committed, and the
  error says so) — the approved progress contract of D-58, not a rollback
  promise. Keep.
- **D-8** (a transport fact has its own witness per driver) — D-53; a rule about
  evidence, not a refusal. Keep.
- **D-9** — confirmed above.
- **G-5** (an uncertain outcome is never retried) — the design contract. Keep.

### §I — the nineteen necessary failures

Each was re-read against the census at this HEAD (`receipts/census-7c3c33a4e.md`)
and none refuses an operation the engine could run. They divide into: the driver
answered impossibly (I-1, I-2, I-3, I-4, I-5, I-7, I-11, I-12, I-13), another
transaction interfered (I-6, I-8, I-9, I-10), the payload is illegal at
admission (I-15), a relation reference would name no row (I-16), the cache
representation is malformed (I-17), and the transport cannot supply the
mechanism or cannot roll back after a commit (I-18, I-19). I-6's sentence is
also the one E-2 reached wrongly; FC-02A's repair left this reach intact, which
`receipts/census-7c3c33a4e.md` shows unchanged at `operation-context.ts:3037`
and `:3074`.

## Witness and result

| | base `7c3c33a4e` | after |
| --- | --- | --- |
| `tests/raptor3/g4/parity/cacheable-read-vocabulary.test.ts` | did not exist; **no test named `cacheResultCodec()` or the refusal sentence, and none exercised the nine-name vocabulary or the refusal arm** — while the official-cache rail already reached the codec for the verbs the fixed lane caches (`official-cache-reads.test.ts:324`, `findUniqueOrThrow`) | 3 cells, green (`receipts/pin-green.log`, re-run `receipts/pin-green-repair-round.log`) |
| the same pin with `"exist"` removed from `READ_OPERATIONS` (falsification, restored) | — | 1 failed / 2 passed, with the J-13 sentence naming `exist` (`receipts/pin-falsified.log`) |
| the same pin with a tenth name added to `CACHEABLE_OPERATIONS` (falsification, restored) | — | 1 failed / 2 passed, the gate's published list no longer the nine (`receipts/pin-falsified-addition.log`) |
| D-9's three arms | green | green, unchanged (`receipts/d9-authority.log`, `receipts/d9-mechanism.log`) |

There is no "base red" for this unit: it enables no family. The falsifications
are what make the new pin's claims refutable — one per direction of the
vocabulary divergence, plus one for the `…OrThrow` mirror
(`receipts/pin-falsified-orthrow-mirror.log`).

## Fact, owner, hunk, rule deleted, second placement

- **Fact established.** Every verb the official cache will hand to the route
  publishes a prepared read, so the route's cached-result boundary restricts no
  admitted operation; and the suppression refusal is the operation's
  region-ownership rule with three named arms, one of them a transport fact.
- **Owner.** Unchanged in both cases: `commands/index.ts` `admittedOperation` +
  the read gate for the first, `OperationContext.suppressionRefusal()` for the
  second. No owner was added, moved or duplicated.
- **Hunk.** **None in `src/`.** `git diff 7c3c33a4e -- src` is empty. The unit
  adds one test file and its evidence.
- **Rule deleted.** None. Deleting either refusal would remove a boundary that
  no measurement showed to be avoidable; the brief's instruction in that case is
  to state what is missing, which is what this note does.
- **Second placement.** The new pin exercises the boundary at two placements —
  the nine-name read vocabulary (including the two `…OrThrow` names that only
  the cache layer knows) and a write verb — and at four result modes (row,
  array, scalar `count`/`exist`, aggregate/grouped document). D-9's confirmation
  rests on three placements: root relation-bearing series (authority arm),
  batch-only transport (mechanism arm) and the granted borrowed scope (the
  working neighbour).

## Capability change

**None.** No behaviour is enabled, refused, widened or narrowed. The engine
perimeter is byte-identical to the base.

## Registrations (the integrator applies them; `scripts/raptor3-manifest.mjs` not edited)

| file | cells | group |
| --- | ---: | --- |
| `tests/raptor3/g4/parity/cacheable-read-vocabulary.test.ts` | 3 | `G4_PARITY_COUNTS` |

Until it is registered the file runs in `extended-local` (192 files); registering
it moves it to `raptor3` (190 → 191) and `coverage-raptor3`, and out of
`extended-local`, exactly as FC-01's and FC-03's pins did
(`receipts/project-membership.txt`).

## Runs (no wide runs; one vitest at a time)

| file | cells | result | receipt |
| --- | ---: | --- | --- |
| `tests/raptor3/g4/parity/cacheable-read-vocabulary.test.ts` | 3 | passed | `pin-green.log` |
| the same, falsified in a backup copy | 3 | 1 failed / 2 passed (intended) | `pin-falsified.log` |
| the same, after the repair round (**repair round**) | 3 | passed | `pin-green-repair-round.log` |
| the same, a tenth name added to `CACHEABLE_OPERATIONS` in a backup copy (**repair round**) | 3 | 1 failed / 2 passed (intended) | `pin-falsified-addition.log` |
| the same, `findFirstOrThrow`'s normalization dropped in a backup copy (**repair round**) | 3 | 2 failed / 1 passed (intended) | `pin-falsified-orthrow-mirror.log` |
| `tests/raptor3/prep/g3p04-review-regressions.test.ts` | 5 (×2 projects) | passed | `d9-authority.log` |
| `tests/raptor3/prep/suppression-replay.test.ts` | 5 (×2 projects) | passed | `d9-mechanism.log` |
| `tests/raptor3/g4/parity/lane-x-route-seam.test.ts` | 3 | passed | `route-seam-neighbour.log` |
| `tests/raptor3/g4/review/cutover/d14-publication.review.test.ts` | — | **no test files found** (belongs to no project) | `d14-pin-no-lane.log` |

Peak sampled process-group RSS across the runs: 553.6 MiB (ceiling 1536 MiB).
Files chosen as the discriminating set: the new pin, the owner whose refusal the
D-9 confirmation reads (its two registered witness files), the route seam's own
neighbour family, and the one file the D-14 status claim depends on. No
directory, no fixed lane, no campaign.

## Typecheck

`node scripts/run-typecheck.mjs` → **0 diagnostics**, exit 0, 5.97 s, 5036.9 MiB
(`receipts/typecheck.log`). The first attempt failed on one TS2554 in the new
test (a 4-argument `super.execute`); it is kept as
`receipts/typecheck-first-attempt.log` and was repaired in the test, not by
relaxing anything.

## Census

`node scripts/raptor3-refusal-census.mjs`, run once at the base and unchanged by
this unit: **23 public sentences at 30 sites**, 72 registered, 21 invariants at
22 sites, 11 internal, 57 without a readable sentence, **192 sites**. Identical
to FC-00's `29a7bf9d8` receipt except for line numbers moved by wave 1
(`receipts/census-7c3c33a4e.md`). **Before = after.**

## Biome

No tracked file changed, so no base copy is compared. The one new file was
formatted with `node_modules/.bin/biome format --write` and
`node_modules/.bin/biome check` reports **no diagnostics**.

## LOC

`node scripts/query-engine-structure.mjs` (`receipts/structure-7c3c33a4e.json`):
38 files, 20,430 physical lines, **16,064 parser-token-bearing lines** — before
and after, because `git diff 7c3c33a4e -- src` is empty. (FC-00 measured 16,036
at `29a7bf9d8`; wave 1 added 28.) The new test file is 241 lines (183 before the
repair round) and is counted with tests, not with the engine.

## Unverified

1. The J-13 measurement is taken at the route seam
   (`createCandidateRoute(...).operation(...).cacheResultCodec()`), which is the
   seam the limit lives on. It does **not** re-execute the official cache's own
   rail end to end; `tests/contracts/public-client/official-cache-reads.test.ts`
   covers `findUniqueOrThrow` through that rail and was not run here (fixed
   lane). `findFirstOrThrow` has no end-to-end cache cell anywhere.
2. D-9's MySQL arm (`skipDuplicatesStrategy === "recoverableUniqueError"`) was
   read from the adapter, not executed: the Docker MySQL lane is out of this
   unit's run scope. The arms executed here are the borrowed/no-grant and
   batch-only ones on SQLite/PGlite fixtures.
3. The claim that the D-14 pin runs in no project is a manifest and runner fact
   at this HEAD; whether that is deliberate is FC-06's to state.
4. §I and §J were re-read against source and the census; no provider run was
   made for any of them by this unit.
5. This unit did not measure whether any §I sentence is *unreachable* — only
   that each states a necessary failure. A dead-site audit is the census's
   bounded blind spot and belongs to FC-06.

## Blockers

**None.** No public-contract change, no new recovery authority and no numerical
semantics were needed, because nothing was repaired. The two decisions that
remain open are recorded, not chosen:

- **R-2 / L-2** — the private recursive-read fit (D-54). Unchanged; the default
  is "keep private". FC-04 asserts nothing about it beyond the census's
  re-checked privacy.
- **R-3 / L-3** — a database-side default spelling. Declined once under D-59;
  listed so J-3/J-4 are not silently re-derived.

R-1 is closed by D-64; R-5 is confirmed by this unit under its stated default.

## Guide addendum

Beside the D-9 row and the J-13 row of FC-00's inventory, as an addendum rather
than a rewrite (the inventory is frozen): both rows' **witness columns are
wrong**, and the corrected witnesses are named in this note —
`prep/g3p04-review-regressions.test.ts` + `prep/suppression-replay.test.ts` for
D-9, and `g4/parity/cacheable-read-vocabulary.test.ts` (new) for J-13, which had
none. D-9's row should also read "the operation owns no member rollback region"
rather than "borrowed", since one of its three arms is reached under standalone
authority on a transaction-less driver.

## Repair round — 2026-09-21

Four review findings applied; none needed a decision, a public-contract change
or a production hunk. `git diff 7c3c33a4e -- src` is **still empty** and the
census is still 23/30/192.

**1 (major) — the novelty claim was false.** "No test in the tree reached
`cacheResultCodec()` at all" (note `Witness and result`, the J-13 section, the
commit draft, and ledger `g4.md`) measured a **grep**, not an execution. The
official cache rail reaches the codec eagerly on every cached read
(`client/client.ts:706-729` calls `readPendingCacheResult` at `:716`, which
builds `codec: operation.#cacheResultCodec()` at
`query-engine/pending-operation.ts:216-220`, resolving through `:519-521`), and
25 test files use `withCache` — `official-cache-reads.test.ts:324` caches a
`findUniqueOrThrow` and asserts one `cacheDriver.sets` entry, a snapshot only the
codec can produce. All four places now state the fact the receipt establishes —
at the base no test **named** `cacheResultCodec()` or the refusal sentence, and
none exercised the nine-name vocabulary or the refusal arm — and
`receipts/cache-codec-coverage-at-base.txt` is retitled to the question its grep
actually answers, with the rail's reach recorded beside it. My own `Unverified`
item 1 had already said the rail covers `findUniqueOrThrow`; the overstatement
contradicted it.

**2 (major) — the pin guarded only one direction.** `CACHEABLE_OPERATIONS` is
module-private (`cache-flow.ts:29`, and its `Set<string>` is the missing type tie
J-13 names), so the nine names were a hand copy and the pin iterated its own
list. A verb ADDED to the cache layer with no prepared read — the direction that
crashes a user's cached read — could not fail here. Cell 1 now ties the copy to
the gate: `validateCacheableOperation` (exported, `cache-flow.ts:223`) must admit
each of the nine, and the list it publishes when it refuses
(`CacheOperationNotCacheableError`, `cache-flow.ts:228-230`) must be exactly
those nine. **Falsified**: `"createMany"` appended to `CACHEABLE_OPERATIONS` in a
backup copy (restored by `cp`, md5 `62f5918…` before and after) → 1 failed /
2 passed, `the cache layer's vocabulary is no longer exactly these nine names`
(`receipts/pin-falsified-addition.log`). The removal direction was re-falsified
unchanged (`"exist"` out of `READ_OPERATIONS` → 1 failed / 2 passed with the J-13
sentence). No second owner and no policy bit: the gate is read, not re-stated.

**3 (minor) — cell 2 overstated "both".** It exercised `findUniqueOrThrow` only.
The mirrored assertions for `findFirstOrThrow`/`findFirst` are added (round-trip,
absent arm, base-codec snapshot equality), so the cell's title, note and ledger
are now true of both places the vocabularies differ. **Falsified**: dropping
`admittedOperation`'s `findFirstOrThrow → findFirst` arm
(`raptor3/commands/index.ts:35-36`) in a backup copy (restored by `cp`, md5
`d9d2304…` before and after) turns **cells 1 and 2** red; before the repair the
same mutation could turn only cell 1 red
(`receipts/pin-falsified-orthrow-mirror.log`).

**4 (minor) — the candidate table's class-3 label.** The row read as whole-class
coverage; the inventory has 24 class-3 rows, of which five (C-3, C-7, C-15, F-5,
F-8) are outside §I. The source column now says "**§I's** class-3 rows" and a
clause below the table names the five and why they are out of scope
(`fc00/note.md:79-81` fixes FC-04's set at §I+§J).

**Runs (repair round).** `tests/raptor3/g4/parity/cacheable-read-vocabulary.test.ts`
3/3 green (`receipts/pin-green-repair-round.log`); the same with a tenth
cacheable name, 1 failed / 2 passed (`receipts/pin-falsified-addition.log`); the
same with `"exist"` removed, 1 failed / 2 passed (unchanged from
`receipts/pin-falsified.log`); the same with the `findFirstOrThrow` normalization
dropped, 2 failed / 1 passed (`receipts/pin-falsified-orthrow-mirror.log`). Every
falsified copy was restored by `cp` and its md5 re-verified; `git diff
7c3c33a4e -- src` is empty. Cell count unchanged at **3**, so the registration
below is unchanged. No other file was re-run: no `src` line changed, so no
owner's pins are affected. **Typecheck** re-run once: 0 diagnostics, exit 0
(`receipts/typecheck-repair-round.log`). **Biome** `check` on the one changed
file: no diagnostics. **Census** not re-run — no refusal, error class or site
changed. **LOC** unchanged at 16,064 token lines.

## Commit message draft (the integrator commits)

```
test(raptor3): the route's cached-result vocabulary boundary, measured — and D-9 confirmed as the region-ownership rule (FC-04)

FC-04 re-examined the closure inventory's closed set of limits (§I, §J, plus
D-7/D-8/D-9/G-5 and §N) after the wave-1 repairs and found NO avoidable
capability restriction left: zero behavioural families enabled, zero production
lines changed, the public census byte-identical at 23 sentences / 30 sites.

Two rows the inventory singled out are answered.

D-9 is confirmed as an authority limit and not an unnamed gap (R-5's default).
`suppressionRefusal()` (shared/operation-context.ts:601-616) has three arms:
a borrowed binding with no memberRollback grant — reached only by the array
owner's sequential fallback, where the array owner's transaction IS the unit;
a batch preparation, which cannot carry a conditional rollback point; and
`usesBatch`, reached with full standalone authority on a driver with no
transactions, which is a transport fact rather than an authority one. Inside
$transaction(callback) the route transfers the grant and the same operation
executes, one savepoint per suppressed member — so the rule is "an operation
that owns no region cannot suppress". Its executed witnesses already exist
(prep/g3p04-review-regressions, prep/suppression-replay, g3/suppression-retry-
contract) and were re-run green; no redundant pin was added.

J-13 is retained with its missing fact named — one upstream owner reconciling
cache-flow's nine CACHEABLE_OPERATIONS with the engine's seven READ_OPERATIONS,
which neither layer holds — and is now measured instead of read. The new pin
executes all nine cacheable names through the route seam, round-trips each
operation's own result through its codec (Date leaves included), shows both
…OrThrow names served by their base read (findUniqueOrThrow/findUnique and
findFirstOrThrow/findFirst, absent arm and snapshot equality each), and pins the
refusal's own reach on a write verb before anything is admitted or dispatched.
The nine names are tied to the gate that owns them — validateCacheableOperation
admits each and publishes its whole list when it refuses — so the pin sees both
directions. Falsified twice: removing "exist" from READ_OPERATIONS turns cell 1
red with the J-13 sentence naming exist, and adding a tenth name to
CACHEABLE_OPERATIONS turns it red on the published vocabulary. At the base no
test NAMED cacheResultCodec() or the refusal sentence and none exercised the
cacheable vocabulary or the refusal arm; the codec itself was already reached by
the official cache rail for the verbs the fixed lane caches.

D-14 stays class 4 under D-64 and was not touched. Recorded for FC-06: the pin
that ruling cites, g4/review/cutover/d14-publication.review.test.ts, executes in
no vitest project at this HEAD.

Registration for the integrator:
  G4_PARITY_COUNTS["tests/raptor3/g4/parity/cacheable-read-vocabulary.test.ts"] = 3

Runs: the new pin 3/3 green and 1/3 red under each of its two falsifications;
prep/g3p04-review-regressions 5×2 green; prep/suppression-replay 5×2 green;
g4/parity/lane-x-route-seam 3 green. Typecheck 0. Census 23/30/192, before =
after. Engine perimeter unchanged at 16,064 token lines.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
```
