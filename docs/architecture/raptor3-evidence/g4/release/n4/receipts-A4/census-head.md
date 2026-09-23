# Raptor 3 refusal census

Produced by `scripts/raptor3-refusal-census.mjs` on `bf7ac30b4` with 9 uncommitted engine file(s). Shipped-sentence corpus: `0cc61e61f`.

Three outcomes, told apart by construction. An **invariant** throws through `shared/invariant.ts` and is not a refusal. An **internal** sentence lies inside a declared private fit whose privacy this run re-checked. A **refusal** is everything else: *registered* when the shipped engine already carries the same sentence, *public* when it does not.

## Counts

| outcome | sites | distinct sentences |
| --- | --- | --- |
| invariant | 19 | 18 |
| internal (private fits) | 11 | 11 |
| refusal — registered | 64 | 64 |
| refusal — public | 27 | 22 |
| no sentence (rethrow) | 66 | — |
| **total sites** | **187** | |

**Public refusals: 22 distinct sentences** at 27 sites, against the **55** the map started from (-33).

## Public refusals

A sentence the candidate spells that the shipped engine does not. Nothing in the tree forecloses it; which admitted payload reaches each one is the map's per-row ruling (`g4/release/plan/refusals-map.md`), which this census does not re-derive.

| sites | class | sentence |
| --- | --- | --- |
| `shared/query.ts:4380` | `InvalidScalarResult` | a document the statement always builds is null |
| `shared/query.ts:4387` | `InvalidScalarResult` | a requested document is not a provider row |
| `shared/query.ts:4369` | `InvalidScalarResult` | a requested relation is not a provider array |
| `commands/commands.ts:953` | `Error` | Dependency read is not under the write's tree |
| `shared/query.ts:2235` | `FeatureNotSupportedError` | distance ${usage} |
| `shared/operation-context.ts:1904` | `TransactionError` | Driver '${this.driver.driverName}' cannot locate one selected createMany row after insertion. |
| `shared/operation-context.ts:999`<br>`shared/operation-context.ts:1683` | `TransactionError` | Driver '${this.driver.driverName}' omitted the prepared result for operation '${this.operation}'. |
| `shared/operation-context.ts:2028` | `TransactionError` | Driver '${this.driver.driverName}' reported ${written} of ${rows.length} inserted rows for operation '${this.operation}'. |
| `commands/commands.ts:1557` | `TypeError` | INSERT … ON CONFLICT did not produce the required record |
| `commands/commands.ts:1531`<br>`commands/commands.ts:1597`<br>`shared/operation-context.ts:2470` | `TypeError` | INSERT did not produce the required record |
| `shared/operation-context.ts:1946` | `TypeError` | INSERT did not produce the required record identity |
| `shared/operation-context.ts:2524` | `TypeError` | INSERT RETURNING did not produce the required record |
| `shared/query.ts:1111` | `QueryEngineError` | Raptor 3 cannot name the updated value of '${model["~"].names.ts ?? "unknown"}.${field}' under '${update.operator}': the provider owns that operator's rounding inside its own assignment. |
| `shared/query.ts:4251` | `QueryEngineError` | Raptor 3 createMany final read returned inconsistent row counts. |
| `shared/operation-context.ts:2495` | `Error` | Raptor 3 G1 atomic output requires exact identity scratch or segmented RETURNING |
| `shared/operation-context.ts:2442` | `Error` | Raptor 3 interactive output requires RETURNING or one generated increment field |
| `shared/query.ts:3968` | `Error` | Raptor 3 variant integrity requires junction storage |
| `route/client-route.ts:212` | `UnsupportedOperationError` | The Raptor 3 route cannot encode a cached result for '${requestedOperation}' on model '${modelName}': the verb publishes no prepared read. |
| `shared/query.ts:4841`<br>`shared/query.ts:4852` | `InvalidScalarResult` | the value is not a binary value |
| `shared/query.ts:4599` | `InvalidScalarResult` | the value is not an array of finite numbers |
| `shared/operation-context.ts:2670`<br>`shared/operation-context.ts:2707` | `TypeError` | UPDATE did not produce the required record |
| `shared/operation-context.ts:2683` | `TypeError` | UPDATE RETURNING did not produce the required record |

## Registered refusals

