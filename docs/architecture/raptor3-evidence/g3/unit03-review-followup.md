# G3-03 independent review follow-up

## Verdict

**ACCEPT for the focused G3-03 harness unit on the exact identity below.** The
three defects recorded in [`unit03-review.md`](unit03-review.md) are resolved.
This does not accept G3-04, does not qualify production, and does not convert
the later CLI or type failures into passing evidence.

## Source-bound result

All accepted focused receipts bind:

- production:
  `5d7a639868789faff0cf0a2a04b11e846a91e4d82001c81277bf312ecb0c74c6`
- harness:
  `012570f2424e7acfcd777f7f24e92a594f292de6d654cb0b96efce23987f5a85`
- Node: `v24.21.0`
- Vitest: `3.1.4`
- SQLite driver: `12.6.0`

The frozen source review accepts:

- C08 bulk scenario SHA-256
  `d6302fe2526c1ff791f05a208bc3bd01440d19306faf6ca92a5d6bdd439580b7`.
  It now owns exact initial/final state, callable-default observations, complete
  create results/counts, preserved update/delete fields, and equality between
  the actual limited affected subset and returned rows or aggregate counts.
- C10 transaction-array scenario SHA-256
  `7a9c1b4bab990f8f075d43dfccaeba271ad8a6002ec2a262ea873cb2e6700796`.
  It now owns exact packaged-member, peer and recovery results; absence of
  unscheduled results; atomic rollback of the failed package; closed-scope late
  refusal; and exact authoritative final state.
- Failure minimizer SHA-256
  `a4e669519581a8d42637d35b74ef4ef40b03e727b9f640b1f5625bb970450a9b`.
  It identifies one stable named property by contract, profile, error name and
  optional code; applies only admitted reductions; retains the original; and
  requires the reduced failure to reproduce through each available exact replay.
- C11 transport-plan SHA-256
  `6c9fbe69a6c7c7e47f98134b12c76d00115afe8d0fd984ce8e6cbb77c2959ea3`.
  Ordinary and variant recurrence use their actual single operation batch;
  compound recurrence retains the actual lookup, two assertion reads, update,
  exact chapter inserts and terminal read; repeated recurrence retains the
  actual depth-spine batch, subsequent series-member batches and terminal read.
  These are scripted transport descriptions, not claims about a universal
  physical segmentation strategy.

## Focused evidence

| Mode | Result | Raw report SHA-256 | Evidence directory |
| --- | ---: | --- | --- |
| `g3-generated-smoke` | 6/6 | `1668a684006c8cd7569f4dca6de6a00a2ab9558f123dd28162a1c7bed3115cd6` | [`unit03/sqlite-strengthened-green`](unit03/sqlite-strengthened-green/) |
| `g3-generated-transport-smoke` | 1/1 | `6ad7fe5a1559f5a16c3722f2d570c60f8b65033ac5d740c5491d1c0f330eb097` | [`unit03/transport-green`](unit03/transport-green/) |
| `g3-generated-minimization` | 1/1 | `7683999399c42f02da9e7d2f6660d47460d3d9342673ae18c131bb5a0b1a9caf` | [`unit03/minimization-green`](unit03/minimization-green/) |

The transport test executes 13 representative recipes on both scripted
profiles and performs one recording plus three exact replays for each cell. The
minimization specimen starts with two actors, 32 operations and eight rows,
injects a wrong persisted row only after actual candidate work, and reduces to
one actor, one operation and one row while preserving `g3-c08:stored-state` for
three exact failing replays. The original padded input remains unchanged.

The earlier red and development receipts under `unit03/` remain unchanged.
They document candidate-execution accounting, retired transport property use,
and successive C11 script-shape corrections; none is relabeled as acceptance.

## Limits and subsequent changes

- Generated actor and fault quotas are disjoint. Fixed witnesses, not the seed
  count, own concurrent actor-plus-fault composition.
- Generated recurrence depth is at most four. The fixed depth 1/2/8/32 witness
  owns the deeper claim.
- Scripted transport proves schedule, request form/cardinality, correlation,
  acknowledgement, selected parameter provenance and failure behavior. It does
  not replace real SQLite/native persisted-state or full SQL-binding evidence.
- A failure without a stable named G3 property is retained with an explicit
  `not-minimized` reason. It is not called minimized.

After these receipts, the broader CLI run exposed real obsolete scope/CS01
assertions and the whole type check exposed task/harness diagnostics. Their raw
logs are preserved under `unit03/type-and-selftests/`. They are unresolved by
this focused acceptance and must pass on the final frozen identity before
G3-04 starts. Any repair that changes the harness makes the identity above
historical supporting evidence; it requires targeted review and fresh affected
receipts rather than relabeling this result.
