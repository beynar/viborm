# The like-for-like recount

Produced 2026-09-21T23:42:29.136Z by `scripts/closure-final-recount.mjs` from
`docs/architecture/raptor3-evidence/g4/release/closure-repair-2/receipts/source-size-repair-2.json` (commit `afaf711e41ce93705f9f7883b584efdd42dd8e36`,
clean: false, status `measured-source-and-bundles`).

Token line = Distinct lines containing parser-owned TypeScript token starts; exact existing census function, comments/JSDoc/EOF excluded. The definition and the charged
classification belong to `scripts/query-engine-structure.mjs` and
`scripts/measure-raptor3-baseline.mjs`; this recount restates neither.

## 1. The charged perimeter

| class | files | token LOC | physical | bytes |
| --- | --- | --- | --- | --- |
| charged-engine (`src/query-engine/**`) | 38 | 16,259 | 21,105 | 799,139 |
| charged-integration | 12 | 3,757 | 4,502 | 148,971 |
| charged-adapter-integration | 2 | 101 | 165 | 6,631 |
| **like-for-like total** | 52 | 20,117 | 25,772 | 954,741 |
| charged-g3-prep-shared (reported apart) | 11 | 3,935 | 6,098 | 223,511 |
| **charged, everything the tool charges** | 63 | 24,052 | 31,870 | 1,178,252 |

## 2. Against the recorded old-engine denominators

These denominators are QUOTED from the evidence tree; a revision whose engine
no longer exists cannot be re-measured from this tree.

| denominator | engine token | with integration | engine physical | engine bytes |
| --- | --- | --- | --- | --- |
| frozen 146-file census | 0.3533 | 0.4033 | — | — |
| ff5e77ca5 charged-engine | 0.3568 | — | 0.3528 | 0.3768 |
| 3a291a59 src/query-engine minus the retired pattern/ experiment | 0.3414 | — | 0.3396 | 0.3637 |

Plan §7 targets: token ≤ 0.6, physical ≤ 0.7.

## 3. Per unit, over the complete charged perimeter

### T1-T2 — `88fe2814b..e82264058` (88fe2814b..e82264058), 51 files

| bucket | files | + | − |
| --- | --- | --- | --- |
| `charged-engine` | 3 | 208 | 34 |
| `non-production:docs` | 41 | 4452 | 0 |
| `non-production:tests` | 6 | 1419 | 4 |
| `removed-or-unclassified-production` | 1 | 63 | 0 |

### T3 — `e82264058..9b30b9cd5` (e82264058..9b30b9cd5), 59 files

| bucket | files | + | − |
| --- | --- | --- | --- |
| `excluded-shared-boundary` | 3 | 173 | 22 |
| `non-production:docs` | 52 | 2219 | 0 |
| `non-production:tests` | 3 | 466 | 49 |
| `removed-or-unclassified-production` | 1 | 71 | 0 |

### integrated — `9b30b9cd5..afaf711e4` (9b30b9cd5..afaf711e4), 10 files

| bucket | files | + | − |
| --- | --- | --- | --- |
| `non-production:docs` | 9 | 300 | 7 |
| `removed-or-unclassified-production` | 1 | 4 | 2 |

