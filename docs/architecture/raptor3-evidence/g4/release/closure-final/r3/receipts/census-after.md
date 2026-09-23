# Raptor 3 refusal census

Produced by `scripts/raptor3-refusal-census.mjs` on `cdd787ac8` with 7 uncommitted engine file(s). Shipped-sentence corpus: `0cc61e61f`.

Three outcomes, told apart by construction. An **invariant** throws through `shared/invariant.ts` and is not a refusal. An **internal** sentence lies inside a declared private fit whose privacy this run re-checked. A **refusal** is everything else: *inherited* when the sentence is matched in the old engine's own corpus at the revision named above, a *candidate* sentence when it is not.

**These are counts of SENTENCES, not of capabilities.** A candidate sentence is one this engine spells and the old one did not; it is not an unsupported operation family. The counts include the integrity failures (a member that is gone, a captured row another writer replaced) and the provider-result failures (a driver that answered a malformed value) that a correct engine must state, and they include sentences no admitted payload can reach. What this engine does and does not support is the behavioural closure inventory's fact, one row per admitted fact: `docs/architecture/raptor3-evidence/g4/release/closure/fc00/inventory.md`. Which admitted payload reaches a given sentence stays the per-row ruling of `g4/release/plan/refusals-map.md`.

## Counts

| outcome | sites | distinct sentences |
| --- | --- | --- |
| invariant | 22 | 21 |
| internal (private fits) | 11 | 11 |
| refusal — inherited (matched in the old-engine corpus) | 75 | 75 |
| refusal — candidate (unmatched) | 30 | 23 |
| no sentence (rethrow) | 55 | — |
| **total sites** | **193** | |

**Candidate sentences unmatched in the old-engine corpus: 23 distinct sentences** at 30 sites, against the **55** the map started from (-32). Earlier notes call this number "23 public refusals": it is the same count, of sentences, and it is not a count of unavailable operations.

## Candidate sentences unmatched in the old-engine corpus

A sentence this engine spells that is not matched in the old engine's corpus. Nothing in the tree forecloses it; which admitted payload reaches each one is the map's per-row ruling (`g4/release/plan/refusals-map.md`), which this census does not re-derive. Integrity and provider-result sentences are counted here like any other: a row in this table is a sentence, never an operation the engine cannot perform.

| sites | class | sentence |
| --- | --- | --- |
| `shared/query.ts:4598` | `InvalidScalarResult` | a document the statement always builds is null |
| `shared/query.ts:4605` | `InvalidScalarResult` | a requested document is not a provider row |
| `shared/query.ts:4587` | `InvalidScalarResult` | a requested relation is not a provider array |
| `shared/operation-context.ts:2429` | `TransactionError` | deleteMany selected-row cardinality changed during its locked mutation. |
| `shared/query.ts:2432` | `FeatureNotSupportedError` | distance ${usage} |
| `shared/operation-context.ts:2099` | `TransactionError` | Driver '${this.driver.driverName}' cannot locate one selected createMany row after insertion. |
| `shared/operation-context.ts:1130`<br>`shared/operation-context.ts:1895`<br>`shared/operation-context.ts:2583` | `TransactionError` | Driver '${this.driver.driverName}' omitted the prepared result for operation '${this.operation}'. |
| `shared/operation-context.ts:2223` | `TransactionError` | Driver '${this.driver.driverName}' reported ${written} of ${rows.length} inserted rows for operation '${this.operation}'. |
| `commands/commands.ts:1641` | `TypeError` | INSERT … ON CONFLICT did not produce the required record |
| `commands/commands.ts:1615`<br>`commands/commands.ts:1681`<br>`shared/operation-context.ts:2804` | `TypeError` | INSERT did not produce the required record |
| `shared/operation-context.ts:2141` | `TypeError` | INSERT did not produce the required record identity |
| `shared/operation-context.ts:2885` | `TypeError` | INSERT RETURNING did not produce the required record |
| `shared/operation-context.ts:566`<br>`shared/operation-context.ts:620` | `TransactionError` | Raptor 3 borrowed createMany skipDuplicates requires an operation-owned member rollback region. |
| `shared/query.ts:1165` | `QueryEngineError` | Raptor 3 cannot name the updated value of '${model["~"].names.ts ?? "unknown"}.${field}' under '${update.operator}': the provider owns that operator's rounding inside its own assignment. |
| `shared/query.ts:4469` | `QueryEngineError` | Raptor 3 createMany final read returned inconsistent row counts. |
| `shared/operation-context.ts:2856` | `Error` | Raptor 3 G1 atomic output requires exact identity scratch or segmented RETURNING |
| `shared/operation-context.ts:2776` | `Error` | Raptor 3 interactive output requires RETURNING or one generated increment field |
| `route/client-route.ts:212` | `UnsupportedOperationError` | The Raptor 3 route cannot encode a cached result for '${requestedOperation}' on model '${modelName}': the verb publishes no prepared read. |
| `shared/query.ts:5083`<br>`shared/query.ts:5094` | `InvalidScalarResult` | the value is not a binary value |
| `shared/query.ts:4841` | `InvalidScalarResult` | the value is not an array of finite numbers |
| `shared/operation-context.ts:3058`<br>`shared/operation-context.ts:3095` | `TypeError` | UPDATE did not produce the required record |
| `shared/operation-context.ts:3071` | `TypeError` | UPDATE RETURNING did not produce the required record |
| `shared/operation-context.ts:2340` | `TransactionError` | updateMany selected-row cardinality changed during its locked mutation. |

