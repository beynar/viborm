# BaseORM Client Type System Implementation Guide

## Overview

This guide describes the implementation strategy for BaseORM's generic type system that dynamically infers all query, mutation, and result types from model definitions. Unlike Prisma's generated approach, BaseORM uses TypeScript's type inference to create a fully type-safe ORM without code generation.

## Core Philosophy

- **Model-Driven Types**: All types are derived from schema model definitions
- **Generic Architecture**: Single type definitions work with any model via generics
- **Dynamic Inference**: TypeScript infers specific types based on model structure
- **Zero Generation**: No code generation step required
- **Prisma Compatibility**: API surface matches Prisma for familiarity

## Type System Architecture

### 1. Foundation Types

#### 1.1 Model Extraction Types

**Purpose**: Extract type information from the actual Model and BaseField classes
**What they do**:

- Extract the generic type parameter from Model instances to get field definitions
- Separate fields from relations based on BaseField vs Relation instances
- Extract model names and metadata
- Provide foundation for all other type inference

**Key Types Needed**:

- `ModelDefinition`: Type alias for Model<any>
- `FieldDefinition`: Type alias for BaseField<any>
- `ExtractFields`: Extracts only BaseField instances from model definition
- `ExtractRelations`: Extracts only Relation instances from model definition
- `ExtractModelName`: Gets the model name string

#### 1.2 Type Mapping Utilities

**Purpose**: Bridge between BaseField instances and TypeScript types
**What they do**:

- Use the existing FieldState system to infer TypeScript types
- Map BaseField instances to their inferred types for queries
- Map BaseField instances to their input types for mutations
- Extract field metadata like nullable, unique, id status
- Provide helpers for determining required vs optional fields

**Key Types Needed**:

- `MapFieldType`: BaseField → inferred TypeScript type for queries
- `MapFieldInputType`: BaseField → input type for create/update operations
- `MapFieldStorageType`: BaseField → database storage type
- `IsFieldNullable`: Extract nullable status from field state
- `IsFieldUnique`: Extract unique status from field runtime properties
- `IsFieldId`: Extract ID status from field runtime properties
- `GetUniqueFields`: Find all unique/id fields in a model
- `GetRequiredCreateFields`: Find fields required for create operations
- `GetOptionalCreateFields`: Find fields optional for create operations

### 2. Query Input Types

#### 2.1 Where Clause Types

**Purpose**: Enable flexible filtering on any model
**What they do**:

- Provide field-specific filters (equals, not, in, contains, etc.)
- Enable relation-based filtering (some, every, none)
- Support logical operators (AND, OR, NOT)
- Adapt automatically to each model's field and relation structure

**Key Types Needed**:

- `WhereInput`: Main where clause type for any model
- `FieldFilters`: Field-specific filtering options
- `RelationFilters`: Relation-based filtering options
- `FieldFilter`: Individual field filter operations
- `RelationFilter`: Individual relation filter operations
- `WhereInputBase`: Logical operators (AND, OR, NOT)

#### 2.2 Unique Identification Types

**Purpose**: Identify records by unique constraints
**What they do**:

- Enforce that at least one unique field is provided
- Allow combination of unique constraints with additional filters
- Support compound unique constraints
- Validate unique field combinations at type level

**Key Types Needed**:

- `WhereUniqueInput`: Unique identification with optional additional filters
- `UniqueFieldConstraints`: Extract and enforce unique field requirements
- `OneOf`: Utility to require exactly one property from a set

#### 2.3 Ordering and Pagination Types

**Purpose**: Control result ordering and pagination
**What they do**:

- Enable sorting by any field in ascending/descending order
- Support relation-based sorting
- Provide cursor-based pagination
- Support skip/take pagination

**Key Types Needed**:

- `OrderByInput`: Main ordering specification
- `FieldOrderBy`: Field-based sorting options
- `RelationOrderBy`: Relation-based sorting options
- `SortOrder`: ASC/DESC enum
- `RelationOrderByInput`: Nested ordering for relations

### 3. Mutation Input Types

#### 3.1 Create Operation Types

**Purpose**: Type-safe record creation
**What they do**:

- Require all non-nullable fields without defaults
- Make optional all nullable fields and fields with defaults
- Handle auto-generated fields (exclude from required inputs)
- Support nested relation creation

**Key Types Needed**:

- `CreateInput`: Main create input combining all field and relation inputs
- `RequiredCreateFields`: Fields that must be provided
- `OptionalCreateFields`: Fields that can be omitted
- `RelationCreateInputs`: Nested relation creation options

#### 3.2 Update Operation Types

**Purpose**: Type-safe record updates
**What they do**:

- Make all fields optional for partial updates
- Provide field-specific update operations (increment, append, etc.)
- Support nested relation updates
- Handle atomic operations

**Key Types Needed**:

- `UpdateInput`: Main update input for partial updates
- `FieldUpdateInputs`: Field-specific update options
- `RelationUpdateInputs`: Nested relation update options
- `FieldUpdateOperations`: Atomic operations per field type

#### 3.3 Upsert Operation Types

**Purpose**: Create or update based on existence
**What they do**:

- Combine unique identification with create/update data
- Ensure type consistency between create and update branches
- Support nested upsert operations

**Key Types Needed**:

- `UpsertInput`: Combination of where/create/update
- `ConnectOrCreateInput`: Connect existing or create new

### 4. Relation Management Types

#### 4.1 Nested Create Types

**Purpose**: Handle relationship creation during record creation
**What they do**:

- Support creating related records inline
- Allow connecting to existing records
- Handle one-to-one, one-to-many, and many-to-many relationships
- Provide connect-or-create operations

**Key Types Needed**:

- `CreateNestedOneInput`: Options for single relation creation
- `CreateNestedManyInput`: Options for multiple relation creation
- `ConnectInput`: Connect to existing records
- `ConnectOrCreateInput`: Connect existing or create new

#### 4.2 Nested Update Types

**Purpose**: Handle relationship updates during record updates
**What they do**:

- Support all CRUD operations on related records
- Handle disconnection and reconnection
- Provide batch operations for multiple relations
- Support conditional updates

**Key Types Needed**:

- `UpdateNestedOneInput`: Single relation update options
- `UpdateNestedManyInput`: Multiple relation update options
- `DisconnectInput`: Remove relation connections
- `DeleteInput`: Delete related records
- `UpsertNestedInput`: Upsert related records

### 5. Selection and Inclusion Types

#### 5.1 Select Types

**Purpose**: Control which fields are returned in queries
**What they do**:

- Allow selection of specific fields only
- Support nested selection for relations
- Exclude unselected fields from result types
- Enable performance optimization

**Key Types Needed**:

- `Select`: Field selection specification
- `RelationSelect`: Nested selection for relations
- `SelectPayload`: Result type when using select

#### 5.2 Include Types

**Purpose**: Include related data without excluding main model fields
**What they do**:

- Add relation data to default field set
- Support nested includes
- Allow filtering and ordering of included relations
- Enable pagination of included relations

**Key Types Needed**:

- `Include`: Relation inclusion specification
- `RelationInclude`: Nested inclusion options
- `IncludePayload`: Result type when using include

### 6. Result Types

#### 6.1 Model Payload Types

**Purpose**: Provide correctly typed query results
**What they do**:

- Infer result type based on select/include options
- Default to all fields when no selection specified
- Handle nested relation data typing
- Ensure type safety of returned data

**Key Types Needed**:

- `ModelPayload`: Main result type for any query
- `DefaultPayload`: All fields when no select/include
- `SelectPayload`: Subset of fields based on selection
- `IncludePayload`: All fields plus included relations

#### 6.2 Aggregation Result Types

**Purpose**: Type aggregation operation results
**What they do**:

- Provide typed results for count, sum, avg, min, max operations
- Handle field-specific aggregations
- Support groupBy operations
- Ensure numeric operations only on numeric fields

**Key Types Needed**:

- `AggregateResult`: Container for all aggregation results
- `CountResult`: Count aggregation results
- `SumResult`: Sum aggregation results (numeric fields only)
- `AvgResult`: Average aggregation results (numeric fields only)
- `MinMaxResult`: Min/max aggregation results

