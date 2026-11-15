/**
 * Default order: per model, the order its reads take when the caller gives
 * no `orderBy`. It reads no argument and filters no row.
 */
import type { Input } from "@query-engine/raptor3/shared/schema";
import type { AnyModel } from "@schema/model";
import { getModelKeyCatalog } from "@schema/model/keys";
import { isPlainRecord } from "@schema/relation/terminal";

const UNORDERED_SCALARS = new Set(["json", "vector", "point", "blob"]);

/**
 * One model's default order, read once: its terms, each `{ field: "asc" |
 * "desc" }`, or `undefined` where they are refused. The model must have a
 * row key (its reads end with it, so the order is total) and each field
 * must be one of its scalars that orders as a value (not a list, JSON,
 * vector or point).
 */
export function orderOf(
  model: AnyModel,
  given: unknown
): readonly Input[] | undefined {
  const terms = Array.isArray(given) ? given : [given];
  const { scalars } = model["~"].state;
  const valid =
    getModelKeyCatalog(model).rowKey !== undefined &&
    terms.length > 0 &&
    terms.every((term) => {
      const [field, ...others] = isPlainRecord(term) ? Object.keys(term) : [];
      const state =
        field !== undefined && Object.hasOwn(scalars, field)
          ? scalars[field]!["~"].state
          : undefined;
      // A field was read off `term`, so it is a record.
      const direction = state && (term as Input)[field!];
      return (
        others.length === 0 &&
        (direction === "asc" || direction === "desc") &&
        !state.array &&
        !UNORDERED_SCALARS.has(state.type)
      );
    });
  return valid ? terms.map((term) => ({ ...term })) : undefined;
}