## Inherited sentences

Sentences matched in the old engine's own corpus at `0cc61e61f` by the receipts' matching (the longest static fragment, or every fragment of 12 characters or more): inherited contracts, reported apart because they were never the census's question.

| sites | class | sentence |
| --- | --- | --- |
| `shared/query.ts:3743`<br>`shared/query.ts:3757` | `QueryEngineError` | A distance result cannot be selected together with a model field named '_distance'. |
| `shared/query.ts:4943` | `InvalidScalarResult` | a JSON array is sparse |
| `shared/query.ts:4934` | `InvalidScalarResult` | a JSON integer is outside the safe range |
| `shared/query.ts:4929` | `InvalidScalarResult` | a JSON number is not finite |
| `shared/query.ts:4893`<br>`shared/query.ts:5101` | `InvalidScalarResult` | a list scalar did not return an array |
| `shared/query.ts:4904` | `InvalidScalarResult` | a list scalar returned a sparse array |
| `shared/query.ts:4666` | `InvalidScalarResult` | a required list is null |
| `shared/query.ts:4666` | `InvalidScalarResult` | a required scalar is null |
| `shared/schema.ts:204` | `QueryEngineError` | Arithmetic updates are not portable for ${scalarType} primary key field '${keyField}'. Use an explicit set value. |
| `commands/execution.ts:1081` | `NestedWriteError` | Cannot ${series.mutation.kind} relation '${edge.name}': parent record changed across a committed segment. |
| `commands/execution.ts:181` | `NestedWriteError` | Cannot connect relation '${relation}': the located target's referenced field '${referenced}' is null. |
| `shared/query.ts:1055` | `QueryEngineError` | Cannot divide decimal field '${field}' by zero. |
| `shared/schema.ts:204` | `QueryEngineError` | Cannot divide primary key field '${keyField}' by zero. |
| `shared/operation-context.ts:869` | `TransactionError` | cannot execute non-returning upsert writes atomically because public result parsing cannot be rolled back after an atomic batch commits |
| `commands/execution.ts:101` | `NestedWriteError` | Cannot update relation key field '${pair.source}' to null while mutating relation '${edge.name}'. A null reference names no row for that relation to point at. |
| `shared/operation-context.ts:3215` | `TransactionError` | Concurrent membership change on the singular polymorphic member of relation '${edge.name}': the captured owner's membership was already removed; retry to converge. |
| `shared/query.ts:2943` | `QueryEngineError` | Cursor field '${field}' cannot be null. Cursor must point to a specific record. |
| `shared/query.ts:2707`<br>`shared/query.ts:2835` | `QueryEngineError` | Cursor pagination supports direct scalar sort directions only; relation and vector-distance orderBy are not supported. |
| `shared/query.ts:4986` | `InvalidScalarResult` | custom output schema rejected the value |
| `shared/decimal.ts:56` | `QueryEngineError` | Decimal field '${field}' has no declared precision and scale, so it has no exact value to bind. |
| `shared/decimal.ts:66` | `QueryEngineError` | Decimal field '${field}' received a value that is not an exact decimal. |
| `shared/decimal.ts:85` | `QueryEngineError` | Decimal list '${field}' received a member that is not an exact decimal. |
| `shared/query.ts:3736` | `QueryEngineError` | Distance select supports only one _distance field per select. |
| `shared/operation-context.ts:869` | `TransactionError` | Driver '${driver.driverName}' cannot execute '${this.operation}' because public result parsing cannot be rolled back. |
| `shared/operation-context.ts:1797` | `TransactionError` | Driver '${this.driver.driverName}' omitted the ${this.ownership === "batch-preparation" ? "prepared" : "terminal"} result for operation '${this.operation}'. |
| `shared/operation-context.ts:1868` | `TransactionError` | Driver '${this.driver.driverName}' omitted the result for operation '${this.operation}'. |
| `shared/operation-context.ts:859` | `TransactionError` | Driver "${driver.driverName}" supports neither transactions nor atomic batch execution. |
| `shared/operation-context.ts:638` | `QueryEngineError` | Driver "${driver}" returned a malformed ${scalarType} scalar for operation "${operation}": ${error.reason}. |
| `shared/query.ts:1786` | `QueryEngineError` | Field reference '${formatFieldRef(value)}' cannot be used while filtering '${scope}': a field reference may only compare columns of the same model. |
| `shared/query.ts:1791` | `QueryEngineError` | Field reference '${formatFieldRef(value)}' does not name a scalar field of '${scope}'. |
| `shared/query.ts:1797` | `QueryEngineError` | Field reference '${payload.field}' cannot be compared with '${owner.field}' on '${scope}': '${owner.field}' is decimal(${own.precision},${own.scale}) and '${payload.field}' is decimal(${other.precision},${other.scale}). Two decimals compare exactly only when they declare the same precision and scale. |
| `shared/query.ts:866` | `FeatureNotSupportedError` | GeoPoint requires a provider with its physical point tier enabled. |
| `shared/query.ts:4428` | `QueryEngineError` | GroupBy orderBy field '${name}' must be included in 'by' or be an aggregate (_count, _avg, _sum, _min, _max). |
| `shared/query.ts:2364` | `QueryEngineError` | JSON filter '${predicate.operator}' requires a number or string operand. |
| `shared/query.ts:2342` | `QueryEngineError` | JSON filter for field '${predicate.target.scalar!.field}' cannot combine 'path' with the ${sentinel} sentinel: the sentinels distinguish the database NULL from the JSON null value of the WHOLE column. Use 'path' with 'equals: null' to test for a JSON null at that path. |
| `shared/operation-context.ts:2056` | `QueryEngineError` | No data to insert for createMany. |
| `shared/query.ts:2907` | `QueryEngineError` | Paginated scalar ordering requires a primary model identifier. |
| `shared/query.ts:4568`<br>`shared/query.ts:4575` | `QueryEngineError` | Polymorphic relation '${shape.relation}' references a missing '${type}' record. |
| `shared/schema.ts:204` | `QueryEngineError` | Primary key field '${keyField}' accepts exactly one update operation; received ${named.join(", ") \|\| "none"}. |
| `shared/query.ts:678` | `InvalidScalarResult` | provider scalar decoding failed |
| `shared/query.ts:4395` | `QueryEngineError` | Scalar '${key}' used in 'having' must be included in 'by'. |
| `shared/query.ts:2310` | `QueryEngineError` | The 'having' _sum operand for decimal field '${scalar.field}' needs ${digits} coefficient digits, but its value is outside this provider's exact HAVING operand cast domain. The provider may compute a wider sum, but VibORM cannot express this operand through its exact decimal cast without changing or refusing the value written. |
| `shared/query.ts:3836` | `QueryEngineError` | The 'select' statement for model '${model["~"].names.ts ?? "unknown"}' needs at least one truthy value. |
| `route/client-route.ts:291` | `CacheConfigurationError` | The cached result snapshot is malformed. |
| `shared/query.ts:4795` | `InvalidScalarResult` | the Date is invalid or not UTC midnight |
| `shared/query.ts:4760` | `InvalidScalarResult` | the Date is outside the public DateTime domain |
| `shared/query.ts:4703` | `InvalidScalarResult` | the integer is outside the safe range |
| `shared/query.ts:5052` | `InvalidScalarResult` | the normalized precision exceeds milliseconds |
| `route/client-route.ts:278` | `CacheConfigurationError` | The operation result cannot be represented by the cache result codec. |
| `shared/query.ts:4863` | `InvalidScalarResult` | the scalar type is unsupported |
| `shared/query.ts:4740` | `InvalidScalarResult` | the sum is not an exact decimal at this column's scale |
| `shared/query.ts:5047` | `InvalidScalarResult` | the timezone suffix is invalid |
| `shared/query.ts:4846` | `InvalidScalarResult` | the value does not have the configured dimension ${leaf.dimension} |
| `shared/query.ts:4672` | `InvalidScalarResult` | the value is absent |
| `shared/query.ts:4725` | `InvalidScalarResult` | the value is not a canonical finite number |
| `shared/query.ts:4856` | `InvalidScalarResult` | the value is not a canonical GeoPoint |
| `shared/query.ts:4698`<br>`shared/query.ts:4715` | `InvalidScalarResult` | the value is not a canonical integer |
| `shared/query.ts:4821` | `InvalidScalarResult` | the value is not a declared enum member |
| `shared/query.ts:4681` | `InvalidScalarResult` | the value is not a string |
| `shared/query.ts:4810` | `InvalidScalarResult` | the value is not a valid ISO calendar date |
| `shared/query.ts:5039`<br>`shared/query.ts:5045` | `InvalidScalarResult` | the value is not a valid provider time |
| `shared/query.ts:4768` | `InvalidScalarResult` | the value is not a valid provider timestamp in the public DateTime domain |
| `shared/query.ts:4740` | `InvalidScalarResult` | the value is not an exact decimal in this column's declared domain |
| `shared/query.ts:4879` | `InvalidScalarResult` | the value is not an exact decimal list in this column's declared domain |
| `shared/query.ts:4752` | `InvalidScalarResult` | the value is not this column's declared physical timestamp |
| `shared/query.ts:4686` | `InvalidScalarResult` | the value is not true, false, zero, or one |
| `shared/query.ts:4959` | `InvalidScalarResult` | the value is outside the JSON value domain |
| `shared/query.ts:3933` | `QueryEngineError` | Unknown polymorphic target '${String(tag)}' for relation '${relation}'. |
| `shared/query.ts:1073` | `QueryEngineError` | Unknown update operation: ${Object.keys(operation).join(", ")} |
| `commands/execution.ts:1117` | `UnsupportedOperationError` | updateMany matched ${count} rows, so it cannot apply '${verb}' to relation '${name}': ${stored} — the last row updated would take it from the others. Narrow the filter (or add 'limit: 1') so exactly one row matches, or write this relation in a separate call. |
| `shared/query.ts:2424` | `QueryEngineError` | Vector distance ${usage} dimension mismatch for '${field}': expected ${dimension} values, received ${to.length}. |
| `shared/query.ts:2410` | `QueryEngineError` | Vector distance select does not support nullable vector field '${field}'. |
| `shared/query.ts:2414` | `FeatureNotSupportedError` | vector distance select requires a pgvector-enabled PostgreSQL driver |
| `shared/query.ts:2414` | `FeatureNotSupportedError` | vector ordering requires a pgvector-enabled PostgreSQL driver |
| `shared/query.ts:2217` | `FeatureNotSupportedError` | within polygon |

