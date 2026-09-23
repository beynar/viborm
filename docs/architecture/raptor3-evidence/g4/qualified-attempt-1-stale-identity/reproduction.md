# G4 qualification reproduction

Run from `/Users/arnaud/code/viborm` with `source.patch` applied to baseline
commit `0cc61e61f372945026b0b564fa643de67168c08e`. Keep validation serial inside
each worktree and use the existing resource lock and ceilings.

```sh
RAPTOR_NODE_BIN=/Users/arnaud/.vite-plus/js_runtime/node/24.21.0/bin
PATH="$RAPTOR_NODE_BIN:$PATH"
NODE="$RAPTOR_NODE_BIN/node"
```

The patch is applied as a whole: the tracked half is an ordinary
`git diff --binary` against the baseline, the untracked half is a sequence of
`git diff --no-index --binary` new-file diffs, so one `git apply` reproduces
both.

```sh
git checkout 0cc61e61f372945026b0b564fa643de67168c08e
git apply source.patch
```

Before accepting a receipt, compare its identity with
`support/final-identity.json`. Every receipt in this package was produced on
that exact production/harness pair; a receipt with any other identity is not
this qualification's evidence.

## Modes

Run each mode listed by `qualification-index.json`:

```sh
$NODE scripts/run-raptor3.mjs <fixed-or-native-mode>
$NODE scripts/run-raptor3.mjs <campaign-mode>
$NODE scripts/run-raptor3.mjs replay <retained-corpus.json>
```

The main tree runs, serially, every fixed mode, the native PostgreSQL and MySQL
groups, the seven selected replays, the two stale-identity refusals, and the
support checks.

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

Each lane is a clean worktree at the frozen source:

```sh
git worktree add /private/tmp/viborm-g4-lane-N <frozen-tree>
mkdir -p /private/tmp/viborm-g4-lane-tmp-N
cd /private/tmp/viborm-g4-lane-N
TMPDIR=/private/tmp/viborm-g4-lane-tmp-N $NODE scripts/run-raptor3.mjs <campaign-mode>
```

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

## Native providers

Native evidence used the task-owned loopback containers on **PostgreSQL
`127.0.0.1:65504`** and **MySQL `127.0.0.1:65515`** (container identities in
`../environment/providers-restart-receipt.json`). The runner sets
`VIBORM_RAPTOR3_PROVIDER`; the port is supplied per provider:

```sh
VIBORM_RAPTOR3_PROVIDER_PORT=65504 $NODE scripts/run-raptor3.mjs <pg-mode>
VIBORM_RAPTOR3_PROVIDER_PORT=65515 $NODE scripts/run-raptor3.mjs <mysql-mode>
```

Host ports are assigned on each container start. Supply credentials only through
the existing local fixture environment; never copy them into evidence or
commands.

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
$NODE scripts/run-node-safe.mjs --rss-limit-mb=1536 768 600000 scripts/raptor3-cli.test.mjs
$NODE scripts/run-typecheck.mjs
$NODE scripts/query-engine-structure.mjs
```

Run the two driver-integration files through the `layer-client` workspace
project with the 1,536 MiB RSS and 768 MiB heap limits, default plus JSON
reporters:

- `tests/contracts/public-client/statement-transforms-integration.core.test.ts`
- `tests/contracts/public-client/official-statement-instrumentation.core.test.ts`

## Structural measurement

Make an isolated worktree at the baseline, apply the frozen task source patch,
then apply `structural-measurement/instrumentation.patch`. Set the three
recorded `VIBORM_RAPTOR3_MEASUREMENT_*` variables and run
`cs02-structure-measure`. Reverse the instrumentation and compare both touched
file hashes and the full identity against
`structural-measurement/uninstrumented-files.sha256` and
`structural-measurement/reversed-identity.json`. Never instrument the live
qualifying worktree.

## Packaging and integrity

The six packaging scripts run in this order, from the repository root:

```sh
$NODE docs/architecture/raptor3-evidence/g4/qualified/support/build-frozen-identity-manifest.mjs
$NODE docs/architecture/raptor3-evidence/g4/qualified/support/build-source-package.mjs
$NODE docs/architecture/raptor3-evidence/g4/qualified/support/package-corpora.mjs
$NODE docs/architecture/raptor3-evidence/g4/qualified/support/retain-corpora.mjs
$NODE docs/architecture/raptor3-evidence/g4/qualified/support/audit-retained-corpora.mjs
$NODE docs/architecture/raptor3-evidence/g4/qualified/support/build-qualification-index.mjs
```

`package-corpora.mjs` proves each archive restores the exact original bytes and
hash before any raw corpus is unlinked, and re-proves the archives the runner
wrote itself rather than trusting their descriptors.
`build-qualification-index.mjs --derive` prints the totals it reads from the
receipts without asserting the pin; a normal run asserts it.
`seal-author-package.mjs` writes `task-commit-allowlist.json`,
`retained-files.json` and `SHA256SUMS` last.

Restore any retained corpus in a new temporary directory and first compare its
restored byte count and SHA-256 with the adjacent archive descriptor. The final
integrity check is:

```sh
cd docs/architecture/raptor3-evidence/g4/qualified
shasum -a 256 -c SHA256SUMS
```
