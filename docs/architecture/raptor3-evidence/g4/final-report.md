# G4 final report — Raptor 3 complete envelope, qualification, performance passes and cutover (2026-09-17, 15:30)

## Outcome

G4 is implemented, reviewed, committed and qualified three times on frozen
identities: the envelope (`0f25637b`, attempt 3), performance pass 1
(`ff5e77ca`, attempt 5) and performance pass 2 (commit 3, attempt 6 on
production `312cde34…`, harness `1d4d913c…`). Every unit has an independent
ACCEPT; the root integrated review is closed. Arnaud's decisions R-D1..R-D4,
D-5, D-6, D-7, D-7.1, D-8, R-D3-class, **D-9** (the remaining preparation
cost is accepted; no further optimisation) and **D-10** (the C-01 cutover is
performed locally as the commit after attempt 6) are applied and pinned.

**Performance, final.** Pass 1 removed eager `Error` construction from the
success path; pass 2 stopped allocating write machinery on pure reads (rule
7), memoised the schema facts a read re-derived (rule 1) and unfroze
prepared operands, within the twelve rules and with a falsifier per item;
cross-operation reuse was measured to have nothing left to amortise and was
not taken. On the frozen 20-cell series (stage 2d, two passes, quiet
machine): preparation 1.19–1.40× CPU on the three cells that were 1.40–2.15×
at the start, `fixed-collection-rowref-20/prepare` under parity, execution at
parity, every nested and conditional write 25–35 % cheaper in CPU and 12–33 %
in wall, peak memory better on every measurable cell. Plan §7's 5 % budget
is still not met on those three cells and four relation-read cells sit 2–7 %
above parity; under D-9 that is accepted for adoption rather than repaired.

> **Release tree, re-measured (2026-09-20, commit 31, `g4/release/perf/note.md`).**
> The same frozen 20-cell protocol against the last shipped-old-engine tree
> (`5a37bcd7`), two passes. The writes win (the two conditional writes 0.80
> CPU, `flat-scalar-update` end to end 0.691), reads hold. At the bracket D-9
> measured, the three preparation cells read **1.215 / 1.315 / 1.325** against
> the 1.12 the decision names — inside stage 2d's own ranges, so nothing has
> regressed since D-9 and the acceptance was never met at its number. Newly
> over budget: `fixed-collection-rowref-1000/parse`, the D-28 decode cell
> (CPU 1.08 / 1.09, wall 1.12 / 1.14, both passes; at parity at identity 4);
> `bulk-update-returning-100/full` moved 0.838 → 0.963, still under parity,
> cause not bisected. D-58 adds no statement on any of the 20 cells. These
> three are decisions for Arnaud (open items 7–9 below), not repairs.

**Size.** ~~The public PostgreSQL client fixtures are 0.700 of the frozen
baseline (target ≤ 1.00); the engine-only fixture (0.238) no longer contains
the candidate after the cutover and is a follow-up to re-point.~~ *Corrected
2026-09-20 (commit 31, `g4/release/perf/bundle-ratios-release.json`): on the
release tree the public PostgreSQL client fixtures are **0.735** of the frozen
baseline (+5.0 % gzip since identity 4, through D-53, M1 and D-58; target
≤ 1.00 met), the engine-only fixture is **0.646** (≤ 0.75) with all 16 raptor3
files in it — the 0.238 measured a fixture holding one module, and the
re-point follow-up is closed as a measured no-op — and `src/query-engine/**`
is 16,036 token lines = **0.348** of the old engine's 46,021 (≤ 0.60).* The cutover
deletes 33 legacy owners (28,740 lines) and 197 legacy or two-sided tests
(86,498 lines); the candidate is 15 files and about 11,700 lines.

