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

**Size.** The public PostgreSQL client fixtures are 0.700 of the frozen
baseline (target ≤ 1.00); the engine-only fixture (0.238) no longer contains
the candidate after the cutover and is a follow-up to re-point. The cutover
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
of `write-engine/` but the typed parse boundary; charged production 11,732 token-LOC outside the engine plus 10,552 inside
`raptor3/` = **22,284 token-LOC, 0.447 of the frozen baseline (49,887)**
(plan §7 target ≤ 0.60, met; the census tool still classifies `raptor3/`
as the excluded experiment, F-1, so its own headline of 0.235 leaves the
engine out — corrected here; before the retirement the honest number was
0.877), the whole-estate typecheck at
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
259 in production (guide +323) and adds 2,444 test lines; the engine
program is **23,132 token-LOC = 0.464 of the frozen baseline** (raptor3
10,552 → 11,399, the charged owners outside it unchanged at 11,733;
target ≤ 0.60 met). The audit of the whole diff (`final2/audit.log`) found
no TODO, no legacy branch re-created and one owner per transport-mode
distinction. Rulings left to Arnaud: D-27, D-28, D-29, D-31, D-32
(recorded in `g4.md`). The campaign qualification was not re-run for this
commit, on Arnaud's instruction.

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
   new protocol identity.
