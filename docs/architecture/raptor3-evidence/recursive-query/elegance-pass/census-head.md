# Raptor 3 refusal census

Produced by `scripts/raptor3-refusal-census.mjs` on `HEAD`. Shipped-sentence corpus: `0cc61e61f`.

Three outcomes, told apart by construction. An **invariant** throws through `shared/invariant.ts` and is not a refusal. An **internal** sentence lies inside a declared private fit whose privacy this run re-checked. A **refusal** is everything else: *inherited* when the sentence is matched in the old engine's own corpus at the revision named above, a *candidate* sentence when it is not.

**These are counts of SENTENCES, not of capabilities.** A candidate sentence is one this engine spells and the old one did not; it is not an unsupported operation family. The counts include the integrity failures (a member that is gone, a captured row another writer replaced) and the provider-result failures (a driver that answered a malformed value) that a correct engine must state, and they include sentences no admitted payload can reach. What this engine does and does not support is the behavioural closure inventory's fact, one row per admitted fact: `docs/architecture/raptor3-evidence/g4/release/closure/fc00/inventory.md`. Which admitted payload reaches a given sentence stays the per-row ruling of `g4/release/plan/refusals-map.md`.

## Counts

| outcome | sites | distinct sentences |
| --- | --- | --- |
| invariant | 24 | 23 |
| internal (private fits) | 0 | 0 |
| refusal — inherited (matched in the old-engine corpus) | 76 | 75 |
| refusal — candidate (unmatched) | 47 | 36 |
| no sentence (rethrow) | 58 | — |
| **total sites** | **205** | |

**Candidate sentences unmatched in the old-engine corpus: 36 distinct sentences** at 47 sites, against the **55** the map started from (-19). Earlier notes call this number "36 public refusals": it is the same count, of sentences, and it is not a count of unavailable operations.

## Candidate sentences unmatched in the old-engine corpus

A sentence this engine spells that is not matched in the old engine's corpus. Nothing in the tree forecloses it; which admitted payload reaches each one is the map's per-row ruling (`g4/release/plan/refusals-map.md`), which this census does not re-derive. Integrity and provider-result sentences are counted here like any other: a row in this table is a sentence, never an operation the engine cannot perform.

