# G4 author qualification

## Outcome

The author qualification evidence is frozen on production
`2e92354bafaaccb7cab5f54041992b552664a7865fb69370be70ebccb63a1975`, harness
`31c2883fd742dbea69896430543a85a9eace96719b9f24f9358593b54ff3a66a`, baseline
commit `0f25637b`, and Node 24.21.0 — the performance-pass identity. Every
qualifying mode, campaign, replay and the structural measurement passed on that
identity.

Two support checks did not pass at the first seal (16:15) — the CLI self-test
was 9 of 10 and the source-cost measurement had died before writing its JSON —
and the index said so with the status
`author-qualification-evidence-incomplete-see-gaps`. **Both were re-run at
16:17–16:21 on the unchanged frozen tree and both are green**, so this seal's
index status is
`author-qualification-evidence-complete-independent-and-root-acceptance-pending`
and its `gaps` list is empty:

1. `support/cli-selftest.log` — the CLI self-test is **10 of 10** (240.41 s
   wall, 211.0 MiB peak RSS), re-run alone in the main tree on the quiet
   machine. The 9-of-10 first attempt is kept whole beside it as
   `support/cli-selftest.attempt1-red.log`.
2. `support/source-cost.json` — the source-cost measurement **exited 0** in the
   lane-5 worktree, whose identity and whose every censused byte are proved
   equal to the freeze. The `spawnSync git ENOBUFS` crash of the first attempt
   is kept whole as `support/source-cost.attempt1-enobufs.log`.

`support/RERUN.md` records exactly what was re-run, where, when and why, and
`support/verify-rerun-receipts.mjs` re-derives the identity checks into
`support/rerun-verification.json`. Nothing in the qualifying evidence was
re-run or rewritten: the pinned totals are unchanged and still assert.

Independent and root acceptance are not part of this author package.

Every count in this report is derived from the receipts in this tree by
`support/build-qualification-index.mjs` and then pinned in that script, so a
later change to a receipt fails the build rather than quietly moving a number.

This is the fifth qualification attempt.

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
  and committed inside `0f25637b`. Arnaud then ordered the performance pass
  (lazy control-flow errors, stable SQL aliases, small allocation trims), which
  moved the identity again, so this package supersedes attempt 3 without a red
  against it.
- **Attempt 4** (12:31–12:35) aborted at launch, tooling only: after the commit
  the six lanes were still checked out at `0cc61e61`, so the delta sync no
  longer carried the committed G4 files and every campaign parent failed in
  seconds; Docker Desktop was found stopped at the same time. Freeze 4 is void —
  it produced no receipt on a frozen identity.
- **Attempt 5** (12:47–14:06, this package) ran the six lanes at the main tree's
  `HEAD` with the freeze aborting on any identity mismatch, and the native
  groups on the two containers Docker restarted at 12:58.

Attempts 1, 2 and 4 are kept whole and unrelabelled at
`../qualified-attempt-{1,2,4}-stale-identity/`; attempt 3 lives in commit
`0f25637b` and its files were moved to
`/private/tmp/viborm-g4-qualified-previous-123127/`. None contributes a count
here. `README.md` states what each found.

## Validation

- **Fixed modes.** All 65 registered fixed modes passed, 1,746 test executions,
  zero failures. That includes the 19 G4 modes — among them `g4-unit01-review`
  (200 tests), `g4-unit02-author` (131) and `g4-read-contracts` (62) — and the
  performance pass's new pin
  `prepared-statement-stability.test.ts`. One further fixed mode, `g0`, was also
  run inside campaign lane 5 (5 files / 33 tests, `campaigns/g0.receipt`); it is
  recorded separately and never counted as campaign cells.
- **Credential-free selectors.** The aggregate selector passed 65 files / 758
  tests; the PGlite provider selector passed 5 files / 11 tests. Both are
  log-only: their launchers print selection and resource lines but write no JSON
  identity companion, and `selector-launch-provenance.json` says so rather than
  claiming the logs embed the identity.
