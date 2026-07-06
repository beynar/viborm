import type { StringKeyOf } from "@schema/model/helper";
import type { RelationState } from "@schema/relation/types";
import v, { type V } from "../primitives/v";
import {
  type SortOrderSchema,
  sortOrderSchema,
} from "@validation/model/core/orderby";
import type { SchemaGetter, TargetModel } from "./helpers";

type TargetScalarKeys<S extends RelationState> = StringKeyOf<
  TargetModel<S>["~"]["state"]["scalars"]
>[];

export type TargetScalarOrderBySchema<S extends RelationState> = V.Object<
  V.FromKeys<TargetScalarKeys<S>, SortOrderSchema>["entries"]
>;

export const getTargetScalarOrderBySchema = <
  S extends RelationState,
  T extends SchemaGetter<S>,
>(
  targetSchemas: T
): TargetScalarOrderBySchema<S> => {
  const scalarKeys = Object.keys(
    targetSchemas().scalars
  ) as TargetScalarKeys<S>;
  const scalarEntries = v.fromKeys<TargetScalarKeys<S>, SortOrderSchema>(
    scalarKeys,
    sortOrderSchema
  );

  return v.object(scalarEntries.entries);
};

/**
 * To-one orderBy: scalar fields from the related model.
 * e.g., orderBy: { author: { name: 'asc' } }
 */
export type ToOneOrderBySchema<S extends RelationState> =
  () => TargetScalarOrderBySchema<S>;

export const toOneOrderByFactory = <
  S extends RelationState,
  T extends SchemaGetter<S>,
>(
  _state: S,
  targetSchemas: T
): ToOneOrderBySchema<S> => {
  return () => getTargetScalarOrderBySchema<S, T>(targetSchemas);
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