**Shipping, done locally.** Commit 3 (`5a37bcd7`) carries pass 2 and the
attempt-6 package. Commit 4 (`e8114ed9`, D-10) is the C-01 cutover: the
candidate is the only engine behind the unchanged public API, 33 legacy
owners and 213 legacy or two-sided test files are gone, `buildStatement()`
and `QueryEngine.build()` answer the one statement an operation compiles to
(D-14), a `QueryEngine` built without a client provisions its own route,
and the differential lanes are kept one-sided at their full counts. Commit
5 (`356254a2`, D-15, reviewed and re-checked) retires
the `pattern/` experiment and the V1 estate it kept alive: 111 production
files / 41,272 lines, the whole `builders/` layer, the V1 parser tree, all
of `write-engine/` but the typed parse boundary; `src/query-engine/**` at 14,511 token-LOC against the old engine's 46,021 =
**0.315 of the frozen baseline** (plan §7 target ≤ 0.60, met; with the
same 15 client and adapter integration files the baseline also charged,
18,344 against 49,887 = 0.368). The census tool's own headline of 0.235
is not this number: it still classifies `raptor3/` as the excluded
experiment (F-1) and charges eleven shared files the baseline never did,
so it measured the owners around the engine, not the engine — corrected
here; before the retirement the honest number was 0.877, the whole-estate typecheck at
**zero** diagnostics, bundles byte-identical, the core lane at the base's
red set. Nothing is pushed; the push, the release note for the two public
contract changes (`expressions.integerDivide`, the `buildStatement`/`build`
answer) and the D-16 decisions are Arnaud's.

**Parity program (2026-09-17, after the cutover).** The 115 D-16 differences
were repaired at their owners in two reviewed lanes plus an integration
unit ([raptor3-parity-plan.md](../raptor3-parity-plan.md), `g4/parity/**`):
admission refuses empty filter objects and owns the JSON path grammar,
`groupBy.by` and the default-only `skipDuplicates` rule; a mutation's
relation-filter correlation names the mutated table; the update language
is interpreted once; a decimal keeps its spelling inside a JSON window and
the decoder reaches the adapter/driver result chain; nested set mutations
are one statement again; the one-recovery allowance is a committed-progress
fact spent by the owner that opened the region; a suppressed INSERT
suppresses the row, not the membership; polymorphic integrity is probed on
the junction; the route keeps the driver's prepared-statement provenance,
publishes commit certainty and hands a one-statement write's package to
the array owner. Measured on the merged tree (`g4/parity/verification/final2/`,
2026-09-17 16:07–16:15): typecheck **zero** diagnostics; the local provider
lanes **0 red**; the core lane **2 red** (the pre-existing inventory cell
and the cache-SWR cell under D-28); the Docker lanes against the pristine
parent commit: pg **26 red, 0 regressions** (parent 57), mysql **165 red,
0 regressions** (parent 218; the diff flags one `ER_LOCK_DEADLOCK`
concurrency cell that the repair round measured 3/3 red on the parent and
the reviewer reproduced); the raptor3 fixed group **59 green, 0 red**
(it was 52/59 after the merge; the repair round fixed three causes). The
remaining Docker reds are the five kept-red registration cells, the D-29
staleness window, a PostGIS-less container, the MySQL migration
fingerprint mismatch, lock deadlocks and four namespace-containment cells,
all red on the parent. Size: the parity work adds 2,083 lines and removes
259 in production (guide +323) and adds 2,444 test lines; `src/query-engine/**`
is **15,359 token-LOC = 0.334 of the old engine's 46,021** (raptor3 alone
10,552 → 11,399; with the same client and adapter integration files the
baseline charged, 19,192 against 49,887 = 0.385; target ≤ 0.60 met). The audit of the whole diff (`final2/audit.log`) found
no TODO, no legacy branch re-created and one owner per transport-mode
distinction. Rulings left to Arnaud: D-27, D-28, D-29, D-31, D-32
(recorded in `g4.md`). The campaign qualification was not re-run for this
commit, on Arnaud's instruction.

**Rulings unit (2026-09-17 evening, commit 8).** Arnaud's rulings after commit 6
were applied under the same discipline (`g4/rulings/**`: brief, note, two
parallel independent reviews, a forced repair round, a re-check; D-33 authored
and reviewed in parallel in its own worktree). D-28: the driver-level
`parseResult` middleware has its consumer again at the one place a terminal
window becomes a decoded result, asked once per operation on every route,
with the chunked terminal's per-window row contract kept by one owner. D-29:
a premise queued during planning rides the atomic unit it protects, and (D-36)
an attempt rejected at a premise provably wrote nothing, so the pg
captured-membership race converges. D-32: loss after observation of a
captured membership re-plans once, with witnesses; the identity premises stay
non-raceable (D-34). D-33: a `json().schema(…)` field's user schema runs at
the one decode boundary on every provider, as the old engine did, through
the estate's one invocation owner; D-37 handles the promise a refused async
schema discards. Measured on the merged tree: typecheck **zero**; local
provider lanes **0 red**; core lane **1 red (the pre-existing inventory cell)**; Docker pg **25 red, 0 regressions, 1 newly green** and
mysql **165 red, 0 regressions** against commit 7's red sets; raptor3 fixed group
**59 green, 0 red** (the regression the first run exposed on the chunked terminal
read was bisected and repaired inside the unit). Size: production
+296/−42, tests +1,339/−66. D-35 (commit 9): the inert count/exists arm of the SQLite
drivers' middleware is deleted, with its release note in `CHANGELOG.md`;
the decoder is the one owner of a count and an exists answer, and those
answers are unchanged on every SQLite driver (production code lines net −10).

