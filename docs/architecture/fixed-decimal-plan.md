# Definitive Exact Decimal Plan

## Status

Implementation-ready V1 design. This document replaces the earlier split
between unconstrained and fixed decimals. VibORM is unreleased, so the final
public contract lands directly without aliases, transitional readers, or a
string/number result compatibility mode.

The feature is complete only when the same declared decimal domain supports
exact storage, comparison, ordering, aggregation, and atomic arithmetic on
PostgreSQL, MySQL, PlanetScale, and every SQLite-family provider.

**Migration V1 supersession — 2026-08-29.** Runtime decimal support and offline
dialect generation remain as designed. The later Migration V1 provider matrix
now refuses effectful libSQL, D1, D1 HTTP, and PlanetScale migration commands
until each concrete provider proves its complete lock, marker-CAS,
table-recreation, and foreign-key boundary. The older live-migration targets
below remain design history, not current provider claims.

## Summary

VibORM has one public decimal scalar:

```ts
const amount = s.decimal({
  precision: 10,
  scale: 5,
});
```

It means one exact fixed-decimal domain:

- `precision` is the maximum total digit count;
- `scale` is the maximum fractional digit count;
- values are multiples of `10^-scale`;
- inputs that do not fit are rejected rather than silently rounded;
- multiplication, division, and average round unavoidable fractional results
  with round-half-to-even; and
- public values are immutable Decimal.js value objects.

One canonical plain-decimal string remains the private logical representation
for validation, SQL binding, identity, cache serialization, diagnostics, and
migrations. It is an implementation value, not a second public result mode.

The physical representation is provider-specific but the logical domain is
not:

| Provider family | Physical scalar |
| --- | --- |
| PostgreSQL | `NUMERIC(precision, scale)` |
| MySQL / PlanetScale | `DECIMAL(precision, scale)` |
| SQLite3 / Bun SQLite / libSQL / D1 | signed `INTEGER` coefficient scaled by `10^scale` |

For `precision: 10`, `scale: 5`, public value `new Decimal("12.34")` is stored
as:

- PostgreSQL/MySQL: the native exact decimal value `12.34000`;
- SQLite: integer coefficient `1234000`.

Every typed read returns a `Decimal` whose exact value is 12.34. No typed path
returns a JavaScript number, a public transport string, or the SQLite
coefficient.

VibORM takes a direct runtime dependency on `decimal.js` and re-exports its
`Decimal` constructor. This buys the application an exact value type and
ordinary `.plus()`, `.minus()`, `.times()`, `.div()`, comparison, and explicit
`.toNumber()` methods. It does **not** delegate database semantics to
Decimal.js: the field descriptor and codec still own precision, scale,
overflow, SQL rounding, and physical representation. Decimal.js configuration
affects only arithmetic the application performs on returned values; VibORM's
own SQL and codecs never consult that mutable configuration.

## 1. One decimal concept

### 1.1 Necessary truth

Portable exact decimal arithmetic requires the field's precision and scale.
PostgreSQL and MySQL can store those facts in native types. SQLite cannot:
`DECIMAL(10,5)` is only a NUMERIC-affinity spelling, and SQLite ignores the
numbers in the declared type. Fractional values may be converted to IEEE-754
binary64.

Therefore a scale cannot be inferred from SQLite storage, a value, a driver, or
an operation. It must be declared once in the model and carried as immutable
scalar state.

The descriptor is the one source of truth for:

- input validation;
- physical DDL;
- literal encoding;
- result decoding;
- comparison and aggregate lowering;
- arithmetic rounding and overflow;
- list-member encoding; and
- migration compatibility.

No adapter, driver, result parser, or migration component stores an independent
precision or scale decision.

### 1.2 Concepts removed

The implementation deletes these existing or planned alternatives:

- zero-argument `s.decimal()`;
- `s.decimal(nativeType)` and decimal native-type overrides;
- `.fixed(...)` as a second decimal mode;
- unconstrained PostgreSQL `NUMERIC` as the default;
- default MySQL `DECIMAL(65,30)` unrelated to model state;
- SQLite canonical-TEXT decimal storage;
- the adapter-wide `supportsExactDecimal` capability;
- SQLite decimal-ordering/arithmetic refusal ladders;
- the transitional `createClient({ decimal: "number" })` option;
- `decimalDecode: "string" | "number"` threading;
- a public canonical-string result mode;
- a second ORM-owned decimal class or wrapper around Decimal.js; and
- any compatibility alias or old-storage reader.

There is no separate “fixed decimal” factory. “Fixed decimal” remains the
precise domain term; `s.decimal({ precision, scale })` is its only public
spelling.

## 2. Public contract

### 2.1 Factory and descriptor

```ts
import { Decimal, s } from "viborm";

s.decimal({ precision: 10, scale: 5 });
s.decimal({ precision: 10, scale: 5 }).nullable();
s.decimal({ precision: 10, scale: 5 }).default(new Decimal("0"));
s.decimal({ precision: 10, scale: 5 }).array();
```

