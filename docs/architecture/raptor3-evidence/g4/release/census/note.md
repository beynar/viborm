# Release unit "census" — the decimal-language census against the shipped engine (note)

Integrator: Fable, in the main tree on `7bc08ebd9` (commit 16). Decision
D-49, taken in Arnaud's absence and recorded in `g4.md`. Receipts under
`receipts/`.

## 1. The red

The credential-free gate (`pnpm test:all`, what CI runs) reached its
`extended-local` stages for the first time on this branch after commit 16 and
stopped at shard 1 of 14:
`tests/contracts/architecture/decimal-language-census.test.ts`, cell "no
floating transport > finds no decimal transport through JavaScript number",
received `["src/query-engine/raptor3/shared/query.ts Number 23"]`
(`receipts/census-before-gate.log`). The same cell is red on the last tree
where the retired engine was shipped, `5a37bcd7` (21 sites then): the red is
as old as the engine, never measured because the gate never got past its
first stages since the cutover.

## 2. The truth and its owner

The census (`tests/fixtures/decimal-language-census.ts`, detector 2) is a
contract: a module that imports the central decimal codec is decimal-owned and
every `Number(` call in it counts as a float transport unless exempted by
exact spelling — "deliberately aggressive about mixed-purpose modules", by
design a syntactic boundary, not dataflow. The query owner `query.ts`
imported the codec directly and carries 23 `Number(` calls, none of them on a
decimal: the recursive shape's seed and depth carriers, the polymorphic
orphan count, the int, number and JSON integer readers, and the provider date,
timestamp and time text grammars (regex match groups). The exemption path
cannot express them: it is keyed by spelling and a second use of one spelling
counts, and `Number(value)` and `Number(match[1])` recur. Twenty-three
exemption lines would be patchwork; a barrel that only re-exports the codec
under another path would be a dodge.

The shape the retired estate kept — decimal handling in decimal-named modules
(`src/query-engine/result/decimal-result-decode.ts`, `builders/decimal-field.ts`,
zero `Number(` in either) — is the census's intended one: a decimal module is
read in full, its consumers are not. The engine now keeps that shape.

## 3. The hunks

- New `src/query-engine/raptor3/shared/decimal.ts` (156 lines): the engine's
  decimal seam. It owns what the engine adds when it asks the codec — which
  entry a traversal takes (a bound literal, a list member, a widened `_sum`,
  an internal or a public result), the provider's representation with its one
  default (`?? "text"`, previously spelled three times in the owner), and the
  engine's sentences for the values the codec refuses. Functions:
  `exactDecimalDomain`, `requireDecimal`, `canonicalDecimal`, `decimalMembers`,
  `dividesByZero`, `sameDecimalDomain`, `decimalSumOperand`,
  `decodeDecimalScalar`, `decodeDecimalList`; the `DecimalDescriptor` type is
  re-exported from the codec. No `Number(`, no `: number` annotation, no
  class, no operation bag, no capability flag: the census reads the module in
  full and finds nothing (42 / 42).
- `query.ts` (+30 / −75): imports `./decimal` instead of the codec; the free
  function `exactDecimalDomain` and the three private methods
  (`decimalMembers`, `canonicalDecimal`, `requireDecimal`) moved verbatim;
  the divide-by-zero check, the descriptor comparison, the `having` `_sum`
  operand, the decimal result arm and the decimal list arm call the seam. Every
  refusal sentence is unchanged and stays where it was thrown (the
  `InvalidScalarResult` throws in the owner, the `QueryEngineError` throws in
  the moved functions).

One owner per fact: the codec owns the decimal facts; the seam owns the
engine's choice of entry and default; the owner owns the result-shape
traversal. No second reader, no policy boolean.

## 4. Falsification and verification

- Before: the gate's shard 1 red on this cell, `Number 23`
  (`receipts/census-before-gate.log`); after: the census file 42 / 42
  (`receipts/census-after.log`).
- Whole-estate typecheck 0 diagnostics (`receipts/typecheck.log`).
- The decimal-bearing engine tests and the decoding parity contracts: 13
  files, 75 / 75 (`receipts/decimal-tests.log`: read-codecs, read-aggregates,
  decimal-having-operand, recursive-codec-fit, commands, projection-preparation,
  parity-decoding, and the rest of the grep).
- The fixed mode `g2-baseline`: 216 / 216, verified (`receipts/mode-g2-baseline.log`).
- Biome on the two files: the seam clean; the owner's diagnostics identical in
  count and rule set to its base (16, all pre-existing:
  `receipts/biome-after.log`, `receipts/biome-base-query.log`).

## 5. LOC

`git diff --numstat -- src`: `query.ts` +30 / −75; `decimal.ts` +156 new
(`receipts/numstat.txt`). Production lines rise by the seam's documentation;
the engine's code moves, it does not grow.

## 6. Still red, unverified, blockers

Still red in the gate after this unit: the `shared-family` and
`imported-pglite` stages (184 cells in 41 files, the retired engine's PGlite
contract suites, triaged separately). Unverified: the whole `extended-local`
project was not re-run end to end here (the gate re-run follows the triage).
Blockers: none.
