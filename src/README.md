# VibORM Source Code Structure

This directory contains the complete implementation of VibORM, a TypeScript ORM for PostgreSQL and MySQL databases.

## Directory Structure

```
src/
├── schema/           # Schema definition system
│   ├── index.ts      # Main schema builder and exports
│   ├── model.ts      # Model class implementation
│   ├── field.ts      # Field class with scalar types
│   └── relation.ts   # Relation class for associations
├── query/            # Query builder and execution
│   └── queryBuilder.ts # Prisma-like query interface
├── types/            # TypeScript type definitions
│   ├── index.ts      # Main type exports
│   ├── scalars.ts    # Scalar field types
│   ├── validators.ts # Validation types and interfaces
│   ├── models.ts     # Model metadata and configuration
│   ├── relations.ts  # Relation types and options
│   ├── queries.ts    # Query operation types
│   ├── filters.ts    # Filter and where clause types
│   ├── operations.ts # Database operation types
│   └── utilities.ts  # Advanced TypeScript utilities
├── validation/       # Validation system
│   ├── index.ts      # Validation exports
│   ├── validators.ts # Field and model validators
│   ├── schema.ts     # Schema-level validation
│   └── runtime.ts    # Runtime validation utilities
└── index.ts          # Main library entry point
```

## Key Components

### Schema Builder (`/schema`)

The core of VibORM's type-safe schema definition system:

- **SchemaBuilder**: Main API class providing chainable methods
- **Model**: Represents database tables with fields, relations, indexes
- **Field**: Type-safe field definitions with validation and auto-generation
- **Relation**: One-to-one and one-to-many relationship definitions

### Type System (`/types`)

Comprehensive TypeScript type definitions ensuring full type safety:

- **Scalars**: Database scalar types (string, int, boolean, etc.)
- **Filters**: Query filtering and where clause types
- **Queries**: All query operation types (find, create, update, delete)
- **Validators**: Standard Schema interface for cross-library validation

### Query Builder (`/query`)

Prisma-like query interface:

- **QueryBuilder**: Implements `DatabaseClient` interface
- Supports all CRUD operations with type-safe parameters
- Designed to work with database adapters (to be implemented)

### Validation (`/validation`)

Multi-layered validation system:

- **Field-level validation**: Type checking, regex, range validation
- **Model-level validation**: Cross-field validation rules
- **Runtime validation**: Data coercion and sanitization
- **Standard Schema support**: Compatible with Zod, Valibot, ArkType

## Usage Example

```typescript
import { s } from "./schema";

// Define a model
const user = s.model({
  id: s.string().id().ulid(),
  name: s.string(),
  email: s.string().unique(),
  age: s.int(),
  posts: s.oneToMany(() => post),
});

const post = s.model({
  id: s.string().id().ulid(),
  title: s.string(),
  content: s.string(),
  authorId: s.string(),
  author: s.manyToOne(() => user)
    .fields("authorId")
    .references("id"),
});

// Query usage (when connected to adapter)
const users = await orm.user.findMany({
  where: { age: { gte: 18 } },
  include: { posts: true },
});
```

## Design Principles

1. **Type Safety First**: All types are inferred, not generated
2. **Chainable API**: No decorators, everything is functional
3. **Standard Schema**: Compatible with popular validation libraries
4. **Database Agnostic**: Works with PostgreSQL and MySQL
5. **Prisma-like**: Familiar query interface for easy adoption

## Future Implementation

Components marked as "requires adapter integration" will be completed when the database adapter system is implemented in a future phase.