The descriptor object is hostile input at runtime. Read each property once,
normalize failures through the schema-definition validation boundary, and
freeze the trusted descriptor.

Rules:

- `precision` is an integer greater than zero;
- `scale` is an integer in `0..precision`;
- unknown, accessor-failing, symbol, inherited-only, or explicit-`undefined`
  properties fail at the definition boundary;
- no rounding option is exposed while only one rounding rule exists;
- V1 rounding is always round-half-to-even;
- `.nullable()`, `.default()`, `.array()`, `.schema()`, `.map()`, `.id()`, and
  `.unique()` preserve the exact descriptor; and
- fixed-decimal lists cannot be IDs, unique fields, index members, foreign-key
  members, or relation identity members.

Scalar decimals may participate in IDs, unique constraints, indexes, foreign
keys, and relation storage. Arithmetic updates to a decimal identity retain the
existing primary-key arithmetic refusals; this plan does not make moving a key
through multiply or divide portable.

### 2.2 Inputs and outputs

Scalar input is:

```ts
type DecimalInput = Decimal | string | number;
```

Scalar output is:

```ts
type DecimalOutput = Decimal;
```

List input and output are:

```ts
type DecimalListInput = readonly DecimalInput[];
type DecimalListOutput = Decimal[];
```

Strings use the existing exact decimal grammar: optional sign, digits, and at
most one decimal point. Exponent notation, whitespace, `NaN`, and infinity are
refused.

Numbers are a convenience only. VibORM canonicalizes `String(number)` and then
applies the same precision/scale validation. It never claims to recover digits
already lost in binary floating point. For example, `0.1 + 0.2` becomes
`"0.30000000000000004"`; a scale-2 field refuses it instead of rounding it to
`"0.3"`.

An input `Decimal` may come from the constructor exported by VibORM or a
Decimal.js clone. `Decimal.isDecimal()` identifies the candidate but is not a
trust token: VibORM copies it with the exported constructor, renders the copy
once in exact non-exponential form with Decimal.js's public API, canonicalizes
that text, and validates the complete descriptor. It never retains a
caller-owned instance or trusts candidate internals directly. Access,
construction, or rendering failures are normalized at the existing validation
boundary. A Decimal created from exponent notation is valid when its exact
expanded value fits; a raw exponent string remains outside the string grammar.

Canonical private text removes a leading plus, insignificant leading/trailing
zeros, a trailing decimal point, and negative zero:

```text
"+001.2300" -> "1.23"
"-0.000"    -> "0"
```

Scale is a domain limit, not display formatting. The returned Decimal represents
1.2 rather than preserving the input spelling `1.20000`. Decimal.js formatting
methods control application presentation; they never define storage or cache
identity.

Non-zero digits beyond `scale`, or an unscaled coefficient with more than
`precision` digits, fail validation. Database assignment is never asked to
perform implicit input rounding.

### 2.3 Custom schemas and defaults

A custom `.schema()` observes a `Decimal`, not private canonical text. It may
refine or brand that value, or return another genuine finite `Decimal`; the
decimal descriptor validates its exact numeric value last, so a custom schema
cannot escape precision or scale or change the public value family. A custom
schema that returns a string, number, arbitrary decimal-like object, NaN, or
infinity fails at that boundary.

Defaults use the same field codec as ordinary writes. A default is serialized
to the provider's physical representation during DDL generation and retained as
the canonical logical value in model metadata.

### 2.4 Decimal value boundary

VibORM re-exports the package's one `Decimal` constructor and its instance type
from the root entry point:

```ts
import { Decimal } from "viborm";

const total = row.subtotal.plus(row.tax);

await db.invoice.update({
  where: { id },
  data: { total },
});
```

Do not add `VibDecimal`, a wrapper, a field-bound Decimal subclass, a decimal
manager, or a second constructor. Decimal.js remains the value owner; the
field-aware codec remains the database-domain owner.

The boundary rules are exact:

- every selected scalar or list member gets a fresh Decimal instance;
- cache stores, migration snapshots, operation identity maps, relation keys,
  cursor material, and diagnostic values use canonical private strings and
  reconstruct public Decimal instances at the result boundary;
- `Decimal#toJSON()` provides a string for ordinary application JSON, but core
  correctness never depends on JSON round-tripping a Decimal prototype;
- equality in application code uses Decimal.js comparison methods such as
  `.eq()`, not JavaScript object identity;
- `.toNumber()` is the explicit lossy escape hatch; and
- Decimal.js precision and rounding configuration governs only application
  arithmetic. Database `multiply`, `divide`, and `_avg` keep the descriptor's
  provider-independent half-even contract.

## 3. Provider representation and legality

### 3.1 Provider limits

