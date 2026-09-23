# CS-04 evidence reproduction

Run from the repository root with the pinned Node executable:

```sh
RAPTOR_NODE_BIN=/Users/arnaud/.vite-plus/js_runtime/node/24.21.0/bin
PATH="$RAPTOR_NODE_BIN:$PATH"
NODE="$RAPTOR_NODE_BIN/node"
```

The `PATH` assignment is required: campaign and bounded-runner children must
resolve the same fixed Node 24.21 runtime as the parent command.

Each registered fixed mode is reproduced with `$NODE scripts/run-raptor3.mjs <mode>`. The complete mode inventory is the directory inventory under `receipts/fixed/`; runner gate selection cannot be filtered.

The seven source-bound campaigns are:

```sh
$NODE scripts/run-raptor3.mjs g2-seeds
$NODE scripts/run-raptor3.mjs g2-transport-seeds
$NODE scripts/run-raptor3.mjs g3p06-seeds
$NODE scripts/run-raptor3.mjs g3p06-transport-seeds
$NODE scripts/run-raptor3.mjs cs03-extension-a-seeds
$NODE scripts/run-raptor3.mjs cs03-extension-b-seeds
$NODE scripts/run-raptor3.mjs cs03-extension-composition-seeds
```

Replay a saved corpus with `$NODE scripts/run-raptor3.mjs replay <corpus.json>`. The five accepted inputs are under `corpora/`. Replaying either historical corpus retained under `docs/architecture/raptor3-evidence/post-g3-fact-ownership/final-qualification/corpora/` must refuse at the identity boundary.

Run the receipt and CLI owners with:

```sh
$NODE scripts/run-node-safe.mjs --rss-limit-mb=1536 768 120000 scripts/raptor3-campaign-receipts.test.mjs
$NODE scripts/run-node-safe.mjs --rss-limit-mb=1536 768 600000 scripts/raptor3-cli.test.mjs
```

Run the static and type evidence with:

```sh
$NODE scripts/run-typecheck.mjs
$NODE scripts/query-engine-structure.mjs
$NODE scripts/measure-raptor3-baseline.mjs --output <output.json>
```

Native PostgreSQL and MySQL modes use the same `run-raptor3.mjs <mode>` entry after the project container owner supplies the provider URL. Use a random loopback port, tmpfs provider data, two CPUs, 1 GiB, exact container-ID teardown, and the image digests recorded in `support/native-container-summary.txt`. Do not put credentials in the archive.

The structural measurement is reproduced through the registered `cs02-structure-measure` mode and its isolated instrumentation copy. `structural-measurement/instrumentation.patch` is the exact instrumentation delta, and the archived receipt binds both base and instrumented identities.
