# CS-02 one-occurrence candidate qualification

Date: 2026-09-13. Status: **frozen for independent review; CS-03 is not
authorized.**

## Outcome

The isolated candidate replaces the flat dependency history with one ordered
`CommandOccurrence` structure. A command is the immutable recipe. Each use of
that recipe owns a distinct occurrence, child/arm topology, series expansion,
and attempt state. A `Selection` remains the reusable observation identity:
presence can be reused, while absence is reobserved at each physical placement.

Static dependency analysis is read-driven. Each stable dependency read walks
only logically preceding writes through occurrence parents and siblings.
Choice arms exclude their opposite arm. Later siblings see the possible writes
of both arms. A concrete series member publishes its finalized membership
contribution only after reconciliation, and later reads consume that exact
carrier/edge/member/identity/origin occurrence. Physical execution walks the
same occurrence topology.

This deletes the reference implementation's flat history owner, range and
suffix splice/restore bookkeeping, mirrored branch observations, actual copied
sibling prefixes, and membership owner scan. Candidate-development versions
that copied ancestry or rescanned the full root were removed before this freeze;
their absence is not credited as a reference deletion. The result does not add
a second scheduler, write chain, cache, feature flag,
public route, or extension capability.

The candidate is not a compression result. Against the accepted reference it
is 450 code-bearing lines larger in both charged scopes:

| Scope | Accepted reference | Candidate | Delta |
| --- | ---: | ---: | ---: |
| Core 12 files | 6,031 lines / 38,161 parser tokens / 200,477 bytes | 6,481 / 40,606 / 215,556 | +450 / +2,445 / +15,079 |
| Broader 28 owners | 10,105 lines / 62,785 parser tokens / 433,524 bytes | 10,555 / 65,230 / 448,603 | +450 / +2,445 / +15,079 |

The increase is the explicit tradeoff for placement-owned topology, stable
dependency reads, ancestry traversal, and direct contribution ownership after
deleting the parallel flat-history mechanisms. CS-03 must measure extension
cost and semantic-owner change before any adoption decision.

## Source identity and retained instrumentation

The final candidate base identity is production
`7fe2364f6988a794f613119c763ec3295a53e39f60a3215ca81630db2f4d0ffc`,
harness `0ed746f70a817183dec58d90233711ff414a47507bcb83e055c5b01958dffdad`,
Node `v24.21.0`. The candidate instrumentation patch is SHA-256
`60e15c802deea7dfc3eae5bb5e003e1c09231c77f6961a33045b929b4e252858`.
Applying only that patch produces production identity
`041fa1376bc74a17e6bbf81c7ec8f5eb564ef78260f01669d7ef93a8f06d6a03`
with the same harness identity. Reversing it reproduces the base identity
exactly.

The accepted reference receipt is
`/tmp/viborm-cs02-reference-final.iBFZzg`. It records 28 cases, 60 exact
same-build Recorder replays, zero skips, and wrapper exit zero. The final
candidate receipt is
`/var/folders/2c/xh5rx2d91wd_lk8rvnnhlr4m0000gn/T/viborm-raptor3-g0-Zmo7lU`.
It records the same 28 recipes, 60 replays, zero skips, plus the three repeated
Choice/series placement witnesses in the source-bound runner.

The two compact archives in this directory preserve the original receipts.
Their raw-event, case, tape, and verified hashes remain inside each receipt;
the archives are not substitutes for those internal checks.

## Actual work measurements

Both alternatives use the same strict protocol, recipes, reducer, semantic IDs,
and schedules. These totals are observed events across all 28 structural cells:

| Counter | Reference | Candidate |
| --- | ---: | ---: |
| Occurrence visits | 1,916 | 1,916 |
| Read visits | 479 | 479 |
| Write visits | 4,729 | 3,088 |
| Overlap pairs | 4,729 | 1,657 |
| Repeated overlap pairs | 3,669 | 0 |
| Prefix reads | 4,204 | 638 |
| Owner-scan reads | 12,743 | 0 |
| Reference copies | 1,027 | 810 |

At depth-create-32 and width-create-32, each alternative performs 33
construction and 33 logical visits with no dependency reads or comparisons.
The reference moves 32 sibling-prefix references; the candidate materializes
32 placement-owned semantic child references. At width-overlap-32, both check
1,024 writer/read pairs and find 32 necessary diagonals. The reference reports
496 speculative distinct and 496 repeated pairs; the candidate reports 992
speculative distinct and no repeats. This is an honest algorithm difference,
not a claim that every candidate counter is smaller.

The candidate's series-choice-missing-32 atomic-batch case reduces overlap work
from 1,596 pairs with 1,487 repeats to 139 distinct pairs with no repeats. Its
222 prefix reads are ancestry navigation; it has no copied prefix or suffix
restore. Behavior, first failing member, error metadata, committed state, and
replay tape remain pinned independently of the counters.

## Validation

- Final instrumented source-bound gate: 4/4 tests, 28 measurement cases, 60
  exact Recorder replays, zero skips; candidate receipt `Zmo7lU`.
- Final uninstrumented G2 contracts: 216/216; receipt `C7UGB9`.
- Final uninstrumented structural/history/choice/member set: 39/39.
- Repeated command occurrence ownership: 3/3. Two placements of one Choice own
  distinct complete found/missing ancestry while sharing the command and lookup;
  present Selection is observed once and absent Selection twice; two placements
  of one selected-series command own distinct template/member ancestry,
  capture targets, and `attempt.series` entries.
- Whole-estate typecheck reports only the two historical Pattern TS2345
  diagnostics plus the isolated worktree's pre-existing
  `tests/pattern/pack/program-dump.ts:131` TS2532 diagnostic. It reports no CS-02
  production or measurement diagnostic.
- `git diff --check` passes.

## Repair record

The first structural-candidate G2 run (`Xg4eog`) passed 207/216. The bounded corrections
were tracked by exact minimized family rather than one aggregate ordering label:
`jbkOAV` passed 212/216, `vhkUBy` passed 211/216, and `btGjQE` passed 216/216;
no one minimized family survived two failed repairs. Repeated placement aliasing
passed after repair 2. Construction finalization first restored missing target-
owned arms, then repair 2 removed the surplus source-owned found arm by
preserving the original source/target ownership boundary. Final G2 and
measurement receipts are green.

CS-02 changes no public API or compatibility contract. Full provider,
campaign, CLI, replay-corpus, and global qualification remains CS-04 work.
