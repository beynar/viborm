import type { PolymorphicRelationState } from "@schema/relation";
import v from "@validation/primitives/v";
import type {
  CoreInputAt,
  CoreOutputAt,
  ExactPolymorphicTargetSchemaGetters,
  PolymorphicSchema,
  PolymorphicTargetSchemaGetters,
} from "./types";
import { polymorphicPublicTypes } from "./types";

type MutationKey =
  | "connect"
  | "create"
  | "connectOrCreate"
  | "update"
  | "upsert"
  | "delete"
  | "disconnect";

type ExclusiveMutation<Key extends MutationKey, Payload> = {
  readonly [Current in Key]: Payload;
} & {
  readonly [Other in Exclude<MutationKey, Key>]?: never;
};

type UpdateInputFor<
  Getters,
  PublicType extends Extract<keyof Getters, string>,
> =
  | ExclusiveMutation<
      "connect",
      {
        readonly type: PublicType;
        readonly where: CoreInputAt<Getters, PublicType, "whereUnique">;
      }
    >
  | ExclusiveMutation<
      "create",
      {
        readonly type: PublicType;
        readonly data: CoreInputAt<Getters, PublicType, "create">;
      }
    >
  | ExclusiveMutation<
      "connectOrCreate",
      {
        readonly type: PublicType;
        readonly where: CoreInputAt<Getters, PublicType, "whereUnique">;
        readonly create: CoreInputAt<Getters, PublicType, "create">;
      }
    >
  | ExclusiveMutation<
      "update",
      {
        readonly type: PublicType;
        readonly where?: CoreInputAt<Getters, PublicType, "where">;
        readonly data: CoreInputAt<Getters, PublicType, "update">;
      }
    >
  | ExclusiveMutation<
      "upsert",
      {
        readonly type: PublicType;
        readonly create: CoreInputAt<Getters, PublicType, "create">;
        readonly update: CoreInputAt<Getters, PublicType, "update">;
      }
    >;

type UpdateOutputFor<
  Getters,
  PublicType extends Extract<keyof Getters, string>,
> =
  | ExclusiveMutation<
      "connect",
      {
        readonly type: PublicType;
        readonly where: CoreOutputAt<Getters, PublicType, "whereUnique">;
      }
    >
  | ExclusiveMutation<
      "create",
      {
        readonly type: PublicType;
        readonly data: CoreOutputAt<Getters, PublicType, "create">;
      }
    >
  | ExclusiveMutation<
      "connectOrCreate",
      {
        readonly type: PublicType;
        readonly where: CoreOutputAt<Getters, PublicType, "whereUnique">;
        readonly create: CoreOutputAt<Getters, PublicType, "create">;
      }
    >
  | ExclusiveMutation<
      "update",
      {
        readonly type: PublicType;
        readonly where?: CoreOutputAt<Getters, PublicType, "where">;
        readonly data: CoreOutputAt<Getters, PublicType, "update">;
      }
    >
  | ExclusiveMutation<
      "upsert",
      {
        readonly type: PublicType;
        readonly create: CoreOutputAt<Getters, PublicType, "create">;
        readonly update: CoreOutputAt<Getters, PublicType, "update">;
      }
    >;

type TargetedInput<Getters> =
  | {
      [PublicType in Extract<keyof Getters, string>]: ExclusiveMutation<
        "delete",
        { readonly type: PublicType }
      >;
    }[Extract<keyof Getters, string>]
  | {
      [PublicType in Extract<keyof Getters, string>]: UpdateInputFor<
        Getters,
        PublicType
      >;
    }[Extract<keyof Getters, string>];

type TargetedOutput<Getters> =
  | {
      [PublicType in Extract<keyof Getters, string>]: ExclusiveMutation<
        "delete",
        { readonly type: PublicType }
      >;
    }[Extract<keyof Getters, string>]
  | {
      [PublicType in Extract<keyof Getters, string>]: UpdateOutputFor<
        Getters,
        PublicType
      >;
    }[Extract<keyof Getters, string>];

type Disconnect<State extends PolymorphicRelationState> =
  State["optional"] extends true
    ? ExclusiveMutation<"disconnect", true>
    : never;

type OptionalTargeted<
  State extends PolymorphicRelationState,
  Getters,
> = State["optional"] extends true
  ? TargetedInput<Getters>
  : Exclude<TargetedInput<Getters>, { readonly delete: unknown }>;

type OptionalTargetedOutput<
  State extends PolymorphicRelationState,
  Getters,
> = State["optional"] extends true
  ? TargetedOutput<Getters>
  : Exclude<TargetedOutput<Getters>, { readonly delete: unknown }>;

export type PolymorphicUpdateSchema<
  State extends PolymorphicRelationState,
  Getters,
> = PolymorphicSchema<
  OptionalTargeted<State, Getters> | Disconnect<State>,
  OptionalTargetedOutput<State, Getters> | Disconnect<State>
>;

export function polymorphicUpdateFactory<
  State extends PolymorphicRelationState,
  Getters extends PolymorphicTargetSchemaGetters<State>,
>(
  state: State,
  targetSchemas: ExactPolymorphicTargetSchemaGetters<State, Getters>
): PolymorphicUpdateSchema<State, Getters> {
  const schemaGetters: PolymorphicTargetSchemaGetters<State> = targetSchemas;
  const members = polymorphicPublicTypes(state).flatMap((publicType) => {
    const schemas = schemaGetters[publicType];
    const typed = { type: v.literal(publicType) };
    return [
      v.object(
        {
          connect: v.object(
            { ...typed, where: () => schemas().core.whereUnique },
            { partial: false }
          ),
        },
        { partial: false }
      ),
      v.object(
        {
          create: v.object(
            { ...typed, data: () => schemas().core.create },
            { partial: false }
          ),
        },
        { partial: false }
      ),
      v.object(
        {
          connectOrCreate: v.object(
            {
              ...typed,
              where: () => schemas().core.whereUnique,
              create: () => schemas().core.create,
            },
            { partial: false }
          ),
        },
        { partial: false }
      ),
      v.object(
        {
          update: v.object(
            {
              ...typed,
              where: () => schemas().core.where,
              data: () => schemas().core.update,
            },
            { atLeast: ["data"] }
          ),
        },
        { partial: false }
      ),
      v.object(
        {
          upsert: v.object(
            {
              ...typed,
              create: () => schemas().core.create,
              update: () => schemas().core.update,
            },
            { partial: false }
          ),
        },
        { partial: false }
      ),
      ...(state.optional === true
        ? [
            v.object(
              { delete: v.object(typed, { partial: false }) },
              { partial: false }
            ),
          ]
        : []),
    ];
  });
  if (state.optional === true) {
    members.push(
      v.object({ disconnect: v.literal(true) }, { partial: false }) as never
    );
  }
  return v.union(members) as unknown as PolymorphicUpdateSchema<State, Getters>;
}
