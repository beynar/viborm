# List-decoder evidence

Raw records behind `raptor3-compiled-list-decoder-report.md` (candidate
branch `compiled-list-decoder` vs `main` `544ab9465`, Node 24.21.0, same
lockfile). Every `.jsonl.gz` line is one fresh-process measurement with the
tree, head, dist digest and cell it came from; the `-summary.txt` files are
the paired summaries the report's tables quote.

| File | What it is |
| --- | --- |
| `u1-baseline.md` | Unit 1: source identities, behaviour matrix with pins, the A/A baseline run |
| `base-time.jsonl.gz`, `base-heap.jsonl.gz` | Unit 1 A/A timing (8 rounds) and heap (4 rounds) on the unchanged trees |
| `u4b-lists.jsonl.gz`, `u4b-lists-summary.txt` | Unit 4 final list cells: root and carried, parse-only and full, 1/20/1000 rows × 0/4/32 members, 12 timing rounds |
| `u4b-controls.jsonl.gz`, `u4b-controls-summary.txt` | Unit 4 non-list controls (scalar, nested) |
| `u4b-parse1x10.jsonl.gz` | The one-row parse-only cells at 10× iterations (the bimodal cells) |
| `u4b-alloc1000.jsonl.gz` | 1000-row heap-growth proxy rounds |
| `u4b-smoke.jsonl.gz` | The 25 verify cells: statements, provider-chain asks by type, result digests, on both trees |
| `review-rerun.jsonl` | The independent reviewer's three-round confirmation (full 1000-row CPU 0.885 / 0.907 / 0.975) |

## Pre-existing reds, identical on `main` (unit 3, both trees, same env)

- `provider-pg` (docker PostgreSQL 16 without PostGIS): 15 PostGIS GeoPoint cells; `provider-postgres`: the same 14. Identical failure sets on both trees.
- `provider-mysql2` (docker MySQL 8): 832 pass, 1 skip on both trees.
- `raptor3-live-provider`, PostgreSQL (throwaway container): `native-g29-member-dependency` ×2, identical on both trees.
- `raptor3-live-provider`, MySQL: the PostgreSQL-only suites under a mysql env (`recovery-live`, `recovery-boundaries` ×2, `staleness-live-pg` ×2), plus `native-g29-member-dependency` ×2, `native-clearability-ownership` ×1, `native-constraint-ownership` (g3p02-mapped-scalar-root-recovery); identical sets on both trees.
- `raptor3` project: `cs02-structure-measure` and the six g3/g4 generation campaigns (missing generated seeds), identical on `main`.

Baseline defects found by unit 3's probes, unchanged on both trees and outside
this change: pg `DATE[]`/`TIMESTAMP[]` not kept as text (date-list create
fails); carried PostgreSQL `bigint[]` beyond 2^53 refused as "not a canonical
integer"; uuid-list push fails on `text[] NOT NULL DEFAULT gen_random_uuid()`.

Reproduce: `node benchmarks/result-decoder-lists.mjs --base <main tree> --candidate <this tree>` (see `benchmarks/README.md`).
