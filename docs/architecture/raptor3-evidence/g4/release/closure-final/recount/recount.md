# The like-for-like recount

Produced 2026-09-21T12:14:19.787Z by `scripts/closure-final-recount.mjs` from
`docs/architecture/raptor3-evidence/g4/release/closure-final/receipts/source-size-final.json` (commit `b5fde8c1eec56992eaadd898c72e462a191151e5`,
clean: false, status `measured-source-and-bundles`).

Token line = Distinct lines containing parser-owned TypeScript token starts; exact existing census function, comments/JSDoc/EOF excluded. The definition and the charged
classification belong to `scripts/query-engine-structure.mjs` and
`scripts/measure-raptor3-baseline.mjs`; this recount restates neither.

## 1. The charged perimeter

| class | files | token LOC | physical | bytes |
| --- | --- | --- | --- | --- |
| charged-engine (`src/query-engine/**`) | 38 | 16,098 | 20,700 | 778,824 |
| charged-integration | 12 | 3,757 | 4,502 | 148,971 |
| charged-adapter-integration | 2 | 101 | 165 | 6,631 |
| **like-for-like total** | 52 | 19,956 | 25,367 | 934,426 |
| charged-g3-prep-shared (reported apart) | 11 | 3,935 | 6,098 | 223,511 |
| **charged, everything the tool charges** | 63 | 23,891 | 31,465 | 1,157,937 |

## 2. Against the recorded old-engine denominators

These denominators are QUOTED from the evidence tree; a revision whose engine
no longer exists cannot be re-measured from this tree.

| denominator | engine token | with integration | engine physical | engine bytes |
| --- | --- | --- | --- | --- |
| frozen 146-file census | 0.3498 | 0.4 | — | — |
| ff5e77ca5 charged-engine | 0.3533 | — | 0.3461 | 0.3672 |
| 3a291a59 src/query-engine minus the retired pattern/ experiment | 0.338 | — | 0.3331 | 0.3545 |

Plan §7 targets: token ≤ 0.6, physical ≤ 0.7.

## 3. Per unit, over the complete charged perimeter

### R4 — `cdd787ac8..61c745f49` (cdd787ac8..61c745f49), 23 files

| bucket | files | + | − |
| --- | --- | --- | --- |
| `non-production:docs` | 18 | 50095 | 0 |
| `non-production:other` | 1 | 80 | 7 |
| `non-production:scripts` | 3 | 801 | 0 |
| `non-production:tests` | 1 | 242 | 0 |

### R2ab — `61c745f49..50ad4fac4` (61c745f49..50ad4fac4), 66 files

| bucket | files | + | − |
| --- | --- | --- | --- |
| `charged-engine` | 1 | 24 | 3 |
| `excluded-shared-boundary` | 6 | 202 | 89 |
| `non-production:docs` | 49 | 5303 | 0 |
| `non-production:tests` | 8 | 508 | 90 |
| `removed-or-unclassified-production` | 2 | 57 | 0 |

### R2c — `50ad4fac4..7a1e9b0e2` (50ad4fac4..7a1e9b0e2), 68 files

| bucket | files | + | − |
| --- | --- | --- | --- |
| `charged-engine` | 4 | 73 | 10 |
| `non-production:docs` | 61 | 5258 | 0 |
| `non-production:tests` | 2 | 721 | 3 |
| `removed-or-unclassified-production` | 1 | 36 | 0 |

### R13 — `7a1e9b0e2..5499cbed3` (7a1e9b0e2..5499cbed3), 60 files

| bucket | files | + | − |
| --- | --- | --- | --- |
| `charged-engine` | 6 | 245 | 112 |
| `non-production:docs` | 47 | 4168 | 0 |
| `non-production:scripts` | 1 | 1 | 1 |
| `non-production:tests` | 5 | 1315 | 99 |
| `removed-or-unclassified-production` | 1 | 77 | 0 |

### postwave — `5499cbed3..b5fde8c1e` (5499cbed3..b5fde8c1e), 44 files

| bucket | files | + | − |
| --- | --- | --- | --- |
| `charged-engine` | 2 | 47 | 10 |
| `excluded-shared-boundary` | 1 | 3 | 3 |
| `non-production:docs` | 34 | 2610 | 59 |
| `non-production:other` | 1 | 6 | 13 |
| `non-production:tests` | 4 | 388 | 14 |
| `removed-or-unclassified-production` | 2 | 78 | 25 |

