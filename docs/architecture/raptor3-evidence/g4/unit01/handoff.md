# G4-01 → G4-02 read/projection handoff

**Revision 5** (frozen against the third repaired diff; supersedes r4). The
r5 entry and falsifiers 19–21 were added by the G4-02 phase-2 writer, who holds
the `shared/query.ts` writer role from the phase-1/phase-2 boundary.
Owner: G4-01 author. Consumer: G4-02 (physical/provider envelope), and the
independent witness author for expectations that are contractual rather than
SQL-shaped.

Revision history is at the bottom. A later revision supersedes an earlier one
wherever they disagree; consumers rebase on the newest revision.

---

## 1. The `Query` value contract

`shared/query.ts`:

```ts
export interface Query {
  sql: Sql;                       // parameterized statement, adapter-spelled
  shape: ProjectionShape;         // decoder shape; no SQL is rebuilt to decode
  expectedRows?: { count: number; missing: Error };   // series read-back only
}
```

A `Query` is **one statement plus the shape needed to decode it**. It carries no
alias table, no cursor state and no cardinality: cardinality is the *operation's*
decision (§3), not the statement's. `OperationContext.read(query, internal?)`
executes it and returns `Queries.decodeQuery(query, rows, internal)`.

`internal = true` means *engine-private decode*: decimals stay in their canonical
private text (`decodePhysicalDecimal`) instead of materializing public
`Decimal` values (`materializePhysicalDecimal`). Every other leaf decodes
identically. Use `internal` for captured rows the engine re-plans against; use
public decode for anything published to the caller.

## 2. Read entry

```ts
interface Read { readonly query: Query; result(rows: Input[]): unknown }
Queries.read(model: AnyModel, operation: Operation, args: Arguments): Read
```

One owner builds the statement **and** the cardinality/shape decision for every
read verb. `commands/index.ts` only dispatches and owns the public `OrThrow`
error identity:

```ts
const read = context.queries.read(model, base, args);
const value = read.result(await context.read(read.query));
if (value === null && throwIfNotFound)
  throw new NotFoundError(model["~"].names.ts ?? "unknown", requestedOperation);
return value;
```

`base` is the admitted operation (`findUniqueOrThrow` → `findUnique`,
`findFirstOrThrow` → `findFirst`); `requestedOperation` is the caller's own verb,
which is what the not-found message must name.

### Expected cardinality and public shape per verb

| Verb | SQL window | `result(rows)` |
| --- | --- | --- |
| `findUnique` | selector only; no `LIMIT` is added by cardinality | `rows[0] ?? null` |
| `findFirst` | `LIMIT 1`; a negative `take` flips the total order and still emits `LIMIT 1`; `take: 0` is an empty window | `rows[0] ?? null` |
| `findMany` | `LIMIT abs(take)`, `OFFSET skip`, cursor predicate, distinct | `rows`; a negative `take` reverses the decoded array so the caller sees ascending order |
| `count` (no `select`) | one aggregate row | `number` |
| `count` (`select`) | one aggregate row with `_all` and/or per-field counts | `{ _all?: number, field: number }` |
| `exist` | one aggregate row | `boolean` (`count > 0`) |
| `aggregate` | one aggregate row | `{ _count?, _avg?, _sum?, _min?, _max? }` |
| `groupBy` | grouped rows | `Input[]` — by-fields plus the requested aggregate objects |

`count`, `exist` and `aggregate` apply the same `where` / `orderBy` / `cursor` /
`take` / `skip` window as a find: the window is an inner select and the
aggregate is computed over it whenever a window exists.

**Every read verb is a pure read.** `shared/schema.ts` exports
`isReadOperation(operation)`; `OperationContext.run` uses it instead of naming
verbs, or a read allocates a write transaction. G4-01 made that one-line change
in `operation-context.ts` (plus its import); the G4-02 writer owns the file
afterwards and must keep it. Witness: `read-verbs.test.ts` asserts that a
`count` executes exactly one statement and opens no transaction.

## 3. Prepared selector, order, page, projection

Four prepared descriptions, all alias-free and immutable, each lowered against a
statement-local alias:

| Prepared | Built by | Lowered by | Holds |
| --- | --- | --- | --- |
| `PreparedSelector` | `prepareSelector(model, where)` | `lowerSelector(selector, alias)` | predicate tree + `SelectorFacts` (fields, scalar equalities, exactness, relation reads) |
| order terms | `orderTerms(model, orderBy, alias)` | `order(...)` joins them | `{ expression, descending, nulls?, expressionNulls?, nullable, field? }` — `nulls` is **optional** (undefined = the provider's default); `expressionNulls` marks a placement that belongs to the expression rather than to the caller, which a reversed window must not flip; `field` is set only for a direct scalar key, which is what a cursor may order by |
| page | `page(model, args, alias)` | inlined into the select parts | normalized total order, cursor predicate, limit/offset, distinct columns |
| `PreparedProjection` | `prepareProjection(model, args)` | `lowerProjection(projection, alias)` | fields (scalar / distance / relation / variants / counts) + `ProjectionShape`, whose `collection` shapes record whether the window was reversed |

Rules that do not change: `prepareSelector` never binds an alias; `lowerSelector`
never re-reads public syntax; SQL facts and dependency facts come from the same
traversal (`SelectorFacts.reads` feeds `Commands.analyze`).

### Predicate targets (what replaced the second `having` ladder)

A prepared comparison addresses a **target**, not a column:

```ts
type PreparedTarget =
  | { kind: "column";    scalar: PreparedScalar }
  | { kind: "aggregate"; aggregate: "_count" | "_avg" | "_sum" | "_min" | "_max";
      scalar?: PreparedScalar }
```

`where` prepares column targets; `having` prepares aggregate targets. Both use
the same operator vocabulary and the same operand lowering, so an operator can
never be admitted on one side and silently refused on the other.

### Logical combinators (`AND` / `OR` / `NOT`, in `where` and in `having`)

One owner, `combine(key, arms)`, assembles all three for both readings:

- `NOT` is per-arm negation conjoined (`NOT: [c1, c2]` is `NOT c1 AND NOT c2`);
  the object form is a single arm.
- **An arm that builds no condition is absent.** A prepared conjunction with no
  member states nothing, so it contributes nothing to `AND`, nothing to `NOT`
  and nothing to `OR` — this is the shipped rule, where each builder answers
  `undefined` for such an arm and the parent skips it
  (`builders/where-builder.ts:217-308`, `operations/groupby-having.ts:77-173`).
  Consequences a consumer must not re-derive: `NOT: {}` and `NOT: [{}]` are
  **absent** (they do not exclude every row), while `OR` with no surviving arm
  is the vacuous **FALSE** (`OR: []` and `OR: [{}]` match nothing). The
  disjunction of nothing is the one `PreparedPredicate` of kind `"always"`.

## 4. Operator vocabulary → adapter spelling

Prepared node → adapter call. A provider that lacks a spelling must add it in the
adapter seam, never in the query owner.

| Prepared predicate | Adapter |
| --- | --- |
| `and` / `or` / `not` | `operators.and` / `or` / `not` |
| `isNull` | `operators.isNull`; `{ not: null }` → `operators.isNotNull` |
| `equals` on text | `operators.exactTextEq(column, operand)` |
| `equals` elsewhere | `operators.eq` |
| `in` on text | `operators.exactTextIn`; empty list → `literals.false()` |
| `in` elsewhere | `operators.in(column, literals.list(...))` |
| `notIn` | `operators.notIn(caseSensitiveText(column), list)`; empty list → `literals.true()` |
| `lt/lte/gt/gte` | `operators.lt/lte/gt/gte` |
| `contains` | `operators.containsText` |
| `startsWith` (literal string, sensitive) | `operators.startsWithPrefix(column, value)` |
| `startsWith` (otherwise) | `operators.startsWithText` |
| `endsWith` | `operators.endsWithText` |
| `mode: "insensitive"` | LHS `caseSensitiveText(asciiCaseFold(column))`, operand `asciiCaseFold(...)`; `in`/`notIn` become an OR/AND of folded equalities |
| list `has` | `arrays.has`; `has: null` → `literals.false()` |
| list `hasEvery` | `arrays.hasEvery`; empty → `operators.isNotNull(column)` |
| list `hasSome` | `arrays.hasSome`; empty → `literals.false()` |
| list `isEmpty` | `arrays.isEmpty` (negated for `false`) |
| list `equals` / `not` | `operators.eq` / `neq` against the whole container literal |
| JSON `equals` | `operators.eq(column, json.value(value))` |
| JSON `path` + comparison | `json.extract` / `extractText` / `numberAtPath` / `stringAtPath`, then the ordinary comparison |
| JSON `string_contains` / `string_starts_with` / `string_ends_with` | `operators.containsText` / `startsWithText` / `endsWithText` over `json.stringAtPath` |
| JSON `array_contains` | `json.contains` |
| point `equals` | `geoPoint.equals(column, point)` |
| point `within` (bounds) | `geoPoint.withinBounds` |
| point `within` (polygon) | `geoPoint.withinPolygon` — **full tier only** |
| point `distance` | `geoPoint.distance` — **full tier only** |
| relation `some`/`none`/`every`/`is`/`isNot` | `filters.*` over `subqueries.existsCheck` with `correlation(edge, parentAlias, childAlias)`; `every` negates the inner predicate |

**Capability rule.** `adapter.geoPoint` is absent on a provider with no point
protocol, and `withinPolygon`/`distance` are absent on the bounds-only tier. The
query owner asks the adapter and raises the named refusal; it never emulates a
tier in JavaScript. Same for `adapter.vector` (`l2`, `cosine`).

## 5. Ordering, cursor, distinct

- A scalar order term is `asc` / `desc` / `{ sort, nulls }`. **An unspelled
  `nulls` is not a placement.** The bare direction names the provider's own
  default (SQLite and MySQL sort NULLs first ascending, PostgreSQL last), and
  the candidate emits exactly that, so an unqualified `orderBy` answers what the
  shipped engine answers on every dialect. A placement is emitted
  (`orderBy.nullsFirst` / `nullsLast`) in exactly two cases: the caller spelled
  `nulls`, or the read is **windowed** (`take` or `cursor` present) over direct
  scalar keys — the one read whose cursor predicate has to name the same total
  order the statement emits. The windowed default is `asc` → nulls last,
  `desc` → nulls first, which is the shipped normalization
  (`operations/cursor-order.ts` `defaultNullPlacement` +
  `buildNormalizedOrderBy`). A NOT NULL key never states a placement in either
  case, so an index can still supply the order. A GeoPoint distance term sorts
  its NULLs last in both directions (shipped `sort-order-builder.ts:39,42`); a
  vector distance term takes the bare direction.
- A to-one relation path (`{ author: { name: "asc" } }`, ≤ 8 hops) lowers to a
  correlated scalar subquery over the target, ordered by the leaf term. To-many
  descent is refused by validation and never reaches this owner.
- A collection order term is `{ _count: "asc" | "desc" }` and lowers to a
  correlated `aggregates.count()` subquery over the same membership correlation
  the projection `_count` uses.
- A distance order term is `{ _distance: { to, metric, sort? } }` for a vector
  (`vector.l2` / `vector.cosine`) and the point distance shape for a GeoPoint.
- A distance **projection** (`select: { <point|vector field>: { _distance: {
  to, metric? } } }`) is the same `distanceExpression` owner in its third usage
  (`"select"`), projected as one numeric leaf (`type: "number"`, the single
  numeric spelling this owner uses) named `_distance` — the
  shipped public output key — and the selected column itself is NOT projected.
  Two `_distance` selections in one selection are refused with the shipped
  identity (`Distance select supports only one _distance field per select.`).
  The leaf is nullable only where the shipped parser admits null, i.e. a
  nullable **point** column; a vector distance must be a finite number.
  On a provider without the distance tier the refusal comes from the one owner:
  `point.distance select is not supported. GeoPoint distance is not supported by
  this provider.`
- **The registered distance refusals**, preserved verbatim from the shipped
  engine (`builders/distance-builder.ts:142-188`,
  `builders/geo-point-builder.ts:8-19`) and owned by `distanceExpression` /
  `geoPoint`:
  - a provider with no point tier at all:
    `GeoPoint requires a provider with its physical point tier enabled.`
  - a nullable vector in a `select` distance, refused **before** any capability
    is consulted, so it refuses on every provider:
    `Vector distance select does not support nullable vector field '<field>'.`
  - no pgvector: `vector ordering requires a pgvector-enabled PostgreSQL driver`
    for `orderBy`, `vector distance select requires a pgvector-enabled
    PostgreSQL driver` otherwise. "Otherwise" is `select` in practice: a
    vector filter admits only `equals` (`src/validation/scalars/vector.ts`),
    so the `"filter"` spelling of this owner is unreachable for a vector — the
    shipped ternary has exactly the same unreachable arm.
  - an operand of the wrong length, which admission does not constrain:
    `Vector distance <usage> dimension mismatch for '<field>': expected N
    values, received M.`
- **Cursor** requires a scalar total order. The order is normalized once:
  requested scalar terms, then the model's identity tie-breakers, then the
  cursor's own fields, each appended only if not already ordered. A negative
  `take` reverses the direction of every term, and the placement of every term
  whose placement **the caller** stated; an unspelled placement stays unspelled,
  because flipping the bare direction is already the exact inverse order on
  every dialect. A placement the **expression** owns (`expressionNulls`: today
  only the GeoPoint distance term's `NULLS LAST`) is fixed and survives the
  reversal unchanged, which is what the shipped engine does by reversing only
  the input `sort` (`operations/find-pagination.ts:131-151`) and re-emitting
  `nullsLast(distance, …)` afterwards.
  - When every term is NOT NULL and shares one direction, the predicate is the
    row-value comparison `(a, b) >= (SELECT a, b FROM t WHERE <cursor> LIMIT 1)`
    (`<=` for `desc`) — inclusive, because the general predicate's last OR term
    is the all-equal one.
  - Otherwise it is the null-aware lexicographic `EXISTS` predicate over the same
    derived cursor row.
  - A cursor that matches no row yields an empty window.
- **`distinct`** is passed to `assembleAdapterSelect` as `distinct` +
  `distinctColumnAliases`; the adapter owns `DISTINCT ON` versus the
  `ROW_NUMBER` partition emulation. Distinct is applied **before** take/skip.

## 6. Relation carriers: how they are physically realized

A nested read node is realized as a **correlated JSON carrier**, one scalar
subquery per relation field of the parent projection:

```
(SELECT <json object or json_agg(...)>
   FROM ( <page: SELECT child columns FROM child WHERE correlation AND where
           ORDER BY ... LIMIT ... OFFSET ...> ) AS pageAlias)
```

- to-one: `json.object(...)` of the page's single row (`LIMIT 1`), decoded as an
  object or `null`.
- to-many: `expressions.coalesce(json.agg(object), json.emptyArray())`, decoded
  as a fresh array (empty array, never `null`).
- Nested scalar leaves that are themselves carriers are wrapped with
  `json.document(...)` so a nested carrier survives one JSON encoding.
- Variant slots project one `json.object` whose keys are the variant tags; each
  arm is a carrier of its own. The decoder flattens arms in schema order into
  `{ type, data }` (to-one: the first non-null arm; to-many: every arm's rows).
- `_count` is a carrier of its own: one `json.objectFromColumns` of correlated
  `aggregates.count()` subqueries, decoded into `{ _count: { relation: n } }`.

Adapter capabilities that decide the spelling: `json.object`, `json.agg`,
`json.objectFromColumns`, `json.document`, `json.emptyArray`,
`subqueries.scalar`, `subqueries.correlate`, `subqueries.existsCheck`,
`expressions.coalesce`. A provider without lateral/correlated JSON aggregation
must supply these in its adapter; the query owner emits no per-provider branch.

**Nested pagination is the ordinary page operator inside the parent's
correlation scope** — the same `page()` used at the root, with the correlation
predicate conjoined. There is no second nested-read engine. A negative nested
`take` therefore runs a reversed window exactly as at the root, and the
**prepared shape carries that fact**: `relationShape` marks the `collection`
shape (and each variant arm's collection) `reversed` when `take < 0`, and
`decodeValue`'s collection branch restores the caller's logical order. The root's
own reversal stays in `Queries.read`; the carried one cannot, because a carrier
is decoded per parent.

## 7. What a provider must supply per scalar codec

Read side (filter operand, cursor/order operand, projection decode). "Encode"
is `Queries.fieldValue`; "decode" is `Queries.decodeValue`'s leaf.

| Scalar | Encode (adapter/codec) | Decode (accepted physical forms) |
| --- | --- | --- |
| `string` | `literals.value` | `string` |
| `boolean` | `literals.value` | `boolean`, `0`/`1`, `0n`/`1n` |
| `int` | `literals.value` | `number`, `bigint`, canonical signed-integer text; must be a safe integer |
| `number` | `literals.value` | finite `number`, or finite numeric text |
| `bigint` | `literals.value` | `bigint`, safe-integer `number`, canonical signed-integer text |
| `decimal` | `literals.decimal(canonical, descriptor)`; `expressions.decimalCast` for an expression operand | `result.decimalRepresentation` (`"coefficient"` for the SQLite family, native exact text elsewhere) through `decodePhysicalDecimal` / `materializePhysicalDecimal`; projected through `expressions.cast(column, "text")` |
| `dateTime` | `literals.dateTime(iso, nativeType)` | `result.dateTimeRepresentation(nativeType)`: `"text"` (provider timestamp grammar), `"epochMillis"`, `"julianDay"` through `decodePhysicalDateTime`; `Date` accepted; result is a `Date` |
| `date` | `literals.value` (ISO date text) | ISO `YYYY-MM-DD` text or a UTC-midnight `Date`; result is a `Date` |
| `time` | `literals.value` (ISO time text) | ISO time text, zone suffix stripped, fractional seconds normalized to ≤ ms; result is a string |
| `enum` | `literals.value` | a declared member string |
| `json` | `literals.json` | JSON text or an already-decoded value; JSON-null sentinels distinguish database NULL from JSON `null` |
| `blob` | `literals.value` | `Uint8Array`/`Buffer`, or the provider's hex/base64 text form |
| `vector` | `vector.literal(values)` | JSON array text or an array; the declared dimension must match |
| `point` | `geoPoint.value(longitude, latitude)` | the adapter's point transport (JSON text or object) through `validateGeoPoint`; projected through `geoPoint.longitude` / `latitude` when the storage is opaque |
| any list | `arrays.value` (`arrays.enumValue` for enum lists; decimal lists as canonical members) | `result.decimalListRepresentation` / `enumListRepresentation` decide the container reading; then each member decodes as its element type |

Aggregate leaves are classified once, exactly as the shipped engine classifies
them: `_count` → non-nullable integer; `_avg` of a non-decimal → nullable float;
`_avg` of a decimal → the field's decimal domain (quantized by
`aggregates.decimalAvg`); `_sum` of a decimal → the **widened** decimal domain
(field scale, dropped precision); every other `_sum`/`_min`/`_max` → the field's
own domain, nullable. `bigint` and `decimal` aggregates are cast to text before
they leave the database.

**Malformed provider rows** raise the established identity: the decoder throws
`InvalidScalarResult(scalarType, reason)` and `OperationContext.failure`
translates it into
`QueryEngineError("Driver \"<driver>\" returned a malformed <type> scalar for operation \"<operation>\": <reason>.", { meta: { driver, operation, scalarType } })`.
Carrier-level failures are **not** on that path and G4-02 should not assume they
are: a carrier that is not an object or a collection that is not an array raises
a bare `TypeError("Invalid provider row" / "Invalid provider collection")` that
`OperationContext.failure` does not translate, so it reaches the caller without
driver/operation/scalarType meta (the shipped engine names these through
`result/relation-result-parser.ts` `malformedResult`). A `_count` carrier whose
keys do not match the requested relations degenerates to
`InvalidScalarResult(int, "the value is absent")`, which *is* translated. No
real driver can produce either shape, so none of the three has an executed
witness; they are assertions about an impossible provider, not a contract G4-02
may rely on. **Public containers are
always fresh**: every decoded row, array, carrier and aggregate object is a newly
allocated value; nothing is shared between two results or reused across rows.

## 8. What G4-02 must add

1. **Root `delete` (OP-W03).** Construction plus provider mutation/projection.
   The removed row's projection is the ordinary `prepareProjection` /
   `decodeProjection` pair; `fieldValue` stays the single value-lowering owner
   for its selector operands. Relation actions and error precedence are the
   command owner's, not the query owner's.
2. **Arithmetic.** `Queries.updateValue` remains the *sole* interpreter of
   admitted scalar update operators, for both mutation assignments and symbolic
   updated-key expressions. Add `multiply`/`divide` there through
   `adapter.set.multiply` / `divide` (and `expressions.multiply` / `divide` for
   the symbolic key expression). Do not add a JavaScript arithmetic ladder and do
   not add a second operator owner beside `fieldValue`.
3. **Native recursive lowering.** `Queries.recursive` composes one adapter
   recursive CTE (`cte.recursive`, `setOperations.unionAll`, `arrays.push`,
   `arrays.has`, `json.document`). PostgreSQL/MySQL fit needs the same adapter
   calls to exist with those semantics; no query-owner branch per provider.
4. **Required profiles and fast paths.** Scalar-only fast paths, batch
   preparation and the non-returning readback path consume `Query` unchanged:
   they must not re-prepare a projection to obtain a decoder, and must not
   assemble a SELECT merely to learn a shape.

## 9. Executable examples

All against a SQLite world; `engine = createCommandEngine({ schema, driver })`.

```ts
// 1. findUnique + nested to-many page, per parent
await engine.execute("author", "findUnique", {
  where: { id: 1 },
  include: { posts: { where: { published: true }, orderBy: { rank: "asc" },
                      take: 2, skip: 1, distinct: ["title"] } },
});
// → { id, name, posts: [ … at most 2 … ] }  (posts is a FRESH array)

// 2. findMany, backward cursor window
await engine.execute("post", "findMany", {
  orderBy: { rank: "asc" }, cursor: { id: 7 }, take: -3, skip: 1,
});
// → three rows ENDING before the cursor, returned in ascending order

// 3. count with a selected shape
await engine.execute("post", "count", { select: { _all: true, title: true } });
// → { _all: 6, title: 4 }   (title counts only non-null titles)

// 4. aggregate
await engine.execute("post", "aggregate", {
  where: { published: true }, _count: true, _avg: { rank: true },
  _sum: { rank: true }, _min: { title: true },
});
// → { _count: 4, _avg: { rank: 2.5 }, _sum: { rank: 10 }, _min: { title: "a" } }

// 5. groupBy with having AND/OR/NOT
await engine.execute("post", "groupBy", {
  by: ["authorId"], _count: true, _sum: { rank: true },
  having: { OR: [ { rank: { _sum: { gt: 5 } } },
                  { NOT: { authorId: { equals: 3 } } } ] },
  orderBy: { _count: { authorId: "desc" } }, take: 2,
});

// 6. insensitive string filter
await engine.execute("post", "findMany", {
  where: { title: { contains: "ab", mode: "insensitive" } },
});

// 7. negative nested window — restored per parent, not per statement
await engine.execute("author", "findMany", {
  select: { id: true,
            posts: { orderBy: { rank: "asc" }, take: -2, select: { id: true } } },
});
// → each parent's posts are its LAST two, in ascending rank

// 8. array NOT — NOT c1 AND NOT c2, the same reading `having` gives it
await engine.execute("post", "findMany", {
  where: { NOT: [{ category: "alpha" }, { published: false }] },
});

// 9. whole-value operand — one value, never an operator record
await engine.execute("author", "findMany", {
  where: { avatar: new Uint8Array([1, 2, 250]) },   // also { equals }, { not }
});

// 10. distance projection — the column is not projected, `_distance` is
await engine.execute("place", "findMany", {
  select: { id: true, at: { _distance: { to: { longitude: 0, latitude: 0 } } } },
});
// → [{ id, _distance }] on a distance-tier provider;
//   FeatureNotSupportedError("point", "distance select", …) without one
```

## 10. Falsifiers (a wrong implementation MUST fail these)

1. **Wrong-result specimen — negative take.** `findMany({ orderBy: { rank: "asc" }, take: -2 })`
   over ranks `[1,2,3,4]` must return `[3,4]` in that order. An implementation
   that emits `LIMIT 2` without flipping the order returns `[1,2]`; one that
   flips but forgets to reverse the decoded array returns `[4,3]`. Both must
   fail.
2. **Cursor inclusivity.** `findMany({ cursor: { id: 3 }, orderBy: { id: "asc" }, take: 2 })`
   must include the cursor row (`[3,4]`). `skip: 1` with the same cursor must
   return `[4,5]`.
3. **Distinct before windowing.** With duplicate `category` values, 
   `findMany({ distinct: ["category"], take: 2, orderBy: { id: "asc" } })` must
   return two rows with *different* categories, not the first two rows.
4. **Nested page is per parent.** With two parents each owning three children,
   `include: { children: { take: 1 } }` must return one child **per parent**, not
   one child overall.
5. **`_count` shape.** `select: { _count: { children: { where: { active: true } } } }`
   must return `{ _count: { children: n } }` where `n` counts only active
   children, and must fail if the carrier's keys do not match the request.
6. **Aggregate domains.** `_avg` over an `int` column must be a float
   (`2.5`, not `2`); `_sum` over a `bigint` column must be a `bigint`; `_sum`
   over a `decimal` column must decode in the widened decimal domain.
7. **Having equals where.** Any operator admitted in `where` must produce the
   same predicate semantics in `having` over the aggregate target (`notIn`,
   `not`, nested AND/OR/NOT).
8. **Malformed row identity.** A provider row whose `int` column answers
   `"12.5"` must raise the established
   `Driver "…" returned a malformed int scalar for operation "…"` identity —
   not a generic `TypeError`, and not a silently coerced `12`.
9. **Fresh containers.** Two results of the same query must not share any array
   or object identity, and a to-many carrier with no rows must be `[]`, never
   `null` or a shared empty array.
10. **No write machinery on a read.** A `count` on an interactive driver must
    execute exactly one statement and open no transaction.
11. **Unqualified order placement.** `findMany({ orderBy: { <nullable>: "asc" } })`
    with no `take` and no `cursor` must answer the SAME row order as the shipped
    engine on the same provider. On SQLite that puts NULLs FIRST; an
    implementation that normalizes the placement answers a different order and
    must fail. Adding `take` flips the same query to NULLs LAST, on both
    engines. A to-one relation path over an absent relation is the same rule.
12. **Nested negative take.** `include: { children: { orderBy: { rank: "asc" },
    take: -2 } }` over parents owning ranks `[1,2,3]` must return `[2,3]` per
    parent — an implementation that reverses the window but not the decoded
    carrier returns `[3,2]` and must fail.
13. **Whole-value operands.** `where: { <blob>: new Uint8Array([1,2,250]) }` and
    `{ <blob>: { not: <Uint8Array> } }` must filter by the value. An
    implementation that re-tests the `equals` operand for operator-ness reads
    the array indices as operator names and throws; it must fail.
14. **Array `NOT`.** `where: { NOT: [c1, c2] }` must mean `NOT c1 AND NOT c2`
    (the same reading `having` gives it), not a field named `0`.
15. **Distance projection.** `select: { <point>: { _distance: { to } } }` on a
    provider without the distance tier must raise the named capability refusal,
    never the raw point column.
16. **Empty logical arm.** Over three rows of which one has `bucket: "y"`,
    `where: { NOT: {} }` must return all three and `where: { OR: [{}, { bucket:
    "y" }] }` must return only that one. An implementation that lowers an empty
    arm to TRUE answers `[]` for the first and all three for the second — the
    second silently over-fetches — and must fail. `OR: []` must still match
    nothing.
17. **Reversed distance placement.** `orderBy: { <point>: { _distance: { to,
    sort: "asc" } } }` with `take: -2` must emit `DESC NULLS LAST`. An
    implementation that flips the placement with the direction emits
    `DESC NULLS FIRST`, so `LIMIT 2` selects rows with no location instead of
    the two nearest, and must fail. A placement the caller spelled must still
    flip (`{ sort: "asc", nulls: "first" }` + `take: -2` → `DESC NULLS LAST`).
18. **Vector select on a nullable column.** `select: { <nullable vector>: {
    _distance: { to, metric } } }` must raise `Vector distance select does not
    support nullable vector field '<field>'.` on **every** provider, including
    one with pgvector. An implementation that checks the capability first
    answers a different refusal on a provider without pgvector, and on one with
    it projects a distance the decoder then rejects; it must fail.

19. **Refusal precedence.** When one call violates the cursor contract AND a
    `where` contract — for example
    `{ where: { <decimal(10,2)>: { equals: fields.<decimal(12,4)> } },
    orderBy: { <collection>: { _count: "asc" } }, cursor: { id: 1 }, take: 2 }` —
    the caller must see the CURSOR refusal, verbatim:
    `Cursor pagination supports direct scalar sort directions only; relation and
    vector-distance orderBy are not supported.` The shipped engine pages before
    it selects and selects before it builds the `where`
    (`operations/find-common.ts` `buildFind`), so an implementation that prepares
    the projection or the selector first answers a different — also true —
    sentence for the same admitted input, and must fail. The same order holds for
    a projection refusal (`Distance select supports only one _distance field per
    select.`), which outranks a `where` refusal and is outranked by the cursor's.
20. **JSON sentinel with a path.** A JSON-null sentinel used together with
    `path` is refused with the shipped template, which names both the FIELD and
    the sentinel kind, for all three kinds (`DbNull`, `JsonNull`, `AnyNull`). A
    refusal that names neither must fail; and the whole-column sentinel forms
    (no `path`) must still answer rows — `DbNull` the database-NULL row,
    `JsonNull` the JSON-null row, `AnyNull` both.
21. **Decimal field-reference domains.** `where: { <decimal(p1,s1)>: { equals:
    fields.<decimal(p2,s2)> } }` with `(p1,s1) ≠ (p2,s2)` must raise the shipped
    sentence naming both columns and both declared domains, under `equals` and
    under `lt`/`lte`/`gt`/`gte`, and in the order the filter asked them. Two
    exact decimals of the SAME domain, and two non-decimal columns, must not be
    refused: an implementation that silently answers `[]` for the mismatch — as
    this owner did before r5 — returns a wrong answer, not a refusal, and must
    fail.

---

## 11. What a G4-02 reader must know that r1 did not say

1. **`omit` never reaches the engine.** Admission desugars it into `select`
   (`withOmitProjection`), and an `omit` with an explicit `select` leaves BOTH
   `select` and `include` populated. `prepareProjection` therefore merges
   `{ ...(args.select ?? defaults), ...args.include }`; reading only `select`
   silently drops an include.
2. **`_count` never reaches the engine as `true`.** Admission desugars both the
   shorthand and the object form into `{ select: { <relation>: true | { where } } }`.
   `prepareCounts` reads `selection.select` and nothing else.
3. **`count` / `exist` / `aggregate` always read from an inner window
   subquery**, even with no `take`/`skip`/`cursor`, exactly as the shipped
   `buildAggregateInputWindow` does. The inner select projects the columns the
   aggregates need, aliased by their PHYSICAL column names; the outer select
   aggregates over that alias.
4. **`exist` is `count > 0`** over the same window; it publishes no row shape.
5. **A whole value is not an operator record.** `Queries.updateValue` now tests
   `Object.hasOwn(value, "increment" | "set")` and treats a non-plain object
   (`Uint8Array`, `Decimal`, `Date`, `GeoPoint`) as one whole value.
   **`commands/assignments.ts:28` still reads `"set" in value`** and therefore
   binds `Uint8Array.prototype.set` as a blob column's value. That file belongs
   to the G3-01/02 writer; the requested one-line change is in this unit's
   `note.md` §8. Until it lands, blob/Decimal/Date values cannot be written
   through `create`/`update`.
6. **`OperationContext.run` now classifies reads** with
   `isReadOperation(this.operation)` from `shared/schema.ts` instead of naming
   three verbs. **G4-02 owns `operation-context.ts` after this handoff and must
   keep that line**: without it `count`, `exist`, `aggregate` and `findFirst`
   open a write transaction on an interactive driver.
7. **Carrier transport casts.** Inside a JSON carrier a `bigint` is cast to
   text, a `blob` goes through `blobToHex`, and a value that is already JSON (a
   list, a `json` column, a `point`, a `vector`) is wrapped in `json.document`
   so it survives one JSON encoding instead of arriving as a quoted string.
8. **Two deliberate omissions**, both recorded as unverified in `note.md` §8:
   the GeoPoint distance filter emits no indexable `withinBounds` pre-filter,
   and a decimal `having { _sum: … }` operand binds in the field's domain rather
   than the widened `_sum` domain. Both are provider-envelope refinements, not
   semantic choices; if G4-02 adds either, it belongs in the same owner
   (`lowerOperation` / `fieldValue`), not in a new one.
9. **Refusal identities in this owner.** A cursor over a non-scalar order and an
   unimplemented operator raise `QueryEngineError`; a missing provider tier
   raises `FeatureNotSupportedError("point" | "vector", usage, …)`; a malformed
   provider value raises `InvalidScalarResult`, which
   `OperationContext.failure` translates into the established `QueryEngineError`
   identity. Do not add a second translation.

## Revisions

- **r1** — frozen design before the implementation diff.
- **r2** — frozen against the implemented diff (34 author checks green on
  SQLite; `production.patch`). Sections 1–10 corrected where the implementation
  settled a detail r1 left open; section 11 added.
- **r3** — frozen against the repaired diff after the independent review
  returned REVISE. Corrected, in order of how badly r2 misled a consumer:
  §5 null placement (r2 stated a normalized default as settled fact; the
  implementation now emits the provider's own default for an unspelled `nulls`
  and normalizes only a windowed read, which is shipped parity), §5 distance
  projection (r2 claimed a projected distance that did not exist; it exists
  now), §6 nested negative `take` (r2 claimed a restoration that did not
  happen; the prepared shape carries it now), §7 carrier-level failures (r2
  claimed a translated identity that only the `_count` case reaches).
  Falsifiers 11–15 added. The `PreparedProjectionField` union lost its
  producerless `"aggregate"` member and gained `"distance"`.
- **r4** — frozen against the second repaired diff after the review follow-up
  returned REVISE. Three contract statements changed, none of them a public
  API change: §3 gains the logical-combinator rule (an arm that builds no
  condition is absent; the disjunction of nothing is FALSE) and names
  `combine` as its one owner; §5's reversal rule is corrected — r3 said a
  negative `take` reverses "the placement of every term that states one",
  which was wrong for the GeoPoint distance term, whose placement belongs to
  the expression and is now marked `expressionNulls` and left alone; §5 lists
  the four registered distance refusals verbatim, one of which (the nullable
  vector `select`) did not exist in r3. Falsifiers 16–18 added.
- **r5** — frozen against the third repaired diff after the review's second
  follow-up returned REVISE, and **updated by the G4-02 phase-2 writer** (note M
  of `g4/unit01-review-followup-3.md`, which observed that the r5 refusals lived
  only in that unit's `note.md` and `repair3.test.ts`). Three registered refusals
  were restored or corrected, none of them a public API change: the cursor
  sentence is the shipped one verbatim (`relation and vector-distance`, not
  `relation and distance`); the JSON sentinel-with-path refusal uses the shipped
  template, naming the field and the sentinel kind; and a field reference between
  two exact decimals of DIFFERENT declared domains is refused with the shipped
  sentence instead of silently answering `[]` (`prepareOperand`, whose rule is
  owned by `sameDecimalDescriptor` and whose local state reading is
  `exactDecimalDomain` — the candidate may not import the shipped builders).
  Falsifiers 19–21 record them. Falsifier 19 also records the owner-SEQUENCE fact
  the third review raised as finding K and the integrator delegated to G4-02
  phase 2: the shipped engine pages, then selects, then builds the `where`, and
  the candidate's `select()` now does the same, so the refusal a caller sees for
  an input that violates two contracts is the shipped one.
