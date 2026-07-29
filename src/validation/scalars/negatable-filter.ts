import type { ObjectEntries, ObjectSchema } from "../primitives/object";
import v, { type V } from "../primitives/v";

/**
 * Shared shape for every scalar filter that supports `not`.
 *
 * `not` is LAZILY SELF-REFERENTIAL: its object arm is the very same filter
 * object, so `not: { not: { not: … } }` validates at ANY depth. This matches
 * both Prisma (whose scalar filters nest `not` without a cap) and the SQL
 * builder, which has always recursed without one — `buildFilterOperation`'s
 * `not` branch calls straight back into `buildScalarFilterObject`
 * ({@link file://../../query-engine/builders/where-builder.ts}). Before this,
 * validation capped nesting at ONE level and rejected payloads the engine was
 * perfectly able to compile.
 *
 * The cycle is tied with {@link v.lazyRef} rather than a direct reference so
 * the union can name the object that is still being constructed. `lazyRef`
 * only resolves when its validator is CALLED, and it sits inside a union (not
 * as a bare object entry), so the object validator never duck-types metadata
 * off it.
 */
export interface NegatableFilter<
  S extends V.Schema,
  TBase extends ObjectEntries,
> extends V.Object<TBase & { not: NegatableFilterSchema<S, TBase> }> {}

/**
 * The scalar filter surface: the shorthand value (`"foo"` → `{ equals: "foo" }`)
 * or the filter object. Also the type of `not` itself — negating a filter
 * accepts exactly what filtering accepts, which is what makes it recursive.
 */
export type NegatableFilterSchema<
  S extends V.Schema,
  TBase extends ObjectEntries,
> = V.Union<readonly [V.ShorthandFilter<S>, NegatableFilter<S, TBase>]>;

/**
 * Builds the union above from a filter-object schema that does NOT yet carry
 * `not`; the returned schema carries it at every depth.
 *
 * @param base - the operator object for this scalar (`equals`/`in`/`lt`/…)
 * @param schema - the scalar's base schema, used for the shorthand arm
 */
export const buildNegatableFilterSchema = <
  S extends V.Schema,
  TBase extends ObjectEntries,
>(
  base: ObjectSchema<TBase>,
  schema: S
): NegatableFilterSchema<S, TBase> => {
  const negatable: NegatableFilter<S, TBase> = base.extend({
    not: v.union([v.shorthandFilter(schema), v.lazyRef(() => negatable)]),
  });
  return v.union([v.shorthandFilter(schema), negatable]);
};
