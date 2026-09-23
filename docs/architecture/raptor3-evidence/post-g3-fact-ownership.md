# Raptor 3 — post-preparation fact-ownership checkpoint

Date: 2026-09-12. Status: **PASS; all five ordered units, final qualification,
independent archive audit, and root global review are accepted. G3 is not
started.**

This ordered checkpoint precedes G3-01 and G3-03. Historical G3-preparation
packages remain immutable. The central implementation plan owns repair budgets,
ordering, and final acceptance.

Compact source-bound receipts and matched costs are preserved under
[`post-g3-fact-ownership/`](post-g3-fact-ownership/); its checksum manifest is
the integrity boundary. It contains no copied campaign or historical archive.

| Unit | Status | Owner outcome |
| --- | --- | --- |
| 1. Consume authoritative clearability | Independently accepted | Bound membership carries `clearableMembership`. Compound correlation retains the full tuple while disconnect, parent-held delete cleanup, and `set` departures clear only its schema-owned nullable subset. `none`, variants, junctions, provenance, and attribution keep their existing owners. |
| 2. Reuse immutable schema views | Independently accepted after one bounded repair | `EngineSchema` owns lazy immutable physical fields, stored-field order, oriented relation views, and slot clearability. |
| 3. Separate projection meaning | Independently accepted after one bounded repair | `Queries` prepares alias-free projection and decoder meaning before statement lowering. SELECT, RETURNING, reference values, continuations, and decoders consume that one meaning. |
| 4. Resolve selector meaning once | Independently accepted after one bounded repair | `Queries` owns one symbolic admitted selector consumed by analysis and lowering. |
| 5. Remove repeated history copying | Independently accepted | `Commands` preserves ordered branch semantics without ancestor-prefix copies. |

## Unit 1 evidence

The pre-repair four-case SQLite gate failed all four executed mixed-compound
departures: direct disconnect, inverse disconnect, `set`, and parent-held delete
cleanup. Three paths nulled the required context column and hit a not-null
constraint; `set` reconstructed total non-clearability and refused.

The frozen unit identity is production
`8bceaa85501c3405c5ebc9173da341efc5991afe1a0e93cd982d07f35f054d4c`
and harness
`34c7ca0ff455229f2a60b55543c6995f6df020fa460ad7cdfa0c8a43e7509515`.
Native PostgreSQL and MySQL each pass 2/2, covering interactive and atomic-batch
execution through mapped compound foreign keys with real constraints, retained
members, empty sets, and unrelated-tenant controls. Final-source SQLite,
retained-contract, and typecheck checks passed under independent review. The
same 28-owner matched charge is 9,355 parser-token lines, five fewer than the
accepted G3-preparation baseline.

## Unit 2 evidence

The unit 2 review identity is production
`57ca5aae3a499b4466ea4350a85d03da79a8d5eb848a75045b4b6701de2f5656`
and harness
`93805b8a4ca70bd75a07d196ced0183e5ffa87874e48ec9efc4dcb5c8b247720`.
Independent review marked the first unit 2 handoff REVISE because its cached
clearability envelope, fields array, and direct-variant scope wrapper remained
mutable, and direct carrier clearing bypassed the factory cache. This was a
static review finding; no executed red is claimed. The first bounded repair
freezes those newly owned nested views and makes bound and direct consumers use
the same `EngineSchema` clearability answer.
The focused immutable-view witness passes 1/1. Retained clearability, concurrent
borrowed ownership, batch preparation, and retry gates pass. Typecheck adds no
diagnostic beyond the two historical Pattern failures. PostgreSQL and MySQL
clearability and G3P-03 array preparation gates pass on the same identity.
Root also executed
`node scripts/run-credential-free-tests.mjs --only 'Raptor 3 fixed contracts'`:
all 590 tests in 40 files passed, including both new local suites while the
native suites remained excluded. This is a root-observed execution, not a
source-bound runner receipt. The final native coverage is five tests per
provider: two clearability tests and three retained G3P-03 tests.
Independent review accepted the repair. The 28-owner matched charge is 9,468
parser-token lines: +113 from accepted unit 1 and +108 from the 9,360-line
G3-preparation baseline. The increase buys factory-lifetime reuse of exact
field descriptors, ordered fields, oriented membership, and clearability; it is
not a bundle, runtime-speed, or large-reduction claim.