| sites | class | sentence |
| --- | --- | --- |
| `shared/query.ts:4873` | `InvalidScalarResult` | a document the statement always builds is null |
| `shared/query.ts:5263` | `InvalidScalarResult` | a JSON value contains itself |
| `shared/query.ts:4880` | `InvalidScalarResult` | a requested document is not a provider row |
| `shared/query.ts:4862` | `InvalidScalarResult` | a requested relation is not a provider array |
| `shared/operation-context.ts:2426` | `TransactionError` | deleteMany selected-row cardinality changed during its locked mutation. |
| `shared/query.ts:2438` | `FeatureNotSupportedError` | distance ${usage} |
| `shared/operation-context.ts:2130` | `TransactionError` | Driver '${this.driver.driverName}' cannot locate one selected createMany row after insertion. |
| `shared/operation-context.ts:1130`<br>`shared/operation-context.ts:1895`<br>`shared/operation-context.ts:2583` | `TransactionError` | Driver '${this.driver.driverName}' omitted the prepared result for operation '${this.operation}'. |
| `shared/operation-context.ts:2255` | `TransactionError` | Driver '${this.driver.driverName}' reported ${written} of ${rows.length} inserted rows for operation '${this.operation}'. |
| `commands/commands.ts:1649` | `TypeError` | INSERT … ON CONFLICT did not produce the required record |
| `commands/commands.ts:1620`<br>`commands/commands.ts:1689`<br>`shared/operation-context.ts:2798` | `TypeError` | INSERT did not produce the required record |
| `shared/operation-context.ts:2172` | `TypeError` | INSERT did not produce the required record identity |
| `shared/operation-context.ts:2879` | `TypeError` | INSERT RETURNING did not produce the required record |
| `shared/query.ts:4652` | `TypeError` | Invalid provider duplicate recursive edge |
| `shared/query.ts:4618` | `TypeError` | Invalid provider duplicate recursive node |
| `shared/query.ts:4637` | `TypeError` | Invalid provider exhaustive recursive depth |
| `shared/query.ts:4592`<br>`shared/query.ts:4598` | `TypeError` | Invalid provider recursive carrier |
| `shared/query.ts:4647`<br>`shared/query.ts:4726`<br>`shared/query.ts:4729` | `TypeError` | Invalid provider recursive depth |
| `shared/query.ts:4627` | `TypeError` | Invalid provider recursive edge |
| `shared/query.ts:4632`<br>`shared/query.ts:4671` | `TypeError` | Invalid provider recursive edge endpoint |
| `shared/query.ts:4602`<br>`shared/query.ts:4607` | `TypeError` | Invalid provider recursive identity |
| `shared/query.ts:4614` | `TypeError` | Invalid provider recursive node |
| `shared/query.ts:4743` | `TypeError` | Invalid provider recursive row |
| `shared/query.ts:4674` | `TypeError` | Invalid provider recursive singular relation |
| `shared/query.ts:4731` | `TypeError` | Invalid provider unreachable recursive node |
| `shared/operation-context.ts:566`<br>`shared/operation-context.ts:620` | `TransactionError` | Raptor 3 borrowed createMany skipDuplicates requires an operation-owned member rollback region. |
| `shared/query.ts:1207` | `QueryEngineError` | Raptor 3 cannot name the updated value of '${model["~"].names.ts ?? "unknown"}.${field}' under '${update.operator}': the provider owns that operator's rounding inside its own assignment. |
| `shared/query.ts:4566` | `QueryEngineError` | Raptor 3 createMany final read returned inconsistent row counts. |
| `shared/operation-context.ts:2850` | `Error` | Raptor 3 G1 atomic output requires exact identity scratch or segmented RETURNING |
| `shared/operation-context.ts:2770` | `Error` | Raptor 3 interactive output requires RETURNING or one generated increment field |
| `shared/query.ts:4791` | `QueryEngineError` | Recursive relation '${shape.relation}' contains a cycle. |
| `route/client-route.ts:213` | `UnsupportedOperationError` | The Raptor 3 route cannot encode a cached result for '${requestedOperation}' on model '${modelName}': the verb publishes no prepared read. |
| `shared/query.ts:5386`<br>`shared/query.ts:5397` | `InvalidScalarResult` | the value is not a binary value |
| `shared/query.ts:5116` | `InvalidScalarResult` | the value is not an array of finite numbers |
| `shared/operation-context.ts:3104` | `TypeError` | UPDATE did not produce the required record |
| `shared/operation-context.ts:2352` | `TransactionError` | updateMany selected-row cardinality changed during its locked mutation. |

## Inherited sentences

Sentences matched in the old engine's own corpus at `0cc61e61f` by the receipts' matching (the longest static fragment, or every fragment of 12 characters or more): inherited contracts, reported apart because they were never the census's question.

