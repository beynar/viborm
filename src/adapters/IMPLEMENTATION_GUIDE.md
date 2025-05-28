# BaseORM Adapter Implementation Guide

## Overview

This guide provides a phase-by-phase implementation roadmap for building BaseORM adapters with clear purposes and actionable steps.

## Architecture Overview

### Two-Layer Implementation Strategy

**Database Adapters (Internal):**

- Pure SQL generation, no connections
- Internal to baseorm package in `src/adapters/database/`
- Used internally by provider adapters

**Provider Adapters (Internal):**

- Connection management and configuration
- Uses database adapters internally
- Part of baseorm package in `src/adapters/providers/`
- Primary developer interface

## Phase-by-Phase Implementation Plan

### Phase 1: Foundation Infrastructure (Days 1-5)

**Purpose:** Establish the security and type-safe foundation for all SQL generation.

**Goals:**

- Create secure SQL template literal system
- Establish base interfaces and types
- Set up testing infrastructure
- Prevent SQL injection at the foundation level

**Daily Breakdown:**

**Day 1: SQL Builder Core**

- Create `src/adapters/database/shared/sql-builder.ts`
- Implement `SqlBuilder` class with template literal support
- Add parameter binding with placeholder generation
- Create `SqlFragment` and `SqlIdentifier` classes
- Write unit tests for SQL injection prevention

**Day 2: Base Interfaces**

- Create `src/adapters/types.ts` with core interfaces
- Define `DatabaseAdapter` interface
- Define `ProviderAdapter` interface
- Create error type hierarchy in `src/adapters/errors.ts`
- Add TypeScript type definitions

**Day 3: Operator System**

- Create `src/adapters/database/shared/operators.ts`
- Implement operator registry pattern
- Add comparison operators (equals, gt, gte, lt, lte)
- Add string operators (contains, startsWith, endsWith)
- Add logical operators (AND, OR, NOT)

**Day 4: Schema Integration**

- Create schema context interfaces
- Implement field definition mapping
- Add relation definition extraction
- Create validation framework
- Test with existing BaseORM schema system

**Day 5: Testing Infrastructure**

- Set up adapter testing framework
- Create mock utilities for database testing
- Implement query analysis tools
- Add performance testing helpers
- Establish testing patterns and documentation

**Acceptance Criteria:**

- SQL injection prevention proven through comprehensive tests
- All base interfaces defined and documented
- Operator system functional with core operators
- Schema integration working with existing types
- Testing framework operational

### Phase 2: Database Adapters (Days 6-12)

**Purpose:** Build stateless SQL generation engines for PostgreSQL and MySQL.

**Goals:**

- Generate database-specific SQL with proper dialects
- Handle type transformations between JavaScript and database
- Implement single-query nested relations using JSON
- Support all BaseORM operations

**Daily Breakdown:**

**Day 6: PostgreSQL Query Builder**

- Create `src/adapters/database/postgres/query-builder.ts`
- Implement SELECT query generation with PostgreSQL syntax
- Add parameter placeholder generation ($1, $2, $3...)
- Implement identifier escaping with double quotes
- Test basic query generation

**Day 7: PostgreSQL Type System**

- Create `src/adapters/database/postgres/type-mapper.ts`
- Implement PostgreSQL type mappings (UUID, TIMESTAMPTZ, JSONB)
- Add value transformation to/from database
- Handle PostgreSQL-specific type nuances
- Test type transformations

**Day 8: PostgreSQL JSON Aggregation**

- Create `src/adapters/database/postgres/json-functions.ts`
- Implement `json_build_object` and `json_agg` usage
- Build correlated subqueries for nested relations
- Add JSON result parsing logic
- Test single-query nested relations

**Day 9: MySQL Query Builder**

- Create `src/adapters/database/mysql/query-builder.ts`
- Implement SELECT query generation with MySQL syntax
- Add parameter placeholder generation (?, ?, ?...)
- Implement identifier escaping with backticks
- Test basic query generation

**Day 10: MySQL Type System**

- Create `src/adapters/database/mysql/type-mapper.ts`
- Implement MySQL type mappings (CHAR(36), DATETIME, JSON)
- Add value transformation to/from database
- Handle MySQL-specific type nuances
- Test type transformations

**Day 11: MySQL JSON Aggregation**

- Create `src/adapters/database/mysql/json-functions.ts`
- Implement `JSON_OBJECT` and `JSON_ARRAYAGG` usage
- Build correlated subqueries for nested relations
- Add JSON result parsing logic
- Test single-query nested relations

**Day 12: Database Adapter Integration**

- Create `src/adapters/database/postgres/adapter.ts`
- Create `src/adapters/database/mysql/adapter.ts`
- Implement complete database adapter interfaces
- Add comprehensive WHERE clause processing
- Test all CRUD operations SQL generation

