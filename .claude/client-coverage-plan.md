# Client coverage closure plan (`pnpm test:coverage:client`)

Author: Opus Max executor (analysis lane). **No runtime command was run** — see §8.
Evidence base: the pre-existing Istanbul/v8 artifact `coverage/client/coverage-final.json`
(mtime 2026-08-31 13:12), whose totals are exactly the ones the orchestrator quoted:

```
lines/statements 3106/3277 = 94.78%   branches 1013/1125 = 90.04%   functions 186/196 = 94.89%
```

Every line number below is from that artifact cross-read against the working-tree source at
`b1509a59`. Uncovered ranges were extracted from `statementMap`/`branchMap`/`fnMap` directly, so
this plan cites *the exact uncovered block*, not a guess.

---

## 1. Headline: 98% is NOT reachable in any metric while `src/` stays frozen

This is the finding the orchestrator has to act on before Phase 3 starts. The client denominator
contains a large block of **provably dead code** — defensive throws that duplicate a guarantee an
upstream owner already makes (the exact shape AGENTS.md §"One guard per invariant — redundant
defense is BANNED" forbids), plus a handful of never-invoked stubs.

| metric | total | covered | needed for 98% | max reachable | verdict |
|---|---|---|---|---|---|
| statements / lines | 3277 | 3106 | **3212** (≤65 uncovered) | ~3191 (≥86 unreachable) | **fails by ~0.6 pt** |
| branches | 1125 | 1013 | **1103** (≤22 uncovered) | ~1089 (≥36 unreachable) | **fails by ~1.2 pt** |
| functions | 196 | 186 | **193** (≤3 uncovered) | **189** (7 unreachable) | **fails by ~1.5 pt** |

The function row is the hard proof and needs no estimation: **7 of the 10 uncovered functions
cannot be invoked by any input**, so the ceiling is 189/196 = **96.43%**. Even a perfect test pass
leaves the lane below its gate. §4 lists all seven with the line that makes each unreachable.

Three ways out, in the order I would rank them:

1. **Narrow production unfreeze for AGENTS.md-mandated redundant-guard removal only** (§2). Deleting
   the seven dead functions and the ~60 dead defensive statements they belong to takes the
   denominator to ≈3190/196→189 and every metric clears 98% comfortably. This is not a feature
   deletion: each removed guard duplicates a check that already fails loudly one call frame up, and
   two of them (`missingOperationResult`, `requiredRelationShape`/`requiredPolymorphicShape`) are
   textbook instances of the two case studies AGENTS.md already cites (`assertScalarOnlyFilter`,
   the `Object.keys(ref)` assert).
2. **Lower the client gate to a number the honest estate can hold** (e.g. 96%) and record why in
   `scripts/coverage-policy.mjs` + `tests/README.md`. Note a coverage *waiver* does not help: 
   `coverageOptionsForSubsystem` (`scripts/coverage-policy.mjs:330-352`) applies the threshold
   regardless of `coverageWaivers`, and `tests/README.md` states waived source stays in the
   denominator.
3. **Ship the test plan in §3 anyway** (it is worth writing on contract grounds alone) and accept
   a red gate. Not recommended as a terminal state.

§3 is written so it is correct under all three: every case is a real public contract, none exists
only to touch a line.

---

## 2. Production defects found (NOT fixed — production is frozen)

### D1 — `missingOperationResult` is a triply-redundant guard for an invariant `assertNormalizedBatchResults` already owns

`src/client/array-transaction-native-batch.ts:77-92` (whole function, 15 statements, 1 function —
the entire 79.16%/80% deficit of that file).

Three call sites, each preceded in its own function by a cardinality+shape assertion:

| call site | guard text | the assertion that makes it dead |
|---|---|---|
| `src/client/array-transaction-native.ts:79-85` | `const result = batchResults[start]; if (!result) throw missingOperationResult(...)` | `assertNativeBatchResults(driver, batchResults, operationQueries.length)` at `array-transaction-native.ts:141`, before the member-parse loop at 147-154 |
| `src/client/array-transaction-legacy.ts:85-87` | same | `assertNormalizedBatchResults(batchResults, operationQueries.length, …)` at `array-transaction-legacy.ts:120`, before the parse loop at 124-126 |
| `src/client/array-transaction-legacy.ts:213-214` | same | `assertNativeBatchResults(driver, batchResults, operationQueries.length)` at `array-transaction-legacy.ts:258`, before the parser loop at 259-264 |

`assertNormalizedBatchResults` (`src/drivers/normalized-result.ts:151-173`) throws unless
`results.length === expectedStatementCount` **and** every element passes
`assertNormalizedQueryResult` (`:123-145`), which rejects `undefined` and every non-`[object Object]`
value. `start` is always `operationQueries.length` captured *before* its own push, so
`start < length` always. `batchResults[start]` is therefore always a truthy normalized object.
Evidence it is dead: 0 hits on all 15 statements in a report where every other line of the three
callers is exercised.

**Do not test this.** Any witness would require forging a driver result past an assertion that
already refused it.

### D2 — `typescript-type-renderer.ts` re-guards five invariants its callees already close

All five are unreachable, all five duplicate a *type-level and runtime* guarantee:

| renderer lines | guard | owner that already guarantees it |
|---|---|---|
| `178-186` `requiredRelationShape` throw | `expected` absent for a relation column | `classifyResultColumn` returns `{kind:"relation"}` only after `if (!expected) return { kind:"unknown", key }` — `src/query-engine/result/result-column.ts:89-96`; the field is declared non-optional at `:34` |
| `188-196` `requiredPolymorphicShape` throw | same, polymorphic | `src/query-engine/result/result-column.ts:79-88`, field non-optional at `:40` |
| `227-231` `aggregateType` "shape absent" throw | `expected.fields` undefined for a non-`_count` aggregate | `ExpectedAggregateResultShape.fields` is undefined *only* for `_count: true` (`src/query-engine/types.ts:146-149`), and `buildAggregateShape` `continue`s without pushing a rawKey when a spec has no entries (`src/query-engine/result/result-shape.ts:389-393`). The `_count` case is already returned at renderer `224-226` |
| `305-310` relation-count "shape absent" throw | `column.relations` falsy | `ExpectedResultShape.relationCounts: ReadonlySet<string>` is non-optional (`src/query-engine/types.ts:201`) and `classifyResultColumn:70-72` passes it straight through |
| `369-374` "no renderable result shape" throw | `buildExpectedResultShape` returned undefined | it returns undefined only for `createMany`/`updateMany`/`deleteMany` (`src/query-engine/result/result-shape.ts:429-445`), and those three are returned at renderer `360-367` before the call |

Plus three exhaustive-`switch` `default:` arms over closed unions built only inside this module or
by a single classifier: `105-108` (`TypeNode`, constructed only by `atom`/`arrayOf`/`objectOf`/
`unionOf`), `169-172` (`ScalarType` is a closed 14-member union at
`src/schema/scalars/common.ts:43-57`; the switch covers all 14), `212-215` (`AggregateLeaf`,
`src/query-engine/result/result-aggregate-leaf.ts:4-17`), `332-335` (`ResultColumn`,
`src/query-engine/result/result-column.ts:18-47`).

Plus three throws closed by `renderSchemaType`'s own two-line preamble
(`src/client/schema-introspection.ts:214-215`: `hydrateSchemaNames(schema)` then
`resolveSchemaOrThrow(schema)`): `402-404` (non-model target — refused by resolution),
`408-412` (no hydrated TS name — `hydrateSchemaNames` runs `assertValidIdentifier("Model", modelKey)`
at `src/schema/hydration.ts:70`, and `VALID_SCHEMA_IDENTIFIER = /^[a-zA-Z_][a-zA-Z0-9_]*$/`
at `src/schema/identifier.ts:3` rejects the empty string), `423-427` (no resolved slot — the index
*is* the resolution of this schema).

Net: **~50 of the file's 53 uncovered statements are unreachable**, which is the whole 87.75% figure.

### D3 — `src/client/client.ts:448-450` `get clientId()` is dead public-shaped code

No consumer anywhere in `src/` (every call site reads `engine.clientId` directly:
`src/query-engine/query-engine.ts:39`, `src/query-engine/pending-operation.ts:228`,
`src/client/raw.ts:299`). `VibORM` the class is not exported from the package
(`src/index.ts:36-41` exports only the `VibORMClient`/`VibORMConfig` types and `createClient`), and
the root proxy forwards unknown keys to the *model* proxy, not to the `VibORM` instance
(`src/client/client.ts:1076-1181`), so `orm.clientId` never reaches the getter.

### D4 — `src/client/client.ts:971-976` re-checks what the proxy it just built cannot fail

`createTxProxy`'s `get` trap returns the `$transaction` closure unconditionally for
`prop === "$transaction"` (`src/client/client.ts:863-946`), so `transactionMethod` read at `:966-969`
is always a function and the `ClientInitializationError("Transaction view did not expose
$transaction.")` at `:972-976` is unreachable.

### D5 — `src/client/raw.ts:396` `prepareBatch: async () => undefined` is never called

The only three callers (`array-transaction-native.ts:66`, `array-transaction-legacy.ts:75` and
`:204`) reach `prepareBatch` only when `owner.prepare(...)` returned a falsy value, and raw's
`prepare` (`src/client/raw.ts:380-395`) returns a `BatchQuery` on both arms or throws.

### D6 — `src/client/default-omit-extension.ts:135` `const request: GenericRequestHandler = () => ({})` is never invoked

It is an identity marker only: the chain strips it before resolving
(`stripOfficialDefaultOmitRequest`, `src/extensions/chain.ts:219-225`, applied at `:319-324`).

### D7 — `src/client/array-transaction-legacy.ts:330-331` placeholders are structurally dead

`let rejectChild … = () => undefined;` / `let resolveChild … = () => undefined;` are both
overwritten by the `new Promise` executor two lines later (`:332-335`), which runs synchronously per
spec. They exist only to satisfy definite-assignment analysis. Two uncovered functions.

### D8 — `src/client/client.ts:128` `new Proxy(() => {}, …)` target is uninvokable

The handler traps `get` (`:129`) and `apply` (`:149`); no un-trapped operation calls the target, and
an arrow function cannot be `construct`ed. One uncovered function.

### D9 — dead `default:` arms behind an earlier membership filter (small, same family)

* `src/client/unique-where-guard.ts:47-48` — `toUniqueValidationOperation`'s `default: throw new
  Error(...)`. `assertNonEmptyUniqueWhere:18` returns early unless the operation is in
  `UNIQUE_SELECTOR_OPERATIONS` (`:6-12`), and the switch at `:39-46` covers all five members.
  (Also note: this is the one place in `src/client` that throws a bare `Error`.)
* `src/client/schema-introspection.ts:96-97` — `resultOperation`'s `default: return operation;`.
  Its `case` list (`:74-95`) is exactly the 16-member list `publicOperationOrThrow` admits
  (`:22-39`), and every case returns.
* `src/client/schema-introspection.ts:192-199` — `if (!model) throw …`. `registry.validate(
  validatedModelName, …)` at `:186-190` already refuses an unknown model name; the existing witness
  is `tests/contracts/public-client/schema-introspection.core.test.ts:154-162`.
* `src/client/raw.ts:343-344` — `observe`'s `if (observers === undefined || observers.length === 0)
  return child();`. Both callers gate on `owner.hasObservation(...)` first
  (`array-transaction.ts:277-278`, `array-transaction-legacy.ts:328-329`), and `hasObservation`
  (`raw.ts:340-341`) is the same predicate.

---

## 3. Per-file plan: the cases worth writing

Conventions used below:
* **Owner** = existing admitted file the case goes into. No new file is proposed anywhere: every
  gap has a natural existing owner (§5 explains what a new file would cost).
* **Pins** = the production line the expectation reads from.
* **Alone catches** = the unique failure required by AGENTS.md before an assertion may be added.
* Fixtures follow the sibling already in that file — `s.model` schemas + `PlanningDriver`
  (`@tests/fixtures/drivers/planning`) or a local `Driver` subclass; `prepareSchema`/`indexFor`
  from `@tests/fixtures/query-scope` for the `omit.ts` unit lane.

### 3.1 `src/client/typescript-type-renderer.ts` — 87.75% / 85.98%

**Public contract owned.** Two exported functions, reachable only through
`renderOperationResultType` and `renderSchemaType` (`src/client/schema-introspection.ts:16`, and
those two are the only importers repo-wide): render a *validated* payload's result type, and render
the whole model graph as one recursive `VibORMSchema` declaration. Meaningful user-visible failure
boundaries: a scalar domain rendered as the wrong TS type, a relation's array/null-ness wrong, a
polymorphic arm's readonly tagging wrong, and the honest `unknown` for custom JSON.

Only **one** uncovered statement here is reachable; everything else is D2.

| id | case | owner | pins | alone catches |
|---|---|---|---|---|
| R1 | `renderOperationResultType({ empty: s.model({}) }, "empty", "findMany", {})` renders `Array<{}>` | `tests/contracts/public-client/typescript-renderer-boundaries.core.test.ts` (beside its existing empty-model sibling at `:21-25`) | renderer `269-271` `case "empty": break;`; the key is pushed by `src/query-engine/result/result-shape.ts:217-224` when a row has no projectable column | a renderer that treated the private empty-row carrier as a real column would emit `Array<{ <internal key>: … }>` — i.e. leak the private sentinel into a user-facing type. No other test renders a row with no columns |

Two further candidates I could not settle statically (see §7, Q1/Q2):

| id | case | owner | pins |
|---|---|---|---|
| R2 | `renderSchemaType({ m: s.model({ status: s.enum([]) }) })` renders `status: never;` | same file | renderer `69-70` `if (!onlyMember) return atom("never")` — an empty enum passes `values.every(...)` at `116-118` and reaches `unionOf()` with no members |
| R3 | a hostile-JS enum whose values are not strings is refused by name: `Reflect.apply(s.enum, undefined, [[1, 2]])` inside a model, then `renderSchemaType` throws `"An enum scalar has no readable string values."` | same file | renderer `114-121`; precedent for the `Reflect.apply` hostile spelling is `tests/contracts/public-client/schema-introspection.core.test.ts:141-206` |

Everything else in this file is §4.

### 3.2 `src/client/schema-introspection.ts` — 94.80% / 92.85%

**Public contract owned.** The four exported schema-only utilities (`src/index.ts:43-48`,
`src/client/exports.ts:35-40`): canonical payload schema with `OrThrow` alias routing, payload
validation, one payload's result type, and the whole-schema type. `src/client/AGENTS.md` states the
boundary: no extensions, no `defaultOmit()`, no cache, no driver capability check.

| id | case | owner | pins | alone catches |
|---|---|---|---|---|
| S1 | `renderOperationResultType(schema, "user", "updateMany", { data: { … } })` (no `select`) renders `{ count: number; }` | `tests/contracts/public-client/schema-introspection.core.test.ts`, in the `"renders count, aggregate, group-by, existence, and bulk result carriers"` test (`:278-328`), beside the `deleteMany` pair at `:318-327` | `resultOperation:80-81` `case "updateMany": return args.select === undefined ? operation : "updateManyAndReturn";` | the `createMany` and `deleteMany` arms are both already pinned (`client-coverage.core.test.ts:148-161`, `schema-introspection.core.test.ts:318-327`); only `updateMany`'s *count* arm is unwitnessed, so a copy-paste slip that made `updateMany` always route to `updateManyAndReturn` would return `Array<…>` where the caller gets `{ count }` and nothing would go red |
| S2 | `renderOperationResultType(schema, "user", "findMany")` — payload omitted entirely — renders the same string as `…, {})` | same file, same test | `:189` `payload ?? {}` | `validateOperationPayload`'s own `payload ?? {}` (`:154`) is already covered by `schema-introspection.core.test.ts:104-106`; the *render* entry point has no such witness, so a regression that dropped the `?? {}` there would make `renderOperationResultType(schema, "user", "findMany")` throw on a call the public signature (`payload: unknown`) admits |

`:96-97` and `:192-199` are §4 (D9).

### 3.3 `src/client/unique-where-guard.ts` — 97.67% / 84.21%

**Public contract owned.** Before validation, refuse an all-`undefined` unique selector with a typed
`ValidationError` named after the *public* operation. Called from
`src/client/client.ts:549` and `:574`.

| id | case | owner | pins | alone catches |
|---|---|---|---|---|
| U1 | `client.record.findUnique()` — no argument at all — rejects with a `ValidationError`, not a `TypeError` | `tests/contracts/public-client/client-construction-boundaries.core.test.ts`, `describe("unique selector validation")` at `:178` | `:19` `if (!isRecord(args)) return;` | without the early return, `args.where` on `undefined` throws a raw `TypeError` out of the client before validation can name the failure. The existing `:199-217` case always passes an object, so this is the only witness that the guard tolerates a missing payload |
| U2 | `client.record.findUnique({})` — payload present, `where` absent — rejects with the *operation schema's* issue for a missing `where`, not the guard's `"whereUnique requires at least one unique discriminator."` message | same describe | `:21` `if (!isRecord(where)) return;` | pins the division of labour: an absent `where` is validation's error, an empty `where` is the guard's. A guard that also claimed the absent case would give the wrong message and the wrong `path`. Assert on the message text so U2 and the existing `:180-196` cases cannot both pass on the same code |

`:47-48` is §4 (D9).

### 3.4 `src/client/omit.ts` — 95.72% / 86.95%

**Public contract owned.** `defaultOmit()` config → per-query args rewrite, with the precedence
block documented at `src/client/omit.ts:17-26` and restated in `src/client/AGENTS.md`
("An explicit `select` overrides the `defaultOmit()` client default, but a query-level `omit`
written beside that select still subtracts from it. The same rule applies on nested relation nodes").

Every gap here is a *documented rule with no runtime witness in the admitted set*. The extended file
`tests/contracts/public-client/default-omit-extension.test.ts:222` ("preserves select and local omit
precedence") covers some of it but is **not admitted** by the manifest, so it contributes nothing.

| id | case | owner | pins | alone catches |
|---|---|---|---|---|
| O1 | an explicit `select` suppresses the model's own default but still visits relation children: `applyClientOmit(user, "findMany", { select: { id: true, posts: true } }, resolver)` → `{ select: { id: true, posts: { omit: { secret: true } } } }`, and the top-level node gains **no** `omit` key | new `describe` in `tests/contracts/public-client/default-omit-bulk-projection.core.test.ts` (it already owns the `applyClientOmit` unit lane with `prepareSchema`/`indexFor`) — or, if the orchestrator prefers one file per rule, rename that file's scope; do **not** create a new file | `:235-237` (`hasSelect ? rewriteRelationMap(...) : selectValue`), `:242` (`hasSelect ? undefined : resolve.omit(model)`), `:254` (`next.select = nextSelect`), `:291-293` (`if (!resolved) continue` for the scalar key `id`) | `hasSelect === true` is *never* exercised in the admitted estate. A rewrite that injected the client default beside an explicit `select` would produce `{ select: {...}, omit: {...} }`, which validation then subtracts — silently dropping a column the caller explicitly selected. That is the exact DX failure the precedence block was written for |
| O2 | a relation node written as an object is recursed into: `{ include: { posts: { select: { title: true } } } }` → the nested node gains `omit` for `post`'s defaults | same | `:319-326` (`if (!isPlainRecord(value)) continue;` then `rewriteNode(target, value, resolve)`) — 5 of the file's 10 uncovered statements | every admitted case passes `true` as the relation value, so the object arm of `rewriteRelationMap` is untested end-to-end. A regression that skipped non-`true` nodes would leave nested rows unredacted while the shorthand kept working |
| O3 | a relation whose target has no configured default is left byte-identical: with a resolver configured only for `post`, `{ include: { posts: true, tags: true } }` keeps `tags: true` by identity | same | `:313-315` `if (!defaults) continue;` | pins the cache-key promise in the doc comment at `:277-281` ("keeps the payload — and its cache key — identical for the models nobody configured"). Without it, promoting every shorthand to `{ omit: {} }` would change every cache key on an unconfigured client |
| O4 | the walk resolves the target from the **owning** side too: with the schema key order `{ author, post, … }`, `applyClientOmit(author, "findMany", { include: { posts: true } }, resolver)` → `{ include: { posts: { omit: { secret: true } } } }` | `tests/contracts/public-client/polymorphic-client-omit.core.test.ts`, `describe("client omit reaches the SETTLED target")` at `:311` | `:356-360` — the `? second.source` arm of `slotTarget`. `endpoints` is `[first.node.slot, second.node.slot]` in *registration* order (`src/schema/validation/relation-resolution.ts:653-656`), so today's cases only ever hit `: first.source` | swap the two arms and every existing case still passes, while `author.posts` resolves to `author` — applying the *source* model's omit to the target's rows. This is the single highest-value case in the file |
| O5 | a **bound inverse of a polymorphic collection** resolves to the carrier: `book.shelf: s.toOne(() => shelf)` paired with `shelf.items: s.toMany({ book, video })`; `applyClientOmit(book, "findMany", { include: { shelf: true } }, resolver-for-shelf)` → `{ include: { shelf: { omit: { label: true } } } }`. Spelling precedent: `tests/fixtures/relation-topology-corpus.ts:740-755` | same describe | `:336` `if (resolved.member) return undefined;` and `:361-362` `return edge.carrier.source;` | a member slot whose edge kind is `variantJunctionCarrier` must NOT be treated as a direct carrier; if `directVariantCarrier` forgot the `member` check, the inverse would be rewritten as a tagged-arm envelope and the query would throw on a payload the caller never wrote |
| O6 | an explicit arm for an **unconfigured** variant target is returned by identity: `{ include: { subject: { post: { select: { title: true } } } } }` with only `video` configured leaves the `post` arm object untouched | `tests/contracts/public-client/polymorphic-client-omit.core.test.ts`, `describe("client omit through polymorphic projections")` at `:56` | `:397-399` — the `undefined` arm of `rewritten === variant ? undefined : rewritten` | the same cache-key promise as O3 but on the polymorphic arm path; the existing `:96-107` case only covers relation-level `false` and a wholly unconfigured resolver |
| O7 | a variant excluded with `false` gets no synthesized arm: `{ include: { subject: { post: false, video: true } } }` leaves `post: false` and only rewrites `video` | same describe | `:401` `if (variant !== true && variant !== undefined) return undefined;` | without it, an explicitly excluded variant is replaced by `{ omit: {…} }`, i.e. a client option *re-includes* an arm the caller switched off. Distinct from the existing relation-level `false` case at `:96-107`, which never reaches `defaultedArm` |
| O8 | a config entry explicitly set to `undefined` is a no-op, not a refusal: `defaultOmit<typeof schema>()({ user: undefined })` builds a client that hides nothing | `tests/contracts/public-client/client-configuration-boundaries.core.test.ts`, `describe("default omit public configuration boundary")` at `:59` (it already owns the refusal cases and the empty-config no-op at `:190-201`) | `:157` `if (!isPlainRecord(entry)) continue;` — sits *after* the unknown-model refusal at `:150-156`, so the ordering is the contract | `ClientOmitConfig` makes every model key optional, so `{ user: undefined }` type-checks; if the `continue` were a refusal, spreading a partially-built config (`{ ...base, user: undefined }`) would throw at construction |

`:311` (`if (!target) continue;`) is §4: `slotTarget` (`:351-363`) returns a model on every path.

### 3.5 `src/client/client.ts` — 97.01% / 92.97%

**Public contract owned.** Client construction and its typed failures, the three-proxy dispatch
surface, the root/derived/transaction views and which `$` utilities each exposes, and callback
transaction commit-certainty.

| id | case | owner | pins | alone catches |
|---|---|---|---|---|
| C1 | the **derived** client's delegate surface: on `base.$extends({ name, client: () => ({ $ping }) })`, assert `$ping()` works, `$schema` is the schema object, `$transaction` is a function, `` $queryRaw`…` `` executes, an unknown `$flag` is `undefined`, and a non-`$` unknown key falls through to the model proxy | `tests/contracts/public-client/extensions-foundation.core.test.ts` (owns `$extends` client/model factories) | `bindConcreteMethods`' trap, `src/client/client.ts:729-748` — statements `732-733`, `737-739`, `744-746`; the whole trap has only ever been asked for a schema model name (the uncovered v8 block `742:10-743:64` proves control never left the `Object.hasOwn(this.schema, prop)` arm at `:740-741`) | six distinct return paths of one trap, none witnessed. A derived client that shadowed `$schema` with a delegate lookup, or that answered a raw method from the *root* scope instead of `rawSurface(engine)`, would be invisible today |
| C2 | inside `orm.$transaction(async tx => …)`: `tx.$schema` is the schema, and `tx.$nope` is `undefined` (not a model proxy) | `tests/contracts/public-client/nested-transaction-contract.core.test.ts` | `src/client/client.ts:948-956` | the transaction view must refuse unknown `$`-prefixed keys rather than minting a model proxy for them — otherwise `tx.$queryRawUnsafeTypo(...)` returns a thenable-free proxy and the call silently does nothing |
| C3 | a PostgreSQL driver whose adapter has no `namespace` is refused at construction with the documented message | `tests/contracts/public-client/client-initialization-errors.core.test.ts`, `describe("client construction errors")` | `src/client/client.ts:1196-1205` | this is the guard that stops a client from writing into whatever `search_path` points at while migrations altered another schema; nothing else pins it. `PlanningDriver("postgresql")` presumably supplies a namespace — the case needs a driver whose `adapter.namespace === undefined` (see §7, Q4) |
| C4 | a construction fault that throws a **non-`Error`** (a hostile model getter throwing a string) surfaces as `ClientInitializationError` with the default message `"Failed to create the VibORM client"` and **no** `cause` | same file | `assertConstructed`, `src/client/client.ts:1238-1248` — branches at `1243`, `1245`, `1246` | the `Error` path is covered by the malformed-schema case at `:54-70`; the non-`Error` path is the one that decides whether a thrown string escapes untyped. Spelling precedent for a getter that throws a string: `default-omit-extension.core.test.ts:94-99` |
| C5 | a callback transaction that fails **after** the driver signalled `readyToCommit`, with a plain `Error`, still rejects with that same error object (unwrapped) while the write-outcome rail publishes `may-have-committed` | `tests/contracts/public-client/protected-driver-lifecycle-observers.core.test.ts` (owns the transaction-phase recording drivers) | `src/client/client.ts:1021-1024` — the `: error` arm of `isVibORMError(error) ? attachCommitCertainty(error, certainty) : error` | a non-VibORM failure must not be swallowed or rewrapped by the certainty path; only the VibORM arm is witnessed today |
| C6 | a request transform that returns nothing leaves the operation with an empty payload rather than throwing | `tests/contracts/public-client/request-transforms.core.test.ts` | `src/client/client.ts:565` `let requestArgs = transformed ?? {};` | see §7 Q5 — needs confirmation that `applyRequestTransforms` can return `undefined` |

`:449-450` (D3), `:697` (`?? 0` — `attachPendingCacheExecution` only runs when the official cache is
present, which implies a chain, so `extensionChain?.statement` is always an array) and `:972-976`
(D4) are §4.

### 3.6 `src/client/raw.ts` — 96.69% / 90.79%

**Public contract owned.** The four raw methods as lazy `RawOperation`s, their array-transaction
authority, and — the whole uncovered region — their **write-outcome notification rail**: when a raw
write publishes `committed` vs `may-have-committed`, and which failure stays primary when the
notification itself fails.

All of the following need one client shape: root (non-transaction) + observers + a query
interceptor, so `#withObservationNotifications` (`raw.ts:585-619`) actually receives notifications.
Its early return at `:588-593` (a transaction-bound engine, or no observers) is why the whole rail is dark today.

