# FC-00 — freeze a behavioral closure inventory

Docs unit. Branch `fc00` from `29a7bf9d8`, worktree `/private/tmp/viborm-fc00`,
`TMPDIR=/private/tmp/viborm-fc00-tmp`, Node `v24.21.0`, Vitest `3.1.4`.
**No engine file, no test file and no registration changed.**

Deliverables: [`inventory.md`](inventory.md) (102 rows, the frozen surface the
rest of the closure program implements against) and
[`remaining-decisions.md`](remaining-decisions.md) (the five items that need
Arnaud). Receipts under [`receipts/`](receipts/).

## The witness and its result at the base and after

This unit ships no behavioral repair, so its witnesses are the falsifiable
claims the inventory rests on. Each was executed or grepped at the base; the
"after" column is what the deliverables now say.

| # | witness | at the base `29a7bf9d8` | after |
| --- | --- | --- | --- |
| W-1 | **D-14's contract.** Probe through the public client on in-process SQLite: `buildStatement()` per verb, and the statements each verb actually executes (`receipts/probe-d14-build-contract.log`, `receipts/probe-d14-build-contract.test.ts.txt`) | **contradiction, unrecorded:** `findMany` publishes its `Sql`; `create`, `update`, `delete` and a non-relation `deleteMany` all answer `undefined` while executing **exactly one** statement each. D-14 promised the folded write; the CHANGELOG documents it as refused | recorded as inventory row **L-1, class 5**, with both options and their exact code/test/doc cost in `remaining-decisions.md` R-1. **Not chosen.** |
| W-2 | **D-16's status.** `git grep`/read of the ledger's D-16 records, `g4/cutover-execution/note.md` R3.2/R4.2 and `docs/architecture/raptor3-parity-plan.md` §0/§3/§5 | **contradiction:** the ledger says both "D-16 all 115 repaired" (`d82c123b`) and "the D-16 families Arnaud has not ruled on" (the Release verdict record after commit 31 (2026-09-20, evening) and the Release-verdict addendum) | reconciled in inventory §M and in a dated ledger record: **no family is awaiting Arnaud**; the later clauses are stale status paragraphs. Two items still trace to that surface, both already owned (E-1 → FC-01; the kept-red pg registration → FC-06) |
| W-3 | **The refusals map's currency.** Each of the map's 55 exact sentences grepped under `src/` | **six rows name sentences that are not in the tree** (#23, #25, #31, #32, #48, #49) — and `#25`'s removal means selected bulk mutations now execute on batch-only transports, a capability the map records as refused | the map gains an **addendum** (not a rewrite) at `g4/release/plan/refusals-map.md`; the inventory is now the authority for capability (rows B-6, C-13, D-3, A-7) |
| W-4 | **The census's meaning.** `node scripts/raptor3-refusal-census.mjs` at this HEAD (`receipts/census-29a7bf9d8.md`) | **23** public sentences / 21 invariants / 11 internal / **72** registered / 57 unreadable / 192 sites — a message-newness metric, with the 72 inherited sentences reported apart and unclassified | all 72 classified on behavior in inventory §K (none is class 2); the three standing cautions recorded, including that E-3 reaches an *invariant* (`shared/query.ts:2171`) and is still a refused valid operation |
| W-5 | **The class-2 set is closed and owned.** The closure review's `paired-probes.log`, the T3 pins, the N5 note | three executed failures with passing controls, plus two residuals: one pinned green-over-red, one with **no executed witness at all** | five class-2 rows (E-1, E-2, E-3, F-4, F-6), each with its owner (FC-01, FC-02A, FC-03, FC-02B, FC-02C), its red cell and its nearest green neighbour |

## The fact this unit establishes

**There is one finite, source-linked surface of admitted behaviors, and every
row on it has a class, an owner and an action.** Capability is a property of
behaviors, not of error sentences: the 23-public figure and the 72-inherited
figure are provenance metrics that answer a different question, and neither
counts unavailable operation families.

## The owner

`docs/architecture/raptor3-evidence/g4/release/closure/fc00/inventory.md` is now
the capability authority for the closure program. The refusal census
(`scripts/raptor3-refusal-census.mjs`) remains the authority for **sentences**,
unchanged and unmodified; the refusals map remains the per-row ruling for the
sentences that still exist. The three are layered, not duplicated: sentence →
ruling → behavior.

## The hunk

| file | change |
| --- | --- |
| `docs/architecture/raptor3-evidence/g4/release/closure/fc00/inventory.md` | new — 102 rows in sections A–L, plus §M (D-16), §N (the stale map) and §O (unverified) |
| `.../fc00/remaining-decisions.md` | new — R-1 … R-5 |
| `.../fc00/note.md` | new — this note |
| `.../fc00/receipts/` | new — the probe log and source, the census at this HEAD, the manifest counts, the structure JSON |
| `docs/architecture/raptor3-evidence/g4/release/plan/refusals-map.md` | **+13 lines, an addendum block after the opening paragraph.** Nothing existing altered |
| `docs/architecture/raptor3-evidence/g4.md` | **+87 lines, one record** inserted directly after the Release-verdict addendum, which is the paragraph whose stale D-16 clause it corrects |

No file under `src/`, `tests/`, `scripts/` or `benchmarks/` was modified. The
one file this unit created under `tests/` — the probe — was deleted before the
unit closed; `git status` shows `tests/` clean.

## The rule deleted

**None, and that is the honest answer** (the design contract admits it for new
meaning). This unit deletes no mechanism. What it *retires* is an inaccurate
claim in three places, each by a dated superseding statement rather than a
rewrite:

1. the ledger's "the D-16 families Arnaud has not ruled on";
2. the refusals map's six stale rows and its obsolete leverage ranking;
3. the implicit reading of "23 public refusals" as a capability count.

Sealed historical receipts are untouched — no old failure is rewritten into a
pass.

## The second consumer / second placement

The inventory has four independent consumers, which is why it is a table and
not prose:

- **FC-01/02/03** take their class-2 rows, red cells and green controls from
  §E and §F (E-1, E-2, E-3, F-4, F-6) and are forbidden to touch each other's.
- **FC-04** takes §I and §J as the closed set of limits to re-examine, and §N
  as the reason not to work from the refusals map; L-1's answer decides its
  build-contract work.
- **FC-05** takes G-1, G-2 and G-3 as its consolidation targets **and** as the
  distinctions it must not flatten.
- **FC-06** takes §L (hosted deferral, L-5/L-6), §M's M-2 (the kept-red pg
  registration to measure once on the frozen tree), §K (the honest census
  labelling) and §O (what stays unverified).

