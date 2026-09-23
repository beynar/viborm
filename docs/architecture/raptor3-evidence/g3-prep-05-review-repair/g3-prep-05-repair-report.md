# Raptor 3 G3P-05 review repair

Date: 2026-09-12. Status: **qualified; independent re-review pending**.

## Outcome

The original G3P-05 package remains immutable. Independent review found two
new first-round failure families.

First, selected `updateMany` and `deleteMany` series were executed but absent
from `Commands.analyze`. A later relation predicate could therefore select from
stale scalar or existence facts. `RelationBody` now attaches the already
admitted record or deletion meaning to the selected series. The existing
analysis traversal reads the selection, then analyzes that semantic write. It
therefore covers root and nested relation/membership effects without a second
payload walker or cache. Existing complete-key disjointness remains the positive
control.

Second, `Queries.recursive` put a seed's `orderBy` inside a recursive UNION
anchor, which SQLite rejects. The anchor is now unordered. The final projection
uses the existing adapter expression/order owners to order each root by its
seed-local terms, followed by descendant sibling order. The private signature,
flat provider-row representation, decoder, and one-statement contract are
unchanged.

No public API, driver contract, new SQL dialect owner, parser, interpreter, or
cache was added.

## Review reds and correction

The selected-series review gate initially passed 8 and failed 3. Both root and
nested `updateMany` stale-predicate witnesses completed instead of refusing;
the selected `deleteMany` existence witness did the same. The complete compound
identity disjoint control passed on the same source. The recursive gate passed
5 and failed the ordered-root case with normalized V2001 from SQLite's
`ORDER BY clause should come after UNION ALL not before`.

The first recursive placement fixed that target case but omitted the empty
`orderBy` guard used by other seeds; its interim gate passed 1 and failed 5 with
`Object.entries(undefined)`. Adding the missing guard completed the same first
owner-level repair. It was a repair diagnostic, not a surviving seed-order
counterexample or a second representation change.

## Validation

The [index](g3-prep-05-repair-index.json) binds production
`934ef37d910c99efcea7c435e2db9ce65df6080cf91868bc0704dab1f1401ecb`,
harness
`c4092f9c3c7d8a20155877254918f8f6b6944c34cde40ecb08f2afa356c5b3ae`,
and whole charged source
`6802626e3a79fc20dedea1b19a24c745a9b442ab6d8ba673a95afc0b918e1434`.

| Gate                                      |                                                                 Result |
| ----------------------------------------- | ---------------------------------------------------------------------: |
| Expanded G3P-05 combined                  |                                                                  21/21 |
| G3P-04 review / original                  |                                                              5/5 + 5/5 |
| G3P-03 / G2.7 / G2.5                      |                                                        6/6 + 6/6 + 6/6 |
| G2 contracts                              |                                                                216/216 |
| G1 contracts / comparison / transport     |                                                143/143 + 66/66 + 44/44 |
| Existing selected-series owner            |                                                                  14/14 |
| Existing client-array owners              |                                                                  17/17 |
| Existing query relation/projection owners |                                                                  38/38 |
| Existing compound-junction owner          | 24/24 across exact 12-case transaction and 12-case atomic-batch slices |

The compound owner's one-shot process exceeded the fixed 1,536 MiB RSS ceiling.
The complete file was therefore executed as its two named modes under 256 MiB
and 192 MiB heaps. Each receipt retains the other 12 cases as not selected; the
two receipts together execute all 24 assertions. The supporting legacy variant
slice passes 6 selected assertions with 82 deliberately not selected. Neither
is presented as a synthetic no-pending receipt.

Whole-estate typecheck has no new diagnostics. Its only failures are the two
historical Pattern diagnostics at `pack.ts:1443` and `pack.ts:2633`.

The [recursive metrics](g3-prep-05-repair-recursive-metrics.json) cover all 15
real SQLite calls. The new ordered-root calls execute one statement each:
depth 0 is 1,837 characters, 18 binds, and 2 flat provider rows; depth 2 is
1,913 characters, 19 binds, and 6 flat rows. The widening fixture remains one
1,854-character statement with 17 binds at depths 1, 2, 8, and 32. Its provider
rows, public objects, and recursive arrays grow 3, 5, 17, and 65; output JSON
grows 128, 212, 716, and 2,778 bytes. These are measured SQL/bind/row values,
executed public occurrence counts, and deterministic output-size proxies—not a
timing or allocation-byte claim.

The same 28 whole owners measure 9,360 parser-token lines. That is +56 from the
reviewed 9,304-line G3P-05 handoff and +615 from the independently accepted
8,745-line G3P-04 baseline. The three repair owners account for +11 lines in
`commands.ts`, +13 in `relation-body.ts`, and +32 in `query.ts`.

## Risks

G3P-05 proves only the private SQLite recursive fit. Native recursive lowering,
the public feature envelope, complete query/projection coverage, and final
campaign qualification remain assigned to later gates. G3P-06 stays closed
until independent re-review accepts this repair package.
