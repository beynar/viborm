import type { VariantRelationState } from "@schema/relation";
import v from "@validation/primitives/v";
import type { VibSchema } from "@validation/types";
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

/**
 * `_count: { select: { items: true | { where } } }` over a collection.
 *
 * `true` counts every member of every configured variant — the engine sums one
 * correlated count per member table, in declaration order. The filtered form
 * takes the SAME tagged predicate the quantifier filter takes, which is what
 * makes "count the posts matching P" and "some post matches P" two readings of
 * one grammar rather than two grammars.
 *
 * `true` is accepted rather than required-object for parity with the ordinary
 * `countFilterFactory`; there is no reason for a polymorphic collection to be
 * spelled differently from an ordinary list at this key.
 */
export type PolymorphicCollectionCountFilterSchema<Getters> = PolymorphicSchema<
  true | { readonly where?: TaggedPredicateInput<Getters> },
  true | { readonly where?: TaggedPredicateOutput<Getters> }
>;

export function polymorphicCollectionCountFilterFactory<
  State extends VariantRelationState,
  Getters extends PolymorphicTargetSchemaGetters<State>,
>(
  state: State,
  targetSchemas: ExactPolymorphicTargetSchemaGetters<State, Getters>
): PolymorphicCollectionCountFilterSchema<Getters> {
  const schemaGetters: PolymorphicTargetSchemaGetters<State> = targetSchemas;
  return v.union([
    v.literal(true),
    v.object({
      where: taggedTargetPredicate(state, schemaGetters),
    }),
  ]) as PolymorphicCollectionCountFilterSchema<Getters>;
}

/**
 * A to-one slot holds at most one membership, and `_count` is defined over
 * LISTS — Prisma's `<Model>CountOutputType` contains only list relations, and
 * the plan keeps that rule. Refused by name rather than omitted so the caller
 * reads the reason instead of "Unknown key".
 */
export const polymorphicToOneCountFilterRefusal = (): VibSchema<never, never> =>
  v.refused("A polymorphic to-one slot has no collection to count.");