- **Native providers.** All current native modes passed on the task-owned
  loopback containers: PostgreSQL 12 modes / 64 tests on `127.0.0.1:55729` and
  MySQL 11 modes / 69 tests on `127.0.0.1:55730`. Both host ports are new for
  this attempt — Docker Desktop was found stopped at 12:24 and both containers
  were started again at 12:58 with re-initialised tmpfs data
  (`support/provider-ports.json`). This includes the inherited
  `g2-mysql-contracts` 13/13, whose unique-race regression was the condition for
  starting qualification at all.
- **Campaigns.** All 15 campaigns passed: 265,000 cells, 795,000 exact replays,
  zero skips. The four G4 campaigns are 250 children each on disjoint fresh
  ranges — `g4-seeds` 20000–44999 and `g4-transport-seeds` 50000–74999 (the read
  campaign, two profiles each), `g4-write-seeds` 75000–99999 and
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
  `qualifying: true`, alternative `shared-occurrence-candidate`, run in an
  isolated worktree (lane 5, reused after its campaigns). Reversing the
  instrumentation restored both touched file hashes
  (`structure/uninstrumented-files.sha256` equals
  `structure/reversed-files.sha256`, and both match the file hashes in
  `source-allowlist.json`) and the complete production/harness identity
  (`structure/reversed-identity.json`).
- **Support checks.** Driver integration passed 2 files / 16 tests. Receipt
  self-tests passed 39. Typecheck reported only the two historical Pattern
  TS2345 diagnostics at `src/query-engine/pattern/pack.ts:1443` and `:2633`;
  there was no new diagnostic. The CLI self-test passed 10 of 10 on its re-run,
  and the source-cost measurement produced `support/source-cost.json` on its
  re-run; both are detailed below under "The two gaps, closed".
- **Source cost.** The charged perimeter measured on this identity is **171
  files / 2,518,074 bytes / 71,146 physical lines / 53,890 token-lines**, with a
  147-file / 47,710-token-line navigation subtotal
  (`support/source-cost.json`, census owner `scripts/query-engine-structure.mjs`,
  census function SHA-256 `15889231…`). That perimeter is the **shipped** code —
  the denominator — not the candidate's own cost: this accounting classifies
  `src/query-engine/raptor3/**` as `excluded-experiment` (35 files, 22,522
  token-lines).
- **Corpus integrity.** A streaming audit restored and hashed every one of the
  1,320 retained gzip corpora: **53,981,235,232 original bytes from
  1,049,645,275 archive bytes**, each checked against its own descriptor for
  archive bytes, archive hash, restored bytes and restored hash, with each
  family's retained seed sequence proved against its parent campaign manifest.
  The runner had already archived 1,200 of them (the G3 and G4 families); this
  package re-proved those rather than trusting their descriptors, and compressed
  the remaining 120 (G1 and G2 children) itself, unlinking a raw corpus only
  after its restore was proven. Nine replay inputs were compressed the same way:
  300,134,755 bytes to 5,961,396. Retention ran in `--move` mode: a lane's copy
  of a child receipt was removed only after the retained copy's bytes and
  SHA-256 had been re-proved, and nothing that failed to verify was removed.
- **Source.** `source-allowlist.json` lists 20 task files (15 tracked, 5
  untracked) and `source.patch` (85,771 bytes) carries the tracked diff against
  `0f25637b` followed by a `--no-index` new-file diff for each untracked file.
  The patch was proved to describe this exact tree by reverse-applying it
  (`git apply --check -R`, which writes nothing).
  `support/frozen-identity-manifest.json` is the per-file manifest of all 1,079
  identity inputs and re-derives both fingerprints.

## The two gaps, closed

Both gaps were support checks, both were re-run at 16:17–16:21 on the unchanged
frozen tree, and both are green. The red first attempts are kept whole beside
the new receipts rather than replaced. `support/rerun-RUN.log` is the
integrator's own record of the two runs with their exit codes and times, and
`support/RERUN.md` is the full account.

