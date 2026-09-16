# G4 "Independent witnesses C01/C12/C13" — independent review, follow-up after REVISE

Reviewer: the same independent reviewer who returned **REVISE** on
[`witness-review.md`](witness-review.md); did not author the unit or its repair.
Reviewed source: main tree `/Users/arnaud/code/viborm`, branch `pattern-engine`,
working tree already containing the repair (nothing applied, nothing repaired by
this review). Date 2026-09-15.

Inputs read: `g4/briefs/common.md`, `g4/briefs/review.md`,
`g4/briefs/witness-c01-c12-c13.md`, my own `witness-review.md`, the author's
repair summary, `g4/witness/note.md` (§§1–12 plus the new §13),
`g4/witness/handoff.md` (revision 3), `g4/witness/production.patch`, every
receipt under `g4/witness/repair/` and `g4/witness/receipts/`, and the current
source of `tests/raptor3/g4/**` (route-* and the review subtree excluded),
`scripts/run-raptor3.mjs`, `scripts/raptor3-manifest.mjs`,
`scripts/raptor3-campaign-receipts.test.mjs`, `scripts/raptor3-cli.test.mjs`.

Follow-up receipts:
`docs/architecture/raptor3-evidence/g4/witness-review-followup-receipts/`.
New probes (kept):
`tests/raptor3/g4/review/witness/campaign-transport-models.review.test.ts`,
`tests/raptor3/g4/review/witness/native-fixture-satisfiable.review.test.ts`.

---

## Outcome: **ACCEPT**

All five must-fix findings are resolved, four of the five notes are fixed, and
the fifth (note 6) is disposed of by the exact second remedy my own finding
offered — a plain statement of the campaign's observable surface in `note.md`
§4/§12.7 and in `handoff.md` §1, where the downstream consumers will read it.

I did not take the repair on its word anywhere it mattered:

- The **subject leak** is closed *live*: with `VIBORM_RAPTOR3_G4_SUBJECT=shipped`
  exported in the shell, the child now runs the **candidate** and says so in
  `attempt.json`; asked for by name, `--subject=shipped` is recorded in
  `attempt.json`, `verified.json`, the child receipt and the printed line.
- The **profile axis** is real, not bookkeeping: my own probe drives the sealed
  driver directly and shows the atomic profile physically issues `BEGIN`/`COMMIT`
  on the connection, the weak profile hands back genuinely frozen copies (a
  decoder that writes into one throws) with `rowCount: 0`, the acknowledging
  profile completes an awaited turn before the rows are released and reports the
  exact count, and `observedTransport()` refuses to name a model for a cell that
  behaved as two.
- Both **retained archive receipts** name a command I executed successfully, and
  both archives restore to exactly the SHA-256 they record; replaying the
  transport lane reproduced a **byte-identical record stream**.
- The **estate** reproduces cell for cell against the author's `repair3.json`
  (75 cells, 34 green / 41 red, **0 differences**), with no green cell lost and
  no red cell silently flipped.
- The **cost** figures are exact: 6,354 owned test lines, 955 added / 19 removed
  across the six registration files, charged LOC 0 (the patch is byte-current
  with `git diff` and touches no file under `src/`).

Six round-2 notes are recorded below for the record; none of them is a false
green and none blocks qualification of this unit.

---

## Reproduction

