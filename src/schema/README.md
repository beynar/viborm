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
4. [Fields](#fields)
   - [Field Types](#field-types)
   - [Field Modifiers](#field-modifiers)
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
  posts: s.oneToMany(() => post),
});

const post = s.model({
  id: s.string().id().ulid(),
  title: s.string(),
  authorId: s.string(),
  author: s.manyToOne(() => user)
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
| **Dual Schemas** | TypeScript types + ArkType runtime schemas stay in sync |
| **Database Agnostic** | Core abstractions work across PostgreSQL, MySQL, and SQLite |

---

## Quick Start

```ts
import { s, validateSchemaOrThrow } from "viborm";

// 1. Define fields
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
├── fields/               # Scalar field implementations
│   ├── base.ts           # Field union type & type guard
│   ├── common.ts         # FieldState interface & helpers
│   ├── native-types.ts   # PG, MYSQL, SQLITE type constants
│   ├── string/           # StringField class + schemas
│   ├── number/           # IntField, FloatField, DecimalField
│   ├── boolean/          # BooleanField
│   ├── datetime/         # DateTimeField
│   ├── bigint/           # BigIntField
│   ├── json/             # JsonField (with StandardSchema support)
│   ├── blob/             # BlobField
│   ├── enum/             # EnumField
│   └── vector/           # VectorField (for embeddings)
├── model/                # Model class & type infrastructure
│   ├── model.ts          # Model class implementation
│   ├── types/            # TypeScript type definitions
│   │   ├── helpers.ts    # Core type helpers (FieldRecord, extraction)
│   │   ├── input-types.ts    # Create, Where, Update inputs
│   │   ├── result-types.ts   # Query result types
│   │   ├── args-types.ts     # Operation argument types
│   │   └── ...
│   └── runtime/          # ArkType schema builders
│       ├── core-schemas.ts   # Base, filter, create schemas
│       ├── args-schemas.ts   # Operation args validation
│       └── mutation-schemas.ts
├── relation/             # Relation class hierarchy
│   ├── relation.ts       # ToOneRelation, OneToManyRelation, ManyToManyRelation
│   └── schemas.ts        # Relation filter schemas
└── validation/           # Schema validation rules
    ├── validator.ts      # SchemaValidator class
    ├── types.ts          # ValidationError, ValidationResult
    └── rules/            # Individual validation rules
```

### The `s` Builder

The main entry point is the `s` object, which provides factory functions for all schema components:

```ts
export const s = {
  // Model factory
  model,

  // Scalar fields
  string, boolean, int, float, decimal, bigInt,
  dateTime, json, blob, enum: enumField, vector,

  // Relations
  oneToOne, oneToMany, manyToOne, manyToMany,
};
```

---

## Fields

Fields represent scalar database columns. Each field type has its own class with type-safe chainable modifiers.

### Field Types

| Field | TypeScript Type | Database Type |
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

### Field Modifiers

All modifiers return a new field instance with updated state:

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

String fields support automatic ID generation:

```ts
s.string().id().uuid()    // Generate UUIDv4
s.string().id().ulid()    // Generate ULID (sortable)
s.string().id().nanoid()  // Generate NanoID (short)
s.string().id().cuid()    // Generate CUID
```

Integer fields support auto-increment:

```ts
s.int().id().increment()  // Auto-incrementing integer
```

DateTime fields support automatic timestamps:

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

Fields accept any [StandardSchema](https://standardschema.dev/) compliant validator:

```ts
import { z } from "zod";

s.string().schema(z.string().email())
s.string().schema(z.string().min(8).max(100))
```

### Field State

Every field tracks its configuration in a `FieldState` object:

```ts
interface FieldState {
  type: ScalarFieldType;        // "string" | "int" | etc.
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
class StringField<State extends FieldState<"string">> {
  nullable(): StringField<UpdateState<State, { nullable: true }>> {
    return new StringField({ ...this.state, nullable: true });
  }
}
```

---

## Models

Models represent database tables with fields and relations.

### Model Definition

```ts
const user = s.model({
  id: s.string().id().ulid(),
  name: s.string(),
  email: s.string().unique(),
  posts: s.oneToMany(() => post),
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
  .extends({ ... })        // Add more fields
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

VibORM uses a **config-first, getter-last** pattern for relations:

| Relation | Returns | Example |
|----------|---------|---------|
| `s.oneToOne()` | Single object or null | User → Profile |
| `s.oneToMany()` | Array | User → Posts |
| `s.manyToOne()` | Single object or null | Post → Author |
| `s.manyToMany()` | Array | Post ↔ Tags |

### Relation Configuration

```ts
// Owner side (has foreign key)
s.manyToOne(() => user)
  .fields("authorId")              // FK field on this model
  .references("id")                // Referenced field on target
  .onDelete("cascade")             // cascade | setNull | restrict | noAction
  .onUpdate("cascade")
  .optional()                      // Allow NULL (to-one only)

// Inverse side (no FK)
s.oneToMany(() => post)            // No configuration needed
```

### Many-to-Many Relations

```ts
const post = s.model({
  tags: s.manyToMany(() => tag)
    .through("post_tags")          // Junction table name
    .A("postId")                   // Source FK column
    .B("tagId"),                   // Target FK column
});
```

### Relation Class Hierarchy

```
Relation<G, T, TOptional>  (abstract base)
├── ToOneRelation          (oneToOne, manyToOne) - has .optional()
├── OneToManyRelation      (oneToMany) - no optional, no through
└── ManyToManyRelation     (manyToMany) - has .through(), .A(), .B()
```

This ensures only valid methods appear in IntelliSense:
- `.optional()` only on `oneToOne` / `manyToOne`
- `.through()`, `.A()`, `.B()` only on `manyToMany`

---

## Type System

The type system provides compile-time type inference without code generation.

### State-Based Generics

Both fields and models use a single `State` generic pattern:

```ts
// Field state
class StringField<State extends FieldState<"string">> { ... }

// Model state
class Model<State extends AnyModelState = ModelState> { ... }

interface ModelState<
  TFields extends FieldRecord,
  TCompoundId extends CompoundConstraint | undefined,
  TCompoundUniques extends readonly CompoundConstraint[]
> {
  fields: TFields;
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
| `ModelWhereUniqueInput<T>` | Unique identifier (single field) |
| `ModelWhereUniqueInputFull<M>` | Unique identifier (includes compound keys) |
| `ModelOrderBy<T>` | Sort order specification |

```ts
// Example: WhereInput
type UserWhere = ModelWhereInput<typeof user["~"]["fields"]>;
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
// Without select/include → all scalars
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
ExtractFields<M>           // Get field definitions
ExtractCompoundId<M>       // Get compound ID constraint
ExtractCompoundUniques<M>  // Get compound unique constraints

// Field analysis
ScalarFieldKeys<T>         // Keys of scalar fields
RelationKeys<T>            // Keys of relations
UniqueFieldKeys<T>         // Keys marked as id or unique
NumericFieldKeys<T>        // Keys of numeric fields

// Relation analysis
GetRelationFields<R>       // Target model's fields
GetRelationType<R>         // "oneToOne" | "oneToMany" | etc.
GetRelationOptional<R>     // Is relation optional?

// Field type inference
InferFieldBase<F>          // Result type (what you get back)
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
| **F0xx** | Field | Field-level constraints |
| **I0xx** | Index | Index definitions |
| **R0xx** | Relation | Relation configuration |
| **JT0xx** | Junction | Many-to-many junction tables |
| **SR0xx** | Self-ref | Self-referential relations |
| **CM0xx** | Cross-model | Cross-model dependencies |
| **FK0xx** | Foreign Key | FK field validation |
| **RA0xx** | Referential Action | onDelete/onUpdate rules |
| **DB0xx** | Database | Database-specific constraints |

### Key Validation Rules

```
M001  Model must have at least one field
M002  Model names must be unique
M003  Model name cannot be empty or reserved

F001  No duplicate field names
F002  Model must have exactly one ID (field or compound)
F003  Default value must match field type
F004  Only certain types support arrays (DB-specific)

I001  Index fields must exist in model
I002  Index names must be unique per model
I003  Compound ID/unique fields must exist

R001  Relation target model must exist
R002  Bidirectional relations should have inverse
R003  Relation names must be unique per model

FK001 FK field must exist in model
FK002 Referenced field must exist in target
FK003 FK and reference types must match
```

### Using the Validator

```ts
import { validateSchema, validateSchemaOrThrow, SchemaValidator } from "viborm";

// Get all errors
const result = validateSchema([user, post, profile]);
if (!result.valid) {
  for (const error of result.errors) {
    console.log(`[${error.code}] ${error.model}: ${error.message}`);
  }
}

// Throw on first error
validateSchemaOrThrow([user, post, profile]);

// Custom validation
const validator = new SchemaValidator([user, post], {
  rules: ['modelHasFields', 'modelHasId', 'relationTargetExists'],
  database: 'postgres'
});
const result = validator.validate();
```

---

## Runtime Schemas

The schema module generates ArkType schemas for runtime validation.

### ArkType Integration

Each field generates four schemas:

| Schema | Purpose |
|--------|---------|
| `base` | The base value type |
| `filter` | Where clause filter object |
| `create` | Create input (handles defaults) |
| `update` | Update input (set, increment, etc.) |

```ts
// Access field schemas
const { base, filter, create, update } = s.string().nullable().schemas;

// Validate at runtime
const result = create("hello");
if (result instanceof ArkErrors) {
  console.error(result.summary);
}
```

### Schema Building

Model schemas are lazily computed on first access:

```ts
// Access model schemas
const schemas = user["~"].schemas;

// Available schemas:
schemas.base         // { id: string; email: string; ... }
schemas.create       // With required/optional handling
schemas.update       // All fields optional + operations
schemas.where        // Full filter object
schemas.whereUnique  // id | email | compound_key
schemas.orderBy      // { id?: "asc" | "desc"; ... }
```

Runtime schema builders are in `model/runtime/`:

```ts
import { buildModelSchemas } from "./runtime";

const schemas = buildModelSchemas(userModel);
// Returns typed schemas for all operations
```

---

## Internal API (`~`)

The `~` property exposes internal state for ORM machinery. It's not part of the public API and may change.

### Field Internals

```ts
const field = s.string().nullable().id();

field["~"].state        // FieldState object
field["~"].schemas      // ArkType schemas
field["~"].nativeType   // Optional native DB type
```

### Model Internals

```ts
const model = s.model({ ... }).map("users");

model["~"].fields        // Field definitions object
model["~"].fieldMap      // Map<string, Field>
model["~"].relations     // Map<string, Relation>
model["~"].tableName     // "users"
model["~"].indexes       // IndexDefinition[]
model["~"].compoundId    // { fields: [...], name?: string } | undefined
model["~"].compoundUniques // CompoundConstraint[]
model["~"].schemas       // Lazily built ArkType schemas
model["~"].infer         // Phantom type for inference
```

### Relation Internals

```ts
const rel = s.manyToOne(() => user).fields("authorId").references("id");

rel["~"].getter          // () => Model (lazy reference)
rel["~"].relationType    // "manyToOne"
rel["~"].isToMany        // false
rel["~"].isToOne         // true
rel["~"].isOptional      // false
rel["~"].fields          // ["authorId"]
rel["~"].references      // ["id"]
rel["~"].onDelete        // undefined | ReferentialAction
rel["~"].onUpdate        // undefined | ReferentialAction
rel["~"].through         // Junction table (manyToMany only)
rel["~"].throughA        // Source FK column (manyToMany only)
rel["~"].throughB        // Target FK column (manyToMany only)
rel["~"].infer           // Phantom type for inference
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
