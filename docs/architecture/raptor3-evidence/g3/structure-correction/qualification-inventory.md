# G3 structural correction: final qualification inventory

## Boundary

This inventory reuses `../unit04-inventory.md`, its existing runner, nine
campaign families, replay protocol, resource limits, and lossless G3 child
archive workflow. It adds no qualification framework and does not treat the
developmental focused receipts as final evidence.

The 42 fixed modes remain unchanged. Their manifest total changes from 1,133 to
1,137 tests:

- `g3-execution-review`: 5 to 6;
- `g3-author-execution-regressions`: 2 to 3;
- `g3-bulk-result-boundary`: 3 to 5.

The credential-free fixed selector therefore remains 65 files and changes from
754 to 758 tests. `g3-generated-minimization` remains an independent one-test
mode, as recorded by the accepted Unit 04 inventory.

## Required final run

After independent and root code acceptance, bind every receipt to one frozen
production/harness identity and run serially with the pinned Node 24.21.0 path:

1. All 42 fixed modes (1,137 mode-selected tests), including fresh runs of the
   three changed modes.
2. The credential-free fixed selector (65 files, 758 tests), generated SQLite
   smoke (6), generated transport smoke (1), and minimization (1).
3. Five PGlite files (11 tests), ten PostgreSQL modes (58 tests), and nine MySQL
   modes (47 tests), using the accepted provider fixture contract.
4. The same nine campaign families: `g2-seeds`, `g2-transport-seeds`,
   `g3p06-seeds`, `g3p06-transport-seeds`, the three CS-03 extension campaigns,
   `g3-seeds`, and `g3-transport-seeds`.
5. Fresh selected-corpus replay, stale-identity refusals, runner/CLI integrity,
   driver integration, whole-estate types, source structure, parser-token
   census, and the existing reversible structural measurement.

Use the exact commands and provider mode lists in `../unit04-inventory.md`.
Historical receipts remain immutable. The final archive must retain new raw
fixed/native/replay/support reports and the verified compressed G3 child
corpora without copying historical raw campaign trees.

## Storage gate

The current workspace has approximately 4.4 GiB available. A full run is
admissible only with the reviewed per-child G3 gzip flow enabled, no duplicate
raw G3 corpus retention, and a fresh free-space check before each campaign
family. The accepted 100-ID measurements remain the sizing basis. Preserve the
raw corpus on any archive failure and stop before the next child.
