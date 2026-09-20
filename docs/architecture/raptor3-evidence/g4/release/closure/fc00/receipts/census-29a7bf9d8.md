# Raptor 3 refusal census

Produced by `scripts/raptor3-refusal-census.mjs` on `29a7bf9d8` (clean engine tree). Shipped-sentence corpus: `0cc61e61f`.

Three outcomes, told apart by construction. An **invariant** throws through `shared/invariant.ts` and is not a refusal. An **internal** sentence lies inside a declared private fit whose privacy this run re-checked. A **refusal** is everything else: *registered* when the shipped engine already carries the same sentence, *public* when it does not.

## Counts

| outcome | sites | distinct sentences |
| --- | --- | --- |
| invariant | 22 | 21 |
| internal (private fits) | 11 | 11 |
| refusal — registered | 72 | 72 |
| refusal — public | 30 | 23 |
| no sentence (rethrow) | 57 | — |
| **total sites** | **192** | |

**Public refusals: 23 distinct sentences** at 30 sites, against the **55** the map started from (-32).

## Public refusals

A sentence the candidate spells that the shipped engine does not. Nothing in the tree forecloses it; which admitted payload reaches each one is the map's per-row ruling (`g4/release/plan/refusals-map.md`), which this census does not re-derive.

| sites | class | sentence |
| --- | --- | --- |
| `shared/query.ts:4489` | `InvalidScalarResult` | a document the statement always builds is null |
| `shared/query.ts:4496` | `InvalidScalarResult` | a requested document is not a provider row |
| `shared/query.ts:4478` | `InvalidScalarResult` | a requested relation is not a provider array |
| `shared/operation-context.ts:2462` | `TransactionError` | deleteMany selected-row cardinality changed during its locked mutation. |
| `shared/query.ts:2339` | `FeatureNotSupportedError` | distance ${usage} |
| `shared/operation-context.ts:2126` | `TransactionError` | Driver '${this.driver.driverName}' cannot locate one selected createMany row after insertion. |
| `shared/operation-context.ts:1127`<br>`shared/operation-context.ts:1905`<br>`shared/operation-context.ts:2591` | `TransactionError` | Driver '${this.driver.driverName}' omitted the prepared result for operation '${this.operation}'. |
| `shared/operation-context.ts:2250` | `TransactionError` | Driver '${this.driver.driverName}' reported ${written} of ${rows.length} inserted rows for operation '${this.operation}'. |
| `commands/commands.ts:1623` | `TypeError` | INSERT … ON CONFLICT did not produce the required record |
| `commands/commands.ts:1597`<br>`commands/commands.ts:1663`<br>`shared/operation-context.ts:2781` | `TypeError` | INSERT did not produce the required record |
| `shared/operation-context.ts:2168` | `TypeError` | INSERT did not produce the required record identity |
| `shared/operation-context.ts:2862` | `TypeError` | INSERT RETURNING did not produce the required record |
| `shared/operation-context.ts:563`<br>`shared/operation-context.ts:617` | `TransactionError` | Raptor 3 borrowed createMany skipDuplicates requires an operation-owned member rollback region. |
| `shared/query.ts:1162` | `QueryEngineError` | Raptor 3 cannot name the updated value of '${model["~"].names.ts ?? "unknown"}.${field}' under '${update.operator}': the provider owns that operator's rounding inside its own assignment. |
| `shared/query.ts:4360` | `QueryEngineError` | Raptor 3 createMany final read returned inconsistent row counts. |
| `shared/operation-context.ts:2833` | `Error` | Raptor 3 G1 atomic output requires exact identity scratch or segmented RETURNING |
| `shared/operation-context.ts:2753` | `Error` | Raptor 3 interactive output requires RETURNING or one generated increment field |
| `route/client-route.ts:212` | `UnsupportedOperationError` | The Raptor 3 route cannot encode a cached result for '${requestedOperation}' on model '${modelName}': the verb publishes no prepared read. |
| `shared/query.ts:4964`<br>`shared/query.ts:4975` | `InvalidScalarResult` | the value is not a binary value |
| `shared/query.ts:4722` | `InvalidScalarResult` | the value is not an array of finite numbers |
| `shared/operation-context.ts:3020`<br>`shared/operation-context.ts:3057` | `TypeError` | UPDATE did not produce the required record |
| `shared/operation-context.ts:3033` | `TypeError` | UPDATE RETURNING did not produce the required record |
| `shared/operation-context.ts:2372` | `TransactionError` | updateMany selected-row cardinality changed during its locked mutation. |

