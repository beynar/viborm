# Exact Fixed Decimal Plan

**Date:** 2026-08-17

**Status:** Working V1 direction. The public contract and physical
representations are settled; provider-specific migration mechanics are
intentionally not decision-complete yet.

**Starting branch:** `by-relation-bearing-bulk`

**Starting commit:** `2b1cb0d0`

**Scope:** This document owns the fixed-decimal public domain, scalar and list
storage, exact query behavior, site 24, and schema evolution. It is independent
from the mutation/transaction work in
[Five Refusal-Site Lifts](five-capability-lift-plan.md).

## 1. Outcome

Define one exact fixed-decimal capability across every shipped provider:

1. a declared fixed decimal has one public string domain with explicit
   precision, scale, and half-even rounding;
2. SQLite scalar fields store and calculate an exact scaled integer rather than
   using `REAL` or NUMERIC affinity;
3. fixed-decimal lists are part of V1 and support the complete existing scalar-
   list surface;
4. ordering, filtering, aggregates, and scalar arithmetic are exact or receive
   one precise pre-I/O boundary;
5. schema changes are intended to convert automatically when the conversion is
   exact and fail loudly when a value cannot fit; and
6. site 24 stops blanket-refusing fixed scalar fields on SQLite.

VibORM is unreleased. This plan therefore defines the only V1 representation.
It does not ship dual readers, legacy snapshot compatibility, deprecation
periods, or manual old-format choreography. Existing development snapshots and
fixtures move directly to the final representation.

That does not make manual shadow-column choreography part of the product. A
future change from unconstrained to fixed decimal, fixed to unconstrained, or
one fixed descriptor to another is intended to use an exact, automatic
lossless-or-error migration. The precise PostgreSQL, MySQL, PlanetScale, and D1
protocols remain implementation work, not a compatibility requirement for the
unreleased storage format.

Unconstrained `s.decimal()` remains a distinct exact domain. On SQLite it uses
canonical text and still refuses numeric ordering and arithmetic. Fixed decimal
is opt-in because finite range and fractional scale are real semantics, not a
storage optimization.

### 1.1 Settled now; deferred on purpose

Settled for V1:

- SQLite fixed scalars use scaled integers, never floating point;
- fixed-decimal arrays ship in V1 on every applicable provider;
- both array modifier orders describe the same public domain;
- typed values and results remain canonical decimal strings; and
- there is no legacy snapshot reader, dual storage format, or user-authored
  compatibility migration.

Deferred until implementation reaches the relevant provider boundary:

- the exact PostgreSQL/MySQL descriptor-change SQL and interruption semantics;
- D1 foreign-key-safe table reconstruction;
- the adapter metadata proof for MySQL/PlanetScale fixed arrays; and
- final normalization of nullable-list containment edge cases.

Those deferred mechanics do not remove arrays from V1, permit floating-point
storage, or reintroduce backward-compatibility machinery.

## 2. Domain and public API

The canonical terms live in [CONTEXT.md](../../CONTEXT.md):

- a **fixed decimal** is an exact decimal domain with declared precision,
  scale, and rounding;
- an **unscaled decimal value** is its signed integer coefficient,
  `logical value × 10^scale`;
- a **fixed decimal list** is an ordered list whose non-null elements all share
  one fixed descriptor.

The scalar spelling is:

~~~ts
const amount = s.decimal().fixed({
  precision: 10,
  scale: 5,
  rounding: "halfEven",
});
~~~

The list spellings are equivalent:

~~~ts
const a = s.decimal().fixed({
  precision: 20,
  scale: 4,
  rounding: "halfEven",
}).array();

const b = s.decimal().array().fixed({
  precision: 20,
  scale: 4,
  rounding: "halfEven",
});
~~~

### 2.1 Descriptor rules

- `precision` is a positive integer.
- `scale` is an integer in `0..precision`.
- V1 requires `rounding: "halfEven"`; there is no provider-default rounding.
- Scalar provider limits are checked when the schema is bound:
  - PostgreSQL: `precision <= 1000` under VibORM's `scale <= precision` rule;
  - MySQL/PlanetScale: `precision <= 65`, `scale <= 30`; multiply/divide also
    require `precision + scale <= 65`;
  - SQLite family: `precision <= 18` and `precision + scale <= 18` for the full
    scalar arithmetic contract.
