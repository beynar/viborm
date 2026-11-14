import type { VariantRelationState } from "@schema/relation";
import v, { type V } from "@validation/primitives/v";
import {
  type ToOneMutationSchema,
  toOneMutationSchema,
} from "../to-one-mutation-schema";
import {
  type PolymorphicCreateEntries,
  polymorphicSupplyEntries,
} from "./create";
import {
  type ExactPolymorphicTargetSchemaGetters,
  type PolymorphicTargetSchemaGetters,
  type TaggedSchema,
  taggedVerbs,
} from "./types";

type PolymorphicTargetedEntries<Getters> = PolymorphicCreateEntries<Getters> & {
  update: TaggedSchema<Getters, { where: "where"; data: "update" }, "data">;
  upsert: TaggedSchema<Getters, { create: "create"; update: "update" }>;
};

/**
 * Removal is a SLOT fact: only an optional membership may be emptied, so only there
 * do `delete` and `disconnect` exist as keys at all. `disconnect` stays a `true`
 * literal rather than a boolean — `false` is not an inactive spelling of a payload
 * that must carry exactly one intent, it is a value this verb never had.
 */
type PolymorphicRemovalEntries<Getters> = {
  delete: TaggedSchema<Getters, Record<never, never>>;
  disconnect: V.Literal<true>;
};

export type PolymorphicUpdateEntries<
  State extends VariantRelationState,
  Getters,
> = PolymorphicTargetedEntries<Getters> &
  (State["optional"] extends true
    ? PolymorphicRemovalEntries<Getters>
    : Record<never, never>);

export type PolymorphicUpdateSchema<
  State extends VariantRelationState,
  Getters,
> = ToOneMutationSchema<
  PolymorphicUpdateEntries<State, Getters>,
  undefined,
  false,
  "exactlyOne"
>;

export function polymorphicUpdateFactory<
  State extends VariantRelationState,
  Getters extends PolymorphicTargetSchemaGetters<State>,
>(
  state: State,
  targetSchemas: ExactPolymorphicTargetSchemaGetters<State, Getters>
): PolymorphicUpdateSchema<State, Getters> {
  const tagged = taggedVerbs<State, Getters>(state, targetSchemas);
  const targetedEntries = {
    ...polymorphicSupplyEntries(tagged),
    // `where` FILTERS the one connected record; the discriminator and the data
    // are what the engine needs to address it at all.
    update: tagged.core({ where: "where", data: "update" }, ["data"]),
    upsert: tagged.core({ create: "create", update: "update" }),
  };
  if (state.optional !== true) {
    return toOneMutationSchema(
      targetedEntries,
      undefined,
      false,
      "exactlyOne"
    ) as unknown as PolymorphicUpdateSchema<State, Getters>;
  }
  return toOneMutationSchema(
    {
      ...targetedEntries,
      delete: tagged.core({}),
      disconnect: v.literal(true),
    },
    undefined,
    false,
    "exactlyOne"
  ) as unknown as PolymorphicUpdateSchema<State, Getters>;
}