## Registered refusals

Sentences the shipped engine already carries at `0cc61e61f`: inherited contracts, reported apart because they were never the census's question.

| sites | class | sentence |
| --- | --- | --- |
| `shared/query.ts:3650`<br>`shared/query.ts:3664` | `QueryEngineError` | A distance result cannot be selected together with a model field named '_distance'. |
| `shared/query.ts:4824` | `InvalidScalarResult` | a JSON array is sparse |
| `shared/query.ts:4815` | `InvalidScalarResult` | a JSON integer is outside the safe range |
| `shared/query.ts:4810` | `InvalidScalarResult` | a JSON number is not finite |
| `shared/query.ts:4774`<br>`shared/query.ts:4982` | `InvalidScalarResult` | a list scalar did not return an array |
| `shared/query.ts:4785` | `InvalidScalarResult` | a list scalar returned a sparse array |
| `shared/query.ts:4557` | `InvalidScalarResult` | a required list is null |
| `shared/query.ts:4557` | `InvalidScalarResult` | a required scalar is null |
| `shared/schema.ts:204` | `QueryEngineError` | Arithmetic updates are not portable for ${scalarType} primary key field '${keyField}'. Use an explicit set value. |
| `commands/execution.ts:192` | `NestedWriteError` | Cannot ${origin.operation} relation '${origin.relation}': the located target's referenced field '${field}' is null. |
| `shared/query.ts:1052` | `QueryEngineError` | Cannot divide decimal field '${field}' by zero. |
| `shared/schema.ts:204` | `QueryEngineError` | Cannot divide primary key field '${keyField}' by zero. |
| `shared/operation-context.ts:866` | `TransactionError` | cannot execute non-returning upsert writes atomically because public result parsing cannot be rolled back after an atomic batch commits |
| `commands/execution.ts:100` | `NestedWriteError` | Cannot update relation key field '${pair.source}' to null while mutating relation '${edge.name}'. A null reference names no row for that relation to point at. |
| `shared/operation-context.ts:3177` | `TransactionError` | Concurrent membership change on the singular polymorphic member of relation '${edge.name}': the captured owner's membership was already removed; retry to converge. |
| `shared/query.ts:2850` | `QueryEngineError` | Cursor field '${field}' cannot be null. Cursor must point to a specific record. |
| `shared/query.ts:2614`<br>`shared/query.ts:2742` | `QueryEngineError` | Cursor pagination supports direct scalar sort directions only; relation and vector-distance orderBy are not supported. |
| `shared/query.ts:4867` | `InvalidScalarResult` | custom output schema rejected the value |
| `shared/decimal.ts:56` | `QueryEngineError` | Decimal field '${field}' has no declared precision and scale, so it has no exact value to bind. |
| `shared/decimal.ts:66` | `QueryEngineError` | Decimal field '${field}' received a value that is not an exact decimal. |
| `shared/decimal.ts:85` | `QueryEngineError` | Decimal list '${field}' received a member that is not an exact decimal. |
| `shared/query.ts:3643` | `QueryEngineError` | Distance select supports only one _distance field per select. |
| `shared/operation-context.ts:866` | `TransactionError` | Driver '${driver.driverName}' cannot execute '${this.operation}' because public result parsing cannot be rolled back. |
| `shared/operation-context.ts:1807` | `TransactionError` | Driver '${this.driver.driverName}' omitted the ${this.ownership === "batch-preparation" ? "prepared" : "terminal"} result for operation '${this.operation}'. |
| `shared/operation-context.ts:1878` | `TransactionError` | Driver '${this.driver.driverName}' omitted the result for operation '${this.operation}'. |
| `shared/operation-context.ts:856` | `TransactionError` | Driver "${driver.driverName}" supports neither transactions nor atomic batch execution. |
| `shared/query.ts:1693` | `QueryEngineError` | Field reference '${formatFieldRef(value)}' cannot be used while filtering '${scope}': a field reference may only compare columns of the same model. |
| `shared/query.ts:1698` | `QueryEngineError` | Field reference '${formatFieldRef(value)}' does not name a scalar field of '${scope}'. |
| `shared/query.ts:1704` | `QueryEngineError` | Field reference '${payload.field}' cannot be compared with '${owner.field}' on '${scope}': '${owner.field}' is decimal(${own.precision},${own.scale}) and '${payload.field}' is decimal(${other.precision},${other.scale}). Two decimals compare exactly only when they declare the same precision and scale. |
| `shared/query.ts:863` | `FeatureNotSupportedError` | GeoPoint requires a provider with its physical point tier enabled. |
| `shared/query.ts:4319` | `QueryEngineError` | GroupBy orderBy field '${name}' must be included in 'by' or be an aggregate (_count, _avg, _sum, _min, _max). |
| `shared/query.ts:2271` | `QueryEngineError` | JSON filter '${predicate.operator}' requires a number or string operand. |
| `shared/query.ts:2249` | `QueryEngineError` | JSON filter for field '${predicate.target.scalar!.field}' cannot combine 'path' with the ${sentinel} sentinel: the sentinels distinguish the database NULL from the JSON null value of the WHOLE column. Use 'path' with 'equals: null' to test for a JSON null at that path. |
| `shared/operation-context.ts:2083` | `QueryEngineError` | No data to insert for createMany. |
| `shared/query.ts:2814` | `QueryEngineError` | Paginated scalar ordering requires a primary model identifier. |
| `shared/query.ts:4459`<br>`shared/query.ts:4466` | `QueryEngineError` | Polymorphic relation '${shape.relation}' references a missing '${type}' record. |
| `shared/schema.ts:204` | `QueryEngineError` | Primary key field '${keyField}' accepts exactly one update operation; received ${named.join(", ") \|\| "none"}. |
| `shared/query.ts:675` | `InvalidScalarResult` | provider scalar decoding failed |
| `shared/query.ts:4286` | `QueryEngineError` | Scalar '${key}' used in 'having' must be included in 'by'. |
| `shared/query.ts:2217` | `QueryEngineError` | The 'having' _sum operand for decimal field '${scalar.field}' needs ${digits} coefficient digits, but its value is outside this provider's exact HAVING operand cast domain. The provider may compute a wider sum, but VibORM cannot express this operand through its exact decimal cast without changing or refusing the value written. |
| `shared/query.ts:3743` | `QueryEngineError` | The 'select' statement for model '${model["~"].names.ts ?? "unknown"}' needs at least one truthy value. |
| `route/client-route.ts:291` | `CacheConfigurationError` | The cached result snapshot is malformed. |
| `shared/query.ts:4676` | `InvalidScalarResult` | the Date is invalid or not UTC midnight |
| `shared/query.ts:4651` | `InvalidScalarResult` | the Date is outside the public DateTime domain |
| `shared/query.ts:4594` | `InvalidScalarResult` | the integer is outside the safe range |
| `shared/query.ts:4933` | `InvalidScalarResult` | the normalized precision exceeds milliseconds |
| `route/client-route.ts:278` | `CacheConfigurationError` | The operation result cannot be represented by the cache result codec. |
| `shared/query.ts:4744` | `InvalidScalarResult` | the scalar type is unsupported |
| `shared/query.ts:4631` | `InvalidScalarResult` | the sum is not an exact decimal at this column's scale |
| `shared/query.ts:4928` | `InvalidScalarResult` | the timezone suffix is invalid |
| `shared/query.ts:4727` | `InvalidScalarResult` | the value does not have the configured dimension ${leaf.dimension} |
| `shared/query.ts:4563` | `InvalidScalarResult` | the value is absent |
| `shared/query.ts:4616` | `InvalidScalarResult` | the value is not a canonical finite number |
| `shared/query.ts:4737` | `InvalidScalarResult` | the value is not a canonical GeoPoint |
| `shared/query.ts:4589`<br>`shared/query.ts:4606` | `InvalidScalarResult` | the value is not a canonical integer |
| `shared/query.ts:4702` | `InvalidScalarResult` | the value is not a declared enum member |
| `shared/query.ts:4572` | `InvalidScalarResult` | the value is not a string |
| `shared/query.ts:4691` | `InvalidScalarResult` | the value is not a valid ISO calendar date |
| `shared/query.ts:4920`<br>`shared/query.ts:4926` | `InvalidScalarResult` | the value is not a valid provider time |
| `shared/query.ts:4659` | `InvalidScalarResult` | the value is not a valid provider timestamp in the public DateTime domain |
| `shared/query.ts:4631` | `InvalidScalarResult` | the value is not an exact decimal in this column's declared domain |
| `shared/query.ts:4760` | `InvalidScalarResult` | the value is not an exact decimal list in this column's declared domain |
| `shared/query.ts:4643` | `InvalidScalarResult` | the value is not this column's declared physical timestamp |
| `shared/query.ts:4577` | `InvalidScalarResult` | the value is not true, false, zero, or one |
| `shared/query.ts:4840` | `InvalidScalarResult` | the value is outside the JSON value domain |
| `shared/query.ts:3840` | `QueryEngineError` | Unknown polymorphic target '${String(tag)}' for relation '${relation}'. |
| `shared/query.ts:1070` | `QueryEngineError` | Unknown update operation: ${Object.keys(operation).join(", ")} |
| `shared/query.ts:2331` | `QueryEngineError` | Vector distance ${usage} dimension mismatch for '${field}': expected ${dimension} values, received ${to.length}. |
| `shared/query.ts:2317` | `QueryEngineError` | Vector distance select does not support nullable vector field '${field}'. |
| `shared/query.ts:2321` | `FeatureNotSupportedError` | vector distance select requires a pgvector-enabled PostgreSQL driver |
| `shared/query.ts:2321` | `FeatureNotSupportedError` | vector ordering requires a pgvector-enabled PostgreSQL driver |
| `shared/query.ts:2124` | `FeatureNotSupportedError` | within polygon |

