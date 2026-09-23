# Raptor 3 shared structure and extension-cost evidence

Date: 2026-09-14. Status: **CS-00, CS-01, and the repaired CS-02 unit are
accepted after independent review. The shared CS-03 peer-member scope unit is
accepted. The isolated CS-03 extension comparison is complete, and the
occurrence-structure candidate is selected, integrated, and accepted after
complete CS-04 qualification and global review. G3 is next and extends these
accepted slices; public adoption remains separate.**

The [checkpoint](../raptor3-core-compression-plan.md) owns the ordered
CS-00–CS-04 contract. The [G2.9 ledger](./g29.md) remains the source for
dependency, branch, progress, repair-budget, and historical receipt evidence.

## CS-00 reference status

The final production identity is
`2fa782174626ac1d27b31ecae3beb6fdf97f49450b86ceeb94230f90ba579e11`;
the harness identity is
`e0da0fd939ab2ba5fde32c094bb407d3648421bc40ab8f539372203c501b87ff`.
Arnaud accepted both G2.9 decisions:

- malformed create, connect-or-create, and ordinary update consumer results
  retain their precise driver/operation/scalar V9001 identity; relevant
  supported-batch failures also retain truthful result-phase progress;
- the 10,104 code-bearing-line broader reference across 28 owners, measured
  with the existing parser-token-line definition, was accepted as 181 lines
  above the 9,923-line G2.9 baseline.

Final qualification found and repaired one self-owner clearability regression.
The resulting broader census is 10,105 lines: +1 from the accepted reference
and +182 from the G2.9 start. Root accepted that single line as the required
same-owner correctness condition, not a new abstraction or a compression
claim. The complete [source-bound package](./core-structure/cs00-qualification/report.md)
is frozen for review.

The candidate ordinary malformed-update progress contract is one committed
segment, one committed write member, and zero completed members. It changes no
write, retry, admission, or uncertainty behavior. Producer-empty
create/connect-or-create keeps the historical generic committed-segment error.

The first approved oracle revision passed `g1-transport` 44/44 but was rejected
by independent `g2-transport` review because its metadata predicate included
non-malformed ordinary failures. Receipt `viborm-raptor3-g0-TbMgDK` is retained
as a failed 6/16 review receipt. The corrected predicate requires a malformed
outcome before applying precise scalar checks. CS-00 must bind all subsequent
evidence to its final harness identity; no earlier partial receipt counts as
closure.

## Final reference measures

| Measure | Reference | CS-00 frozen |
| --- | ---: | ---: |
| Raptor core, twelve `commands/` and `shared/` files | 6,030 code-bearing lines | 6,031 lines / 38,161 parser tokens / 200,477 bytes |
| Broader retained source census | 10,104 code-bearing lines / 28 owners | 10,105 lines / 62,785 parser tokens / 433,524 bytes |
| Broader G2.9 baseline | 9,923 code-bearing lines / 28 owners | Historical anchor |

The core and broader figures answer different questions and are never blended.
Parser-token lines, actual parser tokens, and source bytes are distinct
denominators. The actual token count uses the parser-owned leaf traversal from
`query-engine-structure.mjs`; it is not a standalone scanner count.

## Focused oracle stop

The first CS-00 focused sequence passed `g1-transport` 44/44 at
`/var/folders/2c/xh5rx2d91wd_lk8rvnnhlr4m0000gn/T/viborm-raptor3-g0-Lcr4zb`
and stopped at `g2-transport` 11/16 at
`/var/folders/2c/xh5rx2d91wd_lk8rvnnhlr4m0000gn/T/viborm-raptor3-g0-HfcuKq`.
Both ran production `8f0ff7c22cbb39c1…`, harness `0cdb4349eb7e3fb8…`, and
Node 24.21.0. Self-tests did not run.

The two consumer-malformed failures end at `g2-transport.test.ts:48`, the
legacy-baseline fixture assertion. They do not demonstrate missing candidate
progress. The new malformed candidate contract cannot be imposed on that
unchanged legacy specimen. The other three failures end at line 51, the
candidate assertion, and show already-existing member-phase progress on
non-malformed acknowledged ordinary failures. That difference is not covered by
the malformed-result approval; the existing oracle correctly refuses it until
Arnaud decides whether to preserve legacy behavior or approve the truthful
metadata.