Sentences the shipped engine already carries at `0cc61e61f`: inherited contracts, reported apart because they were never the census's question.

| sites | class | sentence |
| --- | --- | --- |
| `shared/query.ts:4701` | `InvalidScalarResult` | a JSON array is sparse |
| `shared/query.ts:4692` | `InvalidScalarResult` | a JSON integer is outside the safe range |
| `shared/query.ts:4687` | `InvalidScalarResult` | a JSON number is not finite |
| `shared/query.ts:4651`<br>`shared/query.ts:4859` | `InvalidScalarResult` | a list scalar did not return an array |
| `shared/query.ts:4662` | `InvalidScalarResult` | a list scalar returned a sparse array |
| `shared/query.ts:4434` | `InvalidScalarResult` | a required list is null |
| `shared/query.ts:4434` | `InvalidScalarResult` | a required scalar is null |
| `shared/query.ts:1001` | `QueryEngineError` | Cannot divide decimal field '${field}' by zero. |
| `shared/operation-context.ts:753` | `TransactionError` | cannot execute non-returning upsert writes atomically because public result parsing cannot be rolled back after an atomic batch commits |
| `commands/execution.ts:93` | `NestedWriteError` | Cannot update relation key field '${pair.source}' to null while mutating relation '${edge.name}'. A null reference names no row for that relation to point at. |
| `shared/query.ts:2746` | `QueryEngineError` | Cursor field '${field}' cannot be null. Cursor must point to a specific record. |
| `shared/query.ts:4744` | `InvalidScalarResult` | custom output schema rejected the value |
| `shared/decimal.ts:56` | `QueryEngineError` | Decimal field '${field}' has no declared precision and scale, so it has no exact value to bind. |
| `shared/decimal.ts:66` | `QueryEngineError` | Decimal field '${field}' received a value that is not an exact decimal. |
| `shared/decimal.ts:85` | `QueryEngineError` | Decimal list '${field}' received a member that is not an exact decimal. |
| `shared/query.ts:3539` | `QueryEngineError` | Distance select supports only one _distance field per select. |
| `shared/operation-context.ts:753` | `TransactionError` | Driver '${driver.driverName}' cannot execute '${this.operation}' because public result parsing cannot be rolled back. |
| `shared/operation-context.ts:1584` | `TransactionError` | Driver '${this.driver.driverName}' omitted the ${this.ownership === "batch-preparation" ? "prepared" : "terminal"} result for operation '${this.operation}'. |
| `shared/operation-context.ts:1656` | `TransactionError` | Driver '${this.driver.driverName}' omitted the result for operation '${this.operation}'. |
| `shared/operation-context.ts:743` | `TransactionError` | Driver "${driver.driverName}" supports neither transactions nor atomic batch execution. |
| `shared/query.ts:1589` | `QueryEngineError` | Field reference '${formatFieldRef(value)}' cannot be used while filtering '${scope}': a field reference may only compare columns of the same model. |
| `shared/query.ts:1594` | `QueryEngineError` | Field reference '${formatFieldRef(value)}' does not name a scalar field of '${scope}'. |
| `shared/query.ts:1600` | `QueryEngineError` | Field reference '${payload.field}' cannot be compared with '${owner.field}' on '${scope}': '${owner.field}' is decimal(${own.precision},${own.scale}) and '${payload.field}' is decimal(${other.precision},${other.scale}). Two decimals compare exactly only when they declare the same precision and scale. |
| `shared/query.ts:812` | `FeatureNotSupportedError` | GeoPoint requires a provider with its physical point tier enabled. |
| `shared/query.ts:4210` | `QueryEngineError` | GroupBy orderBy field '${name}' must be included in 'by' or be an aggregate (_count, _avg, _sum, _min, _max). |
| `shared/query.ts:2167` | `QueryEngineError` | JSON filter '${predicate.operator}' requires a number or string operand. |
| `shared/query.ts:2145` | `QueryEngineError` | JSON filter for field '${predicate.target.scalar!.field}' cannot combine 'path' with the ${sentinel} sentinel: the sentinels distinguish the database NULL from the JSON null value of the WHOLE column. Use 'path' with 'equals: null' to test for a JSON null at that path. |
| `shared/operation-context.ts:1861` | `QueryEngineError` | No data to insert for createMany. |
| `shared/query.ts:2710` | `QueryEngineError` | Paginated scalar ordering requires a primary model identifier. |
| `shared/query.ts:4350`<br>`shared/query.ts:4357` | `QueryEngineError` | Polymorphic relation '${shape.relation}' references a missing '${type}' record. |
| `shared/query.ts:628` | `InvalidScalarResult` | provider scalar decoding failed |
| `shared/query.ts:4177` | `QueryEngineError` | Scalar '${key}' used in 'having' must be included in 'by'. |
| `shared/query.ts:2113` | `QueryEngineError` | The 'having' _sum operand for decimal field '${scalar.field}' needs ${digits} coefficient digits, but its value is outside this provider's exact HAVING operand cast domain. The provider may compute a wider sum, but VibORM cannot express this operand through its exact decimal cast without changing or refusing the value written. |
| `shared/query.ts:3639` | `QueryEngineError` | The 'select' statement for model '${model["~"].names.ts ?? "unknown"}' needs at least one truthy value. |
| `route/client-route.ts:291` | `CacheConfigurationError` | The cached result snapshot is malformed. |
| `shared/query.ts:4553` | `InvalidScalarResult` | the Date is invalid or not UTC midnight |
| `shared/query.ts:4528` | `InvalidScalarResult` | the Date is outside the public DateTime domain |
| `shared/query.ts:4471` | `InvalidScalarResult` | the integer is outside the safe range |
| `shared/query.ts:4810` | `InvalidScalarResult` | the normalized precision exceeds milliseconds |
| `route/client-route.ts:278` | `CacheConfigurationError` | The operation result cannot be represented by the cache result codec. |
| `shared/query.ts:4621` | `InvalidScalarResult` | the scalar type is unsupported |
| `shared/query.ts:4508` | `InvalidScalarResult` | the sum is not an exact decimal at this column's scale |
| `shared/query.ts:4805` | `InvalidScalarResult` | the timezone suffix is invalid |
| `shared/query.ts:4604` | `InvalidScalarResult` | the value does not have the configured dimension ${leaf.dimension} |
| `shared/query.ts:4440` | `InvalidScalarResult` | the value is absent |
| `shared/query.ts:4493` | `InvalidScalarResult` | the value is not a canonical finite number |
| `shared/query.ts:4466`<br>`shared/query.ts:4483` | `InvalidScalarResult` | the value is not a canonical integer |
| `shared/query.ts:4579` | `InvalidScalarResult` | the value is not a declared enum member |
| `shared/query.ts:4449` | `InvalidScalarResult` | the value is not a string |
| `shared/query.ts:4568` | `InvalidScalarResult` | the value is not a valid ISO calendar date |
| `shared/query.ts:4797`<br>`shared/query.ts:4803` | `InvalidScalarResult` | the value is not a valid provider time |
| `shared/query.ts:4536` | `InvalidScalarResult` | the value is not a valid provider timestamp in the public DateTime domain |
| `shared/query.ts:4508` | `InvalidScalarResult` | the value is not an exact decimal in this column's declared domain |
| `shared/query.ts:4637` | `InvalidScalarResult` | the value is not an exact decimal list in this column's declared domain |
| `shared/query.ts:4520` | `InvalidScalarResult` | the value is not this column's declared physical timestamp |
| `shared/query.ts:4454` | `InvalidScalarResult` | the value is not true, false, zero, or one |
| `shared/query.ts:4717` | `InvalidScalarResult` | the value is outside the JSON value domain |
| `shared/query.ts:3736` | `QueryEngineError` | Unknown polymorphic target '${String(tag)}' for relation '${relation}'. |
| `shared/query.ts:1019` | `QueryEngineError` | Unknown update operation: ${Object.keys(operation).join(", ")} |
| `shared/query.ts:2227` | `QueryEngineError` | Vector distance ${usage} dimension mismatch for '${field}': expected ${dimension} values, received ${to.length}. |
| `shared/query.ts:2213` | `QueryEngineError` | Vector distance select does not support nullable vector field '${field}'. |
| `shared/query.ts:2217` | `FeatureNotSupportedError` | vector distance select requires a pgvector-enabled PostgreSQL driver |
| `shared/query.ts:2217` | `FeatureNotSupportedError` | vector ordering requires a pgvector-enabled PostgreSQL driver |
| `shared/query.ts:2020` | `FeatureNotSupportedError` | within polygon |

