import v, {
  createSchema,
  type ValidationResult,
  type VibSchema,
} from "@validation";
import type { RelationState } from "../relation";
import { getTargetOrderBySchema } from "./helpers";

/**
 * To-one orderBy: nested orderBy from the related model's fields
 * e.g., orderBy: { author: { name: 'asc' } }
 *
 * Creates a lazy schema that delegates to the target model's orderBy schema.
 * This avoids circular reference issues while returning a proper VibSchema.
 */
export const toOneOrderByFactory = <S extends RelationState>(state: S) => {
  // Get the thunk that resolves to the target model's orderBy schema
  const getTargetOrderBy = getTargetOrderBySchema(state);

  // Create a lazy schema that delegates validation to the target's orderBy
  return createSchema<unknown, unknown>(
    "lazy",
    (value): ValidationResult<unknown> => {
      const targetOrderBySchema = getTargetOrderBy() as VibSchema | undefined;
      if (!(targetOrderBySchema && targetOrderBySchema["~standard"])) {
        return { issues: [{ message: "OrderBy schema not available" }] };
      }
      const result = targetOrderBySchema["~standard"].validate(value);
      if ("then" in result) {
        return { issues: [{ message: "Async schemas are not supported" }] };
      }
      if (result.issues) {
        return {
          issues: result.issues as { message: string; path?: PropertyKey[] }[],
        };
      }
      return { value: (result as { value: unknown }).value };
    }
  );
};

/**
 * To-many orderBy: can order by _count aggregate
 * e.g., orderBy: { posts: { _count: 'desc' } }
 */
export const toManyOrderByFactory = <S extends RelationState>(_state: S) => {
  return v.object({
    _count: v.enum(["asc", "desc"]),
  });
};