| id | case | owner | pins | alone catches |
|---|---|---|---|---|
| W1 | a successful intercepted `$executeRaw` publishes `committed` exactly once through the supplied notifications | `tests/contracts/public-client/query-interceptors.core.test.ts` (owns single-operation interception) | `raw.ts:585-619` — `:601` `await notify?.()`, `:615` `notifications?.committed` | the whole committed rail for raw writes is unexercised; a raw write that never published would leave cache invalidation and write-outcome listeners silent |
| W2 | the same call when the *notification* throws: the notification failure is what surfaces, and `#observationCommitCertainty` is still recorded | same | `raw.ts:602-605` and `:606-612` | pins "record the certainty first, then report the notification failure" — reversing the two loses the certainty on every failed listener |
| W3 | an intercepted `$executeRaw` whose provider execution fails publishes `may-have-committed` | same | `raw.ts:527-533` (`writeNotifications?.mayHaveCommitted()`), `raw.ts:616-617` (the `mayHaveCommitted` closure — one of the three coverable uncovered functions) | the failure rail is the half that decides whether a caller may retry; only the success half is reachable through today's tests |
| W4 | when both the parse and the `committed` notification fail, the **parse** error is primary and the outcome failure is retained | same | `raw.ts:540-553` — `:542-544`, `:547-552`, `:553` | four distinct precedence outcomes share these lines; without them a swapped `throw` order silently reports the listener's error instead of the caller's parse failure |
| W5 | raw inside a callback transaction reports `mode: "transaction"` to a query interceptor | `tests/contracts/public-client/query-interceptors.core.test.ts` | `raw.ts:490` `mode: this.#engine.transactionWriteOutcomes ? "transaction" : "direct"` | interceptors branch on `mode`; only `"direct"` is witnessed |
| W6 | a raw member with **no** handlers inside an array transaction that another member forces onto the intercepted path is passed straight through | `tests/contracts/public-client/query-interceptors-array.core.test.ts`, `describe("array query admission")` at `:297` | `raw.ts:311-313` `if (handlers === undefined \|\| handlers.length === 0) return child();` inside `startInterception` | `startInterception` runs for *every* slot once any member requires interception; the zero-handler slot must not be double-wrapped. Needs a model-mapped `query: { user: { findMany } }` so the raw op gets no handlers (§7, Q6) |