- Lists perform no decimal arithmetic. Their portable V1 descriptor limit is
  PostgreSQL's `precision <= 1000`; JSON backends store coefficient digits and
  do not inherit SQLite int64 or MySQL scalar DECIMAL limits.

### 2.2 Values and nulls

- Scalar input remains `string | number`; trusted/public output is a canonical
  decimal string.
- List input is `(string | number)[]`; trusted/public output is `string[]`.
- A number names only the binary number the caller already supplied. VibORM
  canonicalizes that value but never pretends to recover lost precision.
- Non-zero fractional digits beyond `scale`, or more than `precision` unscaled
  digits, fail validation. Insignificant trailing zeros are accepted.
- `.nullable()` makes the scalar or the whole list nullable. List elements are
  never nullable in V1.
- The half-even rule applies when scalar multiply, divide, or average creates
  extra fractional digits. List V1 has no operation that rounds an element.

### 2.3 Modifier and escape-hatch rules

`DecimalScalar` carries the immutable descriptor through `.nullable()`,
`.array()`, `.default()`, `.map()`, and `.schema()`. Both modifier orders above
produce the same runtime validator and public type. A custom schema runs on the
logical canonical value, then the fixed invariant validates its output last.

Fixed decimal cannot combine with a native-type override. The descriptor owns
validation, DDL, transport, and arithmetic; a native type string cannot replace
those semantics. The legacy client option that decodes decimals as JavaScript
numbers is also incompatible with every fixed scalar or list and refuses at
client/schema construction.

Fixed lists are values, not identities. V1 refuses them as direct or compound
IDs/uniques, portable indexes, local or referenced FK members, and polymorphic
identity members. Provider-specific raw indexes remain an explicit migration
escape, not a portable schema promise.

## 3. Why SQLite `DECIMAL(10,5)` is not exact decimal storage

SQLite does not enforce precision or scale from a declared decimal type.
`DECIMAL(10,5)` has NUMERIC affinity, which converts decimal-looking text to an
INTEGER or binary64 `REAL` whenever SQLite considers the conversion numeric.

The relevant local probe is:

~~~sql
CREATE TABLE d(a DECIMAL(10,5), b DECIMAL(10,5), t TEXT);
INSERT INTO d VALUES('0.1', '0.2', '0.1');
SELECT typeof(a), typeof(a + b), quote(a + b), (a + b) = 0.3,
       typeof(t), quote(t)
FROM d;
~~~

Observed with the workspace SQLite CLI:

~~~text
real|real|3.000000000000000445e-01|0|text|'0.1'
~~~

Both inputs fit `(10,5)`, yet arithmetic used binary64 and exact equality with
`0.3` failed. The TEXT value retained its exact spelling.

Official evidence:

