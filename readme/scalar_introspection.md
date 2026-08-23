# Scalar Introspection - Internal Accessor Pattern

## Overview

VibORM uses the `["~"]` accessor pattern to expose internal state and schemas for scalars, models, and relations. This pattern provides lazy-evaluated access to type information and validation schemas while keeping the public API clean.

## The `["~"]` Accessor

All schema components (scalars, models, relations) expose their internals through the `["~"]` getter:

```typescript
scalar["~"]    // Scalar internals
model["~"]     // Model internals  
relation["~"]  // Relation internals
```

## Scalar Introspection

### Accessing Scalar State

Scalar state contains the configuration set through chainable methods:

```typescript
import { s } from "viborm";

const scalar = s.string().nullable().unique().default("hello");

// Access scalar state via ["~"]
const state = scalar["~"].state;

console.log(state.type);        // "string"
console.log(state.nullable);    // true
console.log(state.isUnique);    // true
console.log(state.isId);        // false
console.log(state.array);       // false
console.log(state.default);     // "hello"
console.log(state.hasDefault);  // true
console.log(state.optional);    // true
console.log(state.autoGenerate); // undefined

// ID scalar with auto-generation
const idScalar = s.string().id().ulid();
console.log(idScalar["~"].state.isId);        // true
console.log(idScalar["~"].state.autoGenerate); // "ulid"

// Array scalar
const listScalar = s.string().array();
console.log(listScalar["~"].state.array);  // true
```

### Accessing Scalar Base Schemas

Scalar state stores the base schema. Operation schemas are composed by `SchemaRegistry`.

```typescript
const emailScalar = s.string();

// Base schema for the scalar type
emailScalar["~"].state.base; // VibSchema for string validation
```

### Scalar State Properties

| Property | Type | Description |
|----------|------|-------------|
| `type` | `string` | Scalar type: "string", "int", "boolean", etc. |
| `nullable` | `boolean` | Whether scalar accepts null |
| `array` | `boolean` | Whether scalar is an array |
| `isId` | `boolean` | Whether scalar is a primary key |
| `isUnique` | `boolean` | Whether scalar has unique constraint |
| `hasDefault` | `boolean` | Whether scalar has a default value |
| `default` | `any` | Default value or generator function |
| `optional` | `boolean` | Whether scalar is optional in create |
| `autoGenerate` | `string \| undefined` | Auto-generation type: "uuid", "ulid", "cuid", "nanoid", "autoIncrement", "now" |
| `columnName` | `string \| undefined` | Custom database column name (from `.map()`) |
| `schema` | `StandardSchema \| undefined` | Custom validation schema |

## Model Introspection

### Accessing Model State

```typescript
import { s } from "viborm";

const user = s.model({
  id: s.string().id().ulid(),
  name: s.string(),
  email: s.string().unique(),
  posts: s.toMany(() => post),
}).map("users");

// Access model internals
const internal = user["~"];

// Model state
console.log(internal.state.tableName);  // "users"
console.log(internal.state.fields);     // All model fields
console.log(internal.state.scalars);    // Scalars (no relations)
console.log(internal.state.relations);  // Relations
console.log(internal.state.uniques);    // Scalars with unique constraint
console.log(internal.state.indexes);    // Index definitions

// Cached scalar metadata
console.log(internal.scalarFieldNames);  // ["id", "name", "email"]
console.log(internal.scalarFieldSet);    // Set{"id", "name", "email"}
console.log(internal.relationNames);     // ["posts"]
console.log(internal.relationSet);       // Set{"posts"}

// Schema names (populated after hydration)
console.log(internal.names);  // { ts: "user", sql: "users" }
```

### Accessing Model Operation Schemas

```typescript
import { createSchemaRegistry } from "@validation";

const registry = createSchemaRegistry({ user });
const schemas = registry.proxy.user;

schemas.core.where;    // WHERE clause schema
schemas.core.create;   // Create input schema
schemas.core.update;   // Update input schema
schemas.core.select;   // Select schema
schemas.core.orderBy;  // OrderBy schema
schemas.args.findMany; // Operation args schema
```

### Getting Scalar/Relation Names

```typescript
// Get resolved names for a field
const scalarNames = user["~"].getFieldName("email");
console.log(scalarNames.ts);   // "email" (TypeScript name)
console.log(scalarNames.sql);  // "email" (SQL column name, or custom if .map() used)

// Get resolved names for a relation
const relNames = user["~"].getRelationName("posts");
console.log(relNames.ts);   // "posts"
console.log(relNames.sql);  // "posts"
```

## Relation Introspection

### Accessing Relation State

