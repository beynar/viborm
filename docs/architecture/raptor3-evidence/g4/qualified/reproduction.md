# G4 qualification reproduction (performance-pass identity)

Run from `/Users/arnaud/code/viborm` with `source.patch` applied to baseline
commit `0f25637bcd73b3f402c0bb41aadbb70e67a0a964` — the committed G4 tree. Keep
validation serial inside each worktree and use the existing resource lock and
ceilings.

```sh
RAPTOR_NODE_BIN=/Users/arnaud/.vite-plus/js_runtime/node/24.21.0/bin
PATH="$RAPTOR_NODE_BIN:$PATH"
NODE="$RAPTOR_NODE_BIN/node"
```

The patch is applied as a whole: the tracked half is an ordinary
`git diff --binary` against the baseline, the untracked half is a sequence of
`git diff --no-index --binary` new-file diffs, so one `git apply` reproduces
both. It carries only the performance pass's twenty source and harness files;
the evidence half of the task file set is listed in `task-commit-allowlist.json`
and is never patched.

```sh
git checkout 0f25637bcd73b3f402c0bb41aadbb70e67a0a964
git apply source.patch
```

Before accepting a receipt, compare its identity with
`support/final-identity.json` (production
`2e92354bafaaccb7cab5f54041992b552664a7865fb69370be70ebccb63a1975`, harness
`31c2883fd742dbea69896430543a85a9eace96719b9f24f9358593b54ff3a66a`). Every
receipt in this package was produced on that exact pair; a receipt with any
other identity is not this qualification's evidence.
`support/frozen-identity-manifest.json` re-derives both fingerprints from the
1,079 files `captureRaptor3Identity` hashes.

## Modes

Run each mode listed by `qualification-index.json`:

```sh
$NODE scripts/run-raptor3.mjs <fixed-or-native-mode>
$NODE scripts/run-raptor3.mjs <campaign-mode>
$NODE scripts/run-raptor3.mjs replay <retained-corpus.json>
```

The main tree runs, serially, every fixed mode, then the native PostgreSQL and
MySQL groups (each preceded by the E-1 stale-world drop), then the support
checks. The replays and the structural measurement run after every lane and the
main chain have exited.

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
identity, because the source under them changed.

A lane that finds a stale workspace lock in its own `TMPDIR` refuses rather than
running. A mode whose log still says `Test command refused` after the refused-mode
re-runs is recorded as **refused**, not as a failure — it produced no test result
either way.

## Native providers

