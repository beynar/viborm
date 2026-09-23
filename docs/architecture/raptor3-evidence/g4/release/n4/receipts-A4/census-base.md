# Raptor 3 refusal census

Produced by `scripts/raptor3-refusal-census.mjs` on `bf7ac30b4`. Shipped-sentence corpus: `0cc61e61f`.

Three outcomes, told apart by construction. An **invariant** throws through `shared/invariant.ts` and is not a refusal. An **internal** sentence lies inside a declared private fit whose privacy this run re-checked. A **refusal** is everything else: *registered* when the shipped engine already carries the same sentence, *public* when it does not.

## Counts

| outcome | sites | distinct sentences |
| --- | --- | --- |
| invariant | 0 | 0 |
| internal (private fits) | 11 | 11 |
| refusal — registered | 64 | 64 |
| refusal — public | 51 | 46 |
| no sentence (rethrow) | 63 | — |
| **total sites** | **189** | |

**Public refusals: 46 distinct sentences** at 51 sites, against the **55** the map started from (-9).

## Public refusals

A sentence the candidate spells that the shipped engine does not. Nothing in the tree forecloses it; which admitted payload reaches each one is the map's per-row ruling (`g4/release/plan/refusals-map.md`), which this census does not re-derive.

| sites | class | sentence |
| --- | --- | --- |
| `shared/query.ts:4344` | `InvalidScalarResult` | a document the statement always builds is null |
| `shared/query.ts:4351` | `InvalidScalarResult` | a requested document is not a provider row |
| `shared/query.ts:4333` | `InvalidScalarResult` | a requested relation is not a provider array |
| `shared/operation-context.ts:2545` | `UnsupportedOperationError` | Cannot publish the updated value of '${model["~"].names.ts!}.${field}' for operation "${operation}" inside an atomic batch: the batch scratch reads back as an integer, and '${field}' is a ${state.type} field. |
| `commands/commands.ts:1182` | `Error` | Command occurrence is missing from its parent |
| `commands/commands.ts:561` | `Error` | Command occurrence is not a series capture |
| `shared/operation-context.ts:2236` | `TransactionError` | deleteMany selected-row cardinality changed during its locked mutation. |
| `commands/commands.ts:933` | `Error` | Dependency read is not under the write's tree |
| `shared/query.ts:2200` | `FeatureNotSupportedError` | distance ${usage} |
| `shared/operation-context.ts:2278` | `TransactionError` | Driver '${this.driver.driverName}' cannot atomically capture selected ${this.operation} rows. |
| `shared/operation-context.ts:1919` | `TransactionError` | Driver '${this.driver.driverName}' cannot locate one selected createMany row after insertion. |
| `shared/operation-context.ts:1014`<br>`shared/operation-context.ts:1698` | `TransactionError` | Driver '${this.driver.driverName}' omitted the prepared result for operation '${this.operation}'. |
| `shared/operation-context.ts:2043` | `TransactionError` | Driver '${this.driver.driverName}' reported ${written} of ${rows.length} inserted rows for operation '${this.operation}'. |
| `commands/commands.ts:1525` | `TypeError` | INSERT … ON CONFLICT did not produce the required record |
| `commands/commands.ts:1499`<br>`commands/commands.ts:1565`<br>`shared/operation-context.ts:2403` | `TypeError` | INSERT did not produce the required record |
| `shared/operation-context.ts:1961` | `TypeError` | INSERT did not produce the required record identity |
| `shared/operation-context.ts:2457` | `TypeError` | INSERT RETURNING did not produce the required record |
| `shared/query.ts:3151` | `QueryEngineError` | Raptor 3 aggregate is not implemented: ${aggregate} |
| `shared/operation-context.ts:338` | `TransactionError` | Raptor 3 atomic-array execution is not implemented. |
| `shared/query.ts:1083` | `QueryEngineError` | Raptor 3 cannot name the updated value of '${model["~"].names.ts ?? "unknown"}.${field}' under '${update.operator}': the provider owns that operator's rounding inside its own assignment. |
| `shared/query.ts:4215` | `QueryEngineError` | Raptor 3 createMany final read returned inconsistent row counts. |
| `shared/query.ts:2034` | `QueryEngineError` | Raptor 3 filter operator is not implemented: ${operator} |
| `shared/operation-context.ts:2428` | `Error` | Raptor 3 G1 atomic output requires exact identity scratch or segmented RETURNING |
| `commands/index.ts:152` | `Error` | Raptor 3 G1 operation is not implemented: ${operation} |
| `shared/storage.ts:214` | `Error` | Raptor 3 G1 physical field is not implemented: ${field} |
| `commands/relation-body.ts:728` | `Error` | Raptor 3 G1 relation operation is not implemented: ${verb} |
| `shared/operation-context.ts:2796` | `Error` | Raptor 3 G1 set requires junction storage |
| `shared/storage.ts:64` | `Error` | Raptor 3 G1 variant carrier membership is not implemented: ${name} |
| `shared/query.ts:2251` | `Error` | Raptor 3 G3P-05 relation filter is not implemented: ${predicate.quantifier} |
| `shared/operation-context.ts:2375` | `Error` | Raptor 3 interactive output requires RETURNING or one generated increment field |
| `shared/query.ts:2157` | `QueryEngineError` | Raptor 3 JSON filter operator is not implemented: ${predicate.operator} |
| `shared/query.ts:3932` | `Error` | Raptor 3 variant integrity requires junction storage |
| `commands/execution.ts:888` | `Error` | Selected delete series has no mutation origin |
| `commands/commands.ts:1332` | `Error` | Selected series has no enclosing analysis |
| `commands/commands.ts:1334` | `Error` | Selected series occurrence was already expanded |
| `commands/execution.ts:721`<br>`commands/execution.ts:944` | `Error` | Selected series was not captured |
| `commands/execution.ts:949` | `Error` | Selected update series has no location |
| `commands/commands.ts:563` | `Error` | Series capture has no occurrence target |
| `commands/commands.ts:433` | `Error` | Series capture target lost its occurrence kind |
| `route/client-route.ts:353` | `UnsupportedOperationError` | The Raptor 3 route cannot encode a cached '${leaf.type}' result for '${requestedOperation}': the leaf publishes no declaring scalar. |
| `route/client-route.ts:198` | `UnsupportedOperationError` | The Raptor 3 route cannot encode a cached result for '${requestedOperation}' on model '${modelName}': the verb publishes no prepared read. |
| `shared/query.ts:4805`<br>`shared/query.ts:4816` | `InvalidScalarResult` | the value is not a binary value |
| `shared/query.ts:4563` | `InvalidScalarResult` | the value is not an array of finite numbers |
| `shared/operation-context.ts:2603` | `TypeError` | UPDATE did not produce the required record |
| `shared/operation-context.ts:2616` | `TypeError` | UPDATE RETURNING did not produce the required record |
| `shared/operation-context.ts:2152` | `TransactionError` | updateMany selected-row cardinality changed during its locked mutation. |

