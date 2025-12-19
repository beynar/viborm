// Relation Schema Factories
// Builds filter, create, update schemas for relations using Valibot

import {
  lazy,
  object,
  optional,
  array,
  boolean,
  union,
  partial,
  pipe,
  transform,
  type InferInput,
  type BaseSchema,
  nullable,
  number,
  string,
} from "valibot";
import type { Getter, RelationState, RelationType } from "./relation";

// =============================================================================
// TYPE HELPERS
// =============================================================================

export type AnyRelationSchema = BaseSchema<any, any, any>;

export interface RelationSchemas {
  filter: AnyRelationSchema;
  create: AnyRelationSchema;
  update: AnyRelationSchema;
  select: AnyRelationSchema;
  include: AnyRelationSchema;
  orderBy: AnyRelationSchema;
}

// =============================================================================
// HELPER: Get target model schemas lazily
// =============================================================================

/**
 * Get the target model's where schema lazily
 */
const getTargetWhereSchema = (state: RelationState): AnyRelationSchema => {
  return lazy(() => {
    const targetModel = state.getter();
    return targetModel["~"].schemas?.where;
  });
};

/**
 * Get the target model's whereUnique schema lazily
 */
const getTargetWhereUniqueSchema = (
  state: RelationState
): AnyRelationSchema => {
  return lazy(() => {
    const targetModel = state.getter();
    return targetModel["~"].schemas?.whereUnique;
  });
};

/**
 * Get the target model's create schema lazily
 */
const getTargetCreateSchema = (state: RelationState): AnyRelationSchema => {
  return lazy(() => {
    const targetModel = state.getter();
    return targetModel["~"].schemas?.create;
  });
};

/**
 * Get the target model's update schema lazily
 */
const getTargetUpdateSchema = (state: RelationState): AnyRelationSchema => {
  return lazy(() => {
    const targetModel = state.getter();
    return targetModel["~"].schemas?.update;
  });
};

// =============================================================================
// HELPER: Normalize single value to array
// =============================================================================

const ensureArray = <T>(v: T | T[]): T[] => (Array.isArray(v) ? v : [v]);

/**
 * Schema that accepts single or array, normalizes to array
 */
const singleOrArray = (schema: AnyRelationSchema): AnyRelationSchema => {
  return pipe(union([schema, array(schema)]), transform(ensureArray));
};

// =============================================================================
// SELECT & INCLUDE SCHEMAS
// =============================================================================

/**
 * To-one select: true or nested { select }
 */
const toOneSelectFactory = <S extends RelationState>(
  state: S
): AnyRelationSchema => {
  return union([
    boolean(),
    partial(
      object({
        select: optional(lazy(() => state.getter()["~"].schemas?.select)),
      })
    ),
  ]);
};

/**
 * To-many select: true or nested { where, orderBy, take, skip, select }
 */
const toManySelectFactory = <S extends RelationState>(
  state: S
): AnyRelationSchema => {
  return union([
    boolean(),
    partial(
      object({
        where: optional(lazy(() => state.getter()["~"].schemas?.where)),
        orderBy: optional(lazy(() => state.getter()["~"].schemas?.orderBy)),
        take: optional(number()),
        skip: optional(number()),
        select: optional(lazy(() => state.getter()["~"].schemas?.select)),
      })
    ),
  ]);
};

/**
 * To-one include: true or nested { select, include }
 */
const toOneIncludeFactory = <S extends RelationState>(
  state: S
): AnyRelationSchema => {
  return union([
    boolean(),
    partial(
      object({
        select: optional(lazy(() => state.getter()["~"].schemas?.select)),
        include: optional(lazy(() => state.getter()["~"].schemas?.include)),
      })
    ),
  ]);
};

/**
 * To-many include: true or nested { where, orderBy, take, skip, cursor, select, include }
 */
const toManyIncludeFactory = <S extends RelationState>(
  state: S
): AnyRelationSchema => {
  return union([
    boolean(),
    partial(
      object({
        where: optional(lazy(() => state.getter()["~"].schemas?.where)),
        orderBy: optional(lazy(() => state.getter()["~"].schemas?.orderBy)),
        take: optional(number()),
        skip: optional(number()),
        cursor: optional(string()),
        select: optional(lazy(() => state.getter()["~"].schemas?.select)),
        include: optional(lazy(() => state.getter()["~"].schemas?.include)),
      })
    ),
  ]);
};

