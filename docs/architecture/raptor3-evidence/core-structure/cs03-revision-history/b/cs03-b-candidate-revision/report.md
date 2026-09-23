# CS-03 candidate extension B — feature-only checkpoint

Status: **candidate B checkpoint complete on the accepted peer-scope baseline.**

## Outcome

The candidate implements the private mutation-limit contract through the
existing adapter capability, query lowering, operation context, and selected
series. Scalar `updateMany` and `deleteMany` remain one set statement. A native
mutation suffix or complete-key capped subquery applies the limit. A
relation-bearing `updateMany` caps capture before dynamic member admission and
effects. `limit: 0` returns after ordinary operation admission and before SQL or
dynamic member admission.

The first B package is preserved as historical evidence but is disqualified
from cost comparison: formatting unrelated to B removed 32 charged lines and
115 parser tokens. The exact feature-only production delta is
[`cs03-candidate-b-feature-only.patch`](../cs03-candidate-b-feature-only.patch),
SHA-256
`5938949d38e9f5466ee71800b4de57592de9e8a15f35e75bcf1f75ee55426889`.

## Validation

- `UX0dkC`: extension-B contract **4/4** on an isolated exact scope-baseline
  reconstruction, Node 24.21.0, production identity
  `79bb8fc4802fb27d9d85bb6b40871e2e23aa775579cacba066a67ae3e0fa8d0a`.
- The patch applies cleanly to the exact accepted scope baseline and contains
  nine feature-owner hunks.
- PostgreSQL and MySQL native limit witnesses pass on both alternatives. The
  candidate receipts are `tKXC0s` and `ICO5ua`.
- Independent cost review reproduced the feature-only patch and census:
  `/tmp/viborm-cs03-reference.dRRksW/reviews/cs03-extension-cost-fairness.md`,
  SHA-256
  `2940a2418c536ce4e5fd384de7acb84d242e2d0f8a4b84e54de445e775be55fc`.

The [cost receipt](./cost.json) charges **+47 code-bearing lines, +377 parser
tokens, and +1,612 source bytes** in both owner scopes. The reference B delta
is +46/+390/+1,612. No material marginal cost advantage is demonstrated.

## Risks

This is the standalone B checkpoint. Its composition with A is measured and
validated separately.