**Rulings after commit 8 (commits 9 to 11, 2026-09-17/18).** D-35 (commit 9,
`82195151`) deleted the SQLite drivers' inert count/exists middleware arm
with its release note. Commit 10 (`383f830c`) recorded D-38 to D-41 and
amended the note. Commit 11 (`0e9b8a06`) applied D-39 (a driver's result
surface is stock only when it is the shipped parser object, for the SQLite
and PGlite families), D-40 (the MySQL and PostgreSQL adapters' result legs
measured live across sixty asks, found inert, deleted whole; the adapter
member kept as a public extension point under D-42 with one shared
pass-through under D-43) and D-41 (the short-window pin). Each unit had its
independent review and repair round; on the merged tree typecheck zero, the
fixed group 59 green, Docker pg and mysql with no regressions. Production
code moved net negative across the three commits.

**Release lanes (2026-09-18/19, commits 12 to 15).** The three lane
workflows died on the account's Opus weekly limit with their work half done;
under D-45 the integrator finished each lane's authoring from the partial
work and a Sonnet reviewer at maximum effort provided the independent review
(every lane: REVISE with minimal resolutions or ACCEPT, then a re-check).
Commit 12 (`aa17242c`) makes what CI runs green: the raptor3 test tree
inventoried from the manifest's one provider-backed list, the provider-
isolation registration, validity and resolution stated once in the
validator, and the coverage lane (validation, errors and adapters at 100 %,
drivers over its floors, three unreachable guards deleted). Commit 13
(`88fb0001`) is the Docker triage: two engine defects repaired (an enum
compared against a column on PostgreSQL; a JSON null document in a NOT NULL
column where the driver parses JSON), pg green on a PostGIS server except
the five registered kept-red cells, MySQL blocked by one pre-existing
migrations-layer cause on MySQL 8.4 (150 of 165 cells). Commit 14
(`710e882f`) is D-46: an upsert on the array route of a batch-only
transport, the shipped engine's two paths restated at one owner with one
sanctioned planning read. Commit 15 (`29622ac5`) is the retirement follow-
ups F-1 to F-6: the census counts the engine (like for like `src/query-
engine/**` 15,605 token lines = 0.339 of the old engine), the last
boundaries under `raptor3/`, the engine's own deterministic test tree
measures the query-engine coverage scope (floors 87 / 91 / 90 / 87,
measured, never lowered to fit), fourteen unreachable files deleted, the
retired designs moved. What `ci.yml` runs on the final head: biome, the docs
validation, whitespace, test:types (0), test:core (8,432 / 8,432),
test:coverage (every scope, the policy gate green), test:package (9 / 9),
package:lint and size, all green on `29622ac5`; the credential-free gate's
raptor3 stage, red on that head at one G3-era self-test, green after commit
16 (the cs03 unit); the full `pnpm test:all` on the final head is recorded
in the performance evidence commit. Commit 17 (`b7b0f723`) is D-49: the
decimal-language census, red since the engine's first commit, green through
the engine's decimal seam. Commit 18 is D-50: the exact identity scratch on
PostgreSQL batch-only transports (the INSERT's own RETURNING stored by a
data-modifying CTE), which closes the refusal the gate triage found behind
28 cells, the five kept-red Docker pg cells of commit 4, and three masked
defects. **The full gate, run end to end for the first time on this branch,
is not green:** the retired engine's PGlite contract suites (41 files, 184
cells) were never measured by the parity program; their triage
(`g4/release/gate/`) classifies 26 physical-plan pins, 16 ruled refusals, 28
cells closed by D-50, 11 retired premises and 92 shipped-engine defects in
six mechanisms, each a unit or a ruling still to come. Open for Arnaud: D-47
(widen the upsert fold to the live route), D-48 (a SQL NULL in a NOT NULL
json column), the MySQL migrations cause, D-44 (live PGlite file runs). The
performance and size re-measure follows as its own evidence commit.