| sites | class | sentence |
| --- | --- | --- |
| `shared/query.ts:3503`<br>`shared/query.ts:3523`<br>`shared/query.ts:3630` | `QueryEngineError` | A distance result cannot be selected together with a model field named '_distance'. |
| `shared/query.ts:5228` | `InvalidScalarResult` | a JSON array is sparse |
| `shared/query.ts:5218` | `InvalidScalarResult` | a JSON integer is outside the safe range |
| `shared/query.ts:5213` | `InvalidScalarResult` | a JSON number is not finite |
| `shared/query.ts:5168`<br>`shared/query.ts:5404` | `InvalidScalarResult` | a list scalar did not return an array |
| `shared/query.ts:5179` | `InvalidScalarResult` | a list scalar returned a sparse array |
| `shared/query.ts:4941` | `InvalidScalarResult` | a required list is null |
| `shared/query.ts:4941` | `InvalidScalarResult` | a required scalar is null |
| `shared/schema.ts:206` | `QueryEngineError` | Arithmetic updates are not portable for ${scalarType} primary key field '${keyField}'. Use an explicit set value. |
| `commands/execution.ts:1367` | `NestedWriteError` | Cannot ${series.mutation.kind} relation '${edge.name}': parent record changed across a committed segment. |
| `commands/execution.ts:191` | `NestedWriteError` | Cannot connect relation '${relation}': the located target's referenced field '${referenced}' is null. |
| `shared/query.ts:1097` | `QueryEngineError` | Cannot divide decimal field '${field}' by zero. |
| `shared/schema.ts:206` | `QueryEngineError` | Cannot divide primary key field '${keyField}' by zero. |
| `shared/operation-context.ts:869` | `TransactionError` | cannot execute non-returning upsert writes atomically because public result parsing cannot be rolled back after an atomic batch commits |
| `commands/execution.ts:111` | `NestedWriteError` | Cannot update relation key field '${pair.source}' to null while mutating relation '${edge.name}'. A null reference names no row for that relation to point at. |
| `shared/operation-context.ts:3224` | `TransactionError` | Concurrent membership change on the singular polymorphic member of relation '${edge.name}': the captured owner's membership was already removed; retry to converge. |
| `shared/query.ts:2953` | `QueryEngineError` | Cursor field '${field}' cannot be null. Cursor must point to a specific record. |
| `shared/query.ts:2697`<br>`shared/query.ts:2825` | `QueryEngineError` | Cursor pagination supports direct scalar sort directions only; relation and vector-distance orderBy are not supported. |
| `shared/query.ts:5289` | `InvalidScalarResult` | custom output schema rejected the value |
| `shared/decimal.ts:56` | `QueryEngineError` | Decimal field '${field}' has no declared precision and scale, so it has no exact value to bind. |
| `shared/decimal.ts:66` | `QueryEngineError` | Decimal field '${field}' received a value that is not an exact decimal. |
| `shared/decimal.ts:85` | `QueryEngineError` | Decimal list '${field}' received a member that is not an exact decimal. |
| `shared/query.ts:3494` | `QueryEngineError` | Distance select supports only one _distance field per select. |
| `shared/operation-context.ts:869` | `TransactionError` | Driver '${driver.driverName}' cannot execute '${this.operation}' because public result parsing cannot be rolled back. |
| `shared/operation-context.ts:1797` | `TransactionError` | Driver '${this.driver.driverName}' omitted the ${this.ownership === "batch-preparation" ? "prepared" : "terminal"} result for operation '${this.operation}'. |
| `shared/operation-context.ts:1868` | `TransactionError` | Driver '${this.driver.driverName}' omitted the result for operation '${this.operation}'. |
| `shared/operation-context.ts:859` | `TransactionError` | Driver "${driver.driverName}" supports neither transactions nor atomic batch execution. |
| `shared/operation-context.ts:638` | `QueryEngineError` | Driver "${driver}" returned a malformed ${scalarType} scalar for operation "${operation}": ${error.reason}. |
| `shared/query.ts:1798` | `QueryEngineError` | Field reference '${formatFieldRef(value)}' cannot be used while filtering '${scope}': a field reference may only compare columns of the same model. |
| `shared/query.ts:1803` | `QueryEngineError` | Field reference '${formatFieldRef(value)}' does not name a scalar field of '${scope}'. |
| `shared/query.ts:1809` | `QueryEngineError` | Field reference '${payload.field}' cannot be compared with '${owner.field}' on '${scope}': '${owner.field}' is decimal(${own.precision},${own.scale}) and '${payload.field}' is decimal(${other.precision},${other.scale}). Two decimals compare exactly only when they declare the same precision and scale. |
| `shared/query.ts:887` | `FeatureNotSupportedError` | GeoPoint requires a provider with its physical point tier enabled. |
| `shared/query.ts:4525` | `QueryEngineError` | GroupBy orderBy field '${name}' must be included in 'by' or be an aggregate (_count, _avg, _sum, _min, _max). |
| `shared/query.ts:2370` | `QueryEngineError` | JSON filter '${predicate.operator}' requires a number or string operand. |
| `shared/query.ts:2348` | `QueryEngineError` | JSON filter for field '${predicate.target.scalar!.field}' cannot combine 'path' with the ${sentinel} sentinel: the sentinels distinguish the database NULL from the JSON null value of the WHOLE column. Use 'path' with 'equals: null' to test for a JSON null at that path. |
| `shared/operation-context.ts:2109` | `QueryEngineError` | No data to insert for createMany. |
| `shared/query.ts:2917` | `QueryEngineError` | Paginated scalar ordering requires a primary model identifier. |
| `shared/query.ts:4843`<br>`shared/query.ts:4850` | `QueryEngineError` | Polymorphic relation '${shape.relation}' references a missing '${type}' record. |
| `shared/schema.ts:206` | `QueryEngineError` | Primary key field '${keyField}' accepts exactly one update operation; received ${named.join(", ") \|\| "none"}. |
| `shared/query.ts:689` | `InvalidScalarResult` | provider scalar decoding failed |
| `shared/query.ts:4492` | `QueryEngineError` | Scalar '${key}' used in 'having' must be included in 'by'. |
| `shared/query.ts:2316` | `QueryEngineError` | The 'having' _sum operand for decimal field '${scalar.field}' needs ${digits} coefficient digits, but its value is outside this provider's exact HAVING operand cast domain. The provider may compute a wider sum, but VibORM cannot express this operand through its exact decimal cast without changing or refusing the value written. |
| `shared/query.ts:3603` | `QueryEngineError` | The 'select' statement for model '${model["~"].names.ts ?? "unknown"}' needs at least one truthy value. |
| `route/client-route.ts:292` | `CacheConfigurationError` | The cached result snapshot is malformed. |
| `shared/query.ts:5070` | `InvalidScalarResult` | the Date is invalid or not UTC midnight |
| `shared/query.ts:5035` | `InvalidScalarResult` | the Date is outside the public DateTime domain |
| `shared/query.ts:4978` | `InvalidScalarResult` | the integer is outside the safe range |
| `shared/query.ts:5355` | `InvalidScalarResult` | the normalized precision exceeds milliseconds |
| `route/client-route.ts:279` | `CacheConfigurationError` | The operation result cannot be represented by the cache result codec. |
| `shared/query.ts:5138` | `InvalidScalarResult` | the scalar type is unsupported |
| `shared/query.ts:5015` | `InvalidScalarResult` | the sum is not an exact decimal at this column's scale |
| `shared/query.ts:5350` | `InvalidScalarResult` | the timezone suffix is invalid |
| `shared/query.ts:5121` | `InvalidScalarResult` | the value does not have the configured dimension ${leaf.dimension} |
| `shared/query.ts:4947` | `InvalidScalarResult` | the value is absent |
| `shared/query.ts:5000` | `InvalidScalarResult` | the value is not a canonical finite number |
| `shared/query.ts:5131` | `InvalidScalarResult` | the value is not a canonical GeoPoint |
| `shared/query.ts:4973`<br>`shared/query.ts:4990` | `InvalidScalarResult` | the value is not a canonical integer |
| `shared/query.ts:5096` | `InvalidScalarResult` | the value is not a declared enum member |
| `shared/query.ts:4956` | `InvalidScalarResult` | the value is not a string |
| `shared/query.ts:5085` | `InvalidScalarResult` | the value is not a valid ISO calendar date |
| `shared/query.ts:5342`<br>`shared/query.ts:5348` | `InvalidScalarResult` | the value is not a valid provider time |
| `shared/query.ts:5043` | `InvalidScalarResult` | the value is not a valid provider timestamp in the public DateTime domain |
| `shared/query.ts:5015` | `InvalidScalarResult` | the value is not an exact decimal in this column's declared domain |
| `shared/query.ts:5154` | `InvalidScalarResult` | the value is not an exact decimal list in this column's declared domain |
| `shared/query.ts:5027` | `InvalidScalarResult` | the value is not this column's declared physical timestamp |
| `shared/query.ts:4961` | `InvalidScalarResult` | the value is not true, false, zero, or one |
| `shared/query.ts:5247` | `InvalidScalarResult` | the value is outside the JSON value domain |
| `shared/query.ts:3735` | `QueryEngineError` | Unknown polymorphic target '${String(tag)}' for relation '${relation}'. |
| `shared/query.ts:1115` | `QueryEngineError` | Unknown update operation: ${Object.keys(operation).join(", ")} |
| `commands/execution.ts:1403` | `UnsupportedOperationError` | updateMany matched ${count} rows, so it cannot apply '${verb}' to relation '${name}': ${stored} — the last row updated would take it from the others. Narrow the filter (or add 'limit: 1') so exactly one row matches, or write this relation in a separate call. |
| `shared/query.ts:2430` | `QueryEngineError` | Vector distance ${usage} dimension mismatch for '${field}': expected ${dimension} values, received ${to.length}. |
| `shared/query.ts:2416` | `QueryEngineError` | Vector distance select does not support nullable vector field '${field}'. |
| `shared/query.ts:2420` | `FeatureNotSupportedError` | vector distance select requires a pgvector-enabled PostgreSQL driver |
| `shared/query.ts:2420` | `FeatureNotSupportedError` | vector ordering requires a pgvector-enabled PostgreSQL driver |
| `shared/query.ts:2223` | `FeatureNotSupportedError` | within polygon |

