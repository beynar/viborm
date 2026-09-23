# G3 structural correction: independent repair review

## Outcome

**ACCEPT** the bounded correction for subsequent full qualification.

This verdict is bound to production
`b8f695ea09045f569c9e56b24b3f0aa2adc714f26fd0ca49219fd62653e044dc`,
harness
`61bc21c0d7f6c77ebcff5b4c44162e0912481fdb428e3f2cdb848ba536e17ed7`,
and Node `v24.21.0`. It is a unit verdict, not final qualification.

The reviewed ownership is coherent:

- `Queries.updateValue` remains the one admitted `set`/`increment` SQL
  meaning. `OperationContext.updatedIdentity` maps complete keys through that
  owner and contains no second arithmetic interpreter.
- Locked mutation capture reads the existing internal representation. A
  decoded public Decimal is no longer fed back into private `fieldValue`.
- Callers state result cardinality with `finishOne`, `finishMany`, or the
  result-free `finish`. Live and prepared paths share one terminal decoder and
  one missing-result error boundary. `completeSeries` now consumes only its
  actual `Query[]` contract.
- `CommandExecution.complete` awaits terminal completion inside its recovery
  `try`, so a rejected final atomic dispatch still reaches the existing exact
  producer recovery owner.
- Batch preparation suppresses only `executeMember`'s execution-time final
  flush and completed-member acknowledgement. Static member statements remain
  queued in order. A dynamic `read`, explicit result-bearing `flush`, or
  `submit` still reaches the existing incomplete-preparation refusal. No
  execution progress is fabricated while statements are only being prepared.
- `createMany` delays provider `RETURNING` and physical grouping until its
  route is chosen, and capped mutation lowering constructs only the selected
  aliased or unaliased selector.

No preparation flag, decoder flag, public payload validation, driver contract,
progress model, update language, or second terminal path was added.

## Validation

The independent source-bound checks were:

- `g3-author-execution-regressions`: 3/3 PASS. This enters actual
  `prepareBatch` through the transaction-array boundary, proves singular,
  one-terminal, and multi-terminal cardinality, and removes the later terminal
  result to prove underflow attribution. Raw receipt:
  `review-repair/independent/author-execution-regressions/`.
- `g3p02-pg-contracts`: 5/5 PASS on the existing native PostgreSQL provider.
  The mapped scalar root and compound nested lost-winner cases prove final
  dispatch recovery. Raw receipt:
  `review-repair/independent/g3p02-pg-contracts/`.
- `g3p02-mysql-contracts`: 5/5 PASS on the existing native MySQL provider,
  with the same two recovery cases. Raw receipt:
  `review-repair/independent/g3p02-mysql-contracts/`.

The first PostgreSQL invocation omitted the required loopback port. Collection
failed before any test ran. Its unmodified `attempt.json` and `vitest.json` are
retained under `review-repair/independent/missing-port-attempt/`; they are
diagnostic evidence only and are not counted as validation.

The author's broader focused receipts under `review-repair/final/` bind the
same identities and additionally cover execution review 6/6, bulk result 5/5,
G3P-03 preparation 6/6, transaction array 4/4, both native recovery modes 5/5,
runner receipt self-tests 34/34, and a whole-estate type check with only the two
historical Pattern diagnostics.

## Risks

No bounded correctness blocker remains in this unit. Full source-bound G3
qualification is still required because the production and harness identities
changed after the prior qualification. Historical receipts must not be
relabeled as evidence for these identities.