The descriptor is syntactically valid at model construction. The selected
adapter validates its physical capability once when the schema is bound and
before provider I/O.

| Provider | Complete V1 scalar limit |
| --- | --- |
| PostgreSQL | `precision <= 1000`, `scale <= precision` |
| MySQL / PlanetScale | `precision <= 65`, `scale <= 30` |
| SQLite family | `precision <= 18` and `precision + scale <= 18` |

The SQLite `precision + scale` bound is required by the V1 one-statement
multiply/divide implementation. It ensures every mathematically in-range
rounded result can be computed without overflowing an intermediate signed
int64. VibORM does not accept a broader SQLite field and later surprise the
caller with missing arithmetic operations.

A schema valid for PostgreSQL but outside another provider's limits remains a
valid model graph; binding it to the incapable provider fails once with a
definition error naming the field, descriptor, provider, and limit.

### 3.2 PostgreSQL

- DDL uses `NUMERIC(p,s)`.
- Typed literals bind canonical strings and cast them to the same `NUMERIC(p,s)`
  domain when the expression lacks column context.
- Inputs already fit, so PostgreSQL never owns assignment rounding.
- Result values are captured as exact text, canonicalized once, and materialized
  as Decimal only at the public result boundary.
- Native arithmetic is used only where its result scale is already exact;
  multiply, divide, and average use VibORM's explicit half-even expression.

PostgreSQL supports a much wider unconstrained `NUMERIC`, but exposing it as the
portable scalar would reintroduce a second domain that SQLite cannot order or
calculate exactly. Users who need database-specific arbitrary numeric SQL use
raw SQL or a future explicitly provider-owned scalar, not `s.decimal()`.

### 3.3 MySQL and PlanetScale

- DDL uses `DECIMAL(p,s)`.
- Typed literals bind canonical strings and cast them to `DECIMAL(p,s)`.
- Strict exact-value behavior is required; a mode that converts overflow or
  truncation to warnings is refused for effectful decimal operations.
- Results stay strings through mysql2/PlanetScale normalization and become
  Decimal only in the compiled result parser.
- VibORM implements half-even explicitly because provider rounding must not
  define the public contract.

Bare `DECIMAL` is never emitted: MySQL interprets it as scale zero with default
precision 10.

### 3.4 SQLite family

For scale `s`:

```text
coefficient = logical decimal × 10^s
logical decimal = coefficient × 10^-s
```

The field codec performs both conversions with digit strings and `bigint`.
JavaScript multiplication or division on `number` is forbidden.

DDL uses `INTEGER` plus one deterministic VibORM-owned check constraint that:

- permits `NULL` only for a nullable field;
- requires `typeof(column) = 'integer'`; and
- requires the coefficient to fit `-(10^p - 1)..(10^p - 1)`.

Typed binds send canonical coefficient digits through the provider-independent
integer binding route. Typed projections, `RETURNING`, aggregates, nested
relation carriers, and generated outputs cast coefficients to text before a
driver can round an int64 into a JavaScript number.

SQLite never uses `DECIMAL(...)`, NUMERIC affinity, `REAL`, `total()`, or a
post-read Decimal.js object as a repair for imprecise physical storage. The
Decimal is constructed only after exact coefficient decoding succeeds.

### 3.5 Raw SQL

Raw SQL remains physical:

- PostgreSQL/MySQL expose native decimal values through their normal raw-driver
  contract;
- SQLite raw reads see the unscaled integer coefficient; and
- SQLite raw writes must provide a valid coefficient.

Raw SQL does not receive model-aware scaling. Documentation must show casting a
SQLite coefficient to text when it may exceed JavaScript's safe integer range.
Raw-query results are not implicitly wrapped in Decimal because raw SQL has no
trusted field descriptor.

## 4. One decimal codec

### 4.1 Descriptor and trusted value

Add one immutable decimal descriptor to scalar state:

```ts
interface DecimalDescriptor {
  readonly precision: number;
  readonly scale: number;
}
```

Do not copy it into query scopes, result shapes, drivers, or operation
programs. Consumers reach it through the resolved scalar field they already
own.

One field-aware decimal codec owns:

- canonical logical validation;
- exact extraction from accepted Decimal inputs;
- logical string to unscaled coefficient conversion;
- coefficient to canonical logical string conversion;
- provider scalar and list binding;
- provider scalar and list decoding;
- public Decimal construction;
- cache Decimal-to-string and string-to-Decimal conversion;
- widened aggregate decoding; and
- migration value conversion.

The codec may compile field-specific closures once. Do not introduce a codec
manager, transport strategy, decimal context bag, or driver wrapper.

### 4.2 Result trust boundary

The compiled result parser invokes the field codec exactly once per selected
decimal value. It accepts only the exact physical representation promised by
the active adapter:

- native decimal text on PostgreSQL/MySQL;
- signed integer text for SQLite scalar coefficients;
- the provider-specific list representation below.