`:343-344` (D9), `:370-375` (the `{ commitCertainty }` arm of the `executeWith` completion facts —
`#observationCommitCertainty` is only written by `#withObservationNotifications`, which the
`executeWith` path never installs) and `:396` (D5) are §4.

### 3.7 `src/client/array-transaction.ts` — 92.63% / 90.16%

**Public contract owned.** `$transaction([...])`: hostile-input containment before any provider
effect, ownership checks, substrate selection (legacy vs intercepted; native batch vs fallback), and
commit-certainty publication.

| id | case | owner | pins | alone catches |
|---|---|---|---|---|
| A1 | `orm.$transaction([null])` and `orm.$transaction(["nope"])` reject with `InvalidTransactionInputError` before the driver is touched | `tests/contracts/public-client/array-transaction-legacy-batch-boundaries.core.test.ts`, `describe("unintercepted array transaction batch contracts")` at `:72` | `:170-173` `if (candidate === null \|\| typeof candidate !== "object") throw new InvalidTransactionInputError();` | the existing forged-member cases (`query-interceptors-array.core.test.ts:1471`, `:1780`) all pass *objects* and land on `:174-175`; a primitive member currently reaches `readTransactionOperation(candidate)` with a non-object and its behaviour is unpinned |
| A2 | `orm.$transaction([])` on a client **with** observers resolves to `[]` and starts no provider work | `tests/contracts/public-client/query-interceptors-array.core.test.ts`, `describe("public array lifecycle observers")` at `:1817` | `:108-109` — the observed branch's own empty-array short-circuit (the unobserved one at `:96` is covered) | the two branches have independent early returns; the observed one must still resolve inside the batch lifecycle rather than fall through to substrate selection |
| A3 | an **intercepted fallback** array transaction whose driver reports `readyToCommit` then fails: the array rejects with the coordinated failure carrying `commitCertainty: "may-have-committed"`, and write outcomes are published, not discarded | `tests/contracts/public-client/query-interceptors-array.core.test.ts`, `describe("fallback array query execution")` at `:604` | `:311-320` (the `readyToCommit`/`committed` phase callbacks — **two of the three coverable uncovered functions**) and `:371-390` (17 statements: the certainty ladder, `attachCommitCertainty`, `outcomes.publish`, `retainWriteOutcomeFailure`) | this is the largest single reachable block in the subsystem. The *native* equivalents are pinned (`:1335`, `:2288`); the fallback ladder is not, so a fallback array that lost its phase binding would silently report a definite rollback for a transaction that may have committed |
| A4 | same shape, but the outcome publication *also* fails: the coordinated failure stays primary and the outcome failure is retained | same describe | `:384-388` | pins the retention order that `retainWriteOutcomeFailure` exists for |
| A5 | an intercepted fallback where a **later** member's handler fails with its own distinct error after an earlier member already failed: both appear, the first stays primary, and a member that *fulfilled* is skipped | same describe | `:341-362` — `:348` (`continue` on a fulfilled later outcome), `:352-355` (a later coordination failure whose child differs), `:358-361` (a plain later failure that differs) | the suppressed-post-work fan-in has three distinct arms and one witness; a swap here loses a caller's error entirely |
| A6 | an intercepted array member whose core execution throws **synchronously** rejects that member and does not stall the rest | same describe | `startFallbackCore`, `:403-411` | the async-rejection path is covered; a synchronous throw out of `executeCore` currently has no witness and would otherwise leave `slot.child` forever pending |
| A7 | an intercepted+observed array whose reserve/prepare loop fails closes every member's observation with that failure | same file, `describe("public array lifecycle observers")` | `:292-296` `closeArrayOperationObservers` / `slot.observation?.reject(failure)` | without it a failed preparation leaves the per-member observation promises unsettled |

