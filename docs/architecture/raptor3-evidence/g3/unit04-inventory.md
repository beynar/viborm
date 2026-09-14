# G3-04 provisional qualification inventory

## Status

This is the independent pre-qualification inventory required by plan section
6.3. Counts are **provisional until the final manifest, production, harness, and
dependencies are frozen**. It reuses the CS-04 runners and evidence format; it
does not invent a second orchestrator. No command listed here has been accepted
for G3-04 merely because it passed an earlier identity.

Use the pinned runtime for every parent and child process:

```sh
RAPTOR_NODE_BIN=/Users/arnaud/.vite-plus/js_runtime/node/24.21.0/bin
PATH="$RAPTOR_NODE_BIN:$PATH"
NODE="$RAPTOR_NODE_BIN/node"
```

Every run must retain the exact production and harness identity, Node 24.21.0,
selected mode/files, raw reporter output, resource record, exit status, and
verified teardown. A refused lock executes zero tests and is not a receipt.

## Registered fixed modes

Run each mode independently with `$NODE scripts/run-raptor3.mjs <mode>`.
The 31 inherited CS-04 modes are:

```text
g0
g1-compare
g1-baseline
g1-contracts
g1-generated
g1-transport
g2-baseline
g2-contracts
g2-generated
g2-transport
g25-contracts
g27-contracts
g3p02-contracts
g3p03-contracts
g3p04-contracts
g3p04-review-contracts
g3p05-contracts
post-g3-clearability-contracts
post-g3-schema-views
post-g3-projection-preparation
post-g3-selector-preparation
post-g3-history-analysis
g29-member-dependency
g29-dependency-boundaries
g29-dependency-choices
g29-result-progress
cs01-structural-reference
cs01-extension-a
cs01-extension-b
cs01-extension-composition
cs03-member-scope
```

The eleven newly registered G3 modes are:

```text
g3-bulk-series
g3-suppression-retry
g3-transaction-array
g3-depth-recurrence
g3-generated-smoke
g3-generated-transport-smoke
g3-generated-minimization
g3-execution-review
g3-author-execution-regressions
g3-scope-failure
g3-bulk-result-boundary
```

The current Raptor manifest therefore selects 42 fixed modes. After the
corrected `g3-generated-smoke` count of 6 and the one-test minimization mode,
the provisional sum across those modes is 1,133 tests. The credential-free
aggregate currently remains 65 files and 754 tests because its manifest does
not include `G3_GENERATED_MINIMIZATION_TESTS`; the minimization mode must
therefore run independently and cannot be inferred from the aggregate. Run the
aggregate through its existing owner:

```sh
$NODE scripts/run-credential-free-tests.mjs --only "Raptor 3 fixed"
```

The G3-03 acceptance boundary also requires its focused modes separately before
the campaigns: SQLite 6, scripted transport 1, and minimization 1. Their earlier
red and development-green receipts do not replace a final frozen-source run.

## Provider modes

Run the five inherited PGlite files (11 tests) through the existing selector:

```sh
$NODE scripts/run-credential-free-tests.mjs --only "raptor3-provider:"
```

Run these ten PostgreSQL modes on the task provider:

```text
g2-pg-baseline
g2-pg-contracts
g25-pg-contracts
g27-pg-contracts
g29-member-dependency-pg
g3p02-pg-contracts
g3p03-pg-contracts
g3p04-pg-contracts
post-g3-clearability-pg-contracts
g3-scope-composition-pg
```

The provisional PostgreSQL total is 58 tests. Run these nine MySQL modes:

```text
g2-mysql-baseline
g2-mysql-contracts
g27-mysql-contracts
g29-member-dependency-mysql
g3p02-mysql-contracts
g3p03-mysql-contracts
g3p04-mysql-contracts
post-g3-clearability-mysql-contracts
g3-scope-composition-mysql
```

The provisional MySQL total is 47 tests. Provider evidence must bind the final
source identity and retain exact container identity, loopback port, resource
limits, and teardown without archiving credentials.

The shared driver bind-capacity change also requires fresh durable raw Vitest
evidence for these existing layer-client owners; an earlier stdout observation
is not raw proof:

```text
tests/contracts/public-client/statement-transforms-integration.core.test.ts (5)
tests/contracts/public-client/official-statement-instrumentation.core.test.ts (11)
```

