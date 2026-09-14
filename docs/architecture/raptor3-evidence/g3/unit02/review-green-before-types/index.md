# G3-02 independent review: green runtime group before type repair

This directory preserves the exact `verified.json` and `vitest.json` files
emitted by the frozen Raptor 3 runner. Every receipt binds:

- production: `e012e69af11a73bdb4314d6aeaf7f7a4f17add598f93d9450728fa429c9d6d31`
- harness: `724747608bbe69aa0bfb2a00d297efc196d4cf36c0a0656f15101f02720f7238`
- runtime: Node `v24.21.0`

The preserved modes pass 55 assertions:

| Mode | Assertions |
| --- | ---: |
| `g3-author-execution-regressions` | 2 |
| `g3-execution-review` | 5 |
| `g3p03-contracts` | 6 |
| `g3-bulk-series` | 6 |
| `g3-suppression-retry` | 2 |
| `g3-transaction-array` | 4 |
| `cs01-extension-composition` | 4 |
| `g3p04-review-contracts` | 5 |
| `g27-contracts` | 6 |
| `g3-depth-recurrence` | 6 |
| `g3-scope-composition-pg` | 2 |
| `g3-scope-composition-mysql` | 2 |
| `g3-generated-smoke` | 5 |

Additional bounded checks passed in the same serial freeze but did not emit a
raw artifact, so they are deliberately not represented as raw receipts here:

- registration self-test: 26 assertions
- statement-transform integration: 5 assertions
- protected statement instrumentation: 11 assertions

The whole-estate typecheck also did not persist stdout. Its observed exit was
non-zero with 14 diagnostics. This is a review summary, not a reconstructed raw
artifact:

- historical production: `src/query-engine/pattern/pack.ts:1443:36` and
  `:2633:58`, `TS2345` twice;
- obsolete test-driver call: `tests/raptor3/g3/author-execution-regressions.test.ts:26:60`
  and `tests/raptor3/g3/review-execution-boundaries.test.ts:31:60`, `TS2554`;
- incomplete `CandidateEngineFactory` fixtures:
  `tests/raptor3/candidate-ordering.test.ts:47:3`,
  `tests/raptor3/candidate-pagination.test.ts:37:3`,
  `tests/raptor3/candidate.test.ts:42:3`, and
  `tests/raptor3/transport.test.ts:229:13`, `TS2322`;
- paused generation work:
  `tests/raptor3/g3/generation/recurrence-variant-world.ts:144:22` and
  `:147:22`, `TS2345`, plus
  `tests/raptor3/g3/generation/transaction-array-scenario.ts:47:39`
  (`TS18048`), `:123:15` (`TS2345`), `:256:62` and `:267:23`
  (`TS2339`).

No production diagnostic was introduced by G3-02. Final acceptance remains
pending a fresh typecheck after each owning test or generator repairs its own
diagnostic.
