# Raptor 3 unmatched-refusal map (Area C follow-up)

Read-only mapping against `pattern-engine` @ `464705acc`. Source list:
`docs/architecture/raptor3-evidence/g4/root-review-C-receipts/unmatched.json`.
Every site was re-located by grepping its exact message text in
`src/query-engine/raptor3/**` (line numbers had drifted from the census; all
line numbers below are current). Reachability is assessed against the public
client API (`createClient`/model proxies), i.e. what a caller can construct
with TypeScript types and what `EngineSchema.admit`/`validation/**` let through
— not against internal unit tests that call engine internals directly.

> **Addendum (FC-00, 2026-09-21, `29a7bf9d8`).** This map is preserved as written
> and is still the per-row ruling the census defers to for the sentences that
> remain. It is **stale on six rows**: #23, #25, #31, #32, #48 and #49 name
> sentences that are no longer in `src/` at `29a7bf9d8` (each exact sentence
> grepped). #48 and #49 were re-expressed as the invariants at
> `shared/storage.ts:248` and `:72`; the other four were executed or deleted by
> the parity, N-series and D-58 work. Its ranked "ten sentences whose removal
> would most widen behavior" list is obsolete at positions 1, 2, 5, 6 and 7 for
> the same reason. For **capability** — which admitted behaviors are supported,
> refused, accepted as limits or pending a decision — the authority is now
> `docs/architecture/raptor3-evidence/g4/release/closure/fc00/inventory.md`.
> Nothing here is rewritten; read the two together.

**Count discrepancy, stated up front:** the task brief says 63 unmatched
sentences. `unmatched.json` as it exists on disk now has **59** entries. Of
those, 4 are the garbage fragments named in the brief (3 comment fragments +
the `updateHasRelations ? … : undefined` ternary fragment) — skipped below,
per instructions. That leaves **55** real sentences processed. I could not
reconcile 63 vs. 59 (4 apart, not the same 4 as the garbage set) — either the
brief's count already excluded garbage differently, or the file changed since
the count was taken. I'm treating the file on disk as ground truth.

Legend — **kind**: INVARIANT (internal state impossible if code is right) ·
NOT-IMPLEMENTED (admitted payload shape, no execution yet) · CAPABILITY
(provider/transport limit) · INTEGRITY (execution fact: existence, membership,
concurrency, cardinality, provider row shape) · PUBLICATION (value that can't
reach a dependent on the batch route).
**disposition**: DELETE / ASSERT / EXECUTE / KEEP (definitions per the task
brief).

---

## Cluster note: the recursive-read feature has no public entry point at all

Eleven of the 55 sentences below belong to `Queries.recursive` /
`decodeRecursive` / the route's recursive cache-codec guard. I checked every
caller: `grep -rn "\.recursive(" src/query-engine/raptor3/` finds exactly one
call site outside `shared/query.ts` itself and the six `tests/raptor3/**`
files that call `Queries.recursive` directly — none in `commands/`,
`program/`, or `route/client-route.ts`. `grep -rn 'kind: "recursive"'` outside
`shared/query.ts` finds nothing. There is no public verb, argument, or schema
option (checked `validation/model/**`, `src/client/*.ts`) that builds a
`RecursiveTraversal` or asks for a `"recursive"` projection shape. AGENTS.md
calls this "the private recursive-read fit" — accurate: it is fully built and
unit-tested in isolation but never wired to `commands/`'s public dispatch. All
11 are marked **reachable: NO** for that reason (not because admission refuses
a bad payload — because no admitted payload can reach the mechanism at all).

---

## `shared/query.ts`

