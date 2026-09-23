# G4 qualification reproduction (performance-pass-2 identity)

Run from `/Users/arnaud/code/viborm` with `source.patch` applied to baseline
commit `ff5e77ca5f37e747d45460b588b573b72790f1b8` — the committed pass-1 tree.
Keep validation serial inside each worktree and use the existing resource lock
and ceilings.

```sh
RAPTOR_NODE_BIN=/Users/arnaud/.vite-plus/js_runtime/node/24.21.0/bin
PATH="$RAPTOR_NODE_BIN:$PATH"
NODE="$RAPTOR_NODE_BIN/node"
```

The patch is applied as a whole: the tracked half is an ordinary
`git diff --binary` against the baseline, the untracked half is a sequence of
`git diff --no-index --binary` new-file diffs, so one `git apply` reproduces
both. It carries only performance pass 2's twelve source and harness files; the
evidence half of the task file set is listed in `task-commit-allowlist.json` and
is never patched.

```sh
git checkout ff5e77ca5f37e747d45460b588b573b72790f1b8
git apply source.patch
```

Before accepting a receipt, compare its identity with
`support/final-identity.json` (production
`312cde34932cdb4d70ccad60bb002d0c0a438865bd18e165c38b4a572ebff640`, harness
`1d4d913c4f686d7aa0871dde7f8af2c6049a674db2595c54a52b7f66491f2f9e`). Every
receipt in this package was produced on that exact pair; a receipt with any
other identity is not this qualification's evidence.
`support/frozen-identity-manifest.json` re-derives both fingerprints from the
1,085 files `captureRaptor3Identity` hashes.

`g4/freeze/identity.json` carries exactly those three keys — `production`,
`harness`, `runtime`. It must not carry anything else: `cs02-structure-measure`
parses that file with a strict schema, and an added key makes the structural
measurement refuse (see "The two runs that were taken twice" below).

## Modes

Run each mode listed by `qualification-index.json`:

```sh
$NODE scripts/run-raptor3.mjs <fixed-or-native-mode>
$NODE scripts/run-raptor3.mjs <campaign-mode>
$NODE scripts/run-raptor3.mjs replay <retained-corpus.json>
```

The main tree runs, serially, every fixed mode (18:44–19:07), then the native
PostgreSQL (19:10–19:15) and MySQL (19:15–19:22) groups, each preceded by the
E-1 stale-world drop, then the support checks (19:22–19:32). The replays and
the structural measurement run after every lane and the main chain have exited.

## The six campaign lanes

The campaigns are the only part that runs in parallel, and they are parallel by
isolation rather than by sharing: each lane is its own worktree with its own
`TMPDIR`, so each lane takes the workspace lock inside its own tree and no two
lanes contend for one lock, one temporary directory, or one set of child
receipt paths.

| Lane | Worktree | `TMPDIR` | Modes |
| --- | --- | --- | --- |
| 1 | `/private/tmp/viborm-g4-lane-1` | `/private/tmp/viborm-g4-lane-tmp-1` | `g4-seeds` |
| 2 | `/private/tmp/viborm-g4-lane-2` | `/private/tmp/viborm-g4-lane-tmp-2` | `g4-transport-seeds` |
| 3 | `/private/tmp/viborm-g4-lane-3` | `/private/tmp/viborm-g4-lane-tmp-3` | `g4-write-seeds` |
| 4 | `/private/tmp/viborm-g4-lane-4` | `/private/tmp/viborm-g4-lane-tmp-4` | `g4-write-transport-seeds` |
| 5 | `/private/tmp/viborm-g4-lane-5` | `/private/tmp/viborm-g4-lane-tmp-5` | `g3-seeds`, `g2-seeds`, `g1-seeds`, `g0`, `g3p06-seeds`, `cs03-extension-a-seeds` |
| 6 | `/private/tmp/viborm-g4-lane-6` | `/private/tmp/viborm-g4-lane-tmp-6` | `g3-transport-seeds`, `g2-transport-seeds`, `g1-transport-seeds`, `g3p06-transport-seeds`, `cs03-extension-b-seeds`, `cs03-extension-composition-seeds` |