// =============================================================================
// ORDER BY SCHEMAS
// =============================================================================

/**
 * To-one orderBy: nested orderBy from the related model's fields
 * e.g., orderBy: { author: { name: 'asc' } }
 */
const toOneOrderByFactory = <S extends RelationState>(
  state: S
): AnyRelationSchema => {
  return lazy(() => state.getter()["~"].schemas?.orderBy);
};

/**
 * To-many orderBy: can order by _count aggregate
 * e.g., orderBy: { posts: { _count: 'desc' } }
 */
const toManyOrderByFactory = <S extends RelationState>(
  _state: S
): AnyRelationSchema => {
  return object({
    _count: optional(union([literal("asc"), literal("desc")])),
  });
};

// =============================================================================
// FILTER SCHEMAS
// =============================================================================

/**
 * To-one filter: { is?, isNot? }
 * For optional relations, `is` can also be null
 */
const toOneFilterFactory = <S extends RelationState>(
  state: S
): AnyRelationSchema => {
  const whereSchema = getTargetWhereSchema(state);

  return partial(
    object({
      is: state.optional
        ? optional(nullable(whereSchema))
        : optional(whereSchema),
      isNot: optional(whereSchema),
    })
  );
};

/**
 * To-many filter: { some?, every?, none? }
 */
const toManyFilterFactory = <S extends RelationState>(
  state: S
): AnyRelationSchema => {
  const whereSchema = getTargetWhereSchema(state);

  return partial(
    object({
      some: optional(whereSchema),
      every: optional(whereSchema),
      none: optional(whereSchema),
    })
  );
};

// =============================================================================
// CREATE SCHEMAS
// =============================================================================

/**
 * To-one create: { create?, connect?, connectOrCreate? }
 */
const toOneCreateFactory = <S extends RelationState>(
  state: S
): AnyRelationSchema => {
  const createSchema = getTargetCreateSchema(state);
  const whereUniqueSchema = getTargetWhereUniqueSchema(state);

  return partial(
    object({
      create: optional(createSchema),
      connect: optional(whereUniqueSchema),
      connectOrCreate: optional(
        object({
          where: whereUniqueSchema,
          create: createSchema,
        })
      ),
    })
  );
};

/**
 * To-many create: { create?, connect?, connectOrCreate? }
 * All accept single or array, normalized to array
 */
const toManyCreateFactory = <S extends RelationState>(
  state: S
): AnyRelationSchema => {
  const createSchema = getTargetCreateSchema(state);
  const whereUniqueSchema = getTargetWhereUniqueSchema(state);

  const connectOrCreateSchema = object({
    where: whereUniqueSchema,
    create: createSchema,
  });

  return partial(
    object({
      create: optional(singleOrArray(createSchema)),
      connect: optional(singleOrArray(whereUniqueSchema)),
      connectOrCreate: optional(singleOrArray(connectOrCreateSchema)),
    })
  );
};

// =============================================================================
// UPDATE SCHEMAS
// =============================================================================

/**
 * To-one update: { create?, connect?, update?, upsert?, disconnect?, delete? }
 * disconnect and delete only available for optional relations
 */
const toOneUpdateFactory = <S extends RelationState>(
  state: S
): AnyRelationSchema => {
  const createSchema = getTargetCreateSchema(state);
  const updateSchema = getTargetUpdateSchema(state);
  const whereUniqueSchema = getTargetWhereUniqueSchema(state);

  const baseEntries = {
    create: optional(createSchema),
    connect: optional(whereUniqueSchema),
    update: optional(updateSchema),
    upsert: optional(
      object({
        create: createSchema,
        update: updateSchema,
      })
    ),
  };

  // Optional relations can disconnect/delete
  if (state.optional) {
    return partial(
      object({
        ...baseEntries,
        disconnect: optional(boolean()),
        delete: optional(boolean()),
      })
    );
  }

  return partial(object(baseEntries));
};

/**
 * To-many update: { create?, connect?, disconnect?, set?, delete?, update?, updateMany?, deleteMany?, upsert? }
 * Most operations accept single or array
 */
