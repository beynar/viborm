# VibORM Type System

This document describes the conceptual framework of VibORM's type system, which provides full type safety without code generation by leveraging TypeScript's type inference capabilities.

## Table of Contents

1. [Core Principles](#core-principles)
2. [Model Types](#model-types)
3. [Operation Input Types](#operation-input-types)
4. [Filtering and Selection Types](#filtering-and-selection-types)
5. [Return Types](#return-types)
6. [Utility Types](#utility-types)
7. [Type Inference Strategy](#type-inference-strategy)
8. [Implementation Guide](#implementation-guide)
9. [TypeScript Patterns Reference](#typescript-patterns-reference)
10. [Complete Type Implementation List](#complete-type-implementation-list)
11. [Testing Strategy](#testing-strategy)

## Core Principles

VibORM's type system is built on these fundamental principles:

- **Schema-First Design**: All types are derived from your schema definition
- **Type Inference**: TypeScript's inference does the heavy lifting, minimizing explicit type annotations
- **Prisma Compatibility**: Types follow Prisma's conventions for familiarity and ease of adoption
- **Zero Code Generation**: Types are computed by TypeScript at development time, not build time

## Model Types

### Base Model Type

The base model type is the fundamental representation of your data. It maps directly to the structure of your model definition, with each field converted to its corresponding TypeScript type.

**Key characteristics:**

- Represents the shape of data returned from the database
- Fields match their corresponding scalar or relation definitions
- Optional and nullable fields are properly typed
- Relation fields are typed according to their cardinality (one, many)

**Example concept:**
A `User` model with `id`, `email`, and `posts` would have a model type representing these fields with their corresponding TypeScript types.

### Model Definition to Type Mapping

| Schema Definition       | TypeScript Type             |
| ----------------------- | --------------------------- |
| `s.string()`            | `string`                    |
| `s.number()`            | `number`                    |
| `s.boolean()`           | `boolean`                   |
| `s.date()`              | `Date`                      |
| `s.enum([...])`         | Union type                  |
| `s.string().optional()` | `string \| null`            |
| `s.relation.one(...)`   | Related model type          |
| `s.relation.many(...)`  | Array of related model type |

## Operation Input Types

Different database operations require different input structures. VibORM provides specialized types for each operation.

### CreateInput

Used when creating new records, this type reflects what data must be provided to create a valid record.

**Key characteristics:**

- Required scalars (non-nullable, non-default) must be provided
- Optional scalars (nullable or with defaults) can be omitted
- ID fields may be optional if auto-generated
- Relation fields are represented as nested inputs

### UpdateInput

Used for modifying existing records, this type is more permissive than CreateInput.

**Key characteristics:**

- All fields are optional, since you may want to update only some fields
- Supports scalar-level update operations (set, increment, etc.)
- Uses specialized types like `StringScalarUpdateOperationsInput` to represent operations
- Required scalars for create are still optional for update

### WhereUniqueInput

Used to identify a single record for operations like findUnique, update, or delete.

**Key characteristics:**

- Contains fields that can uniquely identify a record (like ID or unique fields)
- At least one identifier field must be provided
- Combinations of fields may form compound unique identifiers

### WhereInput

Used for filtering records in operations like findMany and count.

**Key characteristics:**

- All fields are optional, allowing flexible filtering
- Supports complex logical operations (AND, OR, NOT)
- Each field accepts simple values or complex filter conditions
- Nested filtering for relations

## Filtering and Selection Types

These types control what data to retrieve and how to filter it.

### Filter Types

Each scalar type has corresponding filter types that enable complex query conditions.

**Key characteristics:**

- String filters support operations like contains, startsWith, endsWith
- Number filters support comparison operations (gt, lt, gte, lte)
- Date filters support time-based comparisons
- Boolean filters support equality checks
- Filter types are recursively composable for complex conditions

### OrderBy Types

Control the sorting of results.

**Key characteristics:**

- Support ascending and descending order
- Can be applied to any scalar field
- Support sorting by relation aggregates (e.g., count of related records)
- Support nulls first/last behavior

### Select and Include Types

Control which fields to return in the result.

**Key characteristics:**

- Select allows specifying exactly which fields to return
- Include allows including related records
- Both can be nested to select specific fields from relations
- Affect the return type of the query, providing precise typing

## Return Types

The types returned from database operations depend on the operation and the selection criteria.

### Single Result Types

Operations like findUnique and findFirst return a single record or null.

**Key characteristics:**

- Return type matches the model type plus any included relations
- Type is narrowed based on select/include parameters
- May be null if no matching record is found

### Multiple Result Types

Operations like findMany return arrays of records.

**Key characteristics:**

- Array of the single result type
- May be empty array if no matching records
- Type reflects any select/include parameters

### Aggregation Result Types

Operations like count, sum, avg return computed values.

**Key characteristics:**

- Types reflect the specific aggregation operation
- Count returns a number
- Other aggregations return type-appropriate values (sum of numbers, etc.)

## Utility Types

### Operation Argument Types

Each database operation has a corresponding Args type that defines its parameters.

**Key characteristics:**

- Includes operation-specific parameters (where, data, select, etc.)
- Enforces required parameters
- Provides type safety for nested parameters

### Relation Types

Special types for handling relationships between models.

**Key characteristics:**

- Different types for different relation cardinalities (one, many)
- Support for nested operations (create related records, connect existing ones)
- Enforce referential integrity through TypeScript's type system

### Enumeration Types

Typed enumerations for various operations.

**Key characteristics:**

- Scalar field enums for referencing model fields
- Sort order enums for ordering results
- Query mode enums for different text search strategies

## Type Inference Strategy

Unlike Prisma, which generates types at build time, VibORM leverages TypeScript's type inference system:

1. **Type Template Construction**: VibORM defines generic type templates that are parameterized by your schema
2. **Schema Introspection**: The schema builder captures type information during model definition
3. **Type Inference**: TypeScript infers concrete types from the templates and your schema
4. **Type Propagation**: Types flow through your queries, ensuring end-to-end type safety

This approach eliminates the need for code generation while maintaining full type safety, providing a more seamless development experience.

## Implementation Guide

This section provides step-by-step guidance for implementing the VibORM type system.

### Step 1: Define Schema Representation Types

First, create types that represent the structure of your schema internally:

```ts
// Schema scalar types
type ScalarType = "string" | "number" | "boolean" | "date";
type RelationType = "one" | "many";

// Scalar definition structure
interface ScalarDefinition {
  type: ScalarType;
  optional?: boolean;
  unique?: boolean;
  id?: boolean;
  auto?: boolean;
}

interface RelationDefinition {
  type: RelationType;
  target: () => ModelDefinition;
  required?: boolean;
}

// Model structure
type FieldDefinition = ScalarDefinition | RelationDefinition;

interface ModelDefinition {
  name: string;
  fields: Record<string, FieldDefinition>;
}
```

### Step 2: Create Basic Scalar Type Mapping

Map schema scalar types to TypeScript types:

```ts
// Map scalar types to TypeScript types
type ScalarToTypeScript<T extends ScalarDefinition> = T["type"] extends "string"
  ? string
  : T["type"] extends "number"
  ? number
  : T["type"] extends "boolean"
  ? boolean
  : T["type"] extends "date"
  ? Date
  : never;

// Handle optional fields
type MakeOptional<
  T,
  TField extends ScalarDefinition
> = TField["optional"] extends true ? T | null : T;
```

### Step 3: Build Model Type

Create the base model type from the schema:

```ts
// Extract scalar fields from model
type ScalarMap<TModel extends ModelDefinition> = {
  [K in keyof TModel["fields"]]: TModel["fields"][K] extends ScalarDefinition
    ? TModel["fields"][K]
    : never;
};

// Extract relation fields
type RelationMap<TModel extends ModelDefinition> = {
  [K in keyof TModel["fields"]]: TModel["fields"][K] extends RelationDefinition
    ? TModel["fields"][K]
    : never;
};

// Build the complete model type
type ModelType<TModel extends ModelDefinition> = {
  [K in keyof ScalarMap<TModel>]: MakeOptional<
    ScalarToTypeScript<ScalarMap<TModel>[K]>,
    ScalarMap<TModel>[K]
  >;
} & {
  [K in keyof RelationMap<TModel>]?: RelationMap<TModel>[K]["type"] extends "many"
    ? Array<ModelType<ReturnType<RelationMap<TModel>[K]["target"]>>>
    : ModelType<ReturnType<RelationMap<TModel>[K]["target"]>>;
};
```

### Step 4: Implement CreateInput Type

Build input types for creating records:

```ts
// Required scalars for creation (non-optional, non-auto)
type RequiredCreateScalars<TModel extends ModelDefinition> = {
  [K in keyof ScalarMap<TModel>]: ScalarMap<TModel>[K]["optional"] extends true
    ? never
    : ScalarMap<TModel>[K]["auto"] extends true
    ? never
    : K;
}[keyof ScalarMap<TModel>];

// Optional scalars for creation
type OptionalCreateScalars<TModel extends ModelDefinition> = {
  [K in keyof ScalarMap<TModel>]: ScalarMap<TModel>[K]["optional"] extends true
    ? K
    : ScalarMap<TModel>[K]["auto"] extends true
    ? K
    : never;
}[keyof ScalarMap<TModel>];

// Create input type
type CreateInput<TModel extends ModelDefinition> =
  // Required scalars
  {
    [K in RequiredCreateScalars<TModel>]: ScalarToTypeScript<
      ScalarMap<TModel>[K]
    >;
  } & {
    // Optional scalars
    [K in OptionalCreateScalars<TModel>]?: MakeOptional<
      ScalarToTypeScript<ScalarMap<TModel>[K]>,
      ScalarMap<TModel>[K]
    >;
  } & {
    // Relation fields (all optional for create)
    [K in keyof RelationMap<TModel>]?: CreateNestedInput<
      ReturnType<RelationMap<TModel>[K]["target"]>,
      TModel
    >;
  };
```

### Step 5: Implement UpdateInput Type

Update inputs make all fields optional:

```ts
type UpdateInput<TModel extends ModelDefinition> = {
  [K in keyof ScalarMap<TModel>]?:
    | ScalarToTypeScript<ScalarMap<TModel>[K]>
    | ScalarUpdateOperations<ScalarToTypeScript<ScalarMap<TModel>[K]>>;
} & {
  [K in keyof RelationMap<TModel>]?: UpdateNestedInput<
    ReturnType<RelationMap<TModel>[K]["target"]>,
    TModel
  >;
};

// Scalar update operations
type ScalarUpdateOperations<T> = {
  set?: T;
} & (T extends number
  ? {
      increment?: T;
      decrement?: T;
      multiply?: T;
      divide?: T;
    }
  : {});
```

### Step 6: Implement WhereInput Type

Create flexible filtering types:

```ts
type WhereInput<TModel extends ModelDefinition> = {
  AND?: WhereInput<TModel> | WhereInput<TModel>[];
  OR?: WhereInput<TModel>[];
  NOT?: WhereInput<TModel> | WhereInput<TModel>[];
} & {
  [K in keyof ScalarMap<TModel>]?:
    | ScalarToTypeScript<ScalarMap<TModel>[K]>
    | FilterType<ScalarToTypeScript<ScalarMap<TModel>[K]>>;
} & {
  [K in keyof RelationMap<TModel>]?: RelationFilterType<
    ReturnType<RelationMap<TModel>[K]["target"]>,
    RelationMap<TModel>[K]["type"]
  >;
};

// Filter types for different scalar types
type FilterType<T> = T extends string
  ? StringFilter
  : T extends number
  ? NumberFilter
  : T extends boolean
  ? BooleanFilter
  : T extends Date
  ? DateFilter
  : never;
```

### Step 7: Create Utility Helper Types

Implement the foundational utility types:

```ts
// Require at least one of the specified keys
type AtLeast<T, K extends keyof T> = Partial<T> & Pick<T, K>;

// Exact type matching
type Exact<T, W> = T extends W ? (W extends T ? T : never) : never;

// Select subset utility
type SelectSubset<T, U> = T extends U ? T : never;

// Get scalar type from union
type GetScalarType<T, O> = T extends keyof O ? O[T] : never;
```

### Step 8: Implement Operation Args Types

Create argument types for database operations:

```ts
type FindManyArgs<TModel extends ModelDefinition> = {
  where?: WhereInput<TModel>;
  orderBy?: OrderByInput<TModel> | OrderByInput<TModel>[];
  take?: number;
  skip?: number;
  cursor?: WhereUniqueInput<TModel>;
  select?: ModelSelect<TModel>;
  include?: ModelInclude<TModel>;
};

type CreateArgs<TModel extends ModelDefinition> = {
  data: CreateInput<TModel>;
  select?: ModelSelect<TModel>;
  include?: ModelInclude<TModel>;
};

type UpdateArgs<TModel extends ModelDefinition> = {
  where: WhereUniqueInput<TModel>;
  data: UpdateInput<TModel>;
  select?: ModelSelect<TModel>;
  include?: ModelInclude<TModel>;
};
```

### Step 9: Build Result Types

Create types for query results:

```ts
// Base result type depends on select/include
type QueryResult<
  TModel extends ModelDefinition,
  TArgs extends { select?: any; include?: any }
> = TArgs["select"] extends object
  ? SelectResult<TModel, TArgs["select"]>
  : TArgs["include"] extends object
  ? IncludeResult<TModel, TArgs["include"]>
  : ModelType<TModel>;

// Select specific fields
type SelectResult<TModel extends ModelDefinition, TSelect> = {
  [K in keyof TSelect & keyof ModelType<TModel>]: ModelType<TModel>[K];
};

// Include relations
type IncludeResult<
  TModel extends ModelDefinition,
  TInclude
> = ModelType<TModel> & {
  [K in keyof TInclude &
    keyof RelationMap<TModel>]: RelationMap<TModel>[K]["type"] extends "many"
    ? Array<ModelType<ReturnType<RelationMap<TModel>[K]["target"]>>>
    : ModelType<ReturnType<RelationMap<TModel>[K]["target"]>>;
};
```

### Step 10: Integration with Schema Builder

Connect the type system to your schema builder:

```ts
// Schema builder method signature
interface SchemaBuilder {
  model<TName extends string, TFields>(
    name: TName,
    fields: TFields
  ): ModelDefinition & {
    __name: TName;
    __fields: TFields;
  };
}

// Usage example that maintains type safety
const userModel = s.model({
  id: s.string().id().auto(),
  email: s.string().unique(),
  name: s.string().optional(),
  posts: s.relation.many(() => postModel),
});

// The type system automatically infers:
// - UserCreateInput requires { email: string, name?: string | null }
// - UserUpdateInput makes all fields optional
// - UserWhereInput supports filtering on all fields
// - etc.
```

## TypeScript Patterns Reference

### Essential Patterns for Implementation

#### 1. Mapped Types

Transform object types by iterating over their properties:

```ts
// Make all properties optional
type Partial<T> = {
  [P in keyof T]?: T[P];
};

// Pick specific properties
type Pick<T, K extends keyof T> = {
  [P in K]: T[P];
};
```

#### 2. Conditional Types

Create types based on conditions:

```ts
// Basic conditional type
type IsString<T> = T extends string ? true : false;

// Nested conditionals for multiple types
type TypeName<T> = T extends string
  ? "string"
  : T extends number
  ? "number"
  : T extends boolean
  ? "boolean"
  : "object";
```

#### 3. Template Literal Types

Create string patterns:

```ts
// Create event names
type EventName<T extends string> = `on${Capitalize<T>}`;
// EventName<"click"> = "onClick"

// Create nested field paths
type ScalarPath<T> = T extends object
  ? {
      [K in keyof T]: K extends string
        ? T[K] extends object
          ? `${K}` | `${K}.${FieldPath<T[K]>}`
          : `${K}`
        : never;
    }[keyof T]
  : never;
```

#### 4. Recursive Types

Handle nested structures:

```ts
// Deep partial type
type DeepPartial<T> = {
  [P in keyof T]?: T[P] extends object ? DeepPartial<T[P]> : T[P];
};

// Nested relation handling
type NestedInclude<T> = {
  [K in keyof T]?: T[K] extends Array<infer U>
    ? boolean | { include?: NestedInclude<U> }
    : T[K] extends object
    ? boolean | { include?: NestedInclude<T[K]> }
    : boolean;
};
```

#### 5. Union Manipulation

Work with union types:

```ts
// Extract union members
type UnionToIntersection<U> = (U extends any ? (x: U) => void : never) extends (
  x: infer I
) => void
  ? I
  : never;

// Distribute over unions
type DistributeOver<T, U> = T extends any ? U<T> : never;
```

## Complete Type Implementation List

This section provides a comprehensive list of all types that need to be implemented for VibORM. Instead of generating types per model, VibORM uses generic types that infer the correct structure based on the model schema.

### Generic Model Types

These generic types work with any model by taking the model schema as a type parameter:

#### Core Model Types

- `ModelType<TModel>` - Base model type representing the data structure
- `ModelPayload<TModel>` - Internal payload type for type computations
- `ModelSelect<TModel>` - Type for selecting specific fields
- `ModelInclude<TModel>` - Type for including related records
- `ModelOmit<TModel>` - Type for omitting specific fields

#### Input Types for Operations

- `CreateInput<TModel>` - Blended create input for scalar fields and supported relation data
- `CreateManyInput<TModel>` - Input for batch create operations
- `UpdateInput<TModel>` - Blended update input for scalar fields and supported relation data
- `UpdateManyMutationInput<TModel>` - Input for batch update operations
- `UpsertInput<TModel>` - Input for upsert operations

#### Where and Filter Types

- `WhereInput<TModel>` - General filtering input
- `WhereUniqueInput<TModel>` - Input for unique identification
- `OrderByWithRelationInput<TModel>` - Ordering with relation support
- `OrderByWithAggregationInput<TModel>` - Ordering with aggregation support
- `ScalarWhereWithAggregatesInput<TModel>` - Scalar filtering with aggregates

#### Relation-Specific Types

- `CreateNestedOneInput<TModel, TRelation>` - Nested creation for one-to-one/many relations
- `CreateNestedManyInput<TModel, TRelation>` - Nested creation for one-to-many relations
- `UpdateOneRequiredNestedInput<TModel, TRelation>` - Conceptual required nested update type; nested `update` is not in the current public contract
- `UpdateOneOptionalNestedInput<TModel, TRelation>` - Conceptual optional nested update type; nested `update` is not in the current public contract
- `UpdateManyNestedInput<TModel, TRelation>` - Conceptual batch nested update type; nested `updateMany` is not in the current public contract
- `CreateOrConnectInput<TModel, TRelation>` - Create or connect operations
- `UpsertNestedInput<TModel, TRelation>` - Conceptual upsert in relation context; nested `upsert` is not in the current public contract
- `CreateWithoutInput<TModel, TRelation>` - Create input without a specific relation
- `UpdateWithoutInput<TModel, TRelation>` - Update input without a specific relation

#### Aggregation Types

- `CountAggregateInput<TModel>` - Input for count aggregation
- `CountAggregateOutput<TModel>` - Output for count aggregation
- `MinAggregateInput<TModel>` - Input for min aggregation
- `MinAggregateOutput<TModel>` - Output for min aggregation
- `MaxAggregateInput<TModel>` - Input for max aggregation
- `MaxAggregateOutput<TModel>` - Output for max aggregation
- `SumAggregateInput<TModel>` - Input for sum aggregation (numeric fields)
- `SumAggregateOutput<TModel>` - Output for sum aggregation
- `AvgAggregateInput<TModel>` - Input for average aggregation (numeric fields)
- `AvgAggregateOutput<TModel>` - Output for average aggregation
- `AggregateResult<TModel>` - Combined aggregation result type

#### Operation Argument Types

- `FindUniqueArgs<TModel>` - Arguments for findUnique operation
- `FindUniqueOrThrowArgs<TModel>` - Arguments for findUniqueOrThrow operation
- `FindFirstArgs<TModel>` - Arguments for findFirst operation
- `FindFirstOrThrowArgs<TModel>` - Arguments for findFirstOrThrow operation
- `FindManyArgs<TModel>` - Arguments for findMany operation
- `CreateArgs<TModel>` - Arguments for create operation
- `CreateManyArgs<TModel>` - Arguments for createMany operation (the optional `select` makes it return rows instead of `{ count }`)
- `UpdateArgs<TModel>` - Arguments for update operation
- `UpdateManyArgs<TModel>` - Arguments for updateMany operation (the optional `select` makes it return rows instead of `{ count }`)
- `UpsertArgs<TModel>` - Arguments for upsert operation
- `DeleteArgs<TModel>` - Arguments for delete operation
- `DeleteManyArgs<TModel>` - Arguments for deleteMany operation
- `AggregateArgs<TModel>` - Arguments for aggregate operation
- `GroupByArgs<TModel>` - Arguments for groupBy operation
- `CountArgs<TModel>` - Arguments for count operation

#### Enumeration Types

- `ScalarFieldEnum<TModel>` - Union type of all scalar field names
- `OrderByRelevanceFieldEnum<TModel>` - Union type for text search relevance ordering

#### Delegate and Client Types

- `ModelDelegate<TModel>` - Model-specific database operations interface
- `ModelClient<TModel>` - Promise-like client for chained operations

### Global Utility Types

These types are shared across all models:

#### Scalar Filter Types

- `StringFilter` - String scalar filtering operations
- `StringNullableFilter` - Nullable string scalar filtering
- `IntFilter` - Integer scalar filtering operations
- `IntNullableFilter` - Nullable integer scalar filtering
- `FloatFilter` - Float scalar filtering operations
- `FloatNullableFilter` - Nullable float scalar filtering
- `BoolFilter` - Boolean scalar filtering operations
- `BoolNullableFilter` - Nullable boolean scalar filtering
- `DateTimeFilter` - DateTime scalar filtering operations
- `DateTimeNullableFilter` - Nullable DateTime scalar filtering
- `EnumFilter` - Enum scalar filtering operations
- `EnumNullableFilter` - Nullable enum scalar filtering

#### Scalar Update Types

- `StringScalarUpdateOperationsInput` - String scalar update operations
- `NullableStringScalarUpdateOperationsInput` - Nullable string scalar updates
- `IntScalarUpdateOperationsInput` - Integer scalar update operations
- `NullableIntScalarUpdateOperationsInput` - Nullable integer scalar updates
- `FloatScalarUpdateOperationsInput` - Float scalar update operations
- `NullableFloatScalarUpdateOperationsInput` - Nullable float scalar updates
- `BoolScalarUpdateOperationsInput` - Boolean scalar update operations
- `NullableBoolScalarUpdateOperationsInput` - Nullable boolean scalar updates
- `DateTimeScalarUpdateOperationsInput` - DateTime scalar update operations
- `NullableDateTimeScalarUpdateOperationsInput` - Nullable DateTime scalar updates
- `EnumScalarUpdateOperationsInput` - Enum scalar update operations
- `NullableEnumScalarUpdateOperationsInput` - Nullable enum scalar updates

#### Relation Filter Types

- `ListRelationFilter<TModel>` - Filtering for one-to-many relations
- `RelationFilter<TModel>` - Filtering for one-to-one relations
- `NullableRelationFilter<TModel>` - Filtering for optional relations

#### Sorting and Ordering Types

- `SortOrder` - Enum for ascending/descending sort
- `SortOrderInput` - Input with nulls positioning
- `QueryMode` - Enum for case sensitivity in text queries
- `NullsOrder` - Enum for null value positioning

#### Operation Result Types

- `BatchPayload` - Result type for batch operations
- `AffectedRowsOutput` - Output showing affected row count

#### Generic Helper Types

- `AtLeast<T, K>` - Utility type requiring at least one of the specified keys
- `Exact<T, W>` - Utility type for exact type matching
- `CheckSelect<T, S, U>` - Type checking for select operations
- `SelectSubset<T, U>` - Subset selection utility
- `GetScalarType<T, O>` - Extract scalar types
- `GetResult<T, A, O>` - Compute result types
- `BasePromise<T>` - Promise-like type for chaining operations
- `TypeMap` - Type mapping for extensions

#### Extension and Middleware Types

- `Extensions` - Type for client extensions
- `ModelExtension<T>` - Type for model-specific extensions
- `ClientExtension` - Type for client-level extensions
- `MiddlewareParams` - Parameters for middleware functions
- `Middleware<T>` - Middleware function type

#### Transaction Types

- `TransactionClient` - Client interface within transactions
- The portable `$transaction` API intentionally exposes no options type;
  provider-specific timeout, isolation, and access-mode settings are outside
  the cross-database contract

This list describes the intended VibORM type surface. It is Prisma-inspired, but it does not claim complete equivalence with Prisma's generated helper types.

## Testing Strategy

### Unit Testing Types

Create test files to verify type behavior:

```ts
// tests/types/user.test.ts
import { expectType, expectError } from "tsd";
import { CreateInput, UpdateInput, WhereInput } from "../src/types";
import { UserModel } from "../src/models";

// Test CreateInput requires email but not id (auto-generated)
expectType<CreateInput<UserModel>>({
  email: "test@example.com",
  name: "John Doe",
});

expectError<CreateInput<UserModel>>({
  name: "John Doe", // Missing required email
});

// Test UpdateInput makes all fields optional
expectType<UpdateInput<UserModel>>({
  email: "new@example.com",
});

expectType<UpdateInput<UserModel>>({
  name: null, // Can set optional field to null
});

// Test WhereInput accepts filters
expectType<WhereInput<UserModel>>({
  email: { contains: "@example.com" },
  AND: [{ name: { not: null } }, { id: { in: ["1", "2", "3"] } }],
});
```

### Integration Testing

Test the complete type flow:

```ts
// tests/integration/query-types.test.ts
const result = await orm.user.findMany({
  where: { email: { contains: "@example.com" } },
  include: { posts: true },
});

// Verify result type includes posts
expectType<Array<UserModel & { posts: PostModel[] }>>(result);

// Test select narrows the return type
const selected = await orm.user.findMany({
  select: { id: true, email: true },
});

expectType<Array<{ id: string; email: string }>>(selected);
```

### Performance Testing

Monitor TypeScript compilation time:

```ts
// tests/performance/type-performance.test.ts
// Use TypeScript compiler API to measure compilation time
// Ensure complex type computations complete within reasonable time limits
// Set up benchmarks for different schema sizes
```

This comprehensive implementation guide provides junior developers with:

1. **Step-by-step implementation approach**
2. **Concrete code examples**
3. **Essential TypeScript patterns**
4. **Testing strategies**
5. **Integration guidance**

The improved document now serves both as a conceptual reference and a practical implementation guide.