Each lane is a clean worktree checked out at the main tree's `HEAD` and then
synced with the frozen task deltas, and its identity is proved equal to the main
tree's before any mode runs:

```sh
git worktree add /private/tmp/viborm-g4-lane-N
mkdir -p /private/tmp/viborm-g4-lane-tmp-N
cd /private/tmp/viborm-g4-lane-N
git checkout --detach "$(git -C /Users/arnaud/code/viborm rev-parse HEAD)"
git checkout -- . && git clean -fd -- src tests scripts benchmarks vitest.workspace.ts
# copy the dirty task file set from the main tree, then:
$NODE -e 'import("./scripts/raptor3-manifest.mjs").then(async m=>console.log(JSON.stringify(await m.captureRaptor3Identity())))'
TMPDIR=/private/tmp/viborm-g4-lane-tmp-N $NODE scripts/run-raptor3.mjs <campaign-mode>
```

The checkout-then-sync order matters: qualification attempt 4 was aborted at
launch because the lanes were still at `0cc61e61` after the G4 commit, so the
delta sync no longer carried the committed files. The sync now checks each lane
out at the main tree's `HEAD` first and the launcher aborts on any identity
mismatch.

A campaign writes its parent receipt into its own `TMPDIR` and one child receipt
directory per batch beside it. `campaigns/<mode>.receipt/verified.json` names
every child directory it produced; those are the paths the packaging step reads.

The four G4 campaigns are 250 children each, 100 seeds per child, two profiles
per campaign and three replays per cell:

| Campaign | Seeds | Profiles |
| --- | --- | --- |
| `g4-seeds` | 20000–44999 | `sqlite-interactive`, `sqlite-atomic-batch` |
| `g4-transport-seeds` | 50000–74999 | `scripted-returning-weak`, `scripted-returning-ack` |
| `g4-write-seeds` | 75000–99999 | `sqlite-interactive`, `sqlite-atomic-batch` |
| `g4-write-transport-seeds` | 100000–124999 | `scripted-returning-weak`, `scripted-returning-ack` |

The inherited campaigns rerun their own registered ranges on the frozen
identity, because the source under them changed. The lanes ran 18:44–20:02:
lanes 5 and 6 finished their six-mode chains at 19:41 and 19:40, the four G4
families at 19:52–20:02.

A lane that finds a stale workspace lock in its own `TMPDIR` refuses rather than
running. A mode whose log still says `Test command refused` after the refused-mode
re-runs is recorded as **refused**, not as a failure — it produced no test result
either way. No mode was refused in this attempt (`rerun.log`).

## Native providers

