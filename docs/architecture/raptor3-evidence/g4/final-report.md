# G4 final report — Raptor 3 complete envelope, qualification, performance passes and cutover (2026-09-16, 20:45)

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

**Shipping.** Commit 3 carries pass 2 and the attempt-6 package. The C-01
cutover then runs as its own unit (brief `g4/briefs/cutover-execution.md`):
the measured diff applied to the main tree, the six two-sided harness modes
retired, the whole surviving estate re-run, an independent review, commit 4.
Nothing is pushed by this program; the push, the release note for the
`expressions.integerDivide` adapter member and the later retirement of
`pattern/` are Arnaud's.

## Validation

| Lane | Result (attempt 6, freeze-6 identity; attempt 5 identical in shape) |
| --- | --- |
| Fixed modes (main tree, serial) | 65 / 65 green (`g4-unit02-author` 21 files / 136 cells) |
| Native PostgreSQL 16 (127.0.0.1:55729) | 12 / 12 modes, 64 tests |
| Native MySQL 8.4 (127.0.0.1:55730) | 11 / 11 modes, 69 tests (RF-12 recovery 13/13) |
| Campaigns (six lanes) | 15 families, 265,000 cells, 795,000 exact replays, 0 skips; G4 read and write families 250 children each on seeds 20000–124999 |
| Replays | 7 corpora green, 2 G4 read children reproduced by their child command (byte-identical to the retained archives), 9 G3-era inputs refused as stale |
| Structural measurement | 28 cases / 60 replays, instrumentation reversed, identity restored |
| Support | receipts self-test, driver integration, credential-free selectors, typecheck = the two Pattern diagnostics only; source-cost measured in an identity-equal lane; the CLI self-test re-run alone after the campaigns (its watchdog cell is load-sensitive) |
| Retention | 1,320 child corpora restored and hashed (54.0 GB restored from 1.05 GB of archives), lane copies released |
| Size (candidate-only package) | engine bundle gzip 0.2377 (≤ 0.75), public PostgreSQL fixtures 0.6984 / 0.6986 (≤ 1.00); engine bundle byte-identical to identity 2 |
| Census | root review D: complete charged candidate 14,680 token-lines = 27.3 % of the shipped 53,787; the pass added +22 then +0 charged token-lines; first-party source-cost measurement in the package |
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