Malformed provider values fail through the existing result-parsing error
boundary. A valid physical value becomes one fresh Decimal at the final typed
boundary. It never falls back to `Number`, plausible zero, an unvalidated
string, or a caller/provider-owned Decimal instance.

Consumable-row reuse remains valid: same-key scalar decoding may replace the
physical value with the fresh Decimal in an owned row; borrowed rows continue
through the copy path. The parser does not construct an intermediate Decimal
before it knows whether the row copies or reuses.

## 5. Exact query and update language

### 5.1 Filters and ordering

All providers support the existing scalar decimal filter surface exactly:

- shorthand/`equals`, `not`, `in`, and `notIn`;
- `lt`, `lte`, `gt`, and `gte`;
- `orderBy`, nested ordering, cursor tie-breakers, and pagination;
- `distinct` and `groupBy({ by: [...] })`; and
- compatible decimal field references.

SQLite compares stored coefficients as integers. PostgreSQL/MySQL compare their
native exact values. Field references are valid only when both fields have the
same precision and scale; scalar kind alone is insufficient.

Decimal objects never become reference-identity keys. Cursors, deduplication,
relation stitching, identity maps, cache keys, and write-engine agreement use
the descriptor codec's canonical private string, so two distinct Decimal
instances representing the same value are the same logical key.

Generic typed `Sql` operands remain refused for decimal predicates because a
fragment carries no trusted precision or scale. Raw SQL remains the escape.

### 5.2 Update object

The current update schema accidentally models one partial object containing all
numeric operations. It therefore admits `{}` and multiple keys, while the
builder silently chooses the first recognized key. That is not the V1 contract.

Decimal updates become an exact union:

```ts
type DecimalUpdate =
  | DecimalInput
  | { set: DecimalInput }
  | { increment: DecimalInput }
  | { decrement: DecimalInput }
  | { multiply: DecimalInput }
  | { divide: DecimalInput };
```

For nullable fields, only the shorthand/set arms also accept `null`.

Exactly one operation is required. Empty objects, multiple operation keys,
unknown keys, inherited keys, and explicit `undefined` fail during operation
validation. There is no precedence ladder in the query engine.

Semantics:

- shorthand and `set` replace the value after exact descriptor validation;
- `increment` and `decrement` perform exact addition/subtraction;
- `multiply` and `divide` quantize the result to the field scale with
  round-half-to-even;
- division by canonical zero fails before I/O;
- a result outside the field precision fails atomically; and
- all arithmetic is one SQL assignment, never application read-modify-write.

The exact-one representation also applies to decimal-list update operations:

```ts
type DecimalListUpdate =
  | DecimalListInput
  | { set: DecimalListInput }
  | { push: DecimalInput | DecimalListInput }
  | { unshift: DecimalInput | DecimalListInput };
```

Only the whole-list shorthand/set arms accept `null` for a nullable list.

### 5.3 Rounding and overflow

V1 uses round-half-to-even only when an operation creates digits beyond scale:

- scalar multiply;
- scalar divide; and
- decimal average.

Create, set, filters, increment, and decrement never round input. Excess input
scale is a validation error.

For SQLite coefficient `x`, operand coefficient `y`, and `F = 10^scale`:

```text
multiply = halfEven((x * y) / F)
divide   = halfEven((x * F) / y)
```

The adapter uses guarded integer `CASE` expressions. Unsafe intermediate or
out-of-domain results route to a deterministic constraint-breaking coefficient
without evaluating an overflowing arm. Quotient/remainder and parity determine
half-even rounding; no path casts through REAL.

PostgreSQL and MySQL use the same coefficient-space rule so provider-default
rounding cannot diverge. MySQL expressions avoid an intermediate wider than its
65-digit exact domain and require proven strict failure behavior.

### 5.4 Aggregates

All providers support:

- `_min` and `_max` in the field domain;
- `_sum` as a scale-preserving, precision-widened Decimal;
- `_avg` rounded half-even to the field scale;
- aggregate ordering and `having`; and
- direct, grouped, nested, and relation-count-adjacent result shapes.

SQLite `_sum` uses integer `SUM` and transports the coefficient as text. Native
integer overflow surfaces as an exact database error; it never falls back to
REAL. `_avg` is derived from exact sum and `COUNT(column)`, preserves `NULL` for
empty/all-null input, and applies the shared quotient/remainder rounder.

Aggregate result decoding is field-aware. `_sum` is not incorrectly rejected
for exceeding the field's storage precision, while it must retain the field's
scale. `_min`, `_max`, `_sum`, and `_avg` return Decimal or `null`; only their
private transport values are canonical strings.

## 6. Decimal lists in V1

Decimal arrays are not deferred.

### 6.1 Physical representation