## Internal — the private fits

## Invariants

States the code cannot be in when it is right, thrown through the engine's one invariant owner. Not refusals, and counted as none.

| sites | through | sentence |
| --- | --- | --- |
| `shared/storage.ts:248` | `assertInvariant` | '${field}' is neither a declared scalar of '${model["~"].names.sql}' nor one of its variant carrier columns. |
| `shared/invariant.ts:28` | `throw` | ${message}: ${String(value)} |
| `commands/commands.ts:1038` | `assertInvariant` | a dependency's read and write share the operation's tree |
| `commands/commands.ts:1049` | `assertInvariant` | a dependency's write precedes its read |
| `shared/query.ts:3970` | `assertInvariant` | a junction-carried slot's integrity probe names junction memberships |
| `commands/commands.ts:1446` | `assertInvariant` | a selected series is enclosed by a record analysis |
| `commands/commands.ts:1453` | `assertInvariant` | a selected series occurrence is expanded once |
| `commands/commands.ts:631` | `assertInvariant` | a series capture target is read only from a capture occurrence |
| `commands/commands.ts:455` | `assertInvariant` | a series capture's target is a sibling of the capture in the same body |
| `commands/execution.ts:1643` | `assertInvariant` | a series member names its captured row |
| `shared/query.ts:4733` | `assertInvariant` | A singular recursive slot may be empty: CM002 refuses a required self foreign key. |
| `commands/commands.ts:1306` | `assertInvariant` | an occurrence's parent lists that occurrence |
| `commands/index.ts:53` | `unreachable` | client operation |
| `commands/commands.ts:636` | `assertInvariant` | materialization resolved this capture's target |
| `shared/query.ts:3385` | `unreachable` | Raptor 3 aggregate is not implemented |
| `shared/query.ts:2270` | `throw` | Raptor 3 filter operator is not implemented: ${operator} |
| `shared/query.ts:2492` | `throw` | Raptor 3 G3P-05 relation filter is not implemented: ${predicate.quantifier} |
| `shared/query.ts:2395` | `throw` | Raptor 3 JSON filter operator is not implemented: ${predicate.operator} |
| `shared/query.ts:4158` | `assertInvariant` | Recursive relation lowering requires admitted recurrence meaning. |
| `commands/relation-body.ts:792` | `unreachable` | relation verb |
| `route/client-route.ts:380` | `throw` | The Raptor 3 route cannot encode a cached '${leaf.type}' result for '${requestedOperation}': the leaf publishes no declaring scalar. |
| `commands/execution.ts:1634` | `assertInvariant` | this series was captured in this attempt |
| `shared/storage.ts:72` | `assertInvariant` | Variant carrier '${name}' was addressed with ${variant === undefined ? "no arm" : `the undeclared arm '${variant}'`}: every caller addresses one declared arm or composes the arms itself. |