## Unit 3 evidence

The accepted Unit 2 production baseline assembled one internal SELECT only to
obtain `referenceProjection` decoder shape. The baseline probe is source-bound
to production `57ca5aae3a499b4466ea4350a85d03da79a8d5eb848a75045b4b6701de2f5656`;
it assigns no retroactive harness digest, and its exact executable probe script
was not retained. The final focused projection witness remains reproducible and
source-bound. The frozen Unit 3 identity is
production `982c196f1ece7c73d57eb476e70210c739246caae3d9221526a86a930e2610ca`
and harness `b62ab4d6ba1377945bdb80c09d25de9ad3d45c19ae73ef2d54a801b6dbdbd6af`.
The final probe observes zero discarded internal SELECT assemblies and one
required literal SELECT assembly.

The first review found that segmented generated output and non-RETURNING update
continuations re-prepared projection meaning. The bounded repair makes existing
`Queries.select` consume the already prepared description. Segmented output now
prepares once and lowers the same description twice for its distinct RETURNING
and continuation statements; non-RETURNING update prepares once and retains its
required UPDATE then SELECT readback.

The final four-case projection gate passes. Retained G1 (143), G2 (216),
transport (16), G3P-03 (6), and G3P-05 (21) gates pass on the same identity.
The harness receipt self-tests pass 12/12. Whole-estate typecheck adds no error
beyond the historical Pattern diagnostics at
`src/query-engine/pattern/pack.ts:1443` and `:2633`. The matched 28-owner charge
is 9,555 parser-token lines: +87 from accepted unit 2 and +195 from the 9,360-line
G3-preparation baseline. This is an ownership-cost increase, not a bundle or
runtime-speed claim. Independent review reran the four-case focused gate on the
exact frozen identity and accepted the repair.

## Unit 4 evidence

The pre-change three-case focused gate failed because selector preparation was
absent; the existing field-reference route also treated an admitted field token
as a provider value, and did not refuse a cross-model token before I/O. This is
an absent-owner red, not a performance measurement. The initial implementation
then exposed two bounded findings: a witness expected unqualified SQL although
the existing adapter correctly qualified both operands, and non-equality
comparisons were incorrectly inserted into literal equality facts. The witness
was corrected to require the same alias on both operands, and equality facts now
retain literals from equality comparisons only.

The first frozen handoff identity was production
`c908133ba33ffd27d55360fd32f6cd6955ba4daf3296c075ccb162ab53982491`
and harness
`4ab4c50a63bf10391b9b22875ff9ec7f5c366275a4b450dde903b6844f083e0e`.
`Queries` prepares one alias-free selector description with its resolved fields,
operators, relation paths, exact key, and dependency facts. SQL lowering binds
fresh aliases. `Selection` retains that description across lookup, capture, and
membership rechecks. Supplier continuations preserve their original prepared
selector; `Queries.andSelectors` composes supplier and own predicates without
reinterpreting either admitted input. Supplier-specific dependency facts remain
an explicit construction choice. Field references are resolved once and never
become literal equality or disjointness proof. Exact conflict recovery retains
the original selected operand semantics and does not make operator, field-token,
SQL, or extended predicates replay-eligible.

Independent review marked that handoff REVISE because top-level upsert prepared
its base selector once for the main lookup, then reparsed the same raw selector
inside both `targetWhere` and `setWhere` probes. The first bounded repair makes
each condition one prepared selector and composes it with `lookup.selector`
through the existing `Queries.andSelectors` owner. The same audit removed the
dead supplier-selector fallback and routes trusted execution identities through
the internal identity lowering path, so result readback does not become another
public-selector interpretation.

