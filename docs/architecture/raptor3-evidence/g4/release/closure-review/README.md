# Final closure review — 2026-09-20

This is an adversarial review receipt, **not a qualification or implementation
receipt**. Production source was not changed. The implementation handoff is
[raptor3-final-closure-handoff.md](../../../../raptor3-final-closure-handoff.md).

## Identity and method

- Branch: `pattern-engine`.
- HEAD: `320c898f1f97965f9ad411945e545f12bbaa3499`.
- Node: `v24.21.0`; Vitest: `3.1.4`.
- Tracked local changes during validation: unrelated `CONTEXT.md` and `memory.md`.
  Both were preserved. Historical untracked evidence was also preserved.
- One independent read-only review each covered command correctness, semantic
  compression, and release/decoder evidence. The root traced the findings and
  executed the probes serially through the resource-bounded test launcher.
- No native PostgreSQL/MySQL tests, hosted provider tests, full qualification,
  typecheck, or performance benchmarks were run for this review. Historical
  measurements cited in the handoff are attributed to their existing receipts.

## Executed paired falsifiers

Each pair enters through the public client and runs real in-process SQLite.
The non-RETURNING case forces that capability on a SQLite test transport; it
is not evidence of an executed native MySQL test.

| Behavior | Control | Failing case | Observed result |
| --- | --- | --- | --- |
| Nested update followed by a selector that observes its result | Root `update` passes | The same payload under root `updateMany` | V7001: split the dependent nested operations into separate queries |
| Captured-set exclusion during a delete with relation projection | Scalar named `flag` passes | Otherwise equivalent scalar named `NOT` | `EngineInvariantError`: filter operator `OR` is not implemented |
| Cascaded identity followed by the holder's own scalar update and selected result | RETURNING enabled passes | RETURNING disabled | `TypeError`: UPDATE did not produce the required record |

The retained final run is **3 passed / 3 failed**, exit 1, **3.33 s** launcher
wall time, **461.0 MiB** sampled peak process-group RSS, teardown verified.
This is evidence against the completion claim, not six successful pins.

See [paired-probes.log](paired-probes.log) for the exact output, command,
dependency-lock hash and launcher hash. The exact executed source is
[probes.test.ts.txt](probes.test.ts.txt), SHA-256
`a856cb32b16430de7d784b05aa45040245143872060b99ba81212bcef7cde634`.

For a diagnostic replay, restore that source to
`tests/raptor3/g4/parity/closure-review-probes.test.ts` in a task-local checkout
and run the command recorded in the log. Relative fixture imports assume that
location. For permanent repair witnesses, integrate the cases into the existing
registered suites and strengthen assertions for results, effects and failure
timing. The `.txt` copy deliberately remains outside test discovery: this review
does not silently add a failing unregistered suite to the user's working tree.

## Source-reviewed issues, not newly executed here

- The existing `captured-identity-domains.test.ts` explicitly expects failures
  for valid noncanonical SQLite TEXT DateTime keys. A green expected-failure pin
  records the T3 residual; it does not repair the capability.
- N5's note records that a found `connectOrCreate` can bind a NULL reference and
  disconnect its holder. The current NULL guard is confined to parent-held
  plain `connect`. This needs a shared reference-representability requirement.
- Captured-set premises queued ahead of an ID-only mutation need a local native
  PostgreSQL concurrency falsifier. A preceding nonlocking SELECT and a later
  successful row count do not alone establish consumption-time membership.
  The precise required predicate must be taken from the operation contract:
  not every initial collection selector is a lasting member requirement.
- The release's "23 public refusals" means unmatched error sentences relative
  to the old-engine corpus, not all refused valid operation families. The same
  census reports 71 inherited sentences, includes integrity/provider failures,
  and has an indirect-error-origin gap. Error class is not a reachability proof;
  the executed `NOT` case reaches an allegedly unreachable invariant.

## Assessment

P1 removes real decoder work and its saved calibration measurements support the
reported improvement. No P1 correctness regression was established here. It
still allocates `Object.keys(shape.fields)` per decoded document, and its own
note requires a committed-tree protocol comparison before quoting a qualified
release number.

The occurrence structure, composed owners and dispatched-unit scratch lifetime
remain useful foundations. The findings identify misplaced or duplicated facts
at those boundaries; they do not establish the need for another engine rewrite.
The next checkpoint should execute more valid compositions, repair local
correctness and remove demonstrated duplication. Hosted qualification is
explicitly deferred by Arnaud and is not its completion gate.
