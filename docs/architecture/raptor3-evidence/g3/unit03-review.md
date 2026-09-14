# G3-03 independent review

## Verdict

**REVISE.** The frozen production implementation was not rejected by this
review. The generated evidence layer was not ready for qualification because
two SQLite scenario oracles did not yet prove the state/result properties they
claimed, and real campaign failures were captured but not minimized through the
existing shrink owner.

This is a review of the G3-03 harness and coverage design. It is not a G3-04
qualification result and it makes no runtime, provider, or campaign-completion
claim.

## Reviewed boundary

The review covered the generated recipe, SQLite and scripted-transport worlds,
campaign failure capture, exact replay reconstruction, the representative
C08-C11 smokes, and the fixed G3 placement witnesses. The original weak oracle
sources are preserved byte-for-byte at
[`unit03/review-oracles`](unit03/review-oracles/):

- `bulk-scenario.before.ts`: SHA-256
  `e348326cababab1eb01af203503f3483d6fe7327bf732f3d2d31b502fd6df54d`.
- `transaction-array-scenario.before.ts`: SHA-256
  `0ed57607ccc60ed57b2b227f51fb094fa15e5974fc2b158c78133fccb3b69974`.

The preserved development attempts are evidence of harness faults, not
qualification receipts. In particular, `unit03/sqlite-red` records 5/6 with a
candidate-execution accounting failure; `unit03/transport-red`,
`unit03/transport-compound-red`, and `unit03/transport-c11-red` record successive
scripted-transport failures. `unit03/sqlite-green` records the later 6/6
development smoke on the still-unaccepted oracle snapshot. None is relabeled as
post-review acceptance.

## Required corrections

1. **C08 persisted-state and result ownership.** The original bulk oracle
   checked only the create row count, the update/delete affected cardinality,
   the type of a count result, and field types in selected/omitted rows. It did
   not prove exact created values and defaults, preservation of untouched
   fields, the numeric count value, or equality between returned rows and the
   rows actually inserted, changed, or deleted. The corrected oracle must derive
   those facts from fixture-owned raw initial/final state and the admitted public
   input. A limited update/delete may affect an arbitrary eligible subset, but
   the returned identities and fields must equal that actual subset.

2. **C10 package/result isolation.** The original transaction-array oracle
   checked outcome kinds, absence of late work, and presence of a healthy
   recovery row. It did not prove exact packaged member and peer rows, nested
   member result windows, rollback of the failed atomic package, or the exact
   final state. The corrected oracle must use the existing
   `memberCount`/peer/recovery/late partition as one small expected ledger and
   compare the public results and authoritative raw state exactly.

3. **Real failure minimization.** Both campaign owners preserved the original
   active recipe/profile and, when available, its raw record and tape. Neither
   invoked `shrinkG3Recipe` for an actual failed property. The existing shrink
   smoke used an always-true predicate and therefore did not prove that a padded
   failing cell retains the same failure and exactly replays after reduction.
   Reuse the existing shrink owner at the campaign failure boundary, keep the
   original failure, and save the reduced recipe plus a fresh replayable record
   when available. Minimization failure must remain visible rather than replace
   or conceal the original failure.

## Accepted design facts and limits

- The 8000-17999 recipe range is deterministic and gives each admitted profile
  10,000 cells. Each 100-seed block has 25 cells per C08-C11 family, 20 two-actor
  cells, and 20 injected-fault cells.
- Actor and fault quotas are disjoint (`seed % 5` is `0` versus `1`). This
  satisfies the two literal minima but does not prove concurrent two-actor fault
  composition. Fixed witnesses own that claim.
- Generated C11 depth is limited to 0-4. The fixed depth 1/2/8/32 witness owns
  the deeper recursion claim. Repeated, compound, and variant generated worlds
  supplement their representation-specific fixed witnesses.
- SQLite uses a real persisted-state oracle and exact three-time same-source
  replay. Scripted transport is only a schedule, correlation, acknowledgement,
  and failure supplement: it checks request sequence/action/cardinality and one
  public actor value, not full SQL parameter or database-state semantics.
- The campaign catch path correctly preserves the available failing cell before
  this review's required shrink addition. It must continue to retain the
  original after minimization is added.

## Already confirmed harness repairs

The first smokes exposed three harness-routing defects: the candidate wrapper
did not count/forward `prepareBatch`, the atomic-array operation retained its
unrelated inherited scalar `prepare`, and `ScriptedTransport.finish` read the
retired `scripts` property. The bounded repairs use the existing preparation and
transport owners: forward/count `prepareBatch`, explicitly disable the unrelated
scalar preparation for the packaged member, and consistently read
`actorScripts`. The later C11 transport scripts must describe the actual single
operation batch rather than invented segmented packets. These changes require a
fresh frozen-source smoke; earlier receipts remain development evidence only.

## Acceptance boundary

G3-03 can be accepted after the three required corrections receive independent
source review and the repaired representative SQLite 6-test and transport
1-test modes pass on one frozen source identity with exact three-time replay.
Full 10,000-seed/profile campaigns, providers, type checks, cost, and archive
integrity belong to G3-04.
