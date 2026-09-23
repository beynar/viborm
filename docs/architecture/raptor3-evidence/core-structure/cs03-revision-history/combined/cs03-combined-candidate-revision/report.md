# CS-03 candidate extensions A+B — feature-only checkpoint

Status: **candidate composition checkpoint complete; seeded comparison remains active.**

## Outcome

The candidate composes the independently measured terminal reader and mutation
limits through the existing command, query, adapter, and operation-context
owners. A capped relation-bearing `updateMany` prepares the capped members,
executes their nested series and choice effects, and then reads final selected
values. `limit: 0` remains SQL-free and member-admission-free. Scalar limits
remain one set statement.

The first combined package is preserved but disqualified from cost comparison:
109 unrelated formatter hunks reduced its charged line and token counts. The
exact feature-only production delta is
[`cs03-candidate-a-b-feature-only.patch`](../cs03-candidate-a-b-feature-only.patch),
SHA-256
`fc1191787d450ebcf1a71860a8542287da4457aa828ab1862fdd71667c867087`.

## Validation

- `VOMZ4Y`: extension A **6/6**.
- `vLPxxl`: extension B **4/4**.
- `h3yrcj`: extension composition **4/4**.
- `R30AvK`: peer-member scope **8/8**.
- These source-bound runs use Node 24.21.0 and the feature-only production
  identity `14cbc7caf5083ccb5532a71f64e7bca4bf884a20cc3d5210be1f847b6db6a700`.
- Whole-estate typecheck has no production error. A later native-witness typing
  repair removed its test-local errors without changing production or runtime
  assertions; final campaign qualification will bind the frozen harness.
- The patch applies cleanly to the exact accepted scope baseline and contains
  sixteen feature-owner hunks.
- Independent fairness review reproduced both patch and census at
  `/tmp/viborm-cs03-reference.dRRksW/reviews/cs03-extension-cost-fairness.md`,
  SHA-256
  `2940a2418c536ce4e5fd384de7acb84d242e2d0f8a4b84e54de445e775be55fc`.

The [cost receipt](./cost.json) charges **+103 code-bearing lines, +670 parser
tokens, and +3,557 source bytes**. The reference composition costs
+100/+680/+3,488. The candidate therefore demonstrates no material marginal
extension-cost advantage. The complete endpoints are candidate core 6,592
versus reference core 6,172, and candidate broader 10,666 versus reference
broader 10,246: a 420-line gap in both scopes.

## Risks

Focused and native behavior is green. Frozen seeded A, B, and composition
campaign evidence is still required before CS-03 comparison acceptance.