## Internal — the private fits

### `recursive-read` (D-54) — the private recursive-read fit

`Queries.recursive`, `decodeRecursive` and the route's recursive cache codec are built and tested, and no public verb, argument or schema option builds a recursive traversal or asks for a `recursive` published shape.

Privacy re-checked this run: `.recursive(`, `kind: "recursive"` named anywhere in `src/**` outside `src/query-engine/raptor3/shared/query.ts` — no hits; the fit holds.

| sites | class | anchor | sentence |
| --- | --- | --- | --- |
| `shared/query.ts:4555` | `TypeError` | under `=== "recursive"` | A recursive shape requires occurrence rows |
| `shared/query.ts:3435` | `Error` | inside `recursive` | A recursive traversal requires at least one seed |
| `shared/query.ts:4540` | `TypeError` | inside `decodeRecursive` | Invalid provider recursive collection |
| `shared/query.ts:4504` | `TypeError` | inside `decodeRecursive` | Invalid provider recursive occurrence |
| `shared/query.ts:4536` | `TypeError` | inside `decodeRecursive` | Invalid provider recursive parent occurrence |
| `shared/query.ts:4508` | `TypeError` | inside `decodeRecursive` | Invalid provider recursive path |
| `shared/query.ts:4523` | `TypeError` | inside `decodeRecursive` | Invalid provider recursive row |
| `shared/query.ts:4512` | `TypeError` | inside `decodeRecursive` | Invalid provider recursive seed |
| `shared/query.ts:3447` | `Error` | inside `recursive` | Raptor 3 recursive traversal relation '${traversal.relation}' is not self-referential |
| `shared/query.ts:3442` | `Error` | inside `recursive` | Raptor 3 recursive traversal requires one ordinary relation: ${traversal.relation} |
| `route/client-route.ts:332` | `UnsupportedOperationError` | under `case "recursive"` | The Raptor 3 route cannot encode a cached result for '${requestedOperation}': a recursive read's published depth is not a fixed shape. |

