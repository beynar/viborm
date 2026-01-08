import v, {
  type BaseJsonSchema,
  type InferInput,
  type InferOutput,
} from "@validation";
import type { V } from "@validation/V";
import type { FieldState } from "../common";

// =============================================================================
// BASE TYPES
// =============================================================================

export const jsonBase = v.json();
export const jsonNullable = v.json({ nullable: true });

// =============================================================================
// FILTER TYPES
// =============================================================================

type JsonFilterBase<S extends V.Schema> = {
  equals: S;
  path: V.Array<V.String>;
  string_contains: V.String;
  string_starts_with: V.String;
  string_ends_with: V.String;
  array_contains: S;
  array_starts_with: S;
  array_ends_with: S;
};

export type JsonFilterSchema<S extends V.Schema> = V.Object<
  JsonFilterBase<S> & {
    not: V.Object<JsonFilterBase<S>>;
  }
>;

// =============================================================================
// UPDATE TYPES
// =============================================================================

export type JsonUpdateSchema<S extends V.Schema> = V.Coerce<
  S,
  { set: S[" vibInferred"]["1"] }
>;

// =============================================================================
// SCHEMA BUILDERS
// =============================================================================

const buildJsonFilterSchema = <S extends V.Schema>(
  schema: S
): JsonFilterSchema<S> => {
  const filter = v.object({
    equals: schema,
    path: v.array(v.string()),
    string_contains: v.string(),
    string_starts_with: v.string(),
    string_ends_with: v.string(),
    array_contains: schema,
    array_starts_with: schema,
    array_ends_with: schema,
  });
  return filter.extend({
    not: filter,
  });
};

const buildJsonUpdateSchema = <S extends V.Schema>(
  schema: S
): JsonUpdateSchema<S> =>
  v.coerce(schema, (value: S[" vibInferred"]["0"]) => {
    return {
      set: value,
    };
  });

// =============================================================================
// JSON SCHEMA BUILDER
// =============================================================================

export interface JsonSchemas<F extends FieldState<"json">> {
  base: F["base"];
  create: BaseJsonSchema<F>;
  update: JsonUpdateSchema<F["base"]>;
  filter: JsonFilterSchema<F["base"]>;
}

export const buildJsonSchema = <F extends FieldState<"json">>(
  state: F
): JsonSchemas<F> => {
  return {
    base: state.base as F["base"],
    create: v.json(state),
    update: buildJsonUpdateSchema(state.base),
    filter: buildJsonFilterSchema(state.base),
  } as JsonSchemas<F>;
};

export type InferJsonInput<
  F extends FieldState<"json">,
  Type extends keyof JsonSchemas<F>,
> = InferInput<JsonSchemas<F>[Type]>;

export type InferJsonOutput<
  F extends FieldState<"json">,
  Type extends keyof JsonSchemas<F>,
> = InferOutput<JsonSchemas<F>[Type]>;