## Sites without a sentence

Refusal sites whose sentence this census cannot read: a rethrow of a value another owner built (a catch binding, a parameter), a property access (`this.incompletePreparation`, a control-flow sentinel no caller sees), a property of another object (`refusal.error`), a value assigned after its declaration, or a message computed at the site (one built from mapped issues). A sentence built by a local factory, a function of the file, a method of the throw's own class, a local `const` bound to one of those, or a named constant IS read at the throw site — including when the site hands it to the failure owner (`failure(…)`), whose own substituted sentences are read once at the owner itself. Listed so no refusal site is silently dropped from the total; an invariant site whose message is not a literal (the owner's own throw) is counted among the invariant sites and has no row.

| site | thrown |
| --- | --- |
| `commands/assignments.ts:203` | `failure` |
| `commands/assignments.ts:207` | `this.refusal` |
| `commands/commands.ts:1852` | `transition` |
| `commands/execution.ts:497` | `error` |
| `commands/execution.ts:544` | `selection.required` |
| `commands/execution.ts:727` | `failure` |
| `commands/execution.ts:755` | `occurrence.refusal` |
| `commands/execution.ts:907` | `ctx.failure` |
| `commands/execution.ts:934` | `supplied ? ctx.failure` |
| `commands/execution.ts:942` | `found.refusal` |
| `commands/execution.ts:1475` | `ctx.failure` |
| `commands/execution.ts:1624` | `failure` |
| `commands/execution.ts:1649` | `ctx.failure` |
| `commands/index.ts:281` | `error` |
| `commands/relation-body.ts:448` | `keyRefusal` |
| `commands/relation-body.ts:704` | `keyRefusal` |
| `shared/operation-context.ts:498` | `this.failure` |
| `shared/operation-context.ts:555` | `this.failure` |
| `shared/operation-context.ts:577` | `error` |
| `shared/operation-context.ts:760` | `error` |
| `shared/operation-context.ts:770` | `primary` |
| `shared/operation-context.ts:815` | `error` |
| `shared/operation-context.ts:833` | `this.failure` |
| `shared/operation-context.ts:837` | `error` |
| `shared/operation-context.ts:888` | `this.requiresEnvelope` |
| `shared/operation-context.ts:961` | `error` |
| `shared/operation-context.ts:963` | `error` |
| `shared/operation-context.ts:988` | `error` |
| `shared/operation-context.ts:990` | `error` |
| `shared/operation-context.ts:1020` | `this.incompletePreparation` |
| `shared/operation-context.ts:1148` | `missing` |
| `shared/operation-context.ts:1201` | `premise.failure` |
| `shared/operation-context.ts:1235` | `this.failure` |
| `shared/operation-context.ts:1244` | `failure` |
| `shared/operation-context.ts:1284` | `this.incompletePreparation` |
| `shared/operation-context.ts:1371` | `this.answered` |
| `shared/operation-context.ts:1572` | `publishingGeneratedOutput \|\| continuations.length > 0         ? this.failure` |
| `shared/operation-context.ts:1598` | `held         ? this.answered` |
| `shared/operation-context.ts:1627` | `held         ? this.answered` |
| `shared/operation-context.ts:1631` | `this.answered` |
| `shared/operation-context.ts:1686` | `this.answered` |
| `shared/operation-context.ts:1836` | `queries.length ? this.failure` |
| `shared/operation-context.ts:1936` | `this.failure` |
| `shared/operation-context.ts:1978` | `error` |
| `shared/operation-context.ts:1998` | `decoded.failure` |
| `shared/operation-context.ts:2030` | `outcomeFailure` |
| `shared/operation-context.ts:2031` | `this.answered` |
| `shared/operation-context.ts:2121` | `this.incompletePreparation` |
| `shared/operation-context.ts:2155` | `error` |
| `shared/operation-context.ts:2448` | `this.incompletePreparation` |
| `shared/operation-context.ts:2706` | `this.failure` |
| `shared/operation-context.ts:2786` | `error` |
| `shared/operation-context.ts:2884` | `this.failure` |
| `shared/operation-context.ts:3063` | `` |
| `shared/operation-context.ts:3079` | `` |
| `shared/parse-boundary.ts:45` | `ValidationError` |
| `shared/query.ts:688` | `error` |
| `shared/query.ts:4564` | `query.expectedRows.missing` |