`:277-278` (`if (!slot.owner.hasObservation(...)) throw`) — see §7, Q3.

### 3.8 `src/client/array-transaction-native.ts` — 95.70% / 85.18%

**Public contract owned (per `src/client/AGENTS.md`).** This file is "the single owner of provider
dispatch attribution, normalized batch cardinality, and native-batch transaction errors" for the
*intercepted* native path.

| id | case | owner | pins | alone catches |
|---|---|---|---|---|
| N1 | an intercepted native array whose driver returns the **wrong number** of batch results fails as a *committed* failure — the batch already ran | `tests/contracts/public-client/query-interceptors-array.core.test.ts`, `describe("native array query execution")` at `:984` | `:140-144` — the `catch` that routes `assertNativeBatchResults` failure into `closeCommittedFailure` | `:1263` labels post-commit *handler* failures; the *cardinality* failure after a successful dispatch is a different arm, and treating it as pre-commit would tell the caller nothing ran |
| N2 | a member with **no** atomic batch representation on the intercepted native path raises `unbatchableArrayError` | same describe | `:91-92` `if (!preparedBatch) throw unbatchableArrayError(driver);` | the *legacy* equivalent is pinned (`array-transaction-legacy-batch-boundaries.core.test.ts:89`); the intercepted one is not, and the two throw from different frames with different close-down behaviour |
| N3 | a multi-statement member's **guards** are offset into the shared batch on the intercepted path | same describe | `:96-98` `for (const guard of preparedBatch.guards ?? [])` | the legacy offset is pinned (`array-transaction-observed-legacy-coverage.core.test.ts:131`); the intercepted offset is a separate loop over a separate array |
| N4 | on a pre-dispatch / dispatched / committed failure, a member whose query handler **fulfilled** anyway is skipped, and a member that failed with a *different* error is reported alongside the primary | same file, spread across `describe("array query admission")` and `describe("native array query execution")` | `:186-192`, `:210-216`, `:233-240` — the `if (outcome.status !== "rejected") continue;` and `if (queryFailure !== primary) …push` arms in all three close-down helpers | three near-identical helpers with three different certainties; a copy-paste error between them is exactly what these arms would catch |
| N5 | a commit-time slot notification that throws is collected rather than lost, and appears after the primary | same | `:257-266` `catch (error) { failures.push(error); }` in `publishNativeOutcome`, and `:241-243` in `closeCommittedFailure` | a throwing listener must not abort the remaining listeners nor replace the caller's error |