- [SQLite type affinity](https://www.sqlite.org/datatype3.html) classifies
  `DECIMAL(10,5)` as NUMERIC and ignores the numeric arguments in type names.
- [SQLite floating-point behavior](https://www.sqlite.org/floatingpoint.html)
  documents binary64 approximation and the optional text-based decimal
  extension.
- [SQLite STRICT tables](https://www.sqlite.org/stricttables.html) do not admit
  `DECIMAL` as a strict type name.

**Decision:** unconstrained decimal stays canonical TEXT. A fixed scalar uses a
scaled INTEGER. A fixed list uses an exact list container described below.
Neither path uses `DECIMAL(...)`, NUMERIC affinity, `REAL`, or Float plus
Decimal.js repair.

Decimal.js remains an optional application tool for constructing or explicitly
quantizing input. It is not an engine dependency and cannot repair a value the
database already rounded.

## 4. Scalar storage and transport

For scale `s`:

~~~text
coefficient = exact logical decimal × 10^s
~~~

| Provider family | Scalar storage | Complete scalar limit |
|---|---|---|
| PostgreSQL | `NUMERIC(p,s)` | `p <= 1000` |
| MySQL / PlanetScale | `DECIMAL(p,s)` | `p <= 65`, `s <= 30`; multiply/divide also need `p + s <= 65` |
| SQLite family | scaled signed `INTEGER` | `p <= 18` and `p + s <= 18` |

The one field codec owns logical-string to coefficient conversion and the
reverse. It uses decimal digits and `bigint`, never JavaScript multiplication or
division on a `number`.

SQLite-family typed binds use one driver-independent route: canonical integer
TEXT plus `CAST(? AS INTEGER)`. Reads, projections, RETURNING, generated
outputs, relation keys, and aggregates cast coefficients to TEXT before a
driver can turn an int64 into a JavaScript number. This works on SQLite3, Bun
SQLite, libSQL, and D1 without a driver-name branch or BigInt binding.

A deterministic SQLite owned constraint records the fixed descriptor and
requires `typeof(column) = 'integer'` plus the coefficient range, allowing NULL
only for a nullable field. If an expression would promote to REAL or exceed the
domain, the write fails rather than storing an approximation.

PostgreSQL and MySQL bind canonical logical strings into their declared native
exact type. Their result paths still return canonical strings; a driver may not
replace the public contract with a number.

Raw SQL is physical. SQLite raw reads/writes see an unscaled integer;
PostgreSQL/MySQL see native decimal. Raw access does not receive model
rescaling. A SQLite raw read above JavaScript's safe integer range must cast the
coefficient to TEXT, and a raw write must bind exact coefficient digits.

## 5. Fixed-decimal lists in V1

### 5.1 Physical representation

| Provider family | Fixed-list storage |
|---|---|
| PostgreSQL | native `NUMERIC(p,s)[]` |
| MySQL / PlanetScale | JSON array of canonical coefficient strings |
| SQLite family | TEXT containing a canonical JSON array of coefficient strings |

At scale 2, public `['1.2', '-0.03']` is physically
`['120', '-3']` on JSON-backed providers. JSON numbers are forbidden: D1 and
JavaScript JSON parsing would round an integer token above `2^53`. PostgreSQL
binds canonical logical strings into the typed numeric array and stringifies
each exact element before any JSON/nested-result construction. It never exposes
`to_json(numeric[])` numeric tokens or parses PostgreSQL array text as a whole.

The SQLite column constraint records the descriptor and verifies TEXT,
`json_valid`, and a top-level array. SQLite CHECK cannot use the `json_each`
subquery needed to validate every member. Typed writes and reads therefore own
member grammar/range. An invalid raw JSON write is an explicit physical escape
and the next typed read fails loudly; the plan does not claim database-level
member enforcement without introducing triggers.

### 5.2 One field-aware list codec

Add one field-aware whole-list binder and one element binder ahead of the
generic array branch in `values-builder.ts`. They resolve the fixed descriptor,
validate every logical element, and delegate the provider's physical list
spelling to the adapter.

Every path uses them:

- create, createMany, upsert, set, default, and whole-list equality;
- `has`, `hasEvery`, and `hasSome` candidates;
- push/unshift of one, many, or zero elements; and
- RETURNING, direct reads, nested relation JSON, and bulk-return result parsing.

Refactor adapter push/unshift to consume the already-built physical list
fragment instead of raw `unknown[]`. Otherwise those operations bypass the
field descriptor.

This is not optional cleanup. Current generic decimal-list writes serialize
logical decimal strings, while the scalar `has` path lowers through a decimal
number candidate on MySQL. Those different JSON kinds cannot match. One field-
aware codec removes that second representation truth.

JSON-backed reads accept only a dense array of canonical signed coefficient
strings (`0` or `-?[1-9]\d*`) within precision. JSON numbers, `+1`, `01`, `-0`,
NULL elements, sparse/wrong top-level values, malformed JSON, and overflow are
malformed provider data. The fixed-list result parser rescales each coefficient
before the generic decimal parser; treating physical `'120'` as logical `'120'`
would be wrong at scale 2.

### 5.3 Public list behavior

V1 supports the existing decimal-list surface:

- equality, nested/shorthand `not`, `has`, `hasEvery`, `hasSome`, and `isEmpty`;
- set/shorthand whole-list assignment; and
- push/unshift of one or many values, including the existing empty no-op and
  nullable-list coalescing behavior.

Whole-list equality preserves order and multiplicity. Containment preserves
set-membership semantics. The exact cross-provider NULL and empty-candidate
truth is an intentionally deferred API detail; it must be decided once at the
operation-schema/adapter boundary before implementation, not inherited
accidentally from provider behavior. `distinct` and
`groupBy({ by: [...] })` may use fixed lists only as canonical whole values.
`_count.field` counts non-null list columns, not elements.

V1 does not invent numeric list semantics. List `lt/lte/gt/gte`, whole-list
`orderBy`/cursor identity, `_min/_max/_sum/_avg`, aggregate ordering/HAVING on
those aggregates, and increment/decrement/multiply/divide are absent from both
the public and runtime operation schemas. The current aggregate/order builders
must exclude list states rather than sorting JSON or admitting `_sum` by scalar
kind alone.

Raw SQL sees PostgreSQL numeric arrays or JSON coefficient strings. A raw JSON
write must use canonical minified coefficient-string JSON. Typed reads remain
fail-closed if raw data violates the descriptor.

## 6. Exact scalar queries, aggregates, and arithmetic

Site 24 becomes field-representation-aware. SQLite's adapter-wide
`supportsExactDecimal` remains false; an operation is admitted only when the
addressed field is fixed and the adapter owns the exact lowering.

### 6.1 Validation roles

The fixed codec exposes distinct schemas:

- a nullable-aware value schema for create/set/equality;
- a non-null literal schema and list form for ordered/IN operands;
- a non-null scalar arithmetic operand schema, with division rejecting
  canonical zero before I/O; and
- field- and operator-aware aggregate HAVING schemas.

For `_min`, `_max`, and `_avg`, HAVING equals/not accepts NULL or an exact fixed
literal; ordered/list operands are non-null. `_sum` uses the same operator split
with a scale-constrained, precision-widened literal whose coefficient fits the
provider aggregate domain. `_count` remains numeric.

Field references are accepted only between resolved fields with the same fixed
descriptor. The where-builder checks both scalar states because the current
FieldRef payload carries only the scalar kind. Generic `Sql` has no scale
descriptor, so V1 refuses it in a typed fixed predicate. Arithmetic operands
remain literals; this plan does not invent assignment field-reference or Sql
semantics.

### 6.2 Exact surface

- equality, inequality, IN, uniqueness, and relation keys compare exact stored
  coefficients;
- `lt/lte/gt/gte`, orderBy, cursors, min, and max use exact numeric order;
- increment/decrement use exact scaled integer or native decimal add/subtract;
- SQLite sum uses integer SUM, surfaces integer overflow, transports the wider
  coefficient as TEXT, and uses a scale-aware aggregate decoder rather than the
  field precision validator;
- average uses exact SUM/COUNT(column), preserves NULL for empty/all-null
  groups, and rounds half-even through quotient/remainder; and
- direct average, group projection, HAVING average, and aggregate order reuse
  the same field-aware expression.

### 6.3 Guarded half-even multiply and divide

For SQLite coefficient `x`, operand coefficient `y`, `F = 10^scale`, and
`M = 10^precision - 1`:

- multiply computes half-even `round((x * y) / F)`;
- divide computes half-even `round((x * F) / y)`.

The `precision + scale <= 18` rule keeps `M * F` and `x * F` inside signed
int64. Multiplication still guards the raw product:

~~~text
B = scale === 0 ? M : M * F + F / 2 - 1
safe = y === 0 || abs(x) <= floor(B / abs(y))
~~~

A lazy CASE evaluates `x * y` only in the safe arm. The rejecting arm writes
the int64-safe out-of-domain sentinel `M + 1`, which the target range constraint
rejects. Every expression begins `WHEN x IS NULL THEN NULL`; the validated
operand cannot turn a stored NULL into a failure sentinel.

Rounding uses integer quotient/remainder. SQLite compares
`2 * abs(remainder)` to `abs(divisor)`; its descriptor bound keeps the doubled
remainder in range. Average compares against `floor(count / 2)` plus parity so
it never doubles a theoretical int64 count.

PostgreSQL and MySQL implement the same explicit coefficient-space half-even
rule rather than inheriting provider ROUND behavior. MySQL:

- extracts coefficients from canonical DECIMAL text instead of multiplying by
  `F` when that could exceed expression precision;
- uses the same lazy B-bound guard before `x * y`;
- never doubles a potentially 65-digit remainder; it compares divisor-half and
  parity instead; and
- requires verified strict SQL mode so overflow errors instead of warning and
  truncating.

No exact scalar path uses REAL, `total()`, JavaScript arithmetic, provider-
default rounding, Decimal.js repair, an extra read, or a progressive write.

## 7. Schema-evolution direction without legacy machinery

This section records the intended lossless-or-error architecture. It is not a
claim that every provider-specific conversion and atomicity protocol below is
already settled. SQLite has the most concrete existing owner; PostgreSQL,
MySQL/PlanetScale, and D1 require implementation-time proof before this section
becomes an execution specification.

### 7.1 One physical descriptor

Extend `ColumnDef` with the decimal representation metadata required by the
active dialect. SQLite owns this complete V1 union:

~~~ts
type SQLiteDecimalStorage =
  | { kind: "text" }
  | { kind: "scaledInteger"; precision: number; scale: number }
  | { kind: "textArray" }
  | { kind: "scaledIntegerArray"; precision: number; scale: number };
~~~

There is no legacy snapshot form or compatibility reader. Serializer, differ,
DDL, introspection, defaults, and table recreation all consume this descriptor.
The differ compares it even when the SQL type remains INTEGER→INTEGER or
TEXT→TEXT.

PostgreSQL introspection uses `pg_catalog.format_type(atttypid, atttypmod)` so
`NUMERIC(p,s)[]` retains its element typmod; `information_schema.data_type =
'ARRAY'` alone loses it. MySQL scalar p/s comes from DECIMAL metadata.
`COLUMN_COMMENT` is the current candidate for a fixed-JSON-list marker, but
hosted PlanetScale preservation must be proven before that representation is
accepted. This revision does not choose an unproven fallback metadata system.

SQLite serialization emits deterministic VibORM-owned constraint metadata and
introspection recognizes only the exact reserved name/body pair from
`sqlite_schema.sql`. Scalar fixed constraints enforce integer/range. List
constraints enforce TEXT plus valid top-level JSON; they do not falsely claim
per-element validation.

Defaults use the same codec as runtime writes. Existing list defaults remain
application defaults; this plan does not add a new database-array-default
contract.

### 7.2 SQLite decode-to-logical-to-encode migration direction

`SQLite3MigrationDriver.generateTableRecreation` is the existing owner. Extend
its copy map from `{ source, target }` to `{ source, target, selectExpression }`.
For a decimal representation change, one driver-owned expression performs:

~~~text
source physical storage
  → canonical logical decimal text
  → target physical storage
~~~

It uses string operations and guarded integer casts only. It never uses REAL,
NUMERIC affinity, `+ 0`, floating SQL, or a JavaScript number.

- Text decodes through the canonical decimal grammar.
- A fixed scalar decodes with `CAST(coefficient AS TEXT)`, sign handling,
  zero-padding, decimal-point placement, and trailing-zero removal.
- A target fixed scalar validates digit count and scale before guarded
  `CAST(... AS INTEGER)`.
- A list walks `json_each`, applies the same element codec, preserves `key`
  order and duplicates, then rebuilds with `json_group_array` of strings.

Do not add a separate fit preflight. The copy expression and target constraint
are the single guard. Scalar failure can use a constraint-breaking value. List
conversion needs a whole-column validity branch because a malformed member
inside an otherwise valid JSON array would not violate the top-level CHECK.
The exact SQL shape is deferred to implementation, but it must fail the
transaction rather than produce a partially converted value.

The intended automatic rules are:

| Change | V1 behavior |
|---|---|
| Unconstrained → fixed | Convert automatically when every value fits target precision/scale |
| Fixed → unconstrained | Convert automatically and exactly |
| Scale increase | Convert automatically when the target precision fits |
| Scale decrease | Convert only when no non-zero fractional digit is discarded |
| Precision widening | Convert automatically |
| Precision narrowing | Convert automatically when every value fits |
| Fixed/unfixed list or list descriptor change | Apply the same rule to every ordered element |
| Malformed storage, excess scale, or overflow | Atomic migration data error; schema and data unchanged |

Scale changes pass through canonical logical text. They do not multiply or
divide a possibly overflowing coefficient.

The destructive-operation classifier treats a checked decimal conversion as a
normal exact transformation, not as a destructive-resolution prompt. Nullable
narrowing remains the existing destructive decision. Generated down migrations
swap source and target and use the same reverse codec; they can correctly fail
if newer data no longer fits the old descriptor.

LibSQL delegates every decimal representation transition to the SQLite rebuild
path. Its native ALTER route neither transforms nor validates the old rows.

### 7.3 D1 table-recreation prerequisite

Fresh D1 schemas and ordinary fixed scalar/list operations do not need a table
rebuild and are part of V1. A representation change on a relation-bearing D1
table exposes a broader existing migration defect: D1 runs migrations in an
implicit transaction, so `foreign_keys=OFF` cannot be lifted outside it;
`defer_foreign_keys` delays checks but does not suppress CASCADE, and SQLite
RESTRICT remains immediate.

The decimal codec cannot solve that substrate problem. Before claiming D1
schema-evolution completion, land a D1 FK-safe table-reconstruction package
with real remote evidence for populated NO ACTION, CASCADE, SET NULL, RESTRICT,
cyclic, self, mapped, compound, and inbound/outbound FK graphs. Until that
package passes, a D1 decimal representation change that requires table
recreation refuses before effects with this exact substrate reason. It never
falls back to manual copy or runs the known unsafe DROP-table sequence.

Cloudflare documents D1's implicit-transaction and deferral behavior in
[D1 foreign keys](https://developers.cloudflare.com/d1/sql-api/foreign-keys/)
and [D1 PRAGMA statements](https://developers.cloudflare.com/d1/sql-api/sql-statements/#pragma-defer_foreign_keys-onoff).

## 8. Mandatory falsifiers

### 8.1 Public domain and validation

- Both `.fixed(...).array()` and `.array().fixed(...)` have identical public
  types, runtime validation, descriptor, DDL, and result.
- Scalar/list minimum, maximum, negative, zero, scale-zero, trailing-zero, and
  values beyond JavaScript safe integer round-trip as canonical strings.
- Nullable whole lists work; NULL elements fail.
- A custom schema cannot escape fixed validation.
- Native override, number-decoding client, invalid descriptor, incompatible
  field reference, generic typed Sql, and list identity/relation/index use fail
  before I/O.

### 8.2 Scalar exactness

- Numeric order differs from lexical order and stays correct in direct,
  relation, cursor, group, HAVING, and aggregate-order paths.
- Ordered/IN literals reject excess scale. HAVING exact strings above `2^53`
  work; widened SUM thresholds may exceed field precision but not scale or the
  provider aggregate domain.
- SUM wider than field precision decodes. AVG uses COUNT(column), not COUNT(*),
  and empty/all-null groups remain NULL. `having._avg.equals: null` and
  `having._sum.equals: null` work.
- Increment/decrement and positive/negative half-even multiply/divide match
  PostgreSQL/MySQL. Pin B and B+1, int64-naive-product overflow, divide-by-zero,
  rounded carry, NULL storage, and strict-MySQL failure.
- Every successful/rejecting scalar arithmetic path remains one statement in
  interactive and capability-false atomic-batch modes.

### 8.3 List exactness

- Coefficients above `2^53` and 65 digits cross PostgreSQL arrays,
  mysql2/PlanetScale JSON, SQLite3, Bun SQLite, libSQL, and D1 without any JSON
  numeric token or JavaScript-number intermediate.
- At scale 2, public `'1.2'` is physical `'120'`; `has: '1.2'` matches while
  `has: '120'` names logical 120 and does not. This catches a forgotten element
  codec.
- Equality order/multiplicity, nested not, has, duplicate hasEvery, hasSome,
  empty candidates, NULL columns, isEmpty, set, one/many/empty push/unshift, and
  push on NULL have exact provider parity.
- Direct reads, RETURNING, createMany-and-return, nested relation JSON, and
  bulk results rescale every element.
- `_count` works. Numeric aggregates, whole-list order/cursor, and arithmetic
  are absent/refused at their schema owner.
- Hostile physical JSON—number token, logical decimal instead of coefficient,
  leading zero/sign, NULL element, overflow, scalar/object, sparse/malformed
  value—fails loudly.
- Raw controls observe each documented physical form while model reads return
  canonical strings.

### 8.4 Migration and introspection

- Fresh scalar/list DDL, owned metadata, defaults, and second-push idempotence
  are pinned on PostgreSQL, MySQL, SQLite, and libSQL.
- PostgreSQL array element typmod and MySQL list marker round-trip; hosted
  PlanetScale proves marker persistence.
- Every row in the conversion table above has a successful exact case and a
  failing case with unchanged schema/data. Arrays preserve order/duplicates.
- Down migration uses the reverse codec and fails safely when data no longer
  fits.
- LibSQL cannot select its native ALTER route for a decimal representation
  change.
- Real D1 proves fresh fixed scalar/list behavior. Relation-bearing rebuild
  cases stay exact refusals until the FK-safe reconstruction prerequisite is
  independently green; a workerd-only empty-table test is not sufficient.

## 9. Provider and final gates

Required evidence:

| Surface | Providers |
|---|---|
| Scalar/list validation and public typing | core type and validation layers |
| SQLite exact scalar storage/arithmetic | SQLite3, Bun SQLite, libSQL, D1/workerd |
| Fixed-list transport/filter/update/result | PostgreSQL/PGlite, MySQL/mysql2/PlanetScale, every SQLite family driver |
| Native exact parity | Docker PostgreSQL and MySQL |
| Migration codec | SQLite3, Bun SQLite, libSQL; D1 after its FK prerequisite |
| Metadata/introspection | PostgreSQL, MySQL/PlanetScale, SQLite/libSQL |

Run the narrow scalar, validation, adapter, query-engine, result-parser, and
migration suites first. Then run `pnpm test:types`, the applicable provider
aggregate, live Docker PostgreSQL/MySQL, hosted PlanetScale/D1 legs, focused
Biome, and `git diff --check`. Passed, skipped, unavailable, and untested
provider legs remain distinct.

## 10. Implementation exit criteria

This working plan is not design-complete. The capability is complete only when:

1. fixed scalar and list values have one public canonical-string domain and one
   field-aware codec;
2. both fixed-list modifier orders and every existing list operation work in
   V1 across applicable providers;
3. no typed fixed operand, coefficient, array element, aggregate, or result
   crosses REAL or JavaScript `number`;
4. every admitted scalar order/aggregate/arithmetic spelling is exact and every
   retained boundary is absent at the operation schema or has one precise
   pre-I/O owner;
5. each provider's exact schema transformations and failure/atomicity contract
   are proven, use one guarded conversion owner, and never require
   user-authored shadow-column choreography;
6. fresh D1 support is green and relation-bearing D1 reconstruction is proven
   safe before it is admitted;
7. unconstrained decimal keeps its exact canonical-text contract; and
8. site 24 no longer blanket-refuses fixed scalar fields.

Likely owners: decimal scalar state and validators, field-aware value/list
binders, scalar and list result parsing, decimal portability, aggregate and
set builders, PostgreSQL/MySQL/SQLite adapters, schema legality, migration
snapshot/serializer/differ/introspection/table recreation, D1 migration
execution, public docs, and provider contracts.
