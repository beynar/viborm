# Replace Float With Number

## Goal

Replace VibORM's approximate numeric scalar with a JavaScript-native name while
preserving its behavior and physical database representation.

```ts
s.float()                   // removed
s.number()                  // replacement

FloatScalar<State<"float">> // removed
NumberScalar<State<"number">> // replacement
```

This is a breaking replacement, not a deprecation cycle. There is no
`s.float()` compatibility alias and no legacy `"float"` scalar discriminator.

Two JSON boundaries must stay distinct throughout this work:

- **Schema JSON** (`viborm/schema/json`) persists VibORM declarations as data.
  Its scalar discriminator currently writes `{ "type": "float" }` and must
  change to `{ "type": "number" }`.
- **Standard JSON Schema conversion** (`viborm/validation`) describes validation
  schemas. The approximate scalar is backed by `v.number()`, so its standards
  output is already `{ "type": "number" }` and must remain byte-identical.

## Contract

`s.number()` represents a finite JavaScript `number`:

- it accepts integers and fractional values;
- it rejects `NaN`, `Infinity`, and `-Infinity`;
- it uses IEEE-754 binary floating-point semantics;
- it returns a JavaScript `number` from every provider;
- it retains all current scalar modifiers and operation schemas;
- it keeps the current physical column type on every dialect.

| Database | Default column type |
| --- | --- |
| PostgreSQL | `double precision` |
| MySQL | `DOUBLE` |
| SQLite | `REAL` |

The other numeric scalars do not change:

| Scalar | Meaning | Result type |
| --- | --- | --- |
| `s.int()` | Safe whole-number domain backed by an integer column | `number` |
| `s.number()` | Approximate finite JavaScript number | `number` |
| `s.decimal()` | Exact base-10 decimal | `string` |
| `s.bigInt()` | Large integer | `bigint` |

## Constraints

- Do not change validation, filtering, update, parsing, or aggregation behavior
  beyond the rename.
- Do not generate a data migration or alter an existing column.
- Change the Schema JSON declaration token from `"float"` to `"number"` in
  both parser and serializer; do not accept both spellings.
- Do not rename `PG.FLOAT`, `MYSQL.FLOAT`, or `SQLITE.FLOAT`. Those names
  describe database-native type families, not VibORM scalar terminology.
- Do not blindly replace the word `float` where it correctly describes an SQL
  type, IEEE-754 arithmetic, precision loss, or a historical fact.
- Preserve natural type inference. Do not introduce assertions to bridge the
  renamed state.

## Public Naming Collision

`NumberScalar` currently names the union of `int`, `float`, and `decimal`
scalars. The concrete replacement also needs that name under VibORM's class
naming convention.

Resolve the collision as follows:

| Current | Replacement |
| --- | --- |
| Numeric-family `NumberScalar` union | `NumericScalar` |
| Numeric-family `NumberScalarConfig` | `NumericScalarConfig` |
| Concrete `FloatScalar` | Concrete `NumberScalar` |
| `float()` | `number()` |
| `ScalarState<"float">` | `ScalarState<"number">` |

`NumberScalar` then has one meaning: the concrete class produced by
`s.number()`.

## Implementation Plan

### 1. Pin the new public contract

Add public-surface type and runtime probes before considering the replacement
complete:

- `s.number()` exists and returns a scalar whose state type is `"number"`;
- nullable, array, default, schema, ID, unique, and mapping modifiers preserve
  their current inferred state;
- model results and aggregates infer JavaScript `number`;
- `s.float()` does not compile;
- `float` is absent from the runtime schema-builder keys;
- `number` is present in the runtime schema-builder keys.

The negative type probe must enter through the public `s` surface. An internal
type alias does not prove what an application can write.

### 2. Replace the scalar owner

Repurpose `src/schema/scalars/number/` from a numeric re-export directory into
the concrete scalar implementation:

1. Move the implementation owned by `src/schema/scalars/float/scalar.ts` into
   `src/schema/scalars/number/scalar.ts`.
2. Rename `FloatScalar` to `NumberScalar`.
3. Rename `float` to `number`.
4. Change `ScalarState<"float">` to `ScalarState<"number">`.
5. Change `createDefaultState("float", v.number())` to
   `createDefaultState("number", v.number())`.