**Acceptance Criteria:**

- Both database adapters generate correct SQL for all operations
- Type transformations work correctly for all field types
- Single-query nested relations functional for both databases
- Complex WHERE clauses handled properly
- No SQL injection vulnerabilities

### Phase 3: Provider Adapters (Days 13-18)

**Purpose:** Build connection management and query execution layers.

**Goals:**

- Establish robust database connections with pooling
- Execute queries with proper error handling
- Provide health monitoring and performance metrics
- Create user-friendly configuration interfaces

**Daily Breakdown:**

**Day 13: PostgreSQL Connection Management**

- Create `src/adapters/providers/postgres.ts`
- Implement `pg` library integration
- Add connection pool configuration
- Implement connection lifecycle management
- Test connection establishment and cleanup

**Day 14: PostgreSQL Query Execution**

- Implement query execution with parameter binding
- Add transaction support framework
- Implement error handling and translation
- Add query performance tracking
- Test query execution with real database

**Day 15: PostgreSQL Error Handling**

- Implement PostgreSQL error code mapping
- Add context preservation for errors
- Create meaningful error messages
- Add retry logic for connection failures
- Test error scenarios and recovery

**Day 16: MySQL Connection Management**

- Create `src/adapters/providers/mysql.ts`
- Implement `mysql2` library integration
- Add connection pool configuration
- Implement connection lifecycle management
- Test connection establishment and cleanup

**Day 17: MySQL Query Execution**

- Implement query execution with parameter binding
- Add transaction support framework
- Implement error handling and translation
- Add query performance tracking
- Test query execution with real database

**Day 18: MySQL Error Handling**

- Implement MySQL error code mapping
- Add context preservation for errors
- Create meaningful error messages
- Add retry logic for connection failures
- Test error scenarios and recovery

**Acceptance Criteria:**

- Both providers establish stable database connections
- Query execution works reliably with proper error handling
- Connection pooling functional with health monitoring
- Error messages are meaningful and actionable
- Performance metrics available for monitoring

### Phase 4: Integration and Testing (Days 19-21)

**Purpose:** Integrate all components and ensure production readiness.

**Goals:**

- Create seamless integration between layers
- Implement adapter factory and configuration
- Comprehensive testing across all scenarios
- Performance optimization and monitoring

**Daily Breakdown:**

**Day 19: Adapter Factory and Configuration**

- Create `src/adapters/factory.ts`
- Implement adapter factory pattern
- Add configuration validation
- Create provider selection logic
- Add schema integration points

**Day 20: Integration Testing**

- Test complete operation workflows
- Verify schema integration with BaseORM
- Test nested relations end-to-end
- Validate error handling across layers
- Performance testing and optimization

**Day 21: Production Readiness**

- Add comprehensive logging and monitoring
- Implement health check endpoints
- Add performance metrics collection
- Create deployment documentation
- Final security audit and testing

**Acceptance Criteria:**

- All components work together seamlessly
- Configuration is simple and intuitive
- Performance meets requirements
- Error handling is comprehensive
- Code is production-ready with monitoring

## Implementation Guidelines

### Daily Development Process

**Each Day Should Include:**

1. **Morning Planning** (30 mins)

   - Review day's goals and acceptance criteria
   - Plan implementation approach
   - Identify potential blockers

2. **Core Development** (6 hours)

   - Implement planned features
   - Write tests alongside code
   - Document decisions and trade-offs

3. **Testing and Validation** (1 hour)

   - Run comprehensive tests
   - Validate against acceptance criteria
   - Test integration points

4. **Documentation** (30 mins)
   - Update implementation notes
   - Document any architectural decisions
   - Prepare next day's plan

### Quality Gates

**After Each Phase:**

- All acceptance criteria must be met
- Test coverage must be >90%
- No known security vulnerabilities
- Performance benchmarks met
- Documentation updated

### Risk Mitigation

**Common Risks and Mitigation:**

- **SQL Injection**: Mandatory template literal usage, comprehensive testing
- **Performance Issues**: Early performance testing, query optimization
- **Connection Failures**: Robust retry logic, health monitoring
- **Type Safety**: Comprehensive TypeScript testing, runtime validation

This phase-by-phase plan ensures systematic development with clear milestones and quality assurance at each step.

## Critical Implementation Requirements

### SQL Security (Mandatory)

**Template Literal Usage:**
ALL SQL construction must use the `sql` template literal function:

```typescript
// Required approach
const query = sql`SELECT * FROM ${sql.identifier(table)} WHERE id = ${userId}`;

// Forbidden - never concatenate
const query = `SELECT * FROM ${table} WHERE id = ${userId}`;
```

