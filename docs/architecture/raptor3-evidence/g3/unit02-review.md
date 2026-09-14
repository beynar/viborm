# G3-02 independent execution review

Date: 2026-09-14. Reviewer: independent Sol 5.6/high review agent.

## Outcome

**REVISE. G3-02 is not complete.** The implementation keeps the accepted
command language and adds the required execution behavior at the existing
`OperationContext`, `Queries`, and `CommandExecution` owners. The narrow
PostgreSQL/MySQL, suppression, package-window, depth, and bulk checks establish
useful slices. They do not cover two execution boundaries that the completed
C08-C11 claim requires. A focused review witness reproduces both defects.

### 1. Standalone batch-only scalar bulk bypasses its atomic route

`OperationContext.usesBatch` is true for a standalone driver without callback
transactions. The existing `queue()` / `submit()` path is the owner of native
batch dispatch, commit acknowledgement, uncertain-prefix attribution, and
result-phase failures. The new `setMutations()` helper uses that path only for
`batch-preparation`; every ordinary operation executes its statements one by
one through `_execute()` instead.

The focused witness uses a no-transaction SQLite driver with an atomic native
batch. A mixed-shape `createMany` produces two statements. The first statement
commits `{ id: 1 }`; the second rejects on a duplicate key; the driver's batch
method is never called. This is the forbidden partial-prefix outcome, not a
test-only difference. D1 and Neon HTTP have the same relevant capability shape:
`supportsTransactions === false` and `supportsBatch === true`.

Repair this at the existing physical-dispatch owner. A scalar statement window
on `usesBatch` must use the qualified batch attempt, keep its operation-local
result window, and preserve the existing commit/result failure facts. Do not
add a scalar-bulk transaction protocol or a second attempt journal. The repair
must also falsify a decode/result failure after a successfully acknowledged
batch; dispatch rollback and post-commit result failure are different facts.

### 2. Scalar update lowering is smaller than the admitted update language

`Queries.updateValue()` implements only `set` and `increment`. The admitted
integer and bigint scalar update language also includes `decrement`,
`multiply`, and `divide`. Both the simple and compound non-returning review
cases stop at the old `Raptor 3 G1 update operator is not implemented` error
before SQL dispatch. Moreover, `finalUpdatedIdentity()` derives only `set` and
`increment`, so merely adding SQL spelling would leave the terminal reader with
a stale key.

Complete the update expression and final-identity rules together at their
existing owners. Preserve the established portable-primary-key rules, including
complete compound identities and division constraints; do not infer a result
identity from returned projection fields or add a select-specific exception.
The repair evidence must cover every admitted arithmetic operation and one
compound-key transition on a non-returning route. The remaining admitted scalar
operators, including list operators where the operation schema permits them,
must be classified and exercised rather than silently deferred under a
"complete C08" label.

### 3. Bind partitioning repeats an existing semantic rule

The set-insert loop and `seriesQueries()` each implement their own binary search
for the largest compiled prefix. The repository already has the neutral
`src/query-engine/bind-budget.ts::compileBindBudgetChunks` owner for exactly this
rule: compiled SQL is the meter, an unknown ceiling preserves one statement,
and one over-limit item remains indivisible for the dispatch boundary to refuse.
That file has only SQL and driver-capacity dependencies and is already included
as a complete charged engine owner in the G3 census. Reusing it is shared
boundary reuse, not a legacy planner/compiler fallback and not a cost credit.

The review witnesses show that both current algorithms preserve order and fit
their ordinary ceilings: create groups use bind counts `[6, 6, 3]`; a
non-returning terminal read uses `[4, 4, 4, 4, 4]` under a ceiling of five.
Consolidate the repeated rule without adding cached topology or a third
partition abstraction, then pin the indivisible-over-limit refusal before I/O.

## Validation