6. Rename internal variables such as `floatBase` to `numberBase`.
7. Preserve every modifier and its immutable return behavior.
8. Delete `src/schema/scalars/float/`.

The implementation continues to use the existing `v.number()` primitive. No
new validator or scalar base class is required.

### 3. Update schema types and exports

Update the schema layer's complete scalar registry:

- replace `"float"` with `"number"` in every `ScalarType` definition;
- replace `FloatScalar` with `NumberScalar` in the `Scalar` union;
- rename the numeric-family union from `NumberScalar` to `NumericScalar`;
- rename `NumberScalarConfig` to `NumericScalarConfig` and replace its
  discriminator member;
- update `NumericScalarType` and `NumericScalarKeys`;
- replace `"float"` with `"number"` in the runtime scalar recognition set;
- export `NumberScalar`, `number`, and `NumericScalar` from the intentional
  scalar and schema surfaces;
- remove `FloatScalar` and `float` exports;
- add `number` and remove `float` from the `s` builder;
- update `ScalarTypeToTS` to map the `"number"` discriminator to the
  JavaScript `number` type.

### 4. Update the Schema JSON document format

Schema JSON under `src/schema/json/` is a declaration persistence boundary, not
the standards-based JSON Schema converter. It reads and writes the scalar
discriminator, so it participates directly in this replacement.

Update its one format and its two directions:

- `document.ts`: `ScalarFieldDocument.type` must include `"number"` through the
  canonical `ScalarType` and must no longer admit `"float"`;
- `factories.ts`: import `number`, replace the `float` factory entry with
  `number`, and keep `SCALAR_FACTORIES` exhaustive;
- `read.ts`: derive the accepted scalar names from the updated factory record,
  accept `{ "type": "number" }`, and refuse `{ "type": "float" }` with the
  existing `J004` unknown-type boundary;
- `interpret.ts`: resolve the `"number"` document node through the real
  `number()` builder without adding another mapping owner;
- `serialize.ts`: emit `{ "type": "number" }` from the renamed scalar state;
- the published `SchemaDocument` type and `viborm/schema/json` package entry:
  expose the new token and no old spelling.

Pin the published format type through that package surface: a document field
with `{ type: "number" }` is assignable to `SchemaDocument`, while a `"float"`
field is a type error.

The schema-document version stays `1` only because this format is still
uncommitted and has not shipped at the time of this plan. Land the scalar rename
before the first Schema JSON release, so version 1 has one history and has never
accepted `"float"`. If version 1 ships with `"float"` before this work lands,
stop and revise the version strategy: changing an already-published v1 token in
place would violate the format's rule that document meaning does not drift.

Update the complete-surface format contract from:

```json
{ "type": "float", "default": 1.5 }
```

to:

```json
{ "type": "number", "default": 1.5 }
```