| Provider family | Decimal-list storage |
| --- | --- |
| PostgreSQL | `NUMERIC(p,s)[]` |
| MySQL / PlanetScale | JSON array of canonical coefficient strings |
| SQLite family | TEXT containing a canonical JSON array of coefficient strings |

At scale 2, logical `['1.2', '-0.03']` is represented as coefficient strings
`['120', '-3']` on JSON-backed providers. JSON numeric tokens are forbidden
because JavaScript and D1 can round integers above `2^53`.

Typed reads materialize those members as:

```ts
[new Decimal("1.2"), new Decimal("-0.03")];
```

The JSON strings are private storage and cache transport, not the public list
result type.

PostgreSQL must capture each exact native array element as text before relation
JSON construction. It must not route native decimal arrays through JSON numeric
tokens or whole-array JavaScript number parsing.

### 6.2 Descriptor metadata

- PostgreSQL carries precision/scale in the array element typmod and
  introspection uses `pg_catalog.format_type`.
- SQLite stores a deterministic reserved constraint name/body containing the
  descriptor and verifies TEXT plus a valid top-level JSON array.
- MySQL/PlanetScale use one deterministic VibORM-owned column-comment marker
  for JSON decimal lists. Introspection recognizes only the exact marker.

The PlanetScale implementation must prove through its deterministic fixture and
hosted leg that the marker survives create/introspect/alter cycles. If that
evidence fails, implementation stops for a design revision; it must not ship an
untracked descriptor or silently omit arrays.

### 6.3 List behavior

The existing list surface remains:

- whole-list equality and nested/shorthand `not`;
- `has`, `hasEvery`, `hasSome`, and `isEmpty`;
- whole-list shorthand/set;
- push/unshift of one, many, or zero elements; and
- nullable whole-list behavior.

Elements are never nullable. Whole-list equality preserves order and
multiplicity; containment uses set-membership semantics. Empty candidate and
nullable-column truth tables are defined once in the operation schema and
adapter contract and pinned identically on every provider.

Lists do not invent numeric list semantics. They expose no `lt/lte/gt/gte`,
whole-list numeric ordering/cursor identity, numeric aggregate, or arithmetic
update. `_count.field` counts non-null lists, not elements.

One field-aware list codec owns create, createMany, upsert, defaults, set,
equality, containment candidates, push/unshift, direct results, returning
results, nested relation carriers, and bulk results. Generic array serialization
must not get a second chance to interpret decimal elements.

## 7. Schema evolution

### 7.1 No pre-release compatibility estate

The implementation replaces the current decimal representation directly:

- no old zero-argument factory;
- no TEXT-decimal dual reader;
- no `REAL` reader;
- no `DECIMAL(65,30)` fallback;
- no compatibility snapshot parser; and
- no generated migration whose sole purpose is upgrading unpublished data.

Existing development databases may be recreated. This is distinct from future
changes between two valid published decimal descriptors, which V1 supports
below.

### 7.2 One physical descriptor

Migration `ColumnDef` stores one logical decimal descriptor plus the active
physical representation. Serializer, snapshot, differ, DDL, introspection,
defaults, and table reconstruction consume it. The differ compares the
descriptor even when the SQL storage class stays `INTEGER`, `TEXT`, or `JSON`.

There is no parallel decimal metadata map on `Model`, adapter, or migration
driver.

### 7.3 Descriptor changes

V1 automatically applies exact changes and fails before irreversible effects
when existing values cannot fit:

| Change | Behavior |
| --- | --- |
| Precision widening | exact automatic conversion |
| Precision narrowing | convert only when every value fits |
| Scale increase | exact automatic conversion when target precision fits |
| Scale decrease | convert only when discarded fractional digits are all zero |
| Scalar/list descriptor change | apply the same rule to every value/member |
| Malformed storage or overflow | fail; preserve old schema and data |

No descriptor change rounds existing data. The arithmetic rounding rule does
not authorize a schema migration to change stored values.

### 7.4 Provider execution

PostgreSQL:

- acquire the migration owner's table lock inside the existing transaction;
- validate every scalar/array member against the target descriptor;
- alter to `NUMERIC(p,s)` or `NUMERIC(p,s)[]` only after validation; and
- roll back validation, DDL, and metadata together on failure.

MySQL/PlanetScale:

- use the migration program's exact admitted provider capability;
- validate every value/member on the pinned producer while writes are excluded;
- preserve strict-mode proof through conversion;
- perform the provider's documented DDL boundary without claiming rollback
  across an implicit commit; and
- report the last proven commit boundary if an admitted MySQL conversion fails.

PlanetScale descriptor changes run only through a migration capability it
actually supports. They never gain effectful DDL merely because the runtime
adapter can encode decimals.

SQLite3, Bun SQLite, and libSQL:

- extend the existing table-recreation copy map with one decimal conversion
  expression;
- decode physical coefficient text to canonical logical digits, validate the
  target descriptor, then encode the target coefficient;