This was the second unsuccessful harness encoding of the approved deviation, so
the inherited repair budget stops CS-00 pending Arnaud's decision. Continuing
requires both explicit approval for a further bounded repair and a decision on
the non-malformed candidate progress contract. Production and tests remain
frozen; no full qualification or PASS is claimed.

## Approved oracle repair

On 2026-09-13 Arnaud approved truthful member-phase progress for acknowledged
ordinary UPDATE provider rejections and one additional bounded oracle repair.
Legacy retains its prior ordinary no-progress contract. Commands requires exact
result-phase `1/1/0` progress for malformed final results and member-phase
`1/1/0` progress for acknowledged after-commit rejection.

The repair keeps the generic comparator strict. The transport-pair owner runs
both engine-specific fixture assertions first, then copies only the approved
candidate `recordSeriesProgress` value into the legacy comparison projection.
It covers primary and subsequent outcomes. Wrong attribution, lost progress,
wrong scalar identity, wrong phase, extra member path, and an unapproved sibling
metadata field remain falsifiers.

The first repair run `viborm-raptor3-g0-AWEK4h` passed 11/16 but rebuilt the
projected metadata with the wrong prototype. Its first correction
`viborm-raptor3-g0-uvbXBU` also passed 11/16 because it preserved the prototype
of Zod's parsed copy rather than the original observed metadata. Root classified
that as a distinct projection implementation defect and authorized its second
bounded correction. The final code preserves the original observation's
prototype and parsed fields, changing only `recordSeriesProgress`.

The final frozen identity is production
`8f0ff7c22cbb39c1188fbfe1e8eba54463e2a071db73fe0c941294f5a81d08ea`,
harness `9e46416a29a6fe60b30a39955630b1f39dc9b23332c103ea764528c05a59877a`,
and Node 24.21.0. Focused `g1-transport` passed 44/44 at
`viborm-raptor3-g0-GdSp7G`; `g2-transport` passed 16/16 at
`viborm-raptor3-g0-CCqx1W`; the campaign-receipt self-test passed 12/12. The
[repair summary](./core-structure/cs00-oracle-repair.json) retains exact paths,
hashes, and the failed-attempt classification. Independent review is pending;
full qualification and PASS are not claimed.

## CS-00 qualification freeze

The final package records 1,062/1,062 local tests, 632/632 ordinary fixed
tests, 11/11 isolated PGlite tests, PostgreSQL 54/54, MySQL 43/43, four complete
campaigns with 20,400 cells and 61,200 replays, two fresh saved replays, two
actual stale-corpus refusals, self-tests 12/12, CLI 7/7, the historical-only
type diagnostics, structure, exact source cost, and the compact archive.

Independent archive review accepted all 419 internal checksums, exact receipt
counts and identities, both cost scopes, and the stale-corpus observations.
Root integration review repeated the identity, checksum, and diff checks and
accepted CS-00. No CS-01 witness, CS-02 production structure, CS-03 extension,
public Raptor route, compression result, cutover, or G3 integration is claimed.

## CS-01 witness contract (frozen for independent review)

CS-01 changes tests, registration, and evidence only. Production remains at the
accepted CS-00 identity. The supported structural gate must pass that reference;
the three capability gates are unconditional future contracts and must expose
their missing capabilities on the reference. They are excluded from every
supported or fixed-pass aggregate.

| Gate | Cells | Reference expectation | Distinct evidence |
| --- | ---: | --- | --- |
| `cs01-structural-reference` | 10 | 10 pass | Choice/read priority across both execution profiles; one present `Selection` observed once at two placements; an absent `Selection` reobserved after an intervening producer; whole-body compound reconciliation publishes only a finalized contribution |
| `cs01-extension-a` | 5 | Four capability failures and one refusal-fence pass | Relation-bearing root `updateMany({ select })` reads terminal scalar rows after all effects; omitted and compound final keys; missing-final-row rollback/progress; no scalar-return, `omit`, `include`, or relation projection widening |
| `cs01-extension-b` | 4 | Four capability failures | Scalar set update/delete limits without preselection; relation capture capped before member admission/effects; negative/fractional admission and a SQL-free zero limit without dynamic member admission |
| `cs01-extension-composition` | 4 | Three capability failures; one supported control must pass | The same limit and terminal-reader contracts through nested series and active/untaken choices, including zero; the control proves the nested recipe independently of A/B |