The reviewed production patch is SHA-256
`b9942d6d350d847f011cd6f8ea5edf1a6b0853a4b6de21245b724085056da0e9`.
It changes the four stated TypeScript owners plus the private Raptor 3
`AGENTS.md`; it does not change an adapter, driver, `TransportAttempt`, public
route, or shipped client transaction owner.

The accepted source census, not physical diff lines, is authoritative:

- core charged code-bearing LOC: 6,598 to 7,019, **+421**;
- complete charged code-bearing LOC: 10,672 to 11,093, **+421**;
- core and complete charged source bytes: **+14,321**;
- owner perimeter: unchanged at 12 core / 28 complete files.

Replacing five temporary refusals with required behavior is feature completion,
not structural compression. The only demonstrated decision deletion is the
duplicate selector preparation removed from `Commands` and consumed as one
prepared selector by mutation lowering. The new provider capability branches,
result windows, and rollback capability are retained rules. The +421 LOC is
below the G3 guidepost and largely sits with the plan's physical execution
owner, but size does not justify the two incomplete forks above.

The final review witness is
`tests/raptor3/g3/review-execution-boundaries.test.ts`, SHA-256
`389c6213e4d8b5ed80f4fba014d75708b97ac84bcf2685ab1a6ff391288f0fe8`.
The registered `g3-execution-review` run used Node 24.21.0 and produced **2
passed / 3 failed**, with no skips. Raw Vitest evidence is
`/var/folders/2c/xh5rx2d91wd_lk8rvnnhlr4m0000gn/T/viborm-raptor3-g0-L2vTU0/vitest.json`,
SHA-256 `12dd0b494db569ff406ace894533a284d24727b9ea2867cf6a62c32a07070342`.
The measured wrapper used production identity
`c2b45664350d6df856d42dde05357f72d83c6c2bc39edebbe186323d55f49d26`
and harness identity
`1ef0bc022ca3adc26d99296e466b5eb6afd31037ba4a6c081ac97cf86bc1cbb2`;
it ran for 3.85 seconds, peaked at 519.0 MiB sampled process-group RSS,
and verified teardown. As a deliberately failing diagnostic, it has no passing
`verified.json` and is not mislabeled as qualification evidence.

Read-only review also accepts these bounded results as evidence for their exact
claims:

- the post-cardinality-repair focused group passed 33/33;
- scalar bulk, depth, registration, smoke, and stable typecheck checks reported
  green, with only the two historical Pattern diagnostics in typecheck;
- PostgreSQL 2/2 and MySQL 2/2 prove the tested returning/non-returning and
  rollback compositions on ports 51436 and 51439;
- exact-root suppression, fatal descendant failure, plain-borrow refusal,
  executable member rollback, escaped-driver refusal, and distinct package
  result windows have direct witnesses.

These checks do not convert the unfinished generated C08-C11 campaign into
evidence. The unregistered C11 variant generator was intentionally mid-edit and
was excluded from this diagnostic.

## Risks and acceptance obligations

There is no evidence for a new command, scheduler, attempt, array coordinator,
or transaction-scope concept. `memberRollback` is a narrow executable authority
on the existing borrowed binding, and plain borrowing remains unchanged. The
main risk is instead divergent physical execution inside the existing owner.

Before G3-02 can be accepted:

1. repair the standalone batch-only dispatch and post-dispatch result-failure
   accounting, then make the first review witness green;
2. complete the admitted scalar update language and terminal identity
   derivation, including the simple and compound review witnesses;
3. replace the two bind-partition algorithms with one existing-owner rule and
   add the one-item over-limit/no-I/O boundary;
4. rerun the focused G3-02 group, native PostgreSQL/MySQL slices, stable
   typecheck, and this review mode on one frozen source/harness identity;
5. leave late completion, closed scope, commit ambiguity, wrong-producer retry,
   healthy suffix, depth/variant recurrence, and the 10,000-seed campaign as
   explicit G3-03/G3-04 obligations. Existing narrow greens are not substitutes
   for those unfinished fault and generation matrices.

No full qualification is warranted until these bounded production defects are
repaired and independently rechecked.