- use string operations and guarded integer casts only;
- convert list members through `json_each` while preserving order and
  multiplicity; and
- keep the rebuild atomic.

D1:

- fresh decimal scalar/list schemas and ordinary operations are mandatory;
- descriptor changes use the same logical conversion contract;
- relation-bearing table reconstruction must first prove the existing D1
  foreign-key-safe rebuild requirement across NO ACTION, CASCADE, SET NULL,
  RESTRICT, cyclic, self, mapped, compound, inbound, and outbound relations;
- until that proof is green, a D1 descriptor change requiring reconstruction
  fails before effects with the exact substrate reason; and
- no unsafe drop/recreate fallback or manual shadow-column instruction is
  shipped.

Down migrations reverse the descriptor conversion and may correctly fail when
newer data no longer fits the old domain.

## 8. Implementation program

### Unit A — Public domain and exact-one update schemas

- Add `decimal.js` as a direct runtime dependency and export its `Decimal`
  constructor/type from `viborm`.
- Replace the decimal factory with the required descriptor object.
- Carry the immutable descriptor through every modifier.
- Build Decimal/string/number input schemas and Decimal scalar/list result
  schemas from it.
- Replace decimal scalar and list operation bags with exact-one unions.
- Make `.schema()` refine the Decimal value family and reject transforms to a
  different representation.
- Remove native overrides and string/number result configuration.
- Add public type and hostile-definition falsifiers.

Done when invalid decimal states and ambiguous updates are unrepresentable
through both TypeScript and runtime validation.

### Unit B — One codec and provider storage

- Add the one field-aware logical/coefficient codec.
- Emit `NUMERIC(p,s)`, `DECIMAL(p,s)`, or checked scaled `INTEGER`.
- Bind and decode every scalar path without a JavaScript number.
- Construct one fresh public Decimal only at each final typed result leaf.
- Encode Decimal to canonical text at cache/identity boundaries and reconstruct
  it without prototype-dependent structured cloning.
- Make defaults use the same codec.
- Preserve consumable-row and borrowed-row ownership rules.

Done when create/read/update/returning values round-trip exactly on PostgreSQL,
MySQL, and every SQLite provider.

### Unit C — Queries, aggregates, and arithmetic

- Make every decimal predicate/order path descriptor-aware.
- Remove the adapter-wide refusal capability and all refusal call sites.
- Implement exact SQLite coefficient operations.
- Implement shared half-even multiply/divide/average semantics.
- Decode widened sums and field-scale averages exactly.
- Preserve primary-key arithmetic boundaries.

Done when every existing public decimal scalar operation answers exactly on all
providers and no old SQLite refusal path remains.

### Unit D — Decimal lists

- Implement PostgreSQL native arrays and JSON coefficient-string containers.
- Add the MySQL/PlanetScale metadata marker and provider proof.
- Route every list write/filter/update/result through the field codec.
- Exclude numeric list operations at their schema owner.
- Add hostile physical-container tests.

Done when the complete existing decimal-list surface has provider parity and no
element can cross JSON as a number.

### Unit E — Migration descriptors and exact conversion

- Extend serialization, snapshots, differ, DDL, and introspection.
- Implement exact precision/scale changes on each provider.
- Prove failure and atomicity/commit-boundary behavior.
- Complete the D1 reconstruction prerequisite before admitting its rebuild.
- Prove second-push convergence.

Done when every descriptor transition has a successful exact witness and a
failing witness that preserves the last guaranteed estate.

### Unit F — Semantic deletion and documentation

- Delete decimal TEXT storage, refusal helpers, compatibility decoding, native
  overrides, stale tests, and duplicate comments.
- Update scalar, Decimal value, application arithmetic, cache, JSON, migration,
  provider, and raw-SQL guidance.
- Update applicable `AGENTS.md` files with the single descriptor/codec owner.
- Add a source census preventing a second decimal mode, float transport,
  public string/number result mode, ORM-owned Decimal wrapper, partial operation
  bag, or adapter-wide refusal.

Done when the final system is explained as one descriptor, one codec, and one
public Decimal value domain.

### Unit G — Provider and performance acceptance

- Run every focused and aggregate gate below sequentially.
- Compare the exact pre-feature baseline and candidate in fresh worktrees.
- Attribute the Decimal-construction allocation/CPU cost separately from codec,
  row-copy, and provider transport costs.
- Remove provider-specific workarounds that duplicate the codec.

Done when all supported provider surfaces are exact and the ordinary
non-decimal operation pipeline is unchanged, with no intermediate Decimal
construction beyond the one public value materialization per result leaf.

## 9. Focused falsifiers

### 9.1 Definition and public types

- Missing, empty, fractional, negative, excessive, explicit-`undefined`,
  inherited, accessor-throwing, and unknown descriptor properties fail through
  the definition boundary.
