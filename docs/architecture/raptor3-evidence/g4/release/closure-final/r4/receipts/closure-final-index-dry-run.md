# closure-final-index.mjs — dry run receipt (the dry run itself was deleted)

command:
  node scripts/closure-final-index.mjs \
    --gate /private/tmp/claude-501/.../scratchpad/fc/gate-closure \
    --out docs/architecture/raptor3-evidence/g4/release/closure-final/dry-run \
    --measurement .../closure-final/r4/receipts/source-size-r4-bundle.json \
    --recount .../closure-final/r4/receipts/recount/recount.json \
    --label "dry run (R4 readiness, integrator's 2026-09-21 01:22 gate logs)"
cwd: /private/tmp/viborm-r4  HEAD: cdd787ac8bbdb735535552dd5851a4758eb8789c  TMPDIR=/private/tmp/viborm-r4-tmp
date: 2026-09-21T08:37:04Z  (re-captured in the repair round, after the
      exit-code parser was corrected; the first capture, 08:11:21Z, counted
      summary.log as a stage and dropped the two multi-word native stages)

stdout:
  closure-final-index: 40 stages (2 summary stage(s) with no log), 663 registered test files -> docs/architecture/raptor3-evidence/g4/release/closure-final/dry-run

produced: index.md (21011 bytes), index.json (105091 bytes),
          logs/ (40 raw logs copied verbatim, 520K).

The gate directory is the INTEGRATOR's 2026-09-21 01:22 run against 833318c5a
(its own summary.log records that HEAD), read only. This dry run is a TOOLING
readiness check: it is NOT a qualification of this tree, and the dry-run
directory was deleted after this receipt was written, as the brief requires.

40 stages: one per log file. summary.log is the exit codes' owner, not a stage,
and is no longer walked as one. 20 of the 40 stages carry no exit code in that
gate's summary.log and are reported `unrecorded`; the tool never substitutes
zero. Two further codes in that summary belong to stage names no log file
carries and are listed under "summary stages with no log" rather than dropped:

  | native mysql2 (docker) | 1 |
  | native pg (docker)     | 1 |

Both are RED native lanes; before the repair their non-zero codes disappeared
entirely and `exit=1` risked being read as the previous stage's.

---- excerpt: index.md, sections 1-3 ----

# Final local release index — dry run (R4 readiness, integrator's 2026-09-21 01:22 gate logs)

Assembled 2026-09-21T08:37:07.136Z by `scripts/closure-final-index.mjs` from `/private/tmp/claude-501/-Users-arnaud-code-viborm/c2c775da-2927-4590-8677-3bb0f5d1aa98/scratchpad/fc/gate-closure`.
Raw logs are copied verbatim under `logs/`; nothing here is recomputed or
reconstructed.

## 1. Source identity

- commit: `cdd787ac8bbdb735535552dd5851a4758eb8789c`
- head: cdd787ac8bbdb735535552dd5851a4758eb8789c 2026-09-21T01:23:57+02:00 docs(raptor3): the local closure checkpoint — the frozen gate's numbers, the release verdict finalised, the kept-red pg registration measured green
- calibration source identity: `8283221eec250d4e88b7d3649b9d973f6513e65fe5cc452e63b555163d3e1207`
- scope: src/, benchmarks/, scripts/, package.json, pnpm-lock.yaml, tsconfig.json, tsdown.config.ts, biome.jsonc — the existing calibration owner
- working tree at assembly: 

```
M CHANGELOG.md
 M docs/architecture/raptor3-evidence/g4.md
 M docs/content/docs/drivers/index.mdx
 M scripts/raptor3-manifest.mjs
?? docs/architecture/raptor3-evidence/g4/release/closure-final/
?? scripts/closure-final-index.mjs
?? scripts/closure-final-recount.mjs
?? tests/raptor3/g4/parity/read-only-build-contract.test.ts
```


## 2. Harness identity

- registered test files: 663
- harness identity: `7c0b989764b38dc87dbc454e813965cfcc94a5d61d448819af9d8aa2d90daaef`