**1. CLI self-test: 9 of 10 → 10 of 10.** The cell "the outer watchdog
terminates a public call awaiting a queued provider reply" asserted on the
sentence `G1 nontermination: public operation awaits queued provider reply` and
saw only the Vitest banner after 17.99 s. It ran between 13:18 and 13:26, while
all six campaign lanes were live: the cell is a watchdog race against a real
process reaching its wait. The packaging classified that as machine load but did
not re-run it, because the cutover timing series owned the machine. The series
finished at 16:04, so the file was re-run alone in the main tree at 16:17–16:21:

```sh
node scripts/run-node-safe.mjs --rss-limit-mb=1536 768 600000 scripts/raptor3-cli.test.mjs
```

All ten cells passed (`support/cli-selftest.log`): 239.9 s of test time, 240.41 s
wall, 211.0 MiB peak sampled process-group RSS against the same 1,536 MiB
ceiling, teardown verified. The cell in question took **10.46 s**, against
17.99 s when it failed under lane load and 16.66 s when it passed on attempt 3.
The whole file took 240.41 s wall here and 460.04 s at 13:26 — the load itself,
measured. The 9-of-10 log is kept as `support/cli-selftest.attempt1-red.log`.
The classification was correct, and it is now settled by a run rather than by an
argument.

**2. `support/source-cost.json`: absent → measured.**
`scripts/measure-raptor3-baseline.mjs` had died with `spawnSync git ENOBUFS`
(`support/source-cost.attempt1-enobufs.log`): its
`execFileSync("git", ["status", "--porcelain"])` at line 318 returns over 1.2 MB
in the main tree — past Node's default 1 MiB `maxBuffer` — because the working
tree carries the removal of the previous sealed package plus this package's own
files. That defect is untouched: the tool was **not** patched, and the one-option
fix still belongs to the harness owner. Instead the measurement was re-run at
16:17 in the lane-5 worktree, whose own status output is small:

```sh
cd /private/tmp/viborm-g4-lane-5
TMPDIR=/private/tmp/viborm-g4-lane-tmp-5 node scripts/measure-raptor3-baseline.mjs --output …/source-cost.json
```

It exited 0 in two seconds. Measuring in another worktree is only sound if the
bytes read are the frozen bytes, and that is checked twice
(`support/verify-rerun-receipts.mjs` → `support/rerun-verification.json`):
lane 5's own `captureRaptor3Identity()` equals `g4/freeze/identity.json`
(`support/rerun-lane5-identity.json`; the integrator verified the same at 16:18),
and **all 581 files the census actually read appear in
`support/frozen-identity-manifest.json` with the identical SHA-256** — 0 outside
the identity, 0 differing from the freeze. `source.commit` is `0f25637b` and
`source.clean` is `false`, exactly as in the main tree, and `source.clean` is the
only value the failed call fed.

**The charged perimeter, now measured first-party.** `support/source-cost.json`
has status `source-accounted-bundle-pending`: the source accounting is complete
and the bundle half is not attempted (`bundles` and `declarationBytes` are
`null`).

| `accounting` | files | bytes | physical | token-lines |
| --- | --- | --- | --- | --- |
| **charged (shipped perimeter)** | **171** | **2,518,074** | **71,146** | **53,890** |
| navigation subtotal | 147 | 2,201,864 | 62,274 | 47,710 |

The perimeter is the shipped code the candidate must replace, not the
candidate's own cost: `src/query-engine/raptor3/**` is `excluded-experiment` (35
files, 22,522 token-lines) in this accounting. Two cross-checks come with it.
The `charged` row reproduces attempt 3's census field for field, which is what
must happen when the performance pass touched only excluded files; and exactly
seven per-file entries differ from attempt 3's — the seven performance-pass
`raptor3/*.ts` files, 8,878 → 8,900 token-lines, **+22** — which is the same +22
the performance review measured independently on the 181-file whole-query-engine
census (`../perf-review-followup.md` note 6).