## Internal — the private fits

### `recursive-read` (D-54) — the private recursive-read fit

`Queries.recursive`, `decodeRecursive` and the route's recursive cache codec are built and tested, and no public verb, argument or schema option builds a recursive traversal or asks for a `recursive` published shape.

Privacy re-checked this run: `.recursive(`, `kind: "recursive"` named anywhere in `src/**` outside `src/query-engine/raptor3/shared/query.ts` — no hits; the fit holds.

| sites | class | anchor | sentence |
| --- | --- | --- | --- |
| `shared/query.ts:4446` | `TypeError` | under `=== "recursive"` | A recursive shape requires occurrence rows |
| `shared/query.ts:3342` | `Error` | inside `recursive` | A recursive traversal requires at least one seed |
| `shared/query.ts:4431` | `TypeError` | inside `decodeRecursive` | Invalid provider recursive collection |
| `shared/query.ts:4395` | `TypeError` | inside `decodeRecursive` | Invalid provider recursive occurrence |
| `shared/query.ts:4427` | `TypeError` | inside `decodeRecursive` | Invalid provider recursive parent occurrence |
| `shared/query.ts:4399` | `TypeError` | inside `decodeRecursive` | Invalid provider recursive path |
| `shared/query.ts:4414` | `TypeError` | inside `decodeRecursive` | Invalid provider recursive row |
| `shared/query.ts:4403` | `TypeError` | inside `decodeRecursive` | Invalid provider recursive seed |
| `shared/query.ts:3354` | `Error` | inside `recursive` | Raptor 3 recursive traversal relation '${traversal.relation}' is not self-referential |
| `shared/query.ts:3349` | `Error` | inside `recursive` | Raptor 3 recursive traversal requires one ordinary relation: ${traversal.relation} |
| `route/client-route.ts:332` | `UnsupportedOperationError` | under `case "recursive"` | The Raptor 3 route cannot encode a cached result for '${requestedOperation}': a recursive read's published depth is not a fixed shape. |