| manifest module | sha256 |
| --- | --- |
| `scripts/raptor3-manifest.mjs` | `7e61f4a882d03b219df5fae0b8b3bde36be028ea347f2b9aab99a807c94b9490` |
| `scripts/credential-free-test-manifest.mjs` | `99696bf1d759ea6fe6d63eacd125b5489731ffac0edcf431fb463d1b4df63d7a` |
| `scripts/client-test-manifest.mjs` | `428020660c3028dd2eb36ce722d9eb9e692c779a19fd0b154edb43c761a47a28` |
| `scripts/driver-test-manifest.mjs` | `2a027df21d54fd332332764646b6b9680faa888751583ad9b9281ecb8a5ca8e0` |
| `scripts/migration-test-manifest.mjs` | `28b01fa5f8b0bd45c3c151d7df456b903894660cbcbbba15a9b57fff60e28a5c` |
| `scripts/query-engine-test-manifest.mjs` | `bca818458f2bd9284d7836db3c6e83b57a96801b48b634ce0978654f7d9ed81a` |

## 3. Runtime and dependency identity

- node: `v24.21.0` (v8 `13.6.233.17-node.53`, darwin/arm64)
- pnpm: `10.11.0`, `packageManager`: `pnpm@10.11.0`
- `pnpm-lock.yaml`: `c366c9806e268e19970626c34e0c5ea1bb74cc7c24b388fa072d580d7bf9aceb`
- `package.json`: `2dd00d97b15fdd2ae20a4fa054bd1befa7fad7c8e18bb2331e7264d90e32961a`

---- excerpt: index.md, section 4 (the repaired part), stage rows elided ----

## 4. Gate stages

| stage | exit | test files | tests | resources / teardown | log sha256 |
| --- | --- | --- | --- | --- | --- |
| `build` | 0 | — | — | Node resources: 2.58s wall, 866.2 MiB peak sampled process-group RSS (sampled ceiling 1536 MiB). Teardown verified. | `79aca0332d3054a1…` |
…37 further stage rows…

### Summary stages with no log

The summary recorded an exit code under these names and no
`<stage>.log` carries them, so their codes are stated here rather than
dropped or attached to a neighbour.

| summary stage | exit |
| --- | --- |
| `native mysql2 (docker)` | 1 |
| `native pg (docker)` | 1 |

---- excerpt: index.md, sections 6-7 ----

## 6. Bundles

From `docs/architecture/raptor3-evidence/g4/release/closure-final/r4/receipts/source-size-r4-bundle.json` (commit `cdd787ac8bbdb735535552dd5851a4758eb8789c`, clean: false, status `measured-source-and-bundles`).
The per-module detail stays in that file.

| fixture | runtime bytes | gzip bytes | modules | sha256 |
| --- | --- | --- | --- | --- |
| `engine` | 359,900 | 101,309 | 180 | `3f133b5ec54f801e…` |
| `pg-simple` | 655,957 | 193,000 | 313 | `e534a53102c999fa…` |
| `pg-relations` | 656,238 | 193,128 | 313 | `662a055f65a77040…` |

Targets: engine gzip ratio ≤ 0.75, every public PostgreSQL fixture ≤ 1. The ratios themselves are computed against the frozen bundle baseline, which this index does not hold.

## 7. LOC and the charged perimeter

| class | files | token LOC | physical | bytes |
| --- | --- | --- | --- | --- |
| charged-engine | 38 | 16,040 | 20,446 | 764,450 |
| charged-integration | 12 | 3,757 | 4,502 | 148,971 |
| charged-adapter-integration | 2 | 101 | 165 | 6,631 |
| likeForLike | 52 | 19,898 | 25,113 | 920,052 |
| charged-g3-prep-shared | 11 | 3,935 | 6,098 | 223,511 |
| charged | 63 | 23,833 | 31,211 | 1,143,563 |

| unit | files | charged-engine ± | charged total ± |
| --- | --- | --- | --- |
| `closure-wave` (`36c87710a..cdd787ac8`) | 569 | +291 / −164 | +301 / −175 |
| `fc06` (`a9e62d8dc..cdd787ac8`) | 49 | +0 / −0 | +0 / −0 |

Full detail: `docs/architecture/raptor3-evidence/g4/release/closure-final/r4/receipts/source-size-r4.json` and the recount beside it.
