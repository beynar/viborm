import { inferred } from "../inferred";
import type { VibSchema, InferInput, InferOutput, ThunkCast } from "../types";
import { fail, ok, createSchema, validateSchema } from "../helpers";

// =============================================================================
// Array Schema
// =============================================================================

export interface ArraySchema<
  TItem extends VibSchema<any, any> | ThunkCast<any, any>,
  TInput = InferInput<TItem>[],
  TOutput = InferOutput<TItem>[]
> extends VibSchema<TInput, TOutput> {
  readonly type: "array";
  readonly item: TItem;
}

/**
 * Resolve a thunk or return the schema directly.
 */
function resolveItem<T extends VibSchema<any, any> | ThunkCast<any, any>>(
  item: T
): VibSchema<any, any> {
  if (typeof item === "function") {
    return item() as VibSchema<any, any>;
  }
  return item;
}

/**
 * Create an array schema that validates each item.
 * Supports thunks for circular references.
 *
 * @example
 * const tags = v.array(v.string());
 * const scores = v.array(v.number());
 * const nodes = v.array(() => nodeSchema); // Thunk for circular ref
 */
export function array<TItem extends VibSchema<any, any> | ThunkCast<any, any>>(
  item: TItem
): ArraySchema<TItem> {
  // Cache resolved item
  let resolvedItem: VibSchema<any, any> | undefined;

  const schema = createSchema<InferInput<TItem>[], InferOutput<TItem>[]>(
    "array",
    (value) => {
      if (!Array.isArray(value)) {
        return fail(`Expected array, received ${typeof value}`);
      }

      // Resolve thunk on first validation
      if (!resolvedItem) {
        resolvedItem = resolveItem(item);
      }

      const results: InferOutput<TItem>[] = [];
      for (let i = 0; i < value.length; i++) {
        const itemResult = validateSchema(resolvedItem, value[i]);
        if (itemResult.issues) {
          const issue = itemResult.issues[0]!;
          const newPath: PropertyKey[] = [i, ...(issue.path || [])];
          return fail(issue.message, newPath);
        }
        results.push((itemResult as { value: InferOutput<TItem> }).value);
      }

      return ok(results);
    }
  ) as ArraySchema<TItem>;

  (schema as any).item = item;

  return schema;
}
