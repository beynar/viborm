# CS-03 candidate extensions A+B

Status: **candidate composition checkpoint complete on the accepted peer-scope baseline.**

## Outcome

The candidate composes the independently measured extension-A terminal reader
and extension-B mutation limits through the existing command, query, adapter,
and operation-context owners. A capped relation-bearing `updateMany` prepares
all captured members, executes only the capped set, runs nested series and
choice effects, then reads final selected values. `limit: 0` returns before SQL
or dynamic member admission. Scalar update/delete limits remain one set
statement and use the adapter's native suffix or complete-key capped subquery.

No public API, transaction, recovery, authority, or scalar-only projection
contract changed. The exact production delta is
[`cs03-candidate-a-b.patch`](../cs03-candidate-a-b.patch), SHA-256
`aaffaea550283ebcbfaf598d0275c2d38c173d4d68a44355f1e52866dbf7a8f5`.

## Validation

- `O54I2S`: extension A **6/6**.
- `RY76Vz`: extension B **4/4**.
- `DtJBeU`: extension composition **4/4**.
- `naHgA5`: accepted peer-member scope **8/8**.
- All four source-bound runs use Node 24.21.0, production identity
  `35f3f96b3723b86a643b0093459462655a1601a6f3189a26bf0dd30f15c01f03`,
  and harness identity
  `16d7b7dd525d354ff96524531f98e54424eea0657e912d45dc590946b6be44a3`.
- Whole-estate typecheck has no A, B, composition, or scope error. It retains
  only the two historical Pattern TS2345 diagnostics and the isolated
  task-worktree `tests/pattern/pack/program-dump.ts:131` TS2532.
- The patch applies cleanly to the exact accepted scope baseline.

The [cost receipt](./cost.json) charges **+68 code-bearing lines, +555 parser
tokens, and +3,112 source bytes** in both owner scopes. Standalone checkpoints
remain separately preserved: repaired A is +57/+286/+1,921, and B is
+15/+262/+1,185. The combined delta is measured directly; it is not inferred
by adding standalone costs.

## Risks

The focused private contracts are complete. Seeded cross-alternative campaign
evidence and native-provider execution remain required before the CS-03
comparison is accepted.