## Invariants

States the code cannot be in when it is right, thrown through the engine's one invariant owner. Not refusals, and counted as none.

| sites | through | sentence |
| --- | --- | --- |
| `shared/storage.ts:248` | `assertInvariant` | '${field}' is neither a declared scalar of '${model["~"].names.sql}' nor one of its variant carrier columns. |
| `shared/invariant.ts:28` | `throw` | ${message}: ${String(value)} |
| `commands/commands.ts:1008` | `assertInvariant` | a dependency's read and write share the operation's tree |
| `commands/commands.ts:1019` | `assertInvariant` | a dependency's write precedes its read |
| `shared/query.ts:4074` | `assertInvariant` | a junction-carried slot's integrity probe names junction memberships |
| `commands/commands.ts:1422` | `assertInvariant` | a selected series is enclosed by a record analysis |
| `commands/commands.ts:1429` | `assertInvariant` | a selected series occurrence is expanded once |
| `commands/commands.ts:618` | `assertInvariant` | a series capture target is read only from a capture occurrence |
| `commands/commands.ts:444` | `assertInvariant` | a series capture's target is a sibling of the capture in the same body |
| `commands/execution.ts:1206` | `assertInvariant` | a series member names its captured row |
| `commands/commands.ts:1270` | `assertInvariant` | an occurrence's parent lists that occurrence |
| `commands/index.ts:53` | `unreachable` | client operation |
| `commands/commands.ts:623` | `assertInvariant` | materialization resolved this capture's target |
| `shared/query.ts:3293` | `unreachable` | Raptor 3 aggregate is not implemented |
| `shared/query.ts:2171` | `throw` | Raptor 3 filter operator is not implemented: ${operator} |
| `shared/query.ts:2393` | `throw` | Raptor 3 G3P-05 relation filter is not implemented: ${predicate.quantifier} |
| `shared/query.ts:2296` | `throw` | Raptor 3 JSON filter operator is not implemented: ${predicate.operator} |
| `commands/relation-body.ts:790` | `unreachable` | relation verb |
| `route/client-route.ts:374` | `throw` | The Raptor 3 route cannot encode a cached '${leaf.type}' result for '${requestedOperation}': the leaf publishes no declaring scalar. |
| `commands/execution.ts:1198` | `assertInvariant` | this series was captured in this attempt |
| `shared/storage.ts:72` | `assertInvariant` | Variant carrier '${name}' was addressed with ${variant === undefined ? "no arm" : `the undeclared arm '${variant}'`}: every caller addresses one declared arm or composes the arms itself. |