## Internal — the private fits

### `recursive-read` (D-54) — the private recursive-read fit

`Queries.recursive`, `decodeRecursive` and the route's recursive cache codec are built and tested, and no public verb, argument or schema option builds a recursive traversal or asks for a `recursive` published shape.

Privacy re-checked this run: `.recursive(`, `kind: "recursive"` named anywhere in `src/**` outside `src/query-engine/raptor3/shared/query.ts` — no hits; the fit holds.

| sites | class | anchor | sentence |
| --- | --- | --- | --- |
| `shared/query.ts:4337` | `TypeError` | under `=== "recursive"` | A recursive shape requires occurrence rows |
| `shared/query.ts:3238` | `Error` | inside `recursive` | A recursive traversal requires at least one seed |
| `shared/query.ts:4322` | `TypeError` | inside `decodeRecursive` | Invalid provider recursive collection |
| `shared/query.ts:4286` | `TypeError` | inside `decodeRecursive` | Invalid provider recursive occurrence |
| `shared/query.ts:4318` | `TypeError` | inside `decodeRecursive` | Invalid provider recursive parent occurrence |
| `shared/query.ts:4290` | `TypeError` | inside `decodeRecursive` | Invalid provider recursive path |
| `shared/query.ts:4305` | `TypeError` | inside `decodeRecursive` | Invalid provider recursive row |
| `shared/query.ts:4294` | `TypeError` | inside `decodeRecursive` | Invalid provider recursive seed |
| `shared/query.ts:3250` | `Error` | inside `recursive` | Raptor 3 recursive traversal relation '${traversal.relation}' is not self-referential |
| `shared/query.ts:3245` | `Error` | inside `recursive` | Raptor 3 recursive traversal requires one ordinary relation: ${traversal.relation} |
| `route/client-route.ts:332` | `UnsupportedOperationError` | under `case "recursive"` | The Raptor 3 route cannot encode a cached result for '${requestedOperation}': a recursive read's published depth is not a fixed shape. |

