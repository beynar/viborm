# G3P-01 evidence report

Date: 2026-09-09. Status: **evidence complete; independent review pending**.
This unit freezes a fresh Node 24.21 baseline and proves that one historical
G2.7 corpus remains replayable under its exact Node 24.20 runtime. It does not
accept G3 prep, start G3, rerun full campaigns, or qualify PGlite or native
providers.

## Stable identity and cost

The fresh gates ran on production identity
`9a4964d55ba06358f5bcbadd76142a93a18379cac1db5f1fa5d7ba99b8733374`
and harness identity
`c00265252b8300053db26dcfc0e30e79ac8d61e3f01f770b4c3eec85ed3ed41e`.
The runtime was Node `v24.21.0`, Darwin arm64, better-sqlite3 `12.6.0`, and
Vitest `3.1.4`. `initial-snapshot.json` and `final-snapshot.json` show that the
production identity, harness identity, Git HEAD, tracked binary diff, and
porcelain summary stayed unchanged.
`g3-prep-01-SHA256SUMS` inventories every other file in this unit directory.

The existing bounded source-accounting command reproduced 4,592 token-bearing
lines, 5,011 physical lines, and 165,458 bytes:

```text
node scripts/run-node-safe.mjs --rss-limit-mb=1536 768 120000 scripts/measure-raptor3-baseline.mjs --output docs/architecture/raptor3-evidence/g3-prep-01/g3-prep-01-cost.json
```

It completed in 1.61 seconds at 417.7 MiB peak sampled process-group RSS with
teardown verified. The cost receipt SHA-256 is
`4257937add7ad3c1fe1cd722df35b063d4251a3116cc6de4c916f24b733ea889`.

## Fresh Node 24.21 gates

All commands used the existing unfiltered runner, its 768 MiB heap, 1,536 MiB
sampled process-group RSS, and 120 second child limits. All verified teardown.

| Command | Result | Peak RSS | Preserved receipt |
|---|---:|---:|---|
| `node scripts/run-raptor3.mjs g1-compare` | 4 files, 66/66, 0 skipped | 722.4 MiB | `receipts/g1-compare-AMhh7V` |
| `node scripts/run-raptor3.mjs g2-contracts` | 16 files, 216/216, 0 skipped | 786.8 MiB | `receipts/g2-contracts-p9wcJL` |
| `node scripts/run-raptor3.mjs g2-transport` | 1 file, 16/16, 0 skipped | 729.0 MiB | `receipts/g2-transport-oq63oC` |
| `node scripts/run-raptor3.mjs g25-contracts` | 1 file, 6/6, 0 skipped | 508.7 MiB | `receipts/g25-contracts-0krzHz` |
| `node scripts/run-raptor3.mjs g27-contracts` | 1 file, 6/6, 0 skipped | 487.3 MiB | `receipts/g27-contracts-IQRKlq` |

Each preserved `verified.json` records the same source/harness identity and
Node 24.21 runtime. Each adjacent `vitest.json` is the runner's unmodified JSON
report.

## Historical Node 24.20 replay

The runtime came from the official Node.js distribution:

- URL: `https://nodejs.org/dist/v24.20.0/node-v24.20.0-darwin-arm64.tar.gz`
- Published checksum source: `https://nodejs.org/dist/v24.20.0/SHASUMS256.txt`
- Published and measured SHA-256:
  `40e5607e5ecb3db9192723776da2d75d966260fc74a7a9e731c1bd67dda96bc8`

The task-local runtime and restored workspace lived under
`/tmp/viborm-g3-prep-01-node-hJSape`. No system Node installation changed.
The frozen `g27-closure-evidence.tar.gz` supplied the production source,
Raptor harness, scripts, configurations, `_clack.ts` setup fixture, receipt,
and selected `3ZEV1M/g25-polish-corpus.json`. The current dependency installation
was linked as `node_modules`; the manifest confirmed better-sqlite3 `12.6.0`
and Vitest `3.1.4`, matching the archived identity.

The archive is not self-contained for its archived Vitest configuration. The
first runner launch stopped before corpus execution because the archive omits
`tests/contracts/drivers`, while archived configuration imports discovery
manifests that scan the wider test tree. A task-local `rsync --ignore-existing`
overlay supplied the current non-Raptor `tests/` discovery tree. It did not
overwrite an archived path: a fresh extraction compared byte-for-byte equal for
the entire archived `tests/raptor3` tree and archived `_clack.ts`. The Raptor
production/harness identity remained exact after the overlay.

`g3-prep-01-replay-overlay.json.gz` records all 4,134 supplied paths and SHA-256
values; its SHA-256 is
`2036a480116cfcc8a1c412032be595bc04227fb26b304eba695098b2be7c8477`.
Of those paths, 4,132 match HEAD. One tracked discovery-only file differs from
HEAD (`tests/pattern/pack/program-dump.ts`) and one is untracked
(`tests/pattern/match/decode-malformed.core.test.ts`). Neither was selected or
executed by the one-file replay, and neither is a task-owned repository change.
The overlay aggregate path/content SHA-256 is
`dfd32f38228afbbce529383bbbb40c8ce03e01dd73800978e0b912f51d160e80`.

With the restored archive, explicit discovery overlay, and Node 24.20 runtime,
the actual archived runner command passed:

```text
/tmp/viborm-g3-prep-01-node-hJSape/node-v24.20.0-darwin-arm64/bin/node scripts/run-raptor3.mjs replay /tmp/viborm-g3-prep-01-node-hJSape/restored/receipts/viborm-raptor3-g0-3ZEV1M/g25-polish-corpus.json
```

Result: 1 file, 1/1, zero skipped, 3.93 seconds, 526.5 MiB peak sampled
process-group RSS, and teardown verified. The corpus SHA-256 is
`a0878177c79b1a7e94f59d6d36e58dc2e6d48412374c8381e2c680a6198b2c9d`.
The preserved fresh replay receipt is `receipts/historical-replay-gqImpH` and
records the exact qualified Node 24.20 source/harness/runtime identity.

## Historical integrity and readiness preflight

The historical evidence tree hash, excluding all `g3-prep-*` paths, remained
`5b943740283ad527bf683db4feecd62a4eb0fc19af452ae0205d90921847cadc`.
The G2.7 archive remained
`f54dfc6e74e6a18b998beb787567ae09bf17bb1110cc05361a2c698db49b1063`,
and its existing sidecar file remained
`4b3714d0c784e5b8da9161309f49d775e456f19ca033cd47298df9b3e6f9ca8d`.
No historical receipt or archive was modified or relabelled.

Read-only provider preflight found Docker Desktop 4.64.0 with client/server
29.2.1, API 1.53, Linux arm64 engine available. No container carrying a
`viborm.test` label and `raptor3` value was present. This is readiness evidence
only; no provider was started, changed, or qualified.

## Limits

- Full G2 SQLite and transport campaigns remain deferred to G3P-06.
- PGlite and native PostgreSQL/MySQL qualification are not part of this unit.
- The historical replay proves the selected archived corpus with an explicit
  discovery overlay. It does not prove that the G2.7 archive is a self-contained
  dependency installation or self-contained Vitest workspace.
- This report does not mark G3P-01 accepted; independent review owns acceptance.