### 7. Operation Argument Types

#### 7.1 Query Operation Arguments

**Purpose**: Type all query method arguments
**What they do**:

- Combine where, orderBy, pagination, and selection options
- Enforce argument compatibility
- Provide method-specific argument sets
- Handle optional vs required arguments

**Key Types Needed**:

- `FindUniqueArgs`: Arguments for findUnique method
- `FindFirstArgs`: Arguments for findFirst method
- `FindManyArgs`: Arguments for findMany method
- `CountArgs`: Arguments for count method
- `AggregateArgs`: Arguments for aggregate method

#### 7.2 Mutation Operation Arguments

**Purpose**: Type all mutation method arguments
**What they do**:

- Combine data inputs with selection options
- Handle where clauses for updates/deletes
- Support batch operations
- Ensure data consistency

**Key Types Needed**:

- `CreateArgs`: Arguments for create method
- `CreateManyArgs`: Arguments for createMany method
- `UpdateArgs`: Arguments for update method
- `UpdateManyArgs`: Arguments for updateMany method
- `UpsertArgs`: Arguments for upsert method
- `DeleteArgs`: Arguments for delete method
- `DeleteManyArgs`: Arguments for deleteMany method

### 8. Client Interface Types

#### 8.1 Model Delegate Types

**Purpose**: Define the interface for each model's operations
**What they do**:

- Provide all CRUD methods for a specific model
- Return properly typed promises
- Handle method overloads
- Ensure consistent API across models

**Key Types Needed**:

- `ModelDelegate`: Main interface for model operations
- Method signatures for all CRUD operations
- Promise return types with proper payloads

#### 8.2 Client Root Types

**Purpose**: Define the main client interface
**What they do**:

- Provide access to all model delegates
- Include client-level operations (connect, disconnect, transaction)
- Handle client configuration and lifecycle
- Ensure type safety at the client level

**Key Types Needed**:

- `BaseORMClient`: Main client interface
- `TransactionClient`: Client interface within transactions
- Client lifecycle method signatures

## Implementation Strategy

### Phase 1: Foundation Infrastructure

1. **Model Extraction Types**: Build utilities to extract type information from Model and BaseField classes
2. **Type Mapping System**: Create mappings between BaseField states and TypeScript types
3. **Field Analysis Utilities**: Develop helpers to analyze field properties and requirements

### Phase 2: Basic Query System

1. **Where Input Types**: Implement flexible filtering system
2. **Selection Types**: Build select and include functionality
3. **Basic Result Types**: Create payload types for simple queries

### Phase 3: Mutation System

1. **Create Input Types**: Implement creation input typing
2. **Update Input Types**: Build update and upsert functionality
3. **Basic Relation Management**: Handle simple relation operations

### Phase 4: Advanced Features

1. **Complex Relation Management**: Full nested CRUD operations
2. **Aggregation System**: Count, sum, avg, min, max operations
3. **Advanced Filtering**: Complex where clauses and relation filters

### Phase 5: Client Interface

1. **Model Delegates**: Complete CRUD interfaces for each model
2. **Client Root**: Main client interface with all features
3. **Transaction Support**: Transactional operation typing

## Key Design Principles

### Type Performance

- Minimize deeply nested conditional types
- Use mapped types for better performance
- Cache complex computations with type aliases
- Avoid recursive types where possible

### Developer Experience

- Provide helpful error messages through branded types
- Use descriptive type names
- Ensure IntelliSense provides useful suggestions
- Design for gradual adoption

### Extensibility

- Design for future field types and operations
- Support custom validators and transformers
- Allow for adapter-specific extensions
- Enable plugin architecture

### Testing Strategy

- Comprehensive type-level testing with expectTypeOf
- Test both positive and negative cases
- Verify complex scenarios and edge cases
- Ensure error conditions produce expected type errors

This type system provides the foundation for a fully type-safe ORM that matches Prisma's functionality while leveraging TypeScript's inference capabilities for superior developer experience without code generation.

## Recommended Folder Structure

