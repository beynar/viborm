# G3-02 independent execution review follow-up

Date: 2026-09-14. Reviewer: independent Sol 5.6/high review agent.

## Outcome

**ACCEPT G3-02.** This follow-up supersedes the earlier `REVISE` verdict for
this unit without rewriting its red evidence. The bounded repairs close the two
confirmed execution defects and remove the duplicate bind-partition rule. They
do not add a command language, scheduler, attempt journal, result protocol, or
public transaction capability.

The repaired ownership is coherent:

- `OperationContext.setMutation()` delegates to `setMutations()`. A standalone
  driver with native batch capability sends the complete scalar statement
  window through the existing `queue()` / `submit()` attempt. One set-oriented
  window remains one semantic write member. A provider acknowledgement followed
  by decode failure is therefore reported at the existing result boundary with
  the acknowledged segment and write member preserved.
- Borrowed interactive execution and standalone native batch execution both
  reach the same typed-statement capacity owner. The existing
  `DriverInstrumentationBase.applyTrustedStatementTransforms()` now checks the
  final typed `Sql` whether or not a transform exists. Deferred observed batches
  still materialize there. `_executeRaw()` remains separate, and no capacity
  guard was copied into Raptor 3.
- Create statement groups and terminal key reads both reuse
  `compileBindBudgetChunks()`. Accepted terminal `Query` values are associated
  with their exact compiled `Sql` objects through a lexical `WeakMap`; rejected
  binary-search probes are not retained. There is no cache or second partition
  owner.
- Selector preparation remains single-owned. Replacing five temporary feature
  refusals with required G3 behavior is feature completion, not decision
  deletion. The demonstrated rule reductions are the duplicate selector
  preparation and the duplicate bind-partition loops.

The earlier review's arithmetic finding is withdrawn. The accepted G3 scalar
subset is `set` and `increment`; the G3 preparation inventory assigns full
arithmetic and scalar-list breadth to G4. The corrected independent witness
therefore tests simple and compound final-key transitions with omitted public
keys under the admitted subset. It does not turn `decrement`, `multiply`,
`divide`, or list mutation into a G3 promise.

## Validation

The complete pre-type-repair runtime group is preserved under
`g3/unit02/review-green-before-types/`. Its thirteen source-bound Raptor modes
used production identity
`e012e69af11a73bdb4314d6aeaf7f7a4f17add598f93d9450728fa429c9d6d31`,
harness identity
`724747608bbe69aa0bfb2a00d297efc196d4cf36c0a0656f15101f02720f7238`,
and Node 24.21.0. Results were:

- author regressions 2/2 and independent execution review 5/5;
- the affected contract group 33/33 and depth recurrence 6/6;
- native PostgreSQL 2/2 on port 51436 and MySQL 2/2 on port 51439;
- generated smoke 5/5, registration self-test 26/26, statement-transform
  integration 5/5, and protected statement instrumentation 11/11.

The Raptor modes retain exact `verified.json` and `vitest.json` receipts. The
three direct checks did not originally persist raw output and are not relabeled
as raw artifacts.

After test and generator typing repairs, the two decisive modes were rerun on
the same production identity and harness identity
`dd03677e01dc917352fbc8fd05f80e0bb270e9701626c4634bbb95fbbb80b639`:

- `g3-author-execution-regressions`: 2/2, no skips;
- `g3-execution-review`: 5/5, no skips.

Their exact receipts are under `g3/unit02/type-repair/{author-pass,review-pass}`.
The fresh whole-estate typecheck log is
`g3/unit02/type-repair/typecheck-run.log`, SHA-256
`26e12f0aa4c05308ec98a0c40081f1827faa865a742a8faef6530ee0d9caa20f`.
It records only the two historical Pattern `TS2345` diagnostics, ran for 18.54
seconds, peaked at 5150.3 MiB under the 8192 MiB ceiling, and verified teardown.
It replaces the earlier non-persisted typecheck observation; it is not a
reconstruction of that output.

The final focused source hashes are:

- independent witness: `c89a44b6d85d59e8954d0982de3443196ead55da0756f50a8702d1ec1a637b6b`;
- author regressions: `d78075f994c9007e1fa02eb2b78b64c6848afd6e128b5fee2f088eb230e9a00a`;
- driver capacity owner: `2edd1b7d77e7836314b3f3aaeae677c490f75a3dceffa45d6db0e1f85e9f7e74`;
- operation context: `c1e19aad66da4ed5bdb48e1f777df83505d5e6ada14034826a229fe25dd2b852`;
- bind-budget owner: `4c0d84dd0ec7af8c1a6e5c67ee883d33542749d4d1c91565eebda22be0ecb265`.

## Risks

The original review incorrectly said `src/query-engine/bind-budget.ts` was
already included in the Commands candidate's private charged files. It was
charged to the old-engine census, but it is absent from
`privateCandidates.candidates.commands.files`. Because G3-02 now imports that
neutral owner, the final candidate accounting must include the whole file. The
provisional 6,987 core / 11,862 broader token-line figures exclude it and are
not final cost claims. Final accounting belongs to the next frozen source
census.

This accepts only G3-02 production and its bounded execution contracts. The
late/closed-scope, ambiguity, recovery, depth/variant generation, and campaign
matrices remain G3-03 and G3-04 obligations. No G3 completion or global
qualification follows from this unit verdict.
