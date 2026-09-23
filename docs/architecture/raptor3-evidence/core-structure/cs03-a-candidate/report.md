# CS-03 candidate extension A

Status: **candidate A checkpoint complete on the accepted peer-scope baseline.**

## Outcome

The candidate implements the frozen private relation-bearing `updateMany`
terminal-selection contract. Admission still refuses scalar-only selection,
`omit`, `include`, relation projection, and every `limit`. Relation-bearing
updates prepare and execute every selected member before one terminal read of
the final complete identities. Missing terminal rows fail at the shared result
boundary; interactive execution rolls back, while atomic batch execution keeps
the three completed members and records result-phase progress.

The result owner is shared with existing record-series completion. Selected
series preserve their existing update/delete discriminant through placement and
execution, so update final identities are statically owned without a downstream
member-kind check. This is the existing command language, not another runtime
interpreter or registry.

The exact production delta from the accepted candidate scope baseline is
[`cs03-candidate-a.patch`](../cs03-candidate-a.patch), SHA-256
`2938c91b758d2c0db9e0ce2ce63ae04aa71b24b8996bfb535324a44c01818879`.

## Validation

- `CaV95z`: corrected extension-A contract **5/5**, zero skips.
- `r7xwr6`: accepted member-scope contract **8/8**, zero skips.
- Both bounded receipts use Node 24.21.0 and production identity
  `2464c330231eb55ce5c48707085464dd889c396f620316f3b05f7b153cfb70ea`.
  Their harness identity is
  `6cce5d45aff555110eeeb3bf61139e6181cb68d6c7cdab1083b996d2fc9de07d`.
- The whole-estate typecheck has no candidate-A error. It retains only the two
  historical Pattern TS2345 diagnostics and the isolated task-worktree
  `tests/pattern/pack/program-dump.ts:131` TS2532 diagnostic.
- The A patch applies cleanly to the exact scope baseline.
- The frozen witness SHA-256 is
  `473be8e0e3d6c3b1ce567b59d45bab3d84d1bd2ba354d82fa0cb4c9416294d9d`.

The corrected progress oracle is three, not two: two outer selected update
members and one nested selected delete member cross the existing recursive
member ledger. The original 2-member failure and the independent reference
observation remain preserved as oracle-development evidence.

The [cost receipt](./cost.json) charges **+104 code-bearing lines, +603 parser
tokens, and +3,670 source bytes** in both the core and broader scopes. No
compression saving is claimed.

## Risks

This checkpoint qualifies candidate A only. Extension B remains isolated from
this delta, and composition is not yet qualified.