| Suite / command | Result | Receipt |
| --- | --- | --- |
| `node scripts/run-vitest-safe.mjs run tests/raptor3/g4/read-*.test.ts tests/raptor3/g4/lifecycle-*.test.ts tests/raptor3/g4/generation/harness.selftest.test.ts` | **75 cells, 34 passed, 41 failed**, 5.61 s / 795.4 MiB — identical cell-by-cell to `repair/g4-fixed-witnesses.repair3.json` (0 differences); per-file split 4/7, 6/7, 1/4, 2/4, 6/1, 1/4, 4/8, 0/3, 1/2, 3/1, 6/0 as claimed | `g4-fixed-witnesses-reproduction.{log,json}` |
| the same, re-run after a concurrent `src/` edit by the G4-03 stream | **0 cells changed**, 5.47 s / 789.7 MiB | `g4-fixed-witnesses-reproduction2.{log,json}` |
| `node scripts/run-node-safe.mjs --rss-limit-mb=1536 768 120000 scripts/raptor3-campaign-receipts.test.mjs` | **38/38**, 0.42 s / 64.0 MiB (37 before the repair) | `campaign-receipts-selftest.log`, re-run after my probes landed: `campaign-receipts-selftest.attempt2.log` |
| `node scripts/run-node-safe.mjs --rss-limit-mb=1536 768 600000 scripts/raptor3-cli.test.mjs` | attempt 1 **8/9** — the failing cell and the file hook both failed on `Stale Raptor 3 evidence`, i.e. identity drift from a concurrent `src/query-engine/raptor3/route/client-route.ts` edit at 01:40, not on a G4 assertion; attempt 2 in a quiet window **9/9**, 226.60 s / 218.2 MiB, including `a G4 campaign subject comes from the command, never from the shell` | `raptor3-cli-selftest.log` (failed attempt kept), `raptor3-cli-selftest.attempt2.log` |
| `node scripts/run-raptor3.mjs g4-generation-selftests` | **6/6**, contract gate verified, 4.07 s / 540.2 MiB | `g4-generation-selftests-mode.log` |
| `VIBORM_RAPTOR3_G4_SUBJECT=shipped node scripts/run-raptor3.mjs g4-seed-batch 20000` | exit 1 — the child ran the **candidate** (`attempt.json`: `subject: "candidate"`, `qualifying: true`) and stopped at the frozen candidate's missing codec | `subject-authority/ambient-shipped.log`, `subject-authority/ambient-shipped.attempt.json` |
| `node scripts/run-raptor3.mjs g4-seed-batch 20000 --subject=shipped` | exit 0, **200 cells / 600 replays**, 5.01 s / 704.6 MiB, corpus 337,999 B, receipt 49,276 B, 100 `interactive-session` at 1 statement + 100 `atomic-submission` at 3; stdout, `verified.json` and `attempt.json` all carry `subject`/`qualifying` | `subject-authority/flag-shipped.log`, `subject-authority/flag-shipped-evidence/` |
| `node scripts/run-raptor3.mjs g4-transport-seed-batch 50000 --subject=shipped` | exit 0, **200 cells / 600 replays**, 5.22 s / 727.2 MiB, corpus 324,199 B, receipt 50,466 B, 100 `detached-returning` + 100 `acknowledged-returning`; records **byte-identical** to the retained corpus | `subject-authority/transport-flag-shipped.log`, `…verified.json`, `…attempt.json` |
| `node scripts/run-typecheck.mjs` | only the two permitted historical `pack.ts` TS2345 diagnostics; this unit, this repair and my probes add none. 6.68 s / 5904.4 MiB, teardown verified | `typecheck.log` |
| Review probes (8 round-1 files, 18 cells) | **11 pass / 7 fail** — every must-fix probe inverted by its repair, matching the author's report exactly | `review-probes-after-repair.log` |
| Review probes including this round's two new files (10 files, 28 cells) | **21 pass / 7 fail** | `review-probes-final.log` |
| New probe `campaign-transport-models.review.test.ts` | **5/5** | `transport-models-probe.log` |
| New probe `native-fixture-satisfiable.review.test.ts` | **5/5** | `native-fixture-satisfiable-probe.log` |

Archive integrity, checked by hand: both retained `generated-corpus.json.gz`
restore to exactly the `originalSha256` their receipts record
(`d1d8a07a…`, `64e7c92f…`), and the transport lane's retained `records` array is
byte-identical to the one my re-run produced — only the harness identity
differs (note N4).

---

## Round-1 findings — status

| # | Round-1 severity | Status | How I checked it |
| --- | --- | --- | --- |
| 1 | must-fix — cache-bypass falsifier asserted nothing about the candidate | **Resolved** (one residual note) | Source + estate run |
| 2 | must-fix — four "transport profiles" were one profile with four names | **Resolved**, independently falsified | New probe + live children + self-tests |
| 3 | must-fix — subject set by an unsanitised ambient variable | **Resolved**, verified live | Two executed children + CLI self-test |
| 4 | must-fix — native suite could not pass and over-claimed | **Resolved** offline; still blocked/unverified | New probe + retained refusal receipts |
| 5 | must-fix — retained archive receipt stated a failing replay command | **Resolved** | Executed both replay commands; SHA-verified both archives |
| 6 | note — campaign publishes no codec-bearing value | **Disputed by disclosure — accepted** | Probe still passes; disclosure verified in three places |
| 7 | note — one refusal witnessed on the shipped engine only | **Fixed** | New green cell |
| 8 | note — four adversarial cases absent | **Fixed** | Four new cells (3 green, 1 red) |
| 9 | note — reported test cost stale | **Fixed** | Both figures recomputed exactly |
| 10 | note — small internal inaccuracies | **Fixed** | All five items re-read |

