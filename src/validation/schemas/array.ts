import type { VibSchema, InferInput, InferOutput } from "../types";
import { createSchema, validateArrayItems } from "../helpers";

// =============================================================================
// Array Schema
// =============================================================================

export interface ArraySchema<
  TItem extends VibSchema<any, any>,
  TInput = InferInput<TItem>[],
  TOutput = InferOutput<TItem>[]
> extends VibSchema<TInput, TOutput> {
  readonly type: "array";
  readonly item: TItem;
}

/**
 * Create an array schema that validates each item.
 *
 * @example
 * const tags = v.array(v.string());
 * const scores = v.array(v.number());
 */
export function array<TItem extends VibSchema<any, any>>(
  item: TItem
): ArraySchema<TItem> {
  // Cache the validate function directly
  const validate = item["~standard"].validate;

  const schema = createSchema<InferInput<TItem>[], InferOutput<TItem>[]>(
    "array",
    (value) => validateArrayItems(value, validate)
  ) as ArraySchema<TItem>;

  (schema as any).item = item;

  return schema;
}