## Validation

| Lane | Result (attempt 6, freeze-6 identity; attempt 5 identical in shape) |
| --- | --- |
| Fixed modes (main tree, serial) | 65 / 65 green (`g4-unit02-author` 21 files / 136 cells) |
| Native PostgreSQL 16 (127.0.0.1:55729) | 12 / 12 modes, 64 tests |
| Native MySQL 8.4 (127.0.0.1:55730) | 11 / 11 modes, 69 tests (RF-12 recovery 13/13) |
| Campaigns (six lanes) | 15 families, 265,000 cells, 795,000 exact replays, 0 skips; G4 read and write families 250 children each on seeds 20000–124999 |
| Replays | 7 corpora green, 2 G4 read children reproduced by their child command (byte-identical to the retained archives), 9 G3-era inputs refused as stale |
| Structural measurement | 28 cases / 60 replays, instrumentation reversed, identity restored |
| Support | receipts self-test, driver integration, credential-free selectors; typecheck = the two Pattern diagnostics at attempts 5–6, ZERO after the pattern retirement; source-cost measured in an identity-equal lane; the CLI self-test re-run alone after the campaigns (its watchdog cell is load-sensitive) |
| Retention | 1,320 child corpora restored and hashed (54.0 GB restored from 1.05 GB of archives), lane copies released |
| Size (candidate-only package) | engine bundle gzip 0.2377 (≤ 0.75), public PostgreSQL fixtures 0.6984 / 0.6986 (≤ 1.00); engine bundle byte-identical to identity 2 |
| Census | root review D: complete charged candidate 14,680 token-lines = 27.3 % of the shipped 53,787; after the cutover 31,664 charged token-LOC (0.635 of the frozen baseline), after the pattern retirement 11,732 (0.235) |
| Post-cutover estate | 59 fixed modes, 12 PostgreSQL, 11 MySQL, support, coverage policy, taxonomy census green; `pnpm test:core` 6 files / 11 tests red (base 5 / 42) — the D-16 cells; provider lanes red on D-16 cells only (61 local, 13 + 13 Docker) |
| Performance (plan §7, stage 2d) | 5 pass, 3 block (preparation 1.19–1.40×), 9 inconclusive after the repeat (5 precision-limited, 4 relation-read cells 2–7 % above parity), 2 not measurable, 1 contract divergence; accepted under D-9 |
| Performance and size (release tree, commit 31, 2026-09-20) | 6 pass, 5 block (three preparation cells 1.215 / 1.315 / 1.325 at D-9's bracket, `fixed-collection-rowref-20/prepare` 1.16–1.21 at the statement seam, the D-28 decode cell 1.08–1.09 CPU), 5 inconclusive after the repeat (two passed on it, carried by the worse-of-two rule), 3 not measurable comparably, 1 contract divergence; engine bundle 0.646, public fixtures 0.735, engine source 0.348 — all size targets met; decisions pending |

Six qualification attempts were needed; each earlier attempt is kept whole
(`g4/qualified-attempt-{1,2,4}-stale-identity/`; attempt 3 is the package in
`0f25637b`). Attempt 1 found a G4 regression (`recordSeriesProgress` on a
non-series failure, then the `statementIndex` family that became D-7);
attempt 2 found one harness specimen still pinning the pre-D-7 transport;
attempt 3 qualified the committed tree; attempt 4 aborted at launch (lanes
mis-synced after the commit, Docker stopped — tooling only); attempt 5
qualified performance pass 1; attempt 6 qualified pass 2. The session-limit interruption (13:40–15:00)
and the owner's desktop load (swap, load average 143) cost time only; both
are recorded in the ledger.

## Risks and open items

**Closure checkpoint addendum (FC-06, 2026-09-21).** The items below are kept
exactly as they were written; each one that the closure wave settled carries a
dated superseding line, and the items the wave opened or left open are added at
the end (10–16). Nothing recorded as red has been rewritten into a pass. The
closure units' own notes are under
[`g4/release/closure/`](release/closure/), and the release verdict this
checkpoint feeds is drafted in
[`g4/release/closure/fc06/release-verdict-draft.md`](release/closure/fc06/release-verdict-draft.md).


0. **D-16 — 115 behaviour differences of the new engine surfaced by the
   cutover's own verification, none caused by the cutover (first item for
   Arnaud).** The most serious first: an EMPTY operator bag in a bulk
   `where` (`updateMany`/`deleteMany({ where: { name: {} } })`) used to fail
   closed and now matches every row — every row updated, then deleted — and
   six non-portable JSON path spellings, empty scalar/relation filters and a
   `having` field outside `by` are no longer refused on reads (27 lost or
   changed refusals in all, plus 13 fail-closed result contracts no longer
   enforced, some now leaking a raw `TypeError`). The C-01 unit ran the lanes the qualification estate never
   registered — the credential-free sqlite3/libsql provider suites and the
   two Docker provider suites — and found 78 red cells there plus 8 on the
   public-client core lane and 2 changed refusal wordings; every one
   reproduces on the pre-cutover tree with the candidate route, so they are
   pre-existing differences between the candidate and the engine it
   replaces, not cutover defects. Families a user would notice first:
   relation-filtered `updateMany`/`deleteMany` touching the wrong row set
   (18 cells), a nested object value parsed as an update-operator bag (9:
   delegated JSON writes, GeoPoint round-trips), JSON path filters (8),
   polymorphic collection reads and writes (9), decimal exactness and scalar
   decoding (7), nested-write dependency refusals raised where the old engine
   executed (5), read-path regressions (`groupBy` `by.map` crash, empty
   default projections, `_count: true`; 4), live upsert concurrency (4),
   an empty `createMany` refusal gone, an `upsert` pre-dispatch error class,
   three array-interceptor orderings, two write-outcome certainties. They
   are neither repaired nor deleted (D-12); they stay red on the branch and
   are listed cell by cell in `g4/cutover-execution/note.md` R3.2 and R4.2
   and in commit 4's message. Decision: repair unit before pushing, accept
   and re-pin, or hold the cutover. Six qualification attempts did not see
   them because those suites were outside the registered modes — a gap in
   the qualification plan, recorded as such.
   **Reconciled FC-00 (2026-09-21): no D-16 family is awaiting Arnaud.** He
   ruled all twenty-one families "repaired now, before any push" on the
   morning of 2026-09-17; the 115 cells landed across D-17..D-32 and are not
   reopened. The later "families Arnaud has not ruled on" clauses were stale
   status paragraphs. Two items still trace to that surface and both are
   owned: family 5's sentence still reaching an admitted shape under root
   `updateMany` was the closure review's first executed failure, repaired by
   FC-01; the pg `batchPrimaryKeyDataflowContract` registration kept red at
   the cutover is item 10 below.

