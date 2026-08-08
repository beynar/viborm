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

type CreateInputFor<
  Getters,
  PublicType extends Extract<keyof Getters, string>,
> =
  | {
      readonly connect: {
        readonly type: PublicType;
        readonly where: CoreInputAt<Getters, PublicType, "whereUnique">;
      };
      readonly create?: never;
    }
  | {
      readonly connect?: never;
      readonly create: {
        readonly type: PublicType;
        readonly data: CoreInputAt<Getters, PublicType, "create">;
      };
    };

type CreateOutputFor<
  Getters,
  PublicType extends Extract<keyof Getters, string>,
> =
  | {
      readonly connect: {
        readonly type: PublicType;
        readonly where: CoreOutputAt<Getters, PublicType, "whereUnique">;
      };
      readonly create?: never;
    }
  | {
      readonly connect?: never;
      readonly create: {
        readonly type: PublicType;
        readonly data: CoreOutputAt<Getters, PublicType, "create">;
      };
    };

export type PolymorphicCreateInput<Getters> = {
  [PublicType in Extract<keyof Getters, string>]: CreateInputFor<
    Getters,
    PublicType
  >;
}[Extract<keyof Getters, string>];

export type PolymorphicCreateOutput<Getters> = {
  [PublicType in Extract<keyof Getters, string>]: CreateOutputFor<
    Getters,
    PublicType
  >;
}[Extract<keyof Getters, string>];

export type PolymorphicCreateSchema<Getters> = PolymorphicSchema<
  PolymorphicCreateInput<Getters>,
  PolymorphicCreateOutput<Getters>
>;

export function polymorphicCreateFactory<
  State extends PolymorphicRelationState,
  Getters extends PolymorphicTargetSchemaGetters<State>,
>(
  state: State,
  targetSchemas: ExactPolymorphicTargetSchemaGetters<State, Getters>
): PolymorphicCreateSchema<Getters> {
  const schemaGetters: PolymorphicTargetSchemaGetters<State> = targetSchemas;
  const members = polymorphicPublicTypes(state).flatMap((publicType) => {
    const schemas = schemaGetters[publicType];
    return [
      v.object(
        {
          connect: v.object(
            {
              type: v.literal(publicType),
              where: () => schemas().core.whereUnique,
            },
            { partial: false }
          ),
        },
        { partial: false }
      ),
      v.object(
        {
          create: v.object(
            {
              type: v.literal(publicType),
              data: () => schemas().core.create,
            },
            { partial: false }
          ),
        },
        { partial: false }
      ),
    ];
  });
  return v.union(members) as unknown as PolymorphicCreateSchema<Getters>;
}
