# VibORM Schema Module

The schema module is the heart of VibORM — a fully type-safe, chainable API for defining database schemas in TypeScript. It provides the foundation for:

- **Type-safe schema definitions** with zero code generation
- **Runtime validation** via ArkType schemas
- **Prisma-like DX** with familiar patterns

---

## Table of Contents

1. [Overview](#overview)
2. [Quick Start](#quick-start)
3. [Architecture](#architecture)
4. [Scalars](#scalars)
   - [Scalar Types](#scalar-types)
   - [Scalar Modifiers](#scalar-modifiers)
   - [Auto-generation](#auto-generation)
   - [Native Database Types](#native-database-types)
   - [Custom Validators](#custom-validators)
5. [Models](#models)
   - [Model Definition](#model-definition)
   - [Model Modifiers](#model-modifiers)
   - [Compound Keys](#compound-keys)
   - [Indexes](#indexes)
6. [Relations](#relations)
   - [Relation Types](#relation-types)
   - [Relation Configuration](#relation-configuration)
   - [Many-to-Many Relations](#many-to-many-relations)
7. [Type System](#type-system)
   - [State-Based Generics](#state-based-generics)
   - [Input Types](#input-types)
   - [Result Types](#result-types)
   - [Type Inference Helpers](#type-inference-helpers)
8. [Validation](#validation)
   - [Rule Categories](#rule-categories)
   - [Using the Validator](#using-the-validator)
9. [Runtime Schemas](#runtime-schemas)
   - [ArkType Integration](#arktype-integration)
   - [Schema Building](#schema-building)
10. [Internal API (`~`)](#internal-api-)

---

## Overview

The schema module enables developers to define database schemas using a fluent, chainable TypeScript API:

```ts
import { s, TYPES } from "viborm";

const user = s.model({
  id: s.string().id().ulid(),
  email: s.string(TYPES.PG.STRING.CITEXT).unique(),
  name: s.string().nullable(),
  createdAt: s.dateTime().default(() => new Date()),
  posts: s.toMany(() => post),
});

const post = s.model({
  id: s.string().id().ulid(),
  title: s.string(),
  authorId: s.string(),
  author: s.toOne(() => user)
    .fields("authorId")
    .references("id"),
});
```

### Key Principles

| Principle | Description |
|-----------|-------------|
| **Zero Generation** | Types are inferred from schema, no codegen step required |
| **Single State Generic** | Each class uses one `State` generic for future-proofing |
| **Chainable API** | All modifiers return new instances, enabling fluent definitions |
| **Registry Validation** | Schema state feeds `SchemaRegistry` operation validation |
| **Database Agnostic** | Core abstractions work across PostgreSQL, MySQL, and SQLite |

For portable schemas, model keys, mapped table names, scalar and relation keys,
and mapped column names must be ASCII SQL identifiers (letters, digits, and
underscores, not starting with a digit) of at most 63 bytes. Names inherited
from `Object.prototype`, such as `constructor` and `toString`, are reserved to
prevent dictionary collisions at runtime.

---

## Quick Start

```ts
import { s, validateSchemaOrThrow } from "viborm";

// 1. Define a model with scalar fields
const user = s.model({
  id: s.string().id().ulid(),
  email: s.string().unique(),
  role: s.enum(["USER", "ADMIN"]).default("USER"),
}).map("users");

// 2. Validate schema (optional but recommended)
validateSchemaOrThrow([user]);

// 3. Access inferred types
type User = typeof user["~"]["infer"];
// { id: string; email: string; role: "USER" | "ADMIN" }
```

---

## Architecture

```
src/schema/
├── index.ts              # Main entry point, exports `s` builder
├── scalars/              # Scalar implementations
│   ├── base.ts           # Scalar union type & type guard
│   ├── common.ts         # ScalarState interface & helpers
│   ├── native-types.ts   # PG, MYSQL, SQLITE type constants
│   ├── string/           # StringScalar class + schemas
│   ├── int/, float/, decimal/, number/  # Numeric scalar classes
│   ├── boolean/          # BooleanScalar
│   ├── datetime/         # DateTimeScalar
│   ├── bigint/           # BigIntScalar
│   ├── json/             # JsonScalar (with StandardSchema support)
│   ├── blob/             # BlobScalar
│   ├── enum/             # EnumScalar
│   ├── point/            # PointScalar (geo)
│   └── vector/           # VectorScalar (for embeddings)
├── model/                # Model class & structural metadata
│   ├── model.ts          # Model class implementation
│   └── helper.ts         # ModelShape, extraction helpers (ScalarKeys, RelationKeys, etc.)
├── relation/             # The two relation factories and their state
│   ├── types.ts          # The closed declaration-state union
│   ├── to-one.ts         # s.toOne + its model-target terminal
│   ├── to-many.ts        # s.toMany + its model-target terminal
│   ├── polymorphic.ts    # Variant normalization + the two variant terminals
│   ├── terminal.ts       # Shared refusal vocabulary + target once-cell
│   ├── clearability.ts   # slotMayBeEmpty / clearableMembership
│   ├── junction-topology.ts  # Resolved junction physical facts
│   └── helpers.ts        # Junction physical naming
└── validation/           # Schema validation rules
    ├── validator.ts      # SchemaValidator class
    ├── types.ts          # ValidationError, ValidationResult
    └── rules/            # Individual validation rules (model, fk, relation, database)
```

**Note:** Operation input/result types (`ModelWhereInput`, `ModelCreateInput`, result
shapes, etc.) are no longer defined under `src/schema/`. That responsibility moved to
`src/validation/` — see [validation/AGENTS.md](../validation/AGENTS.md) and
`SchemaRegistry`. The "Input Types" / "Result Types" sections below describe the
current validation-layer equivalents where paths differ from `src/schema/`.

### The `s` Builder

The main entry point is the `s` object, which provides factory functions for all schema components:

```ts
export const s = {
  // Model factory
  model,

  // Scalars
  string, boolean, int, float, decimal, bigInt,
  dateTime, json, blob, enum: enumScalar, vector,

  // Relations — two factories; the argument states the target domain
  toOne, toMany,
};
```

---

## Scalars

Scalars represent database columns. Each scalar type has its own class with type-safe chainable modifiers.

### Scalar Types

| Scalar | TypeScript Type | Database Type |
|-------|----------------|---------------|
| `s.string()` | `string` | VARCHAR/TEXT |
| `s.int()` | `number` | INTEGER |
| `s.float()` | `number` | FLOAT/REAL |
| `s.decimal()` | `number` | DECIMAL/NUMERIC |
| `s.bigInt()` | `bigint` | BIGINT |
| `s.boolean()` | `boolean` | BOOLEAN |
| `s.dateTime()` | `Date` | TIMESTAMP |
| `s.json<T>()` | `T` / `unknown` | JSON/JSONB |
| `s.blob()` | `Uint8Array` | BYTEA/BLOB |
| `s.enum([...])` | Union type | ENUM |
| `s.vector()` | `number[]` | VECTOR |

### Scalar Modifiers

All modifiers return a new scalar instance with updated state:

```ts
s.string()
  .nullable()              // Allow NULL values
  .array()                 // Make it an array type
  .id()                    // Mark as primary key (implies unique)
  .unique()                // Add unique constraint
  .default("value")        // Static default value
  .default(() => value)    // Runtime default function
  .schema(schema)          // Custom StandardSchema validator
  .map("column_name")      // Custom database column name
```

### Auto-generation

String scalars support automatic ID generation:

```ts
s.string().id().uuid()    // Generate UUIDv4
s.string().id().ulid()    // Generate ULID (sortable)
s.string().id().nanoid()  // Generate NanoID (short)
s.string().id().cuid()    // Generate CUID
```

Integer scalars support auto-increment:

```ts
s.int().id().increment()  // Auto-incrementing integer
```

DateTime scalars support automatic timestamps:

```ts
s.dateTime().now()        // Default to current timestamp
s.dateTime().updatedAt()  // Update on every modification
```

### Native Database Types

Override the default database type mapping for specific databases:

```ts
import { TYPES } from "viborm";

// PostgreSQL
s.string(TYPES.PG.STRING.CITEXT)           // Case-insensitive text
s.string(TYPES.PG.STRING.VARCHAR(255))     // Limited varchar
s.string(TYPES.PG.STRING.UUID)             // Native UUID type
s.json(TYPES.PG.JSON.JSONB)                // Binary JSON

// MySQL  
s.string(TYPES.MYSQL.STRING.TEXT)          // TEXT instead of VARCHAR
s.int(TYPES.MYSQL.INT.TINYINT)             // Smaller integer
s.decimal(TYPES.MYSQL.DECIMAL.DECIMAL(10, 2))

// SQLite (limited type affinity)
s.string(TYPES.SQLITE.STRING.TEXT)
s.float(TYPES.SQLITE.FLOAT.REAL)
```

### Custom Validators

Scalars accept any [StandardSchema](https://standardschema.dev/) compliant validator:

```ts
import { z } from "zod";

s.string().schema(z.string().email())
s.string().schema(z.string().min(8).max(100))
```

### Scalar State

Every scalar tracks its configuration in a `ScalarState` object:

```ts
interface ScalarState {
  type: ScalarType;        // "string" | "int" | etc.
  nullable: boolean;
  array: boolean;
  hasDefault: boolean;
  isId: boolean;
  isUnique: boolean;
  defaultValue: any;
  autoGenerate: AutoGenerateType | undefined;
  schema: StandardSchemaV1 | undefined;
  columnName: string | undefined;
}
```

The state flows through the generic parameter, enabling compile-time type inference:

```ts
class StringScalar<State extends ScalarState<"string">> {
  nullable(): StringScalar<UpdateState<State, { nullable: true }>> {
    return new StringScalar({ ...this.state, nullable: true });
  }
}
```

---

## Models

Models represent database tables with fields: scalars and relations.

### Model Definition

```ts
const user = s.model({
  id: s.string().id().ulid(),
  name: s.string(),
  email: s.string().unique(),
  posts: s.toMany(() => post),
});
```

### Model Modifiers

```ts
s.model({ ... })
  .map("table_name")       // Database table name
  .index("email")          // Single-field index
  .index(["a", "b"])       // Composite index
  .index(["a"], { 
    name: "idx_custom",
    type: "gin",           // btree | hash | gin | gist
    unique: true 
  })
  .id(["orgId", "userId"]) // Compound primary key
  .unique(["a", "b"])      // Compound unique constraint
  .extends({ ... })        // Add more model members
```

### Compound Keys

Define composite primary keys and unique constraints:

```ts
const membership = s.model({
  orgId: s.string(),
  userId: s.string(),
  role: s.string(),
})
  .id(["orgId", "userId"])                        // Compound PK
  .unique(["orgId", "role"], { name: "org_role" }); // Named unique

// Query with compound key:
client.membership.findUnique({
  where: {
    orgId_userId: { orgId: "org1", userId: "user1" }
    // OR with custom name:
    // org_role: { orgId: "org1", role: "admin" }
  }
});
```

### Indexes

```ts
// Simple index
.index("email")

// Composite index
.index(["lastName", "firstName"])

// Named index with options
.index(["status", "createdAt"], {
  name: "idx_status_date",
  type: "btree",
  unique: false,
  where: "status != 'deleted'"  // Partial index (PostgreSQL)
})
```

---

## Relations

Relations define how models connect. VibORM uses a class hierarchy for type-safe relation methods.

### Relation Types

A declaration states TWO facts and no more: the slot cardinality its factory was
spelled with, and the target domain its argument names.

| Declaration | Returns | Example |
|----------|---------|---------|
| `s.toOne(() => model)` | Single object or null | Post → Author, User → Profile |
| `s.toMany(() => model)` | Array | User → Posts, Post ↔ Tags |
| `s.toOne({ ... })` | A discriminated union or null | Comment → Post or Video |
| `s.toMany({ ... })` | An array of discriminated members | Shelf → Books and Videos |

The familiar cardinality cells are readings of the PAIR, derived by
`validation/relation-resolution.ts`: `toOne`+`toOne` is one-to-one,
`toOne`+`toMany` is many-to-one/one-to-many, `toMany`+`toMany` is many-to-many.

### Relation Configuration

```ts
// Owner side (completes a foreign key — exactly one endpoint may)
s.toOne(() => user)
  .fields("authorId")              // FK scalar field-key on this model
  .references("id")                // Referenced scalar field-key on target
  .onDelete("cascade")             // cascade | setNull | restrict | noAction
  .onUpdate("cascade")

// Inverse side (no FK)
s.toMany(() => post)               // No configuration needed
```

There is no `.optional()` on a model-target relation: an owner's emptiness comes
from its foreign-key scalars, and a non-owner's is derived. There is no
`.unique()`: the paired slot cardinality is the one statement of remote
uniqueness. `.fields(...)` returns a transient stage that carries no relation
brand, so an incomplete foreign key can never reach `s.model()`.

### Many-to-Many Relations

Every junction override lives on ONE endpoint; the other reads the mirrored view:

```ts
const post = s.model({
  tags: s.toMany(() => tag)
    .through("post_tags")          // Junction table name
    .source("postId")              // This endpoint's FK column
    .target("tagId"),              // The other endpoint's FK column
});

const tag = s.model({
  posts: s.toMany(() => post),     // mirrors the configuration above
});
```

### Terminal Capability Surfaces

Four private terminals, reached only through the two factories:

```
s.toOne(() => model)  → .name(), .fields() → .references() → .onDelete()/.onUpdate()
s.toMany(() => model) → .name(), .through(), .source(), .target(), .onDelete(), .onUpdate()
s.toOne({ ... })      → .name(), .optional()
s.toMany({ ... })     → .name(), .through({ variant: { table, source, target } })
```

Only valid methods appear in IntelliSense, and every modifier is
last-call-wins: repeating one replaces its own fact instead of intersecting.

---

## Type System

The type system provides compile-time type inference without code generation.

### State-Based Generics

Both scalars and models use a single `State` generic pattern:

```ts
// Scalar state
class StringScalar<State extends ScalarState<"string">> { ... }

// Model state
class Model<State extends AnyModelState = ModelState> { ... }

interface ModelState<
  TShape extends ModelShape,
  TCompoundId extends CompoundConstraint | undefined,
  TCompoundUniques extends readonly CompoundConstraint[]
> {
  shape: TShape;
  compoundId: TCompoundId;
  compoundUniques: TCompoundUniques;
}
```

This pattern:
1. **Future-proofs** the API — adding state properties won't break `Model<any>`
2. **Simplifies** type signatures — one generic instead of many
3. **Enables** extraction helpers for accessing specific state parts

### Input Types

Located in `model/types/input-types.ts`:

| Type | Purpose |
|------|---------|
| `ModelCreateInput<T>` | Input for create operations |
| `ModelUpdateInput<T>` | Input for update operations |
| `ModelWhereInput<T>` | Filter conditions |
| `ModelWhereUniqueInput<T>` | Unique identifier (single unique scalar field) |
| `ModelWhereUniqueInputFull<M>` | Unique identifier (includes compound keys) |
| `ModelOrderBy<T>` | Sort order specification |

```ts
// Example: WhereInput
type UserWhere = ModelWhereInput<typeof user["~"]["state"]["shape"]>;
// {
//   id?: string | { equals?: string; not?: string; in?: string[]; ... };
//   email?: string | { contains?: string; startsWith?: string; ... };
//   AND?: UserWhere[];
//   OR?: UserWhere[];
//   NOT?: UserWhere;
// }
```

### Result Types

Located in `model/types/result-types.ts`:

| Type | Purpose |
|------|---------|
| `ModelBaseResult<T>` | All scalar fields (default) |
| `SelectResult<T, S>` | Selected fields only |
| `IncludeResult<T, I>` | Base + included relations |
| `InferResult<T, Args>` | Dispatches based on select/include |

```ts
// Without select/include → all scalar fields
type User = ModelBaseResult<UserFields>;
// { id: string; email: string; name: string | null }

// With select
type Selected = SelectResult<UserFields, { id: true; email: true }>;
// { id: string; email: string }

// With include
type WithPosts = IncludeResult<UserFields, { posts: true }>;
// { id: string; email: string; name: string | null; posts: Post[] }
```

### Type Inference Helpers

Located in `model/types/helpers.ts`:

```ts
// Extract from Model
ExtractScalarMap<M>        // Get scalar definitions
ExtractCompoundId<M>       // Get compound ID constraint
ExtractCompoundUniques<M>  // Get compound unique constraints

// Scalar analysis
ScalarKeys<T>              // Scalar field keys
RelationKeys<T>            // Keys of relations
UniqueScalarKeys<T>         // Keys marked as id or unique
NumericScalarKeys<T>       // Numeric scalar field keys

// Relation analysis
RelationCardinality        // "one" | "many" — the declared slot cardinality
ResolvedSlot               // One contextual (model, field) edge view

// Scalar type inference
InferScalarBase<F>         // Result type (what you get back)
InferFieldInput<F>         // Input type (what you can pass)
InferFieldCreate<F>        // Create input (handles defaults)
InferFieldFilter<F>        // Filter input type
InferFieldUpdate<F>        // Update input type
```

---

## Validation

The validation system checks schema correctness before runtime.

### Rule Categories

| Code | Category | Description |
|------|----------|-------------|
| **M0xx** | Model | Basic model structure |
| **F0xx** | Scalar | Scalar-level constraints |
| **I0xx** | Index | Index definitions |
| **R0xx** | Relation | Relation configuration |
| **JT0xx** | Junction | Many-to-many junction tables |
| **CM0xx** | Cross-model | Cross-model dependencies |
| **FK0xx** | Foreign Key | FK scalar field-key validation |
| **RA0xx** | Referential Action | onDelete/onUpdate rules |

### Key Validation Rules

```
M001  Model must have an ID field or compound ID
M002  Model must have at least one scalar field
M003  Duplicate registration is rejected before Map replacement
M005  Model name must be a valid identifier
M006  Model name cannot be reserved
M007  Mapped table name must be a valid identifier

F001  Field names must be valid identifiers
F002  ID definitions cannot conflict
F003  Two scalars cannot map to the same column
F004  A direct default must satisfy its scalar schema
F006  An ID cannot be nullable
F007  An ID cannot be an array
F008  Automatic generation without an ID produces a warning
F009  Mapped column names must be valid identifiers

I001  Index fields must exist in model
I002  Index names must be unique per model
I003  Compound ID/unique fields must exist

R002-R005  Each relation cardinality must have its inverse
R006       Relation target model must be registered
R007       Multiple relation pairs require names

FK001 FK scalar field-key must exist in model
FK002 Referenced scalar field-key must exist in target
FK003 FK scalar and referenced scalar types must match
```

### Using the Validator

```ts
import { validateSchema, validateSchemaOrThrow, SchemaValidator } from "viborm";

// Get all errors
const result = validateSchema({ user, post, profile });
if (!result.valid) {
  for (const error of result.errors) {
    console.log(`[${error.code}] ${error.model}: ${error.message}`);
  }
}

// Throw on first error
validateSchemaOrThrow({ user, post, profile });

// Custom validation
const validator = new SchemaValidator()
  .register("user", user)
  .register("post", post);
const customResult = validator.validate();
```

`validateSchemaOrThrow` throws `SchemaValidationError`. The error keeps an
immutable `issues` snapshot, uses `V4002`, and does not claim a Prisma code.
Database-specific schema restrictions are validated by the migration dialect
that owns them; the schema validator does not emit disconnected portability
warnings.

---

## Runtime Schemas

The schema module owns database structure and base scalar schemas. Runtime operation schemas are built by `SchemaRegistry` in `src/validation/`.

### Scalar Base Schemas

Each scalar stores its base value schema in state:

| Schema | Purpose |
|--------|---------|
| `base` | The base value type |

```ts
// Access the base scalar schema
const base = s.string().nullable()["~"].state.base;

// Validate at runtime
const result = base["~standard"].validate("hello");
if ("issues" in result) {
  console.error(result.issues);
}
```

### Operation Schema Building

Operation schemas are built from full model graph context:

```ts
import { createSchemaRegistry } from "@validation";

const registry = createSchemaRegistry({ user });
const schemas = registry.proxy.user;

// Available schemas:
schemas.core.create       // With required/optional handling
schemas.core.update       // All scalar fields optional + operations
schemas.core.where        // Full filter object
schemas.core.whereUnique  // id | email | compound_key
schemas.core.orderBy      // { id?: "asc" | "desc"; ... }
schemas.args.findMany     // Operation args
schemas.args.create       // Operation args with nested relation creates
```

The registry owns `filter`, `create`, `update`, relation, and model args schemas. The client/query-engine use it for operation validation.

---

## Internal API (`~`)

The `~` property exposes internal state for ORM machinery. It's not part of the public API and may change.

### Scalar Internals

```ts
const scalar = s.string().nullable().id();

scalar["~"].state        // ScalarState object
scalar["~"].state.base   // Base scalar schema
scalar["~"].nativeType   // Optional native DB type
```

### Model Internals

```ts
const model = s.model({ ... }).map("users");

model["~"].state.shape      // Model shape object
model["~"].state.scalars    // Scalar definitions object
model["~"].state.relations  // Relation definitions object
model["~"].state.tableName  // "users"
model["~"].state.indexes    // IndexDefinition[]
model["~"].state.compoundId // { fields: [...], name?: string } | undefined
model["~"].state.uniques    // CompoundConstraint[]
model["~"].state.infer      // Phantom type for inference
```

### Relation Internals

```ts
const rel = s.toOne(() => user).fields("authorId").references("id");

rel["~"].state.cardinality       // "one" | "many" — the factory that was called
rel["~"].state.target            // { kind: "model", getter } | { kind: "variants", entries }
rel["~"].state.name              // undefined | the disambiguating relation name
rel["~"].state.foreignKey        // undefined | { fields, references, onDelete?, onUpdate? }
rel["~"].state.junction          // undefined | ordinary junction overrides (toMany only)
rel["~"].state.optional          // undefined | true (variant toOne only)
rel["~"].settleTarget()          // Lazy once-cell over the target getter
```

The state stores NO source model — `.extends()` may reuse one terminal under
several models, so `(model, field)` is the whole contextual identity — and no
partner, ownership flag or derived optionality. Every derived view has one owner,
and each reads the RESOLVED slot the topology owner published:

```ts
slotMayBeEmpty(resolved);          // may this slot hold nothing — @schema/relation/clearability
clearableMembership(resolved);     // HOW a membership is emptied — same module
membershipCanBeCleared(resolved);  // the boolean projection of the above
```

---

## Summary

The schema module provides:

✅ **Type-safe schema definitions** with full TypeScript inference  
✅ **Chainable API** for fluent, declarative models  
✅ **Runtime validation** via ArkType schemas  
✅ **Comprehensive validation** with 50+ rules  
✅ **Database flexibility** with native type overrides  
✅ **Relation support** for all cardinalities  
✅ **Compound keys** with custom naming  
✅ **Future-proof architecture** with single-state generics

For more details on specific components, explore the source files or refer to the test suite in `/tests/schema/`.
