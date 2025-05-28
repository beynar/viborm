# Phase 3: Query Input Types Implementation

## Context

You are continuing the development of VibORM, a TypeScript ORM with zero-generation, fully type-safe capabilities. Phase 2 (Foundation Types) has been completed successfully. Now we move to Phase 3: implementing the Query Input Types that will enable Prisma-like querying capabilities.

## Current State

- ✅ Schema Builder is implemented (`src/schema/`)
- ✅ Foundation Types completed (`src/types/client/foundation/`)
- ✅ Model and Field classes exist (`src/schema/model.ts`, `src/schema/fields/base.ts`)
- ✅ Type inference utilities like `InferType<TState>`, `InferInputType<TState>`
- ✅ Comprehensive model introspection and field mapping types
- ✅ Existing filter types in `src/types/client/filters.ts`

## Phase 3 Objectives

Implement **Query Input Types** that enable Prisma-like query operations. These types will allow developers to write type-safe queries like:

```typescript
// Target API we want to support
const users = await orm.user.findMany({
  where: {
    name: { contains: "john" },
    email: { endsWith: "@gmail.com" },
    age: { gte: 18, lte: 65 },
    posts: { some: { published: true } },
  },
  orderBy: [{ createdAt: "desc" }, { name: "asc" }],
  select: {
    id: true,
    name: true,
    posts: {
      select: { title: true, publishedAt: true },
    },
  },
  take: 10,
  skip: 20,
});
```

## Implementation Plan

### 1. Core Query Input Types

Create `src/types/client/query/` directory with the following files:

#### A. Where Input Types (`where-input.ts`)

Build upon existing filter types to create model-specific where inputs:

- `WhereInput<TModel>` - Main filtering interface for a model
- `WhereUniqueInput<TModel>` - Filtering by unique fields only
- `ScalarWhereInput<TModel>` - Filtering on scalar fields only
- `NestedWhereInput<TModel, TRelation>` - Filtering through relations

**Key Requirements:**

- Use foundation types (`FieldNames<TModel>`, `GetIdFields<TModel>`, etc.)
- Support all scalar filter operations (eq, not, in, notIn, contains, etc.)
- Support relation filtering (some, every, none)
- Handle nullable vs non-nullable fields correctly
- Support nested AND/OR logic

#### B. Order By Input Types (`orderby-input.ts`)

- `OrderByInput<TModel>` - Ordering interface for a model
- `OrderByWithRelationInput<TModel>` - Ordering including relations
- `SortOrder` - "asc" | "desc" | "asc_nulls_first" | "desc_nulls_last"

**Key Requirements:**

- Allow ordering by any scalar field
- Support ordering by relation counts
- Handle multiple sort criteria
- Support nulls positioning

#### C. Selection Input Types (`select-input.ts`)

- `SelectInput<TModel>` - Field selection interface
- `IncludeInput<TModel>` - Relation inclusion interface
- `OmitInput<TModel>` - Field omission interface
- Nested selection for relations

**Key Requirements:**

- Boolean selection for scalar fields
- Nested selection objects for relations
- Mutual exclusivity between select and include
- Type-safe result inference

### 2. Operation Argument Types

Create `src/types/client/operations/` directory:

#### A. Find Operation Args (`find-args.ts`)

- `FindManyArgs<TModel>` - Arguments for findMany operations
- `FindUniqueArgs<TModel>` - Arguments for findUnique operations
- `FindFirstArgs<TModel>` - Arguments for findFirst operations

#### B. Mutation Operation Args (`mutation-args.ts`)

- `CreateArgs<TModel>` - Arguments for create operations
- `CreateManyArgs<TModel>` - Arguments for createMany operations
- `UpdateArgs<TModel>` - Arguments for update operations
- `UpdateManyArgs<TModel>` - Arguments for updateMany operations
- `UpsertArgs<TModel>` - Arguments for upsert operations
- `DeleteArgs<TModel>` - Arguments for delete operations
- `DeleteManyArgs<TModel>` - Arguments for deleteMany operations

**Key Requirements:**

- Use foundation `MapModelCreateFields<TModel>` and `MapModelUpdateFields<TModel>`
- Integrate with where, select, include inputs
- Handle nested relation operations (connect, create, update, delete)

### 3. Result Type Inference

Create `src/types/client/results/` directory:

#### A. Query Result Types (`query-results.ts`)

- `QueryResult<TModel, TArgs>` - Infer result based on select/include
- `FindResult<TModel, TArgs>` - Single record result
- `FindManyResult<TModel, TArgs>` - Array result
- `CountResult` - Count operation result

**Key Requirements:**