## Registered refusals

Sentences the shipped engine already carries at `0cc61e61f`: inherited contracts, reported apart because they were never the census's question.

| sites | class | sentence |
| --- | --- | --- |
| `shared/query.ts:4665` | `InvalidScalarResult` | a JSON array is sparse |
| `shared/query.ts:4656` | `InvalidScalarResult` | a JSON integer is outside the safe range |
| `shared/query.ts:4651` | `InvalidScalarResult` | a JSON number is not finite |
| `shared/query.ts:4615`<br>`shared/query.ts:4823` | `InvalidScalarResult` | a list scalar did not return an array |
| `shared/query.ts:4626` | `InvalidScalarResult` | a list scalar returned a sparse array |
| `shared/query.ts:4398` | `InvalidScalarResult` | a required list is null |
| `shared/query.ts:4398` | `InvalidScalarResult` | a required scalar is null |
| `shared/query.ts:989` | `QueryEngineError` | Cannot divide decimal field '${field}' by zero. |
| `shared/operation-context.ts:768` | `TransactionError` | cannot execute non-returning upsert writes atomically because public result parsing cannot be rolled back after an atomic batch commits |
| `commands/execution.ts:89` | `NestedWriteError` | Cannot update relation key field '${pair.source}' to null while mutating relation '${edge.name}'. A null reference names no row for that relation to point at. |
| `shared/query.ts:2708` | `QueryEngineError` | Cursor field '${field}' cannot be null. Cursor must point to a specific record. |
| `shared/query.ts:4708` | `InvalidScalarResult` | custom output schema rejected the value |
| `shared/decimal.ts:56` | `QueryEngineError` | Decimal field '${field}' has no declared precision and scale, so it has no exact value to bind. |
| `shared/decimal.ts:66` | `QueryEngineError` | Decimal field '${field}' received a value that is not an exact decimal. |
| `shared/decimal.ts:85` | `QueryEngineError` | Decimal list '${field}' received a member that is not an exact decimal. |
| `shared/query.ts:3503` | `QueryEngineError` | Distance select supports only one _distance field per select. |
| `shared/operation-context.ts:768` | `TransactionError` | Driver '${driver.driverName}' cannot execute '${this.operation}' because public result parsing cannot be rolled back. |
| `shared/operation-context.ts:1599` | `TransactionError` | Driver '${this.driver.driverName}' omitted the ${this.ownership === "batch-preparation" ? "prepared" : "terminal"} result for operation '${this.operation}'. |
| `shared/operation-context.ts:1671` | `TransactionError` | Driver '${this.driver.driverName}' omitted the result for operation '${this.operation}'. |
| `shared/operation-context.ts:758` | `TransactionError` | Driver "${driver.driverName}" supports neither transactions nor atomic batch execution. |
| `shared/query.ts:1561` | `QueryEngineError` | Field reference '${formatFieldRef(value)}' cannot be used while filtering '${scope}': a field reference may only compare columns of the same model. |
| `shared/query.ts:1566` | `QueryEngineError` | Field reference '${formatFieldRef(value)}' does not name a scalar field of '${scope}'. |
| `shared/query.ts:1572` | `QueryEngineError` | Field reference '${payload.field}' cannot be compared with '${owner.field}' on '${scope}': '${owner.field}' is decimal(${own.precision},${own.scale}) and '${payload.field}' is decimal(${other.precision},${other.scale}). Two decimals compare exactly only when they declare the same precision and scale. |
| `shared/query.ts:800` | `FeatureNotSupportedError` | GeoPoint requires a provider with its physical point tier enabled. |
| `shared/query.ts:4174` | `QueryEngineError` | GroupBy orderBy field '${name}' must be included in 'by' or be an aggregate (_count, _avg, _sum, _min, _max). |
| `shared/query.ts:2134` | `QueryEngineError` | JSON filter '${predicate.operator}' requires a number or string operand. |
| `shared/query.ts:2112` | `QueryEngineError` | JSON filter for field '${predicate.target.scalar!.field}' cannot combine 'path' with the ${sentinel} sentinel: the sentinels distinguish the database NULL from the JSON null value of the WHOLE column. Use 'path' with 'equals: null' to test for a JSON null at that path. |
| `shared/operation-context.ts:1876` | `QueryEngineError` | No data to insert for createMany. |
| `shared/query.ts:2672` | `QueryEngineError` | Paginated scalar ordering requires a primary model identifier. |
| `shared/query.ts:4314`<br>`shared/query.ts:4321` | `QueryEngineError` | Polymorphic relation '${shape.relation}' references a missing '${type}' record. |
| `shared/query.ts:616` | `InvalidScalarResult` | provider scalar decoding failed |
| `shared/query.ts:4141` | `QueryEngineError` | Scalar '${key}' used in 'having' must be included in 'by'. |
| `shared/query.ts:2080` | `QueryEngineError` | The 'having' _sum operand for decimal field '${scalar.field}' needs ${digits} coefficient digits, but its value is outside this provider's exact HAVING operand cast domain. The provider may compute a wider sum, but VibORM cannot express this operand through its exact decimal cast without changing or refusing the value written. |
| `shared/query.ts:3603` | `QueryEngineError` | The 'select' statement for model '${model["~"].names.ts ?? "unknown"}' needs at least one truthy value. |
| `route/client-route.ts:277` | `CacheConfigurationError` | The cached result snapshot is malformed. |
| `shared/query.ts:4517` | `InvalidScalarResult` | the Date is invalid or not UTC midnight |
| `shared/query.ts:4492` | `InvalidScalarResult` | the Date is outside the public DateTime domain |
| `shared/query.ts:4435` | `InvalidScalarResult` | the integer is outside the safe range |
| `shared/query.ts:4774` | `InvalidScalarResult` | the normalized precision exceeds milliseconds |
| `route/client-route.ts:264` | `CacheConfigurationError` | The operation result cannot be represented by the cache result codec. |
| `shared/query.ts:4585` | `InvalidScalarResult` | the scalar type is unsupported |
| `shared/query.ts:4472` | `InvalidScalarResult` | the sum is not an exact decimal at this column's scale |
| `shared/query.ts:4769` | `InvalidScalarResult` | the timezone suffix is invalid |
| `shared/query.ts:4568` | `InvalidScalarResult` | the value does not have the configured dimension ${leaf.dimension} |
| `shared/query.ts:4404` | `InvalidScalarResult` | the value is absent |
| `shared/query.ts:4457` | `InvalidScalarResult` | the value is not a canonical finite number |
| `shared/query.ts:4430`<br>`shared/query.ts:4447` | `InvalidScalarResult` | the value is not a canonical integer |
| `shared/query.ts:4543` | `InvalidScalarResult` | the value is not a declared enum member |
| `shared/query.ts:4413` | `InvalidScalarResult` | the value is not a string |
| `shared/query.ts:4532` | `InvalidScalarResult` | the value is not a valid ISO calendar date |
| `shared/query.ts:4761`<br>`shared/query.ts:4767` | `InvalidScalarResult` | the value is not a valid provider time |
| `shared/query.ts:4500` | `InvalidScalarResult` | the value is not a valid provider timestamp in the public DateTime domain |
| `shared/query.ts:4472` | `InvalidScalarResult` | the value is not an exact decimal in this column's declared domain |
| `shared/query.ts:4601` | `InvalidScalarResult` | the value is not an exact decimal list in this column's declared domain |
| `shared/query.ts:4484` | `InvalidScalarResult` | the value is not this column's declared physical timestamp |
| `shared/query.ts:4418` | `InvalidScalarResult` | the value is not true, false, zero, or one |
| `shared/query.ts:4681` | `InvalidScalarResult` | the value is outside the JSON value domain |
| `shared/query.ts:3700` | `QueryEngineError` | Unknown polymorphic target '${String(tag)}' for relation '${relation}'. |
| `shared/query.ts:1007` | `QueryEngineError` | Unknown update operation: ${Object.keys(operation).join(", ")} |
| `shared/query.ts:2192` | `QueryEngineError` | Vector distance ${usage} dimension mismatch for '${field}': expected ${dimension} values, received ${to.length}. |
| `shared/query.ts:2178` | `QueryEngineError` | Vector distance select does not support nullable vector field '${field}'. |
| `shared/query.ts:2182` | `FeatureNotSupportedError` | vector distance select requires a pgvector-enabled PostgreSQL driver |
| `shared/query.ts:2182` | `FeatureNotSupportedError` | vector ordering requires a pgvector-enabled PostgreSQL driver |
| `shared/query.ts:1992` | `FeatureNotSupportedError` | within polygon |