Native evidence used the task-owned loopback containers on **PostgreSQL
`127.0.0.1:55729`** and **MySQL `127.0.0.1:55730`**. Both host ports are
ephemeral and are new for this attempt: Docker Desktop was found stopped at
12:24 and restarted before the qualification, which re-initialised the tmpfs
data and reassigned the ports. The container identities, ports, memory, CPU and
tmpfs limits as observed during this run are in `support/provider-ports.json`.
The driver reads the port per group and passes it to the runner:

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
live-provider run is in flight. The drop is an environment step, not evidence:
it never runs beside a live native mode, and it never removes a world younger
than the window, so an in-flight run cannot lose its own schema. E-1 remains
open for the harness owner; a per-world drop on success is the one-line fix.

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
$NODE scripts/measure-raptor3-baseline.mjs --output support/source-cost.json                  # ENOBUFS here; see below
```

Two of these did not produce the evidence they were asked for on the first pass
at 13:18–13:26, and both were **re-run at 16:17–16:21 on the unchanged frozen
tree**, where both are green. Reproduce them the way the re-run did, not the way
the first attempt did. `support/RERUN.md` is the full account; the red first
attempts are kept beside the new receipts as
`support/cli-selftest.attempt1-red.log` and
`support/source-cost.attempt1-enobufs.log`, and `support/rerun-RUN.log` is the
integrator's record of the two re-runs with their exit codes and times.

- `scripts/raptor3-cli.test.mjs` was 9 of 10 while all six campaign lanes were
  live: the watchdog cell "the outer watchdog terminates a public call awaiting a
  queued provider reply" saw only the Vitest banner after 17.99 s. **Run this file
  alone, on a quiet machine.** Re-run that way in the main tree it is 10 of 10
  (`support/cli-selftest.log`, 240.41 s wall, 211.0 MiB peak RSS) and that cell
  takes 10.46 s. The cell is a watchdog race against a real process reaching its
  wait, so a loaded machine will fail it again.
- `scripts/measure-raptor3-baseline.mjs` died before writing
  `support/source-cost.json`: its
  `execFileSync("git", ["status", "--porcelain"])` at
  `scripts/measure-raptor3-baseline.mjs:318` overflows Node's default 1 MiB
  `maxBuffer` (`spawnSync git ENOBUFS`) whenever the working tree's status output
  is large — 1,220,616 bytes at 13:26, with the previous sealed package's
  deletions and this package's own untracked files in it. The value read from
  that call is only `source.clean`, which is `false` either way. That defect is
  untouched: the fix is one option on that call (`maxBuffer`), owned by the
  harness, and the measurement was **not** retaken with a modified tool. Instead
  run the unmodified tool in a worktree whose own status output is small:

  ```sh
  cd /private/tmp/viborm-g4-lane-5
  TMPDIR=/private/tmp/viborm-g4-lane-tmp-5 \
    $NODE scripts/measure-raptor3-baseline.mjs --output <path>/source-cost.json
  ```

  That is sound only if the bytes read are the frozen bytes, so check both: the
  worktree's own `captureRaptor3Identity()` must equal `support/final-identity.json`
  (`support/rerun-lane5-identity.json`), and every file the census read must
  appear in `support/frozen-identity-manifest.json` with the identical SHA-256 —
  581 of 581 do, 0 outside the identity and 0 differing from the freeze.
  `support/verify-rerun-receipts.mjs` re-derives both checks into
  `support/rerun-verification.json`:

  ```sh
  $NODE docs/architecture/raptor3-evidence/g4/qualified/support/verify-rerun-receipts.mjs
  ```

  The result has status `source-accounted-bundle-pending` — source accounting
  complete, bundle half not attempted — with the charged perimeter at 171 files /
  2,518,074 bytes / 71,146 physical lines / 53,890 token-lines.
  `support/query-engine-structure.log` (the whole-query-engine census, exit 0)
  and `../root-review-D.md` carry the other structural numbers this attempt
  has.

Run the two driver-integration files through the `layer-client` workspace
project with the 1,536 MiB RSS and 768 MiB heap limits, default plus JSON
reporters:

- `tests/contracts/public-client/statement-transforms-integration.core.test.ts`
- `tests/contracts/public-client/official-statement-instrumentation.core.test.ts`

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
`<name>.not-a-replay-input.*` as in the previous package, and classified from
the gate's own `unrecognized_keys` / `subject` sentence (`replays/NOTE.md`):

```sh
$NODE scripts/run-raptor3.mjs g4-seed-batch 20000 --subject=candidate
$NODE scripts/run-raptor3.mjs g4-transport-seed-batch 50000 --subject=candidate
```

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
  $NODE scripts/run-raptor3.mjs cs02-structure-measure
git apply -R "$PATCH"
```

The receipt of this run is `structure/receipt/` (28 cases, 60 same-build
replays, 0 skipped, `qualifying: true`). `structure/uninstrumented-files.sha256`
and `structure/reversed-files.sha256` are equal, and
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

`support/retention-run.log` is the stdout of the three corpus steps as they ran,
in order, with their exit codes. `--reproductions` needs the retained children
already in place, because it compares each re-run corpus with the retained
archive it reproduces; `build-source-package.mjs` runs after them so that its
evidence-status snapshot counts the retained receipts.

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
the script after the runs finished. After the two support re-runs the index was
derived unpinned, checked field for field against the pin, and re-pinned: the
pinned totals are unchanged — no qualifying receipt was touched — and the only
difference is that `gaps` is now empty and the status is
`author-qualification-evidence-complete-independent-and-root-acceptance-pending`.

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
