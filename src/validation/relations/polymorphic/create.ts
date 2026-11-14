import type { VariantRelationState } from "@schema/relation";
import type { InferInput, InferOutput } from "@validation/types";
import {
  type ToOneMutationSchema,
  toOneMutationSchema,
} from "../to-one-mutation-schema";
import {
  type ExactPolymorphicTargetSchemaGetters,
  type PolymorphicTargetSchemaGetters,
  type TaggedSchema,
  taggedVerbs,
} from "./types";

/**
 * A direct polymorphic payload carries its discriminator INSIDE each verb, so a verb
 * schema is a union over the configured public types and the type-to-selector
 * correlation is a property of that union — not of a projection the enclosing edge
 * applies (that owner, `nested-data-projection`, is for INVERSE edges).
 */

/** The supply verbs a fresh parent can name. Declaration order is the message order. */
export type PolymorphicCreateEntries<Getters> = {
  connect: TaggedSchema<Getters, { where: "whereUnique" }>;
  create: TaggedSchema<Getters, { data: "create" }>;
  connectOrCreate: TaggedSchema<
    Getters,
    { where: "whereUnique"; create: "create" }
  >;
};

export type PolymorphicCreateSchema<Getters> = ToOneMutationSchema<
  PolymorphicCreateEntries<Getters>,
  undefined,
  false,
  "exactlyOne"
>;

export type PolymorphicCreateInput<Getters> = InferInput<
  PolymorphicCreateSchema<Getters>
>;

export type PolymorphicCreateOutput<Getters> = InferOutput<
  PolymorphicCreateSchema<Getters>
>;

/** The three supply verbs, read by the create factory and by the update one. */
export const polymorphicSupplyEntries = <
  State extends VariantRelationState,
  Getters extends PolymorphicTargetSchemaGetters<State>,
>(
  tagged: ReturnType<typeof taggedVerbs<State, Getters>>
): PolymorphicCreateEntries<Getters> => ({
  connect: tagged.core({ where: "whereUnique" }),
  create: tagged.core({ data: "create" }),
  connectOrCreate: tagged.core({ where: "whereUnique", create: "create" }),
});

export function polymorphicCreateFactory<
  State extends VariantRelationState,
  Getters extends PolymorphicTargetSchemaGetters<State>,
>(
  state: State,
  targetSchemas: ExactPolymorphicTargetSchemaGetters<State, Getters>
): PolymorphicCreateSchema<Getters> {
  return toOneMutationSchema(
    polymorphicSupplyEntries(taggedVerbs<State, Getters>(state, targetSchemas)),
    undefined,
    false,
    "exactlyOne"
  ) as unknown as PolymorphicCreateSchema<Getters>;
}
