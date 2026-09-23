# CS03 independent structural decision

## Outcome

**Recommend the shared-occurrence candidate for final CS04 qualification.**

This is an ownership decision, not a compression or performance claim. The
candidate is 426 core lines larger after A+B, and A+B costs essentially the
same on both alternatives. Its advantage is narrower: construction,
dependency analysis, selected-series expansion, and execution use the same
per-placement occurrence tree, so a dynamic expansion changes its one owning
structure instead of synchronizing copied flat histories.

Retaining the reference would also be defensible if minimum source size were
the controlling objective. That is not the accepted objective here: the
checkpoint asks whether one structural representation deletes maintenance
machinery and its ownership hazards. The candidate does.

## What the candidate deletes

The scoped reference still has these independent rules in
`src/query-engine/raptor3/commands/commands.ts`:

- `AnalysisState.writes` and `AnalysisState.series` form a flat logical
  history beside the command structure.
- `DependencyChoice` mirrors Choice arms for dependency observation.
- `SeriesAnalysis` records `state`, `provisionalLength`, `substituted`, and a
  list of copied-state `publications`.
- `analyzeMembers` copies prefix writes and active series into each peer,
  registers inbound and outbound publication links, and later appends the
  copied suffix to the enclosing state.
- `resumeSeries` locates a positional marker, detaches suffixes and following
  scopes, removes and restores a generated parent, substitutes expansion
  ranges into every published copy, and rewires the publication graph.
- `readMembership` scans the flat write history again to prove that a
  contribution owner has become visible.

These are not hypothetical costs. The approved peer-member scope correction
needed both inbound and outbound publication registration. Its first repair
left a copied active prefix stale; the causal surrounding-read witness exposed
the defect, and a second synchronization repair was required.

The candidate has none of `AnalysisState`, `DependencyChoice`,
`SeriesAnalysis`, `provisionalLength`, `substituted`, the publication graph,
positional expansion replacement, or the membership-owner history scan.
The immutable command recipe retains the finalized publication descriptor;
the containing `DependencyWrite.occurrence` is its sole current placement
owner. Expansion attaches actual member occurrences to the selected-series
occurrence. Later reads find earlier writes by walking that occurrence
ancestry.

## Replacement rules and lifetime cost

The replacement is not free and should not be described as “just the command
tree.” An immutable command recipe cannot itself own runtime state when the
same Choice or selected-series command is placed more than once. Each
placement therefore gets a fresh `CommandOccurrence` with its own parent,
children, role, refusal, dependency read, and captured members. Shared
`Selection` identity remains distinct from occurrence identity, preserving
presence reuse and absence re-observation.

The candidate adds four real rules:

1. `place` establishes semantic order and physical placement on the recipe.
2. `materializePlacement` clones one parent's direct recipe children, resolves
   capture targets against that parent's local sibling correspondence, and
   recurses with a fresh correspondence for every child placement.
3. branch ancestry determines arm compatibility and branch-local activation.
4. preceding-write and following-read traversals stop at the peer-series
   boundary while retaining true outer-prefix and later-surrounding checks.

Those rules are inherent in repeated placement and ordered dependency scope.
They replace the flat-history synchronization rules rather than moving them
into a second scheduler or VM. Construction, analysis, expansion, and
execution all consume `CommandOccurrence`; attempt state is keyed by those
occurrences.

## Cost

The exact scoped and combined core census is:

| Alternative | Scoped foundation | A+B increment | Combined core |
| --- | ---: | ---: | ---: |
| Flat reference | 6,072 lines / 38,538 tokens / 202,519 bytes | +100 / +680 / +3,488 | 6,172 / 39,218 / 206,007 |
| Shared occurrence | 6,489 lines / 40,416 tokens / 215,168 bytes | +109 / +695 / +3,747 | 6,598 / 41,111 / 218,915 |

The candidate foundation costs **+417 lines, +1,878 parser tokens, and +12,649
bytes**. After A+B the total gap is **+426 lines, +1,893 tokens, and +12,908
bytes**. A+B itself is only nine lines and fifteen tokens more on the
candidate, so the extensions do not repay the foundation cost. Conversely,
they do not create a second candidate-specific execution path.

## Measured structural work

The final comparison uses the scope-corrected reference, not the earlier
pre-scope measurements. Both alternatives executed the same 28 recipes and 60
exact replays on Node 24.21. Recipe, schedule, inventory, outcome, and replay
tape identities match exactly.

| Actual-work counter | Flat reference | Shared occurrence |
| --- | ---: | ---: |
| Dependency pair checks | 1,657 | 1,657 |
| Compared atoms | 6,239 | 5,146 |
| Prefix reads | 2,319 | 5,180 |
| of which navigation | 0 | 1,028 |
| Reference/publication copies | 1,887 | 638 |
| Membership owner-scan reads | 12,743 | 0 |
| Occurrence visits | 1,916 | 2,554 |

These counters are unlike units and must not be summed into a speed claim.
The candidate does not reduce conservative dependency pair decisions: both
perform 1,657 checks and identify the same 65 necessary pairs. It removes the
reference's owner scan and most copy synchronization, but pays for explicit
occurrence construction and tree traversal.

Before the bounded same-owner cleanup, candidate navigation was 8,220. Exact
site attribution showed that `branchOf` caused 7,395 reads, including 6,382
same-site repeated consumer/prefix pairs. The cleanup threads the already-known
branch through the existing traversals, deletes the temporary ancestor array,
and adds no cache or mirrored topology. Final navigation is 1,028.

The remaining 5,180 prefix reads are still more than the reference's 2,319:
4,152 enumerate comparison entries in the structural tree and 1,028 position
those traversals. The navigation set contains 275 distinct semantic keys and
753 repeated reads. The largest concentration is a 32-member missing-arm
series case, where the same later surroundings are traversed once per actual
write to retain member-major/read-major failure order. This is genuine
residual traversal work, not full-root reanalysis: pair checks remain equal.
It is also not evidence of a runtime regression without a runtime benchmark.
No further cache or traversal index is justified by this checkpoint.

## Validation basis

- The final-review red witness reused one enclosing record recipe in both
  Choice arms. The new case failed before repair because the active arm's
  nested capture lost its target, while the existing four passed; all five pass
  after the per-parent repair.
- The pre-repair CS04 campaign archive is preserved but superseded. Fresh
  post-repair full-campaign closure remains the CS04 acceptance boundary.
- Final candidate structural receipt:
  `/var/folders/2c/xh5rx2d91wd_lk8rvnnhlr4m0000gn/T/viborm-raptor3-g0-UUKxtm`
  — production `36103eff…`, harness `87bc63c2…`, instrumented production
  `dd86a5e6…`, Node 24.21.0, 28 cases, 60 replays, 0 skips, and a successful
  wrapper. Earlier candidate receipts remain supporting evidence for their
  exact pre-repair identities only.
- Final reference structural receipt:
  `/var/folders/2c/xh5rx2d91wd_lk8rvnnhlr4m0000gn/T/viborm-raptor3-g0-JzSNb2`
  — the same 28 cases and 60 replays.

## Risks

- The source-size premium is permanent and should be accepted explicitly; the
  candidate is not a source-compression result.
- The occurrence tree performs more prefix traversal than the flat history.
  The current evidence supports correctness and ownership, not a bundle-size
  or runtime-speed claim.
- Final adoption still depends on the registered CS04 qualification running
  against the frozen uninstrumented candidate source. Temporary measurement
  hooks are not production code and are excluded from the census.
