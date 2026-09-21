# The like-for-like recount

Produced 2026-09-21T20:18:17.143Z by `scripts/closure-final-recount.mjs` from
`docs/architecture/raptor3-evidence/g4/release/closure-repair/receipts/source-size-repair.json` (commit `392dfd30c0c7226b8fba0ebd4f8d1366d8bbecbd`,
clean: false, status `measured-source-and-bundles`).

Token line = Distinct lines containing parser-owned TypeScript token starts; exact existing census function, comments/JSDoc/EOF excluded. The definition and the charged
classification belong to `scripts/query-engine-structure.mjs` and
`scripts/measure-raptor3-baseline.mjs`; this recount restates neither.

## 1. The charged perimeter

| class | files | token LOC | physical | bytes |
| --- | --- | --- | --- | --- |
| charged-engine (`src/query-engine/**`) | 38 | 16,182 | 20,931 | 790,729 |
| charged-integration | 12 | 3,757 | 4,502 | 148,971 |
| charged-adapter-integration | 2 | 101 | 165 | 6,631 |
| **like-for-like total** | 52 | 20,040 | 25,598 | 946,331 |
| charged-g3-prep-shared (reported apart) | 11 | 3,935 | 6,098 | 223,511 |
| **charged, everything the tool charges** | 63 | 23,975 | 31,696 | 1,169,842 |

## 2. Against the recorded old-engine denominators

These denominators are QUOTED from the evidence tree; a revision whose engine
no longer exists cannot be re-measured from this tree.

| denominator | engine token | with integration | engine physical | engine bytes |
| --- | --- | --- | --- | --- |
| frozen 146-file census | 0.3516 | 0.4017 | — | — |
| ff5e77ca5 charged-engine | 0.3551 | — | 0.3499 | 0.3728 |
| 3a291a59 src/query-engine minus the retired pattern/ experiment | 0.3398 | — | 0.3368 | 0.3599 |

Plan §7 targets: token ≤ 0.6, physical ≤ 0.7.

## 3. Per unit, over the complete charged perimeter

### U4 — `bc18b4e23..68bb0bd17` (bc18b4e23..68bb0bd17), 44 files

| bucket | files | + | − |
| --- | --- | --- | --- |
| `excluded-shared-boundary` | 3 | 126 | 34 |
| `non-production:docs` | 33 | 1383 | 0 |
| `non-production:other` | 1 | 1 | 0 |
| `non-production:scripts` | 1 | 1 | 0 |
| `non-production:tests` | 5 | 447 | 30 |
| `removed-or-unclassified-production` | 1 | 62 | 0 |

### U1-U3 — `68bb0bd17..05169b273` (68bb0bd17..05169b273), 57 files

| bucket | files | + | − |
| --- | --- | --- | --- |
| `charged-engine` | 4 | 281 | 64 |
| `non-production:docs` | 47 | 4242 | 0 |
| `non-production:tests` | 5 | 2758 | 78 |
| `removed-or-unclassified-production` | 1 | 144 | 3 |

### U5 — `05169b273..27e6d609a` (05169b273..27e6d609a), 32 files

| bucket | files | + | − |
| --- | --- | --- | --- |
| `non-production:docs` | 27 | 1564 | 0 |
| `non-production:other` | 1 | 21 | 0 |
| `non-production:scripts` | 3 | 897 | 13 |
| `non-production:tests` | 1 | 66 | 0 |

### integrated — `27e6d609a..392dfd30c` (27e6d609a..392dfd30c), 39 files

| bucket | files | + | − |
| --- | --- | --- | --- |
| `charged-engine` | 2 | 52 | 38 |
| `non-production:docs` | 31 | 2514 | 10 |
| `non-production:other` | 1 | 1 | 1 |
| `non-production:tests` | 4 | 197 | 11 |
| `removed-or-unclassified-production` | 1 | 32 | 6 |

