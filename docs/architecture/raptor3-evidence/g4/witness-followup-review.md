# G4 witness follow-up (native fixtures, write campaign, G4-01 evidence landing) — independent review

Reviewer: independent; did not author the unit, its round-1 repair or this
follow-up. Reviewed source: main tree `/Users/arnaud/code/viborm`, branch
`pattern-engine`, already containing the change (nothing applied, nothing
repaired here). Date 2026-09-15.

Inputs read: `g4/briefs/common.md`, `g4/briefs/review.md`,
`g4/briefs/witness-followup.md`, `g4/witness/note.md` (§14 in full, §§1–13 for
context), `g4/witness/handoff.md`, `g4/witness/receipts/followup/**` (every log,
JSON and identity file), the follow-up patch
`g4/witness/receipts/followup/witness-harness-vs-0cc61e61.patch`, and the
current source of `tests/raptor3/transitions/live-world.ts`,
`tests/raptor3/g4/native/read-envelope-native.test.ts`,
`tests/raptor3/g4/generation/write-*.test.ts`,
`tests/raptor3/g3/generation/{recipe,sqlite-campaign,transport-campaign}.ts`,
`scripts/{run-raptor3,raptor3-manifest,raptor3-campaign-receipts.test,raptor3-cli.test,credential-free-test-manifest}.mjs`,
`vitest.workspace.ts`, plus `src/drivers/{pg,mysql2}/index.ts` and
`src/adapters/databases/mysql/mysql-adapter.ts` for the two repaired facts.

Review receipts:
`docs/architecture/raptor3-evidence/g4/witness-followup-review-receipts/`.
Probes (kept): `tests/raptor3/g4/review/witness-followup/` —
`write-lane-registration.review.test.ts`, `evidence-identity.review.test.ts`,
`native-pool-configuration.review.test.ts`,
`native-fixture-authority.review.test.ts`, `review.workspace.ts`.

---

## Outcome: **REVISE**

The four brief outcomes are delivered and, where they are checkable, they check
out. I reproduced every headline number and on three of them got a *different*
result than the author — two better, one worse — because the tree moved
underneath both of us. What sends this back is not the work: it is that the two
new campaign lanes re-open the exact ambient-variable class this stream's
round-1 review closed (finding 1), that neither new child mode is registered in
the runner's cell-count map (finding 2), that the note's identity narrative is
contradicted by the follow-up's own receipts (finding 3), and that the write
lane's archive receipt names a command that never touches the archive it just
proved (finding 4). All four are small, local and inside the files this stream
owns.

What I verified rather than accepted:

- **The native repair is real, and it is the fixture's.** My own probe goes to
  the recorded containers without the ORM: the pool the repaired fixture builds
  returns PostgreSQL `DATE`/`TIMESTAMP` as text and MySQL `DATE` as text with
  wide integers exact, and a pool built the old way (`new PgPool(options)` /
  `createPool(options)`) returns `Date` objects and a lossy `number` for the
  same columns. MySQL refuses the ISO-`Z` literal the old seed wrote
  (`Incorrect datetime value`) and accepts the adapter's naive-UTC spelling,
  reading the stored instant back as `2024-01-15T10:30:00.123Z`. Both defects
  were the fixture's, exactly as claimed.
- **The landing is byte-exact.** `diff -rq` against the author's worktree
  `/private/tmp/viborm-g4-unit01` reports `tests/raptor3/g4/unit01/` identical
  and exactly one differing review file — `unit01-followup2/cursor-refusal.test.ts`,
  1,574 → 1,670 bytes, the TS2638 repair and nothing else.
- **The counts are exact.** Re-derived independently from the author's census
  JSON: 54 files, 387 cells, **0 count mismatches**, 375 green / 12 red, and the
  12 reds are the 12 the note names; `route-transactions.test.ts` is 11. Re-run
  through the runner: `g4-unit01-author` 83/83 and `g4-unit01-review` 200/200,
  both count gates passing.
- **The write children really are the G4 candidate's.** `verifyG3SQLiteCell`
  drives `candidateFactory: createCommandEngine` from the live `src`, and the
  G3 scenarios do reach `prepareBatch` (`transaction-array-scenario.ts:63`,
  `suppression-scenario.ts:251`, `transport-plans.ts:445`), so the lanes exercise
  the prepared-operation boundary G4 moved rather than replaying G3's subject.