`:79-85` (D1) is §4.

### 3.9 `src/client/array-transaction-legacy.ts` — 97.29% / 87.62%

**Public contract owned.** The allocation-compatible array path when no query handler compiled —
including the observe-only variant (`src/client/AGENTS.md`: "Keep the unextended legacy shell
monomorphic").

| id | case | owner | pins | alone catches |
|---|---|---|---|---|
| L1 | an **observed** legacy native array whose preparation fails (a member with no batch representation) rejects every member's observation with that failure, and each observation completion reports **no** commit certainty | `tests/contracts/public-client/array-transaction-observed-legacy-coverage.core.test.ts`, `describe("legacy native array composition")` at `:130` | `:220-221` (`if (!preparedBatch) throw unbatchableArrayError(driver)`), `:234-237` (the preparation `catch` → `rejectObservedMembers`), `:341-342` (the `undefined` arm of the completion-facts closure, reached only before `setObservedCertainty` runs) | the observed path's *pre-dispatch* failure is unwitnessed; today only post-dispatch failures are, and those always carry a certainty |
| L2 | an observed legacy native array whose **multi-statement member carries guards** offsets them into the shared batch | same describe (beside `:131`, which pins the *unobserved* offset) | `:224-227` — the observed copy of the guard-offset loop | the observed shell keeps its own preparation loop by design; the two loops can drift |
| L3 | an observed legacy native array where the **second** member's parse fails after the first resolved: the first member's observation stays resolved (not re-settled) and the array rejects | same file | `:355-362` `rejectObservedMember`'s `if (member.settled) return;` | double-settlement would turn a successful member's observation into a rejection after the fact, corrupting the observer's completion record |

`:85-87`, `:212-214` (D1), `:176-183` + `:328-329` (§7 Q3), `:364-371`'s settled guard (unreachable:
nothing resolves an already-rejected member) are §4.