## Invariants

States the code cannot be in when it is right, thrown through the engine's one invariant owner. Not refusals, and counted as none.

| sites | through | sentence |
| --- | --- | --- |
| `shared/storage.ts:248` | `assertInvariant` | '${field}' is neither a declared scalar of '${model["~"].names.sql}' nor one of its variant carrier columns. |
| `shared/invariant.ts:28` | `throw` | ${message}: ${String(value)} |
| `commands/commands.ts:1027` | `assertInvariant` | a dependency's read and write share the operation's tree |
| `commands/commands.ts:1038` | `assertInvariant` | a dependency's write precedes its read |
| `shared/query.ts:4167` | `assertInvariant` | a junction-carried slot's integrity probe names junction memberships |
| `commands/commands.ts:1441` | `assertInvariant` | a selected series is enclosed by a record analysis |
| `commands/commands.ts:1448` | `assertInvariant` | a selected series occurrence is expanded once |
| `commands/commands.ts:620` | `assertInvariant` | a series capture target is read only from a capture occurrence |
| `commands/commands.ts:442` | `assertInvariant` | a series capture's target is a sibling of the capture in the same body |
| `commands/execution.ts:1278` | `assertInvariant` | a series member names its captured row |
| `commands/commands.ts:1289` | `assertInvariant` | an occurrence's parent lists that occurrence |
| `commands/index.ts:53` | `unreachable` | client operation |
| `commands/commands.ts:625` | `assertInvariant` | materialization resolved this capture's target |
| `shared/query.ts:3386` | `unreachable` | Raptor 3 aggregate is not implemented |
| `shared/query.ts:2264` | `throw` | Raptor 3 filter operator is not implemented: ${operator} |
| `shared/query.ts:2486` | `throw` | Raptor 3 G3P-05 relation filter is not implemented: ${predicate.quantifier} |
| `shared/query.ts:2389` | `throw` | Raptor 3 JSON filter operator is not implemented: ${predicate.operator} |
| `commands/relation-body.ts:788` | `unreachable` | relation verb |
| `route/client-route.ts:374` | `throw` | The Raptor 3 route cannot encode a cached '${leaf.type}' result for '${requestedOperation}': the leaf publishes no declaring scalar. |
| `commands/execution.ts:1270` | `assertInvariant` | this series was captured in this attempt |
| `shared/storage.ts:72` | `assertInvariant` | Variant carrier '${name}' was addressed with ${variant === undefined ? "no arm" : `the undeclared arm '${variant}'`}: every caller addresses one declared arm or composes the arms itself. |

