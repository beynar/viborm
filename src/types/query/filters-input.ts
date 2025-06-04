import {
  BaseField,
  BigIntField,
  BooleanField,
  DateTimeField,
  EnumField,
  JsonField,
  NumberField,
  StringField,
} from "@schema";
import {
  boolean,
  optional,
  array,
  object,
  nullable,
  type ZodMiniType,
  union,
  omit,
  extend,
  transform,
  pipe,
  core,
  ZodMiniObject,
  refine,
  z,
  string,
} from "zod/v4-mini";

export type QueryMode = "default" | "insensitive";
export type NullsOrder = "first" | "last";

export const rawTransformer = (schema: ZodMiniType) =>
  pipe(
    schema,
    transform((value) => ({
      equals: value,
    }))
  );

// Base filter schemas - exported for use in field-filters.ts
export const baseFilter = <Z extends ZodMiniType>(
  schema: Z,
  extendedObject?: ZodMiniObject
) => {
  const baseFilterSchema = object({
    ...(extendedObject?.def.shape || {}),
    equals: optional(nullable(schema)),
    not: optional(
      union([
        object({
          equals: optional(nullable(schema)),
          notIn: optional(array(schema)),
          in: optional(array(schema)),
        }),
        nullable(schema),
      ])
    ),
    in: optional(array(schema)),
    notIn: optional(array(schema)),
  });
  return union([baseFilterSchema, rawTransformer(schema)]);
  // if (extendedObject) {
  //   return union([
  //     extend(baseFilterSchema, extendedObject.shape),
  //     rawTransformer(schema),
  //   ]);
  // }
};

export const baseNullableFilter = <Z extends ZodMiniType>(
  schema: Z,
  extendedObject?: ZodMiniObject
) => {
  let baseObject = object({
    equals: optional(nullable(schema)),
    not: optional(
      union([
        object({
          equals: optional(nullable(schema)),
          notIn: optional(array(schema)),
          in: optional(array(schema)),
        }),
        nullable(schema),
      ])
    ),
    in: optional(array(schema)),
    notIn: optional(array(schema)),
  });
  if (extendedObject) {
    baseObject = extend(baseObject, extendedObject);
  }
  return union([baseObject, rawTransformer(nullable(schema))]);
};

// List/Array filters - exported for use in field-filters.ts
export const baseListFilter = <T extends ZodMiniType>(schema: T) =>
  union([
    object({
      equals: optional(array(schema)),
      has: optional(schema),
      hasEvery: optional(array(schema)),
      hasSome: optional(array(schema)),
      isEmpty: optional(boolean()),
    }),
    rawTransformer(array(schema)),
  ]);

export const baseNullableListFilter = <T extends ZodMiniType>(schema: T) =>
  union([
    object({
      equals: optional(nullable(array(schema))),
      has: optional(schema),
      hasEvery: optional(array(schema)),
      hasSome: optional(array(schema)),
      isEmpty: optional(boolean()),
    }),
    rawTransformer(array(schema)),
  ]);

// Type inference helper - exported for use in field-filters.ts
export type InferFilter<T> = T extends ZodMiniType ? T["_zod"]["input"] : never;

// Re-export all field filter types and implementations from field-filters.ts
export * from "./field-filters";

// ============================================================================
// LIST FILTERS (Generic)
// ============================================================================
export type ListFilter<T> = InferFilter<ReturnType<typeof baseListFilter<any>>>;

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