## Invariants

States the code cannot be in when it is right, thrown through the engine's one invariant owner. Not refusals, and counted as none.

| sites | through | sentence |
| --- | --- | --- |
| `shared/storage.ts:248` | `assertInvariant` | '${field}' is neither a declared scalar of '${model["~"].names.sql}' nor one of its variant carrier columns. |
| `shared/invariant.ts:28` | `throw` | ${message}: ${String(value)} |
| `commands/commands.ts:1356` | `assertInvariant` | a selected series is enclosed by a record analysis |
| `commands/commands.ts:1363` | `assertInvariant` | a selected series occurrence is expanded once |
| `commands/commands.ts:578` | `assertInvariant` | a series capture target is read only from a capture occurrence |
| `commands/commands.ts:444` | `assertInvariant` | a series capture's target is a sibling of the capture in the same body |
| `commands/execution.ts:958` | `assertInvariant` | a series member names its captured row |
| `commands/commands.ts:1204` | `assertInvariant` | an occurrence's parent lists that occurrence |
| `commands/index.ts:53` | `unreachable` | client operation |
| `commands/commands.ts:583` | `assertInvariant` | materialization resolved this capture's target |
| `shared/query.ts:3189` | `unreachable` | Raptor 3 aggregate is not implemented |
| `shared/query.ts:2067` | `throw` | Raptor 3 filter operator is not implemented: ${operator} |
| `shared/query.ts:2289` | `throw` | Raptor 3 G3P-05 relation filter is not implemented: ${predicate.quantifier} |
| `shared/query.ts:2192` | `throw` | Raptor 3 JSON filter operator is not implemented: ${predicate.operator} |
| `commands/relation-body.ts:744` | `unreachable` | relation verb |
| `route/client-route.ts:374` | `throw` | The Raptor 3 route cannot encode a cached '${leaf.type}' result for '${requestedOperation}': the leaf publishes no declaring scalar. |
| `commands/execution.ts:950` | `assertInvariant` | this series was captured in this attempt |
| `shared/storage.ts:72` | `assertInvariant` | Variant carrier '${name}' was addressed with ${variant === undefined ? "no arm" : `the undeclared arm '${variant}'`}: every caller addresses one declared arm or composes the arms itself. |

