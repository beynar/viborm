# VibORM Generic Type System

This document explains the generic type system implementation that enables full type inference from schema definitions with field-specific type safety.

## Overview

VibORM uses a sophisticated generic type system combined with a hierarchical field class structure that provides:

1. Full TypeScript type inference without code generation
2. Field-specific method availability (prevents `boolean().max()`)
3. Complete type safety with autocompletion and compile-time error checking

## Field Class Hierarchy

### Base Architecture

```typescript
BaseField<T>               // Abstract base with common functionality
├── StringField<T>        // String-specific methods (regex, min/max length)
├── NumberField<T>        // Number-specific methods (min/max value)
├── BooleanField          // Only common methods
├── BigIntField           // Only common methods
├── DateTimeField         // Date-specific auto-generation
├── JsonField<T>          // JSON-specific functionality
├── BlobField             // Binary data
└── EnumField<TEnum>      // Enum values
```

### Type-Safe Field Creation

Each field type only exposes relevant methods:

```typescript
// String fields - only string-relevant methods
s.string()
  .min(5) // ✅ String length validation
  .max(100) // ✅ String length validation
  .regex(/\w+/) // ✅ String pattern validation
  .auto.uuid(); // ✅ String auto-generation

// Number fields - only number-relevant methods
s.int()
  .min(0) // ✅ Numeric range validation
  .max(1000) // ✅ Numeric range validation
  .auto.increment(); // ✅ Numeric auto-generation

// Boolean fields - only common methods
s.boolean()
  .default(true) // ✅ Common modifier
  .nullable(); // ✅ Common modifier
// No min/max/regex available - they don't make sense!
```

## How Type Inference Works

### 1. Field-Level Type Capture

Each specific field class captures its TypeScript type:

```typescript
s.string(); // StringField<string>
s.string().nullable(); // StringField<string | null>
s.int(); // NumberField<number>
s.boolean(); // BooleanField<boolean>
s.dateTime(); // DateTimeField<Date>
```

### 2. Model-Level Type Aggregation

The `Model<TFields>` class aggregates all field types:

```typescript
const userModel = s.model("user", {
  id: s.string().auto.uuid(), // StringField<string>
  name: s.string().nullable(), // StringField<string | null>
  age: s.int().min(0), // NumberField<number>
  isActive: s.boolean(), // BooleanField<boolean>
  createdAt: s.dateTime(), // DateTimeField<Date>
});
```

### 3. Type Extraction and Inference

The `ModelType<TFields>` utility extracts TypeScript types:

```typescript
type ModelType<TFields extends Record<string, Field | Relation<any>>> = {
  [K in keyof TFields]: TFields[K] extends BaseField<infer T>
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

### Union Field Types

The `Field<T>` type is a union of all possible field types:

```typescript
export type Field<T = any> =
  | BaseField<T>
  | StringField<any>
  | NumberField<any>
  | BooleanField
  | BigIntField
  | DateTimeField
  | JsonField<any>
  | BlobField
  | EnumField<any>;
```

This allows the type system to work with any field while maintaining specificity.

### Relation Type Integration

Relations work seamlessly with the field system:

```typescript
const userModel = s.model("user", {
  id: s.string().id(),
  posts: s.relation.many(() => postModel), // Relation<PostType[]>
});

const postModel = s.model("post", {
  id: s.string().id(),
  author: s.relation.one(() => userModel), // Relation<UserType>
  authorId: s.string(),
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
const user = s.model("user", {
  // ✅ All field-appropriate methods
  name: s
    .string()
    .min(1)
    .max(100)
    .regex(/^[A-Za-z\s]+$/),
  age: s.int().min(0).max(120),
  email: s.string().regex(/^[^\s@]+@[^\s@]+\.[^\s@]+$/),
  isVerified: s.boolean().default(false),
  balance: s.float().min(0.0),
  createdAt: s.dateTime().auto.now(),
});
```

### Prevented Errors

```typescript
// ❌ These would cause TypeScript compilation errors:

const invalidModel = s.model("invalid", {
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

- Field methods only available where they make sense
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

const user = s.model("user", {
  id: s.string().id().auto.ulid(),
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
const post = s.model("post", {
  id: s.string().id().auto.ulid(),
  title: s.string().min(1).max(200),
  content: s.string(),
  published: s.boolean().default(false),
  publishedAt: s.dateTime().nullable(),
  author: s.relation.one(() => user),
  authorId: s.string(),
  tags: s.relation.many(() => tag),
});

const tag = s.model("tag", {
  id: s.string().id().auto.ulid(),
  name: s.string().unique(),
  posts: s.relation.many(() => post),
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

This type system represents a significant advancement in ORM design, providing both compile-time safety and excellent developer experience while maintaining the familiar Prisma-like API.
