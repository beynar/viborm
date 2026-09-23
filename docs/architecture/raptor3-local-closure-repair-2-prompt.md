# Raptor 3 — close the three recorded gaps of the consumption-boundary checkpoint (Arnaud, 2026-09-22)

Review of `88fe2814b` (the consumption-boundary repairs). I would close all three now, in one bounded checkpoint. The first is unfinished correctness work — not an acceptable consequence of deferring hosted tests.

## 1. Batch reference reuse: must fix

The code confirms the gap: batch execution bypasses the current-row confirmation and can retain stale reference values.

- Add the recycled-key schedule to the existing local forced-batch fixture. No hosted credentials needed.
- Resolve the consumed reference through the existing query/reference owner, pinned to the captured complete identity.
- Do not blindly copy folded `connect`: its selector-based subquery could itself adopt a replacement row.
- Cover compound references, disappearance, NULL transitions and concurrent reassignment. Preserve missing-arm recovery and transaction authority.

Exit: the operation connects the intended row or fails correctly; never another row. No blanket refusal.

## 2. Dual-condition attribution: make the error truthful

Keep the single combined confirmation. Do not add round trips merely to identify which condition failed.

When several conditions were conjoined, report that a matched requirement changed — not that the first condition specifically failed. Preserve precise attribution when only one condition exists.

Add tests for first-only, second-only and both conditions changing. Assert the error, unchanged database state and absence of the consuming write.

Pinning a knowingly incorrect diagnosis would preserve the defect, not solve it.

## 3. MySQL defaults: finish the shared literal boundary

There are two remaining defects here:

- Enum escaping: `mysqlEnumType` still duplicates string-literal spelling instead of using `mysqlStringLiteral`. Consolidate that rule and verify the catalog inverse.
- Unicode defaults: establish where encoding is lost, then correct that exact boundary. Do not apply a speculative global Latin-1-to-UTF-8 conversion.

Require native push, no-op repush and raw-INSERT checks with Unicode and escaped enum values. Keep unsupported SQL modes outside scope.

## Workflow (as before)

One production author for the coupled engine interfaces (items 1 and 2, in that order); a separate migrations author for item 3; an independent adversarial review per unit on stable source, a bounded repair and re-check; one integrated review; then one frozen local gate (the full registered inventory, native MySQL and PostgreSQL included), the affected performance cells re-measured, the footprint and the recount, a dated verdict, one task-scoped Conventional Commit. Preserve every decision and accepted limit of the previous checkpoints; no new interpreter, no wider replay, no blanket refusal. No push.