These are missing combined falsifiers, not copies of the existing single-axis
gates. Existing G2.9 tests already own isolated member substitution, choice-arm
activation, repeated command identity, result progress, retry, and provider
behavior. CS-01 combines the exact placements where the proposed occurrence
structure could otherwise preserve each isolated rule while changing their
priority, lifetime, or publication boundary.

### Owner and deletion map

| Current owner/mechanism | Frozen responsibility | CS-02 deletion test |
| --- | --- | --- |
| `commands/commands.ts` analysis state and `analyzeInto` | Logical occurrence order, dependency reads/writes, branch-local activation, series expansion | One ordered occurrence structure replaces range splice, suffix detach/restore, mirrored arm observations, actual sibling-prefix copies, and owner-history scans; no equivalent parallel registry appears. Ancestor-prefix copying and full-root reanalysis were candidate-development defects, not reference deletions. |
| `commands/selection.ts` and `CommandExecution.run` | A `Selection` is reusable observation meaning, while each placement remains a distinct ordered occurrence; absence is not cached | Presence is observed once, absence can be reobserved, and occurrence identity is not collapsed into `Selection` identity |
| Finalized field/membership contributions | Reconciliation completes before publication; every contribution retains carrier, edge, member, identity, origin, and branch | Later reads consume direct finalized contribution references; provisional or conflicting tuples never become authoritative |
| `commands/execution.ts` and `OperationContext` | Physical capture/effect/result order, prepare-all-before-execute, first-member/error priority, acknowledged progress | Logical traversal changes cannot reorder physical effects, replay admission, or invent stale member path/cardinality |
| Existing mutation and result owners | Adapter mutation limits and the `createMany` terminal-reader pattern | Extension slices reuse these owners; composition adds no third limit/reader route |

### Fair comparison recipe

The accepted reference is preserved at
`/tmp/viborm-cs00-reference.FtGrx0`; the candidate starts identically at
`/tmp/viborm-cs00-candidate.V7lUlt`. At the CS-01 freeze, one exact
witness/registration patch will be generated by diffing only the four
`tests/raptor3/core-structure/` files, the Raptor manifests/runner, and
`vitest.workspace.ts` against the reference worktree. The same patch and
checksum are applied to both worktrees. Neither worktree receives the dirty main
workspace, evidence archives, unrelated files, or another production
interpreter.

CS-02 changes only the candidate production owners. CS-03 implements A, B, and
A+B independently on flat reference and candidate worktrees, with the identical
frozen contracts and 100 deterministic seeds per applicable profile for each
alternative. Measurement records code-bearing lines, parser-owned token leaves,
source bytes, semantic owners/rules/exceptions, and actual depth/width 1, 2, 8,
32 traversal counters. No marginal saving or runtime claim is accepted without
that measurement.

### CS-01 supported-gate stop

The first execution did not reach the tests because `vitest.workspace.ts` had
not registered the new directory. Receipt `viborm-raptor3-g0-H1NWSc` is a setup
failure and is not semantic evidence. After exact registration, receipt
`viborm-raptor3-g0-IQslN6` passed 2/10. It exposed two fixture-construction
errors: the public upsert did not establish the intended prior choice
observation, and the compound create bag used a relation operation that its
admission schema refuses.

The first bounded witness correction used existing `Selection` and command
placement seams and admitted upsert forms. Receipt `viborm-raptor3-g0-fP4PcS`
passed 5/10. The second bounded correction restored the existing
`OperationContext.run` lifecycle, placed both existing choice selections as
guards, and separated the second compound lookup through its other named
relation slot. Receipt `viborm-raptor3-g0-rSRmMx` passed 8/10: all four
priority cases, both Selection cases, compound complete agreement, and
compound conflict passed. The partial and declaration-order-permuted compound
cases still did not produce the expected `NestedWriteError`.