- **The G3 widening is inert for G3.** Only the two bound constants changed in
  `recipe.ts`; the picker (`seed ^ 0xa4093822`), the rotation (`(seed - 8000) % 4`)
  and the actor/fault rules (`seed % 5`) are untouched absolute functions of the
  seed, and `(75000 - 8000) % 4 === 0`, `(100000 - 8000) % 4 === 0` keep the
  receipt's `(seed - campaign.firstSeed) % 4` equal to the generator's.
- **The ranges are disjoint** — not only from the three campaigns the new
  self-test cell compares against, but from all eight `firstSeed`/`seedCount`
  pairs the manifest declares (probe cell, green).

### Suites run (serial, through the bounded runner and the workspace lock)

| Command | Result | Receipt |
| --- | --- | --- |
| `node scripts/run-raptor3.mjs g4-read-envelope-pg-contracts` (`VIBORM_RAPTOR3_PROVIDER_PORT=65504`) | **4 passed / 0 failed** (author: 3/4; the `42883` cell is green at the current production identity) | `native-pg-mode-attempt1.log` |
| `node scripts/run-raptor3.mjs g4-read-envelope-mysql-contracts` (port 65515) | 4 passed / 0 failed | `native-mysql-mode-attempt1.log` |
| `node scripts/run-raptor3.mjs g4-unit01-author` | 83 passed / 0 failed, 10 files | `mode-g4-unit01-author-attempt1.log` |
| `node scripts/run-raptor3.mjs g4-unit01-review` | **200 passed / 0 failed**, 29 files (author: 197/3) | `mode-g4-unit01-review-attempt1.log` |
| `node scripts/run-raptor3.mjs g4-route-transactions` | 9 passed / **2 failed** of 11 (census had 1 red) | `mode-g4-route-transactions-attempt1.log` |
| `node scripts/run-node-safe.mjs … scripts/raptor3-campaign-receipts.test.mjs` | **39 passed / 0 failed** | `campaign-receipts-selftest-attempt1.log` |
| `node scripts/run-typecheck.mjs` | clean apart from the two permitted Pattern TS2345 (6.58 s, 5,751.3 MiB) | `typecheck-attempt1.log` |
| review probes (13 cells) | 3 green / 7 red / 3 skipped, then 1 green / 4 red on the corrected write-lane file | `probes-attempt2.log`, `probes-attempt3.log` |
| review probes, pg and mysql pools | 1 green / 2 skipped; 2 green / 1 skipped | `probe-native-pg-attempt1.log`, `probe-native-mysql-attempt1.log` |
| `VIBORM_RAPTOR3_GENERATED_SEED_COUNT=1 … g4-write-seed-batch 75000` | "contract gate verified", **qualifying receipt of 1 seed / 2 cells** | `write-child-ambient-count-attempt1.log`, `write-child-ambient-count/` |
| `… g4-write-seed-batch 75000` then `… replay <corpus>` | child green, **gate replay of the write corpus green** | `write-child-2seed-attempt1.log`, `write-corpus-gate-replay-attempt1.log` |
| `node scripts/run-raptor3.mjs g4-write-seed-batch 75000` (full 100 seeds) | green, 6.83 s / 873.0 MiB | `write-seed-batch-75000-attempt1.log` |
| `node scripts/run-raptor3.mjs g4-write-transport-seed-batch 100000` | **red at cell 54** (finding 9) | `write-transport-seed-batch-100000-attempt1.log`, `write-transport-100000-red/` |
| `node scripts/run-node-safe.mjs … scripts/raptor3-cli.test.mjs` | **9 passed / 1 failed**, no identity drift (finding 8) | `raptor3-cli-selftest-attempt1.log` |

Identity during my runs: production `c2613acf…` for everything up to and
including the typecheck (`identity-before-native.json` = `identity-after-chain.json`,
harness `0da8165b…`; the harness moved only when I added my own probe files),
then `b100ea77…` / `6aedd37b…` by the time the two write children re-ran
(`identity-after-chain4.json`) — the phase-2 author was writing `src/`
throughout. Each receipt above carries the identity its own run captured.

---

## Findings

### 1. (must-fix) The two new write children take their seed count from the ambient environment — the class the round-1 repair closed

`tests/raptor3/g4/generation/write-campaign.test.ts:26` and
`tests/raptor3/g4/generation/write-transport-campaign.test.ts:25`:

```ts
const seedCount = Number(
  process.env.VIBORM_RAPTOR3_GENERATED_SEED_COUNT ?? G4_WRITE_CAMPAIGN.batchSize
);
```

`scripts/run-raptor3.mjs:835-847` deletes `VIBORM_RAPTOR3_GENERATED_FIRST_SEED`
and `VIBORM_RAPTOR3_G4_SUBJECT` from the child environment but **not**
`VIBORM_RAPTOR3_GENERATED_SEED_COUNT`, and `environment = { ...process.env }`
forwards it.

This is not a class the follow-up merely resembles — it is a recorded repair
undone. `note.md` §13, must-fix 3, says of the round-1 fix, in the author's own
words: *"The two campaign child tests no longer default the subject or read
`VIBORM_RAPTOR3_GENERATED_SEED_COUNT`: a child holds the frozen batch"*
(`note.md:707-709`), and `tests/raptor3/g4/generation/sqlite-campaign.test.ts`
still carries that hardening in a comment. The two child tests added by this
follow-up read it again.

Nothing downstream catches it: `assertG3GeneratedBatchReceipt` accepts any
`seedCount` in `1..batchSize` (probe cell "refuses a child that holds fewer
seeds than the frozen batch" → *Missing expected exception*, with a receipt
whose every re-derived recipe fact is truthful), and the runner has no
cell-count entry for these modes (finding 2).

Reproduction (run, not argued):

```
VIBORM_RAPTOR3_GENERATED_SEED_COUNT=1 node scripts/run-raptor3.mjs g4-write-seed-batch 75000
→ "Raptor 3 g4-write-seed-batch contract gate verified"
→ generated-campaign.json: { firstSeed: 75000, seedCount: 1, cells: 2, replays: 6, qualifying: true, status: "complete" }
```

(`witness-followup-review-receipts/write-child-ambient-count-attempt1.log`,
`…/write-child-ambient-count/generated-campaign.json`). A 250-child parent run
with that variable inherited would print "campaign verified" for 250 seeds
instead of 25,000, and every child receipt would be individually valid.

The hazard is not hypothetical inside this evidence tree: the author's retained
`receipts/followup/write-campaign/probe-sqlite-1seed.log` is such a run — its
text is "Raptor 3 g4-write-seed-batch contract gate verified" with nothing in
the log saying it covered one seed.

**Resolution.** Bind the count to the campaign in both new children
(`G4_WRITE_CAMPAIGN.batchSize`, as the read child does) and/or `delete
environment.VIBORM_RAPTOR3_GENERATED_SEED_COUNT` beside the subject in
`run-raptor3.mjs`; if a reduced smoke child is wanted, give it its own mode.
`tests/raptor3/g3/generation/sqlite-campaign.test.ts` carries the same line —
that is pre-existing and this finding is not a request to change G3.

Probe: `tests/raptor3/g4/review/witness-followup/write-lane-registration.review.test.ts`
(cells 1–3).

### 2. (must-fix) Neither write child mode is registered in the runner's expected-counts map

`scripts/run-raptor3.mjs:770` registers `"g4-write-seed-batch"` in the *files*
map; the *expected-counts* map at `scripts/run-raptor3.mjs:946-951` has
`"g4-seed-batch"` and `"g4-transport-seed-batch"` but neither write mode. Since
`expectedCounts` is then `undefined`, the guard at
`scripts/run-raptor3.mjs:1010` (`if (expectedCounts)`) skips the per-file cell
assertion entirely: every other `*-seed-batch` mode in the estate pins its
child at `{file: 1}`, these two pin nothing. A write child file that gained a
second `it`, or lost its only one to a `describe.skip`, would run "verified".

This is inside the brief's own item 4 (registration hygiene).

**Resolution.** Add

```js
"g4-write-seed-batch": { "tests/raptor3/g4/generation/write-campaign.test.ts": 1 },
"g4-write-transport-seed-batch": { "tests/raptor3/g4/generation/write-transport-campaign.test.ts": 1 },
```

