# VibORM Developer Specifications

> **Scope note (2026-08-27):** these are development-era design
> specifications; parts predate the implementation and sketch APIs that
> never shipped (`.min()`, `.list()`, `.positive()`, `s.jsonb()`). The
> current public API reference is `docs/content/docs/` and the layer
> `AGENTS.md` files.

This folder contains detailed specifications for each component of the VibORM project. These documents are designed to be comprehensive guides for developers working on individual parts of the system.

## Table of Contents

1. [Schema Builder](1_schema_builder.md) - The foundation of the ORM
2. [Scalar Class](1.2_scalar_class.md) - Type-safe scalar definitions with validation
   - [Scalar Types](1.3_scalar_types.md) - Detailed reference for all scalar types
3. [Relation Class](3_relation_class.md) - Relationships between models
4. [Query Builder](4_query_builder.md) - Prisma-inspired API for data operations
5. [Adapter API](5_adapter_api.md) - Database-specific implementations
6. [Validation](6_validation.md) - Scalar and model validation

## Project Overview

VibORM is a TypeScript ORM for Postgres and MySQL with two main components:

1. **Schema Builder** - A chainable API for defining models and fields (scalars and relations)
2. **Query Builder** - A Prisma-inspired interface for querying and mutating data

All components are designed to be fully type-safe, with TypeScript types inferred from schema definitions rather than generated.

## Key Principles

- **Type Safety**: All components must be fully type-safe and leverage TypeScript's type inference.
- **Chainable API**: All configuration must use a chainable, functional API (no decorators).
- **Prisma-inspired Query API**: The query interface should feel familiar to Prisma users while documenting intentional differences.
- **Modular Design**: Components should be loosely coupled and independently testable.
- **MySQL/Postgres Support**: Focus on features supported by both databases.

## Development Guidelines

- All TypeScript types must be in the `/types` directory
- No decorators should be used anywhere in the codebase
- All components must have comprehensive unit tests
- Validation should be baked into the schema definition
- Code should follow the project's established patterns and naming conventions

## Example Usage

```ts
import { s } from "viborm";

// Schema Definition
const user = s.model({
  id: s.string().id().ulid(),
  name: s.string(),
  email: s.string(),
  // Self-referential many-to-many: two paired collection slots,
  // with every junction override on one of them
  friends: s.toMany(() => user)
    .through("user_friends")
    .source("userId")
    .target("friendId"),
  friendOf: s.toMany(() => user),
});

// Query API Usage
const users = await orm.user.findMany({
  where: { name: "Alice" },
  include: { friends: true },
});
```

## Future Features (Not Required for Initial Implementation)

- SQL Migration Generation
- Transactions
- Lifecycle Hooks
- Telemetry
