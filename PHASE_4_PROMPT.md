# Phase 4: Client Interface and ORM Integration

## Context

You are continuing the development of BaseORM, a TypeScript ORM with zero-generation, fully type-safe capabilities. The first three phases have been completed successfully:

- ✅ Phase 1: Foundation Types infrastructure
- ✅ Phase 2: Enhanced Foundation Types with comprehensive model introspection
- ✅ Phase 3: Query Input Types (where, select, include, orderBy, operations args)

Now we move to Phase 4: implementing the **Client Interface and ORM Integration** that brings everything together into a working ORM that developers can actually use.

## Current State

- ✅ Schema Builder implemented (`src/schema/`)
- ✅ Foundation Types complete (`src/types/client/foundation/`)
- ✅ Query Input Types complete (`src/types/client/query/`, `src/types/client/operations/`, `src/types/client/results/`)
- ✅ Type-safe query arguments (WhereInput, SelectInput, IncludeInput, etc.)
- ✅ Complete type inference from schema to query results
- 🔄 Query Builder skeleton exists (`src/query/queryBuilder.ts`) but commented out pending adapter
- ❌ Client interface not implemented
- ❌ Model delegates not implemented
- ❌ ORM integration not implemented

## Phase 4 Objectives

Implement the **Client Interface** that enables developers to use BaseORM with this API:

```typescript
// Target API we want to achieve
import { BaseORM } from "baseorm";

// Define schema
const user = s.model("user", {
  id: s.string().uuid(),
  name: s.string(),
  email: s.string().unique(),
  posts: s.relation.many(() => post),
});

const post = s.model("post", {
  id: s.string().uuid(),
  title: s.string(),
  content: s.string(),
  published: s.boolean().default(false),
  authorId: s.string(),
  author: s.relation.one(() => user),
});

// Create ORM instance
const orm = new BaseORM({
  models: { user, post },
  adapter: mockAdapter, // For testing - real adapter comes later
});

// Use the ORM
const users = await orm.user.findMany({
  where: { email: { contains: "@gmail.com" } },
  include: { posts: true },
});

const newUser = await orm.user.create({
  data: {
    name: "John Doe",
    email: "john@example.com",
  },
});
```

## Implementation Plan

### 1. Model Delegate System

Create `src/client/model-delegate.ts`:

**Purpose**: Provide the `orm.user`, `orm.post` interfaces that contain all CRUD methods for each model.

**Key Requirements**:

- Generic `ModelDelegate<TModel>` class that works with any model
- Implement all Prisma-compatible methods: `findMany`, `findUnique`, `findFirst`, `create`, `update`, `delete`, etc.
- Full type safety - methods should use the query input types from Phase 3
- Result type inference - methods should return properly typed results based on select/include
- Integration with adapter system (delegating actual execution to adapter)

**Methods to implement**:

```typescript
class ModelDelegate<TModel extends Model<any>> {
  findUnique<TArgs extends FindUniqueArgs<TModel>>(
    args: TArgs
  ): Promise<FindUniqueResult<TModel, TArgs>>;
  findUniqueOrThrow<TArgs extends FindUniqueArgs<TModel>>(
    args: TArgs
  ): Promise<FindUniqueResult<TModel, TArgs>>;
  findFirst<TArgs extends FindFirstArgs<TModel>>(
    args?: TArgs
  ): Promise<FindFirstResult<TModel, TArgs>>;
  findFirstOrThrow<TArgs extends FindFirstArgs<TModel>>(
    args?: TArgs
  ): Promise<FindFirstResult<TModel, TArgs>>;
  findMany<TArgs extends FindManyArgs<TModel>>(
    args?: TArgs
  ): Promise<FindManyResult<TModel, TArgs>>;
  create<TArgs extends CreateArgs<TModel>>(
    args: TArgs
  ): Promise<CreateResult<TModel, TArgs>>;
  createMany(args: CreateManyArgs<TModel>): Promise<BatchPayload>;
  update<TArgs extends UpdateArgs<TModel>>(
    args: TArgs
  ): Promise<UpdateResult<TModel, TArgs>>;
  updateMany(args: UpdateManyArgs<TModel>): Promise<BatchPayload>;
  upsert<TArgs extends UpsertArgs<TModel>>(
    args: TArgs
  ): Promise<UpsertResult<TModel, TArgs>>;
  delete<TArgs extends DeleteArgs<TModel>>(
    args: TArgs
  ): Promise<DeleteResult<TModel, TArgs>>;
  deleteMany(args?: DeleteManyArgs<TModel>): Promise<BatchPayload>;
  count(args?: CountArgs<TModel>): Promise<number>;
  aggregate(args?: AggregateArgs<TModel>): Promise<AggregateResult<TModel>>;
  groupBy<TArgs extends GroupByArgs<TModel>>(
    args: TArgs
  ): Promise<GroupByResult<TModel, TArgs>>;
}
```

