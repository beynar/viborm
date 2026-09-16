# G4 author qualification

## Outcome

The author qualification evidence is frozen on production
`312cde34932cdb4d70ccad60bb002d0c0a438865bd18e165c38b4a572ebff640`, harness
`1d4d913c4f686d7aa0871dde7f8af2c6049a674db2595c54a52b7f66491f2f9e`, baseline
commit `ff5e77ca`, and Node 24.21.0 — the performance-pass-2 identity (freeze 6,
18:40 on 2026-09-16). Every qualifying mode, campaign, replay and the structural
measurement passed on that identity. The index's `gaps` list is **empty** and
its status is
`author-qualification-evidence-complete-independent-and-root-acceptance-pending`.

Two checks were run twice, and neither first attempt was a candidate failure.
Both reds are kept whole, unrelabelled, beside the runs that are counted:

1. **The CLI self-test** was 9 of 10 under the six live campaign lanes and
   **10 of 10** when the sequencer re-ran it alone afterwards
   (`support/cli-selftest.log`; the red is `support/cli-selftest.attempt1-red.log`).
2. **The structural measurement** refused on a tooling incident — a capture
   timestamp the integrator had added to `g4/freeze/identity.json`, which
   `cs02-structure-measure` parses with a strict schema — and was **green** on
   the re-run once the annotation was removed
   (`structure/`; the red is `structure-attempt1-red-tooling/`).

One support record the driver did not write at all is named here rather than
passed over: `support/provider-ports.json`. The previous attempt's driver
captured the two provider containers; this one did not, so the packaging step
captured the record itself from `docker inspect` after the native groups and
says so inside the file. Both containers had been running since 12:58 and were
still up, so they were up continuously across both native groups and the ports
recorded are the ports those runs used. Everything else in `support/` is the
driver's own output.

`support/support-verification.json` re-derives, from the receipts themselves,
that the lane-5 source-cost census read the frozen bytes and that the counted
CLI self-test is green; `support/verify-support-receipts.mjs` is the script.

Independent and root acceptance are not part of this author package.

Every count in this report is derived from the receipts in this tree by
`support/build-qualification-index.mjs` and then pinned in that script, so a
later change to a receipt fails the build rather than quietly moving a number.
This attempt began with the pin set to `null`, derived its own totals once every
run was complete, wrote them back and re-ran with the assertion live: the
previous attempt's numbers are a different identity's and were never assumed.

This is the sixth qualification attempt.

- **Attempt 1** (2026-09-15 20:03) was stopped by a real red: `g2-generated`
  seed 2122 on `sqlite-atomic-batch` carried `recordSeriesProgress` and
  `statementIndex` on a root single write's failure where the shipped engine
  carries neither. The production repair moved the identity.
- **Attempt 2** (00:55) was stopped by a second red:
  `g3-author-execution-regressions` "Missing expected rejection", because under
  D-7 that specimen's plan is one statement and never reaches the corrupting
  driver's `executeBatch` cut. Re-expressing the specimen moved the harness
  identity.
- **Attempt 3** (01:58–03:47) passed with an empty `gaps` list and was sealed
  and committed inside `0f25637b`. Arnaud then ordered performance pass 1 (lazy
  control-flow errors, stable SQL aliases, small allocation trims), which moved
  the identity again, so attempt 3 was superseded without a red against it.
- **Attempt 4** (12:31–12:35) aborted at launch, tooling only: after the commit
  the six lanes were still checked out at `0cc61e61`, so the delta sync no
  longer carried the committed G4 files and every campaign parent failed in
  seconds; Docker Desktop was found stopped at the same time. Freeze 4 is void —
  it produced no receipt on a frozen identity.
- **Attempt 5** (12:47–14:06, sealed 16:38) passed on the pass-1 identity. Its
  first seal carried two support gaps — the CLI self-test at 9 of 10 and a
  source-cost measurement that had died with `spawnSync git ENOBUFS` — and both
  were re-run green on the unchanged frozen tree at 16:17–16:21, so it sealed
  with an empty `gaps` list and was committed inside `ff5e77ca`. Arnaud then
  ordered performance pass 2, which moved the identity again, so this package
  supersedes attempt 5 without a red against it.