### 1 — C13 cache-bypass falsifier · **resolved**

`tests/raptor3/g4/lifecycle-admission.test.ts:48-93` is now a module-level
oracle `assertCacheBypass(base, route)` holding all three statement-count
assertions; `:187-199` runs that same function against the shipped route **and
the candidate route**, each with its own `MemoryCache`; `:201-227` is a new
self-falsification cell. The candidate cell is still red, and red for the
candidate's own reason — `UnsupportedOperationError … publishes no prepared read
shape` — so when G4-03 lands the cache encoder the three assertions are what
decides the cell. The exact failure mode my finding named (a silently green
cell testing nothing) is gone.

My round-1 probe `cache-bypass-blindness.review.test.ts` still passes; the
author discloses why, and I confirm it: the probe embeds a verbatim copy of the
old candidate block instead of reading the file, so it no longer speaks about
this unit. See note **N1** for the one thing the in-tree self-falsification does
not exercise.

### 2 — the campaign's profile axis · **resolved, independently falsified**

`tests/raptor3/g4/generation/world.ts:246-415` now implements four executed
read-transport models; `campaign.ts:113,133` records the model the driver
actually exhibited per cell; `scripts/raptor3-manifest.mjs:723-728` owns the
frozen `profile → model` expectation and `:1106-1176` compares the two, also
requiring the models within a lane to be distinct and an `atomic-submission`
cell to report `statements % 3 === 0`.

I did not take the model names on trust. My probe
`campaign-transport-models.review.test.ts` (5/5) drives the sealed driver
directly and shows:

- `sqlite-interactive` — one statement, borrowed rows, `rowCount = rows`;
- `sqlite-atomic-batch` — the physical stream is exactly `["BEGIN", <SELECT>, "COMMIT"]`;
- `scripted-returning-weak` — the returned rows are genuinely `Object.isFrozen`
  (assigning to one throws `TypeError`) and `rowCount` is genuinely `0`;
- `scripted-returning-ack` — the transport really completes an awaited turn
  before the rows are released (an ordering assertion, not a name) and reports
  the exact count, and the driver declares `supportsOrderedCommittedSegments`;
- `observedTransport()` answers `"none"` for a cell that exhibited two models,
  so a collapsed profile fails the receipt instead of passing under a name.

Two in-tree falsifiers exist and are green
(`harness.selftest.test.ts:293-330`: a cell whose transport is another profile's
model, and an atomic cell that did not wrap its statement), plus the four-way
distinguishability cell at `:186-250`. My round-1 probe
`campaign-profile-power.review.test.ts` now fails, as it must. The executed
children confirm the axis in production shape: 100 cells at 1 statement versus
100 at 3 in the SQLite lane, and the two returning models in the transport lane.
`note.md` §4 states the honest limit (for a read, the transport lane's two
profiles differ in the returned envelope only), which matches what I measured.

### 3 — who decides a child's subject · **resolved, verified live**

`scripts/run-raptor3.mjs:224-251, 330-357, 464, 495, 531-548, 620-676, 806-812,
1028-1032`. The runner owns the subject (`--subject=candidate|shipped`,
defaulting to `candidate`, admitted only by the four G4 campaign modes),
`delete environment.VIBORM_RAPTOR3_G4_SUBJECT` sits beside the other sanitised
variables, the receipt assertion is selected from `requestedSubject.qualifying`
rather than from the receipt's own field, and `subject`/`qualifying` are written
into `attempt.json`, both `verified.json` shapes and the printed line. The
generated G4 replay command carries the subject.

Executed, not read: with `VIBORM_RAPTOR3_G4_SUBJECT=shipped` in my shell the
child ran the candidate (`attempt.json`: `subject: "candidate"`, and it failed
on the frozen candidate's missing codec); with `--subject=shipped` the run
printed `(subject shipped, NOT qualifying — oracle validation)` and wrote
`subject: "shipped"`, `qualifying: false`, `status: "oracle-validation"` in every
artefact. The child still reads the value from the environment, which is correct
now that the runner deletes any inherited value, writes its own, and the two
campaign tests refuse to run when the value is missing or unknown
(`sqlite-campaign.test.ts:18-22`, `transport-campaign.test.ts:18-22`). The CLI
falsifier I asked for exists in the shape I asked for
(`scripts/raptor3-cli.test.mjs:225-273`) and passes.

### 4 — the native read-envelope suite · **resolved as far as is decidable offline**

`tests/raptor3/g4/native/read-envelope-native.test.ts` now seeds real `Buffer`
bytes on all three rows and a real JSON document, adds `DATE`/`TIME`, projects
`big, amount, moment, day, clock, status, document, payload`, states exactly what
it does and does not cover (lists, PostGIS metre tier, pgvector — the spatial
claim is withdrawn), and its fourth cell is the real private fit: an
`OperationContext`, `context.queries.recursive(nativeNode, …)` over a mapped
compound self-relation with a tenant the seed must not reach, and
`world.statements.length === 1`.

My probe `native-fixture-satisfiable.review.test.ts` (5/5) derives the NOT NULL
column set from the fixture's **own** DDL builders and requires that no seeded
row supplies a NULL for one of them — the defect my round-1 finding named is
mechanically absent now, not merely edited around. I also pinned the projected
field set, the withdrawn spatial claim and the private-fit entry point. Round-1
cells 1 and 3 of `native-fixture-consistency.review.test.ts` are correspondingly
inverted; its cell 2 still passes because it hardcodes its own NULL insert
(a general fact about SQLite, no longer a claim about this file).

Still **blocked and still entirely unverified against a provider**: both modes
were re-attempted after the repair and retained their exact refusals — no port
(`AssertionError: Required live provider loopback port is missing or invalid`,
zero cells collected) and with a port supplied, four cells at
`connect ECONNREFUSED 127.0.0.1:5434` / `:3307`
(`repair/native/{pg,mysql}-{no-port,port-*}.log`). Reported blocked, never as
passed. Carried forward as unverified claim 1.

### 5 — the retained archive receipt · **resolved**

Both retained children were re-run and re-archived; each
`generated-corpus.archive.json` now names the command that produced it, subject
included. I executed both named commands: `g4-seed-batch 20000 --subject=shipped`
and `g4-transport-seed-batch 50000 --subject=shipped` both exit 0, and the
transport corpus my run produced is byte-identical, record for record, to the
retained one. Both retained archives restore to the SHA-256 their receipts
record. The falsifier I asked for exists
(`scripts/raptor3-campaign-receipts.test.mjs:184-230`): the two-argument call
must carry its own command and must not spell the `replay` default, and the
one-argument call must still spell the G0/G3 default exactly. My round-1
`evidence-integrity` archive cell is inverted; its differential-oracle cell
still passes, so the oracle's ordering guarantee is intact.

### 6 — the codec-blind campaign · **disputed by disclosure, accepted**

Not repaired, and openly so. My finding offered two remedies — widen
`SELECTED_FIELDS`, or state the observable surface plainly in §4 and §12 — and
the author took the second: `note.md` §12.7 names the three projected field
sets, says the campaign witnesses no codec but `enum`, notes that `canonical()`
would erase a `Buffer`/`Uint8Array` distinction anyway, and points at the 12
fixed codec cells as where codec identity is pinned; `handoff.md` §1 repeats the
limit where G4-01/G4-02 will actually read it ("apart from `enum` it witnesses
**no codec**"). My probe `campaign-codec-blindness.review.test.ts` still passes,
which is what makes the disclosure accurate rather than decorative. The reason
given for deferring (widening the projection changes every oracle expectation
and requires re-validating both lanes) is sound, and it is recorded as the
highest-value follow-up for the campaign. Accepted as a disclosed limitation,
not as a repair.

### 7–10 — the remaining notes · **fixed**

- **7.** The one-sided `observeFailure` became `expectRefusal` in its own cell,
  `Q-W05 refuses a list container on a scalar column` — green, and correctly
  split out so it is not parked behind the red containment rows.
- **8.** All four cells exist: `Q-P03` windowing the junction collection shared
  by `acme/ada` and `acme/bob` (green), `Q-S01` stitching a collection while the
  mapped compound key is unselected (green), `Q-W03` partitioning a nullable
  column at the NULL itself (green), and `Q-W04` pinning that the insensitive
  mode folds ASCII only (red, on the candidate's missing `contains` — the same
  reason as the existing Q-W04 cell).
- **9.** Recomputed independently: `find tests/raptor3/g4 -name '*.ts' !
  -name 'route-*.test.ts' ! -path '*/review/*' | xargs wc -l` = **6,354**;
  `git diff --numstat` over the six registration files = **955 added / 19
  removed**. Both exact. Charged LOC 0 re-confirmed: `production.patch` contains
  six `diff --git` headers, none under `src/`, and is byte-identical to the
  current tracked diff.
- **10.** `read-schema.ts:1-17` now names `author.score` as the deliberate
  exception; the Q-P03 title says `cursor`; `RAPTOR3_ROUTE_AVAILABLE` is gone
  from the tree; the duplicated ternary arms are one arm
  (`raptor3-campaign-receipts.test.mjs:1024`); the §1 cross-reference points at
  §8. The identity-drift bullet stands as blocker 2 — see N4.

---

## Round-2 notes (recorded, none blocking)

**N1 — the cache-bypass self-falsification exercises only the first of the three
assertions.** The `cacheAlways` stand-in
(`lifecycle-admission.test.ts:201-227`) never reaches a provider at all, so
`assertCacheBypass` rejects it on *"the first cached read … must reach the
provider"*. The assertion that carries the actual C13 invariant — a read inside
`$transaction` must bypass the cache — is never the one that fires. A stand-in
that serves the provider first, the cache second **and** the cache inside the
transaction would pin it. This does not weaken the candidate measurement (all
three assertions run against the candidate route); it is the falsifier's own
coverage.

**N2 — "six cells were added" is seven.** The repair summary, `note.md` §13 and
`handoff.md` revision 3 all say six (five green, one red). Measured pre/post:
68 → 75 cells with one rename (the Q-P03 title fix), i.e. **seven** new cells,
six green and one red — the seventh being the `Q-W05` refusal cell, which the
prose treats as a move rather than an addition even though it raises the count.
The registration table in §13 is right (`read-filters` 10 → 13), so nothing
downstream is mis-registered.

**N3 — the SQLite lane's per-child disk figure excludes a file the directory
holds.** §4 records 64,590 B retained per SQLite child; the retained directory
is 65,646 B because it also keeps `runner-attempt1-identity-drift.log`
(1,056 B), a failed attempt that is correctly retained. For a routine child the
64,590 B figure is the right basis, so the ≈ 30.9 MB projection stands; the
discrepancy is worth one sentence in §4 rather than a re-measurement.

**N4 — the retained campaign receipts are stale again, for reasons outside this
unit.** They carry harness identity `3eb52728…` while the tree now reads
`e544d14e…` (my own probe files are part of that hash); the production identity
`2b1c61ef…` is unchanged. The drift comes from post-archive harness edits and
from the concurrent G4-03 and unit03 streams. My own re-runs of both lanes
re-establish the campaign evidence at the current identity and reproduce every
figure in §4, so nothing is lost — but blocker 2 is real and the campaign
figures must be re-measured once the tree is quiet, exactly as the note says.

**N5 — reproduction hazard in a shared tree.** My first `raptor3-cli.test.mjs`
run failed 1/9 purely because another stream wrote
`src/query-engine/raptor3/route/client-route.ts` 40 seconds into a 227-second
suite; the G4 subject cell itself passed. The failed receipt is kept
(`raptor3-cli-selftest.log`). Anyone re-verifying this unit should run that
suite in a quiet window and expect 9/9.

**N6 — native provider behaviour remains entirely unverified** (carried
forward). The suite is now satisfiable and correctly scoped, but no cell has
ever executed against PostgreSQL or MySQL. Two of its expectations are worth a
second look the day a provider answers: the MySQL `mode: "default"`
case-sensitivity assertion relies on `containsText` spelling
`LOCATE(BINARY …)` (`src/adapters/databases/mysql/mysql-adapter.ts:487`), and
the JSON seed is sent as a JSON text for a `JSONB`/`JSON` column. Both look
right by inspection; neither is evidence.

---

## Unverified author claims (carried forward after this round)

1. **Native provider behaviour** — unverified; the file has never executed
   against a provider (N6). Now correctly labelled in `note.md` §12.1.
2. **The campaign has executed 100 seeds per lane, not 25,000** — confirmed as
   stated; I executed one child per lane myself.
3. **No candidate-subject child has ever completed**, so candidate child cost is
   unmeasured — confirmed: my candidate-subject run stopped on cell 0.
4. **The route counts registered for G4-03 (7/5/6/8)** were read from that
   unit's files; I did not re-derive them this round.
5. **That this unit edited no `src/` file** — now verified rather than assumed:
   `production.patch` is byte-current with `git diff` over the six registration
   files and contains no `src/` path. The dirty `src/` files and the untracked
   `src/query-engine/raptor3/route/` belong to G4-03.