1. **Accepted performance difference (D-9).** Preparation 1.19–1.40× CPU
   on three cells and four relation-read cells 2–7 % above parity, with
   execution at parity and memory better everywhere. The named remainder is
   allocation shape and the candidate's own layering; the prepared-shape
   cache is closed as an option for now.
2. **Measurement.** The stage-2d series is the quiet-machine run; five cells
   stay precision-limited on this hardware and would need a dedicated box to
   label. Absolute medians are not comparable across identities, ratios are.
3. **`relation-series-2` (D-8) still diverges at the final-state gate.** The
   per-engine ledger made the cell runnable on both sides; the cross-engine
   comparison then refuses because the adjudicated evaluation-count
   difference lands on the workload's counter default (persisted ids
   differ, rows and associations do not). Making the benchmark's generated
   ids engine-neutral is a `benchmarks/**` change (a protocol path, new
   measurement identity) for Arnaud to decide.
4. **Prepared-statement alias spelling.** The per-client alias drift is fixed
   and pinned; the candidate still spells the root alias `q0` where the
   shipped engine spells `t0`. A spelling, not a cache defeat.
5. **Cutover obligations (C-01, proposal):** seven registered modes are
   pre-cutover instruments to retire; the retained `pattern/` experiment
   keeps 17 write-engine files plus `result/`, `context/`, `operations/`
   alive; `expressions.integerDivide` is a required adapter member (a
   compile-time change for third-party adapters); `route` is effectively
   required through one localised assertion.