Probe: same file, cell "pins the child cell count of every registered
seed-batch mode" (`g4-write-seed-batch is registered in 1 of the runner's two
maps`, 1 !== 2).

### 3. (must-fix) §14's identity statements are contradicted by the follow-up's own receipts

`note.md` §14.8 states "Every receipt in this follow-up except the four CLI
attempts and the parse-level check was produced at harness `72fbd01e…`" and
"the only difference is the comment corrected in
`tests/raptor3/transitions/live-world.ts` at 05:02 — no other file under
`tests/` or `scripts/` was touched after 04:53"; the §14 preamble states "every
red recorded here is red against `d844ae0f…`".

What the receipts say (probe `evidence-identity.review.test.ts`, which walks
every JSON under `receipts/followup/`):

| Receipt | production | harness |
| --- | --- | --- |
| `native/pg-attempt1/attempt.json`, `native/mysql-attempt1/*` | `eb93c64d…` | `854ad639…` |
| `write-campaign/sqlite-75000/*`, `write-campaign/transport-100000/*` | `d844ae0f…` | `854ad639…` |
| `mode-g4-unit01-author/attempt.json`, `verified.json` | `08861ba0…` | `c7a5344f…` |
| `identity-at-census.json` | `d844ae0f…` | `72fbd01e…` |
| `identity-final.json` | `6c26242c…` | `6e204375…` |

**No receipt carries `72fbd01e…`**; the receipts span two harness identities and
three production identities, and the harness moved between 04:53 and 05:03 as
well as after it. In particular the PostgreSQL `42883` red — the one cell this
follow-up hands to G4-02 — was recorded at production `eb93c64d…`, which the
note never names. The receipts themselves are correct and complete; the prose
about them is not, and "receipts must carry the identity of the source they ran
on" is a hard rule whose value is the accuracy of that statement.

**Resolution.** Replace the two sentences with the per-receipt table above (or
equivalent), and drop the "only difference is a comment" claim unless it can be
supported.

### 4. (must-fix) The write lane's archive receipt names a command that never touches the archive

`scripts/run-raptor3.mjs:667-675` gives `g4-write-` children the replay command
`node scripts/run-raptor3.mjs <batchMode> <firstSeed>`, justified as "their
parser would refuse a `--subject`". But the G0/G3 default command carries no
`--subject` either, and unlike the G4 *read* lane this lane's corpus is a
G3-format `G0ReplayRecord` corpus that the ordinary gate replays:

```
node scripts/run-raptor3.mjs g4-write-seed-batch 75000      # child, green
node scripts/run-raptor3.mjs replay <child>/generated-corpus.json
→ "Raptor 3 replay contract gate verified"
```

(`write-child-2seed-attempt1.log`, `write-corpus-gate-replay-attempt1.log`.)
As written, the archive receipt proves a gzip round-trip to the byte and then
names a command that regenerates the corpus from seeds instead of consuming the
restored bytes — the restore step it documents has no consumer. This is the
round-1 must-fix 5 shape (a retained archive receipt whose replay command does
not do what the receipt implies), in a lane where the inherited default works.

**Resolution.** Call `archiveG3GeneratedCorpus(receiptDirectory)` with no second
argument for `g4-write-` children, or state in the note why a re-run is
preferred to replaying the archived bytes.

### 5. (note) `nativeDateTime` duplicates the adapter's private rule rather than applying it

`tests/raptor3/g4/native/read-envelope-native.test.ts:78` says it "applies that
one rule once" and `note.md` §14.1 says it "applies the adapter's own rule
(`toMySqlDateTime`)". It does not: `toMySqlDateTime`
(`src/adapters/databases/mysql/mysql-adapter.ts:360`) is not exported, and the
fixture re-spells its body. The two agree exactly today — my probe compares the
fixture's arm against `new MySQLAdapter().literals.dateTime(iso)` for four
instants and passes — but a change to the adapter's spelling would leave the
fixture seeding a literal the product never sends, which is the failure the
repair just removed. Importing it would need a production edit this brief
forbids, so the practical remedy is the pin.

**Resolution.** Keep a cell in the native suite (or adopt mine) that compares
`nativeDateTime` with `adapter.literals.dateTime`, and reword the note to say
the rule is duplicated and pinned rather than applied.

Probe: `native-fixture-authority.review.test.ts`, cell 1 (green).

### 6. (note) The borrowed pool carries a background-failure listener nobody can read

`PgDriver.initClient()` (`src/drivers/pg/index.ts:170-185`) attaches
`pool.on("error", errorState.retain)` and keys the retained failure in a
`WeakMap` on the driver instance that built the pool. `runLiveWorld`
(`tests/raptor3/transitions/live-world.ts:394`, `:453`) discards that
`PgPoolFactory` instance, and the observed drivers receive the pool as a
*supplied* pool, which `initClient()` returns unsubscribed by contract. Net
effect: before the repair a background pool error reached Node and failed the
run loudly; now it is retained by an unreachable object and the fixture can pass
with a failed transport underneath it. (Probe: `pool.listenerCount("error")` is
1, expected 0.) No current run is affected — this is a hazard, not a defect in
the recorded results.

**Resolution.** Keep the factory instance and surface its retained failure in
`assertHealthy()`, or attach the fixture's own `error` listener that fails the
run.

### 7. (note) §14.7's ownership justification is wrong in one detail, and the patch is one edit stale

- §14.7 says of `tests/raptor3/g3/generation/`: "They belong to no G4 stream and
  nobody else is writing them." `tests/raptor3/g3/generation/transport-plans.ts`
  is modified in the working tree (mtime 02:33, between this stream's two
  windows; absent from this stream's round-1 `production.patch` and from the
  follow-up patch), adapting `Candidate` to the phase-2 engine type. Another
  stream *is* writing that directory. No conflict occurred — the three files
  this stream edited are not the one the other stream touched — but the
  justification as worded is false, and a reader reconciling `git status`
  against the patch finds a fifth dirty harness file that
  `receipts/followup/README.md` does not mention.
- `witness-harness-vs-0cc61e61.patch` is not byte-current with `git diff`: it
  records `live-world.ts` blob `a80d91e2` while the tree has `6a10eeaf` — the
  05:02 comment correction the note itself describes, made two minutes after the
  patch was written. One hunk header and two comment lines differ.

**Resolution.** Re-save the patch, and reword §14.7 to "no other stream edited
the three files I changed" with `transport-plans.ts` named.

### 8. (note) The CLI self-test reaches 9/10 here; the residual failure is another stream's `src/`

The author's best run is 6/10 with all four failures `Stale Raptor 3 evidence`
(unverified claim 6, honestly labelled; attempt 1's raw log was destroyed by the
author's own retry wrapper and is disclosed as a reconstruction rather than
relabelled — the right call). I got a quiet window:
`raptor3-cli-selftest-attempt1.log`, **9 pass / 1 fail**, 230.09 s wall,
217.8 MiB peak RSS, **no identity drift**. All three G4 cells are green,
including both this follow-up added ("the command refuses a filtered G4 mode and
an off-boundary G4 child", "the G4 write lanes own their own range and take no
subject") and "a G4 campaign subject comes from the command, never from the
shell".

The single failure is "test:all cannot replace the required lane through
inherited specimen variables", whose inner `test:all` run is **17 failed / 741
passed** across three files — `tests/raptor3/transport.test.ts`,
`tests/raptor3/g3/generation/generated-transport-smoke.test.ts` and
`tests/raptor3/core-structure/measurement/extension-campaign.selftest.test.ts`.
The failures are production-shaped, not registration-shaped: `TypeError` where a
`QueryEngineError` is owed, missing durable/uncertain progress facts, and
`Unscripted statement: g3-c11-8027-0:recurrence-0; actual=INSERT;
expected=INSERT,SELECT` — the candidate now issues one physical statement where
G3's scripted plan owes two. That is the phase-2 `src/` work, visible from my
identity (`c2613acf…`), and it is the integrator's to triage. So the brief's
item 4 is satisfied for everything this unit registered.

### 9. (note) Several numbers in §14 are already stale, as §14.9 predicted — including a write lane that is now red

At production `c2613acf…`: `g4-read-envelope-pg-contracts` is **4/4** (the
`42883` recursive-fit gap the note hands to G4-02 phase 2 is closed),
`g4-unit01-review` is **200/200** (the three finding-K probes are green), and
`g4-route-transactions` is 9/11 (two reds where the census had one).

More consequential for this unit: at production `b100ea77…` (the tree moved
again mid-run) the freshly registered **`g4-write-transport-seed-batch 100000`
is red** at cell 54 —

```
g3-transport:script-shape; Unscripted statement: g3-c11-100027-0:recurrence-0;
actual=INSERT; expected=INSERT,SELECT   (1 !== 2)
```

— the same signature as `tests/raptor3/g3/generation/generated-transport-smoke.test.ts`'s
`g3-c11-8027-0:recurrence-0` in the `test:all` run of finding 8. Note the
offsets: **100027 − 100000 = 27 = 8027 − 8000**. The new lane reproduces G3's
recipe at the same offset, which is an independent confirmation of the rotation
alignment §14.4 claims *and* evidence that the red is the candidate's physical
change (phase 2 now issues one statement where the scripted plan owes two), not
the campaign constant. The SQLite lane re-ran green (100 seeds).

None of this is the follow-up's defect — the note labels the census as a
snapshot of a moving tree — but §14.2, §14.4, §14.5 and §14.6 must not be
carried into the ledger as current results, and the write-transport lane needs a
green child at a settled production identity before it counts as proven.
Receipts: `write-transport-seed-batch-100000-attempt1.log`,
`write-transport-100000-red/generated-failure-54.json`.

### 10. (note) The new lanes exist only in `note.md`

`g4.md` — which `common.md` calls the authority for seed ranges — does not
mention `G4_WRITE_CAMPAIGN` (75000–99999), `G4_WRITE_TRANSPORT_CAMPAIGN`
(100000–124999), the four new modes or the two landed `g4-unit01-*` modes, and
`handoff.md` was last written at 01:24, before the follow-up. The brief asked
only for `note.md`, so this is a handoff gap for the integrator rather than a
missed deliverable — but the ranges are now frozen in code and nothing outside
this note records them.

### 11. (note) The self-test's disjointness cell compares against three campaigns, not "every other lane"

`scripts/raptor3-campaign-receipts.test.mjs:1071` builds `occupied` from
`G3_GENERATED_CAMPAIGN`, `G4_GENERATED_CAMPAIGN` and
`G4_GENERATED_TRANSPORT_CAMPAIGN` while the cell's doc comment claims disjointness
from every other lane. The claim is true today — my probe checks all eight
`firstSeed`/`seedCount` pairs in the manifest and passes — but a new campaign
constant would not be compared.

**Resolution.** Derive `occupied` from the manifest's campaign constants instead
of listing three.

---

## §7 decision-elimination gate, applied to the actual diff

No production file is touched: `grep "^+++ b/src/"` over the follow-up patch is
0, and every added file lives under `tests/`. No second public-syntax walker, no
per-verb codec, no duplicated result-shape preparation, no recreated lifecycle,
no projection rebuilt for a decoder, no JavaScript arithmetic beside SQL, no
policy-boolean bag, no per-feature interpreter, no fixture-named flag, no legacy
import or fallback, no cached absence, no public-contract change.

Two "one fact, one authority" observations, both inside test code and both
recorded above: the MySQL datetime spelling is now written twice (finding 5),
and the pool configuration is now written once — the repair's actual win, and
the reason `live-world.ts` no longer re-spells a single driver option.

The claimed deletion (`new PgPool(options)` / `createPool(options)` in the
fixture) did disappear: `createPool` is no longer imported by `live-world.ts`,
and `new PgPool(` survives only inside the comment at `live-world.ts:336` that
explains its removal. The replacing invariant has a falsifier
that fails when it is broken — mine, `native-pool-configuration.review.test.ts`,
which asserts both what the driver-built pool decodes and that a bare pool
decodes differently.

## Cost

Incremental core and complete charged cost **0 LOC / 0 parser tokens / 0 bytes**
— confirmed, not accepted: the follow-up patch touches 10 files, none under
`src/`, and the untracked additions are `tests/raptor3/g4/generation/write-*.test.ts`
(81 lines), the landed `tests/raptor3/g4/unit01/` (2,550 lines) and
`tests/raptor3/g4/review/unit01*/` (4,651 lines), all test/evidence. The
absolute census belongs to the G4-02 author, whose `src/` moved four times
during the follow-up and twice more during this review.

## Author claims left unverified by this review

1. That no `src/` file was edited by this stream. Consistent with the patch and
   with the concurrent stream's activity, but unfalsifiable from here while
   another author is writing `src/`.
2. The disk projection (≈ 679 MB for 250 children per lane) — arithmetic checked
   exactly against the two retained child directories (1,281,627 B and
   1,433,241 B), extrapolation unmeasured beyond one child per lane, as the note
   says.
3. The free-space trend (21 GiB → 4.1 GiB). The volume reads 6.4 GiB now; the
   trend is plausible and the recommendation (re-measure immediately before the
   campaign) is right, but the intermediate readings are not receipts.
4. That the three `g2-mysql-contracts` reds are candidate-side. The falsifier
   receipt against the unmodified `live-world.ts` is convincing for "not the
   pool repair"; I did not re-run those suites.
5. The cause of the PostgreSQL `42883` — moot now (finding 9), and never
   claimed as diagnosed.
