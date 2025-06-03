import {
  BaseField,
  BigIntField,
  BooleanField,
  DateTimeField,
  EnumField,
  JsonField,
  NumberField,
  StringField,
} from "../../../schema";
import {
  string,
  number,
  boolean,
  date,
  enum as enumType,
  optional,
  array,
  object,
  nullable,
  type ZodMiniType,
  lazy,
  union,
  literal,
  omit,
  any,
  bigint,
  json,
  extend,
} from "zod/v4-mini";

export type QueryMode = "default" | "insensitive";
export type NullsOrder = "first" | "last";

// Base filter schemas - exported for use in field-filters.ts
export const baseFilter = <Z extends ZodMiniType>(schema: Z) =>
  object({
    equals: optional(schema),
    not: optional(
      union([
        schema,
        object({
          equals: optional(schema),
          notIn: optional(array(schema)),
          in: optional(array(schema)),
        }),
      ])
    ),
    in: optional(array(schema)),
    notIn: optional(array(schema)),
  });

export const baseNullableFilter = <Z extends ZodMiniType>(schema: Z) =>
  object({
    equals: optional(nullable(schema)),
    not: optional(
      union([
        nullable(schema),
        object({
          equals: optional(nullable(schema)),
          notIn: optional(array(schema)),
          in: optional(array(schema)),
        }),
      ])
    ),
    in: optional(array(schema)),
    notIn: optional(array(schema)),
  });

// List/Array filters - exported for use in field-filters.ts
export const baseListFilter = <T extends ZodMiniType>(schema: T) =>
  object({
    equals: optional(array(schema)),
    has: optional(schema),
    hasEvery: optional(array(schema)),
    hasSome: optional(array(schema)),
    isEmpty: optional(boolean()),
  });

export const baseNullableListFilter = <T extends ZodMiniType>(schema: T) =>
  nullable(
    union([
      extend(omit(baseListFilter(schema), { equals: true }), {
        equals: optional(nullable(array(schema))),
      }),
      array(schema),
    ])
  );

// Type inference helper - exported for use in field-filters.ts
export type InferFilter<T> = T extends ZodMiniType ? T["_zod"]["input"] : never;

// Re-export all field filter types and implementations from field-filters.ts
export * from "./field-filters";

// ============================================================================
// LIST FILTERS (Generic)
// ============================================================================
export type ListFilter<T> = InferFilter<ReturnType<typeof baseListFilter<any>>>;

// ============================================================================
// COMPOSITE FILTERS
// ============================================================================
const whereInputBase = <TModel extends ZodMiniType>(modelSchema: TModel) =>
  object({
    AND: optional(union([modelSchema, array(modelSchema)])),
    OR: optional(array(modelSchema)),
    NOT: optional(union([modelSchema, array(modelSchema)])),
  });

export type WhereInputBase<TModel extends ZodMiniType> = InferFilter<
  ReturnType<typeof whereInputBase<TModel>>
>;

// ============================================================================
// FIELD FILTER MAPPING
// ============================================================================
export type FieldFilter<F extends BaseField<any>> = F extends DateTimeField<any>
  ? import("./field-filters").DateTimeFilters<F>
  : F extends StringField<any>
  ? import("./field-filters").StringFilters<F>
  : F extends NumberField<any>
  ? import("./field-filters").NumberFilters<F>
  : F extends BooleanField<any>
  ? import("./field-filters").BooleanFilters<F>
  : F extends BigIntField<any>
  ? import("./field-filters").BigIntFilters<F>
  : F extends JsonField<any, any>
  ? import("./field-filters").JsonFilters<F>
  : F extends EnumField<infer E, infer TState>
  ? import("./field-filters").EnumFilters<F>
  : never;