| # | sentence | site (current) | guard condition | reachable | kind | disposition |
|---|---|---|---|---|---|---|
| 1 | A recursive shape requires occurrence rows | query.ts:4270 | `decodeValue` refuses a nested `"recursive"` shape (a recursive read shape appearing anywhere but the top-level `decodeRecursive` entry) | NO — recursive cluster, see note above | INVARIANT | ASSERT (cheap defensive TypeError; no cost to keep once/if the feature is wired) |
| 2 | A recursive traversal requires at least one seed | query.ts:3171 | `recursive(model, traversal)` refuses `traversal.seeds.length === 0` | NO — recursive cluster | INVARIANT (would become a real admission fact once wired) | ASSERT |
| 3 | distance `${usage}` (full message via `FeatureNotSupportedError("point", "distance ${usage}", "GeoPoint distance is not supported by this provider.")`) | query.ts:2202 | `distanceExpression` refuses when `!geoPoint.distance` — the adapter's GeoPoint tier has no `distance` operator | **YES** — smallest payload: `db.place.findMany({ where: { location: { distance: { to: {lat,lng}, lt: 100 } } } })` (or `orderBy`/`select` distance) on a provider/adapter whose GeoPoint tier doesn't implement `distance` (e.g. SQLite without the extension, or a MySQL tier below full spatial) | CAPABILITY | KEEP — AGENTS.md: "never emulates a tier in JavaScript"; this is the one registered sentence for all three distance consumers (filter/order/projection) |
| 4 | Invalid provider collection | query.ts:4302 | `decodeValue`, `shape.kind === "collection"`: the raw decoded value for a to-many relation projection (JSON-aggregated) isn't an array | NO — only a malformed/misbehaving driver result triggers this; every admitted `include`/`select` of a to-many relation builds the aggregate SQL itself, so a correct provider always returns an array here | INTEGRITY (provider row shape) | KEEP — the D-17/D-28 "transport asked about a value exactly once, at the row boundary" contract; no other owner re-checks provider row shape |
| 5 | Invalid provider recursive collection | query.ts:4255 | inside `decodeRecursive`: a child slot isn't an array where `shape.many` | NO — recursive cluster | INTEGRITY | KEEP (once wired) |
| 6 | Invalid provider recursive occurrence | query.ts:4219 | `decodeRecursive`: seed/depth carriers aren't safe integers | NO — recursive cluster | INTEGRITY | KEEP (once wired) |
| 7 | Invalid provider recursive parent occurrence | query.ts:4251 | `decodeRecursive`: no parent occurrence found at `path.slice(0,-1)` | NO — recursive cluster | INTEGRITY | KEEP (once wired) |
| 8 | Invalid provider recursive path | query.ts:4223 | `decodeRecursive`: path carrier isn't an array after JSON-parsing | NO — recursive cluster | INTEGRITY | KEEP (once wired) |
| 9 | Invalid provider recursive row | query.ts:4238 | `decodeRecursive`: decoded occurrence value isn't a plain object | NO — recursive cluster | INTEGRITY | KEEP (once wired) |
| 10 | Invalid provider recursive seed | query.ts:4227 | `decodeRecursive`: `depth===0` but no seed shape at that index | NO — recursive cluster | INTEGRITY | KEEP (once wired) |
| 11 | Invalid provider row | query.ts:4313, 4320 | `decodeValue` default object branch: decoded value is `null` on a non-nullable carrier, or isn't an object/array-free — a to-one JSON-carried document | NO — same malformed-driver-only reasoning as #4 | INTEGRITY | KEEP |
| 12 | Raptor 3 aggregate is not implemented: `${aggregate}` | query.ts:3121 | `aggregateExpression` `default:` over `_count/_sum/_min/_max/_avg` | UNSURE leaning NO — `aggregate` is typed from the closed `AGGREGATES`/`AGGREGATE_NAMES` set this same file defines (`const AGGREGATES = ["_count","_avg","_sum","_min","_max"]`), which is also what admission (`validation/model/args/aggregate.ts`) enumerates; didn't trace whether every call site narrows the type before calling | INVARIANT | ASSERT |
| 13 | Raptor 3 cannot name the updated value of `'X.field'` under `'operator'`: the provider owns that operator's rounding inside its own assignment | query.ts:1084 | `updateValue`: `update.kind === "list"` or (exact-decimal domain AND operator is `multiply`/`divide`) | **YES** — the function's own doc comment states it: "A decimal PRIMARY key never reaches it… so the reachable shape is a decimal RELATION key." Smallest payload: nested write setting a decimal-typed relation/foreign-key field with `{ multiply: 2 }` or `{ divide: 2 }` | CAPABILITY | KEEP — doc comment: "recorded as a decision for Arnaud (note §R2.1)"; already a pinned, named decision, not an oversight |
| 14 | Raptor 3 createMany final read returned inconsistent row counts. | query.ts:4185 | `assertExpectedRows`: the terminal read-back returned MORE rows than `expectedRows.count` (fewer rows is a different, already-matched sentence) | **YES**, but only via a genuine race — two OR'd identity predicates matching more rows than submitted means a primary key moved/collided between the capture and the read-back window. Not reachable from a single caller's payload alone; reachable via concurrent writes racing a `createMany`/`updateMany({select})` read-back | INTEGRITY (concurrency, cardinality) | KEEP — exactly the "affected-row requirements are execution facts" class in ELEGANCE §5 |
| 15 | Raptor 3 filter operator is not implemented: `${operator}` | query.ts:2035 | `lowerOperation` `default:` over 16 enumerated operators (equals/in/notIn/lt/lte/gt/gte/contains/startsWith/endsWith/has/hasEvery/hasSome/isEmpty/within/distance) | NO — each per-scalar-type filter file only ever admits keys mapping into this exact set; AGENTS.md: "`prepareOperations`/`prepareOperation` prepare every one of them… Do not add a second operator switch" | INVARIANT | ASSERT |
| 16 | Raptor 3 G1 atomic output requires exact identity scratch or segmented RETURNING | operation-context.ts:2327 | in `insert`'s batch arm: `!carriesIdentity` (produced field isn't a single `increment`-kind key) AND (`!supportsReturning` OR `supportsCteWithMutations`) | **YES** per AGENTS.md, which names the exact reachable shape: "a produced field that is not one increment key, on a provider whose RETURNING cannot be segmented." I did not fully re-derive which live adapter combination satisfies the boolean condition (budget) | CAPABILITY | KEEP — AGENTS.md explicitly: "do not widen the scratch to other produced columns without a ruling" (a named, owned decision boundary, not a gap to close casually) |
| 17 | Raptor 3 G3P-05 relation filter is not implemented: `${predicate.quantifier}` | query.ts:2252 | `default:` over `some/none/every/is/isNot` | NO — AGENTS.md: "every relation filter that spells quantifiers… refuses a payload that names none of them, in its own registered sentence" at admission; this switch only ever receives an already-admitted quantifier | INVARIANT | ASSERT |
| 18 | Raptor 3 JSON filter operator is not implemented: `${predicate.operator}` | query.ts:2158 | `default:` over the JSON operator set (`equals/not/lt/…/string_contains/…/array_ends_with` etc.) | NO — same reasoning as #15/#17; JSON operators are enumerated once at admission (Lane Q: "the six grammar refusals and the one portable-path rule") | INVARIANT | ASSERT |
| 19 | Raptor 3 recursive traversal relation `'X'` is not self-referential | query.ts:3184 | `recursive()`: `edge.target !== model` | NO — recursive cluster | INVARIANT (would be real once wired) | ASSERT |
| 20 | Raptor 3 recursive traversal requires one ordinary relation: `${traversal.relation}` | query.ts:3179 | `recursive()`: resolved edge is undefined or is a `variantRowCarrier`/`variantJunctionCarrier` | NO — recursive cluster | INVARIANT (real once wired) | ASSERT |
| 21 | the value is not a binary value | query.ts:4774, 4785 | `decodeBlob`/`base64Bytes`: raw provider value for a `blob` column matches none of the recognized binary spellings | NO — decode-time provider-value check on the READ path; a correctly-behaving driver always returns one of the recognized forms for a blob column it stored | INTEGRITY (provider value domain) | KEEP — D-17 row-boundary decode contract |
| 22 | the value is not an array of finite numbers | query.ts:4534 | `decodeScalar` `"vector"` case: raw provider value isn't `Array<finite number>` | NO — same reasoning as #21, decode-time provider-value check | INTEGRITY | KEEP |