```
src/types/client/
├── README.md                           # Overview and usage guide
├── IMPLEMENTATION_GUIDE.md            # This document
│
├── foundation/                         # 1. Foundation Types
│   ├── index.ts                       # Re-exports all foundation types
│   ├── model-extraction.ts            # ModelDefinition, ExtractFields, ExtractRelations
│   └── field-mapping.ts               # MapFieldType, IsFieldNullable, GetUniqueFields
│
├── inputs/                            # 2-3. Query and Mutation Input Types
│   ├── index.ts                       # Re-exports all input types
│   ├── where/                         # 2.1 Where Clause Types
│   │   ├── index.ts
│   │   ├── where-input.ts             # WhereInput, FieldFilters, RelationFilters
│   │   ├── field-filters.ts           # FieldFilter operations (equals, in, contains, etc.)
│   │   ├── relation-filters.ts        # RelationFilter operations (some, every, none)
│   │   └── logical-operators.ts       # WhereInputBase (AND, OR, NOT)
│   │
│   ├── unique/                        # 2.2 Unique Identification Types
│   │   ├── index.ts
│   │   ├── where-unique.ts            # WhereUniqueInput, UniqueFieldConstraints
│   │   └── utilities.ts               # OneOf utility type
│   │
│   ├── ordering/                      # 2.3 Ordering and Pagination Types
│   │   ├── index.ts
│   │   ├── order-by.ts                # OrderByInput, FieldOrderBy, RelationOrderBy
│   │   ├── sort-order.ts              # SortOrder enum type
│   │   └── pagination.ts              # Cursor, take, skip types
│   │
│   ├── create/                        # 3.1 Create Operation Types
│   │   ├── index.ts
│   │   ├── create-input.ts            # CreateInput, RequiredCreateFields, OptionalCreateFields
│   │   └── field-requirements.ts      # Logic for determining required vs optional fields
│   │
│   ├── update/                        # 3.2 Update Operation Types
│   │   ├── index.ts
│   │   ├── update-input.ts            # UpdateInput, FieldUpdateInputs
│   │   ├── field-operations.ts        # FieldUpdateOperations (increment, append, etc.)
│   │   └── atomic-operations.ts       # Atomic update operations per field type
│   │
│   └── upsert/                        # 3.3 Upsert Operation Types
│       ├── index.ts
│       ├── upsert-input.ts            # UpsertInput
│       └── connect-or-create.ts       # ConnectOrCreateInput
│
├── relations/                         # 4. Relation Management Types
│   ├── index.ts                       # Re-exports all relation types
│   ├── create/                        # 4.1 Nested Create Types
│   │   ├── index.ts
│   │   ├── nested-create.ts           # CreateNestedOneInput, CreateNestedManyInput
│   │   ├── connect.ts                 # ConnectInput operations
│   │   └── connect-or-create.ts       # ConnectOrCreateInput operations
│   │
│   └── update/                        # 4.2 Nested Update Types
│       ├── index.ts
│       ├── nested-update.ts           # UpdateNestedOneInput, UpdateNestedManyInput
│       ├── disconnect.ts              # DisconnectInput operations
│       ├── delete.ts                  # DeleteInput operations
│       └── upsert.ts                  # UpsertNestedInput operations
│
├── selection/                         # 5. Selection and Inclusion Types
│   ├── index.ts                       # Re-exports all selection types
│   ├── select/                        # 5.1 Select Types
│   │   ├── index.ts
│   │   ├── select.ts                  # Select, RelationSelect
│   │   ├── select-payload.ts          # SelectPayload type computation
│   │   └── field-selection.ts         # Field selection utilities
│   │
│   ├── include/                       # 5.2 Include Types
│   │   ├── index.ts
│   │   ├── include.ts                 # Include, RelationInclude
│   │   ├── include-payload.ts         # IncludePayload type computation
│   │   └── relation-options.ts        # Relation filtering/ordering in includes
│   │
│   └── utilities/                     # Selection utilities
│       ├── index.ts
│       ├── select-include.ts          # SelectInclude mutual exclusion
│       └── payload-computation.ts     # Common payload computation logic
│
├── results/                           # 6. Result Types
│   ├── index.ts                       # Re-exports all result types
│   ├── payloads/                      # 6.1 Model Payload Types
│   │   ├── index.ts
│   │   ├── model-payload.ts           # ModelPayload main type
│   │   ├── default-payload.ts         # DefaultPayload (all fields)
│   │   └── payload-resolution.ts      # Logic for select vs include vs default
│   │
│   └── aggregation/                   # 6.2 Aggregation Result Types
│       ├── index.ts
│       ├── aggregate-result.ts        # AggregateResult container
│       ├── count.ts                   # CountResult
│       ├── numeric-aggregates.ts      # SumResult, AvgResult, MinMaxResult
│       └── field-constraints.ts       # Ensure numeric operations on numeric fields
│
├── operations/                        # 7. Operation Argument Types
│   ├── index.ts                       # Re-exports all operation types
│   ├── queries/                       # 7.1 Query Operation Arguments
│   │   ├── index.ts
│   │   ├── find-unique.ts             # FindUniqueArgs
│   │   ├── find-first.ts              # FindFirstArgs
│   │   ├── find-many.ts               # FindManyArgs
│   │   ├── count.ts                   # CountArgs
│   │   └── aggregate.ts               # AggregateArgs
│   │
│   └── mutations/                     # 7.2 Mutation Operation Arguments
│       ├── index.ts
│       ├── create.ts                  # CreateArgs, CreateManyArgs
│       ├── update.ts                  # UpdateArgs, UpdateManyArgs
│       ├── upsert.ts                  # UpsertArgs
│       └── delete.ts                  # DeleteArgs, DeleteManyArgs
│
├── client/                            # 8. Client Interface Types
│   ├── index.ts                       # Re-exports all client types
│   ├── delegates/                     # 8.1 Model Delegate Types
│   │   ├── index.ts
│   │   ├── model-delegate.ts          # ModelDelegate interface
│   │   ├── method-signatures.ts       # All CRUD method signatures
│   │   └── promise-types.ts           # Promise return type helpers
│   │
│   └── root/                          # 8.2 Client Root Types
│       ├── index.ts
│       ├── base-orm-client.ts         # BaseORMClient main interface
│       ├── transaction-client.ts      # TransactionClient interface
│       └── lifecycle-methods.ts       # Connect, disconnect, etc.
│
├── utilities/                         # Common utilities used across types
│   ├── index.ts                       # Re-exports all utilities
│   ├── branded-types.ts               # Branded types for better error messages
│   ├── conditional-helpers.ts         # Common conditional type helpers
│   ├── mapped-type-helpers.ts         # Common mapped type utilities
│   └── type-constraints.ts           # Type constraint utilities
│
└── index.ts                          # Main entry point - re-exports everything
```

