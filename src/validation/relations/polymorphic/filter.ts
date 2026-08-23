import type { VariantRelationState } from "@schema/relation";
import v from "@validation/primitives/v";
import { createSchema, fail, validateSchema } from "../../primitives/helpers";
import type { VibSchema } from "../../types";
import { isRecord } from "../../value-guards";
import type {
  TaggedPredicateInput,
  TaggedPredicateOutput,
} from "./tagged-predicate";
import { taggedTargetPredicate } from "./tagged-predicate";
import type {
  ExactPolymorphicTargetSchemaGetters,
  PolymorphicSchema,
  PolymorphicTargetSchemaGetters,
} from "./types";

type FilterInput<Getters> = TaggedPredicateInput<Getters>;

type FilterOutput<Getters> = TaggedPredicateOutput<Getters>;

type PresenceFilter =
  | { readonly is: null; readonly isNot?: never }
  | { readonly is?: never; readonly isNot: null };

export type PolymorphicFilterSchema<
  State extends VariantRelationState,
  Getters,
> = PolymorphicSchema<
  | FilterInput<Getters>
  | (State["optional"] extends true ? PresenceFilter | null : never),
  | FilterOutput<Getters>
  | (State["optional"] extends true ? PresenceFilter : never)
>;

export function polymorphicFilterFactory<
  State extends VariantRelationState,
  Getters extends PolymorphicTargetSchemaGetters<State>,
>(
  state: State,
  targetSchemas: ExactPolymorphicTargetSchemaGetters<State, Getters>
): PolymorphicFilterSchema<State, Getters> {
  const schemaGetters: PolymorphicTargetSchemaGetters<State> = targetSchemas;
  const targetFilter = taggedTargetPredicate(state, schemaGetters);
  const isNull = v.object({ is: v.literal(null) }, { partial: false });
  const isNotNull = v.object({ isNot: v.literal(null) }, { partial: false });
  const presenceMembers: readonly [typeof isNull, typeof isNotNull] = [
    isNull,
    isNotNull,
  ];
  const presenceFilter = v.union(presenceMembers);
  const nullShorthand = v.literal(null, {
    transform: (): { readonly is: null } => ({ is: null }),
  });
  const optional = state.optional === true;
  const options: readonly VibSchema<unknown, unknown>[] = optional
    ? [nullShorthand, presenceFilter, targetFilter]
    : [targetFilter];
  const schema = createSchema<unknown, unknown>("union", (value) => {
    if (value === null) {
      return optional
        ? validateSchema(nullShorthand, value)
        : fail("Expected polymorphic filter with a type");
    }
    if (!isRecord(value)) return fail("Expected object");
    if (Object.hasOwn(value, "type")) {
      return validateSchema(targetFilter, value);
    }
    return optional
      ? validateSchema(presenceFilter, value)
      : fail("Expected polymorphic filter with a type");
  });
  (schema as { options?: unknown }).options = options;
  return schema as PolymorphicFilterSchema<State, Getters>;
}

// =============================================================================
// COLLECTION QUANTIFIERS — cardinality `"many"`
// =============================================================================

/**
 * `{ some | every | none }` over the SAME tagged predicate the to-one filter
 * uses, and nothing else.
 *
 * NO null-presence arm. A collection has no null state — an empty collection is
 * the empty array, not `null` — so `is: null` / `isNot: null` would be a second
 * spelling of "empty" that disagrees with the result type. Callers asking
 * "is it empty" write `none: { type: … }` or a `_count` filter.
 *
 * NO hand-written `Object.hasOwn(value, "type")` dispatcher either. That lives
 * in the to-one factory to disambiguate the bare-`null` shorthand from the
 * tagged form; with no shorthand and no presence arm there is nothing to
 * disambiguate, and the strict object's own "Unknown key" is already the right
 * message.
 *
 * Every quantifier carries a TYPE. `some: { type: "post", is: … }` asks about
 * post members specifically — the plan's §7.3 rule that `every` means "every
 * member of the named variant satisfies the predicate AND no member of another
 * variant exists", which the engine lowers as a conjunction rather than trusting
 * a `NOT EXISTS` spelling to mean it.
 */
export type PolymorphicCollectionFilterSchema<Getters> = PolymorphicSchema<
  {
    readonly some?: FilterInput<Getters>;
    readonly every?: FilterInput<Getters>;
    readonly none?: FilterInput<Getters>;
  },
  {
    readonly some?: FilterOutput<Getters>;
    readonly every?: FilterOutput<Getters>;
    readonly none?: FilterOutput<Getters>;
  }
>;

export function polymorphicCollectionFilterFactory<
  State extends VariantRelationState,
  Getters extends PolymorphicTargetSchemaGetters<State>,
>(
  state: State,
  targetSchemas: ExactPolymorphicTargetSchemaGetters<State, Getters>
): PolymorphicCollectionFilterSchema<Getters> {
  const schemaGetters: PolymorphicTargetSchemaGetters<State> = targetSchemas;
  const predicate = taggedTargetPredicate(state, schemaGetters);
  return v.object({
    some: predicate,
    every: predicate,
    none: predicate,
  }) as PolymorphicCollectionFilterSchema<Getters>;
}