## Sites without a sentence

Refusal sites whose sentence this census cannot read: a rethrow of a value another owner built (a catch binding, a parameter), a property access (`this.incompletePreparation`, a control-flow sentinel no caller sees), a property of another object (`refusal.error`), a value assigned after its declaration, or a message computed at the site (one built from mapped issues). A sentence built by a local factory, a function of the file, a method of the throw's own class, a local `const` bound to one of those, or a named constant IS read at the throw site — including when the site hands it to the failure owner (`failure(…)`), whose own substituted sentences are read once at the owner itself. Listed so no refusal site is silently dropped from the total; an invariant site whose message is not a literal (the owner's own throw) is counted among the invariant sites and has no row.

| site | thrown |
| --- | --- |
| `commands/assignments.ts:203` | `failure` |
| `commands/assignments.ts:207` | `this.refusal` |
| `commands/commands.ts:1828` | `transition` |
| `commands/execution.ts:399` | `error` |
| `commands/execution.ts:446` | `selection.required` |
| `commands/execution.ts:477` | `occurrence.refusal` |
| `commands/execution.ts:628` | `ctx.failure` |
| `commands/execution.ts:655` | `supplied ? ctx.failure` |
| `commands/execution.ts:663` | `found.refusal` |
| `commands/execution.ts:698` | `requirement.failure` |
| `commands/execution.ts:1189` | `ctx.failure` |
| `commands/execution.ts:1284` | `ctx.failure` |
| `commands/index.ts:281` | `error` |
| `commands/relation-body.ts:448` | `keyRefusal` |
| `commands/relation-body.ts:700` | `keyRefusal` |
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
| `shared/operation-context.ts:2090` | `this.incompletePreparation` |
| `shared/operation-context.ts:2124` | `error` |
| `shared/operation-context.ts:2466` | `this.incompletePreparation` |
| `shared/operation-context.ts:2706` | `this.failure` |
| `shared/operation-context.ts:2792` | `error` |
| `shared/operation-context.ts:2890` | `this.failure` |
| `shared/parse-boundary.ts:45` | `ValidationError` |
| `shared/query.ts:677` | `error` |
| `shared/query.ts:4467` | `query.expectedRows.missing` |
