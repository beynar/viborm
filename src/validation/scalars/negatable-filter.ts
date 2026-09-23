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
/**
 * `path` and `mode` SCOPE a filter; they do not state one. A JSON filter that
 * carries only a path asks nothing about the document, and a `mode` beside no
 * text operator folds nothing — which is why "at least one key" is not the
 * rule and "at least one OPERATION" is.
 */
const FILTER_MODIFIER_KEYS: ReadonlySet<string> = new Set(["path", "mode"]);

/**
 * The sentence an empty filter object answers.
 *
 * The lowerer spelled the field (`Filter for field 'name' must contain at
 * least one operation.`) because it held the field name. This owner is the
 * per-scalar filter object, INTERNED per scalar type, so it validates every
 * `string` field of every model from one instance and cannot name one. The
 * field is not lost: the refusal is a {@link ValidationError} issue whose
 * `path` is `where.name`, which is where an admission refusal names its
 * subject.
 */
export const FILTER_WITHOUT_OPERATION =
  "Filter must contain at least one operation.";

/**
 * The whole-object refusal every scalar filter object carries: `{}`,
 * `{ equals: undefined }` and `{ path: [...] }` state no operation and must
 * not lower to TRUE — `updateMany({ where: { name: {} } })` would touch every
 * row. `where: {}` (no field at all) still matches everything; this is a rule
 * about a FILTER, not about a `where`.
 *
 * The operator vocabulary is not restated here: the object is STRICT, so every
 * key it admits is one of its own, and the rule is "a key that is not a
 * modifier, with a value". That is what keeps the rule true for the objects
 * that are EXTENDED later — a list filter extended with `_count`/`_avg` for
 * `having` (`model/args/aggregate.ts`) states an operation through the
 * extension, and an operator list captured at build time would refuse it.
 */
export const requireFilterOperation = (
  value: Record<string, unknown>
): string | undefined =>
  Object.entries(value).some(
    ([key, member]) => !FILTER_MODIFIER_KEYS.has(key) && member !== undefined
  )
    ? undefined
    : FILTER_WITHOUT_OPERATION;

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
  const negatable: NegatableFilter<S, TBase> = v.object(
    {
      ...base.entries,
      not: v.union([v.shorthandFilter(schema), v.lazyRef(() => negatable)]),
    },
    { refuse: requireFilterOperation }
  ) as unknown as NegatableFilter<S, TBase>;
  return v.union([v.shorthandFilter(schema), negatable]);
};
