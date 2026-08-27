# VibORM Generic Type System

This document explains the generic type system implementation that enables full type inference from schema definitions with scalar-specific type safety.

## Overview

VibORM uses a sophisticated generic type system combined with a hierarchical scalar class structure that provides:

1. Full TypeScript type inference without code generation
2. Scalar-specific method availability (prevents `boolean().max()`)
3. Complete type safety with autocompletion and compile-time error checking

## Scalar Class Hierarchy

### Base Architecture

```typescript
BaseScalar<T>               // Abstract base with common functionality
├── StringScalar<T>        // String-specific methods (regex, min/max length)
├── NumberScalar<T>        // Number-specific methods (min/max value)
├── BooleanScalar          // Only common methods
├── BigIntScalar           // Only common methods
├── DateTimeScalar         // Date-specific auto-generation
├── JsonScalar<T>          // JSON-specific functionality
├── BlobScalar             // Binary data
└── EnumScalar<TEnum>      // Enum values
```

### Type-Safe Scalar Creation

Each scalar type only exposes relevant methods:

```typescript
// String scalars - only string-relevant methods
s.string()
  .min(5) // ✅ String length validation
  .max(100) // ✅ String length validation
  .regex(/\w+/) // ✅ String pattern validation
  .auto.uuid(); // ✅ String auto-generation

// Number scalars - only number-relevant methods
s.int()
  .min(0) // ✅ Numeric range validation
  .max(1000) // ✅ Numeric range validation
  .auto.increment(); // ✅ Numeric auto-generation

// Boolean scalars - only common methods
s.boolean()
  .default(true) // ✅ Common modifier
  .nullable(); // ✅ Common modifier
// No min/max/regex available - they don't make sense!
```

## How Type Inference Works

### 1. Scalar-Level Type Capture

Each specific scalar class captures its TypeScript type:

```typescript
s.string(); // StringScalar<string>
s.string().nullable(); // StringScalar<string | null>
s.int(); // NumberScalar<number>
s.boolean(); // BooleanScalar<boolean>
s.dateTime(); // DateTimeScalar<Date>
```

### 2. Model-Level Type Aggregation

The `Model<TFields>` class aggregates all field definitions:

```typescript
const userModel = s.model({
  id: s.string().auto.uuid(), // StringScalar<string>
  name: s.string().nullable(), // StringScalar<string | null>
  age: s.int().min(0), // NumberScalar<number>
  isActive: s.boolean(), // BooleanScalar<boolean>
  createdAt: s.dateTime(), // DateTimeScalar<Date>
});
```

### 3. Type Extraction and Inference

The `ModelType<TFields>` utility extracts TypeScript types:

```typescript
type ModelType<TFields extends Record<string, Scalar | Relation<any>>> = {
  [K in keyof TFields]: TFields[K] extends BaseScalar<infer T>
    ? T
    : TFields[K] extends Relation<infer R>
    ? R
    : never;
};

// Results in:
type UserType = {
  id: string;
  name: string | null;
  age: number;
  isActive: boolean;
  createdAt: Date;
};
```

## Advanced Type Features

### Union Scalar Types

The `Scalar<T>` type is a union of all possible scalar types:

```typescript
export type Scalar<T = any> =
  | BaseScalar<T>
  | StringScalar<any>
  | NumberScalar<any>
  | BooleanScalar
  | BigIntScalar
  | DateTimeScalar
  | JsonScalar<any>
  | BlobScalar
  | EnumScalar<any>;
```

This allows the type system to work with any scalar while maintaining specificity.

### Relation Type Integration

Relations work seamlessly with the field system:

```typescript
const userModel = s.model({
  id: s.string().id(),
  posts: s.toMany(() => postModel), // Collection slot
});

const postModel = s.model({
  id: s.string().id(),
  authorId: s.string(),
  author: s.toOne(() => userModel) // Singular slot; this side owns the FK
    .fields("authorId")
    .references("id"),
});
```