The receipt records only the failed `instanceof NestedWriteError` assertion; it
does not retain the caught value, so it cannot distinguish `undefined` from a
different failure class. CS-01 therefore stopped for read-only independent
diagnosis after two bounded corrections. The executable fingerprint at that
stop was production
`255738d50148ee042f9590d311781892d770becd456c5f334780ec2fff282487`
and harness
`5f4eec5bcf77c216a7082a9cd47fe7c9d74c5d0a4917a59ce5670669185d593a`;
the production-source files themselves remained the accepted CS-00 files,
while the shared Vitest configuration is part of both conservative
fingerprints.

Independent diagnosis established that the remaining fixture read a different
resolved relation edge, which is correctly independent. Arnaud approved one
additional test-only correction without resetting the prior budgets. The final
fixture binds a separately admitted real `kids.updateMany` consumer to the same
authoritative edge. It passes as part of the final 10/10 supported gate. A and B
then produced their expected unconditional reference reds. The
[CS-01 freeze index](./core-structure/cs01-witness-freeze/index.md) records the
final contracts and evidence.

### CS-01 composition repair history

Independent review found that the first composition contract matched only one
root and projected a value already written by that root. It therefore could not
falsify an ignored positive limit or a premature terminal read. A retained
no-limit/no-select control was added before accepting a three-candidate,
`limit: 1` replacement.

Receipt `bLFMdC` first exposed a new fixture problem: the three-member control
refused at the nested `bins.updateMany`. Repair 1, receipt `Qask2Y`, removed the
unnecessary root scalar write; the same refusal remained. Repair 2, receipt
`CvOEYa`, replaced the ORM bin-to-shelf back-write with a synchronous SQLite
trigger, but the control still refused before nested effects. The current
composition file at that stop was SHA-256 `7ee91126…` and reported 0/4: three
expected capability refusals plus the failed control.

Read-only diagnosis does not establish that root `updateMany` plus a nested
series is generally unsupported. The observed refusal is specific to the
three-root control: a prior shelf member's provisional bin write precedes the
next member's unconstrained `bins where: {}` capture, and the analysis has no
proof that those sibling-parent bin sets are disjoint. Existing one-root
nested-series and choice cases remain qualified. A further test-only correction
would keep the future three-candidate `where: {}` plus `limit: 1` cells and
narrow only the supported control to `where: { id: "s1" }`, with one-member
assertions. Arnaud authorized that correction without resetting the inherited
budgets. Receipt `Gbbjbx` passes the supported control with one shelf, bin,
ticket, and holder effect. The three future cells remain `where: {}` over three
candidates with positive `limit: 1` or zero and fail only at the missing
capability boundary. No production widening or CS-02 work is authorized before
independent CS-01 acceptance.

## CS-02 first package and repair

The isolated candidate now owns one ordered occurrence topology for logical
analysis, branch arms, series expansion, and physical execution. It removes the
flat dependency history, range/suffix splice and restore, mirrored branch
observations, actual copied sibling prefixes, and membership owner scan.
Ancestor-prefix copying and full-root rescanning were candidate-development
mistakes removed before qualification, not credited reference deletions.
Selection identity remains separate: two placements of
one command do not share child/arm/member ancestry or attempt state, while an
intentionally shared Selection still reuses presence and does not cache absence.

The first package's uninstrumented identity was production `7fe2364f…`, harness
`0ed746f7…`, Node 24.21.0. G2 contracts pass 216/216, the focused
structural/history/choice/member set passes 39/39, and the repeated
Choice/series placement witness passes 3/3. The source-bound candidate receipt
`Zmo7lU` records 28 measurement cases, 60 exact same-build replays, and zero
skips. Independent review blocked this package: actual preceding traversal was
not fully instrumented; reference receipt `iBFZzg` used Node 24.14.0; that
reference had three lines of unrecorded formatting drift; and repeated
finalized membership retained the first placement's owner.