**2026-08-27 — version gate adjudicated, does not trigger.** Schema JSON merged
to `main` (`ac3e84ef`, PR #28). The `viborm` package HAS been published
(`0.1.0`, January 2026), but that release predates the format and exports no
`viborm/schema/json` entry — the Schema JSON FORMAT itself is unreleased, so no
v1 document with `"float"` has ever shipped. The rename lands now, before the
format's first release, and document-format version 1 keeps one history in
which the approximate scalar was only ever `"number"`.

Preserve the Schema JSON theorems:

- **T1:** parsing a serialized coded schema keeps the same resolved topology and
  migration snapshot;
- **T2:** `serializeSchema(parseSchema(document))` remains the canonical,
  idempotent form;
- parsing produces a fresh scalar whose state type equals the document token;
- serialization stays non-mutating and never drops unsupported declarations.

Add one focused refusal witness for `{ "type": "float" }`. This is unique
coverage for the Schema JSON wire boundary; the absence of `s.float()` from the
code API does not prove that hostile or stored documents refuse the old token.

### 5. Rename operation validation and preserve JSON Schema output

Move `src/validation/scalars/float.ts` to
`src/validation/scalars/number.ts` and rename its semantic surface:

| Current | Replacement |
| --- | --- |
| `FloatSchemas` | `NumberSchemas` |
| `buildFloatSchema` | `buildNumberSchema` |
| `FloatOperand` | `NumberOperand` |
| `FloatFilterBase` | `NumberFilterBase` |
| `ComparisonOperand<"float">` | `ComparisonOperand<"number">` |

Update the scalar-schema dispatcher, aggregate scalar lists, comparison
operator registry, field-reference branding, and schema interning imports.

Preserve the current operation language:

- `equals`, `not`, `in`, and `notIn`;
- `lt`, `lte`, `gt`, and `gte`;
- `set`, `increment`, `decrement`, `multiply`, and `divide`;
- list equality and list mutation operations;
- custom Standard Schema validation.

The standards-based converter in `src/validation/json-schema/` should need no
new scalar case: the renamed scalar's base remains `v.number()`, whose schema
type is already `"number"`. Update model fixtures from `s.float()` to
`s.number()` and pin both public conversion routes:

- `toJsonSchema(numberFilter)` emits a shorthand `{ "type": "number" }` and
  the existing recursive filter structure;
- `numberFilter["~standard"].jsonSchema.input(...)` emits the same document;
- number lists emit the element primitive `{ "type": "number" }` — CORRECTED
  2026-08-27: this plan originally expected `{ "type": "array", "items": … }`,
  but the standards converter has never emitted an array representation for
  ANY scalar's list surface, and changing that for every scalar would violate
  this plan's own behavior-preservation constraint. The implemented contract
  (`tests/unit/validation/json-schema.core.test.ts:950`) pins the measured
  behavior; a future array/items emission is a converter feature, not part of
  this rename;
- the all-scalar conversion matrix includes the renamed number scalar on
  Draft-07, Draft 2020-12, and OpenAPI 3.0;
- recursive `not` remains represented through the existing `$ref`/`$defs`
  cycle machinery rather than being inlined;
- standard JSON Schema documents contain no VibORM scalar discriminator at all:
  their `{ "type": "number" }` member is JSON Schema's primitive keyword and
  value.

Keep one owner per invariant: the existing recursive-filter witness proves the
cycle machinery for every scalar filter, while the all-scalar target matrix
proves that the renamed number filter participates. Do not add a second
number-only cycle test.

### 6. Update query execution and result parsing

Replace the semantic discriminator in each consumer:

- SQL value and deferred-reference casts;
- scalar filter operator admission;
- primary-key arithmetic portability checks;
- strict provider result parsing;
- native result identity guards;
- cache value codecs;
- client result mappings;
- aggregate result types;
- diagnostic messages;
- decimal portability recommendations.

Rename implementation terms such as `floatGuard` to `numberGuard`. Retain terms
such as "floating-point precision" when they describe the underlying numeric
behavior rather than the retired API.

The adapter logical `numeric` cast remains unchanged. It still expresses the
database cast used for approximate JavaScript-number columns. Only comments
that call it the `float` scalar cast change to `number`.

### 7. Preserve migration compatibility

Replace the abstract migration mapping key `float` with `number` while returning
the same native SQL types:

```ts
PG_TYPE_DEFAULTS.number = PG.FLOAT.DOUBLE_PRECISION.type;
MYSQL_TYPE_DEFAULTS.number = "DOUBLE";
SQLITE_TYPE_DEFAULTS.number = SQLITE.FLOAT.REAL.type;
```

Keep the native `FLOAT` namespaces because their vocabulary belongs to the
database.

Add a migration contract that compares an existing physical snapshot with a
schema using `s.number()` and proves that the differ emits no operation. Schema
snapshots store physical column types rather than the scalar discriminator, so
no legacy `"float"` **migration-snapshot** reader is necessary. This does not
apply to Schema JSON documents, which do persist the discriminator and are
covered separately in step 4.

### 8. Migrate behavioral and type contracts

Replace `s.float()` and its semantic labels across the existing test estate.
Retain model field names only when `float` is intentionally arbitrary test data;
otherwise rename them to avoid teaching the retired vocabulary.

The adapted contracts must prove:

- finite integer and fractional values validate;
- non-finite values fail;
- nullable and array values retain their current shapes;
- custom schemas still transform and reject values correctly;
- filters and arithmetic updates behave identically;
- number field references accept number fields and reject incompatible scalar
  domains;
- provider strings decode to finite numbers;
- cache snapshots materialize the same numeric values;
- number relation keys retain their current write and read behavior;
- aggregates retain their current result types;
- PostgreSQL, MySQL, and SQLite retain their current DDL and round-trip behavior;
- Schema JSON parses, serializes, canonicalizes, and documents only
  `{ "type": "number" }` for this scalar;
- the old Schema JSON `{ "type": "float" }` node is refused with `J004`;
- standard JSON Schema conversion continues to emit the primitive
  `{ "type": "number" }` through both public conversion routes;
- the package surface contains no `float` factory or `FloatScalar` class.

Adapt existing contracts rather than adding a second assertion for an invariant
that already has one owner.

### 9. Update active documentation

Update:

- the project README;
- the scalar overview and number scalar page;
- numeric filtering documentation;
- decimal portability guidance;
- database migration-driver type tables;
- native-type documentation;
- compatibility guidance;
- internal scalar documentation;
- the `viborm/schema/json` format guide, scalar inventory, and examples;
- the Schema JSON architecture record's current factory inventory and canonical
  complete-surface document;
- `src/schema/AGENTS.md` where the Schema JSON format boundary is documented;
- `src/schema/scalars/AGENTS.md`.

Document the source migration explicitly:

```ts
// Before
const score = s.float();

// After
const score = s.number();
```

Also document advanced type migrations:

```ts
FloatScalar     -> NumberScalar
NumberScalar    -> NumericScalar // only for the former numeric-family union
"float"         -> "number"      // extension code inspecting scalar state
```

State that no database migration is needed because the physical column type is
unchanged. State separately that Schema JSON documents use `"number"`; because
the format is being updated before its first release, there is no supported v1
`"float"` document to migrate.

Historical architecture records should retain old names when those names are
the subject of the history. Current recommendations inside those records must
use `s.number()`.

## Verification

Run the relevant checks sequentially because the workspace launchers prohibit
overlapping Vitest and TypeScript processes:

```bash
pnpm test:layer:scalars
pnpm test:layer:schema-json
pnpm test:layer:validation
pnpm test:layer:operation-schemas
pnpm test:layer:query-engine
pnpm test:layer:migrations
pnpm test:layer:client
pnpm test:coverage:scalars
pnpm test:coverage:schema
pnpm test:coverage:validation
pnpm test:types
pnpm test:core
pnpm test:package
pnpm test:all
```

Then run focused stale-name scans over active source, tests, and documentation:

```bash
rg 's\.float|FloatScalar|FloatSchemas|buildFloatSchema' \
  src tests docs/content README.md

rg 'ScalarState<"float">|case "float"|state\.type === "float"' \
  src tests

rg 'type: "float"|"type": "float"' \
  src/schema/json tests/unit/schema-json tests/types/schema-json \
  docs/content/docs/schema/json.mdx

test ! -e src/schema/scalars/float
test ! -e src/validation/scalars/float.ts
```

Review the remaining uses of `float` manually. Every survivor must describe a
native database type, floating-point arithmetic, or a historical fact rather
than a live VibORM scalar.

## Completion Criteria

The replacement is complete when:

- `s.number()` is the only approximate JavaScript-number scalar;
- `s.float()`, `float()`, `FloatScalar`, `FloatSchemas`, and the `"float"`
  scalar discriminator are absent from the active product surface;
- `NumberScalar` names the concrete scalar and `NumericScalar` names the numeric
  family union;
- validation, filtering, updates, aggregates, caching, relations, and result
  parsing retain their previous behavior;
- Schema JSON version 1 accepts and emits `"number"`, refuses `"float"`, and
  retains its T1 and T2 round-trip guarantees;
- standard JSON Schema conversion remains `{ "type": "number" }` for the base,
  list, and operation-filter surfaces;
- generated and introspected SQL types are unchanged;
- an existing database or migration snapshot requires no migration;
- public type, package, layer, provider, coverage, and documentation checks pass.

## Separate Existing Defect

`ScalarTypeToTS` currently maps `decimal` to `number`, while database decimal
results are exact strings. Correcting that changes a public type contract and
must not be hidden inside this rename. Track and decide that correction
separately.
