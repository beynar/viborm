# Static series completion: independent review

## Outcome

**REVISE** the frozen unit at production
`7ca1b0a17c17794928fab9a23c9e0bf6f6d2bbe2b05bf2dd3a2d88e5cb6abc11`
and harness
`3d9977876d5b8c0c80aec1ea6902f34b39ea80ab52e07e7242a287312dd2b922`.

The root/nested completion repair is accepted. `executeRecords` owns only
member execution. Nested static series no longer finalize the operation or
queue scratch cleanup. Root `records` alone publishes either the constant
`{ count }` result or the selected collection. This preserves generated parent
key expressions through multiple roots and sibling series until the outer
terminal read, then queues cleanup once. Batch preparation records neither a
flush nor completed-member progress; live and borrowed execution retain both.
Dynamic reads and explicit result-bearing flushes still reach the existing
incomplete-preparation refusal.

One preservation defect remains. Both selected root callers now prepare their
projection before checking whether `identities` is empty. The removed
`completeSeries` owner returned `[]` without preparing or lowering a projection
when selection captured no rows or every suppressible member was skipped. The
new eager work can change failure timing and constructs a result program that
cannot be consumed.

The bounded correction is local in each caller: return
`context.finishMany([])` when `identities.length === 0`, before
`prepareProjection`. Build and lower the projection only for a nonempty
identity set. No helper or new preparation concept is warranted.

## Validation

On Node `v24.21.0`, the independent pre-repair checks were:

- `g3-author-execution-regressions`: 3/3 PASS;
- `g3p03-contracts`: 6/6 PASS;
- `g3-transaction-array`: 4/4 PASS.

The exact raw receipts are retained under
`independent/pre-lazy-empty/`. They bind the identities above and establish the
accepted scratch lifetime, count result, selected multi-terminal result,
missing-later-terminal failure, and existing dynamic preparation refusals.
They do not waive the remaining eager-empty defect and must not be relabeled
after its repair.

## Risks

No other consequential defect was found in this bounded unit. After the two
lazy empty branches are repaired, rerun the changed execution contract and the
existing empty selected/suppressed behavior before full qualification.
