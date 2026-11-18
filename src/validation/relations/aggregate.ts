// Relation Aggregate Schema
// The `_aggregate` entry of one relation: the target's `aggregate` arguments,
// without the page, over the rows that relation reaches.

import type { RelationState } from "@schema/relation/types";
import v, { type V } from "../primitives/v";
import type { VibSchema } from "../types";
import { isRecord } from "../value-guards";
import type { GetTargetSchemas, SchemaGetter } from "./helpers";

type AggregateEntries<S extends RelationState> =
  GetTargetSchemas<S>["args"]["aggregate"]["entries"];

/**
 * An entry that selects no aggregate asks for nothing: `{ where }` alone, or
 * `_sum: {}`. Refused at its own path, as a `select` that names nothing is.
 * Every key beside `where` is an aggregate.
 */
const requireAggregate = (
  entry: Record<string, unknown>
): string | undefined =>
  Object.entries(entry).some(
    ([key, selection]) =>
      key !== "where" &&
      (selection === true ||
        (isRecord(selection) && Object.values(selection).some(Boolean)))
  )
    ? undefined
    : "An aggregate of a relation selects at least one field of '_count', '_sum', '_avg', '_min' or '_max'.";

/**
 * `_aggregate: { posts: { where?, _count?, _sum?, _avg?, _min?, _max? } }`.
 *
 * The target model's own `aggregate` members, read from its memoized schema, so
 * a field admits exactly the aggregates `client.post.aggregate()` admits for it
 * and refuses the rest with the same sentence. No page: `take`, `skip`,
 * `cursor` and `orderBy` would each need a derived table per entry, and none
 * changes what an unpaged aggregate answers.
 */
export type RelationAggregateSchema<S extends RelationState> = V.Object<
  Pick<
    AggregateEntries<S>,
    "where" | "_count" | "_avg" | "_sum" | "_min" | "_max"
  >,
  { readonly refuse: typeof requireAggregate }
>;

export const relationAggregateFactory = <
  S extends RelationState,
  T extends SchemaGetter<S>,
>(
  targetSchemas: T
): RelationAggregateSchema<S> => {
  const { where, _count, _avg, _sum, _min, _max } =
    targetSchemas().args.aggregate.entries;
  return v.object(
    { where, _count, _avg, _sum, _min, _max },
    { refuse: requireAggregate }
  ) as RelationAggregateSchema<S>;
};

/** A to-one relation reaches one row at most: its aggregate is the field itself. */
export const toOneAggregateRefusal = (): VibSchema<never, never> =>
  v.refused(
    "A to-one relation has no rows to aggregate; select its fields instead."
  );

/** The arms of a polymorphic slot share no column to aggregate. */
export const polymorphicAggregateRefusal = (): VibSchema<never, never> =>
  v.refused(
    "A polymorphic slot cannot be aggregated: its members live in different tables, with no column in common; use '_count'."
  );