The candidate is larger, not compressed: core 6,481 versus 6,031 code-bearing
lines and broader 10,555 versus 10,105, with matching +2,445 parser tokens and
+15,079 source bytes in both scopes. The [CS-02 qualification report](./core-structure/cs02-qualification/report.md)
records the preserved first-package identities, work counters, repair history,
and compact receipt archives. The repair removes occurrence ownership from the
symbolic contribution, keeps the finalized descriptor on the immutable command
recipe, and takes current placement ownership only from the containing
`DependencyWrite.occurrence`. Fresh exact-reference and actual-traversal
receipts pass at `pIrQAS` and `UXiw04`; the compact repaired package is
[`cs02-requalification`](./core-structure/cs02-requalification/report.md).
Independent review [accepted the repaired unit](./core-structure/cs02-requalification-review.md)
for the scoped CS-03 comparison. It independently verified all nine package
checksums, patch application and reversal, exact identities, 28-case parity and
raw reductions, the 6,477-versus-6,031 core-line cost, and the focused 4/4,
7/7, and 13/13 gates. The blocked first package remains preserved. This
acceptance authorizes only the scoped CS-03 comparison; it does not adopt the
candidate or authorize broader G3 work.

## CS-03 peer-member scope decision

The candidate's first extension A implementation makes the compound final-key
terminal-read cell pass and preserves the scalar projection boundary. Three
cells remain blocked before terminal read: member 1 writes a root row, then
member 2's self-relation `children.updateMany` or `children.deleteMany` capture
observes that same row. The qualified analyzer refuses the target-existence
dependency with unknown overlap.

This exposed a contract conflict. On 2026-09-13 Arnaud chose the shared semantic
rule for both alternatives: ordered peer series members may observe earlier
peer effects because those effects are not earlier writes inside the next
member's record body. The correction must derive from existing series/member
ancestry. It preserves outer-prefix versus member checks, within-member order,
branch activation, all-members-admitted-before-effects, the union of member
writes seen by later surrounding reads, and the exact published-parent
exclusion. It adds no select-only exception, acknowledged-write exemption,
scope class, policy flag, retry authority, or public route. Its cost is reported
separately from extension A.

The candidate's first and only production correction passes the final causal
scope witness 8/8, the unchanged G2 contracts 216/216, and the final-source
focused gates 45/45. The independently implemented flat reference passes the
same scope, G2, and focused contracts. Independent review accepted the shared
unit after verifying both implementations and the corrected final-source
citations. The [scope evidence](./core-structure/cs03-scope-candidate/report.md)
records exact patches, identities, fixture-development failures, and separate
costs; the candidate delta is +12 lines/+66 tokens/+353 bytes.

## CS-03 extension comparison and selection

Both alternatives implement the same private terminal relation-bearing
`updateMany` selection, scalar and relation-bearing mutation limits, and their
composition. Frozen focused contracts, native PostgreSQL/MySQL witnesses, 100
deterministic seeds per applicable profile, saved-corpus replay, and canonical
comparison preserve the same results, failures, progress, defaults, cuts, and
database state.

The candidate does not demonstrate lower marginal extension cost. From each
qualified foundation, A+B adds 109 core lines, 695 parser tokens, and 3,747 bytes
on the candidate versus 100 lines, 680 tokens, and 3,488 bytes on the
reference. The final same-owner cleanup and placement repair, relative to the
already scope-corrected candidate, nets 0 lines, -89 parser tokens, and -81
bytes; the structural foundation still has a 417-line premium over the scoped
reference foundation. The complete endpoints are 6,598 candidate core lines
versus 6,172 reference core lines, and 10,672 versus 10,246 in the broader
retained-owner census: a 426-line gap in both scopes.

The measured structural comparison selects the candidate, and complete CS-04
qualification and global review accept its integration. It keeps current placement ownership on one occurrence
topology, removes the reference owner scan and administrative history copies,
and reduces repeated dependency work. It also performs more construction and
publication work and retains explicit navigation work. These are measured
trade-offs, not a compression or runtime-speed claim. G3 must extend the
accepted slices rather than rebuild them; public adoption and cutover remain
separate, and the public route is unchanged.