7. **Preparation cost against D-9's number (release tree).** At the bracket
   D-9 measured, the three cells read 1.215 / 1.315 / 1.325 against the 1.12
   the decision states; nothing regressed since D-9, the acceptance was never
   met at its number. Decision: restate D-9 at the measured numbers, fund a
   preparation-cost unit before the push, or hold. **Ruled D-60 (2026-09-20):
   restated at 1.22 / 1.32 / 1.33; closed as documented cost.**
8. **The D-28 decode cell.** `fixed-collection-rowref-1000/parse` is newly
   8–9 % over on CPU and 12–14 % on wall on both passes (parity at identity
   4), the same single statement on both sides — the clearest
   ruling-attributable movement in the series. Decision: profile and repair
   before the push, or accept as a documented cost. **Ruled D-61
   (2026-09-20): profile and repair before the push, unit P1.**
   **Closed by P1 (2026-09-20, evening):** one line — the decoder rebuilt the
   projection's member list per row — repaired at `prepareProjection`'s frozen
   shape; the cell reads 1.073 → 0.655 / 0.649 CPU and allocation per row
   1,702 → 847 B on P1's own calibration cells. **Corrected by FC-05
   (2026-09-21):** what P1 removed is the PAIR list and the per-row object
   rebuild; `Object.keys(shape.fields)` still allocates one key array per
   decoded document, and removing that one too is an unmeasured candidate, not
   a rule. **Still owed (the integrator's):** P1's own note says its after-cells
   were produced by driving the protocol's worker in calibration mode on a
   dirty tree, so the committed-tree comparator run for that cell and its
   full-read consumer has not happened.
9. **`bulk-update-returning-100/full` 0.838 → 0.963** between identity 4 and
   the release tree, same bracket, same statement count, still under parity;
   the cause is in the eight commits between and was not bisected.
   Decision: bisect (measurement only), or accept. **Ruled D-62 (2026-09-20):
   accepted, under parity; recorded, not bisected.**
6. **Environment:** the live-provider harness leaks one database or schema
   per world (E-1; the qualification driver drops stale worlds before native
   groups); the source-cost tool cannot run in a tree whose `git status`
   exceeds 1 MiB (a `maxBuffer` fix in `scripts/`, deferred so the harness
   identity stays frozen; measured in an identity-equal lane instead); the
   CLI watchdog self-test is load-sensitive.
7. **Unverified by construction:** the G4 read campaigns are candidate-only
   (subject `candidate`; the oracle is independent JavaScript, not the
   shipped engine); most retained corpora are proven to restore, not
   re-executed; the credential-free selectors are log-only; the stage-2c
   series is SQLite-only and did not re-run the adapter's falsifiers for the
   new protocol identity. **Attested at the closure gate (2026-09-21, `g4/release/closure/attest/`): on the committed tree `a9e62d8dc`, through the protocol's own comparator, `parse` 0.669 / 0.669 CPU and `full` 0.875 / 0.862, `measurementProtocolValid: true`.**

### Added by the closure wave (FC-00 … FC-06, 2026-09-21)

Everything the wave CLOSED is recorded at its own item above or in the ledger's
`**FC-…` records; these are what is still open at this checkpoint.

10. **The pg `batchPrimaryKeyDataflowContract` registration, kept red at the
    cutover, is still unmeasured** (`tests/providers/docker/pg-nested-write-races.test.ts:115`).
    D-58 and the closure repairs may have made it green; no unit measured it,
    because the gated PostgreSQL container lane belongs to the integrator's one
    frozen gate. Measure it there: if it passes, the "kept red" record is
    retired with a dated line and no decision is needed; if it fails, it is a
    defect with an owner, not a ruling.
11. **D-65 — the captured set's membership premise on the batch route —
    is PENDING** (ledger, 2026-09-21). FCPG measured ten cells on native
    PostgreSQL 16: the interactive route HOLDS the premise to the effect
    (`FOR UPDATE`), and the batch route leaves one window on both consumers in
    which a row that stopped matching is still mutated and a member that joined
    is missed, silently, with the row count right. Recorded with the
    integrator's recommended default (B for consumer 1 — the ID-located
    mutation carries its own selector, a public-contract change on the batch
    route; A, documented, for consumer 2 — no single statement can see a member
    that joined after the complement). Not implemented: a public-contract
    change is Arnaud's. `requireCapturedSet`'s "STILL PRESENT and STILL A
    MEMBER" comment is left as it stands, because correcting it would pick
    reading A.
