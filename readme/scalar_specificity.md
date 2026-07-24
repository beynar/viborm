# Scalar Type Specificity in VibORM

This document explains the new scalar class hierarchy that ensures type safety and prevents invalid method combinations like `boolean().max().min()`.

## Problem Statement

The original single `Scalar` class allowed nonsensical method combinations:

```typescript
// ❌ These made no sense but were allowed
s.boolean().max(10).min(0); // Boolean with numeric constraints
s.string().increment(); // String with auto-increment
s.int().regex(/\d+/); // Number with regex validation
```

## Solution: Hierarchical Scalar Classes

We now use a base class with specific implementations for each scalar type:

```
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

## Scalar-Specific Methods

### StringScalar

```typescript
const nameScalar = s
  .string()
  .min(2) // ✅ Minimum length
  .max(50) // ✅ Maximum length
  .regex(/^[A-Z]/) // ✅ Regex validation
  .auto.uuid(); // ✅ String auto-generation

// ❌ These are now TypeScript errors:
// nameScalar.increment()  // Not available on strings
// nameScalar.min(0)       // Would be ambiguous
```

### NumberScalar

```typescript
const ageScalar = s
  .int()
  .min(0) // ✅ Minimum value
  .max(120) // ✅ Maximum value
  .auto.increment(); // ✅ Number auto-generation

const priceScalar = s
  .float()
  .min(0.01) // ✅ Minimum value
  .max(9999.99); // ✅ Maximum value

// ❌ These are now TypeScript errors:
// ageScalar.regex(/\d+/)  // Not available on numbers
// ageScalar.uuid()        // Not available on numbers
```

### BooleanScalar

```typescript
const isActiveScalar = s
  .boolean()
  .default(true) // ✅ Common method
  .nullable(); // ✅ Common method

// ❌ These are now TypeScript errors:
// isActiveScalar.min(0)     // Not available on booleans
// isActiveScalar.max(1)     // Not available on booleans
// isActiveScalar.regex()    // Not available on booleans
```

### DateTimeScalar

```typescript
const createdAtScalar = s
  .dateTime()
  .auto.now() // ✅ Date-specific auto-generation
  .nullable(); // ✅ Common method

const updatedAtScalar = s.dateTime().auto.updatedAt(); // ✅ Date-specific auto-generation

// ❌ These are now TypeScript errors:
// createdAtScalar.min(0)    // Not available on dates
// createdAtScalar.regex()   // Not available on dates
```

## Common Methods (Available on All Scalars)

All scalar types inherit these methods from `BaseScalar`:

```typescript
anyScalar
  .nullable() // Makes scalar optional (T | null)
  .default(value) // Sets default value
  .unique() // Adds unique constraint
  .id() // Marks as primary key
  .list() // Makes scalar an array
  .schema(fn); // Adds custom validator
```

## Type Safety Benefits

### 1. Compile-Time Error Prevention

```typescript
// ✅ Valid combinations
const user = s.model({
  name: s.string().min(1).max(100),
  age: s.int().min(0).max(120),
  isActive: s.boolean().default(true),
});

// ❌ These would cause TypeScript errors:
// name: s.string().increment(),     // increment not on strings
// age: s.int().regex(/\d+/),        // regex not on numbers
// isActive: s.boolean().min(0),     // min not on booleans
```

### 2. Intelligent Auto-Completion

IDEs now show only relevant methods for each scalar type:

- **StringScalar**: Shows `min()`, `max()`, `regex()`, `auto.uuid()`, etc.
- **NumberScalar**: Shows `min()`, `max()`, `auto.increment()`, etc.
- **BooleanScalar**: Shows only common methods like `default()`, `nullable()`

### 3. Proper Type Inference

```typescript
const userModel = s.model({
  id: s.string().auto.uuid(), // StringScalar<string>
  name: s.string().nullable(), // StringScalar<string | null>
  age: s.int().min(0), // NumberScalar<number>
  isActive: s.boolean(), // BooleanScalar
});

type User = typeof userModel.infer;
// Correctly infers:
// {
//   id: string;
//   name: string | null;
//   age: number;
//   isActive: boolean;
// }
```

## Implementation Details

### Nullable Type Preservation

The `nullable()` method now preserves the specific scalar type:

```typescript
const scalar = s.string().min(5).nullable().max(10);
//    ^-- Still a StringScalar, so max() is available
```

### Auto-Generation by Type

Each scalar type has appropriate auto-generation options:

```typescript
// Strings
s.string().auto.uuid();
s.string().auto.ulid();
s.string().auto.nanoid();
s.string().auto.cuid();

// Numbers
s.int().auto.increment();

// Dates
s.dateTime().auto.now();
s.dateTime().auto.updatedAt();
```

### Validation Inheritance

Scalar-specific validation is automatically applied:

```typescript
const emailScalar = s
  .string()
  .regex(/^[^\s@]+@[^\s@]+\.[^\s@]+$/) // String validation
  .min(5); // String validation

// Validates both regex and length automatically
```

## Migration Guide

If you're migrating from the old system:

### Before (Generic Scalar)

```typescript
const scalar = s
  .string()
  .min(5) // Could be confusing - length or value?
  .max(100)
  .nullable();
```

### After (Specific Scalar)

```typescript
const scalar = s
  .string()
  .min(5) // Clearly length for strings
  .max(100) // Clearly length for strings
  .nullable();
```

## Benefits Summary

1. **Type Safety**: Prevents nonsensical method combinations at compile time
2. **Better DX**: IDE shows only relevant methods for each scalar type
3. **Clearer Intent**: Method names are unambiguous within their context
4. **Maintainability**: Easier to add scalar-specific features
5. **Performance**: No runtime checks needed for method validity

This new system ensures that your schema definitions are not only type-safe but also semantically correct and easy to understand.
