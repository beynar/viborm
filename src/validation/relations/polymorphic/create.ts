import type { VariantRelationState } from "@schema/relation";
import v from "@validation/primitives/v";
import type { InferInput, InferOutput, VibSchema } from "@validation/types";
import {
  type ToOneMutationSchema,
  toOneMutationSchema,
} from "../to-one-mutation-schema";
import type {
  CoreInputAt,
  CoreOutputAt,
  ExactPolymorphicTargetSchemaGetters,
  PolymorphicTargetSchemaGetters,
} from "./types";
import { polymorphicPublicTypes } from "./types";

/**
 * A direct polymorphic payload carries its discriminator INSIDE each verb, so a verb
 * schema is a union over the configured public types and the type-to-selector
 * correlation is a property of that union — not of a projection the enclosing edge
 * applies (that owner, `nested-data-projection`, is for INVERSE edges).
 */
type ConnectInput<Getters> = {
  [PublicType in Extract<keyof Getters, string>]: {
    readonly type: PublicType;
    readonly where: CoreInputAt<Getters, PublicType, "whereUnique">;
  };
}[Extract<keyof Getters, string>];

type ConnectOutput<Getters> = {
  [PublicType in Extract<keyof Getters, string>]: {
    readonly type: PublicType;
    readonly where: CoreOutputAt<Getters, PublicType, "whereUnique">;
  };
}[Extract<keyof Getters, string>];

type CreateInput<Getters> = {
  [PublicType in Extract<keyof Getters, string>]: {
    readonly type: PublicType;
    readonly data: CoreInputAt<Getters, PublicType, "create">;
  };
}[Extract<keyof Getters, string>];

type CreateOutput<Getters> = {
  [PublicType in Extract<keyof Getters, string>]: {
    readonly type: PublicType;
    readonly data: CoreOutputAt<Getters, PublicType, "create">;
  };
}[Extract<keyof Getters, string>];

type ConnectOrCreateInput<Getters> = {
  [PublicType in Extract<keyof Getters, string>]: {
    readonly type: PublicType;
    readonly where: CoreInputAt<Getters, PublicType, "whereUnique">;
    readonly create: CoreInputAt<Getters, PublicType, "create">;
  };
}[Extract<keyof Getters, string>];

type ConnectOrCreateOutput<Getters> = {
  [PublicType in Extract<keyof Getters, string>]: {
    readonly type: PublicType;
    readonly where: CoreOutputAt<Getters, PublicType, "whereUnique">;
    readonly create: CoreOutputAt<Getters, PublicType, "create">;
  };
}[Extract<keyof Getters, string>];

/** The supply verbs a fresh parent can name. Declaration order is the message order. */
export type PolymorphicCreateEntries<Getters> = {
  connect: VibSchema<ConnectInput<Getters>, ConnectOutput<Getters>>;
  create: VibSchema<CreateInput<Getters>, CreateOutput<Getters>>;
  connectOrCreate: VibSchema<
    ConnectOrCreateInput<Getters>,
    ConnectOrCreateOutput<Getters>
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

export function polymorphicCreateFactory<
  State extends VariantRelationState,
  Getters extends PolymorphicTargetSchemaGetters<State>,
>(
  state: State,
  targetSchemas: ExactPolymorphicTargetSchemaGetters<State, Getters>
): PolymorphicCreateSchema<Getters> {
  const schemaGetters: PolymorphicTargetSchemaGetters<State> = targetSchemas;
  const publicTypes = polymorphicPublicTypes(state);
  return toOneMutationSchema(
    {
      connect: v.union(
        publicTypes.map((publicType) =>
          v.object(
            {
              type: v.literal(publicType),
              where: () => schemaGetters[publicType]().core.whereUnique,
            },
            { partial: false }
          )
        )
      ),
      create: v.union(
        publicTypes.map((publicType) =>
          v.object(
            {
              type: v.literal(publicType),
              data: () => schemaGetters[publicType]().core.create,
            },
            { partial: false }
          )
        )
      ),
      connectOrCreate: v.union(
        publicTypes.map((publicType) =>
          v.object(
            {
              type: v.literal(publicType),
              where: () => schemaGetters[publicType]().core.whereUnique,
              create: () => schemaGetters[publicType]().core.create,
            },
            { partial: false }
          )
        )
      ),
    },
    undefined,
    false,
    "exactlyOne"
  ) as unknown as PolymorphicCreateSchema<Getters>;
}
