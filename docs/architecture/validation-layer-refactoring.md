# Validation Layer Refactoring

> Historical rationale: this document describes the pre-`SchemaRegistry` architecture and the motivation for moving operation schemas into `src/validation/`. The implemented branch uses `SchemaRegistry`; keep this file as context, not as current implementation guidance.

## Overview

This document describes a major architectural change to separate operation schemas (create, update, filter, etc.) from database schema definitions. The goal is to centralize all validation logic in the `src/validation/` layer, enabling full type context during schema building.

## Motivation

### The Problem

Before this migration, operation schemas lived directly on models, relations, and fields via their `~.schemas` property. This created issues:

1. **Limited Type Context**: When building nested create schemas, we need to know which FK fields to omit (they're derived from the parent record). However, the `source` model is typed as `AnyModel` at the schema level because schemas are built in isolation.

2. **Tight Coupling**: Database schema definitions (what columns exist, their types) are mixed with operation logic (how to validate create/update inputs).

### The Solution

Move all operation schemas to a dedicated validation layer with a central builder that has full schema context. This enables:

- Proper FK field inference for nested creates
- Clear separation of concerns
- Better testability

## Pre-Migration Structure

```
src/schema/
├── scalars/
│   ├── boolean/
│   │   ├── scalar.ts         # Scalar class definition
│   │   └── schemas.ts        # Operation schemas (filter, update, create)
│   ├── string/
│   │   ├── scalar.ts
│   │   └── schemas.ts
│   └── ... (13 scalar types total)
│
├── relation/
│   ├── to-one.ts             # Relation class definitions
│   ├── to-many.ts
│   ├── many-to-many.ts
│   └── schemas/              # Relation operation schemas
│       ├── create.ts
│       ├── filter.ts
│       ├── update.ts
│       ├── order-by.ts
│       ├── select-include.ts
│       ├── count-filter.ts
│       └── helpers.ts
│
├── model/
│   ├── model.ts              # Model class definition
│   └── schemas/              # Model operation schemas
│       ├── core/             # where, create, update, select, orderby, filter
│       ├── args/             # findMany, create, update, delete, aggregate
│       ├── model-schemas.ts  # Lazy ModelSchemas class
│       └── utils.ts

src/validation/
├── schemas/                  # Validation primitives (v.object, v.string, etc.)
│   ├── object.ts
│   ├── string.ts
│   ├── number.ts
│   └── ...
├── helpers.ts
├── inferred.ts
├── types.ts
├── V.ts                      # Type namespace
└── json-schema/              # JSON Schema conversion
```

### Problems with the Pre-Migration Structure

1. **Schemas on `~` accessor**: Each field, relation, and model exposes `~.schemas`, building operation schemas on demand without full context.

2. **Isolated schema building**: `getRelationSchemas(state)` only has access to the relation's own state, not the parent model or full schema.

3. **Mixed concerns**: Each scalar directory (e.g., `src/schema/scalars/boolean/`) contains both the scalar class definition (`scalar.ts` - what a boolean scalar is) and its operation schemas (`schemas.ts` - how to validate create/update/filter inputs). These are different responsibilities that should live in separate layers.

## Proposed Structure

```
src/validation/
├── primitives/               # Renamed from schemas/
│   ├── object.ts
│   ├── string.ts
│   ├── number.ts
│   ├── boolean.ts
│   ├── array.ts
│   ├── union.ts
│   ├── literal.ts
│   ├── nullable.ts
│   ├── optional.ts
│   ├── lazy.ts               # Lazy primitive for deferred evaluation
│   ├── ...
│   ├── helpers.ts            # Moved from validation/
│   ├── inferred.ts           # Moved from validation/
│   ├── types.ts              # Moved (deduplicated ObjectOptions)
│   ├── V.ts                  # Type namespace
│   └── index.ts              # export *
│
├── scalars/                  # Scalar operation schemas
│   ├── boolean.ts            # From src/schema/scalars/boolean/schemas.ts
│   ├── string.ts             # From src/schema/scalars/string/schemas.ts
│   ├── int.ts
│   ├── float.ts
│   ├── decimal.ts
│   ├── bigint.ts
│   ├── datetime.ts
│   ├── json.ts
│   ├── blob.ts
│   ├── enum.ts
│   ├── vector.ts
│   ├── point.ts
│   ├── number.ts             # Unified number scalar
│   ├── common.ts             # Shorthand helpers (shorthandFilter, shorthandUpdate, etc.)
│   └── index.ts              # export *
│
├── relations/                # Relation operation schemas
│   ├── create.ts             # From src/schema/relation/schemas/create.ts
│   ├── filter.ts
│   ├── update.ts
│   ├── order-by.ts
│   ├── select-include.ts
│   ├── count-filter.ts
│   ├── helpers.ts
│   └── index.ts              # export *
│
├── models/                   # Model operation schemas
│   ├── core/
│   │   ├── where.ts
│   │   ├── create.ts
│   │   ├── update.ts
│   │   ├── select.ts
│   │   ├── orderby.ts
│   │   ├── filter.ts
│   │   └── index.ts
│   ├── args/
│   │   ├── find.ts
│   │   ├── mutation.ts
│   │   ├── aggregate.ts
│   │   └── index.ts
│   ├── utils.ts
│   └── index.ts              # export *
│
├── builder.ts                # Central schema builder
├── json-schema/              # Unchanged
├── index.ts                  # export *
└── exports.ts                # Public API
```

## Key Changes

### 1. Rename `schemas/` to `primitives/`

The `src/validation/schemas/` folder contains validation primitives (`v.object`, `v.string`, etc.), not operation schemas. Renaming to `primitives/` clarifies this distinction.

### 2. Create `scalars/` Directory

Move all scalar operation schemas from `src/schema/scalars/*/schemas.ts`.

The directory includes a `createScalarSchemas` factory that returns properly typed scalar schemas wrapped in `lazy`:

```typescript
// src/validation/scalars/index.ts

export function createScalarSchemas<T extends ModelState>(
  state: T,
): ScalarSchemas<T> {
  return Object.fromEntries(
    Object.entries(state.scalars).map(([key, scalar]) => [
      key,
      {
        base: lazy(() => scalar["~"].state.base),
        create: lazy(() => buildScalarCreateSchema(scalar)),
        update: lazy(() => buildScalarUpdateSchema(scalar)),
        filter: lazy(() => buildScalarFilterSchema(scalar)),
      },
    ]),
  ) as ScalarSchemas<T>;
}
```

The `common.ts` file with shorthand helpers (`shorthandFilter`, `shorthandUpdate`, `shorthandArray`) also moves here.

### 3. Create `relations/` Directory

Move relation schemas from `src/schema/relation/schemas/`.

The directory includes a `createRelationSchemas` factory that returns properly typed relation schemas wrapped in `lazy`. The schema structure varies based on whether the relation is toOne or toMany:

```typescript
// src/validation/relations/index.ts

// For toMany relations (oneToMany, manyToMany)
function createToManySchemas(state: RelationState): ToManySchemas {
  return {
    filter: lazy(() => toManyFilterFactory(state)),
    create: lazy(() => toManyCreateFactory(state)),
    update: lazy(() => toManyUpdateFactory(state)),
    select: lazy(() => toManySelectFactory(state)),
    include: lazy(() => toManyIncludeFactory(state)),
    orderBy: lazy(() => toManyOrderByFactory(state)),
    countFilter: lazy(() => countFilterFactory(state)),
  };
}

// For toOne relations (manyToOne, oneToOne)
function createToOneSchemas(state: RelationState): ToOneSchemas {
  return {
    filter: lazy(() => toOneFilterFactory(state)),
    create: lazy(() => toOneCreateFactory(state)),
    update: lazy(() => toOneUpdateFactory(state)),
    select: lazy(() => toOneSelectFactory(state)),
    include: lazy(() => toOneIncludeFactory(state)),
    orderBy: lazy(() => toOneOrderByFactory(state)),
    countFilter: lazy(() => countFilterFactory(state)),
  };
}

// Main factory iterates over state.relations and dispatches to the appropriate builder
export function createRelationSchemas<T extends ModelState>(
  state: T,
): RelationSchemas<T>;
```

The return type `RelationSchemas<T>` is properly typed to reflect the different schema shapes for toOne vs toMany relations.

Individual schema builders remain in separate files:

- `create.ts` - `toOneCreateFactory`, `toManyCreateFactory`
- `filter.ts` - `toOneFilterFactory`, `toManyFilterFactory`
- `update.ts` - `toOneUpdateFactory`, `toManyUpdateFactory`
- `order-by.ts` - `toOneOrderByFactory`, `toManyOrderByFactory`
- `select-include.ts` - select/include factories
- `count-filter.ts` - `countFilterFactory`
- `helpers.ts` - `getTargetCreateSchema`, `getTargetWhereSchema`, etc.

### 4. Create `models/` Directory

Move model schemas from `src/schema/model/schemas/`.

The directory includes two factories: `createCoreSchemas` for core schemas and `createOperationSchemas` for operation args, both returning properly typed schemas wrapped in `lazy`:

```typescript
// src/validation/models/core/index.ts

export function createCoreSchemas<T extends ModelState>(
  state: T,
): CoreSchemas<T> {
  return {
    scalarFilter: lazy(() => getScalarFilter(state)),
    uniqueFilter: lazy(() => getUniqueFilter(state)),
    relationFilter: lazy(() => getRelationFilter(state)),
    compoundIdFilter: lazy(() => getCompoundIdFilter(state)),
    compoundConstraintFilter: lazy(() => getCompoundConstraintFilter(state)),
    scalarCreate: lazy(() => getScalarCreate(state)),
    nestedScalarCreate: lazy(() => getNestedScalarCreate(state)),
    relationCreate: lazy(() => getRelationCreate(state)),
    scalarUpdate: lazy(() => getScalarUpdate(state)),
    relationUpdate: lazy(() => getRelationUpdate(state)),
    where: lazy(() => getWhereSchema(state)),
    whereUnique: lazy(() => getWhereUniqueSchema(state)),
    create: lazy(() => getCreateSchema(state)),
    update: lazy(() => getUpdateSchema(state)),
    select: lazy(() => getSelectSchema(state)),
    include: lazy(() => getIncludeSchema(state)),
    orderBy: lazy(() => getOrderBySchema(state)),
  };
}
```

```typescript
// src/validation/models/args/index.ts

export function createOperationSchemas<T extends ModelState>(
  state: T,
  core: CoreSchemas<T>,
): OperationSchemas<T> {
  return {
    findUnique: lazy(() => getFindUniqueArgs(core)),
    findFirst: lazy(() => getFindFirstArgs(core)),
    findMany: lazy(() => getFindManyArgs(state, core)),
    create: lazy(() => getCreateArgs(core)),
    createMany: lazy(() => getCreateManyArgs(core)),
    update: lazy(() => getUpdateArgs(core)),
    updateMany: lazy(() => getUpdateManyArgs(core)),
    delete: lazy(() => getDeleteArgs(core)),
    deleteMany: lazy(() => getDeleteManyArgs(core)),
    upsert: lazy(() => getUpsertArgs(core)),
    count: lazy(() => getCountArgs(state, core)),
    aggregate: lazy(() => getAggregateArgs(state, core)),
    groupBy: lazy(() => getGroupByArgs(state, core)),
  };
}
```

Individual schema builders remain in separate files:

- `core/` - Base schemas (where, create, update, select, orderby, filter)
- `args/` - Operation argument schemas (find, mutation, aggregate)
- `utils.ts` - Iteration helpers (`forEachRelation`, `forEachScalarField`)

Note: The `ModelSchemas` class is removed. All lazy evaluation is handled by the `lazy` primitive from `primitives/lazy.ts`, providing a consistent approach across scalar schemas, relation schemas, and model schemas.

### 5. Create Central Builder (`builder.ts`)

The builder receives the full schema and builds all operation schemas with complete context:

```typescript
// src/validation/builder.ts

import type { AnySchema } from "@schema";

export interface SchemaBuilder<TSchema extends AnySchema> {
  // Access to the full schema for context
  schema: TSchema;

  // Model schemas with full type inference
  model<TModelKey extends keyof TSchema["models"]>(
    key: TModelKey,
  ): ModelSchemas<TSchema["models"][TModelKey]>;

  // Relation schemas with source model context
  relation<TModel, TRelationKey extends keyof TModel["relations"]>(
    model: TModel,
    key: TRelationKey,
  ): RelationSchemas<TModel["relations"][TRelationKey], TModel>;
}

export function buildSchemas<TSchema extends AnySchema>(
  schema: TSchema,
): SchemaBuilder<TSchema> {
  // Implementation with full context available
}
```

This enables proper FK field inference:

```typescript
// With full context, we can now properly omit FK fields in nested creates
const postCreateSchema = builder.relation(User, "posts");
// The builder knows User is the source, can find inverse relation,
// and automatically omit the userId field
```

### 6. Create Lazy Primitive (`primitives/lazy.ts`)

A lazy primitive for deferred schema evaluation, useful for performance optimization:

```typescript
// src/validation/primitives/lazy.ts

export function lazy<T extends VibSchema>(factory: () => T): LazySchema<T> {
  let cached: T | undefined;
  return {
    get schema() {
      return (cached ??= factory());
    },
    // ... validation methods that delegate to resolved schema
  };
}
```

### 7. Remove `schemas` from `~` Properties

Currently:

```typescript
// Model
get "~"() {
  return {
    state: this._state,
    schemas: (this._schemas ??= new ModelSchemas(this._state)),
  };
}
```

After:

```typescript
// Model - no more schemas property
get "~"() {
  return {
    state: this._state,
  };
}

// Schemas accessed via builder
const schemas = buildSchemas(mySchema);
const userSchemas = schemas.model("User");
```

### 8. Update Index Files

All index files use `export *` for cleaner re-exports:

```typescript
// src/validation/scalars/index.ts
export * from "./boolean";
export * from "./string";
export * from "./int";
// ...

// src/validation/index.ts
export * from "./primitives";
export * from "./scalars";
export * from "./relations";
export * from "./models";
export { buildSchemas } from "./builder";
```

### 9. Create `exports.ts`

Define the public API explicitly:

```typescript
// src/validation/exports.ts

// Primitives
export { object, string, number, boolean, array, union } from "./primitives";

// Builder
export { buildSchemas, type SchemaBuilder } from "./builder";

// Types
export type { InferInput, InferOutput, VibSchema } from "./primitives/types";
```

## Migration Path

### Phase 1: Create New Structure

1. Create `src/validation/primitives/` and move files
2. Create `src/validation/scalars/` with copied schemas
3. Create `src/validation/relations/` with copied schemas
4. Create `src/validation/models/` with copied schemas
5. Update all internal imports

### Phase 2: Create Builder

1. Implement `src/validation/primitives/lazy.ts`
2. Implement `src/validation/builder.ts`
3. Add `v.omit()` support for FK field removal

### Phase 3: Remove Old Schemas

1. Remove `schemas` from model/relation/scalar `~` properties
2. Delete old schema files from `src/schema/`
3. Update all consumers to use the builder

### Phase 4: Cleanup

1. Update public exports
2. Update documentation
3. Run full test suite

## Benefits

### Full Context for FK Inference

The builder has access to the complete schema, enabling:

```typescript
// Before: Unable to infer source model type
const createSchema = relation["~"].schemas.create; // Can't omit FK fields

// After: Full context available
const createSchema = builder.relation(User, "posts").create;
// Knows User is source, omits userId automatically
```

### Separation of Concerns

- **Database Schema** (`src/schema/`): Defines structure - models, fields (scalars and relations), constraints
- **Validation** (`src/validation/`): Defines operations - how to validate inputs for create/update/filter

### Easier Testing

Operation schemas become pure functions:

```typescript
// Easy to test in isolation
const booleanSchemas = buildBooleanSchema({
  type: "boolean",
  nullable: false,
  array: false,
  // ...
});

expect(booleanSchemas.filter).toBeDefined();
```

### Better Type Inference

Generic builder preserves full type information through the chain:

```typescript
const builder = buildSchemas(mySchema);
const userCreate = builder.model("User").create;
// userCreate is fully typed with all fields
```

## Builder Output Structure

The builder produces a `Schemas` object keyed by model name. Each model exposes its scalar schemas, relation schemas, core schemas, and operation schemas. All top-level schemas use the `lazy` primitive for automatic caching on first access.

```typescript
type Schemas<T extends AnySchema> = {
  [Model in keyof T["models"]]: {
    scalars: {
      [Scalar in keyof T["models"][Model]["scalars"]]: {
        base: lazy<
          ScalarSchemas<
            T["models"][Model]["scalars"][Scalar]["~"]["state"]
          >["base"]
        >;
        create: lazy<
          ScalarSchemas<
            T["models"][Model]["scalars"][Scalar]["~"]["state"]
          >["create"]
        >;
        update: lazy<
          ScalarSchemas<
            T["models"][Model]["scalars"][Scalar]["~"]["state"]
          >["update"]
        >;
        filter: lazy<
          ScalarSchemas<
            T["models"][Model]["scalars"][Scalar]["~"]["state"]
          >["filter"]
        >;
      };
    };
    relations: {
      [Relation in keyof T["models"][Model]["relations"]]: {
        filter: lazy<
          RelationSchemas<
            T["models"][Model]["relations"][Relation]["~"]["state"]
          >["filter"]
        >;
        create: lazy<
          RelationSchemas<
            T["models"][Model]["relations"][Relation]["~"]["state"],
            T["models"][Model]
          >["create"]
        >;
        update: lazy<
          RelationSchemas<
            T["models"][Model]["relations"][Relation]["~"]["state"]
          >["update"]
        >;
        select: lazy<
          RelationSchemas<
            T["models"][Model]["relations"][Relation]["~"]["state"]
          >["select"]
        >;
        include: lazy<
          RelationSchemas<
            T["models"][Model]["relations"][Relation]["~"]["state"]
          >["include"]
        >;
        orderBy: lazy<
          RelationSchemas<
            T["models"][Model]["relations"][Relation]["~"]["state"]
          >["orderBy"]
        >;
        countFilter: lazy<
          RelationSchemas<
            T["models"][Model]["relations"][Relation]["~"]["state"]
          >["countFilter"]
        >;
      };
    };
    core: {
      scalarFilter: lazy<ScalarFilterSchema<T>>;
      uniqueFilter: lazy<UniqueFilterSchema<T>>;
      relationFilter: lazy<RelationFilterSchema<T>>;
      compoundIdFilter: lazy<CompoundIdFilterSchema<T>>;
      compoundConstraintFilter: lazy<CompoundConstraintFilterSchema<T>>;
      scalarCreate: lazy<ScalarCreateSchema<T>>;
      nestedScalarCreate: lazy<NestedScalarCreateSchema<T>>;
      relationCreate: lazy<RelationCreateSchema<T>>;
      scalarUpdate: lazy<ScalarUpdateSchema<T>>;
      relationUpdate: lazy<RelationUpdateSchema<T>>;
      where: lazy<WhereSchema<T>>;
      whereUnique: lazy<WhereUniqueSchema<T>>;
      create: lazy<CreateSchema<T>>;
      update: lazy<UpdateSchema<T>>;
      select: lazy<SelectSchema<T>>;
      include: lazy<IncludeSchema<T>>;
      orderBy: lazy<OrderBySchema<T>>;
    };
    operations: {
      findUnique: lazy<FindUniqueArgs<T>>;
      findFirst: lazy<FindFirstArgs<T>>;
      findMany: lazy<FindManyArgs<T>>;
      create: lazy<CreateArgs<T>>;
      createMany: lazy<CreateManyArgs<T>>;
      update: lazy<UpdateArgs<T>>;
      updateMany: lazy<UpdateManyArgs<T>>;
      delete: lazy<DeleteArgs<T>>;
      deleteMany: lazy<DeleteManyArgs<T>>;
      upsert: lazy<UpsertArgs<T>>;
      count: lazy<CountArgs<T>>;
      aggregate: lazy<AggregateArgs<T>>;
      groupBy: lazy<GroupByArgs<T>>;
    };
  };
};
```

Usage example:

```typescript
const schemas = buildSchemas(mySchema);

// Access model operation schemas
const findManyArgs = schemas.User.operations.findMany;

// Access scalar schemas
const emailFilter = schemas.User.fields.email.filter;

// Access relation schemas
const postsCreate = schemas.User.relations.posts.create;

// Access core schemas
const whereSchema = schemas.User.core.where;
```