- **Attempt 6** (18:44–20:08 for the runs, reproductions 20:27, this package)
  ran the six lanes at the main tree's `HEAD` with the freeze aborting on any
  identity mismatch, and the native groups on the same two containers, up since
  12:58. It took attempt 5's two lessons up front: the source-cost census was
  measured in the lane-5 worktree in the first place rather than crashing in the
  main tree, and the sequencer re-ran the CLI self-test alone after the campaigns
  when the first attempt came back red.

Attempts 1, 2 and 4 are kept whole and unrelabelled at
`../qualified-attempt-{1,2,4}-stale-identity/`; attempt 3's files were moved to
`/private/tmp/viborm-g4-qualified-previous-123127/` and attempt 5's to
`/private/tmp/viborm-g4-qualified-previous-184446/`, and both live in commits
(`0f25637b` and `ff5e77ca`). None contributes a count here. `README.md` states
what each found.

## Validation

- **Fixed modes.** All 65 registered fixed modes passed, **1,751 test
  executions**, zero failures. That includes the 19 G4 modes (591 tests) — among
  them `g4-unit01-review` (200 tests), `g4-unit02-author` (136, now carrying
  performance pass 2's new pin `prepared-projection-reuse.test.ts`) and
  `g4-read-contracts` (62) — and pass 1's pin
  `prepared-statement-stability.test.ts`. The five added cells are the whole
  difference from attempt 5's 1,746. One further fixed mode, `g0`, was also run
  inside campaign lane 5 (5 files / 33 tests, `campaigns/g0.receipt`); it is
  recorded separately and never counted as campaign cells.
- **Credential-free selectors.** The aggregate selector passed 65 files / 758
  tests; the PGlite provider selector passed 5 files / 11 tests. Both are
  log-only: their launchers print selection and resource lines but write no JSON
  identity companion, and `selector-launch-provenance.json` says so rather than
  claiming the logs embed the identity.
- **Native providers.** All current native modes passed on the task-owned
  loopback containers: PostgreSQL 12 modes / 64 tests on `127.0.0.1:55729` and
  MySQL 11 modes / 69 tests on `127.0.0.1:55730` (`support/provider-ports.json`,
  captured by the packaging step — see "Outcome"). This includes the inherited
  `g2-mysql-contracts` 13/13, whose unique-race regression was the condition for
  starting qualification at all.
- **Campaigns.** All 15 campaigns passed: **265,000 cells, 795,000 exact
  replays, zero skips**. The four G4 campaigns are 250 children each on disjoint
  fresh ranges — `g4-seeds` 20000–44999 and `g4-transport-seeds` 50000–74999
  (the read campaign, two profiles each), `g4-write-seeds` 75000–99999 and
  `g4-write-transport-seeds` 100000–124999 (the accepted G3 write generator on
  seeds no child has run). The eleven inherited campaigns reran their own
  registered ranges on the frozen identity because the source under them changed.
- **Replays.** Seven current corpora replayed green through the `replay` gate
  (both write families, both G3 families, all three CS-03 extensions). Nine
  G3-era inputs were refused with the required stale-identity sentence. The two
  G4 read families are reproduced by re-running their own child command rather
  than through `replay` — see "The G4 read corpora" below — and both re-runs
  passed 200 cells / 600 replays / zero skips and produced corpora
  **byte-identical** to the retained child archives they reproduce.
- **Structural measurement.** 28 cases / 60 same-build replays / zero skips,
  `qualifying: true`, alternative `shared-occurrence-candidate`, profiles
  `construction-only` / `sqlite-interactive` / `sqlite-atomic-batch`, run in an
  isolated worktree (lane 5, reused after its campaigns). The receipt's
  `baseIdentity` is the freeze and its `instrumentedIdentity` is `a8ac7987…`.
  Reversing the instrumentation restored both touched file hashes
  (`structure/uninstrumented-files.sha256` equals
  `structure/reversed-files.sha256`, and both match
  `support/frozen-identity-manifest.json`) and the complete production/harness
  identity (`structure/reversed-identity.json`).
- **Support checks.** Driver integration passed 2 files / 16 tests. Receipt
  self-tests passed 39. Typecheck reported only the two historical Pattern
  TS2345 diagnostics at `src/query-engine/pattern/pack.ts:1443` and `:2633`;
  there was no new diagnostic — which is the pass-2 review's one must-fix,
  re-checked here on the frozen tree. The CLI self-test passed 10 of 10 on the
  run that is counted. `support/query-engine-structure.log` (the
  whole-query-engine census) exited 0.
- **Source cost.** The charged perimeter measured on this identity is **171
  files / 2,518,074 bytes / 71,146 physical lines / 53,890 token-lines**, with a
  147-file / 47,710-token-line navigation subtotal
  (`support/source-cost.json`, census owner `scripts/query-engine-structure.mjs`,
  census function SHA-256 `15889231…`). That perimeter is the **shipped** code —
  the denominator — not the candidate's own cost: this accounting classifies 35
  files as `excluded-experiment` (22,610 token-lines), 15 of them the
  candidate's own `src/query-engine/raptor3/**` (10,510) and 20 the Pattern and
  builder experiment.
- **Corpus integrity.** A streaming audit restored and hashed every one of the
  **1,320** retained gzip corpora: **53,959,470,288 original bytes from
  1,048,570,233 archive bytes**, each checked against its own descriptor for
  archive bytes, archive hash, restored bytes and restored hash, with each
  family's retained seed sequence proved against its parent campaign manifest.
  The runner had already archived 1,200 of them (the G3 and G4 families); this
  package re-proved those rather than trusting their descriptors, and compressed
  the remaining 120 (G1 and G2 children) itself, unlinking a raw corpus only
  after its restore was proven. Nine replay inputs were compressed the same way:
  300,021,900 bytes to 5,953,013. Retention ran in `--move` mode: a lane's copy
  of a child receipt was removed only after the retained bytes and SHA-256 had
  been re-proved, and nothing that failed to verify was removed.
- **Source.** `source-allowlist.json` lists **12 task files (6 tracked, 6
  untracked)** and `source.patch` (83,394 bytes) carries the tracked diff against
  `ff5e77ca` followed by a `--no-index` new-file diff for each untracked file.
  The patch was proved to describe this exact tree by reverse-applying it
  (`git apply --check -R`, which writes nothing).
  `support/frozen-identity-manifest.json` is the per-file manifest of all 1,085
  identity inputs (587 production, 504 harness) and re-derives both fingerprints.

## The two runs that were taken twice

**1. CLI self-test: 9 of 10 → 10 of 10.** The cell "the outer watchdog
terminates a public call awaiting a queued provider reply" asserted on the
sentence `G1 nontermination: public operation awaits queued provider reply` and
saw only the Vitest banner after 18.46 s. It ran between 19:19 and 19:28, while
all six campaign lanes were live: the cell is a watchdog race against a real
process reaching its wait. This attempt's sequencer does not argue about that —
it re-runs the file alone when the first attempt is red, which it did after the
campaigns:

```sh
node scripts/run-node-safe.mjs --rss-limit-mb=1536 768 600000 scripts/raptor3-cli.test.mjs
```

All ten cells passed (`support/cli-selftest.log`): 234.63 s wall, 213.8 MiB peak
sampled process-group RSS against the same 1,536 MiB ceiling, teardown verified.
The cell in question took **10.78 s**, against 18.46 s when it failed under lane
load. The whole file took 234.6 s here and 494.1 s of test time under the lanes
— the load itself, measured. The 9-of-10 log is kept as
`support/cli-selftest.attempt1-red.log`. Attempt 5 saw exactly the same cell fail
at 17.99 s and pass at 10.46 s alone; this is the third measurement of the same
behaviour.

**2. Structural measurement: refused → green.** The first run in lane 5 (20:04)
failed inside `cs02-structure-measure.test.ts:1215`, where the measurement
receipt is parsed:

```
ZodError: [{ "code": "unrecognized_keys", "keys": ["capturedAt"],
             "path": ["baseIdentity"], "message": "Unrecognized key: \"capturedAt\"" }]
```

The cause is entirely outside the candidate: the integrator had annotated
`g4/freeze/identity.json` with a capture timestamp so that two concurrently
running agents could check the freeze's freshness, and that file is what
`VIBORM_RAPTOR3_MEASUREMENT_BASE_IDENTITY` points at — parsed with a strict
schema that admits exactly `production`, `harness` and `runtime`. **The
fingerprints never moved** (production `312cde34…`, harness `1d4d913c…`, the
same pair as every other receipt in this package). The annotation was removed
and the group was re-run in lane 5 at 20:06: green, 28 cases / 60 replays / 0
skipped, instrumentation reversed and the identity restored. The refused first
attempt is kept whole as `structure-attempt1-red-tooling/` — its own
`run.log`, `FAILURES.log`, patch, hashes and partial receipt — and is counted
nowhere. This package's `support/final-identity.json` is byte-identical to the
corrected `g4/freeze/identity.json`, and `reproduction.md` states the constraint
so that the next run of this file does not rediscover it.

## The G4 read corpora

A G4 read child corpus carries the campaign subject (`candidate` / `shipped`),
and the generic `replay` gate's corpus schema rejects unknown keys, so
`replay <g4 read corpus>` fails with `unrecognized_keys: subject`. That is the
runner's own design, not a defect the package is explaining away: the G4 read
family's archive descriptor names `g4-seed-batch <seed> --subject=candidate` as
its reproduction command, precisely because a read corpus names a subject and a
`replay` would not re-run the subject it was recorded on.

The two attempts made with the `replay` spelling are kept exactly as they ran,
renamed to `replays/receipts/g4-seeds-20000.not-a-replay-input.receipt` and
`…/g4-transport-seeds-50000.not-a-replay-input.receipt` with their logs;
`replays/NOTE.md` is the classification, and the index makes it from the gate's
own `unrecognized_keys` / `subject` sentence rather than from the file name, so
a receipt without that sentence would stay a red. `replays/FAILURES.log` still
records both as the driver wrote it.

The two correct reproductions ran at 20:27, after the cutover timing series, and
are `replays/receipts/g4-seed-batch-20000.receipt` and
`…/g4-transport-seed-batch-50000.receipt`. Each re-executed 200 cells / 600
replays / zero skips on the frozen identity and emitted a corpus whose bytes and
SHA-256 equal the retained child archive's `originalBytes` / `originalSha256`
(`support/reproduction-packaging.json`). So for those two children the claim is
not only "the archive restores" but "the archive's contents are what re-running
the child produces".

## What the source-cost census says about pass 2

`support/source-cost.json` has status `source-accounted-bundle-pending`: the
source accounting is complete and the bundle half is not attempted (`bundles`
and `declarationBytes` are `null`).

| `accounting` | files | bytes | physical | token-lines |
| --- | --- | --- | --- | --- |
| **charged (shipped perimeter)** | **171** | **2,518,074** | **71,146** | **53,890** |
| navigation subtotal | 147 | 2,201,864 | 62,274 | 47,710 |

The `charged` row is **identical, field for field, to attempt 5's**, which is
what must happen when a performance pass touches only `excluded-experiment`
files. Exactly four per-file entries differ from attempt 5's census, and they
are exactly the four production files pass 2 changed:

| file | attempt 5 | attempt 6 | Δ |
| --- | --- | --- | --- |
| `raptor3/shared/operation-context.ts` | 1,898 | 1,919 | +21 |
| `raptor3/shared/query.ts` | 3,572 | 3,592 | +20 |
| `raptor3/shared/schema.ts` | 411 | 433 | +22 |
| `raptor3/shared/transport-attempt.ts` | 16 | 41 | +25 |
| **total** | **5,897** | **5,985** | **+88** |

The pass-2 author and reviewer both measured **+82** charged token-lines on
their own 181-file whole-query-engine census. This package does not reconcile
the six-token-line difference between the two walks and does not adopt either as
the other's confirmation: **+88** is what this tool measured here, on the frozen
bytes, and it is the number this package stands behind. The candidate's own
complete charged total is still root review D's measurement on a predecessor
tree and was not re-measured here.

## Not in this package

**No performance evidence.** The §3 performance series (20 frozen cells, five
alternating fresh-process pairs per cell, 5 % time and 10 % peak-memory budgets)
is not part of the author qualification tree and no receipt of it is claimed
here; its receipts live under `../cutover/`. Arnaud's D-9 decision accepted the
candidate's remaining preparation cost, and the series on this identity is the
record of what was accepted — it is a separate artefact. This package's own runs
were sequenced around it: the two read-child reproductions ran after the series
finished, so the series measured a quiet machine and the reproductions did not
compete with it.

## Claim boundaries

- **Source cost only, and only its source half.** `support/source-cost.json` is
  this attempt's own measurement on the frozen identity — charged perimeter
  **171 files / 2,518,074 bytes / 71,146 physical lines / 53,890 token-lines**.
  Its status is `source-accounted-bundle-pending`: `bundles` and
  `declarationBytes` are `null`, so it establishes **no** runtime, allocation,
  bundle or package-size result. It is also the **shipped** perimeter, the
  denominator; the candidate's own complete charged total is still root review
  D's measurement on a predecessor tree and was not re-measured here.
- **Native suites.** The PostgreSQL and MySQL results are the current-source
  modes on the two task-owned loopback containers recorded in
  `support/provider-ports.json`. They are not a claim about any other provider
  version, build or deployment.
- **Read campaign profiles.** The four G4 read profile names are backed by the
  transport model each cell actually exhibits, checked per child; the names alone
  are not the claim.
- **Write campaign.** `g4-write-seeds` and `g4-write-transport-seeds` are the
  accepted G3 write generator on fresh disjoint ranges. They are new inputs, not
  a new generator, and they are not a second qualification of the G3 envelope.
- **Acceptance.** Independent and root review attestations are external to this
  sealed author tree; nothing here is an acceptance.

## Risks

- Re-execution is proven for six of the 1,320 retained children — the first
  child of each of the four seeded families that has a replayable corpus, plus
  the two G4 read reproductions — and for the three CS-03 parent corpora, which
  are not among the 1,320. Every other retained corpus is proven to restore to
  its exact recorded bytes; that is a weaker claim than re-execution and is all
  the audit asserts.
- The CLI self-test's watchdog cell is timing-sensitive by construction: across
  three attempts it has passed at 10.46 s and 10.78 s alone and failed at 17.99 s
  and 18.46 s under six live campaign lanes. The sequencer now re-runs it alone
  rather than classifying it, but the cell will fail again on a loaded machine,
  and a future run of this file is only evidence if the machine is quiet.
- `scripts/measure-raptor3-baseline.mjs` still dies with `spawnSync git ENOBUFS`
  in the main tree; the measurement here was obtained by running the unmodified
  tool in the lane-5 worktree, whose own status output is small, not by fixing
  the tool. The one-option `maxBuffer` fix is still owed by the harness owner,
  and until it lands this measurement is not reproducible in the main tree as it
  stands.
- The charged perimeter is measured first-party for the **shipped** side only,
  and its pass-2 delta (+88 token-lines) does not equal the +82 the pass-2 author
  and reviewer measured on their own walk. Six token-lines are unreconciled
  between two censuses of the same four files.
- `support/provider-ports.json` is the packaging step's capture, not the
  driver's. Continuous container uptime across both native groups is proved from
  `State.StartedAt` plus the containers still running, which is strong but is
  not the same as a port read taken at each group's own start; the driver's own
  per-group read is only in the runner's environment, not in a receipt.
- Free disk was 27 GiB when retention began and 28 GiB when it ended (the lane
  copies were released), against 48 GiB at the same point of attempt 5. Disk was
  tight but never a constraint; nothing was deleted that had not verified first.
- Five earlier attempts preceded this identity: two found reds, two passed and
  were superseded by deliberate performance changes, one aborted on tooling.
  That is the process working, but it means the current identity is young: it
  has one full pass behind it, and pass 2's own production change is four files
  old.
- Review attestations must stay outside the sealed checksum tree so that they do
  not rewrite the author evidence they assess.