## Campaigns and replay

Retain and rerun the seven inherited source-bound campaign modes:

```text
g2-seeds
g2-transport-seeds
g3p06-seeds
g3p06-transport-seeds
cs03-extension-a-seeds
cs03-extension-b-seeds
cs03-extension-composition-seeds
```

Add the two G3 campaign modes:

```text
g3-seeds
g3-transport-seeds
```

Each G3 mode owns seeds 8000-17999 on two profiles in children of at most 100
seed IDs. That is 20,000 cells and 60,000 exact replays per mode. The two new
lanes therefore add 40,000 cells and 120,000 replays. Together with the seven
inherited CS-04 campaign families, the provisional milestone total is 61,000
cells, 183,000 replays, and zero skips.

Replay the five inherited accepted corpora and one selected final-identity G3
SQLite child corpus plus one selected G3 transport child corpus with:

```sh
$NODE scripts/run-raptor3.mjs replay <corpus.json>
```

Also retain the two historical stale-identity refusal probes. A replay counts
only when the archived input hash matches the receipt and exact reconstruction
passes; deterministic recipe regeneration alone is not a saved-corpus receipt.

## Required mapping checks

The inherited mappings are present and must remain source-bound:

- Wrong-producer recovery refusal:
  `tests/raptor3/prep/native-constraint-ownership.test.ts`, witness
  `g3p02-wrong-table-producer-refusal`, in both `g3p02-pg-contracts` and
  `g3p02-mysql-contracts`.
- Missing recovery winner:
  `tests/raptor3/polish/recovery-live.ts`, witness
  `g25-recovery-winner-lost`, in `g25-pg-contracts`.
- Borrowed binding has no suppression/replay authority:
  `g3p04-review-contracts`, including nested found/missing refusal and the exact
  borrowed INSERT failure.

No additional G3 placement mode was found necessary in the reviewed inventory.
The fixed modes already cover depth 1/2/8/32, ordinary/compound/variant/repeated
occurrences, transaction-array packaging and closed scope, relation-series late
scope, suppression/fatal descendant/healthy suffix, and inherited
after-commit/acknowledgement transport positions. This inventory claim must be
rechecked against the final registered manifest; it is not inferred from a
campaign summary.

## Support, accounting, and archive closure

Run the existing support owners on the final identity:

```sh
$NODE scripts/run-node-safe.mjs --rss-limit-mb=1536 768 120000 scripts/raptor3-campaign-receipts.test.mjs
$NODE scripts/run-node-safe.mjs --rss-limit-mb=1536 768 600000 scripts/raptor3-cli.test.mjs
$NODE scripts/run-typecheck.mjs
$NODE scripts/query-engine-structure.mjs
$NODE scripts/measure-raptor3-baseline.mjs --output <output.json>
```

The source report must keep its denominators distinct. `tokenLines` is the
existing code-bearing LOC measure: distinct source lines containing a
parser-owned token start. It is not the actual parser-token count. Preserve the
separate parser-leaf traversal used by the CS-04 accounting (JSDoc and EOF
excluded), together with physical lines and source bytes, and label each value
by its real unit.

Also rerun the existing source-bound structural measurement: 28 cases, 60
same-build replays, zero skips, with its exact instrumentation patch proved
reversible against the final uninstrumented source.

Archive fixed/native/campaign/replay/support raw reports, source/cost manifests,
the qualification report, reproduction commands, and checksums under one final
identity. Verify every JSON file, mode/directory label, corpus input hash, source
patch hash, and checksum entry. Do not call the result adopted or route the
shipped client until the root's final review and Arnaud's decision.

## Resource/storage constraint

The earlier G2-size projection is obsolete for the richer nested G3 worlds.
The final representative 100-ID children produced 78,700,582 raw bytes for
SQLite and 85,021,090 raw bytes for scripted transport, while their verified
gzip archives were 1,389,330 and 1,650,048 bytes. Extrapolating the raw files
would require about 16.4 GB for the two 10,000-ID lanes, so the campaign must
not retain every raw child concurrently. The existing parent runner instead
streams and verifies each child's restored byte count and SHA-256, writes its
archive receipt, and removes only that verified task-created raw corpus before
starting the next child. Preserve the compact archive and receipt for every
child, record their provenance in the final index, and do not delete historical
evidence.