- Fresh and held option objects reject misspellings beside real keys.
- Zero-argument, native-argument, `.fixed()`, rounding-option, and
  client-number-decoding spellings fail publicly and at hostile runtime calls.
- Every modifier preserves descriptor identity and output typing.
- Scalar output is `Decimal`; list output is `Decimal[]`; nullable forms are
  exact. The constructor exported from `viborm` constructs accepted inputs and
  matches result instances.
- A custom schema receives Decimal and cannot return string, number, NaN,
  infinity, or an arbitrary decimal-like object.
- Inputs from the exported constructor and a Decimal.js clone work; malformed
  or forged Decimal candidates cannot bypass canonical grammar, finiteness,
  precision, or scale validation.
- Distinct result instances for the same value compare equal with `.eq()` but
  are never relied on through `===`.
- Scale zero, maximum values, negative zero, leading/trailing zeros, values
  beyond `2^53`, a genuine Decimal input, and a `number` carrying `0.1 + 0.2`
  have discriminating tests.

### 9.2 Storage and results

- Fresh DDL is exactly `NUMERIC(p,s)`, `DECIMAL(p,s)`, or checked `INTEGER`.
- SQLite physically stores the expected coefficient and refuses TEXT/REAL,
  overflow, and malformed raw values.
- Direct, prepared, transaction, fallback/native batch, returning, nested
  relation, aggregate, and extension-observed typed results expose Decimal.
- Cache memory/KV stores encode canonical strings, every hit reconstructs fresh
  Decimal instances, and caller mutation cannot poison later hits.
- No exact value crosses provider middleware, relation JSON, cache snapshots,
  identity maps, cursor material, or generated-output transport as a JavaScript
  number or Decimal object; Decimal is materialized only at the typed result
  boundary.
- Public/manual result parsing remains hostile-input safe and never mutates
  borrowed input.
- Decimal.js constructor configuration changes cannot alter SQL, physical
  encoding, cache identity, migrations, database rounding, or result
  validation.

### 9.3 Filters and updates

- Numeric and lexical order disagree in fixtures; all scalar comparison,
  ordering, cursor, pagination, nested, and group spellings return numeric
  order on SQLite.
- Field references with equal descriptors work; unequal descriptors and generic
  typed SQL fail before I/O.
- Shorthand/set/increment/decrement/multiply/divide each work alone.
- `{}`, multiple keys, unknown keys, inherited keys, and explicit `undefined`
  fail before SQL; no precedence behavior survives.
- Positive/negative half-even ties, rounded carries, division by zero,
  intermediate-overflow candidates, target overflow, nullable storage, and
  strict-MySQL failures are pinned.
- Successful and rejected arithmetic remains one atomic statement in direct,
  nested, updateMany, series, and batch execution.

### 9.4 Aggregates

- `_min`, `_max`, `_sum`, `_avg`, grouped projection, aggregate ordering, and
  HAVING have exact provider parity.
- Sum can exceed field precision while retaining scale and returns Decimal.
- SQLite sum overflow is an error, never a REAL answer.
- Average uses `COUNT(column)`, preserves NULL for empty/all-null input, and
  rounds exact positive/negative ties half-even.

### 9.5 Lists

- Both ordinary and nullable lists round-trip coefficients above `2^53` and
  provider-native decimal limits without JSON numeric tokens.
- Every typed member is a fresh Decimal and no storage/cache JSON container is
  exposed as the typed result.
- At scale 2, logical `"1.2"` is physical `"120"`; `has: "1.2"` matches while
  `has: "120"` means logical 120.
- Equality order/multiplicity, nested not, containment, empty candidates,
  isEmpty, set, push/unshift one/many/empty, and NULL behavior match everywhere.
- Direct, returning, bulk, nested, cache, and relation-carrier results rescale
  every member.
- Numeric list filters, ordering, aggregates, identity use, and arithmetic are
  absent at type and runtime schema boundaries.
- Number tokens, leading-zero coefficients, `+1`, `-0`, NULL members, malformed
  JSON, wrong top-level values, overflow, and descriptor-marker mismatch fail
  loudly.

### 9.6 Migrations

- Every descriptor transition has exact success and refusal cases.
- Scale reduction never rounds existing values.
- Failed conversion preserves schema/data according to the provider's declared
  transaction or commit-boundary contract.
- Arrays preserve order and duplicates.
- PostgreSQL array typmods, MySQL/PlanetScale markers, and SQLite reserved
  constraints introspect exactly.
- LibSQL cannot take a native ALTER route that skips conversion.
- D1 relation-bearing rebuilds have real remote FK evidence before admission.
- Generated down migrations reverse the codec and fail safely when data no
  longer fits.
- Second push is empty on every admitted provider.

## 10. Sequential validation gates

Run large commands sequentially because the workspace lock forbids overlap.

1. Focused decimal definition, validation, operation-schema, codec, query,
   aggregate, list, result-parser, and migration tests.