## Internal — the private fits

### `recursive-read` (D-54) — the private recursive-read fit

`Queries.recursive`, `decodeRecursive` and the route's recursive cache codec are built and tested, and no public verb, argument or schema option builds a recursive traversal or asks for a `recursive` published shape.

Privacy re-checked this run: `.recursive(`, `kind: "recursive"` named anywhere in `src/**` outside `src/query-engine/raptor3/shared/query.ts` — no hits; the fit holds.

| sites | class | anchor | sentence |
| --- | --- | --- | --- |
| `shared/query.ts:4301` | `TypeError` | under `=== "recursive"` | A recursive shape requires occurrence rows |
| `shared/query.ts:3202` | `Error` | inside `recursive` | A recursive traversal requires at least one seed |
| `shared/query.ts:4286` | `TypeError` | inside `decodeRecursive` | Invalid provider recursive collection |
| `shared/query.ts:4250` | `TypeError` | inside `decodeRecursive` | Invalid provider recursive occurrence |
| `shared/query.ts:4282` | `TypeError` | inside `decodeRecursive` | Invalid provider recursive parent occurrence |
| `shared/query.ts:4254` | `TypeError` | inside `decodeRecursive` | Invalid provider recursive path |
| `shared/query.ts:4269` | `TypeError` | inside `decodeRecursive` | Invalid provider recursive row |
| `shared/query.ts:4258` | `TypeError` | inside `decodeRecursive` | Invalid provider recursive seed |
| `shared/query.ts:3214` | `Error` | inside `recursive` | Raptor 3 recursive traversal relation '${traversal.relation}' is not self-referential |
| `shared/query.ts:3209` | `Error` | inside `recursive` | Raptor 3 recursive traversal requires one ordinary relation: ${traversal.relation} |
| `route/client-route.ts:318` | `UnsupportedOperationError` | under `case "recursive"` | The Raptor 3 route cannot encode a cached result for '${requestedOperation}': a recursive read's published depth is not a fixed shape. |