```typescript
import { s } from "viborm";

const author = s.toOne(() => user)
  .fields("authorId")
  .references("id")
  .onDelete("cascade");

// Access relation state
const state = author["~"].state;

console.log(state.cardinality);          // "one" (the factory that was called)
console.log(state.target.kind);          // "model"
console.log(state.target.getter);        // () => user (thunk to target model)
console.log(state.foreignKey.fields);    // ["authorId"] (FK fields on this model)
console.log(state.foreignKey.references);// ["id"] (referenced fields on target)
console.log(state.foreignKey.onDelete);  // "cascade"
console.log(state.foreignKey.onUpdate);  // undefined

// A collection slot carrying junction overrides
const tags = s.toMany(() => tag)
  .through("post_tags")
  .source("postId")
  .target("tagId");

const junctionState = tags["~"].state;
console.log(junctionState.cardinality);      // "many"
console.log(junctionState.junction.table);   // "post_tags" (junction table name)
console.log(junctionState.junction.source);  // "postId" (this endpoint's column)
console.log(junctionState.junction.target);  // "tagId" (the other endpoint's column)
```

The state carries what was DECLARED and nothing else. Whether this endpoint owns
the foreign key, who its partner is, and whether the slot may be empty are
derived by the schema-wide resolver, which publishes one `ResolvedSlot` per
`(model, field)`.

### Relation State Properties

Every arm shares two properties and adds only what its own arm may carry. An
absent property means the fact was not declared; trusted state never stores an
explicit `undefined`, a `false`, or an empty override object.

#### Shared by all four arms

| Property | Type | Description |
|----------|------|-------------|
| `cardinality` | `"one" \| "many"` | The factory that was called |
| `target` | `{ kind: "model", getter } \| { kind: "variants", entries }` | The target domain the argument named |
| `name` | `string \| undefined` | Pairing label, matched exactly on both endpoints |

#### Singular over one model (`s.toOne(() => Model)`)

| Property | Type | Description |
|----------|------|-------------|
| `foreignKey` | `{ fields, references, onDelete?, onUpdate? } \| undefined` | Present only on the owning endpoint |

#### Collection over one model (`s.toMany(() => Model)`)

| Property | Type | Description |
|----------|------|-------------|
| `junction` | `{ table?, source?, target?, onDelete?, onUpdate? } \| undefined` | Present only on the endpoint that configured the junction |

#### Variant targets (`s.toOne({ ... })` / `s.toMany({ ... })`)

| Property | Type | Description |
|----------|------|-------------|
| `target.entries` | `Record<string, { getter, storedValue, junction? }>` | Normalized variants; `storedValue` defaults to the public key |
| `optional` | `true \| undefined` | Singular variant slots only — the nullability of the private `(type, id)` pair |

## Introspection Patterns

### Analyzing a Scalar

```typescript
function analyzeScalar(scalar: Scalar) {
  const { state } = scalar["~"];
  
  console.log(`Type: ${state.type}`);
  console.log(`Nullable: ${state.nullable ?? false}`);
  console.log(`Unique: ${state.isUnique ?? false}`);
  console.log(`Primary Key: ${state.isId ?? false}`);
  console.log(`Array: ${state.array ?? false}`);
  
  if (state.hasDefault) {
    console.log(`Default: ${state.default}`);
  }
  
  if (state.autoGenerate) {
    console.log(`Auto-generate: ${state.autoGenerate}`);
  }
  
  if (state.columnName) {
    console.log(`Column name: ${state.columnName}`);
  }
}
```

### Analyzing a Model

```typescript
function analyzeModel(model: Model<any>) {
  const internal = model["~"];
  const { state } = internal;
  
  console.log(`Table: ${state.tableName ?? "(not mapped)"}`);
  console.log(`Scalars: ${internal.scalarFieldNames.join(", ")}`);
  console.log(`Relations: ${internal.relationNames.join(", ")}`);
  
  // Iterate scalars
  for (const [name, scalar] of Object.entries(state.scalars)) {
    const scalarState = scalar["~"].state;
    const optional = scalarState.nullable ? "?" : "";
    console.log(`  ${name}${optional}: ${scalarState.type}`);
  }
  
  // Iterate relations
  for (const [name, relation] of Object.entries(state.relations)) {
    const relState = relation["~"].state;
    console.log(`  ${name}: ${relState.type}`);
  }
}
```

### Checking Scalar Constraints

```typescript
function getRequiredScalars(model: Model<any>): string[] {
  const required: string[] = [];
  
  for (const [name, scalar] of Object.entries(model["~"].state.scalars)) {
    const state = scalar["~"].state;
    
    // Scalar is required if: not nullable, no default, no auto-generate
    if (!state.nullable && !state.hasDefault && !state.autoGenerate) {
      required.push(name);
    }
  }
  
  return required;
}
```

## Why `["~"]` Instead of Direct Properties?

1. **Clean public API**: User-facing methods (`.nullable()`, `.id()`, etc.) aren't cluttered with internal properties
2. **Lazy evaluation**: Schemas are built only when accessed, avoiding unnecessary work
3. **Namespace separation**: Internal state (`["~"].state`) is clearly separated from the chainable API
4. **Type safety**: The accessor return type is fully typed, enabling autocompletion
5. **Collision prevention**: The space-prefixed key `" ~"` can't collide with any field name

## Notes

- The `["~"]` accessor is a getter that returns a fresh object each time, but internal caches (like `_schemas`) are preserved
- Schemas are built lazily using the `??=` pattern for performance
- Model internals include helper methods like `getFieldName()` and `getRelationName()` for name resolution
- All state objects are read-only at runtime; modifications have no effect
