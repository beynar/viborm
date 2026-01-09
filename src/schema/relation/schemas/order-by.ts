import v, { type V } from "@validation";
import type { RelationState } from "../types";
import { getTargetOrderBySchema, type InferTargetSchema } from "./helpers";

/**
 * To-one orderBy: nested orderBy from the related model's fields
 * e.g., orderBy: { author: { name: 'asc' } }
 */
export type ToOneOrderBySchema<S extends RelationState> =
  () => InferTargetSchema<S, "orderBy">;

export const toOneOrderByFactory = <S extends RelationState>(
  state: S
): ToOneOrderBySchema<S> => {
  return getTargetOrderBySchema(state);
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
