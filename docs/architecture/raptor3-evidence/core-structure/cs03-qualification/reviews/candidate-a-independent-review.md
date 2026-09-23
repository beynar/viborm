# CS03 candidate A independent review

Status: accepted after the two requested repairs.

Reviewed artifact: `docs/architecture/raptor3-evidence/core-structure/cs03-candidate-a.patch`, SHA-256 `2938c91b758d2c0db9e0ce2ce63ae04aa71b24b8996bfb535324a44c01818879`.

1. The patch creates a type-only split across `CommandAttempt`, `Commands`, `RelationBody`, and `CommandExecution`. Update and delete capture duplicate prepare, expand, refusal, and store logic. `executeSeries` then branches on `prepared.kind` but calls the same method in both arms, while the update-select path still guards `prepared.kind` at runtime. The admitted mutation kind already determines the member shape. Retain one series/capture flow and narrow the dependent member map once at the trusted top updateMany terminal-completion boundary, or use a top-only subtype/overload. Do not keep a parallel generic series language whose only consumer is this proof.

2. `OperationContext.decodeFinal` converts every `expectedRows` underflow to `TransactionError`. This changes the existing createMany terminal-missing failure from `QueryEngineError`, although A only adds updateMany returning. Carry the operation-specific missing failure at `Query.expectedRows` and preserve the createMany error class while giving updateMany its required `TransactionError`.

The review does not request a smaller patch by percentage. It requests removal of duplicated semantic control flow and preservation of an existing error contract.

## Repair verification

The final candidate source has one `captureSeries` implementation, one
`executeSeries` implementation, and one `completeSeries` terminal callback
path. It removed the update/delete type-only preparation branches. The admitted
top-level updateMany-select boundary now performs the one approved trusted
dependent-member narrowing before it collects final identities; there is no
downstream impossible-kind failure.

`Queries.selectSeries` now carries the missing-row `Error` itself. CreateMany
retains `QueryEngineError`; updateMany uses `TransactionError`.
`OperationContext` adds result-phase/progress attribution without replacing
either class. The candidate's final A6 receipt is `zWlGy8` (6/6), and its whole
typecheck reports only the established Pattern x2 and isolated program-dump x1
errors.