2. `pnpm test:layer:scalars`
3. `pnpm test:layer:validation`
4. `pnpm test:layer:query-engine`
5. `pnpm test:layer:adapters`
6. `pnpm test:layer:drivers`
7. `pnpm test:layer:migrations`
8. `pnpm test:layer:client`
9. Relevant cache, instrumentation, relation, and write-engine suites.
10. Relevant scalar, validation, schema, query-engine, and write-engine coverage
    gates.
11. `pnpm test:types`, with no TS2589 or TS2590 and before/after diagnostics.
12. Repository-pinned Biome on every touched TypeScript file.
13. `git diff --check`.
14. `pnpm --dir docs validate`.
15. `pnpm package:build` and `pnpm test:package`.
16. SQLite3, Bun SQLite, libSQL, and D1 contracts.
17. PGlite, `pg`, postgres.js, and Neon contracts.
18. MySQL2 and PlanetScale contracts, including strict-mode and metadata proof.
19. `pnpm test:core`.
20. `pnpm test:all`.
21. `pnpm test:providers`, with hosted skips reported honestly.
22. Architecture census and detector falsifiers.
23. Five alternating fresh-process operation-pipeline runs for a scalar control,
    one-decimal row, 1,000-decimal rows, decimal arithmetic, decimal aggregate,
    and decimal-list workloads on SQLite3 and PGlite; add MySQL2 when the Docker
    substrate is available.
24. Package-export and Worker-runtime probes proving `Decimal` has one public
    constructor identity and does not pull a Node-only runtime into D1/Workers.

Acceptance requires:

- no regression in non-decimal SQL, results, or operation behavior;
- no per-operation decimal handler scan;
- one field-compiled conversion step and one Decimal construction per selected
  decimal value, with no intermediate Decimal arithmetic in the ORM;
- no non-decimal allocation or framework-CPU regression greater than 3% and
  `2×MAD`;
- a measured decimal-heavy allocation, retained-heap, CPU, and package-size
  report that separates the intentional public Decimal value cost from
  avoidable transport, copying, or codec overhead;
- no decimal-path regression beyond the measured Decimal constructor/value
  floor by more than 10% or `2×MAD`;
- unchanged unextended-client and non-decimal consumable-row fast paths; and
- exact provider behavior, not cross-ORM benchmark ratios, deciding retention.

## 11. Completion criteria

The decimal is nailed only when all statements are true:

1. `s.decimal({ precision, scale })` is the sole public decimal factory.
2. Precision and scale are immutable scalar state and have no second owner.
3. Round-half-to-even is the one V1 derived-result rule and is not exposed as a
   one-value configuration concept.
4. Public scalar/list results are fresh Decimal.js values; no public
   string/number result mode or ORM-owned Decimal wrapper exists.
5. PostgreSQL uses `NUMERIC(p,s)`, MySQL uses `DECIMAL(p,s)`, and SQLite uses a
   checked scaled integer.
6. `DECIMAL(...)` affinity, REAL, and canonical TEXT are absent from SQLite
   scalar decimal storage and arithmetic.
7. One field-aware codec owns every logical/physical scalar and list crossing,
   canonical private text, and final Decimal materialization.
8. Every typed decimal scalar filter, order, aggregate, and arithmetic operation
   answers exactly on every provider that admits the descriptor.
9. Decimal updates require exactly one operation and the query engine contains
   no precedence ladder for them.
10. Multiplication, division, and average have provider-independent half-even
    behavior; input validation never silently rounds.
11. Overflow and division by zero fail before effects when knowable and remain
    atomic database errors otherwise.
12. Decimal arrays ship in V1 with their complete existing list surface.
13. No JSON-backed coefficient is ever represented as a JSON number, and no
    cache or transport boundary relies on cloning a Decimal prototype.
14. Aggregate sums widen safely and averages have one scale/nullability rule.
15. Descriptor changes are automatic when exact and refuse without changing
    values when not exact.
16. Fresh and migrated schemas converge on a second push.
17. D1 reconstruction is admitted only after its relation-bearing FK safety is
    proven.
18. Raw SQL exposes the documented physical representation and receives no
    hidden scaling.
19. Current refusal helpers, compatibility options, native override, duplicate
    codecs, and obsolete documentation are deleted in the same program.
20. `decimal.js` is the one direct value-object dependency and `viborm` exports
    its one Decimal constructor/type; application arithmetic configuration
    cannot alter ORM/database semantics.
21. All focused, type, layer, coverage, package, provider, core, and aggregate
    gates pass with honest hosted-provider reporting.
22. The operation pipeline satisfies the measured allocation/CPU gate.

After implementation, record the durable descriptor/codec ownership in the
applicable `AGENTS.md` files and replace this plan's status with its measured
completion report. Do not preserve old and final decimal mechanisms together.
