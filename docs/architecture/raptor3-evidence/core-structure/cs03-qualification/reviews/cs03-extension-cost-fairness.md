# CS-03 extension-cost fairness review

Status: **corrected candidate costs independently reproduced; old B and A+B
cost claims are not comparison evidence.**

## Baseline

The exact candidate peer-scope baseline is
`/tmp/viborm-cs03-scope-baseline.aqiAbY`. Its unchanged shared owners are
byte-identical to the reference peer-scope baseline:

- `shared/query.ts`: `b3fb03bfb0f2577506f3d5b7093dad095822bf171ec6880d5d4f11b6e0535817`
- `shared/operation-context.ts`: `418e47474d0d40a6871a87b5929148b52f9aa832305795f1a2a7d3f8dcd938d5`

This matters because the accepted CS-02 candidate semantic patch changed only
the five command owners. The old candidate B patch reformatted both unchanged
shared owners while adding B. That churn cannot count as structural economy.

## Reproduction

I applied each corrected candidate patch independently to the exact saved
scope baseline, then counted parser-owned TypeScript token-start lines, leaf
tokens excluding JSDoc and EOF, and whole-file bytes. The resulting four owner
hashes for A+B are the current candidate hashes:

- `commands.ts`: `31457b0febf5221d3976b3d9b8b62106e86ec35c23346a682c26d5a3240a8a11`
- `execution.ts`: `9d8db4f08ac71181a7aa80e75f55a7b9e5519ba124f275366bbe5db5113aa26b`
- `query.ts`: `6b0758c8eb88f4a60555b49785693c7a9a35ba9ec10a4b9e7dd24b3be2ad094f`
- `operation-context.ts`: `9664bcd3c8727a374e9ca21b0884970b8424115481fe7b063f0e794cd4f1528c`

The fair production deltas from each implementation's accepted scope baseline
are:

| Unit | Candidate lines / tokens / bytes | Reference lines / tokens / bytes |
| --- | ---: | ---: |
| A | +57 / +286 / +1,921 | +58 / +283 / +1,881 |
| B | +47 / +377 / +1,612 | +46 / +390 / +1,612 |
| A+B | +103 / +670 / +3,557 | +100 / +680 / +3,488 |

Candidate corrected patches:

- B: `cs03-candidate-b-feature-only.patch`, SHA-256
  `5938949d38e9f5466ee71800b4de57592de9e8a15f35e75bcf1f75ee55426889`
- A+B: `cs03-candidate-a-b-feature-only.patch`, SHA-256
  `fc1191787d450ebcf1a71860a8542287da4457aa828ab1862fdd71667c867087`

The old B patch contains 261 insertions and 246 deletions across the same four
owners, including
widespread trailing-comma and call-layout churn in `query.ts` and
`operation-context.ts`. The corrected B patch contains 61 insertions and 14
deletions, all in its
four semantic owners. The old +15 lines / +262 tokens / +1,185 bytes and old
combined +68 / +555 / +3,112 figures are therefore preserved only as failed
cost-accounting evidence.

The reference B and A+B patches retain their original baseline bytes and
contain only feature-owner hunks. Their raw changes are respectively 58
insertions / 12 deletions and 138 insertions / 38 deletions; no whole-owner
format pass is present.

## Conclusion

The corrected measurements establish no material extension-cost advantage for
either representation. Candidate and reference exchange a few lines and parser
tokens, while their byte costs are nearly identical. Any cheaper-extension
claim based on the old candidate receipts would be false.
