# G3-04 reproduction

Run from `/Users/arnaud/code/viborm` with the frozen source patch applied to
commit `26e4f78378e5f545c694c8bc3789201db7f5926a`.

```sh
RAPTOR_NODE_BIN=/Users/arnaud/.vite-plus/js_runtime/node/24.21.0/bin
PATH="$RAPTOR_NODE_BIN:$PATH"
NODE="$RAPTOR_NODE_BIN/node"
```

Before accepting any result, compare the runner's attempt/verified identity to
`support/final-identity.json`. Run serially under the existing shared lock.

## Fixed and provider modes

Run every mode listed under `fixed` and `native` in
`qualification-index.json` independently:

```sh
$NODE scripts/run-raptor3.mjs <mode>
```

The native task providers used PostgreSQL on loopback port 51436 and MySQL on
51439. Supply their local task credentials through the existing fixture
environment; do not copy credentials into commands or evidence.

Run the established log-only selectors:

```sh
$NODE scripts/run-credential-free-tests.mjs --only "Raptor 3 fixed"
$NODE scripts/run-credential-free-tests.mjs --only "raptor3-provider:"
```

The exact selector provenance and log hashes are in
`selector-launch-provenance.json`.

## Campaigns

Run these nine modes serially:

```sh
$NODE scripts/run-raptor3.mjs g2-seeds
$NODE scripts/run-raptor3.mjs g2-transport-seeds
$NODE scripts/run-raptor3.mjs g3p06-seeds
$NODE scripts/run-raptor3.mjs g3p06-transport-seeds
$NODE scripts/run-raptor3.mjs cs03-extension-a-seeds
$NODE scripts/run-raptor3.mjs cs03-extension-b-seeds
$NODE scripts/run-raptor3.mjs cs03-extension-composition-seeds
$NODE scripts/run-raptor3.mjs g3-seeds
$NODE scripts/run-raptor3.mjs g3-transport-seeds
```

The G3 parent archives each completed child before starting the next child.
From the directory that contains a child's `generated-corpus.archive.json`,
restore and replay it without changing the archived bytes:

```sh
g3_corpus_restore_dir=$(mktemp -d)
gzip -dc "generated-corpus.json.gz" > "$g3_corpus_restore_dir/generated-corpus.json"
cd /Users/arnaud/code/viborm
$NODE scripts/run-raptor3.mjs replay "$g3_corpus_restore_dir/generated-corpus.json"
```

Verify the restored byte count and SHA-256 against the adjacent archive
descriptor before replay. The retained selected inputs under `replays/inputs`
can be replayed directly with the same command.

## Support checks

```sh
$NODE scripts/run-node-safe.mjs --rss-limit-mb=1536 768 120000 scripts/raptor3-campaign-receipts.test.mjs
$NODE scripts/run-node-safe.mjs --rss-limit-mb=1536 768 600000 scripts/raptor3-cli.test.mjs
$NODE scripts/run-typecheck.mjs
$NODE scripts/query-engine-structure.mjs
g3_cost_output=$(mktemp)
$NODE scripts/measure-raptor3-baseline.mjs --output "$g3_cost_output"
```

Run the two driver integration files with the existing `layer-client` Vitest
project and JSON reporter. Preserve both stdout and the JSON report.

For the structural measurement, make an isolated copy of the frozen worktree,
copy the required Vitest configuration, prove its base identity, apply
`structural-measurement/instrumentation.patch`, and run the existing
`cs02-structure-measure` mode. Reverse the patch and compare both file hashes
and the complete production/harness identity. Do not instrument the qualifying
worktree.

Finally verify the compact evidence tree:

```sh
cd docs/architecture/raptor3-evidence/g3/unit04
shasum -a 256 -c SHA256SUMS
```
