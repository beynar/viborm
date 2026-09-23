# G3-02 bulk-result postfix: partial independent verification

## Outcome

The source review accepts the bounded correction. It does not qualify the
postfix because an unrelated validation chain held the workspace lock after the
first focused mode completed.

The correction keeps the existing execution model:

- `OperationContext.emptyBulkResult()` is the one owner of direct and prepared
  zero-width bulk results. Update and delete reach it before selector capture or
  provider work.
- A terminal `PreparedProjection` is built once and passed through
  `seriesQueries()`. Partitioning does not repeat projection preparation.
- Non-returning update and delete retain operation-specific lexical ordering.
  Their duplicate wrapper methods were removed; no generic mutation workflow
  or third result path was introduced.
- Unsupported G4 arithmetic remains outside G3 and still refuses before row
  capture. The postfix adds no scalar operator.

## Validation

`g3-bulk-result-boundary` passed 3/3 with no skips on:

- production identity:
  `c6c5e9193234b18b2e570df835069599d87b6167fc853bc0ba41a2356486ed41`;
- harness identity:
  `e32dbce214349579d6aeb54787cf117d190a8db3cc47c48b69dce1cddaea6bfe`;
- Node `v24.21.0`;
- 7.81 seconds wall, 462.0 MiB peak sampled process-group RSS, verified
  teardown.

`pass/` contains the exact runner `attempt.json`, `verified.json`, and
`vitest.json`. The test source SHA-256 is
`8c41456cfb76d0de22019d9d73e65f297020cac29ae34c026b47f3d079e1dfa7`.

The seven files under `lock-refusals/` are exact runner attempts. They record
refusal to overlap unrelated coverage, layer-wide Vitest, and typecheck
processes. They are infrastructure evidence, not failed test evidence.

## Risks

The following postfix checks remain unrun on this identity:

- independent review 5, bulk 6, transaction array 4, composition 4, and scope
  failure 2;
- native PostgreSQL 2 and MySQL 2;
- whole-estate typecheck with a durable log;
- the fresh source census that charges `bind-budget.ts` whole and separates
  existing-owner charge from the genuine postfix source delta.

No unit qualification or cost conclusion follows until those checks complete
on one stable source graph.