The repaired runner identity is production
`ac687ead886a0c94d0694927b43cfab5a4fbda7db1f99b3310d6c68629ba625c`
and harness
`0ea531c7f1c0c0c1dccffa39b7231d8b62fc45014aab0d4a7d2e1f8af106b346`.
Fresh repaired-identity gates pass: focused selector preparation 4/4, G2
216/216, G3P-05 21/21, and local G3P-02 4/4. Harness receipt tests pass 12/12.
Whole-estate typecheck adds no diagnostic beyond the historical Pattern errors
at `src/query-engine/pattern/pack.ts:1443` and `:2633`.

The pre-repair identity also passed G1 143/143, transport 16/16, and the five-case
G3P-02 provider gate on both PostgreSQL and MySQL. Those native containers used
the exact cached images, reported zero restarts and no OOM, were removed by exact
ID, and left an empty task-label census. These receipts remain pre-repair
evidence; final checkpoint qualification will rerun the complete provider set on
the final Unit 5 identity rather than relabel them.

The repaired matched 28-owner charge is 9,923 parser-token lines: +368 from
accepted unit 3 and +563 from the 9,360-line G3-preparation baseline. The
increase owns one symbolic selector representation plus its fact derivation and
lowering, while removing repeated syntax-to-SQL and syntax-to-facts traversal.
It is not a bundle, runtime-speed, or whole-engine reduction claim. Independent
review reran the repaired four-case gate on the exact frozen identity and
accepted the repair.

## Unit 5 evidence

The accepted Unit 4 source recursively copied the complete preceding occurrence
prefix at every nested record. The removed expressions imply 1, 3, 36, and 528
copied references for both depth and sibling-width axes 1, 2, 8, and 32. These
are analytical source-derived counts, not runtime allocation measurements.

`Commands.analyze` now creates one ordered history, and its private recursion
appends ordinary and series records in place. Only a real two-arm choice detaches
the found and missing suffixes so each arm sees the same common prefix; it then
restores both possible suffixes in semantic order for later siblings. Single
arms allocate no branch suffix. Repeated command identities remain repeated
occurrences, and each dynamic selected-series member still enters analysis with
a fresh history.

The frozen identity is production
`509869f4df577a29820f26514f6bdb7750f5e5c32591722c004aab8e1d40c4c9`
and harness
`112e82f710c639c31d69ca3cb3395338d26d81a4a04bb2bed9b1ce947120c1e0`.
The focused four-case gate passes and observes 2, 3, 9, and 33 actual record
occurrences for both deep and wide fixtures. It also pins exact repeated
identity and two-arm isolation with later-sibling visibility. Fresh retained
gates pass: G1 143, G2 216, G2.7 6, G3P-04 5 plus review 5, G3P-05 21,
selector preparation 4, G3P-03 6, and transport 16. Harness receipt tests pass
12/12. Whole-estate typecheck adds only the historical Pattern diagnostics at
`src/query-engine/pattern/pack.ts:1443` and `:2633`.

The matched charge remains 9,923 parser-token lines across the same 28 owners:
no net increase from accepted Unit 4. This is an eliminated construction-work
claim grounded in removed prefix copies and structural witnesses, not a timing,
heap-allocation, bundle, or whole-engine reduction claim. Independent review
reran the focused four-case gate on the exact frozen identity and accepted the
unit. Final root review repeated that gate at the same identity (receipt suffix
`NV2RHj`) and accepted the complete checkpoint.

## Limits

- The accepted qualification package is under
  [`final-qualification/`](post-g3-fact-ownership/final-qualification/).
- Full checkpoint provider, campaign, replay, type, cost, and compact archive
  qualification is complete on the one stable final identity recorded above.
- This checkpoint changes no public API, public route, production cutover, or G4
  qualification obligation.