- Dynamically infer result shape based on select/include arguments
- Handle partial selections correctly
- Include relation data when included
- Preserve type safety throughout

### 4. Advanced Query Features

#### A. Aggregation Input Types (`aggregation-input.ts`)

- `AggregateArgs<TModel>` - Arguments for aggregate operations
- `GroupByArgs<TModel>` - Arguments for groupBy operations
- `CountArgs<TModel>` - Arguments for count operations

#### B. Nested Operations (`nested-operations.ts`)

- `NestedCreateInput<TModel, TRelation>` - Creating through relations
- `NestedUpdateInput<TModel, TRelation>` - Updating through relations
- `NestedConnectInput<TModel, TRelation>` - Connecting existing records
- `NestedDisconnectInput<TModel, TRelation>` - Disconnecting relations

## Implementation Guidelines

### Type Safety Requirements

1. **Full Generic Support**: All types must work with any Model instance
2. **Foundation Integration**: Leverage all foundation types extensively
3. **Dynamic Inference**: Results must be inferred from query arguments
4. **Prisma Compatibility**: API should match Prisma's interface exactly
5. **Edge Case Handling**: Support optional fields, relations, unique constraints

### Architecture Patterns

1. **Conditional Types**: Use conditional types for dynamic behavior
2. **Mapped Types**: Create object types from model definitions
3. **Template Literals**: For string manipulation where needed
4. **Utility Types**: Build composable, reusable type utilities
5. **Type Guards**: Runtime validation where necessary

### Testing Strategy

Create comprehensive tests in `tests/types/client/query/`:

1. **Type Tests**: Use `expectTypeOf().toEqualTypeOf()` for type correctness
2. **Integration Tests**: Test with actual model instances
3. **Edge Cases**: Test with complex models (many relations, optional fields)
4. **API Surface**: Verify Prisma compatibility

### Example Test Cases

Your implementation should support these test scenarios:

```typescript
// Where input should work correctly
expectTypeOf<WhereInput<UserModel>>().toMatchTypeOf<{
  id?: StringFilter;
  name?: StringFilter;
  email?: StringFilter;
  posts?: PostListRelationFilter;
  AND?: WhereInput<UserModel>[];
  OR?: WhereInput<UserModel>[];
  NOT?: WhereInput<UserModel>;
}>();

// Select input should infer correctly
type UserSelect = SelectInput<UserModel>;
expectTypeOf<UserSelect>().toMatchTypeOf<{
  id?: boolean;
  name?: boolean;
  email?: boolean;
  posts?: boolean | PostSelectInput;
}>();

// Result inference should work
type FindManyResult = QueryResult<
  UserModel,
  {
    select: { id: true; name: true; posts: { select: { title: true } } };
  }
>;
expectTypeOf<FindManyResult>().toEqualTypeOf<
  {
    id: string;
    name: string;
    posts: { title: string }[];
  }[]
>();
```

## Success Criteria

Phase 3 is complete when:

- [ ] All query input types are implemented and working
- [ ] Full Prisma API compatibility for basic operations
- [ ] Type-safe result inference from query arguments
- [ ] Comprehensive test suite passes (type and integration tests)
- [ ] Complex nested queries work correctly
- [ ] Integration with foundation types is seamless
- [ ] Documentation includes usage examples

## Integration Points

### With Foundation Types

- Use `FieldNames<TModel>`, `RelationNames<TModel>` extensively
- Leverage `MapModelCreateFields<TModel>`, `MapModelUpdateFields<TModel>`
- Build on `IsFieldId<TField>`, `IsFieldUnique<TField>` for validation
- Integrate with `GetIdFields<TModel>`, `GetUniqueFields<TModel>`

### With Existing Code

- Extend existing filter types in `src/types/client/filters.ts`
- Work with Model and Field classes from `src/schema/`
- Use FieldState system for type inference
- Integrate with relation system from `src/schema/relation.ts`

## Future Considerations

This phase sets up the foundation for:

- Query Builder implementation (Phase 4)
- Client/ORM implementation (Phase 5)
- Advanced features (transactions, hooks, etc.)

## Getting Started

1. **Study the foundation types** - Understand what's available in `src/types/client/foundation/`
2. **Examine existing filters** - Review `src/types/client/filters.ts` for patterns
3. **Start with WhereInput** - Begin with the most fundamental query type
4. **Build incrementally** - Add one type at a time with tests
5. **Test extensively** - Both type-level and integration testing
6. **Challenge assumptions** - Question design decisions and suggest improvements

Remember: The goal is a type-safe, Prisma-compatible query interface that leverages the robust foundation we've built. Focus on developer experience and type safety above all else.