### 2. Client Root Interface

Create `src/client/base-orm-client.ts`:

**Purpose**: Main entry point for the ORM that provides access to all model delegates.

**Key Requirements**:

- Accept schema models and adapter in constructor
- Dynamically create model delegates for each model
- Provide type-safe access to each model delegate
- Handle client-level operations (connect, disconnect, transaction when ready)
- Initialize and manage adapter lifecycle

**API Design**:

```typescript
interface BaseORMClientConfig {
  models: Record<string, Model<any>>;
  adapter: AdapterInterface; // Abstract adapter interface
}

class BaseORM {
  constructor(config: BaseORMClientConfig);

  // Dynamic model access - should be type-safe
  [modelName: string]: ModelDelegate<any>;

  // Client lifecycle
  connect(): Promise<void>;
  disconnect(): Promise<void>;

  // Transaction support (future)
  $transaction<T>(fn: (tx: BaseORM) => Promise<T>): Promise<T>;

  // Raw queries
  $executeRaw(query: string, ...values: any[]): Promise<number>;
  $queryRaw<T = unknown>(query: string, ...values: any[]): Promise<T>;
}
```

### 3. Adapter Interface Definition

Create `src/adapter/adapter-interface.ts`:

**Purpose**: Define the abstract interface that database adapters must implement.

**Key Requirements**:

- Abstract interface for database operations
- Should receive processed query objects (not raw SQL)
- Return standardized result formats
- Support for all CRUD operations
- Connection management
- Transaction support interface (for future)

**Interface Design**:

```typescript
export interface AdapterInterface {
  // Connection management
  connect(): Promise<void>;
  disconnect(): Promise<void>;

  // Core CRUD operations
  findUnique(params: FindUniqueParams): Promise<Record<string, any> | null>;
  findFirst(params: FindFirstParams): Promise<Record<string, any> | null>;
  findMany(params: FindManyParams): Promise<Record<string, any>[]>;
  create(params: CreateParams): Promise<Record<string, any>>;
  createMany(params: CreateManyParams): Promise<{ count: number }>;
  update(params: UpdateParams): Promise<Record<string, any>>;
  updateMany(params: UpdateManyParams): Promise<{ count: number }>;
  delete(params: DeleteParams): Promise<Record<string, any>>;
  deleteMany(params: DeleteManyParams): Promise<{ count: number }>;
  count(params: CountParams): Promise<number>;

  // Raw queries
  executeRaw(query: string, values: any[]): Promise<number>;
  queryRaw(query: string, values: any[]): Promise<any[]>;
}

// Parameter types that adapters receive
interface FindUniqueParams {
  model: string;
  where: Record<string, any>;
  select?: Record<string, any>;
  include?: Record<string, any>;
}
// ... other params interfaces
```

### 4. Mock Adapter for Testing

Create `src/adapter/mock-adapter.ts`:

**Purpose**: In-memory adapter for testing and development.

**Key Requirements**:

- Implement `AdapterInterface`
- Store data in memory using Maps/Arrays
- Support all CRUD operations with basic filtering
- Handle relations by storing foreign keys
- Provide predictable behavior for tests

**Features**:

- In-memory storage per model
- Basic where clause evaluation (equals, in, etc.)
- Support for select/include (return only requested fields)
- Auto-generate IDs for fields marked as auto-generated
- Proper error handling for unique constraints

### 5. Query Transformation Layer

Create `src/client/query-transformer.ts`:

**Purpose**: Transform typed query arguments into adapter-compatible parameters.

**Key Requirements**:

- Convert `WhereInput<TModel>` to plain object that adapter can understand
- Handle nested relation queries
- Transform select/include to field lists
- Resolve model relationships for includes
- Handle special operators (contains, gte, etc.)

**Functionality**:

```typescript
export class QueryTransformer {
  static transformWhere<TModel extends Model<any>>(
    model: TModel,
    where: WhereInput<TModel>
  ): Record<string, any>;

  static transformSelect<TModel extends Model<any>>(
    model: TModel,
    select?: SelectInput<TModel>
  ): Record<string, any> | undefined;

  static transformInclude<TModel extends Model<any>>(
    model: TModel,
    include?: IncludeInput<TModel>
  ): Record<string, any> | undefined;

  static transformData<TModel extends Model<any>>(
    model: TModel,
    data: any
  ): Record<string, any>;
}
```

### 6. Result Transformation Layer

Create `src/client/result-transformer.ts`:

**Purpose**: Transform adapter results back into properly typed results.

**Key Requirements**:

