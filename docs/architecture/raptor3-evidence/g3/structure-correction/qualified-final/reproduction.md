# G3 structural-correction reproduction

Run from `/Users/arnaud/code/viborm` with `source.patch` applied to baseline
commit `cf2cbc4e6eed445816e70b0d98ca117db90c86b0`. Keep validation serial and use
the existing resource lock and ceilings.

```sh
RAPTOR_NODE_BIN=/Users/arnaud/.vite-plus/js_runtime/node/24.21.0/bin
PATH="$RAPTOR_NODE_BIN:$PATH"
NODE="$RAPTOR_NODE_BIN/node"
```

Before accepting a receipt, compare its identity with
`support/final-identity.json`. Run each mode listed by `qualification-index.json`:

```sh
$NODE scripts/run-raptor3.mjs <fixed-or-native-mode>
$NODE scripts/run-raptor3.mjs <campaign-mode>
$NODE scripts/run-raptor3.mjs replay <retained-input.json>
```

Native evidence used the already qualified task providers on loopback ports
51436 (PostgreSQL) and 51439 (MySQL). Supply credentials only through the
existing local fixture environment. Do not copy them into evidence or commands.

The two established log-only selectors are:

```sh
$NODE scripts/run-credential-free-tests.mjs --only "Raptor 3 fixed"
$NODE scripts/run-credential-free-tests.mjs --only "raptor3-provider:"
```

Their exact command, selection, resource result, and log hash are in
`selector-launch-provenance.json`.

Run support checks with the recorded limits:

```sh
$NODE scripts/run-node-safe.mjs --rss-limit-mb=1536 768 120000 scripts/raptor3-campaign-receipts.test.mjs
$NODE scripts/run-node-safe.mjs --rss-limit-mb=1536 768 600000 scripts/raptor3-cli.test.mjs
$NODE scripts/run-typecheck.mjs
$NODE scripts/query-engine-structure.mjs
$NODE scripts/measure-raptor3-baseline.mjs --output <output.json>
```

Run the two driver-integration files through the `layer-client` workspace project
with the 1,536 MiB RSS and 768 MiB heap limits, default plus JSON reporters:

- `tests/contracts/public-client/statement-transforms-integration.core.test.ts`
- `tests/contracts/public-client/official-statement-instrumentation.core.test.ts`

For structural measurement, make an isolated worktree at the baseline, apply
the frozen task source patch, then apply
`structural-measurement/instrumentation.patch`. Set the three recorded
`VIBORM_RAPTOR3_MEASUREMENT_*` variables and run `cs02-structure-measure`.
Reverse the instrumentation and compare both touched-file hashes and the full
identity. Never instrument the live qualifying worktree.

Restore any retained corpus in a new temporary directory and first compare its
restored byte count and SHA-256 with the adjacent archive descriptor. The final
integrity check is:

```sh
cd docs/architecture/raptor3-evidence/g3/structure-correction/qualified-final
shasum -a 256 -c SHA256SUMS
```
