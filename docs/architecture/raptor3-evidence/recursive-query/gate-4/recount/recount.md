# The like-for-like recount

Produced 2026-09-23T16:49:17.484Z by `scripts/closure-final-recount.mjs` from
`docs/architecture/raptor3-evidence/recursive-query/gate-4/source-size-rq.json` (commit `bcb364491c605dd428d3f57fdc48ed0a3a88b2cb`,
clean: false, status `measured-source-and-bundles`).

Token line = Distinct lines containing parser-owned TypeScript token starts; exact existing census function, comments/JSDoc/EOF excluded. The definition and the charged
classification belong to `scripts/query-engine-structure.mjs` and
`scripts/measure-raptor3-baseline.mjs`; this recount restates neither.

## 1. The charged perimeter

| class | files | token LOC | physical | bytes |
| --- | --- | --- | --- | --- |
| charged-engine (`src/query-engine/**`) | 38 | 16,602 | 21,638 | 821,199 |
| charged-integration | 12 | 3,812 | 4,587 | 151,845 |
| charged-adapter-integration | 2 | 101 | 165 | 6,631 |
| **like-for-like total** | 52 | 20,515 | 26,390 | 979,675 |
| charged-g3-prep-shared (reported apart) | 11 | 3,935 | 6,098 | 223,511 |
| **charged, everything the tool charges** | 63 | 24,450 | 32,488 | 1,203,186 |

## 2. Against the recorded old-engine denominators

These denominators are QUOTED from the evidence tree; a revision whose engine
no longer exists cannot be re-measured from this tree.

| denominator | engine token | with integration | engine physical | engine bytes |
| --- | --- | --- | --- | --- |
| frozen 146-file census | 0.3607 | 0.4112 | — | — |
| ff5e77ca5 charged-engine | 0.3643 | — | 0.3617 | 0.3872 |
| 3a291a59 src/query-engine minus the retired pattern/ experiment | 0.3486 | — | 0.3482 | 0.3738 |

Plan §7 targets: token ≤ 0.6, physical ≤ 0.7.

## 3. Per unit, over the complete charged perimeter

### recursive-query — `076fad02b..HEAD` (076fad02b..bcb364491), 300 files

| bucket | files | + | − |
| --- | --- | --- | --- |
| `charged-engine` | 6 | 882 | 355 |
| `charged-integration` | 2 | 107 | 16 |
| `excluded-shared-boundary` | 6 | 715 | 27 |
| `non-production:docs` | 251 | 107804 | 28 |
| `non-production:other` | 3 | 887 | 858 |
| `non-production:scripts` | 5 | 130 | 43 |
| `non-production:tests` | 24 | 11768 | 736 |
| `removed-or-unclassified-production` | 3 | 50 | 22 |