## `shared/operation-context.ts`

| # | sentence | site (current) | guard condition | reachable | kind | disposition |
|---|---|---|---|---|---|---|
| 23 | Cannot publish the updated value of `'X.field'` for operation `"op"` inside an atomic batch: the batch scratch reads back as an integer, and `'field'` is a `${state.type}` field. | operation-context.ts:2444 | on a driver with no interactive transaction, a dependent needs the computed value of a scalar-operator update (`increment` etc.) on a field whose type isn't `int` | **YES** — smallest payload: nested write on a batch-only driver where a parent's `{ field: { increment: 1.5 } }` (a `float`/`decimal`/etc. field) must be read back by a dependent child write | CAPABILITY | KEEP — already given its own class (`UnsupportedOperationError`, V8003) specifically so callers can tell "deliberate capability boundary" from "crash" by class (R-D3, Arnaud 2026-09-16); textbook KEEP |
| 24 | deleteMany selected-row cardinality changed during its locked mutation. | operation-context.ts:2135 | after the captured-identity `DELETE … WHERE key IN (captured)`, `response.rowCount !== identities.length` | **YES** via a genuine race: concurrent write removes/moves a captured row between the plan-time capture and the locked mutation statement, on a relation-bearing selected `deleteMany` | INTEGRITY (concurrency, cardinality) | KEEP |
| 25 | Driver `'X'` cannot atomically capture selected `${operation}` rows. | operation-context.ts:2177 | `captureMutationIdentities`: `this.usesBatch` is true (no interactive session) for a relation-bearing selected `updateMany`/`deleteMany` that needs a plan-time capture | **YES** — smallest payload: a relation-bearing `updateMany`/`deleteMany` (nested member with a relation change, or a selected series that needs captured identities) on a batch-only driver (D1/PlanetScale-style, no interactive transaction) | CAPABILITY | KEEP — a batch-only transport genuinely cannot hold a captured selection across two statements without an interactive session |
| 26 | Driver `'X'` cannot locate one selected createMany row after insertion. | operation-context.ts:1818 | `createMany({select})` non-RETURNING/skipDuplicates-recoverable path: an inserted row is missing more than one server-generated key field, or its one missing field isn't a plain `increment` key | **NO schema this ORM can PUSH to MySQL holds the shape** (M1, D-59, 2026-09-21): every ORM generator except `increment` is a JavaScript closure evaluated at admission, so only two `increment` columns among the fields the operation must know reach it, and MySQL — the one shipped adapter with `supportsReturning: false` — refuses such a table at DDL (errno 1075, measured on the Docker lane). The guard reads the DECLARATION and the adapter capability before any statement is emitted, so a schema that declares two `.increment()` columns reaches both sentences on the shipped mysql2 driver against a table the ORM did not create, or before any push (the review's measurement). Kept as that limit. (Was: YES — smallest payload: `createMany({ data, select })` on a non-RETURNING driver (MySQL) for a model whose generated identity isn't a single trackable `increment` field (composite key with more than one server-defaulted part)) | CAPABILITY | KEEP |
| 27 | Driver `'X'` omitted the prepared result for operation `'op'`. | operation-context.ts:1003, 1597 | `publishPrepared`: the externally-supplied results array (from `prepareBatch`'s prepared-statement protocol) has no entry at this read's queued index | NO via query *payload* — this fires only if the caller of the prepared-batch protocol (an external driver/transport integration, not a query argument) returns a shorter results array than what was queued | INTEGRITY (transport) | KEEP — no other owner checks the driver's returned-array length against what it queued |
| 28 | INSERT did not produce the required record | commands.ts:1146, 1212; operation-context.ts:2301 | the folded root-create/root-upsert fast path's `missing` callback for `createMany`'s identity read-back (1 row submitted, RETURNING-safe) | NO via payload — a single-row INSERT that returns success with zero returned/located rows is a provider/driver anomaly, not something a payload shape controls | INTEGRITY (provider row shape) | KEEP — 3 call sites already share exactly one sentence (already satisfies "one semantic rule across its real consumers") |
| 29 | INSERT did not produce the required record identity | operation-context.ts:1859 | batch createMany: driver reports success (`rowCount`) for a row needing a generated identity, but `response.insertId === undefined` | NO via payload — driver-behavior anomaly (claims success on an auto-increment insert but supplies no last-insert-id) | INTEGRITY | KEEP |
| 30 | INSERT RETURNING did not produce the required record | operation-context.ts:2356 | the exact-identity-scratch RETURNING segment (non-`carriesIdentity` branch) reads back zero rows for the just-produced key(s) | UNSURE, leaning YES via same-batch ordering (an array batch that inserts then deletes the same row before this segment resolves) — didn't fully trace batch statement ordering guarantees within budget | INTEGRITY | KEEP |
| 31 | Raptor 3 atomic-array execution is not implemented. | operation-context.ts:327 | `OperationContext` constructor: `binding?.kind === "atomic-array"` | **NO — provably dead.** `ExecutionBinding`'s `"atomic-array"` variant is never constructed anywhere in `src/` (`grep -rn '"atomic-array"' src/` outside this one file: zero hits). `route/client-route.ts` only ever constructs `"borrowed-transaction"` or leaves the binding absent (`"standalone"`); the public array form `$transaction([...])` runs through the client's separate array owner, which uses `driverOverride`/`"borrowed-transaction"` with no grant (AGENTS.md: "mirrors the shipped `runLinearOn`"), never this binding kind | INVARIANT (not NOT-IMPLEMENTED — nothing produces the state this guards against) | **DELETE** — established upstream by the route: only `"borrowed-transaction"` and implicit `"standalone"` are ever constructed. The `"atomic-array"` union member and this guard are dead type surface, not a live feature gap (the array form already works via the other mechanism) |
| 32 | Raptor 3 G1 set requires junction storage | operation-context.ts:2694 | `clear(edge, …)` for a variant/polymorphic collection `set`: `edge.kind !== "junction"` | UNSURE — needs the schema layer to confirm whether a non-junction (row-held) variant/polymorphic collection can currently be declared and reached with a `set` verb; didn't trace `s.model()`'s variant-carrier builder within budget. The "G1" prefix (shared with 3 other genuinely-staged entries below) suggests this is deliberately scoped-out, not accidental | NOT-IMPLEMENTED | EXECUTE — AGENTS.md documents an existing non-junction mechanism for `set` elsewhere ("`set` departures write only its authoritative `columns.fields`"); if reachable, that's the existing owner to extend, not a new abstraction |
| 33 | Raptor 3 interactive output requires RETURNING or one generated increment field | operation-context.ts:2274 | non-batch (`!usesBatch`) `insert`: `produced.length` (a demanded generated field) AND `!supportsReturning` AND no single `increment` key among them | **NO schema this ORM can PUSH to MySQL holds the shape** (M1, D-59, 2026-09-21): every ORM generator except `increment` is a JavaScript closure evaluated at admission, so only two `increment` columns among the fields the operation must know reach it, and MySQL — the one shipped adapter with `supportsReturning: false` — refuses such a table at DDL (errno 1075, measured on the Docker lane). The guard reads the DECLARATION and the adapter capability before any statement is emitted, so a schema that declares two `.increment()` columns reaches both sentences on the shipped mysql2 driver against a table the ORM did not create, or before any push (the review's measurement). Kept as that limit. (Was: YES — smallest payload: `create`/nested-create with a demanded generated/default field, on an interactive (non-batch) driver without RETURNING support (MySQL) whose generated identity isn't a lone `increment` key) | CAPABILITY | KEEP |
| 34 | UPDATE did not produce the required record | operation-context.ts:2501 | non-RETURNING update path's follow-up SELECT read-back finds no row for the just-updated identity | **YES** via race — concurrent delete of the just-updated row between the UPDATE and the follow-up SELECT | INTEGRITY (concurrency) | KEEP |
| 35 | UPDATE RETURNING did not produce the required record | operation-context.ts:2515 | RETURNING-based update statement returns zero rows for a `captured` identity | **YES** via race — same class as #34, RETURNING variant | INTEGRITY | KEEP |
| 36 | updateMany selected-row cardinality changed during its locked mutation. | operation-context.ts:2051 | captured-identity `UPDATE … WHERE key IN (captured)`: `response.rowCount !== identities.length` | **YES** via race — same class as #24, update variant | INTEGRITY (concurrency, cardinality) | KEEP |

## `commands/commands.ts` and `commands/index.ts`

All of the following are internal occurrence-tree bookkeeping inside
`Commands.analyze`'s materialization/dependency-analysis machinery (the
mechanism AGENTS.md describes at length: "Materialization resolves that pair
within the parent's local direct-child correspondence… never resolve
descendants through one shared replacement map"). They check the engine's own
tree-copy/traversal invariants, not payload shape.

| # | sentence | site (current) | guard condition | reachable | kind | disposition |
|---|---|---|---|---|---|---|
| 37 | Command occurrence is missing from its parent | commands.ts:841 | `visitPrecedingWrites`: walked every sibling of `target`'s parent without finding `target` itself | NO | INVARIANT | ASSERT |
| 38 | Command occurrence is not a series capture | commands.ts:531 | `seriesCaptureTarget`: `occurrence.command.kind !== "captureSeries"` | NO | INVARIANT | ASSERT |
| 39 | Selected series has no enclosing analysis | commands.ts:985 | `expandSeries`: `seriesOwner(occurrence)` is undefined | NO | INVARIANT | ASSERT |
| 40 | Selected series occurrence was already expanded | commands.ts:987 | `expandSeries`: `seriesMembers(occurrence).length` is already nonzero | NO | INVARIANT | ASSERT |
| 41 | Series capture has no occurrence target | commands.ts:533 | `seriesCaptureTarget`: `occurrence.captureTarget` is undefined after the kind check passes | NO | INVARIANT | ASSERT |
| 42 | Series capture target lost its occurrence kind | commands.ts:405 | `materializePlacement`: a `captureSeries` command's replacement target isn't a series occurrence after the tree copy | NO | INVARIANT | ASSERT |
| 43 | Raptor 3 G1 operation is not implemented: `${operation}` | commands/index.ts:153 (production); program/index.ts:41 (dead, see program/ note) | `admittedOperation` `default:` — but its `switch` enumerates all 16 members of the closed `Operations` union (`src/client/types.ts:44`) one-for-one, including both `…OrThrow` variants | NO — TS-exhaustive over the closed public `Operations` union; every member is handled | INVARIANT | ASSERT |

## `commands/execution.ts`

Same class as the `commands.ts` cluster — internal sequencing invariants about
the attempt-local `series` map, populated by `captureSeries` one line above
each of these reads in the same async function.

| # | sentence | site (current) | guard condition | reachable | kind | disposition |
|---|---|---|---|---|---|---|
| 44 | Selected delete series has no mutation origin | execution.ts:844 | `captureSeries`: `series.mutation.kind === "delete"` but `selection.origin` is undefined | NO | INVARIANT | ASSERT |
| 45 | Selected series was not captured | execution.ts:677, 886 | `series()`/`executeSeries()`: `attempt.series.get(occurrence)` is empty immediately after `captureSeries` populated it | NO | INVARIANT | ASSERT |
| 46 | Selected update series has no location | execution.ts:891 | `executeSeries`: a member's `command.located` is undefined | NO | INVARIANT | ASSERT |

## `commands/relation-body.ts` (+ dead `program/program.ts` twin)

| # | sentence | site (current) | guard condition | reachable | kind | disposition |
|---|---|---|---|---|---|---|
| 47 | Raptor 3 G1 relation operation is not implemented: `${verb}` | relation-body.ts:684 (production); program.ts:187 (dead) | `default:` over an 11-case switch (`disconnect/delete/create/createMany/connect/connectOrCreate/upsert/update/set/updateMany/deleteMany`) — `verb: string`, not a closed TS union | NO — not TS-exhaustive, but validation's strict nested-relation-write schemas only ever admit keys from this exact 11-verb vocabulary, so no admitted payload can spell a 12th verb | INVARIANT (established upstream by validation's strict object schemas) | ASSERT — worth keeping specifically *because* the type is loose (`string`), unlike the TS-exhaustive switches above |

## `shared/storage.ts`

| # | sentence | site (current) | guard condition | reachable | kind | disposition |
|---|---|---|---|---|---|---|
| 48 | Raptor 3 G1 physical field is not implemented: `${field}` | storage.ts:214 | `buildPhysicalFieldView`: `field` names neither a scalar nor a variant-row-carrier's `typeColumn`/`idColumn` | UNSURE — depends on whether the schema builder can declare a resolved-schema shape whose physical fields this resolver doesn't yet enumerate (e.g. a junction-carrier's own columns); not traced within budget | NOT-IMPLEMENTED (or INVARIANT if schema construction already forecloses it — undetermined) | EXECUTE if reachable — extend the same resolver, no new abstraction; otherwise ASSERT |
| 49 | Raptor 3 G1 variant carrier membership is not implemented: `${name}` | storage.ts:65 | `variantMember`: neither the untagged nor the tagged resolution named `name` exists | UNSURE — same schema-layer caveat as #48; doc comment calls it "the candidate's registered unimplemented identity", implying a genuine, named, currently-real gap for some variant-membership addressing shape | NOT-IMPLEMENTED | EXECUTE if reachable — the surrounding code already knows how to resolve both the untagged and tagged forms; extending to the missing addressing shape reuses that same resolver |

## `route/client-route.ts`

| # | sentence | site (current) | guard condition | reachable | kind | disposition |
|---|---|---|---|---|---|---|
| 50 | The Raptor 3 route cannot encode a cached `'${leaf.type}'` result for `'op'`: the leaf publishes no declaring scalar. | client-route.ts:354 | `leafCodec` else-branch: `leaf.type` is none of the three undeclared-scalar leaves the doc comment enumerates (`_count`/`exist`/non-decimal `_avg`/`_distance`, handled by the boolean/int/number branches just above) | NO — by the function's own doc comment, every undeclared-scalar leaf kind that exists today is already one of those three, all handled before this branch | INVARIANT | ASSERT — a real refusal only if a future leaf kind adds a 4th undeclared-scalar case without updating this branch |
| 51 | The Raptor 3 route cannot encode a cached result for `'op'` on model `'M'`: the verb publishes no prepared read. | client-route.ts:199 | `cacheResultCodec()`: `prepared.read` is undefined (a write verb has no `.read`) | UNSURE — didn't trace whether the cache middleware that calls `cacheResultCodec()` is itself scoped to `CacheableOperations` before calling it, or whether a misconfigured cache extension could invoke it for a write verb | CAPABILITY (or INVARIANT if the caller is always pre-scoped) | KEEP if reachable (a write result genuinely can't be cache-encoded); ASSERT if the caller always pre-filters |
| 52 | The Raptor 3 route cannot encode a cached result for `'op'`: a recursive read's published depth is not a fixed shape. | client-route.ts:319 | `shapeCodec`, `case "recursive"` | NO — recursive cluster (no admitted payload ever produces a `"recursive"` published shape to cache) | INTEGRITY (once wired) | KEEP (once wired) |

## `program/program.ts` and `program/index.ts` — the retired comparison specimen

`program/` is not routed. `createCandidateRoute` (the only production entry,
imported by `src/client/client.ts:72`) is built entirely from `commands/`;
nothing outside `program/` itself imports from `program/`
(`grep -rln "raptor3/program" src --include="*.ts"` returns nothing besides
`program/`'s own files). Per AGENTS.md: "`program/` is retained only as its
private comparison specimen." Every sentence whose *only* site is inside
`program/` is therefore unreachable from the public client, full stop — not
because admission refuses a bad payload, but because the client never invokes
this code at all.

| # | sentence | site (current) | reachable | kind | disposition |
|---|---|---|---|---|---|
| 53 | Nested operation `'op'` on relation `'rel'` depends on an earlier `'op2'` target write in the same nested write. Split these operations into separate queries. | program.ts:398 (only site) | NO — program/ not routed | N/A (dead code, not a shipped refusal) | DELETE candidate — but ELEGANCE's own local-application note says "An active comparison specimen stays outside the shipped graph, never as a hidden fallback," implying `program/` is *meant* to stay as a comparison specimen; deleting this one throw without deleting `program/` itself would be inconsistent. Recommend: leave to the specimen's own retention decision, not a one-off deletion |
| 54 | Raptor 3 program has a cyclic produced-field dependency | program.ts:356 (only site) | NO — program/ not routed | N/A | same as #53 |
| 55 | Raptor 3 G1 source-held update supply is not implemented | program.ts:239 (only site) | NO — program/ not routed | N/A | same as #53 |

---

## Skipped (garbage entries, as instructed)

- `"s grant names the caller"` (operation-context.ts, 3 sites) — comment fragment (`… borrowed-transaction operation owns a region only when it's grant names the caller …`), not a throw sentence.
- `"s own — a nested locate names the nested record, exactly as the\n * shipped executor"` (operation-context.ts:473-ish) — comment fragment.
- `"s published result, live or packaged. A prepared read is one\n * statement plus the operation"` (operation-context.ts:498-ish) — comment fragment.
- `"updateHasRelations ? … : undefined"` (commands.ts:1206-ish) — a ternary-expression fragment the census script mis-captured, not a throw.

---

## Summary

**Processed: 55** (of 59 entries in `unmatched.json`; 4 skipped as garbage per instructions; see count-discrepancy note above). Counts below are an exact tally of the per-row table, row by row.

### By kind

| kind | count | rows |
|---|---|---|
| INVARIANT | 21 | #1, 2, 12, 15, 17, 18, 19, 20, 31, 37, 38, 39, 40, 41, 42, 43, 44, 45, 46, 47, 50 |
| INTEGRITY | 20 | #4, 5, 6, 7, 8, 9, 10, 11, 14, 21, 22, 24, 27, 28, 29, 30, 34, 35, 36, 52 |
| CAPABILITY | 8 | #3, 13, 16, 23, 25, 26, 33, 51 (51 is unsure — see its row) |
| NOT-IMPLEMENTED | 3 | #32, 48, 49 (all reachability-unsure — schema-layer tracing not finished) |
| unclassified (dead program.ts-only specimen code) | 3 | #53, 54, 55 — the task's 5 kinds describe a *live* guard's function; these never execute at all, so forcing a kind would overstate confidence |
| PUBLICATION | 0 | none of the 55 fit — the closest candidates (#16, #23, the batch-scratch/identity-scratch refusals) are CAPABILITY limits on what can be *computed* on a given transport, not on handing an already-computed value to a dependent |

21 + 20 + 8 + 3 + 3 = 55.

### By disposition

| disposition | count | rows |
|---|---|---|
| DELETE | 1 | #31 — the one entry proven dead by construction (grepped every constructor of `ExecutionBinding` in `src/`; only `"borrowed-transaction"` and implicit `"standalone"` are ever built) |
| DELETE, contingent on the `program/` specimen's own retention decision (not a per-sentence call) | 3 | #53, 54, 55 |
| ASSERT | 20 | every INVARIANT row except #31: #1, 2, 12, 15, 17, 18, 19, 20, 37, 38, 39, 40, 41, 42, 43, 44, 45, 46, 47, 50 |
| KEEP | 27 | #3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 14, 16, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 33, 34, 35, 36, 52 |
| EXECUTE, conditional on schema-layer confirmation I couldn't finish | 3 | #32, 48, 49 |
| genuinely unresolved (could be KEEP or ASSERT depending on an un-traced caller) | 1 | #51 |

1 + 3 + 20 + 27 + 3 + 1 = 55.

### Ten sentences whose removal or execution would most widen what an admitted payload can do

Ranked by real leverage, not raw block-count (most of the 55 block nothing
today — see kind counts above). Only entries that are reachable **and** would
unlock new behavior if addressed are eligible; pure INTEGRITY/CAPABILITY KEEP
entries protect correctness rather than block valid shapes, so they're
excluded even where reachable.

1. **The recursive-read cluster (11 sentences, #1,2,5–10,19,20,52)** — the single highest-leverage item by far. `Queries.recursive`, `decodeRecursive`, and the route's recursive cache codec are fully built and unit-tested but wired to no public verb. Executing this means adding the missing piece — a public verb/argument in `commands/` that calls the existing `Queries.recursive` owner — not writing new machinery. Today it blocks zero payloads (nothing reaches it); wiring it unlocks an entire feature (hierarchical/recursive reads) at once.
2. **#25 Driver cannot atomically capture selected rows** — blocks every relation-bearing selected `updateMany`/`deleteMany` on any batch-only (serverless/edge) driver. High real-world impact: this is an ordinary, expected operation shape, refused for a whole class of drivers.
3. **#26 Driver cannot locate one selected createMany row after insertion** — blocks `createMany({select})` on non-RETURNING drivers whenever the generated identity isn't a single plain increment field.
4. **#33 Interactive output requires RETURNING or one generated increment field** — same shape as #3 for the single-row interactive `create` path.
5. **#23 Cannot publish the updated value … inside an atomic batch (non-int field)** — blocks a dependent nested write from consuming a computed non-integer field's value on any batch-only driver; the batch scratch is int-only by construction (AGENTS.md: "Widening it needs a typed scratch read per domain… which is a capability change, not an identity").
6. **#32 G1 set requires junction storage** — if reachable (unconfirmed), blocks `set` on any non-junction variant/polymorphic collection.
7. **#48/#49 G1 physical field / G1 variant carrier membership** — if reachable (unconfirmed), block querying/writing whatever schema shape they guard.
8. **#3 GeoPoint distance capability** — blocks distance filter/order/select on any provider whose adapter doesn't implement a `distance` tier; a JS-fallback tier (deliberately rejected per AGENTS.md) would widen provider coverage, at a cost already argued against once.
9. **#13 Decimal relation key under multiply/divide** — narrow (exact-decimal relation keys only) but a real, named, currently-refused shape.
10. **#16 G1 atomic output requires exact identity scratch or segmented RETURNING** — narrow provider/shape combination, already named as a deliberate boundary ("do not widen… without a ruling").

Notably **absent** from this list: the six `commands.ts`/`execution.ts`
occurrence-tree invariants, the recursive-cluster's sibling program.ts-only
entries, and every switch-`default` this review could confirm is TS- or
validation-exhaustive — none of those block any payload today, so acting on
them widens nothing.

### What I could not determine (stated once, for reference)

- Exact live-adapter combination that satisfies #16's and #30's boolean
  conditions (which real driver hits `!carriesIdentity && (!supportsReturning
  || supportsCteWithMutations)`, and whether same-batch insert-then-delete
  ordering is achievable through public array-batch syntax).
- Whether the schema builder (`s.model()` / variant-carrier declaration) can
  currently produce the shapes #32, #48, #49 guard against — this needs a
  schema-layer investigation this review's budget didn't cover.
- Whether `cacheResultCodec()` (#51) is always called by a caller already
  scoped to `CacheableOperations`, or whether a misconfigured cache extension
  could reach it for a write verb.
- Whether #12's `aggregate` parameter is narrowed to the closed
  `AGGREGATES`/`AGGREGATE_NAMES` type at every call site (didn't trace every
  caller of `aggregateExpression`).