**Security Checklist:**

- No string concatenation for SQL construction
- All user input through parameter binding
- Identifier escaping for table/column names
- Input validation at adapter boundaries

### Single-Query Nested Relations (Critical)

**Architecture Decision:**
Must eliminate N+1 query problems by fetching all nested data in one query.

**Implementation Strategy:**

- Use database JSON functions for nested relations
- Build correlated subqueries with JSON aggregation
- Transform JSON results back to typed objects
- Support complex nesting while maintaining performance

**Database Support:**

- PostgreSQL: Leverage `json_build_object` and `json_agg`
- MySQL: Use `JSON_OBJECT` and `JSON_ARRAYAGG`

**Performance Requirements:**

- Single database round-trip for any include depth
- Optimized subquery generation
- Efficient JSON parsing and transformation

### Error Handling (Comprehensive)

**Error Categories:**

- Connection errors (network, authentication, pool)
- Query execution errors (syntax, constraints)
- Validation errors (types, business rules)
- Schema errors (missing tables, invalid relations)

**Requirements:**

- Meaningful error messages for developers
- Proper error categorization and codes
- Context preservation across adapter layers
- Database-specific error translation

### Type System Integration

**Schema Context:**

- Integration with existing BaseORM schema system
- Field definition and relation mapping
- Type transformation between JavaScript and database
- Validation at adapter boundaries

**Type Safety:**

- Compile-time type checking where possible
- Runtime validation for dynamic data
- Proper type inference for nested relations
- Clear error messages for type mismatches

## Bundle Optimization Strategy

### Single Package Architecture

**Package Structure:**

```
baseorm                      # Main package with all adapters
```

**Benefits:**

- Single package installation for users
- Tree-shaking eliminates unused database code
- Simplified dependency management
- All adapter code maintained together

**User Experience:**

- Configure provider adapters only
- Database adapters used automatically
- No exposure to internal implementation details

## Configuration Management

### Provider-Centric Design

**User Interface:**
Users configure provider adapters, which internally use database adapters.

**Configuration Requirements:**

- Simple setup for common use cases
- Advanced options for performance tuning
- Environment-specific settings
- Validation with clear error messages
- Sensible defaults for all optional settings

**Key Configuration Areas:**

- Connection parameters (host, port, credentials)
- Connection pooling (min/max, timeouts, retry logic)
- Performance options (query timeout, logging level)
- Database-specific features (JSON handling preferences)

## Testing Requirements

### Multi-Level Testing Strategy

**Database Adapter Tests (Internal):**

- Unit tests without database connections
- SQL generation verification for both databases
- Type transformation accuracy
- Edge case handling (nulls, complex nesting)

**Provider Adapter Tests (Internal):**

- Integration tests with real database connections
- Connection pooling and lifecycle testing
- Error handling and recovery scenarios
- Performance and load testing

**End-to-End Tests:**

- Complete operation workflows
- Schema integration verification
- Multi-database compatibility
- Production scenario simulation

### Mock and Test Utilities

**Mock Adapter Enhancement:**

- Better query analysis and verification
- Relation simulation capabilities
- Error injection for testing error handling
- Performance simulation features

## Performance Optimization

### Query Optimization

**Key Goals:**

- Minimize database round-trips through single-query approach
- Optimize for common query patterns
- Provide performance insights and recommendations
- Handle complex queries efficiently

**Implementation Focus:**

- Efficient JSON aggregation strategies
- Query complexity analysis and limits
- Index usage recommendations
- Parameter limit management for large IN clauses

### Connection Management

**Key Goals:**

- Efficient resource utilization
- Automatic scaling based on load
- Health monitoring and recovery
- Performance metrics and alerting

**Implementation Focus:**

- Dynamic connection pool sizing
- Connection health checks and recovery
- Query performance tracking
- Resource cleanup and management

## Critical Caveats and Pitfalls

### Security Pitfalls

- Never concatenate user input into SQL strings
- Always validate input at adapter boundaries
- Be cautious with dynamic table/column names
- Implement proper error message sanitization

### Performance Pitfalls

- Avoid falling back to N+1 query patterns
- Monitor connection pool utilization carefully
- Be cautious with deeply nested relation queries
- Implement query complexity limits

### Compatibility Pitfalls

- Test with multiple versions of each database
- Handle database-specific quirks gracefully
- Provide clear error messages for unsupported features
- Plan for future database version compatibility

### Bundle Size Pitfalls

- Keep provider packages lean and focused
- Avoid pulling in unnecessary dependencies
- Use tree-shaking friendly export patterns
- Monitor bundle size impact during development

This implementation guide provides the roadmap and requirements for building production-ready BaseORM adapters with proper two-layer separation, security, performance, and developer experience.