---

## 4. Honest exceptions: uncovered code that no input can reach

These must be reported, never covered by forged state. Grouped by the normalization that closes them.

### 4.1 Functions (7 of the 10 uncovered — this is the arithmetic in §1)

| function | closed by |
|---|---|
| `array-transaction-native-batch.ts:77` `missingOperationResult` | `assertNormalizedBatchResults` at `drivers/normalized-result.ts:156` + `:171`, called at `array-transaction-native.ts:141`, `array-transaction-legacy.ts:120`, `array-transaction-legacy.ts:258` — all before the member parse |
| `array-transaction-legacy.ts:330` `rejectChild` initializer | overwritten by the synchronous `new Promise` executor at `:332-335` |
| `array-transaction-legacy.ts:331` `resolveChild` initializer | same |
| `client.ts:128` `() => {}` (Proxy target) | the handler traps `get` (`:129`) and `apply` (`:149`); an arrow function cannot be constructed |
| `client.ts:448` `get clientId()` | no consumer in `src/`; `VibORM` is not exported (`src/index.ts:36-41`) and the root proxy forwards to the model proxy (`client.ts:1076-1181`) |
| `raw.ts:396` `prepareBatch` | `raw.ts:380-395` `prepare` returns a `BatchQuery` on both arms, and callers only fall through on a falsy `prepare` (`array-transaction-native.ts:62-63`, `array-transaction-legacy.ts:71-72`, `:200-204`) |
| `default-omit-extension.ts:135` `request` marker | stripped from the resolved definition at `extensions/chain.ts:319-324` via `stripOfficialDefaultOmitRequest` (`:219-225`) |