## Invariants

States the code cannot be in when it is right, thrown through the engine's one invariant owner. Not refusals, and counted as none.

_None._

## Sites without a sentence

Rethrows of a value another owner built. Listed so no site is silently dropped from the total.

| site | thrown |
| --- | --- |
| `commands/assignments.ts:138` | `failure` |
| `commands/assignments.ts:142` | `this.refusal` |
| `commands/commands.ts:1712` | `transition` |
| `commands/execution.ts:236` | `error` |
| `commands/execution.ts:283` | `selection.required` |
| `commands/execution.ts:301` | `occurrence.refusal` |
| `commands/execution.ts:431` | `ctx.failure` |
| `commands/execution.ts:458` | `supplied ? ctx.failure` |
| `commands/execution.ts:466` | `found.refusal` |
| `commands/execution.ts:501` | `requirement.failure` |
| `commands/execution.ts:831` | `ctx.failure` |
| `commands/execution.ts:933` | `ctx.failure` |
| `commands/execution.ts:955` | `ctx.failure` |
| `commands/index.ts:280` | `error` |
| `commands/relation-body.ts:432` | `keyRefusal` |
| `commands/relation-body.ts:640` | `keyRefusal` |
| `shared/operation-context.ts:449` | `this.failure` |
| `shared/operation-context.ts:464` | `this.failure` |
| `shared/operation-context.ts:473` | `refusal` |
| `shared/operation-context.ts:484` | `error` |
| `shared/operation-context.ts:527` | `refusal` |
| `shared/operation-context.ts:667` | `error` |
| `shared/operation-context.ts:677` | `primary` |
| `shared/operation-context.ts:722` | `error` |
| `shared/operation-context.ts:732` | `this.failure` |
| `shared/operation-context.ts:736` | `error` |
| `shared/operation-context.ts:787` | `this.requiresEnvelope` |
| `shared/operation-context.ts:859` | `error` |
| `shared/operation-context.ts:861` | `error` |
| `shared/operation-context.ts:886` | `error` |
| `shared/operation-context.ts:888` | `error` |
| `shared/operation-context.ts:918` | `this.incompletePreparation` |
| `shared/operation-context.ts:1032` | `missing` |
| `shared/operation-context.ts:1091` | `premise.failure` |
| `shared/operation-context.ts:1125` | `this.failure` |
| `shared/operation-context.ts:1137` | `failure` |
| `shared/operation-context.ts:1147` | `this.incompletePreparation` |
| `shared/operation-context.ts:1212` | `this.answered` |
| `shared/operation-context.ts:1397` | `publishingGeneratedOutput \|\| this.continuationCount > 0         ? this.failure` |
| `shared/operation-context.ts:1429` | `held         ? this.answered` |
| `shared/operation-context.ts:1433` | `this.answered` |
| `shared/operation-context.ts:1488` | `this.answered` |
| `shared/operation-context.ts:1639` | `queries.length ? this.failure` |
| `shared/operation-context.ts:1739` | `this.failure` |
| `shared/operation-context.ts:1781` | `error` |
| `shared/operation-context.ts:1801` | `decoded.failure` |
| `shared/operation-context.ts:1828` | `outcomeFailure` |
| `shared/operation-context.ts:1829` | `this.answered` |
| `shared/operation-context.ts:1910` | `this.incompletePreparation` |
| `shared/operation-context.ts:1944` | `error` |
| `shared/operation-context.ts:2276` | `this.incompletePreparation` |
| `shared/operation-context.ts:2391` | `error` |
| `shared/operation-context.ts:2462` | `this.failure` |
| `shared/operation-context.ts:2694` | `failure` |
| `shared/parse-boundary.ts:45` | `ValidationError` |
| `shared/query.ts:615` | `error` |
| `shared/query.ts:2472` | `QueryEngineError` |
| `shared/query.ts:2600` | `QueryEngineError` |
| `shared/query.ts:3510` | `QueryEngineError` |
| `shared/query.ts:3524` | `QueryEngineError` |
| `shared/query.ts:4213` | `query.expectedRows.missing` |
| `shared/query.ts:4578` | `InvalidScalarResult` |
| `shared/schema.ts:204` | `refusal` |