- Apply select/include filtering to results
- Handle nested relation data assembly
- Ensure type safety between runtime and compile-time types
- Convert database primitives to TypeScript types

## Implementation Strategy

### Step 1: Start with Basic Structure

1. **Create adapter interface** - Define the contract
2. **Create mock adapter** - Simple in-memory implementation
3. **Create basic model delegate** - Start with `findUnique` and `create`
4. **Create basic client** - Constructor and model delegate setup

### Step 2: Add Core Operations

1. **Implement query transformer** - Handle where clauses
2. **Add all find operations** - `findMany`, `findFirst`, etc.
3. **Add mutation operations** - `update`, `delete`, etc.
4. **Add result transformation** - Handle select/include

### Step 3: Integration and Testing

1. **Create comprehensive tests** - Test all operations with mock adapter
2. **Test type inference** - Verify result types match expectations
3. **Test error cases** - Unique constraints, not found, etc.
4. **Performance testing** - Ensure reasonable performance with mock adapter

### Step 4: Advanced Features

1. **Add aggregation operations** - `count`, `aggregate`, `groupBy`
2. **Add batch operations** - `createMany`, `updateMany`, `deleteMany`
3. **Add upsert operations**
4. **Raw query support**

## Testing Strategy

Create comprehensive tests in `tests/client/`:

### Integration Tests (`tests/client/integration.test.ts`)

- Test complete user workflows
- Test with complex schemas (multiple models, relations)
- Test error scenarios
- Test type inference at runtime

### Unit Tests

- `tests/client/model-delegate.test.ts` - Test individual operations
- `tests/client/query-transformer.test.ts` - Test query transformation
- `tests/client/result-transformer.test.ts` - Test result transformation
- `tests/client/mock-adapter.test.ts` - Test mock adapter behavior

### Type Tests (`tests/client/type-inference.test.ts`)

- Test that result types are inferred correctly
- Test that query arguments are type-safe
- Test that model delegates have correct method signatures
- Test client type safety

## Success Criteria

Phase 4 is complete when:

- [ ] All CRUD operations working with mock adapter
- [ ] Full type safety from schema to results
- [ ] Comprehensive test suite passes (integration, unit, and type tests)
- [ ] Error handling works correctly
- [ ] Performance is acceptable for development use
- [ ] API matches Prisma's interface for familiarity
- [ ] Ready for real database adapter integration

## Example Usage Tests

Your implementation should support these usage scenarios:

```typescript
// Basic CRUD operations
const user = await orm.user.create({
  data: { name: "John", email: "john@example.com" },
});

const users = await orm.user.findMany({
  where: { email: { contains: "@gmail.com" } },
  orderBy: { name: "asc" },
  take: 10,
});

// Relations
const userWithPosts = await orm.user.findUnique({
  where: { id: user.id },
  include: { posts: true },
});

// Complex queries
const publishedPosts = await orm.post.findMany({
  where: {
    published: true,
    author: { email: { endsWith: "@company.com" } },
  },
  select: {
    title: true,
    author: { select: { name: true } },
  },
});

// Type inference should work
expectTypeOf(user).toMatchTypeOf<{ id: string; name: string; email: string }>();
expectTypeOf(userWithPosts.posts).toMatchTypeOf<
  Array<{ id: string; title: string /* ... */ }>
>();
```

## Architecture Integration

### With Existing Code

- **Foundation Types**: Use extensively for model introspection
- **Query Input Types**: Use all input types from Phase 3
- **Result Types**: Use all result types from Phase 3
- **Schema System**: Integrate with Model and Field classes

### Future Phases

This phase prepares for:

- **Phase 5**: Real database adapters (PostgreSQL, MySQL)
- **Phase 6**: Advanced features (transactions, migrations, hooks)
- **Phase 7**: Performance optimizations and production features

## Key Design Decisions

### Type Safety Strategy

- Runtime behavior must match compile-time types
- Use generic constraints to ensure adapter compatibility
- Leverage existing type inference system from previous phases

### Error Handling

- Throw descriptive errors for common scenarios
- Use custom error classes for different error types
- Maintain Prisma-compatible error structure

### Performance Considerations

- Lazy model delegate creation
- Efficient query transformation
- Minimal overhead for type inference

## Getting Started

1. **Study existing types** - Understand Phase 3 query input/output types
2. **Start with adapter interface** - Define the foundation
3. **Build mock adapter** - Create testable implementation
4. **Implement basic model delegate** - Start with one operation
5. **Add client integration** - Wire everything together
6. **Test incrementally** - Add one operation at a time

Remember: This phase transforms BaseORM from a type system into a working ORM. Focus on developer experience, type safety, and laying the groundwork for production database adapters.
