# BaseORM Adapter Structure Guide

## Overview

This guide outlines the architecture and design principles for BaseORM's adapter system, focusing on separation of concerns and developer experience.

## Architecture Philosophy

### Two-Layer Separation

1. **Database Adapters** (Internal to baseorm)

   - Stateless SQL generation and type transformation
   - Internal implementation within baseorm package
   - Used by provider adapters

2. **Provider Adapters** (Internal to baseorm)
   - Connection management and query execution
   - Uses database adapters internally
   - Primary interface for developers
   - Part of the same baseorm package

### Bundle Optimization Strategy

**Single Package Design:**

- All adapters are part of the baseorm package
- Tree-shaking eliminates unused database code
- Users configure which provider they want to use

**User Interface Design:**

- Users configure provider adapters only
- Database adapters selected automatically based on provider type
- Clear separation between public and internal APIs

## Directory Structure

```
baseorm/                       # Main package
├── src/adapters/
│   ├── database/              # Internal database adapters
│   │   ├── postgres/
│   │   │   ├── adapter.ts
│   │   │   ├── query-builder.ts
│   │   │   └── type-mapper.ts
│   │   ├── mysql/
│   │   │   ├── adapter.ts
│   │   │   ├── query-builder.ts
│   │   │   └── type-mapper.ts
│   │   └── shared/
│   │       ├── sql-builder.ts
│   │       └── operators.ts
│   ├── providers/             # Provider adapters
│   │   ├── postgres.ts
│   │   ├── mysql.ts
│   │   └── mock.ts
│   └── factory.ts
└── package.json
```

## Core Interface Design

### Database Adapter Interface

**Goals:**

- Pure SQL generation without side effects
- Database-specific optimizations
- Type-safe transformations
- Single-query nested relations

**Key Responsibilities:**

- Generate parameterized SQL for all operations
- Handle database dialect differences
- Transform types between JavaScript and database
- Build complex WHERE clauses
- Create single-query solutions for nested relations

**Acceptance Criteria:**

- Must be stateless (no connections)
- Must support all BaseORM operations
- Must use parameter binding for security
- Must handle nested relations in single queries
- Must support PostgreSQL and MySQL

### Provider Adapter Interface

**Goals:**

- User-friendly connection management
- Robust error handling
- Performance monitoring
- Simple configuration

**Key Responsibilities:**

- Manage database connections and pooling
- Execute SQL queries with error handling
- Provide health checks and monitoring
- Handle configuration and credentials
- Use appropriate database adapter internally

**Acceptance Criteria:**

- Simple configuration interface
- Graceful connection failure handling
- Configurable connection pooling
- Clear error messages with context
- Seamless database adapter integration

## SQL Template Literal System

### Mandatory for All String Manipulation

**Security Requirement:**
ALL SQL construction MUST use the `sql` template literal function.

**Key Features:**

- Automatic parameter binding
- Database-specific parameter syntax
- Safe identifier escaping
- Composable SQL fragments

**Usage Patterns:**

```typescript
// Correct - using template literals
sql`SELECT * FROM ${table} WHERE ${field} = ${value}`;
sql.identifier(tableName);
sql.raw(preValidatedFragment);

// NEVER - string concatenation
"SELECT * FROM " + table + " WHERE " + field + " = " + value;
```

**Acceptance Criteria:**

- Must prevent SQL injection attacks
- Must handle parameter binding automatically
- Must support database-specific syntax
- Must enable fragment composition
- Must provide clear error messages

## Single-Query Nested Relations

### Critical Architecture Decision

**Goal:** Eliminate N+1 query problems through JSON aggregation.

**Strategy:**

- Use database JSON functions for nested data
- Build correlated subqueries for relations
- Transform JSON results to typed objects
- Support unlimited nesting within complexity limits

**Database Support:**

- PostgreSQL: `json_build_object`, `json_agg`
- MySQL: `JSON_OBJECT`, `JSON_ARRAYAGG`

**Acceptance Criteria:**

- Single SQL query for any include depth
- Support all relation types
- Preserve type safety in nested structures
- Better performance than N+1 approaches
- Handle complex WHERE clauses on relations

## Error Handling Strategy

### Comprehensive Error Context

**Goals:**

- Meaningful developer error messages
- Proper error categorization
- Context preservation across layers
- Database-specific error translation

**Error Categories:**

- Connection errors
- Query execution errors
- Validation errors
- Schema errors

**Acceptance Criteria:**

- Actionable error messages
- Preserved context and stack traces
- Consistent categorization across databases
- Database-specific error code handling
- Support for error recovery and retry

## Configuration Management

### Provider-Centric Approach

**User Interface:**
Users configure provider adapters, which manage database adapters internally.

**Configuration Goals:**

- Simple setup for common cases
- Advanced options for performance tuning
- Environment-specific settings
- Validation and defaults

**Key Areas:**

- Connection parameters
- Connection pooling
- Performance options
- Database-specific features

## Performance Considerations

### Query Optimization

**Goals:**

- Minimize database round-trips
- Optimize common patterns
- Provide performance insights

**Features:**

- Single-query nested relations
- Query planning optimization
- Index recommendations
- Complexity analysis

### Connection Management

**Goals:**

- Efficient resource utilization
- Automatic scaling
- Performance monitoring

**Features:**

- Dynamic connection pooling
- Health monitoring
- Automatic failover
- Performance metrics

## Testing Strategy

### Multi-Level Approach

**Database Adapter Testing:**

- Unit tests (no database required)
- SQL syntax validation
- Type transformation verification
- Edge case handling

**Provider Adapter Testing:**

- Integration tests with real connections
- Connection pooling testing
- Error handling scenarios
- Performance testing

**End-to-End Testing:**

- Complete operation workflows
- Schema integration
- Multi-database compatibility
- Production scenarios

## Development Guidelines

### Core Principles

**Separation of Concerns:**

- Database logic separate from connection management
- Abstract database differences
- Isolate user APIs from implementation

**Type Safety:**

- Leverage TypeScript inference
- Compile-time validation
- Type safety across boundaries

**Performance:**

- Design for scalability
- Optimize common use cases
- Provide advanced escape hatches

### Critical Caveats

**Security:**

- NEVER concatenate user input into SQL
- ALWAYS use parameterized queries
- Validate all inputs

**Performance:**

- Avoid N+1 query patterns
- Monitor connection pool usage
- Be cautious with deep nesting

**Compatibility:**

- Test multiple database versions
- Handle database quirks gracefully
- Clear error messages for unsupported features

**Bundle Size:**

- Tree-shaking eliminates unused code
- Avoid unnecessary dependencies
- Use conditional imports where possible

This guide provides the architectural foundation for implementing secure, performant database adapters while maintaining clean separation of concerns and optimal developer experience.