## Sites without a sentence

Rethrows of a value another owner built. Listed so no site is silently dropped from the total.

| site | thrown |
| --- | --- |
| `commands/assignments.ts:138` | `failure` |
| `commands/assignments.ts:142` | `this.refusal` |
| `commands/commands.ts:1744` | `transition` |
| `commands/execution.ts:240` | `error` |
| `commands/execution.ts:287` | `selection.required` |
| `commands/execution.ts:305` | `occurrence.refusal` |
| `commands/execution.ts:435` | `ctx.failure` |
| `commands/execution.ts:462` | `supplied ? ctx.failure` |
| `commands/execution.ts:470` | `found.refusal` |
| `commands/execution.ts:505` | `requirement.failure` |
| `commands/execution.ts:834` | `ctx.failure` |
| `commands/execution.ts:934` | `ctx.failure` |
| `commands/execution.ts:964` | `ctx.failure` |
| `commands/index.ts:281` | `error` |
| `commands/relation-body.ts:448` | `keyRefusal` |
| `commands/relation-body.ts:656` | `keyRefusal` |
| `shared/operation-context.ts:434` | `this.failure` |
| `shared/operation-context.ts:449` | `this.failure` |
| `shared/operation-context.ts:458` | `refusal` |
| `shared/operation-context.ts:469` | `error` |
| `shared/operation-context.ts:512` | `refusal` |
| `shared/operation-context.ts:652` | `error` |
| `shared/operation-context.ts:662` | `primary` |
| `shared/operation-context.ts:707` | `error` |
| `shared/operation-context.ts:717` | `this.failure` |
| `shared/operation-context.ts:721` | `error` |
| `shared/operation-context.ts:772` | `this.requiresEnvelope` |
| `shared/operation-context.ts:844` | `error` |
| `shared/operation-context.ts:846` | `error` |
| `shared/operation-context.ts:871` | `error` |
| `shared/operation-context.ts:873` | `error` |
| `shared/operation-context.ts:903` | `this.incompletePreparation` |
| `shared/operation-context.ts:1017` | `missing` |
| `shared/operation-context.ts:1076` | `premise.failure` |
| `shared/operation-context.ts:1110` | `this.failure` |
| `shared/operation-context.ts:1122` | `failure` |
| `shared/operation-context.ts:1132` | `this.incompletePreparation` |
| `shared/operation-context.ts:1197` | `this.answered` |
| `shared/operation-context.ts:1382` | `publishingGeneratedOutput \|\| this.continuationCount > 0         ? this.failure` |
| `shared/operation-context.ts:1414` | `held         ? this.answered` |
| `shared/operation-context.ts:1418` | `this.answered` |
| `shared/operation-context.ts:1473` | `this.answered` |
| `shared/operation-context.ts:1624` | `queries.length ? this.failure` |
| `shared/operation-context.ts:1724` | `this.failure` |
| `shared/operation-context.ts:1766` | `error` |
| `shared/operation-context.ts:1786` | `decoded.failure` |
| `shared/operation-context.ts:1813` | `outcomeFailure` |
| `shared/operation-context.ts:1814` | `this.answered` |
| `shared/operation-context.ts:1895` | `this.incompletePreparation` |
| `shared/operation-context.ts:1929` | `error` |
| `shared/operation-context.ts:2150` | `changed` |
| `shared/operation-context.ts:2240` | `changed` |
| `shared/operation-context.ts:2277` | `this.incompletePreparation` |
| `shared/operation-context.ts:2458` | `error` |
| `shared/operation-context.ts:2529` | `this.failure` |
| `shared/operation-context.ts:2618` | `this.incompletePreparation` |
| `shared/operation-context.ts:2780` | `failure` |
| `shared/parse-boundary.ts:45` | `ValidationError` |
| `shared/query.ts:627` | `error` |
| `shared/query.ts:2510` | `QueryEngineError` |
| `shared/query.ts:2638` | `QueryEngineError` |
| `shared/query.ts:3546` | `QueryEngineError` |
| `shared/query.ts:3560` | `QueryEngineError` |
| `shared/query.ts:4249` | `query.expectedRows.missing` |
| `shared/query.ts:4614` | `InvalidScalarResult` |
| `shared/schema.ts:204` | `refusal` |