### 4.2 Statements — the redundant-guard block (≈76)

`array-transaction-native-batch.ts:78-92` (15) — D1.
`typescript-type-renderer.ts` (≈50): `106-108`, `169-172`, `183-186`, `193-196`, `209-211`
(`classifyAggregateLeaf` returns `unknown` only for a field that is not a model scalar, and the
payload was validated at `schema-introspection.ts:186-190`), `213-215`, `228-231`, `307-310`,
`329-331` (rawKeys are only ever pushed together with their map entry — `result-shape.ts:117-224`,
`:376-411`), `333-335`, `371-374`, `403-404`, `409-412`, `424-427`, `470`, `478-481` (a model's
`state.shape` is partitioned into `state.scalars` ∪ `state.relations` by construction) — D2.
`array-transaction-legacy.ts:181-183` (3) — the observation-start `catch`; its only thrower is
`:328-329`, gated by the caller (§7 Q3).
`client.ts:449-450` (2) — D3; `client.ts:973-976` (4) — D4.
`unique-where-guard.ts:48` (1) — D9.
`schema-introspection.ts:97` (1) and `:193-199` (7) — D9.
`raw.ts:373-375` (3) — the `{ commitCertainty }` arm of `executeWith`'s completion facts;
`#observationCommitCertainty` is only ever written by `#withObservationNotifications`
(`raw.ts:585-619`), which the `executeWith` path (`:346-379`) never installs, and a member cannot
have been awaited first (duplicate/awaited members are refused —
`query-interceptors-array.core.test.ts:1780`).

### 4.3 Branch paths (≈36)

One per dead statement block above, plus these branch-only cases:

* `typescript-type-renderer.ts:75` — `renderPropertyName`'s quoting arm. Every name it receives is a
  schema key, a field key, or a fixed internal alias, and `hydrateSchemaNames` enforces
  `/^[a-zA-Z_][a-zA-Z0-9_]*$/` (`schema/hydration.ts:70`, `:74-75`; `schema/identifier.ts:3`), a
  strict subset of the renderer's own `IDENTIFIER` at `:42`.
* `typescript-type-renderer.ts:260` / `:444` — `variants.length === 0 ? atom("never")`. A variant
  edge's `members` is a non-empty tuple (`schema/validation/relation-resolution.ts:120-133`).
* `omit.ts:311` — `if (!target) continue;`. `slotTarget` (`:351-363`) returns a model on every path;
  the `| undefined` in its signature has no producer.
* `client.ts:697` — `(engine.extensionChain?.statement.length ?? 0)`. The enclosing
  `attachPendingCacheExecution` only runs with the official cache present, which implies a chain.
* `raw.ts:344` — D9.
* `array-transaction-legacy.ts:368` — `resolveObservedMember`'s `settled` guard; nothing resolves an
  already-rejected member.

### 4.4 The native-batch path specifically (the orchestrator asked)

`array-transaction-native-batch.ts` has **zero** uncovered branches and **one** uncovered function
whose 15 statements are the file's entire deficit: `missingOperationResult`. The exact normalization
line is `src/drivers/normalized-result.ts:156`
(`results.length !== expectedStatementCount` → throw) together with `:171`
(`assertNormalizedQueryResult(results[resultIndex], …)`, which rejects `undefined`). Invoked from
`array-transaction-native-batch.ts:46-50` (`assertNativeBatchResults`) and directly at
`array-transaction-legacy.ts:120`. There is no honest witness; report and move on.

---

## 5. Manifest consequences

