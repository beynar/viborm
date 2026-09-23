# The like-for-like recount

Produced 2026-09-23T07:15:15.400Z by `scripts/closure-final-recount.mjs` from
`docs/architecture/raptor3-evidence/recursive-query/gate/source-size-rq.json` (commit `dc662e1842171a30a4823319a6c9b4051f889280`,
clean: false, status `measured-source-and-bundles`).

Token line = Distinct lines containing parser-owned TypeScript token starts; exact existing census function, comments/JSDoc/EOF excluded. The definition and the charged
classification belong to `scripts/query-engine-structure.mjs` and
`scripts/measure-raptor3-baseline.mjs`; this recount restates neither.

## 1. The charged perimeter

| class | files | token LOC | physical | bytes |
| --- | --- | --- | --- | --- |
| charged-engine (`src/query-engine/**`) | 38 | 16,580 | 21,578 | 818,961 |
| charged-integration | 12 | 3,817 | 4,593 | 152,031 |
| charged-adapter-integration | 2 | 101 | 165 | 6,631 |
| **like-for-like total** | 52 | 20,498 | 26,336 | 977,623 |
| charged-g3-prep-shared (reported apart) | 11 | 3,935 | 6,098 | 223,511 |
| **charged, everything the tool charges** | 63 | 24,433 | 32,434 | 1,201,134 |

## 2. Against the recorded old-engine denominators

These denominators are QUOTED from the evidence tree; a revision whose engine
no longer exists cannot be re-measured from this tree.

| denominator | engine token | with integration | engine physical | engine bytes |
| --- | --- | --- | --- | --- |
| frozen 146-file census | 0.3603 | 0.4109 | — | — |
| ff5e77ca5 charged-engine | 0.3638 | — | 0.3607 | 0.3861 |
| 3a291a59 src/query-engine minus the retired pattern/ experiment | 0.3481 | — | 0.3472 | 0.3728 |

Plan §7 targets: token ≤ 0.6, physical ≤ 0.7.

## 3. Per unit, over the complete charged perimeter

### recursive-query — `076fad02b..HEAD` (076fad02b..dc662e184), 130 files

| bucket | files | + | − |
| --- | --- | --- | --- |
| `charged-engine` | 6 | 802 | 347 |
| `charged-integration` | 2 | 107 | 16 |
| `excluded-shared-boundary` | 6 | 715 | 27 |
| `non-production:docs` | 82 | 37112 | 28 |
| `non-production:other` | 3 | 875 | 858 |
| `non-production:scripts` | 5 | 120 | 43 |
| `non-production:tests` | 23 | 11477 | 736 |
| `removed-or-unclassified-production` | 3 | 38 | 22 |

