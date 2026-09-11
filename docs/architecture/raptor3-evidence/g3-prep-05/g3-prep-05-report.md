# Raptor 3 — G3P-05 dependency, variant-order, and recursive-read fit

Date: 2026-09-11. Status: **implemented and qualified; independent review
pending. G3P-06 and G3 remain closed.**

## Outcome

G3P-05 extends three existing semantic owners without changing the public
client, binding, operation, transaction, adapter, or driver API.

`Queries.where` now performs the one SQL and semantic traversal for scalar and
relation predicates. It records path-scoped model reads and conjunctive equality
facts. `Commands.analyze` consumes those facts for selected update/delete
dependency checks and complete-identity disjoint proofs. A related-row update
or membership mutation that may change a later selector is refused before SQL;
an exact complete identity proves a disjoint control. `OR`, negation, `none`,
`every`, and `isNot` remain unknown rather than becoming false disjointness.

`RelationBody` now admits the bounded `deleteMany` slice and groups variant
collection work as guards, one clear of every configured variant junction, then
writes in caller order. Empty set clears all variants; unmentioned variants are
cleared; alternating members keep their positions; targets survive membership
clears. Root and nested programs use the same owner. Update admission preserves
ordinary-before-variant phase order through the existing schema parse boundary.

Selected update/delete series now use an attempt-owned capture. Direct relation
execution retains the captured target through a later clear; the physical batch
route rechecks the selected target immediately before mutation. This preserves
the established root-prefix and target-missing timing instead of adding a second
series interpreter.

The private `Queries.recursive(model, traversal)` fit accepts only one chosen
self-relation, one or more seed argument bags, a depth, and descendant
`where`/`select`/`include`/`orderBy`. It emits one adapter-composed SQLite
recursive CTE and executes it through `OperationContext.read`. Flat occurrence
rows carry collision-safe seed, depth, complete mapped identity path, and
projected value fields. The existing projection and decoder owners assemble
distinct public occurrences in seed/path order. Complete-key cycles stop per
path before revisit; there is no first-key or global identity deduplication.
Depth zero, empty branches, upward singular and downward collection traversal,
branch pruning, sibling order, ordinary include, mapped compound hidden keys,
overlapping roots, and depths 1/2/8/32 are executable. No public recursion
schema or graph language was added.

## Validation

The [index](g3-prep-05-index.json) binds production
`9edf6c025b924974a3b63f758c9badab0f4e6f3da506bd6b4b03911b93e546a5`,
harness
`a652d43c8afc1e97dba809952341094664c37fbc7b7590aeaeb549afdde6b00f`,
and whole charged source
`c28578266030fee1129a238849e90be35765e6702053a35d60d61960dea51384`.
Every registered final receipt embeds the same production/harness pair.

The initial meaningful gates failed 7/7 selector cases, 3/4 variant cases, and
5/5 recursive cases. The recursive failures were the exact missing private
capability with zero provider statements. After implementation, the combined
gate passes 16/16 with zero failures and zero pending tests:

| Gate | Result | Receipt |
|---|---:|---|
| G3P-05 combined | 16/16 | [`g3p05-final`](receipts/g3p05-final.verified.json) |
| G3P-04 review regression | 5/5 | [`g3p04-review-final`](receipts/g3p04-review-final.verified.json) |
| G3P-04 original | 5/5 | [`g3p04-original-final`](receipts/g3p04-original-final.verified.json) |
| G3P-03 local | 6/6 | [`g3p03-final`](receipts/g3p03-final.verified.json) |
| G2.7 ownership | 6/6 | [`g27-final`](receipts/g27-final.verified.json) |
| G2.5 contracts | 6/6 | [`g25-final`](receipts/g25-final.verified.json) |
| G2 contracts | 216/216 | [`g2-final`](receipts/g2-final.verified.json) |
| G1 contracts | 143/143 | [`g1-contracts-final`](receipts/g1-contracts-final.verified.json) |
| G1 comparison | 66/66 | [`g1-compare-final`](receipts/g1-compare-final.verified.json) |
| G1 transport | 44/44 | [`g1-transport-final`](receipts/g1-transport-final.verified.json) |
| Existing selected-series owner | 14/14 | [`series-final`](receipts/series-final.vitest.json) |
| Existing client-array owners | 17/17 | [`array-final`](receipts/array-final.vitest.json) |
| Existing query relation/projection owners | 38/38 | [`query-owner-final`](receipts/query-owner-final.vitest.json) |
| Existing compound-junction owner | 24/24 | [`compound-owner-final`](receipts/compound-owner-final.vitest.json) |

The large legacy polymorphic collection file exceeded the fixed 1,536 MiB RSS
ceiling as a whole. Under a stricter 384 MiB heap cap, the six assertions that
directly own clear-unmentioned, empty-set, and variant updateMany/deleteMany
behavior pass; the other 82 registered cases were deliberately not selected.
This is supporting focused evidence, not a full-file gate. The new four-case
variant gate executes without pending tests and owns the G3P-05 claim.

The selected-series implementation needed one bounded correction during
retained qualification. Capturing before the parent prefix broke four existing
G2 cases; capturing after the prefix exposed one batch target-missing timing
case. The final shared rule captures after the prefix, retains the captured row
for direct clear/write programs, and performs the established batch recheck.
The final G2 gate passes all 216 cases.

The [recursive metrics](g3-prep-05-recursive-metrics.json) record all 13 real
SQLite calls. For the widening fixture, depth 1/2/8/32 each executes one 1,854-
character statement with 17 binds. Provider rows and public object/recursive-
array counts grow 3/5/17/65; exact accepted output JSON grows 128/212/716/2,778
bytes. Source-level allocation analysis records one public occurrence, one
recursive array, and one local occurrence-map entry per flat row, plus the
transient carrier/path copies. A 512-byte V8 heap sample did not resolve a
private decoder frame, so this package makes no allocation-byte or timing claim.

The [whole-owner cost](g3-prep-05-cost.json) and [matched
receipt](g3-prep-05-matched-cost.json) charge 9,304 parser-token lines across
the same 28 complete owners as the accepted 8,745-line G3P-04 baseline: +559.
Six owners changed; 22 remain charged whole. The historical 4,592-line figure
is a narrower candidate scope and is not comparable. No bundle, whole-engine
reduction, or performance claim is made.

Witness interfaces were typechecked before final qualification. The final
[typecheck receipt](receipts/typecheck-final-known-pattern-failure.txt) contains
only the two unchanged historical Pattern diagnostics at `pack.ts:1443` and
`pack.ts:2633`; no G3P-05 source or witness diagnostic remains.

## Risks

- Independent review has not accepted G3P-05. G3P-06 and G3 stay closed.
- The recursive fit is private SQLite evidence. G4 still owns representative
  PostgreSQL/MySQL lowering, the complete projection/codec/lifecycle envelope,
  and any public recursive API.
- V8 sampling did not attribute bytes to the private decoder. The exact
  occurrence census and process RSS bound do not constitute heap-allocation or
  performance qualification.
- The full legacy polymorphic collection file remains unqualified in this unit
  because it exceeded the unchanged RSS ceiling; only the directly relevant
  six assertions ran. The new bounded gate is complete and has no pending cases.
- Whole-estate typecheck remains non-green only because of the two disclosed
  historical Pattern diagnostics.
