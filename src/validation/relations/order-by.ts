import type { RelationState } from "@schema/relation/types";
import v, { type V } from "@validation";
import type { GetTargetSchemas, SchemaGetter } from "./helpers";

/**
 * To-one orderBy: nested orderBy from the related model's fields
 * e.g., orderBy: { author: { name: 'asc' } }
 */
export type ToOneOrderBySchema<S extends RelationState> =
  () => GetTargetSchemas<S>["core"]["orderBy"];

export const toOneOrderByFactory = <
  S extends RelationState,
  T extends SchemaGetter<S>,
>(
  _state: S,
  targetSchemas: T
): ToOneOrderBySchema<S> => {
  return () => targetSchemas().core.orderBy;
};

/**
 * To-many orderBy: can order by _count aggregate
 * e.g., orderBy: { posts: { _count: 'desc' } }
 */
export type ToManyOrderBySchema<S extends RelationState> = V.Object<{
  _count: V.Enum<["asc", "desc"]>;
}>;
export const toManyOrderByFactory = <S extends RelationState>(
  _state: S
): ToManyOrderBySchema<S> => {
  return v.object({
    _count: v.enum(["asc", "desc"]),
  });
};