Native evidence used the task-owned loopback containers on **PostgreSQL
`127.0.0.1:55729`** and **MySQL `127.0.0.1:55730`**. Both containers have been
running since 12:58 on 2026-09-16 and were still up when their record was taken,
so they were up continuously across both native groups; their identities, ports,
memory, CPU and tmpfs limits are in `support/provider-ports.json`, which the
packaging step captured from `docker inspect` after the native groups (the
driver did not write it this time, and the record says so rather than repeating
the previous package's numbers). The driver reads the port per group and passes
it to the runner:

```sh
PG_PORT=$(docker port viborm-raptor3-g3-pg-20260914 5432 | head -1 | cut -d: -f2)
MY_PORT=$(docker port viborm-raptor3-g3-mysql-20260914 3306 | head -1 | cut -d: -f2)
VIBORM_RAPTOR3_PROVIDER_PORT=$PG_PORT $NODE scripts/run-raptor3.mjs <pg-mode>
VIBORM_RAPTOR3_PROVIDER_PORT=$MY_PORT $NODE scripts/run-raptor3.mjs <mysql-mode>
```

Supply credentials only through the existing local fixture environment; never
copy them into evidence or commands.

### E-1 stale-world drop (before each native group)

`runLiveWorld` creates one `r3_<uuid>` schema (PostgreSQL) or database (MySQL)
per world inside `raptor3_g2` and by design never drops it — only the test-owned
server removes it. Left alone, accumulated worlds fill the MySQL container's
512 MiB tmpfs and every native mode then fails with "disk is full". The
qualification driver therefore drops every `r3_*` world older than ten minutes
on both providers immediately before each native group, and only when no
live-provider run is in flight. Each group's `RUN.log` opens with what that drop
removed and how full the tmpfs then was — 133 stale MySQL worlds and 70
PostgreSQL schemas before the PostgreSQL group, 84 more schemas before the MySQL
group, 211 MiB / 512 MiB and 65 MiB / 512 MiB used. The drop is an environment
step, not evidence: it never runs beside a live native mode, and it never
removes a world younger than the window, so an in-flight run cannot lose its own
schema. E-1 remains open for the harness owner; a per-world drop on success is
the one-line fix.

## Log-only selectors

The two established credential-free selectors emit bounded stdout and resource
evidence but no JSON identity companion:

```sh
$NODE scripts/run-credential-free-tests.mjs --only "Raptor 3 fixed"
$NODE scripts/run-credential-free-tests.mjs --only "raptor3-provider:"
```

Their exact command, selection, resource result, and log hash are in
`selector-launch-provenance.json`.

## Support checks

```sh
$NODE scripts/run-node-safe.mjs --rss-limit-mb=1536 768 120000 scripts/raptor3-campaign-receipts.test.mjs
$NODE scripts/run-node-safe.mjs --rss-limit-mb=1536 768 600000 scripts/raptor3-cli.test.mjs   # alone, on a quiet machine
$NODE scripts/run-typecheck.mjs
$NODE scripts/query-engine-structure.mjs
```

Run the two driver-integration files through the `layer-client` workspace
project with the 1,536 MiB RSS and 768 MiB heap limits, default plus JSON
reporters:

- `tests/contracts/public-client/statement-transforms-integration.core.test.ts`
- `tests/contracts/public-client/official-statement-instrumentation.core.test.ts`

### The source-cost census runs in lane 5, not the main tree

`scripts/measure-raptor3-baseline.mjs` calls
`execFileSync("git", ["status", "--porcelain"])` at line 318 with Node's default
1 MiB `maxBuffer`. The main tree's status output is far past that — the
moved-out previous sealed package alone shows as about 9,800 evidence deletions
— so the unmodified tool dies there with `spawnSync git ENOBUFS`. That is how
attempt 5 met it, as a gap; attempt 6's driver measures in the lane-5 worktree
in the first place, whose own status output is small. **The tool is still not
patched:** the one-option `maxBuffer` fix belongs to the harness owner, and the
number here is the frozen harness's own unmodified output.

```sh
cd /private/tmp/viborm-g4-lane-5
TMPDIR=/private/tmp/viborm-g4-lane-tmp-5 \
  $NODE scripts/measure-raptor3-baseline.mjs --output <path>/source-cost.json
```

Measuring elsewhere is sound only if the bytes read are the frozen bytes, so
check both, as `support/verify-support-receipts.mjs` does:

```sh
$NODE docs/architecture/raptor3-evidence/g4/qualified/support/verify-support-receipts.mjs
```

The worktree's own `captureRaptor3Identity()` must equal
`support/final-identity.json` (`support/source-cost-lane5-identity.json` — it
does), and every file the census read must appear in
`support/frozen-identity-manifest.json` with the identical SHA-256 — **581 of
581 do, 0 outside the identity and 0 differing from the freeze**
(`support/support-verification.json`). The result has status
`source-accounted-bundle-pending` — source accounting complete, bundle half not
attempted — with the charged perimeter at 171 files / 2,518,074 bytes / 71,146
physical lines / 53,890 token-lines. `support/source-cost.log` is the run's own
stdout and is empty by design: on success the tool writes its JSON to `--output`
and prints nothing.

## The two runs that were taken twice

Neither was a candidate failure, and both first attempts are kept whole,
unrelabelled, beside the counted runs.

**1. The CLI self-test.** Run under the six live campaign lanes it is 9 of 10:
the cell "the outer watchdog terminates a public call awaiting a queued provider
reply" is a watchdog race against a real process reaching its wait, and it saw
only the Vitest banner after 18.46 s (`support/cli-selftest.attempt1-red.log`,
494.1 s of test time). The sequencer re-ran the file **alone** after the
campaigns and it is 10 of 10 (`support/cli-selftest.log`, 234.63 s wall,
213.8 MiB peak sampled process-group RSS against the same 1,536 MiB ceiling),
with that cell taking 10.78 s. Run this file alone, on a quiet machine; a loaded
machine will fail it again.

**2. The structural measurement.** The first run refused with
`Unrecognized key: "capturedAt"` on `baseIdentity`: the integrator had annotated
`g4/freeze/identity.json` with a capture timestamp for two concurrent agents'
freshness check, and `cs02-structure-measure` parses that file with a strict
schema. The fingerprints never moved (production `312cde34…`, harness
`1d4d913c…`); the annotation was removed and the group was re-run in lane 5 at
20:06, green. The refused first attempt is kept whole as
`structure-attempt1-red-tooling/` and is counted nowhere.

## Replays

After every lane and the main chain exited, the sequencer restores the first
child corpus of each seeded family from its retained archive, checks the restored
bytes and SHA-256 against the archive descriptor, and replays it; then it replays
the three CS-03 parent corpora; then it runs all nine G3-era inputs, which must be
refused as stale.

```sh
gzip -dc campaigns/<family>/seed-<first>.receipt/generated-corpus.json.gz > replays/inputs/<name>.json
$NODE scripts/run-raptor3.mjs replay replays/inputs/<name>.json
```

The two G4 read families are reproduced by re-running their own child command
rather than through `replay` — a read corpus names the subject it was recorded
on, and the `replay` gate's corpus schema rejects that key. The sequencer ran
both under `replay` anyway; those two receipts and logs are kept, renamed
`<name>.not-a-replay-input.*` as in the previous packages, and classified from
the gate's own `unrecognized_keys` / `subject` sentence (`replays/NOTE.md`):

```sh
$NODE scripts/run-raptor3.mjs g4-seed-batch 20000 --subject=candidate
$NODE scripts/run-raptor3.mjs g4-transport-seed-batch 50000 --subject=candidate
```

Both ran in the main tree at 20:27, immediately after the cutover timing series
released the machine, and each re-executed 200 cells / 600 replays / 0 skips.
`package-corpora.mjs --reproductions` packages those two receipts and asserts
each reproduced corpus is byte-identical to the retained child archive it
reproduces, writing `support/reproduction-packaging.json`.

## Structural measurement

Make an isolated worktree at the frozen source (lane 5 is reused after its
campaigns finish), record both touched file hashes and the identity, apply
`structure/instrumentation.patch`, set the three recorded
`VIBORM_RAPTOR3_MEASUREMENT_*` variables and run `cs02-structure-measure`, then
reverse the instrumentation and compare the file hashes and the full identity
against `structure/reversed-files.sha256` and `structure/reversed-identity.json`.
Never instrument the live qualifying worktree.

```sh
PATCH=<g4>/qualified/structure/instrumentation.patch   # the same patch G3 sealed
cd /private/tmp/viborm-g4-lane-5
shasum -a 256 src/query-engine/raptor3/commands/commands.ts src/query-engine/raptor3/commands/execution.ts
git apply "$PATCH"
VIBORM_RAPTOR3_MEASUREMENT_BASE_IDENTITY=<g4>/freeze/identity.json \
VIBORM_RAPTOR3_MEASUREMENT_PATCH="$PATCH" \
VIBORM_RAPTOR3_MEASUREMENT_ALTERNATIVE=shared-occurrence-candidate \
  TMPDIR=/private/tmp/viborm-g4-structure-tmp $NODE scripts/run-raptor3.mjs cs02-structure-measure
git apply -R "$PATCH"
```

The receipt of this run is `structure/receipt/` (28 cases, 60 same-build
replays, 0 skipped, `qualifying: true`, profiles `construction-only`,
`sqlite-interactive`, `sqlite-atomic-batch`). Its `baseIdentity` is the freeze
and its `instrumentedIdentity` is `a8ac7987…` — the instrumented production
fingerprint, which is what the patch is for.
`structure/uninstrumented-files.sha256` and `structure/reversed-files.sha256`
are equal and both files match `support/frozen-identity-manifest.json`, and
`structure/reversed-identity.json` equals `support/final-identity.json`, so the
instrumentation left nothing behind.

## Packaging and integrity

The packaging scripts run in this order, from the repository root:

```sh
$NODE docs/architecture/raptor3-evidence/g4/qualified/support/build-frozen-identity-manifest.mjs
$NODE docs/architecture/raptor3-evidence/g4/qualified/support/package-corpora.mjs
$NODE docs/architecture/raptor3-evidence/g4/qualified/support/retain-corpora.mjs --move
$NODE docs/architecture/raptor3-evidence/g4/qualified/support/audit-retained-corpora.mjs
$NODE docs/architecture/raptor3-evidence/g4/qualified/support/package-corpora.mjs --reproductions
$NODE docs/architecture/raptor3-evidence/g4/qualified/support/build-source-package.mjs
$NODE docs/architecture/raptor3-evidence/g4/qualified/support/build-qualification-index.mjs
$NODE docs/architecture/raptor3-evidence/g4/qualified/support/seal-author-package.mjs
```

`support/retention-run.log` is the stdout of the four corpus steps as they ran,
in order, with their exit codes and the free disk before and after.
`--reproductions` needs the retained children already in place, because it
compares each re-run corpus with the retained archive it reproduces;
`build-source-package.mjs` runs after them so that its evidence-status snapshot
counts the retained receipts.

`package-corpora.mjs` proves each archive restores the exact original bytes and
hash before any raw corpus is unlinked, and re-proves the archives the runner
wrote itself rather than trusting their descriptors. It also compresses the
restored replay inputs under `replays/inputs/`, which are copies of corpora this
package already retains compressed.

`retain-corpora.mjs` copies each child receipt into `campaigns/<mode>/`, re-hashes
the retained archive, and only then — with `--move` — removes the lane's copy.
Without `--move` the lane copy is kept.

`build-source-package.mjs` reverse-applies the patch it wrote
(`git apply --check -R`, which writes nothing) so that the patch is proved to
describe the exact tree this qualification ran.

`build-qualification-index.mjs --derive` prints the totals it reads from the
receipts without asserting the pin; a normal run asserts the pin written into
the script after the runs finished. This attempt began with the pin set to
`null` — attempt 5's numbers are a different identity's — derived its own totals
at 20:31 once every run was complete, wrote them back, and re-ran with the
assertion live.

`seal-author-package.mjs` writes `task-commit-allowlist.json`,
`retained-files.json` and `SHA256SUMS` last; `--allowlist-only` writes just the
commit allowlist, which is how it is drafted while runs are still in flight.

Restore any retained corpus in a new temporary directory and first compare its
restored byte count and SHA-256 with the adjacent archive descriptor. The final
integrity check is:

```sh
cd docs/architecture/raptor3-evidence/g4/qualified
shasum -a 256 -c SHA256SUMS
```
