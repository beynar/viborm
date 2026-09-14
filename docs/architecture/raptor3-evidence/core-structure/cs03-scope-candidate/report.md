# CS-03 candidate peer-member scope unit

Status: **ACCEPTED for the isolated extension comparison after independent review.**

## Outcome

The candidate implements the approved peer-member rule through the existing
occurrence ancestry. A static record-series child, or a dynamic selected-series
occurrence with role `member`, does not treat earlier peer effects as writes
inside its own record body. The symmetric following-read traversal skips only
later peers at that same boundary, then continues to true reads after the whole
series. Outer-prefix checks, within-member order, branch activation, full member
admission before effects, member-union checks against later surrounding reads,
and exact published-parent exclusion remain unchanged.

The production delta is only candidate `commands.ts`: one ancestry predicate
and its two traversal uses. It adds no select-only
exception, acknowledged-write exemption, scope state, policy flag, retry,
authority, or public route. Extension A remains preserved separately and is not
applied to this scope baseline.

The exact production patch from accepted CS-02 is
[`cs03-candidate-scope.patch`](../cs03-candidate-scope.patch), SHA-256
`7f940223cc97af10da58b541fd726289f0e9bb02935464d64cfcbfdf6653a767`.
It reverses cleanly from the frozen candidate. Final source SHA-256 for
`commands.ts` is
`3189d88a6dcc98a83f1f727365c4462ee058666d579915aaeeb084cc75c6b9dc`.

## Validation

All runs used the fixed Node 24.21.0 binary and the bounded Raptor runner.

- `Yl62u8`: final-source causal member-scope gate **8/8**, zero skips,
  production
  `f151ae5892627324cd95a4e71655c7bf8e27f1aabecd890c920e610b219ae70d`,
  harness
  `b964803386e94baa16fee01c4b5c678b13cc3b6d1599d290abd94632fe739742`.
  The common witness SHA-256 is
  `824e33bc06b97891d240124b545efa3d8209f4d6cee4d36cf3c96a4ad996d265`.
  Its surrounding-read negative pins nested `n2` writer admission, its
  acknowledged effect, then the true outside-series `c1` reader admission.
  Interactive rollback and atomic-batch retained-prefix outcomes are distinct.
- `MzbQUL`: final-source G2 contracts **216/216**.
- `mmNJEA`, `RMkRph`, `SSQKKA`, `2w3v3P`, `MOtdMM`, and `uC3zhu`:
  final-source structural, history, member, choice, boundary, and result gates
  **45/45** in total.
- The final-source receipts above share the exact production and harness
  identities and fixed Node 24.21.0 runtime.
- The earlier whole-estate typecheck completed in 5.90 s at 5,855.8 MiB peak
  RSS. It found no scope or common-witness error and retained the two historical
  Pattern TS2345 diagnostics plus the isolated task-worktree
  `tests/pattern/pack/program-dump.ts:131` TS2532 diagnostic. It is supporting
  evidence from the earlier harness identity, not a final-harness receipt.
- The patch passes `git apply --reverse --check` on the frozen candidate.

The earlier receipts `RLsoSJ`, `gThP7l`, `NpWa56`, `R217ud`, and `lBrnL2`
remain preserved at full production identity `8bac94fe…`; they are not the
qualifying final-source receipts even though the scope owner was already
`commands.ts` SHA-256
`3189d88a6dcc98a83f1f727365c4462ee058666d579915aaeeb084cc75c6b9dc`.
Receipt `vDjFJM` likewise preserves the first causal-witness pass at the same
scope-owner SHA but the earlier harness identity. The development receipts
`Mbga5d` and `I9emL9` each recorded 6/8 because their
test fixtures respectively introduced a within-member collision and admitted
the supposed outside reader before the nested write. They are test-development
evidence, not production repair attempts. The final causal witness corrects
both fixture defects without a second production change.

The separate [cost receipt](./cost.json) records core and broader deltas of
**+12 code-bearing lines, +66 actual parser tokens, and +353 source bytes** from
the accepted CS-02 candidate. No extension saving is claimed.

The independently implemented flat reference passes the same causal witness
8/8 (`Yq7yfv`), G2 216/216 (`1HdK5l`), and its focused set 45/45. Its exact
production patch is
[`reference-scope-exact.patch`](./reference-scope-exact.patch), SHA-256
`731acbf84c8a6bf590445480783998a564e03eb740f22cbfc4a60b0edc9386b1`.
The normalized derivative [`reference-scope.patch`](./reference-scope.patch),
SHA-256
`a4a7efc57be42109fe89557cb0909e0dc2d5e80479e844993cdacef0bb72908e`,
differs only by the source artifact's final empty line. The census is preserved
in [`reference-cost.json`](./reference-cost.json), SHA-256
`46b50397cab421d0024e071b0d4886244fe72c5b1e80762968ac9c14fbed8cb1`.

The reference typecheck initially exposed a task-owned CS-02 measurement
collector narrowing defect. The exact
[`collector-type-narrowing.patch`](./collector-type-narrowing.patch) repaired
that harness owner without changing an executed route. The final
[`reference-typecheck.log`](./reference-typecheck.log) retains only the two
historical Pattern diagnostics and the isolated task-worktree `program-dump`
diagnostic. This separate harness delta is +9 code-bearing lines, +30 parser
tokens, and +224 bytes; it is not charged to either scope production
implementation.

## Risks

Both scope implementations are frozen and green. Independent review accepted
the unit after the final-source citation repair recorded in the separate
[review attestation](../cs03-scope-review.md). A/B and composition remain
unapplied.
