# VibORM Validation Library

A minimal, StandardSchema-compliant validation library designed for the VibORM project.

## Features

- **Recursive type support**: Thunks for circular references (no separate `lazy` needed)
- **Fail-fast validation**: Throws on first error for optimized performance
- **Options-based API**: Clean, non-verbose schema definitions
- **Strict objects by default**: Extra keys are rejected
- **StandardSchema v1 compliant**: Works with any StandardSchema consumer
- **Minimal runtime footprint**: Small monadic functions

## Usage

```typescript
import { v } from "viborm/validation";
// Or import individual schemas
import { string, number, object, date, instance } from "viborm/validation";

// Simple schemas
const name = v.string();
const age = v.number();
const active = v.boolean();
const id = v.bigint();

// With options
const optionalName = v.string({ optional: true });
const nullableAge = v.number({ nullable: true });
const tags = v.string({ array: true });
const defaultStatus = v.string({ default: "pending" });
const upperName = v.string({ transform: (s) => s.toUpperCase() });

// Date & Time
const createdAt = v.date();                    // JavaScript Date object
const timestamp = v.isoTimestamp();            // "2023-12-15T10:30:00.000Z"
const birthDate = v.isoDate();                 // "2023-12-15"
const startTime = v.isoTime();                 // "10:30:00"

// Instance (for Buffer, Uint8Array, etc.)
const buffer = v.instance(Uint8Array);
const blob = v.union([v.instance(Uint8Array), v.instance(Buffer)]);

// Objects
const user = v.object({
  name: v.string(),
  age: v.number({ optional: true }),
  email: v.string(),
});

// Circular references using thunks (no lazy() needed!)
const node = v.object({
  value: v.string(),
  children: v.array(() => node),  // Thunk for self-reference
});

// Mutual references
const model1 = v.object({
  name: v.string(),
  friend: () => model2,  // Thunk for forward reference
});

const model2 = v.object({
  name: v.string(),
  friend: () => model1,  // Thunk for back reference
});
```

## Available Schemas

### Scalars

| Schema | Description | Options |
|--------|-------------|---------|
| `string()` | String values | `optional`, `nullable`, `array`, `default`, `transform` |
| `number()` | Number values (no NaN) | Same as above |
| `integer()` | Integer values | Same as above |
| `boolean()` | Boolean values | Same as above |
| `bigint()` | BigInt values | Same as above |
| `literal(value)` | Exact literal match | Same as above |
| `null_()` | Null value only | - |

### Date & Time

| Schema | Description | Format |
|--------|-------------|--------|
| `date()` | JavaScript Date object | `new Date()` |
| `isoTimestamp()` | ISO timestamp string | `2023-12-15T10:30:00.000Z` |
| `isoDate()` | ISO date string | `2023-12-15` |
| `isoTime()` | ISO time string | `10:30:00` |

### Instance

| Schema | Description |
|--------|-------------|
| `instance(Class)` | Instance of a class (Uint8Array, Buffer, etc.) |

### Wrappers

| Schema | Description |
|--------|-------------|
| `array(schema)` | Array of schema type (supports thunks) |
| `nullable(schema, default?)` | Allows null (supports thunks) |
| `optional(schema, default?)` | Allows undefined (supports thunks) |

### Objects

| Schema | Description |
|--------|-------------|
| `object(entries)` | Object with entries, strips unknown keys |
| `strictObject(entries)` | Object with entries, rejects unknown keys |
| `partial(objectSchema)` | Makes all fields optional |

### Composition

| Schema | Description |
|--------|-------------|
| `union([schemas])` | First matching schema wins |
| `pipe(schema, ...actions)` | Chain transforms |
| `transform(fn)` | Transform action for pipe |
| `record(keySchema, valueSchema)` | Dynamic key-value pairs |

## Type Inference

Types are inferred using StandardSchemaV1:

```typescript
import type { StandardSchemaV1 } from "@standard-schema/spec";

const user = v.object({
  name: v.string(),
  age: v.number(),
});

type UserInput = StandardSchemaV1.InferInput<typeof user>;
type UserOutput = StandardSchemaV1.InferOutput<typeof user>;
// Both are: { name: string; age: number }
```

## Circular Reference Support

The library supports circular references through **thunks** (`() => schema`).
No separate `lazy()` function needed - just use arrow functions!

```typescript
// Self-reference
const node = v.object({
  value: v.string(),
  child: v.optional(() => node),  // Thunk
});

// Mutual references
const user = v.object({
  name: v.string(),
  posts: v.array(() => post),  // Thunk
});

const post = v.object({
  title: v.string(),
  author: () => user,  // Thunk (works directly in object entries)
});

// Types are correctly inferred (no `any`)
type User = StandardSchemaV1.InferOutput<typeof user>;
type Post = StandardSchemaV1.InferOutput<typeof post>;
```

## Key Implementation Details

### Branded Types

We use a string literal branded property for type inference:

```typescript
const inferred = " vibInferred" as const;

interface VibSchema<TInput, TOutput> {
  [inferred]: [TInput, TOutput]; // Carries both types
}
```

### No Constraint on Object Entries

The object function's generic has no direct constraint:

```typescript
function object<const Def>(entries: Def): ObjectSchema<...>
```

This allows TypeScript to defer evaluation during circular resolution.

### StandardSchema Only

All validation happens in `~standard.validate`. There's no internal `~run` method, reducing code duplication.

### Thunks Everywhere

All wrappers (`array`, `nullable`, `optional`) and object entries support thunks.
This means you can use `() => schema` anywhere circular references are needed.

## Validation

```typescript
const schema = v.object({ name: v.string() });

const result = schema["~standard"].validate({ name: "Alice" });

if (result.issues) {
  console.error("Validation failed:", result.issues);
} else {
  console.log("Valid:", result.value);
}
```

## Comparison with Valibot

| Feature | VibORM | Valibot |
|---------|--------|---------|
| Circular references | ✅ Thunks | ❌ Broken |
| StandardSchema | ✅ Only | ✅ + `~run` |
| Options API | ✅ `{ optional, nullable, array }` | ❌ Wrappers |
| Bundle size | Minimal | Small |
| Fail-fast | ✅ First error | ✅ Configurable |