`scripts/client-test-manifest.mjs:14-22` is a **directory read**: every
`tests/contracts/public-client/*.core.test.ts` (flat only — subdirectories are excluded because the
`readdirSync` entries `cli`, `errors`, `extensions` do not end in `.core.test.ts`) plus exactly two
audited extended files (`geopoint-provider-limit.test.ts`, `omit-builder-types.test.ts`).
`tests/README.md` now states this explicitly ("a new core file joins its coverage lane
automatically … The client set has no import audit").

Consequences for this plan:

1. **Every case above lands in an already-admitted file.** No manifest edit is required, and
   `scripts/coverage-policy.test.mjs:176-188` (which re-derives the expected set from the same
   directory) stays green without change.
2. If Phase 3 nevertheless wants a new file, it **must** be flat in
   `tests/contracts/public-client/` and end in `.core.test.ts`. A file under `errors/` or
   `extensions/` would run in `layer-client` but contribute **nothing** to
   `pnpm test:coverage:client`; a file named `*.test.ts` would contribute nothing either and would
   additionally be swept into `test:all` via `scripts/credential-free-test-manifest.mjs`.
3. Admission is also automatic into **`layer-client`** (`vitest.workspace.ts:57-60`), which shares a
   **30-second budget for runtime + type probes together** (`tests/README.md`). Several cases here
   need a driver that drives transaction phases; keep them cheap and prefer adding `test(...)` cases
   to existing files over new module-scope clients. `src/client/AGENTS.md` warns that module-scope
   `createClient()` keeps schema registries alive for the whole worker.
4. `client-coverage.core.test.ts` and `config-subpath.core.test.ts` / `public-runtime-surface.core.test.ts`
   are *also* claimed by other coverage projects (`coverage-public`, `coverage-extensions` —
   `vitest.workspace.ts:88-121`). Adding cases there is fine; renaming or moving them is not.

---

## 6. Semantic duplication worth removing

I found no *behavioural* duplication that is safe to delete outright — but three overlaps are worth
the orchestrator's attention, and two of them are the reason some of §3 looks like new work when the
behaviour is arguably already tested somewhere:

1. **`default-omit-extension.test.ts` (extended) vs the admitted core set.** `:222` "preserves select
   and local omit precedence" and `:306` "rewrites ordinary, recursive, direct-variant, and
   collection results" cover much of O1/O2 end-to-end through `createClient`, but the file is not
   admitted, so it neither counts nor protects the lane. Rather than duplicating it, consider
   promoting **one** representative sentinel from it (per `tests/README.md` §"Adding behavior" step
   2: "Mark only a representative, deterministic sentinel as core") — the select-precedence test is
   the highest-value candidate. That single rename would close O1's lines through the *public* API
   instead of the `applyClientOmit` unit lane, which is what AGENTS.md prefers. Cost: it joins the
   30-second `layer-client` budget.
2. **Empty-array `$transaction([])`.** `array-transaction.ts:96` and `:109` are two separate early
   returns for the same user-visible behaviour. Do not write two tests spelled the same way; write
   A2 explicitly as *"with observers attached"* and reference the unobserved sibling, or the pair
   reads as redundant defense.
3. **`assertAtomicArraySupport` / `assertNativeBatchResults` / `unbatchableArrayError` in
   `client-coverage.core.test.ts:326-355`** are direct-module unit calls that overlap the
   end-to-end refusals in `array-transaction-legacy-batch-boundaries.core.test.ts:89-102`. They are
   cheap and already green; I would leave them, but any *new* native-batch case (N2) should be
   written end-to-end through `$transaction([...])`, not as a third direct call.

Also worth noting for the record: the *production* redundancy in §2 is the real duplication problem
here. Five of the renderer's guards, the raw `observe` guard, and `missingOperationResult` are each a
second guard for an invariant that already has a single home — precisely what AGENTS.md's
"one guard per invariant" section bans.

---

## 7. What I could not determine statically — for the orchestrator to resolve at runtime

| # | question | why it matters | cheap probe |
|---|---|---|---|
| Q1 | Does `s.enum([])` survive `s.model()` + `hydrateSchemaNames` + `resolveSchemaOrThrow`? | R2 is the only honest witness for `typescript-type-renderer.ts:69-70`; if an empty enum is refused earlier, that line joins §4 | `renderSchemaType({ m: s.model({ status: s.enum([]) }) })` |
| Q2 | Does `v.enum` accept non-string values when called from JS (`Reflect.apply(s.enum, undefined, [[1, 2]])`), and does the model/schema gate admit the resulting scalar? | R3 is the only witness for `:114-121` | build the model, call `renderSchemaType` |
| Q3 | Can a `PendingOperation`/`RawOperation` created on a client **without** observers be passed to `$transaction([...])` on a `$extends`-derived client **with** observers and still pass the `clientId`/`scopeId` check? | decides whether `array-transaction.ts:277-278`, `array-transaction-legacy.ts:328-329` and the `:176-183` catch are reachable (3+ statements) or §4 | derive with an `observe` extension, build the member on the base client, `$transaction([member])` on the derived one |
| Q4 | Does `PlanningDriver("postgresql")` supply an `adapter.namespace`? | C3 needs a postgresql-dialect driver whose adapter has none; if `PlanningDriver` already supplies one, the case needs a local `Driver` subclass with a bare `PostgresAdapter`-less adapter | read `tests/fixtures/drivers/planning.ts` or run C3 both ways |
| Q5 | Can a `request` handler legally return `undefined` (so `applyRequestTransforms` returns undefined)? | decides whether `client.ts:565`'s `?? {}` is C6 or §4 | `$extends({ name, request: () => undefined })` then any operation |
| Q6 | Does a **model-mapped** `query: { user: { findMany } }` chain leave a `DeferredRawOperation`'s `#queryHandlers` empty while still making the array require interception? | W6 depends on it | inspect `src/extensions/chain.ts` handler compilation, or run the two-member array |
| Q7 | Is a variant arm written as `false` (`include: { subject: { post: false } }`) accepted by the polymorphic projection schema? | O7's rewrite runs *before* validation so the rewrite behaviour is pinned either way, but if `false` is refused the test must assert the refusal comes from validation, not from a rewritten payload | `validateOperationPayload(schema, "comment", "findMany", { include: { subject: { post: false } } })` |
| Q8 | Exact post-fix numbers. | Even the full §3 pass lands ≈97.4% statements / ≈96.8% branches / 96.43% functions (§1). Re-run `pnpm test:coverage:client` after Phase 3 and compare against §1's ceilings before deciding between the three options | — |

---

## 8. Runtime-command statement

I ran **no** runtime command: no `vitest`, no `pnpm test:*`, no coverage run, no `tsc`, no build, no
`tsdown`/`package:build`, no `biome`, and no Node process that executes repository code. The only
commands used were read-only shell utilities (`cat`, `sed`, `grep`, `ls`, `wc`, `git status`,
`git log`) plus two throw-away `python3` scripts in the session scratchpad that parse the
**pre-existing** JSON file `coverage/client/coverage-final.json` and print source ranges. No test,
build, or coverage process was started, and nothing under `src/` or `tests/` was modified. The only
file this task wrote is `.claude/client-coverage-plan.md`.