### Scalar vs Relation Separation

Type utilities help separate scalars from relations:

```typescript
// Extract only scalar fields
type UserScalars = ModelScalars<typeof userModel.fieldDefinitions>;
// { id: string; name: string | null; age: number; isActive: boolean; }

// Extract only relation fields
type UserRelations = ModelRelations<typeof userModel.fieldDefinitions>;
// { posts: PostType[]; }
```

## Compile-Time Safety Examples

### Valid Combinations

```typescript
const user = s.model({
  // ✅ All scalar-appropriate methods
  name: s
    .string()
    .min(1)
    .max(100)
    .regex(/^[A-Za-z\s]+$/),
  age: s.int().min(0).max(120),
  email: s.string().regex(/^[^\s@]+@[^\s@]+\.[^\s@]+$/),
  isVerified: s.boolean().default(false),
  balance: s.number().min(0.0),
  createdAt: s.dateTime().auto.now(),
});
```

### Prevented Errors

```typescript
// ❌ These would cause TypeScript compilation errors:

const invalidModel = s.model({
  // name: s.string().increment(),    // increment() not available on strings
  // age: s.int().regex(/\d+/),       // regex() not available on numbers
  // isActive: s.boolean().min(0),    // min() not available on booleans
  // createdAt: s.dateTime().max(10), // max() not available on dates
});
```

## Benefits Over Traditional ORMs

### 1. Zero Code Generation

- Types computed at development time by TypeScript
- No build step required for type updates
- Changes to schema immediately reflected in types

### 2. Semantic Correctness

- Scalar methods only available where they make sense
- Impossible to create semantically invalid schemas
- Self-documenting through available methods

### 3. Enhanced Developer Experience

- IntelliSense shows only relevant methods
- Compile-time errors prevent runtime issues
- Type inference reduces boilerplate

### 4. Incremental Development

- Types inferred as you build your schema
- No need to generate/regenerate types
- Instant feedback in IDE

## Usage Examples

### Basic Model Definition

```typescript
import { s } from "viborm";

const user = s.model({
  id: s.string().id().ulid(),
  email: s.string().regex(/^[^\s@]+@[^\s@]+\.[^\s@]+$/),
  age: s.int().min(13).max(120).nullable(),
  preferences: s.json<{ theme: string; notifications: boolean }>(),
  createdAt: s.dateTime().auto.now(),
  updatedAt: s.dateTime().auto.updatedAt(),
});

// TypeScript automatically infers:
type User = typeof user.infer;
// {
//   id: string;
//   email: string;
//   age: number | null;
//   preferences: { theme: string; notifications: boolean };
//   createdAt: Date;
//   updatedAt: Date;
// }
```

### Complex Relations

```typescript
const post = s.model({
  id: s.string().id().ulid(),
  title: s.string(),
  content: s.string(),
  published: s.boolean().default(false),
  publishedAt: s.dateTime().nullable(),
  authorId: s.string(),
  author: s.toOne(() => user)
    .fields("authorId")
    .references("id"),
  tags: s.toMany(() => tag)
    .through("post_tags")
    .source("postId")
    .target("tagId"),
});

const tag = s.model({
  id: s.string().id().ulid(),
  name: s.string().unique(),
  // The junction is configured once, on post.tags; this side mirrors it
  posts: s.toMany(() => post),
});

// Full type inference across relations:
type Post = typeof post.infer;
type Tag = typeof tag.infer;
```

## TypeScript Configuration

For optimal experience, use these `tsconfig.json` settings:

```json
{
  "compilerOptions": {
    "target": "ES2020",
    "strict": true,
    "exactOptionalPropertyTypes": true,
    "noUncheckedIndexedAccess": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true
  }
}
```

This type system aims to provide compile-time safety and a familiar Prisma-inspired API without cloning Prisma's generated helper type surface.