Root review D used 53,787 token-lines / 70,983 physical / 2,511,682 bytes as its
denominator, measured by that review's own walk, and put the complete charged
candidate at 27.3 % / 25.9 % / 26.1 %. Against this tool's measured perimeter the
same candidate totals (14,680 / 18,378 / 655,283) are **27.2 % / 25.8 % /
26.0 %**, inside the ≤ 60 % token and ≤ 70 % physical targets. This package
states its own measured denominator and does not reconcile the 103-token-line
difference between the two walks; the numerator is still D's, measured on the
predecessor tree, and no candidate perimeter was re-measured here.
`support/query-engine-structure.log` (the whole-query-engine census, exit 0 —
181 files, 68,628 token-lines) is unchanged and remains the other structural
number this attempt carries.

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

The two correct reproductions ran at 16:04, after the cutover timing series, and
are `replays/receipts/g4-seed-batch-20000.receipt` and
`…/g4-transport-seed-batch-50000.receipt`. Each re-executed 200 cells / 600
replays / zero skips on the frozen identity and emitted a corpus whose bytes and
SHA-256 equal the retained child archive's `originalBytes` / `originalSha256`
(`support/reproduction-packaging.json`). So for those two children the claim is
not only "the archive restores" but "the archive's contents are what re-running
the child produces".

## Not in this package

**No performance evidence.** The §3 performance series (20 frozen cells, five
alternating fresh-process pairs per cell, 5 % time and 10 % peak-memory budgets)
is not part of the author qualification tree and no receipt of it is claimed
here; its receipts live under `../cutover/`. This package's own runs were
sequenced around it — the replays, the structural measurement and the two read-
child reproductions ran outside the timing window — so that the series measured
a quiet machine.

## Claim boundaries

- **Source cost only, and only its source half.** `support/source-cost.json` is
  this attempt's own measurement on the frozen identity — charged perimeter
  **171 files / 2,518,074 bytes / 71,146 physical lines / 53,890 token-lines**,
  navigation subtotal 147 files / 47,710 token-lines. Its status is
  `source-accounted-bundle-pending`: `bundles` and `declarationBytes` are
  `null`, so it establishes **no** runtime, allocation, bundle or package-size
  result. It is also the **shipped** perimeter, the denominator; the candidate's
  own complete charged total (14,680 token-lines) is still root review D's
  measurement on the predecessor tree and was not re-measured here.
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
- The CLI self-test's watchdog cell is timing-sensitive by construction: it
  passed in 10.46 s alone, failed at 17.99 s under six live campaign lanes and
  passed at 16.66 s on attempt 3. The classification held, but the cell will fail
  again on a loaded machine, and a future run of this file is only evidence if
  the machine is quiet.
- `scripts/measure-raptor3-baseline.mjs` still dies with `spawnSync git ENOBUFS`
  in the main tree; the measurement here was obtained by running the unmodified
  tool in a worktree with a small status output, not by fixing the tool. The
  one-option `maxBuffer` fix is still owed by the harness owner, and until it
  lands this measurement is not reproducible in the main tree as it stands.
- The charged perimeter is measured first-party for the **shipped** side only.
  The candidate numerator (14,680 token-lines) is root review D's, measured on
  the predecessor tree by a different walk whose denominator was 53,787 rather
  than the 53,890 measured here; the 103-token-line difference between the two
  walks is unreconciled, and the ratios above mix the two sources.
- Free disk was 48 GiB when retention began and 50 GiB when it ended (the lane
  copies were released), against 4.7 GiB at the same point of attempt 3. Disk
  was not a constraint this time.
- Four earlier attempts preceded this identity: two found reds, one passed and
  was superseded by a deliberate performance change, one aborted on tooling.
  That is the process working, but it means the current identity is young: it
  has one full pass behind it.
- Review attestations must stay outside the sealed checksum tree so that they do
  not rewrite the author evidence they assess.
