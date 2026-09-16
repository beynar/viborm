# G4 final report — Raptor 3 complete envelope, qualification and performance pass (2026-09-16, 16:30)

## Outcome

G4 is implemented, reviewed, committed (`0f25637b`, 2026-09-16 09:40) and
re-qualified after the performance pass on a second frozen identity
(production `2e92354b…`, harness `31c2883f…`, base `0f25637b`, freeze 5). The
sealed author package at `g4/qualified/` replaces the attempt-3 package of
`0f25637b` (9,892 files, `SHA256SUMS` verified). Every unit has an independent
ACCEPT; the root integrated review is closed (A, C with one ledger row, D).
Arnaud's decisions R-D1..R-D4, D-5, D-6, D-7, D-7.1 (accept), D-8 (one
evaluation per admitted input, both ledgers pinned in the benchmark) and
R-D3-class (`UnsupportedOperationError` V8003) are applied and pinned; no
decision is open.

**The performance pass (safe fixes only, two review rounds, ACCEPT)** removed
eager `Error` construction from the success path — lazy control-flow
sentinels, thunked plan-time nested-write refusals, one stack capture in
`VibORMError` — scoped the SQL alias counter per statement and memoised the
schema's scalar list, with no behaviour change and a falsifier per item.
Measured on the frozen identity (stage 2c, two independent 20-cell series):
the preparation regression halved (`scalar-find-unique/prepare` 2.15× →
1.45× CPU, `bulk-update-returning-100/prepare` 1.76× → 1.48×,
`fixed-collection-rowref-1000/prepare` → 1.40×), every nested and conditional
write lost its wall-above-CPU signature (now 0.87–1.02), peak memory passes on
every measurable cell (0.80–1.03), execution stays at parity, and no cell got
worse than at identity 2.

**Adoption is still blocked by the plan §7 performance gate**, not by
correctness: steady-state preparation remains 1.40–1.48× on three cells on
both series (E/B 2.9–9.2 %, so the verdict is not a noise artefact), and the
gate reads 6 pass / 4 block / 7 inconclusive / 2 not measurable / 1 required
contract divergence (identity 2: 3 / 11 / 3 / 2 / 1). The cutover proposal
(`g4/cutover-proposal.md`, §11 and the integrator addendum) recommends not
cutting over yet. The remaining preparation cost is the diagnosed remainder
of `g4/cutover/perf-diagnosis.md` (allocation shape, no reuse between
identical operations) and needs the prepared-shape cache, which Arnaud kept
as a separate decision. A second local commit (`perf(raptor3): …`) carries
the pass, the decisions and the re-sealed package; nothing is pushed, the
legacy engine is untouched, C-01 remains a proposal.

## Validation

| Lane | Result (attempt 5, freeze-5 identity) |
| --- | --- |
| Fixed modes (main tree, serial) | 65 / 65 green, 1,746 test executions (plus the g0 lane mode, 33 tests) |
| Native PostgreSQL 16 (127.0.0.1:55729) | 12 / 12 modes, 64 tests |
| Native MySQL 8.4 (127.0.0.1:55730) | 11 / 11 modes, 69 tests (RF-12 recovery 13/13) |
| Campaigns (six lanes) | 15 families, 265,000 cells, 795,000 exact replays, 0 skips; G4 read and write families 250 children each on seeds 20000–124999 |
| Replays | 7 corpora green, 2 G4 read children reproduced by their child command (byte-identical to the retained archives), 9 G3-era inputs refused as stale |
| Structural measurement | 28 cases / 60 replays, instrumentation reversed, identity restored |
| Support | receipts self-test 39, driver integration 16, credential-free selectors, typecheck = the two Pattern diagnostics only; CLI self-test and source-cost re-run on the quiet machine after two load-induced reds (see the package's `support/RERUN.md`) |
| Retention | 1,320 child corpora restored and hashed (54.0 GB restored from 1.05 GB of archives), lane copies released |
| Size (candidate-only package) | engine bundle gzip 0.2377 (≤ 0.75), public PostgreSQL fixtures 0.6984 / 0.6986 (≤ 1.00); engine bundle byte-identical to identity 2 |
| Census | root review D: complete charged candidate 14,680 token-lines = 27.3 % of the shipped 53,787; the pass added +22 then +0 charged token-lines; first-party source-cost measurement in the package |
| Performance (plan §7) | FAILS: 6 pass, 4 block (all preparation, 1.40–1.48×), 7 inconclusive after the one permitted repeat (measurement precision: E > 5 % on 13 of 17 measurable cells on this machine), 2 not measurable comparably, 1 contract divergence; two full series, the first repeat aborted on machine state and kept |

Five qualification attempts were needed; each earlier attempt is kept whole
(`g4/qualified-attempt-{1,2,4}-stale-identity/`; attempt 3 is the package in
`0f25637b`). Attempt 1 found a G4 regression (`recordSeriesProgress` on a
non-series failure, then the `statementIndex` family that became D-7);
attempt 2 found one harness specimen still pinning the pre-D-7 transport;
attempt 3 qualified the committed tree; attempt 4 aborted at launch (lanes
mis-synced after the commit, Docker stopped — tooling only); attempt 5
qualified the performance pass. The session-limit interruption (13:40–15:00)
and the owner's desktop load (swap, load average 143) cost time only; both
are recorded in the ledger.

## Risks and open items

1. **Performance gate (blocking), remainder named.** Preparation-path CPU
   1.40–1.48× on three cells on both series. Cause 1 of the diagnosis (eager
   errors) is removed; what remains is object-shape and allocation work with
   no reuse between identical operations. The prepared-shape cache is the
   named next step and a separate decision; it changes the identity and
   needs a re-run of the 20 cells.
2. **Measurement precision on this machine.** Seven cells are inconclusive
   because the protocol's own uncertainty exceeded the 5 % budget, driven
   by the owner's other applications (recorded, not controlled). A
   quiet-machine re-run of the same 20 cells (about nine minutes per pass,
   everything in place) would settle their labels; it cannot change the
   three blocking preparation cells.
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
