# G3 structural-correction source cost

## Outcome

The current 12-file core contains 6,927 code-bearing token-lines, 43,383 true
parser tokens, and 230,397 bytes. The complete 30-file charged perimeter contains
11,849 token-lines, 72,385 parser tokens, and 499,927 bytes.

Against the accepted unit04 measurement, both scopes remove 28 token-lines,
74 parser tokens, and 1,121 bytes. The change is structural source compression.
It is not a runtime, allocation, bundle, or package-size result.

## Validation

`support/source-cost.json` is the complete current source-cost report.
`support/parser-token-census.json` records every charged file and uses the same
TypeScript leaf-token traversal as `scripts/query-engine-structure.mjs`:
`getChildren`, `FirstToken` through `LastToken`, excluding JSDoc and EOF. The
method reproduces the historical 1,031-token `assignments.ts` control exactly.

The working tree is intentionally dirty because it contains the frozen task
patch. The report records baseline commit
`cf2cbc4e6eed445816e70b0d98ca117db90c86b0`; clean Git state is not an identity
claim. `support/final-identity.json` and `support/frozen-identity-manifest.json`
own the executed source/harness identity.

## Risks

- A lower source count does not prove faster execution or a smaller distributed
  bundle.
- Low bind-cap witnesses can increase physical statement and terminal-query
  count; that trade-off is retained for correctness.
