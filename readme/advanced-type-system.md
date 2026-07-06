# Advanced Type System for VibORM Scalars

This document explains the advanced generic type system designed for VibORM that enables complete type inference from schema definitions.

## Overview

The VibORM type system uses TypeScript's advanced generic capabilities to encode scalar states (nullable, list, ID, unique, default, auto-generate) directly in the type system. This allows for:

- **Complete Type Inference**: TypeScript can infer exact types from schema definitions
- **Type Safety**: All scalar configurations are validated at compile time
- **Chainable API**: Method chaining preserves and updates type information
- **No Code Generation**: Types are inferred, not generated

## Core Concepts

### Scalar State Configuration

Each scalar carries its configuration as type-level information:

```typescript
interface ScalarState<T = any> {
  BaseType: T; // The core TypeScript type (string, number, etc.)
  IsNullable: boolean; // Whether the scalar can be null
  IsList: boolean; // Whether the scalar is an array
  IsId: boolean; // Whether the scalar is an ID
  IsUnique: boolean; // Whether the scalar has a unique constraint
  HasDefault: boolean; // Whether the scalar has a default value
  AutoGenerate: AutoGenerateType | false; // Auto-generation strategy
}
```

### Type Modifiers

Type-level functions that transform scalar states:

```typescript
type MakeNullable<T extends ScalarState> = T & { IsNullable: true };
type MakeList<T extends ScalarState> = T & { IsList: true };
type MakeId<T extends ScalarState> = T & { IsId: true };
type MakeUnique<T extends ScalarState> = T & { IsUnique: true };
type MakeDefault<T extends ScalarState> = T & { HasDefault: true };
```

### Type Inference

The final TypeScript type is computed from the scalar state:

```typescript
type InferType<T extends ScalarState> = T["IsList"] extends true
  ? T["IsNullable"] extends true
    ? T["BaseType"][] | null
    : T["BaseType"][]
  : T["IsNullable"] extends true
  ? T["BaseType"] | null
  : T["BaseType"];
```

## Implementation Details

### Base Scalar Class

The base scalar class implements the type system:

```typescript
export abstract class BaseScalar<T extends ScalarState = any>
  implements BaseScalarType<T>
{
  public readonly __scalarState!: T; // Type-only property

  // Method chaining with type updates
  nullable(): BaseScalarType<MakeNullable<T>> {
    const newScalar = this.createInstance<MakeNullable<T>>();
    this.copyPropertiesTo(newScalar);
    (newScalar as any).isOptional = true;
    return newScalar;
  }

  // Type inference
  get infer(): InferType<T> {
    return {} as InferType<T>;
  }
}
```

### Concrete Scalar Implementation

```typescript
export class StringScalar<
  T extends ScalarState = DefaultScalarState<string>
> extends BaseScalar<T> {
  public scalarType = "string" as const;

  protected createInstance<U extends ScalarState>(): StringScalar<U> {
    return new StringScalar<U>();
  }
}
```

## Usage Examples

### Basic Scalar Types

```typescript
const name = string();
type NameType = typeof name.infer; // string

const optionalName = string().nullable();
type OptionalNameType = typeof optionalName.infer; // string | null

const tags = string().list();
type TagsType = typeof tags.infer; // string[]
```

### Complex Combinations

```typescript
const id = string().id().auto.ulid();
type IdType = typeof id.infer; // string

const categories = string().list().nullable().default([]);
type CategoriesType = typeof categories.infer; // string[] | null
```

### Schema Type Inference

```typescript
const userSchema = {
  id: string().id().auto.ulid(),
  email: string().email().unique(),
  name: string(),
  bio: string().nullable(),
  tags: string().list(),
  createdAt: dateTime().auto.now(),
};

// TypeScript infers the complete User type
type User = {
  [K in keyof typeof userSchema]: (typeof userSchema)[K]["infer"];
};

// Results in:
// type User = {
//   id: string;
//   email: string;
//   name: string;
//   bio: string | null;
//   tags: string[];
//   createdAt: Date;
// }
```

## Implementation Challenges

### Generic Complexity

The advanced type system requires:

- Complex generic constraints
- Type-level computations
- Conditional types
- Mapped types

### TypeScript Limitations

Current challenges include:

- Type instantiation depth limits
- Complex generic inference
- Method chaining type preservation
- Runtime/compile-time boundary

## Simplified Alternative

For immediate implementation, a simplified approach is recommended:

```typescript
interface ScalarConfig<
  T,
  IsNullable extends boolean = false,
  IsList extends boolean = false
> {
  baseType: T;
  isNullable: IsNullable;
  isList: IsList;
}

type InferScalarType<Config extends ScalarConfig<any, any, any>> =
  Config["isList"] extends true
    ? Config["isNullable"] extends true
      ? Config["baseType"][] | null
      : Config["baseType"][]
    : Config["isNullable"] extends true
    ? Config["baseType"] | null
    : Config["baseType"];
```

## Benefits

1. **No Code Generation**: Types are inferred directly from schema definitions
2. **Type Safety**: All scalar configurations are validated at compile time
3. **Developer Experience**: Full autocompletion and type checking
4. **Maintainability**: Schema changes automatically update types
5. **Performance**: No runtime overhead for type information

## Future Enhancements

- **Relation Type Inference**: Extend to relation fields
- **Validation Type Integration**: Include validator types in inference
- **Query Type Generation**: Infer query types from schema
- **Migration Types**: Type-safe database migrations

## Conclusion

The advanced type system provides a powerful foundation for type-safe ORM operations. While complex to implement initially, it offers significant benefits in developer experience and type safety. The simplified approach provides a practical stepping stone toward the full implementation.
