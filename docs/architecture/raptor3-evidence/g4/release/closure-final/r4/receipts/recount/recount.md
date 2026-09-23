# The like-for-like recount

Produced 2026-09-21T08:36:15.672Z by `scripts/closure-final-recount.mjs` from
`docs/architecture/raptor3-evidence/g4/release/closure-final/r4/receipts/source-size-r4.json` (commit `cdd787ac8bbdb735535552dd5851a4758eb8789c`,
clean: false, status `source-accounted-bundle-pending`).

Token line = Distinct lines containing parser-owned TypeScript token starts; exact existing census function, comments/JSDoc/EOF excluded. The definition and the charged
classification belong to `scripts/query-engine-structure.mjs` and
`scripts/measure-raptor3-baseline.mjs`; this recount restates neither.

## 1. The charged perimeter

| class | files | token LOC | physical | bytes |
| --- | --- | --- | --- | --- |
| charged-engine (`src/query-engine/**`) | 38 | 16,040 | 20,446 | 764,450 |
| charged-integration | 12 | 3,757 | 4,502 | 148,971 |
| charged-adapter-integration | 2 | 101 | 165 | 6,631 |
| **like-for-like total** | 52 | 19,898 | 25,113 | 920,052 |
| charged-g3-prep-shared (reported apart) | 11 | 3,935 | 6,098 | 223,511 |
| **charged, everything the tool charges** | 63 | 23,833 | 31,211 | 1,143,563 |

## 2. Against the recorded old-engine denominators

These denominators are QUOTED from the evidence tree; a revision whose engine
no longer exists cannot be re-measured from this tree.

| denominator | engine token | with integration | engine physical | engine bytes |
| --- | --- | --- | --- | --- |
| frozen 146-file census | 0.3485 | 0.3989 | — | — |
| ff5e77ca5 charged-engine | 0.352 | — | 0.3418 | 0.3604 |
| 3a291a59 src/query-engine minus the retired pattern/ experiment | 0.3368 | — | 0.329 | 0.3479 |

Plan §7 targets: token ≤ 0.6, physical ≤ 0.7.

## 3. Per unit, over the complete charged perimeter

### closure-wave — `36c87710a..cdd787ac8` (36c87710a..cdd787ac8), 569 files

| bucket | files | + | − |
| --- | --- | --- | --- |
| `charged-engine` | 5 | 291 | 164 |
| `charged-g3-prep-shared` | 1 | 6 | 5 |
| `charged-integration` | 3 | 4 | 6 |
| `excluded-shared-boundary` | 2 | 33 | 15 |
| `non-production:docs` | 535 | 142804 | 3 |
| `non-production:other` | 4 | 65 | 14 |
| `non-production:scripts` | 5 | 644 | 59 |
| `non-production:tests` | 13 | 3530 | 101 |
| `removed-or-unclassified-production` | 1 | 172 | 10 |

### fc06 — `a9e62d8dc..cdd787ac8` (a9e62d8dc..cdd787ac8), 49 files

| bucket | files | + | − |
| --- | --- | --- | --- |
| `non-production:docs` | 39 | 22505 | 8 |
| `non-production:other` | 4 | 23 | 16 |
| `non-production:scripts` | 5 | 638 | 59 |
| `removed-or-unclassified-production` | 1 | 40 | 24 |

