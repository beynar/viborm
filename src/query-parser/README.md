# BaseORM Query Parser - Modular Architecture

This directory contains the decomposed, modular architecture for the BaseORM query parser system. The original monolithic query parser has been broken down into specialized, focused components that follow the single responsibility principle.

## Architecture Overview

The new architecture follows a **composition-based design** where the main `QueryParser` class coordinates specialized components rather than handling everything itself. This provides better maintainability, testability, and extensibility.

### Core Principles

- **Single Responsibility**: Each component handles one specific concern
- **Composition over Inheritance**: Components are injected and coordinated
- **Database Abstraction**: All database-specific logic is in adapters
- **Type Safety**: Full TypeScript support with proper type inference
- **Modularity**: Components can be tested and developed independently

## Directory Structure

```
src/query-parser/
├── index.ts                    # Main QueryParser coordinator class
├── types.ts                    # Shared types and interfaces
├── README.md                   # This documentation
│
├── operations/                 # Operation-specific handlers
│   ├── read-operations.ts      # findMany, findFirst, findUnique
│   ├── mutation-operations.ts  # create, update, delete
│   ├── upsert-operations.ts    # upsert operations
│   └── aggregate-operations.ts # count, aggregate, groupBy
│
├── clauses/                    # SQL clause builders
│   ├── select-clause.ts        # SELECT clause generation
│   ├── where-clause.ts         # WHERE clause generation
│   ├── orderby-clause.ts       # ORDER BY clause generation
│   └── limit-clause.ts         # LIMIT/OFFSET clause generation
│
├── relations/                  # Relation-specific handlers
│   ├── relation-queries.ts     # Relation query building
│   ├── relation-filters.ts     # Relation filtering logic
│   └── relation-mutations.ts   # Relation mutation operations
│
├── fields/                     # Field-specific handlers
│   ├── field-filters.ts        # Field-specific filtering
│   ├── field-updates.ts        # Field update operations
│   └── field-validators.ts     # Field validation logic
│
└── utils/                      # Shared utilities
    ├── alias-generator.ts      # Table alias management
    └── context-factory.ts      # BuilderContext creation
```

## Component Responsibilities

### Main Coordinator

- **`QueryParser`** (`index.ts`): Central orchestrator that coordinates all components and provides the main API

### Operation Handlers

- **`ReadOperations`**: Handles all read operations (findMany, findFirst, findUnique, etc.)
- **`MutationOperations`**: Handles data mutations (create, update, delete, createMany, etc.)
- **`UpsertOperations`**: Handles upsert operations with conflict resolution
- **`AggregateOperations`**: Handles aggregation operations (count, aggregate, groupBy)

### Clause Builders

- **`SelectClauseBuilder`**: Generates SELECT clauses with field selection and relation inclusion
- **`WhereClauseBuilder`**: Generates WHERE clauses with complex filtering logic
- **`OrderByClauseBuilder`**: Generates ORDER BY clauses with sorting and null positioning
- **`LimitClauseBuilder`**: Generates LIMIT/OFFSET clauses for pagination

### Relation Handlers

- **`RelationQueryBuilder`**: Builds subqueries for relation inclusion
- **`RelationFilterBuilder`**: Handles relation-based filtering (some, every, none)
- **`RelationMutationBuilder`**: Manages relation mutations (connect, disconnect, etc.)

### Field Handlers

- **`FieldFilterBuilder`**: Handles field-specific filtering with type-aware operations
- **`FieldUpdateBuilder`**: Manages field update operations (increment, set, etc.)
- **`FieldValidatorBuilder`**: Validates field operations and constraints

### Utilities

- **`AliasGenerator`**: Manages table alias generation and conflict resolution
- **`ContextFactory`**: Creates and manages BuilderContext instances

## Key Features

### Enhanced BuilderContext

The new `BuilderContext` type includes all the missing fields needed for complete feature support:

```typescript
type BuilderContext = {
  // Core identification
  model: Model<any>;
  field?: Field<any>;
  relation?: Relation<any, any>;
  baseOperation: Operation;
  alias: string;

  // Relation context
  parentAlias?: string;
  fieldName?: string;

  // Pagination context (restored from original)
  take?: number;
  skip?: number;
  cursor?: any;
  distinct?: string[];

  // Mutation context
  data?: any;
  conflictFields?: string[];

  // Query context
  mode?: QueryMode;
  orderBy?: any;

  // Advanced context
  isNested?: boolean;
  depth?: number;
  path?: string[];
};
```

### Component Interfaces

All components implement standardized interfaces for consistency:

- **`QueryParserComponent`**: Base interface for all components
- **`OperationHandler`**: Interface for operation-specific handlers
- **`ClauseBuilder`**: Interface for SQL clause builders
- **`FieldHandler`**: Interface for field-specific handlers
- **`RelationHandler`**: Interface for relation-specific handlers

### Dependency Management

Components declare their dependencies explicitly:

```typescript
export class ReadOperations implements OperationHandler {
  readonly name = "ReadOperations";
  readonly dependencies = [
    "SelectClause",
    "WhereClause",
    "OrderByClause",
    "LimitClause",
  ];
  // ...
}
```

## Usage Example

```typescript
import { QueryParser } from "./query-parser";
import { PostgresAdapter } from "../adapters/database/postgres/postgres-adapter";

// Create adapter and parser
const adapter = new PostgresAdapter();
const sql = QueryParser.parse("findMany", userModel, payload, adapter);

// The parser coordinates all components internally
// No need to manage individual components
```

## Benefits of This Architecture

### 1. **Maintainability**

- Each component has a single, clear responsibility
- Changes to one feature don't affect others
- Easier to understand and modify individual components

### 2. **Testability**

- Components can be unit tested in isolation
- Mock dependencies easily for focused testing
- Better test coverage and reliability

### 3. **Extensibility**

- New operations: Add to `operations/` directory
- New field types: Extend field handlers
- New databases: Implement adapter interface
- New features: Add appropriate component

### 4. **Performance**

- Components are created once per parser instance
- Efficient context creation through factory pattern
- Optimized SQL building with template literals

### 5. **Type Safety**

- Full TypeScript support throughout
- Proper type inference and validation
- Compile-time error detection

## Implementation Status

All components have been created with:

- ✅ Complete class structure and interfaces
- ✅ Detailed documentation and purpose
- ✅ Method signatures and responsibilities
- ✅ TODO markers for implementation
- ✅ Proper TypeScript types and imports

The structure is ready for implementation of the actual logic in each component.

## Next Steps

1. **Implement Core Components**: Start with `ReadOperations` and basic clause builders
2. **Add Unit Tests**: Create comprehensive test suites for each component
3. **Implement Missing Features**: Add support for all the features identified in the coverage analysis
4. **Performance Optimization**: Add caching and optimization strategies
5. **Documentation**: Add detailed API documentation and examples

This modular architecture provides a solid foundation for implementing all the missing features while maintaining clean, maintainable code.
