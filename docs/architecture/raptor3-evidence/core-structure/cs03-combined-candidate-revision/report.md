# CS-03 candidate extensions A+B — feature-only checkpoint

Status: **candidate composition selected for CS-04; final acceptance remains conditional.**

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
`1555503911cd67225b0204f85c43531e563b0232c834b0a10a343e4149d8b0eb`.
The separate foundation cleanup is
[`cs03-candidate-foundation-cleanup.patch`](../cs03-candidate-foundation-cleanup.patch),
SHA-256
`ed06174aac78b517c2fb953d1af486f76bb38ff1c3e72accdf4c088b2dcd5608`.

## Validation

- `4CjKYV`: extension A **6/6**.
- `7GjVp5`: extension B **4/4**.
- `eerthk`: extension composition **4/4**.
- `jWDrCQ`: peer-member scope **8/8**.
- `diJmpH` / `cVOn2g` / `U62JMG`: structural **10/10**, choices
  **10/10**, and member dependencies **14/14**. `G5M6s3`: G2 **216/216**.
- Seeded campaigns `VMW01B`, `Ehc0of`, and `fzXTJX` each completed 200
  cases and 600 exact replays with zero skips. Saved-corpus replays `PUzMYt`,
  `3VXdXc`, and `V2ARPp` passed. Strict reference comparison is exact.
- Those campaign receipts bind the source-equivalent pre-registration identity
  `c51995d5aa1ecd76dfc8526358f7b586189ada1da33ee52c25c002fd89674b68` /
  `3d5a08be2c6f852e4690ab99ef3d2b0534d626b7ba4263aa8a5d5eb88ca5f119`
  and remain preserved. The final registered source is production
  `d7f14cc5973eb25e8ab80678bd55dfcb424e2a837907ce1f4c3728b1bbf66922`
  and harness
  `4b4783d8926b943a07066dc741106ea9caeeabc9ca35c58042f1d3cca2c2c18f`,
  under Node 24.21.0.
- Final registered structural receipt `6IGp8V` passes 28 measurement cases and
  60 exact same-build replays with zero skips. It records 5,180 prefix reads,
  including 1,028 navigation reads, after the bounded branch-ancestry reuse;
  pair checks remain 1,657 and owner scans remain zero.
- Whole-estate typecheck has no production error. A later native-witness typing
  repair removed its test-local errors without changing production or runtime
  assertions; final campaign qualification will bind the frozen harness.
- The foundation patch applies to the exact scope baseline. The feature patch
  then applies and reverses cleanly to reproduce the frozen source.
- Independent fairness review reproduced both patch and census at
  `/tmp/viborm-cs03-reference.dRRksW/reviews/cs03-extension-cost-fairness.md`,
  SHA-256
  `2940a2418c536ce4e5fd384de7acb84d242e2d0f8a4b84e54de445e775be55fc`.

The [cost receipt](./cost.json) charges **+109 code-bearing lines, +695 parser
tokens, and +3,747 source bytes** from the cleaned foundation. The separate
foundation cleanup costs +10 lines, -33 tokens, and +219 bytes. The reference
composition costs +100/+680/+3,488. The candidate therefore demonstrates no
material marginal extension-cost advantage. The complete endpoints are
candidate core 6,608 versus reference core 6,172, and candidate broader 10,682
versus reference broader 10,246: a 436-line gap in both scopes.

## Risks

Focused, native, seeded, saved-corpus, canonical-comparison, and final
structural-measurement behavior is green. Selection authorizes scoped CS-04
closure only; it is not final adoption.
