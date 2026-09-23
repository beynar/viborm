# FC-06 — the like-for-like recount on the closure tree

Measured on `a9e62d8dc` (working tree; nothing changed under `src/`, `tests/`
or `benchmarks/` by this unit) with the two readers the protocol names:
`scripts/measure-raptor3-baseline.mjs` (classification and totals,
`receipts/source-size-fc06.json`) and `scripts/query-engine-structure.mjs`
(the token-line definition both tools execute). Token line = a physical line on
which at least one parser-owned TypeScript token starts.

## 1. The charged perimeter, closure tree against the release tree

| class | files | token LOC | physical | bytes |
| --- | --- | --- | --- | --- |
| charged-engine (`src/query-engine/**`) | 38 | **16,040** | 20,446 | 764,450 |
| charged-integration (12 client files) | 12 | 3,757 | 4,502 | 148,971 |
| charged-adapter-integration | 2 | 101 | 165 | 6,631 |
| **like-for-like total** | **52** | **19,898** | **25,113** | **920,052** |
| charged-g3-prep-shared (reported apart, as the ledger ruled) | 11 | 3,935 | 6,098 | 223,511 |
| **charged, everything the tool charges** | **63** | **23,833** | **31,211** | **1,143,563** |

Against the release tree `36c87710a` (`g4/release/perf/source-size-release.json`):
engine 16,036 → **16,040 (+4)** token lines, 20,319 → 20,446 (+127) physical,
756,128 → 764,450 (+8,322) bytes; integration 3,759 → 3,757 (−2); adapter
integration and the shared class unchanged; charged total 23,831 → 23,833 (+2).

## 2. Where the +4 comes from, by kind

Each unit's own note and ledger record carries the number; they sum exactly.

| kind | units | token LOC |
| --- | --- | --- |
| new meaning (a fact the tree did not state) | FC-01 +3 (the derived execution-position boundary), FC-02A +2 (one current-values parameter replacing a contradictory pair), FC-03 +23 (the prepared complement and its shared identity predicate) | **+28** |
| duplicate-rule removal | FC-05 −24 in the engine (the restated write-outcome composition, the scalar scratch projection and `lowerProjectionValues`) and −2 in the client integration | **−26** |
| cosmetic / prose | FC-02C (+9 physical, all docblock), FC-05 (+25 comment lines), the wave's docblocks and guide addenda | **0** |
| retired comparison code | none retired in this wave | **0** |
| net | | **+4** engine, **+2** charged |

The +127 physical lines and +8,322 bytes the engine gained are therefore
comment and docblock prose almost in full: 123 of the 127 new physical lines
carry no parser token.

**Moved production responsibility, counted:** FC-05 moved the one write-outcome
composition rule out of the engine to `@errors` (`src/errors/query.ts`, +13
token lines, a class the like-for-like does not charge) and deleted the copy in
`src/extensions/query.ts` (−13). The estate is unchanged by the move, the
engine's −24 already contains the deleted restatement, and no engine semantics
were parked outside the charged perimeter to flatter this table.

## 3. Against the old engine, with the same denominators

Token-LOC against the ledger's frozen denominators (g4.md, "Census corrected",
16:40 2026-09-16 — 146 charged files under `src/query-engine/**` = 46,021, and
49,887 with the 12 client and 3 adapter integration files):

| reading | candidate | old engine | ratio | plan §7 target |
| --- | --- | --- | --- | --- |
| engine only, token LOC | 16,040 | 46,021 | **0.3485** | ≤ 0.60 |
| with the same integration files, token LOC | 19,898 | 49,887 | **0.3989** | ≤ 0.60 |

The frozen 146-file set's own PHYSICAL lines and BYTES are not recorded in the
evidence tree (the ledger's correction records token LOC only), so the physical
and byte targets are reported against the two old-engine readings that ARE
recorded, both named exactly:

| old-engine reading | files | token | physical | bytes |
| --- | --- | --- | --- | --- |
| `ff5e77ca5` charged-engine, the tool's own classification while the old engine was the shipped one (`g4/qualified/support/source-cost.json`) | 144 | 45,570 | 59,815 | 2,121,028 |
| `3a291a59` (the commit before the candidate existed) `src/query-engine/**` minus the retired `pattern/` experiment — the plan's provisional navigation denominator, 47,625 | 147 | 47,625 | 62,149 | 2,197,061 |

| measure | candidate | vs `ff5e77ca5` | vs `3a291a59` | plan §7 target |
| --- | --- | --- | --- | --- |
| engine token LOC | 16,040 | 0.3520 | 0.3368 | ≤ 0.60 |
| engine physical LOC | 20,446 | **0.3418** | **0.3290** | ≤ 0.70 |
| engine source bytes | 764,450 | 0.3604 | 0.3479 | — |
| with-integration token LOC | 19,898 | 0.4027 | — | ≤ 0.60 |
| with-integration physical LOC | 25,113 | 0.3896 | — | ≤ 0.70 |
| with-integration source bytes | 920,052 | 0.4044 | — | — |

The physical-LOC target of plan §7 (≤ 0.70 of the frozen baseline, same
formatting) had never been reported with a number; on every reading above it is
met with a wide margin. Bundles are measured separately and are not recomputed
here — `measure-raptor3-baseline.mjs` was run without `--bundle`
(`status: "source-accounted-bundle-pending"`), and the release tree's bundle
numbers (engine gzip 0.646, public PostgreSQL fixtures 0.735) stand until the
integrator's own run.

## 4. What this recount does not establish

- The exact revision of the frozen 146-file / 46,021 baseline is not named in
  the evidence; the two old-engine readings above are the nearest recorded ones
  and are labelled as such rather than substituted for it.
- `measure-raptor3-baseline.mjs` ran on a tree whose working copy carries this
  unit's documentation, script and manifest edits (`clean: false`); none of
  them is a charged file, and both readers agree on the charged numbers.
