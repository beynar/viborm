import { FieldState } from "../common";
import v, {
  BaseJsonSchema,
  InferInput,
  InferOutput,
  VibSchema,
} from "@validation";

// =============================================================================
// BASE TYPES
// =============================================================================

export const jsonBase = v.json();
export const jsonNullable = v.json({ nullable: true });

// =============================================================================
// FILTER SCHEMAS
// =============================================================================

const buildJsonFilterSchema = <S extends VibSchema>(schema: S) => {
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

const buildJsonUpdateSchema = <S extends VibSchema>(schema: S) =>
  v.coerce(schema, (value: S[" vibInferred"]["0"]) => {
    return {
      set: value,
    };
  });

export const buildJsonSchema = <F extends FieldState<"json">>(state: F) => {
  return {
    base: state.base,
    create: v.json(state),
    update: buildJsonUpdateSchema(state.base),
    filter: buildJsonFilterSchema(state.base),
  } as JsonSchemas<F>;
};

export type JsonSchemas<F extends FieldState<"json">> = {
  base: F["base"];
  create: BaseJsonSchema<F>;
  update: ReturnType<typeof buildJsonUpdateSchema<F["base"]>>;
  filter: ReturnType<typeof buildJsonFilterSchema<F["base"]>>;
};

export type InferJsonInput<
  F extends FieldState<"json">,
  Type extends "create" | "update" | "filter" | "base"
> = InferInput<JsonSchemas<F>[Type]>;

export type InferJsonOutput<
  F extends FieldState<"json">,
  Type extends "create" | "update" | "filter" | "base"
> = InferOutput<JsonSchemas<F>[Type]>;
