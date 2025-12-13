// JSON Field Schemas
// Factory pattern handling optional StandardSchema for typed validation

import { z, ZodJSONSchema } from "zod/v4";

import {
  array,
  boolean,
  nullable,
  object,
  optional,
  partial,
  string,
  union,
  _default,
  extend,
  json,
  pipe,
  type input as Input,
  type output as Output,
  ZodMiniType,
  ZodMiniJSONSchema,
  core,
  ZodMiniNullable,
  prefault,
} from "zod/v4-mini";
import type { StandardSchemaV1 } from "../../../standardSchema";
import {
  FieldState,
  isOptional,
  shorthandFilter,
  shorthandUpdate,
} from "../common";
import { StandardSchemaToZod, zodFromStandardSchema } from "../standard-schema";

// =============================================================================
// BASE BUILDERS
// =============================================================================

export const jsonBase = <const S extends StandardSchemaV1 | undefined>(
  schema: S
) =>
  !schema
    ? json()
    : (zodFromStandardSchema(schema) as S extends StandardSchemaV1
        ? StandardSchemaToZod<S>
        : ZodMiniJSONSchema);

const jsonNullable = <S extends StandardSchemaV1 | undefined>(schema: S) => {
  return nullable(jsonBase(schema)) as S extends StandardSchemaV1
    ? ZodMiniNullable<StandardSchemaToZod<S>>
    : ZodMiniNullable<ZodMiniJSONSchema>;
};

// =============================================================================
// FILTER FACTORIES
// =============================================================================

const jsonFilterFactory = <const B extends ZodMiniType>(base: B) => {
  const filterBase = partial(
    object({
      equals: base,
      path: array(string()),
      string_contains: string(),
      string_starts_with: string(),
      string_ends_with: string(),
      array_contains: base,
      array_starts_with: base,
      array_ends_with: base,
    })
  );
  return union([
    extend(filterBase, {
      not: optional(union([filterBase, shorthandFilter(base)])),
    }),
    shorthandFilter(base),
  ]);
};

const jsonNullableFilterFactory = <B extends ZodMiniNullable>(base: B) => {
  const filterBase = partial(
    object({
      equals: base,
      path: array(string()),
      string_contains: string(),
      string_starts_with: string(),
      string_ends_with: string(),
      array_contains: base.def.innerType,
      array_starts_with: base.def.innerType,
      array_ends_with: base.def.innerType,
    })
  );
  return union([
    extend(filterBase, {
      not: optional(union([filterBase, base])),
    }),
    shorthandFilter(base),
  ]);
};

// =============================================================================
// CREATE FACTORIES
// =============================================================================

const jsonCreate = <B extends ZodMiniType>(base: B) => base;

const jsonOptionalCreate = <B extends ZodMiniType>(base: B) => optional(base);

type NoUndefined<T> = T extends undefined ? never : T;

const jsonOptionalNullableCreate = <B extends ZodMiniNullable>(base: B) => {
  return _default(optional(base), null as NoUndefined<Output<B>>);
};

// =============================================================================
// UPDATE FACTORIES
// =============================================================================

const jsonUpdateFactory = <B extends ZodMiniType>(base: B) => {
  return union([partial(object({ set: base })), shorthandUpdate(base)]);
};

const jsonNullableUpdateFactory = <B extends ZodMiniType>(base: B) => {
  return union([partial(object({ set: base })), shorthandUpdate(base)]);
};

// =============================================================================
// SCHEMA FACTORIES
// =============================================================================

export const jsonSchemas = <S extends FieldState<"json">>(state: S) => {
  const base = jsonBase(state.schema);
  return {
    base,
    filter: jsonFilterFactory(base),
    create: jsonCreate(base),
    update: jsonUpdateFactory(base),
  } as unknown as JsonSchemas<S>;
};

export const jsonNullableSchemas = <S extends FieldState<"json">>(state: S) => {
  const base = jsonNullable(state.schema);
  return {
    base,
    filter: jsonNullableFilterFactory(base),
    create: jsonOptionalNullableCreate(base),
    update: jsonNullableUpdateFactory(base),
  } as unknown as JsonNullableSchemas<S>;
};

export type JsonSchemas<S extends FieldState<"json">> =
  S["schema"] extends StandardSchemaV1
    ? {
        base: ZodMiniNullable<StandardSchemaToZod<S["schema"]>>;
        filter: ReturnType<
          typeof jsonNullableFilterFactory<
            ZodMiniNullable<StandardSchemaToZod<S["schema"]>>
          >
        >;
        create: isOptional<S> extends true
          ? ReturnType<
              typeof jsonOptionalCreate<
                ZodMiniNullable<StandardSchemaToZod<S["schema"]>>
              >
            >
          : ReturnType<
              typeof jsonCreate<
                ZodMiniNullable<StandardSchemaToZod<S["schema"]>>
              >
            >;
        update: ReturnType<
          typeof jsonNullableUpdateFactory<
            ZodMiniNullable<StandardSchemaToZod<S["schema"]>>
          >
        >;
      }
    : {
        base: ZodMiniNullable<ZodMiniJSONSchema>;
        filter: ReturnType<
          typeof jsonNullableFilterFactory<ZodMiniNullable<ZodMiniJSONSchema>>
        >;
        create: isOptional<S> extends true
          ? ReturnType<
              typeof jsonOptionalCreate<ZodMiniNullable<ZodMiniJSONSchema>>
            >
          : ReturnType<typeof jsonCreate<ZodMiniNullable<ZodMiniJSONSchema>>>;
        update: ReturnType<
          typeof jsonNullableUpdateFactory<ZodMiniNullable<ZodMiniJSONSchema>>
        >;
      };

export type JsonNullableSchemas<S extends FieldState<"json">> =
  S["schema"] extends StandardSchemaV1
    ? {
        base: StandardSchemaToZod<S["schema"]>;
        filter: ReturnType<
          typeof jsonFilterFactory<StandardSchemaToZod<S["schema"]>>
        >;
        create: ReturnType<
          typeof jsonOptionalNullableCreate<
            ZodMiniNullable<StandardSchemaToZod<S["schema"]>>
          >
        >;
        update: ReturnType<
          typeof jsonUpdateFactory<StandardSchemaToZod<S["schema"]>>
        >;
      }
    : {
        base: ZodMiniJSONSchema;
        filter: ReturnType<typeof jsonFilterFactory<ZodMiniJSONSchema>>;
        create: ReturnType<typeof jsonCreate<ZodMiniJSONSchema>>;
        update: ReturnType<typeof jsonUpdateFactory<ZodMiniJSONSchema>>;
      };

// =============================================================================
// TYPE HELPERS
// =============================================================================

export type InferJsonSchemas<F extends FieldState<"json">> =
  F["nullable"] extends true ? JsonNullableSchemas<F> : JsonSchemas<F>;

export type InferJsonInput<
  F extends FieldState<"json">,
  Type extends "create" | "update" | "filter" | "base"
> = Input<InferJsonSchemas<F>[Type]>;

// =============================================================================
// MAIN SCHEMA GETTER
// =============================================================================

export const getFieldJsonSchemas = <S extends FieldState<"json">>(state: S) => {
  return (
    state.nullable ? jsonNullableSchemas(state) : jsonSchemas(state)
  ) as InferJsonSchemas<S>;
};
