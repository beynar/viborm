# G3-04 source and cost report

## Measured scope

The final source census is `support/source-cost.json`. It uses the existing
parser-owned `tokenLines` definition: distinct source lines that contain a
TypeScript token start, with comments, JSDoc, and EOF excluded. Whole owners
are charged without a symbol-level or proportional discount.

The command candidate language is 7 files, 3,199 token lines, and 106,726
bytes. Its 5 shared owners are 3,756 token lines and 124,792 bytes. The core
candidate plus shared boundary is therefore 12 files, 6,955 token lines, and
231,518 bytes. This is 357 token lines above the 6,598 comparison baseline and
32 below the 6,987 interim measured core. Genuine whole-owner source growth is
359 token lines. The final scope also charges 846 existing lines that were not
in the earlier retained perimeter: 799 from the driver instrumentation owner
and 47 from the bind-budget owner.

The broader retained perimeter increased from 10,672 to 11,877 token lines. Its
final size is 30 whole files, 14,514 physical lines, and 501,048 bytes. This is
a scope-enlarged perimeter and is not compared as if it had the 12-file core
denominator.

## Actual parser tokens

`tokenLines` is not a token count. The separate parser-leaf traversal in
`support/parser-token-census.json` reports 43,457 actual parser tokens for the
12-file core and 72,459 for the 30-file broader perimeter. It uses the same
TypeScript leaf ownership and excludes JSDoc and EOF.

## Newly charged boundaries

The retained census charges `src/drivers/driver-instrumentation.ts` and
`src/query-engine/bind-budget.ts` whole. The unchanged
`src/drivers/bind-parameter-capacity.ts` remains governed by the established
unchanged-leaf rule. Historical CS-04 artifacts and their denominators are not
rewritten.

The exact G3 task patch is `source.patch`. `source-allowlist.json` binds that
patch to baseline commit `26e4f78378e5f545c694c8bc3789201db7f5926a`, the
57 task-owned source files and their SHA-256 values, and the frozen production
and harness identities. Unrelated dirty files and root-owned plan/status files
are excluded.