12. **FC-02C's two measured residuals**, both compatibility questions owed a
    bounded decision, both with receipts and neither pinned: a
    `connectOrCreate`'s CREATE arm whose own payload spells the referenced
    field NULL still writes it (the rule that refuses the identical plain
    nested `create` never sees a choice's arm), and the CHILD-held direction
    (`badge.update` with `holders: { connect }` from a parent holding NULL)
    writes NULL too. The third residual — a nested `update` that nulls the
    referenced column under a live member — keeps its provider
    `ForeignKeyError` deliberately.
13. **D-64's own pin executes in no vitest project.** The ruling that settles
    the public build contract cites
    `tests/raptor3/g4/review/cutover/d14-publication.review.test.ts`, which
    FC-04 measured to be in no `*_TESTS` group and excluded from
    `extended-local` by the `tests/raptor3/g4/review/` prefix rule, as is the
    whole `g4/review/cutover/` and `g4/review/unit02/` tree. The contract is
    stated in code, the CHANGELOG and the drivers/engine guides; what is
    missing is a registered cell that fails if a future change restores a
    write's `buildStatement()`. Either register that file in a mode or state
    the contract in a registered suite.
14. **Hosted qualification stays deferred, and local is not hosted.** The live
    Neon suite is credential-gated on `NEON_TEST_DATABASE_URL` and was not run
    for this release. D1 has local Workers-pool coverage
    (`tests/providers/workers/d1.test.ts`, project `provider-d1`, run by
    `pnpm test:all` and by CI) and no hosted Cloudflare D1 run; its
    ordered-committed-segments declaration is therefore still unwitnessed on
    the hosted transport. Test source is not a receipt, and a local emulation
    is not the hosted provider.
15. **Two named limits the closure wave kept without an executed witness.**
    FC-01's surviving placement limit covers the pairs an expansion makes
    against the tree around the series and was instrumented to zero hits (a
    `false` reader leaves every control green); FC-02A's widened
    current-values parameter has no public witness for a NON-key arithmetic
    input, because arithmetic on a relation key field is refused at admission,
    so every arithmetic input reachable today is a key. Both are argued, not
    measured, and both are recorded at their units.
16. **The retired CS-02 reference instrumentation is kept, and now fails
    loudly.** `tests/raptor3/core-structure/measurement/reference-instrumentation.patch`
    is the flat-history-reference alternative superseded at `b0ec55fa3`; 20 of
    its 29 hunks no longer apply at `a9e62d8dc`. It is retained as history, and
    a structural-measurement run that names it is refused before it measures
    anything (`assertStructuralMeasurementPatch`, FC-06). The live
    instrumentation for that measure remains
    `docs/architecture/raptor3-evidence/g4/qualified/structure/instrumentation.patch`. **Measured at the closure gate (2026-09-21, `833318c5a`): `pg-nested-write-races.test.ts` 95 / 95 on native PostgreSQL 16 — the registration is GREEN; the D-58 and closure repairs closed it.**

### Added by the final local closure (R1 … R4, 2026-09-21)

17. **The three residual NULL-reference shapes are refused, not written.** R1
    states the one requirement at the record that stores the tuple; the
    narrower found-choice loop is deleted; native PostgreSQL and MySQL
    witnesses prove operation-owned rollback, borrowed ownership and truthful
    segmented progress. Items 12's two residuals are closed.
18. **D-65 is adopted and implemented (R3), no longer pending.** Root captured
    mutations carry identity set and prepared selector in the effect; nested
    captured series are a bounded worklist. Item 11 is closed; the batch-route
    window it described is now the documented bound, not a silent mutation.
19. **Native MySQL is part of local qualification (D-66, D-67; R2).** The
    schema-attestation owner, the exposed behaviour and the deadlock policy are
    repaired at their owners; the lane is green at the frozen gate (735 / 1
    skipped / 0 red). "The same failures existed before" no longer describes it.
20. **D-64's witness runs in the normal gate (R4).** Item 13 is closed.
21. **The final release record** lives under `g4/release/closure-final/`
    (`index.md`, the gate's raw logs and identities, the recount, the bundle
    and performance receipts, the release verdict). Hosted Neon/D1 stays
    deferred (items 14, L-5, L-6). Three files someone modified in the working
    tree during the program — the first closure handoff, the implementation
    plan and `features-docs/recursive-query.md` — are not this checkpoint's and
    were left uncommitted.

