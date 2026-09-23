# CS-02 repaired one-occurrence qualification

Date: 2026-09-13. Status: **frozen for independent review; CS-03 is not
authorized.**

## Outcome

The repair keeps the immutable command recipe and fresh placement occurrence as
separate meanings. Recipe children are the only instantiation source; a runtime
tree, expansion, refusal, ancestry, or attempt binding is never reused as a
recipe. Each placement owns its child, Choice-arm, and selected-series runtime
occurrences. Shared `Selection` identity still reuses presence and reobserves
absence.

Finalized membership descriptors remain on the immutable command recipe. The
current `DependencyWrite.occurrence` is the sole placement owner; the symbolic
contribution no longer stores a second occurrence owner. Repeated finalized
membership and re-instantiation after expansion/refusal are pinned by the
four-cell occurrence witness.

The retained candidate instrumentation emits at the actual preceding ancestor,
sibling, and subtree loop entries before write filtering. Its falsifier requires
both a read-only capture leaf and a compound Choice entry to appear as comparison
prefixes without masquerading as direct writes, and separately requires ancestor
navigation. The dead generic walker is absent. Receipt acceptance rejects a
self-consistent runtime other than Node v24.21.0.

The exact accepted reference was restored without formatting: core 12 files are
6,031 code-bearing lines / 38,161 parser tokens / 200,477 bytes, and the broader
28 owners are 10,105 / 62,785 / 433,524. The repaired candidate is 6,477 /
40,439 / 214,896 and 10,551 / 65,063 / 447,943 respectively: an explicit
**+446 lines / +2,278 tokens / +14,419 bytes** tradeoff, not compression.

The semantic patch is SHA-256 `903df185370866ec03b55fb32080fb57d3afe94d7d96fcbbdd2458259b0460ee`.
It applies to the exact accepted reference and reverses from the uninstrumented
candidate. The candidate instrumentation patch is `da6279d171011c17b3ae449c6d0a436da4d42951d589e29b7f2f84306c5e687d`;
the reference instrumentation patch is
`180a40cddea24c50fc66265479956b1458b356f5f0f2305dd0907f846d517f2d`.

## Validation

- Reference: fixed Node v24.21.0, 28 cases, 60 exact Recorder replays, zero
  skips, wrapper exit zero; receipt `pIrQAS`, verified SHA `47b997ac…`, events
  `8232acb0…`, cases `8da29273…`, tapes `1f0a49c3…`.
- Candidate: fixed Node v24.21.0, 28 cases, 60 exact Recorder replays, zero
  skips; receipt `UXiw04`, verified SHA `533b3e00…`, events `2f83101a…`, cases
  `3ef55d61…`, tapes `1f0a49c3…`. The instrumentation reverses to commands
  `67dcda98…` and execution `695924f2…`.
- Independent reduction `independent-comparison.json` reports zero reduction,
  identity-coverage, recipe/schedule/inventory/outcome-parity, or replay errors.
  Necessary distinct overlap pairs remain 65 in both alternatives.
- Final uninstrumented gates: G2 216/216 (`9AkZgs`); structural reference 10/10
  (`X0hFWD`); history 5/5 (`yfjR9e`); dependency choices 10/10 (`jmHswV`);
  member dependency 14/14 (`hr1DTg`); repeated occurrence ownership 4/4
  (`/tmp/viborm-cs02-ownership.bsD2jx`); receipt self-tests 13/13; measurement
  self-tests 7/7.
- Whole-estate typecheck reports the two historical Pattern TS2345 diagnostics
  and the isolated worktree's unrelated `program-dump.ts:131` TS2532; it reports
  no CS-02 production, harness, or measurement diagnostic.

Observed totals across the same 28 cases are:

| Counter | Reference | Candidate |
| --- | ---: | ---: |
| Occurrence visits | 1,916 | 2,554 |
| Construction visits | 838 | 1,476 |
| Read visits | 479 | 479 |
| Write visits | 4,729 | 3,088 |
| Overlap pairs | 4,729 | 1,657 |
| Overlap atoms | 10,361 | 5,146 |
| Prefix reads | 7,413 | 4,187 |
| Distinct semantic prefixes | 1,383 | 3,362 |
| Repeated prefixes | 6,030 | 0 |
| Navigation prefixes | 0 | 825 |
| Reference copies | 1,027 | 638 |
| Owner-scan reads | 12,743 | 0 |

The corrected prefix accounting supersedes the first package's 4,204/638
comparison. The candidate adds 638 recipe-to-occurrence construction visits and
622 semantic-publication copies. At width-overlap the pair count remains 1,093,
and candidate prefix/write work rises; no general runtime, traversal, allocation,
or performance improvement is claimed. The measured deletions are repeated
prefix work, sibling/suffix administration, and owner scans.

## Risks

- The candidate remains larger than the qualified reference. CS-03 must measure
  extension cost and semantic-owner change before any adoption decision.
- The measurements are work counts, not elapsed-time or allocation claims.
- Full provider, campaign, CLI, replay-corpus, and global qualification remains
  CS-04 work. CS-02 acceptance alone does not authorize CS-03 implementation or
  claim G3 completion.
