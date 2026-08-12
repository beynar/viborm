import type { PolymorphicRelationState } from "@schema/relation";
import v, { type V } from "@validation/primitives/v";
import type { VibSchema } from "@validation/types";
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

type UpdateInput<Getters> = {
  [PublicType in Extract<keyof Getters, string>]: {
    readonly type: PublicType;
    readonly where?: CoreInputAt<Getters, PublicType, "where">;
    readonly data: CoreInputAt<Getters, PublicType, "update">;
  };
}[Extract<keyof Getters, string>];

type UpdateOutput<Getters> = {
  [PublicType in Extract<keyof Getters, string>]: {
    readonly type: PublicType;
    readonly where?: CoreOutputAt<Getters, PublicType, "where">;
    readonly data: CoreOutputAt<Getters, PublicType, "update">;
  };
}[Extract<keyof Getters, string>];

type UpsertInput<Getters> = {
  [PublicType in Extract<keyof Getters, string>]: {
    readonly type: PublicType;
    readonly create: CoreInputAt<Getters, PublicType, "create">;
    readonly update: CoreInputAt<Getters, PublicType, "update">;
  };
}[Extract<keyof Getters, string>];

type UpsertOutput<Getters> = {
  [PublicType in Extract<keyof Getters, string>]: {
    readonly type: PublicType;
    readonly create: CoreOutputAt<Getters, PublicType, "create">;
    readonly update: CoreOutputAt<Getters, PublicType, "update">;
  };
}[Extract<keyof Getters, string>];

type DeleteTarget<Getters> = {
  [PublicType in Extract<keyof Getters, string>]: {
    readonly type: PublicType;
  };
}[Extract<keyof Getters, string>];

type PolymorphicTargetedEntries<Getters> = {
  connect: VibSchema<ConnectInput<Getters>, ConnectOutput<Getters>>;
  create: VibSchema<CreateInput<Getters>, CreateOutput<Getters>>;
  connectOrCreate: VibSchema<
    ConnectOrCreateInput<Getters>,
    ConnectOrCreateOutput<Getters>
  >;
  update: VibSchema<UpdateInput<Getters>, UpdateOutput<Getters>>;
  upsert: VibSchema<UpsertInput<Getters>, UpsertOutput<Getters>>;
};

/**
 * Removal is a SLOT fact: only an optional membership may be emptied, so only there
 * do `delete` and `disconnect` exist as keys at all. `disconnect` stays a `true`
 * literal rather than a boolean — `false` is not an inactive spelling of a payload
 * that must carry exactly one intent, it is a value this verb never had.
 */
type PolymorphicRemovalEntries<Getters> = {
  delete: VibSchema<DeleteTarget<Getters>, DeleteTarget<Getters>>;
  disconnect: V.Literal<true>;
};

export type PolymorphicUpdateEntries<
  State extends PolymorphicRelationState,
  Getters,
> = PolymorphicTargetedEntries<Getters> &
  (State["optional"] extends true
    ? PolymorphicRemovalEntries<Getters>
    : Record<never, never>);

export type PolymorphicUpdateSchema<
  State extends PolymorphicRelationState,
  Getters,
> = ToOneMutationSchema<
  PolymorphicUpdateEntries<State, Getters>,
  undefined,
  false,
  "exactlyOne"
>;

export function polymorphicUpdateFactory<
  State extends PolymorphicRelationState,
  Getters extends PolymorphicTargetSchemaGetters<State>,
>(
  state: State,
  targetSchemas: ExactPolymorphicTargetSchemaGetters<State, Getters>
): PolymorphicUpdateSchema<State, Getters> {
  const schemaGetters: PolymorphicTargetSchemaGetters<State> = targetSchemas;
  const publicTypes = polymorphicPublicTypes(state);
  const typed = (publicType: (typeof publicTypes)[number]) => ({
    type: v.literal(publicType),
  });
  const targetedEntries = {
    connect: v.union(
      publicTypes.map((publicType) =>
        v.object(
          {
            ...typed(publicType),
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
            ...typed(publicType),
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
            ...typed(publicType),
            where: () => schemaGetters[publicType]().core.whereUnique,
            create: () => schemaGetters[publicType]().core.create,
          },
          { partial: false }
        )
      )
    ),
    update: v.union(
      publicTypes.map((publicType) =>
        v.object(
          {
            ...typed(publicType),
            where: () => schemaGetters[publicType]().core.where,
            data: () => schemaGetters[publicType]().core.update,
          },
          // `where` FILTERS the one connected record; the discriminator and the data
          // are what the engine needs to address it at all.
          { atLeast: ["type", "data"] }
        )
      )
    ),
    upsert: v.union(
      publicTypes.map((publicType) =>
        v.object(
          {
            ...typed(publicType),
            create: () => schemaGetters[publicType]().core.create,
            update: () => schemaGetters[publicType]().core.update,
          },
          { partial: false }
        )
      )
    ),
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
      delete: v.union(
        publicTypes.map((publicType) =>
          v.object(typed(publicType), { partial: false })
        )
      ),
      disconnect: v.literal(true),
    },
    undefined,
    false,
    "exactlyOne"
  ) as unknown as PolymorphicUpdateSchema<State, Getters>;
}