### File Organization Principles

#### 1. **Logical Grouping**

- Each major type category gets its own top-level folder
- Related types are grouped together in subfolders
- Each folder has an `index.ts` for clean re-exports

#### 2. **Granular Files**

- Individual files focus on specific type responsibilities
- No single file becomes too large or complex
- Easy to locate and modify specific functionality

#### 3. **Clear Dependencies**

- Foundation types have no internal dependencies
- Higher-level types depend on foundation types
- Circular dependencies are avoided through careful layering

#### 4. **Consistent Naming**

- File names clearly indicate their purpose
- Folder structure mirrors the conceptual organization
- Index files provide clean public APIs

#### 5. **Scalability**

- Easy to add new types within existing categories
- New categories can be added without restructuring
- Testing files can mirror this structure in `/tests/types/client/`

### Usage Example

```typescript
// Clean imports from category level
import type { WhereInput, OrderByInput } from "../../types/client/inputs";
import type { ModelPayload } from "../../types/client/results";
import type { FindManyArgs } from "../../types/client/operations";

// Or from the main entry point
import type {
  WhereInput,
  OrderByInput,
  ModelPayload,
  FindManyArgs,
} from "../../types/client";
```

This structure provides clear separation of concerns, makes the codebase easy to navigate, and allows for incremental implementation following the phases outlined in the implementation strategy.
