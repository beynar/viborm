# The like-for-like recount

Produced 2026-09-23T10:58:20.083Z by `scripts/closure-final-recount.mjs` from
`docs/architecture/raptor3-evidence/recursive-query/gate-3/source-size-rq.json` (commit `4ead1c5919b3cdb2f6a0f5f8a766c25c9e010b37`,
clean: false, status `measured-source-and-bundles`).

Token line = Distinct lines containing parser-owned TypeScript token starts; exact existing census function, comments/JSDoc/EOF excluded. The definition and the charged
classification belong to `scripts/query-engine-structure.mjs` and
`scripts/measure-raptor3-baseline.mjs`; this recount restates neither.

## 1. The charged perimeter

| class | files | token LOC | physical | bytes |
| --- | --- | --- | --- | --- |
| charged-engine (`src/query-engine/**`) | 38 | 16,595 | 21,622 | 821,717 |
| charged-integration | 12 | 3,817 | 4,593 | 152,031 |
| charged-adapter-integration | 2 | 101 | 165 | 6,631 |
| **like-for-like total** | 52 | 20,513 | 26,380 | 980,379 |
| charged-g3-prep-shared (reported apart) | 11 | 3,935 | 6,098 | 223,511 |
| **charged, everything the tool charges** | 63 | 24,448 | 32,478 | 1,203,890 |

## 2. Against the recorded old-engine denominators

These denominators are QUOTED from the evidence tree; a revision whose engine
no longer exists cannot be re-measured from this tree.

| denominator | engine token | with integration | engine physical | engine bytes |
| --- | --- | --- | --- | --- |
| frozen 146-file census | 0.3606 | 0.4112 | — | — |
| ff5e77ca5 charged-engine | 0.3642 | — | 0.3615 | 0.3874 |
| 3a291a59 src/query-engine minus the retired pattern/ experiment | 0.3485 | — | 0.3479 | 0.374 |

Plan §7 targets: token ≤ 0.6, physical ≤ 0.7.

## 3. Per unit, over the complete charged perimeter

### recursive-query — `076fad02b..HEAD` (076fad02b..4ead1c591), 143 files

| bucket | files | + | − |
| --- | --- | --- | --- |
| `charged-engine` | 6 | 830 | 347 |
| `charged-integration` | 2 | 107 | 16 |
| `excluded-shared-boundary` | 6 | 715 | 27 |
| `non-production:docs` | 95 | 45053 | 28 |
| `non-production:other` | 3 | 877 | 858 |
| `non-production:scripts` | 5 | 120 | 43 |
| `non-production:tests` | 23 | 11487 | 736 |
| `removed-or-unclassified-production` | 3 | 43 | 22 |