const toManyUpdateFactory = <S extends RelationState>(
  state: S
): AnyRelationSchema => {
  const createSchema = getTargetCreateSchema(state);
  const updateSchema = getTargetUpdateSchema(state);
  const whereSchema = getTargetWhereSchema(state);
  const whereUniqueSchema = getTargetWhereUniqueSchema(state);

  const updateWithWhereSchema = object({
    where: whereUniqueSchema,
    data: updateSchema,
  });

  const updateManyWithWhereSchema = object({
    where: whereSchema,
    data: updateSchema,
  });

  const upsertSchema = object({
    where: whereUniqueSchema,
    create: createSchema,
    update: updateSchema,
  });

  const connectOrCreateSchema = object({
    where: whereUniqueSchema,
    create: createSchema,
  });

  return partial(
    object({
      // Single or array operations
      create: optional(singleOrArray(createSchema)),
      connect: optional(singleOrArray(whereUniqueSchema)),
      disconnect: optional(singleOrArray(whereUniqueSchema)),
      delete: optional(singleOrArray(whereUniqueSchema)),
      connectOrCreate: optional(singleOrArray(connectOrCreateSchema)),
      // Array-only operations
      set: optional(array(whereUniqueSchema)),
      update: optional(array(updateWithWhereSchema)),
      updateMany: optional(array(updateManyWithWhereSchema)),
      deleteMany: optional(array(whereSchema)),
      upsert: optional(array(upsertSchema)),
    })
  );
};

// =============================================================================
// SCHEMA BUNDLES
// =============================================================================

const toOneSchemas = <S extends RelationState>(state: S): RelationSchemas => {
  return {
    filter: toOneFilterFactory(state),
    create: toOneCreateFactory(state),
    update: toOneUpdateFactory(state),
    select: toOneSelectFactory(state),
    include: toOneIncludeFactory(state),
    orderBy: toOneOrderByFactory(state),
  } as unknown as ToOneSchemas<S>;
};

const toManySchemas = <S extends RelationState>(state: S): RelationSchemas => {
  return {
    filter: toManyFilterFactory(state),
    create: toManyCreateFactory(state),
    update: toManyUpdateFactory(state),
    select: toManySelectFactory(state),
    include: toManyIncludeFactory(state),
    orderBy: toManyOrderByFactory(state),
  };
};

// =============================================================================
// TYPE INFERENCE
// =============================================================================

export type ToOneSchemas<S extends RelationState> = {
  filter: ReturnType<typeof toOneFilterFactory<S>>;
  create: ReturnType<typeof toOneCreateFactory<S>>;
  update: ReturnType<typeof toOneUpdateFactory<S>>;
  select: ReturnType<typeof toOneSelectFactory<S>>;
  include: ReturnType<typeof toOneIncludeFactory<S>>;
  orderBy: ReturnType<typeof toOneOrderByFactory<S>>;
};

export type ToManySchemas<S extends RelationState> = {
  filter: ReturnType<typeof toManyFilterFactory<S>>;
  create: ReturnType<typeof toManyCreateFactory<S>>;
  update: ReturnType<typeof toManyUpdateFactory<S>>;
  select: ReturnType<typeof toManySelectFactory<S>>;
  include: ReturnType<typeof toManyIncludeFactory<S>>;
  orderBy: ReturnType<typeof toManyOrderByFactory<S>>;
};

export type InferRelationSchemas<S extends RelationState> = S["type"] extends
  | "manyToMany"
  | "oneToMany"
  ? ToManySchemas<S>
  : ToOneSchemas<S>;

// =============================================================================
// MAIN EXPORT
// =============================================================================

/**
 * Get all schemas for a relation based on its type
 */
export const getRelationSchemas = <S extends RelationState>(
  state: S
): RelationSchemas => {
  const isToMany = state.type === "manyToMany" || state.type === "oneToMany";
  return isToMany ? toManySchemas(state) : toOneSchemas(state);
};

/**
 * Infer input type for a specific relation schema
 */
export type InferRelationInput<
  S extends RelationState,
  Type extends keyof RelationSchemas
> = InferInput<InferRelationSchemas<S>[Type]>;