The D-14 probe has a second placement of its own: it measured both the answer
(`buildStatement()`) and the fact that answer contradicts (the executed
statement count), so it discriminates option A's feasibility, not just the
current behavior.

## Capability change

**None.** No behavior is enabled, refused, widened or narrowed by this unit.
The census is byte-identical at 23 public sentences; the engine perimeter is
byte-identical.

Recorded as *newly known* rather than newly true: four capabilities the
refusals map still lists as refused are already executing at this HEAD
(selected bulk mutations on batch-only transports; `set` on a non-junction
variant collection; the array form; a non-int computed value published across
a batch boundary, witnessed by
`g4/parity/batch-observed-publication.test.ts` — "a bigint key and a decimal
key publish through the same observation", "the observation is taken BEHIND
the write"). Those are not FC-00 gains — they are parity/N-series/D-58 gains
that the map never recorded.

## Runs

Per Arnaud's instruction, no wide runs. One vitest at a time.

| file | cells | result |
| --- | ---: | --- |
| `tests/raptor3/g4/parity/fc00-build-contract.probe.test.ts` (created, run twice, **deleted**) | 5 | 5 passed, 5 passed. Final run 3.34 s launcher wall, **522.1 MiB** peak sampled process-group RSS (ceiling 1,536 MiB), teardown verified — `receipts/probe-d14-build-contract.log` |

Probes used: **1 of the 10 permitted.** No registered suite was run: this unit
touches no owner, so it has no owner's pins to re-run, and running a neighbour
family would have measured nothing about a documentation change.

## Typecheck

`node scripts/run-typecheck.mjs` → **exit 0, zero diagnostics** (whole estate,
native; 6.09 s wall, 4,966.9 MiB peak sampled process-group RSS against the
8,192 MiB native-typecheck ceiling, teardown verified). Receipt:
`receipts/typecheck.log`. No `.ts` file is modified by this unit; the only one
it created was deleted before the run.

## Census

`node scripts/raptor3-refusal-census.mjs` → **23 public** distinct sentences at
30 sites, 21 invariants at 22 sites, 11 internal, 72 registered, 57 sites
without a readable sentence, **192 sites total** — unchanged, as required (no
refusal or error class was touched). Receipt: `receipts/census-29a7bf9d8.md`.

## Biome

`node_modules/.bin/biome check` on all four changed/added Markdown paths:
**0 files processed** — Markdown is outside this repository's Biome
configuration, so the diagnostic counts are identical to the base copies (zero,
by construction). No formatter was run on any file.

## LOC

`node scripts/query-engine-structure.mjs` (receipt
`receipts/structure-29a7bf9d8.json`):

| measure | before | after |
| --- | ---: | ---: |
| `src/query-engine/**` parser-token-bearing lines | 16,036 | **16,036** |
| physical lines | 20,333 | **20,333** |
| files | 38 | **38** |

Unchanged, as a docs unit must be.

## Unverified

1. **F-6** — the found-`connectOrCreate` NULL reference has **no executed
   witness** anywhere in the tree. Carried from the N5 note's own "Unverified"
   paragraph and from the shape of the guard at `commands/execution.ts:185`.
   FC-02C must execute it before repairing it.
2. **F-8** — the lifetime of a captured-set premise under real concurrency is a
   source-derived concern. No native PostgreSQL lock schedule has been run,
   here or by the closure review.
3. **M-2** — the pg `batchPrimaryKeyDataflowContract` registration kept red at
   the cutover was **not measured** by this unit (Docker lane; out of scope).
   D-58 may have made it green; FC-06 owes the measurement.
4. **Native local MySQL and PostgreSQL** were not run. Every provider-shaped
   claim in the inventory is sourced to an existing receipt or marked as owed
   (L-7: FC-02A owes the native MySQL qualification of the non-RETURNING
   cascaded-identity path).
5. The D-14 probe ran on `RecordingSQLiteDriver` only. It establishes the
   statement count of each write verb **on a RETURNING driver**; it does not
   establish which writes stay single-statement without RETURNING.
6. §K's mapping of the 72 inherited sentences to inventory rows was made by
   reading the census's sentence list and the owning source line, not by
   executing each one. Their class-3/class-4 dispositions are inherited from
   the existing rulings and the map, not newly measured.
7. The class-1 rows name a **discriminating** witness file, not an exhaustive
   list of cells. A reviewer refuting a class-1 row should read the named file,
   not assume it is the only coverage.

## Blockers

**None.** Four public-contract or new-feature questions are recorded as
**pending Arnaud** (`remaining-decisions.md` R-1, R-2, R-3, R-5) and one as
**conditional on FC-03's witness** (R-4). Per the handoff, independent work
continues around R-1 rather than choosing it; none of these stops another unit.

## Repair round (2026-09-21)

Five review findings, all confirmed against the tree before applying; all five
applied, none declined. No engine, test or registration change; the deliverable
set and every class assignment are unchanged.

| # | severity | what was wrong | repair |
| --- | --- | --- | --- |
| 1 | major | §K presented itself as a partition of the 72 registered sentences but its seventeen group sizes summed to **77**. Seven groups were miscounted against the census's own registered list | sizes corrected to leaf-domain `InvalidScalarResult` **31**, polymorphic missing record / unknown target **2**, admission legality **4**, GeoPoint tier / within-polygon **2**, vector **4**, cursor pagination limits **3**, `_distance` naming and cardinality **2**; the other ten unchanged; total stays **72**; I-12's aside changed from "~30 registered" to "31", and its action cell's "not 30 capabilities" with it — same number, same row, or the row would contradict itself. No row's class changed |
| 2 | minor | the ledger record and note W-2 said the stale "the D-16 families Arnaud has not ruled on" clause sits in *the perf record*; it does not — it is at `g4.md:2258`, inside the **Release verdict — after commit 31 (2026-09-20, evening)** record | `g4.md:2303` and `note.md:21` now name that record. The addendum again sits beside the paragraph it corrects, which is the one thing the rule makes checkable |
| 3 | minor | §N row #23 and the capability-change list asserted a capability "already executing at this HEAD" with no witness, unlike rows #25 → B-6, #31 → D-3, #32 → C-13 | both now cite `tests/raptor3/g4/parity/batch-observed-publication.test.ts`, cells "a bigint key and a decimal key publish through the same observation" and "the observation is taken BEHIND the write" |
| 4 | minor | I-10 cited `operation-context.ts:3018` — a line inside the non-RETURNING update read-back, not this refusal | replaced with `:3174`, `:3257`, the two throw sites of `Concurrent membership change on …` (the census receipt records `:3177`, the sentence's own line) |
| 5 | minor | I-19 cited `operation-context.ts:842`, a line inside the capability gate's doc comment | replaced with `:866`, the `throw new TransactionError(` line the census receipt itself records for both upsert sentences |

**The arithmetic, re-derived.** The census at this HEAD registers 72 distinct
sentences whose classes tally 31 `InvalidScalarResult` + 27 `QueryEngineError`
+ 6 `TransactionError` + 4 `FeatureNotSupportedError` + 2 `NestedWriteError` +
2 `CacheConfigurationError`. The seven corrected groups follow from reading
that list row by row: a sentence at two sites is ONE sentence (`query.ts:4459`
/`:4466`; `:2614`/`:2742`; `:3650`/`:3664`), the GeoPoint distance-tier and the
"empty filter" sentences are public rather than registered, and the JSON-path
sentence belongs to J-12, not to admission. §K now sums to exactly 72 and is
the partition it presents itself as.

| file | check | result |
| --- | --- | --- |
| `inventory.md` | §K group sizes summed (`awk`/`grep -o '([0-9]+)'`) | **72**, against the table's own `**total** \| **72**` |
| `inventory.md`, `note.md`, `g4.md` | `markdownlint` not in this repo; Biome does not lint `.md` | n/a — docs only |
| — | `node scripts/run-typecheck.mjs` (once, at the end) | **0 errors**, exit 0 (`receipts/typecheck-repair-round.log`) |

No vitest run: no test file, no source file and no registration changed this
round. `batch-observed-publication.test.ts` is cited, not modified, and its
three named cells were read in the tree at `29a7bf9d8` to confirm they exist
and say what the citation claims.

## Commit message draft

```
docs(raptor3): FC-00 — the frozen behavioral closure inventory, 102 facts with an owner each

One row per admitted BEHAVIOR, not per test cell and not per error sentence:
the finite local surface FC-01..FC-06 implement against, source-linked to the
public entry points (the closed 16-verb `Operations` union, `QueryEngine`,
`PendingOperation`), the validation surface, the failure owners and the
registered manifest. 49 supported, 5 avoidable refusals or incorrect failures,
24 necessary integrity/concurrency/provider-result failures, 17 accepted
capability limits (D-55, D-56, D-59 carried as binding), 4 decisions, 3
deferred hosted claims. The 72 inherited sentences are classified on behavior
too — inherited text is not an exemption — and none of them is class 2.

The five class-2 rows are the closure review's three executed failures and the
two source-reviewed residuals, each with its red cell, its nearest green
neighbour and its owning unit: E-1 dependent placement under `updateMany`
(FC-01), E-2 the cascaded current identity without RETURNING (FC-02A), E-3 a
legal scalar named `NOT` under captured-set exclusion (FC-03), F-4 the T3
noncanonical TEXT `dateTime` key pinned green-over-red (FC-02B), F-6 the found
`connectOrCreate` NULL reference with no executed witness anywhere (FC-02C).
None is repaired here.

D-16 reconciled by current family status: NO family is awaiting Arnaud. The
2026-09-17 ruling covers all twenty-one, both requested analyses were produced
and answered inside the parity plan, and D-17..D-32 are closed; the later
"families not yet ruled" clauses are stale status paragraphs, superseded by a
dated record beside them. Only two items still trace to that surface and both
are already owned: family 5's sentence still reaching a shape it must not
(that is E-1, FC-01's defect), and the kept-red pg registration whose status at
this HEAD is unmeasured (FC-06's one frozen qualification).

The D-14 build contract is stated as pending and NOT chosen. One probe through
the public client, created and deleted inside the unit, measured the exact
contradiction: `create`, `update`, `delete` and a non-relation `deleteMany`
each answer `buildStatement() === undefined` while executing exactly one
statement, and `prepareSingle` already prepares them synchronously (D-20), so
the old "writes need asynchronous preparation" rationale no longer resolves it.
Both options are costed in code, tests and docs.

`refusals-map.md` gains an addendum, not a rewrite: six of its 55 rows name
sentences absent from the tree at 29a7bf9d8, so four capabilities it records as
refused already execute (selected bulk mutations on batch-only transports, `set`
on a non-junction variant collection, the array form, a non-int computed value
across a batch boundary).

No engine, test or registration change. Census unchanged at 23 public / 21
invariant / 11 internal / 72 registered / 192 sites; `src/query-engine/**`
unchanged at 16,036 token lines; one vitest run of 5 cells, no wide runs.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
```