## Sites without a sentence

Refusal sites whose sentence this census cannot read: a rethrow of a value another owner built (`ctx.failure`, `error`), a property access (`this.incompletePreparation`, a control-flow sentinel no caller sees), a value assigned after its declaration, or a message computed at the site (one built from mapped issues). A sentence built by a local factory, a function of the file, a method of the throw's own class, a local `const` bound to one of those, or a named constant IS read at the throw site. Listed so no refusal site is silently dropped from the total; an invariant site whose message is not a literal (the owner's own throw) is counted among the invariant sites and has no row.

| site | thrown |
| --- | --- |
| `commands/assignments.ts:196` | `failure` |
| `commands/assignments.ts:200` | `this.refusal` |
| `commands/commands.ts:1810` | `transition` |
| `commands/execution.ts:352` | `error` |
| `commands/execution.ts:399` | `selection.required` |
| `commands/execution.ts:417` | `occurrence.refusal` |
| `commands/execution.ts:559` | `ctx.failure` |
| `commands/execution.ts:586` | `supplied ? ctx.failure` |
| `commands/execution.ts:594` | `found.refusal` |
| `commands/execution.ts:629` | `requirement.failure` |
| `commands/execution.ts:1009` | `ctx.failure` |
| `commands/execution.ts:1045` | `ctx.failure` |
| `commands/execution.ts:1117` | `ctx.failure` |
| `commands/execution.ts:1212` | `ctx.failure` |
| `commands/index.ts:281` | `error` |
| `commands/relation-body.ts:450` | `keyRefusal` |
| `commands/relation-body.ts:702` | `keyRefusal` |
| `shared/operation-context.ts:497` | `this.failure` |
| `shared/operation-context.ts:552` | `this.failure` |
| `shared/operation-context.ts:574` | `error` |
| `shared/operation-context.ts:757` | `error` |
| `shared/operation-context.ts:767` | `primary` |
| `shared/operation-context.ts:812` | `error` |
| `shared/operation-context.ts:830` | `this.failure` |
| `shared/operation-context.ts:834` | `error` |
| `shared/operation-context.ts:885` | `this.requiresEnvelope` |
| `shared/operation-context.ts:958` | `error` |
| `shared/operation-context.ts:960` | `error` |
| `shared/operation-context.ts:985` | `error` |
| `shared/operation-context.ts:987` | `error` |
| `shared/operation-context.ts:1017` | `this.incompletePreparation` |
| `shared/operation-context.ts:1145` | `missing` |
| `shared/operation-context.ts:1211` | `premise.failure` |
| `shared/operation-context.ts:1245` | `this.failure` |
| `shared/operation-context.ts:1254` | `failure` |
| `shared/operation-context.ts:1294` | `this.incompletePreparation` |
| `shared/operation-context.ts:1381` | `this.answered` |
| `shared/operation-context.ts:1582` | `publishingGeneratedOutput \|\| continuations.length > 0         ? this.failure` |
| `shared/operation-context.ts:1608` | `held         ? this.answered` |
| `shared/operation-context.ts:1637` | `held         ? this.answered` |
| `shared/operation-context.ts:1641` | `this.answered` |
| `shared/operation-context.ts:1696` | `this.answered` |
| `shared/operation-context.ts:1846` | `queries.length ? this.failure` |
| `shared/operation-context.ts:1946` | `this.failure` |
| `shared/operation-context.ts:1988` | `error` |
| `shared/operation-context.ts:2008` | `decoded.failure` |
| `shared/operation-context.ts:2035` | `outcomeFailure` |
| `shared/operation-context.ts:2036` | `this.answered` |
| `shared/operation-context.ts:2117` | `this.incompletePreparation` |
| `shared/operation-context.ts:2151` | `error` |
| `shared/operation-context.ts:2499` | `this.incompletePreparation` |
| `shared/operation-context.ts:2683` | `this.failure` |
| `shared/operation-context.ts:2769` | `error` |
| `shared/operation-context.ts:2867` | `this.failure` |
| `shared/parse-boundary.ts:45` | `ValidationError` |
| `shared/query.ts:674` | `error` |
| `shared/query.ts:4358` | `query.expectedRows.missing` |
