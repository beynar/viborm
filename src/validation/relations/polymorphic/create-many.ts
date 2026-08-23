import type { VariantRelationState } from "@schema/relation";
import v from "@validation/primitives/v";
import type {
  CoreInputAt,
  CoreOutputAt,
  ExactPolymorphicTargetSchemaGetters,
  PolymorphicSchema,
  PolymorphicTargetSchemaGetters,
} from "./types";
import { polymorphicPublicTypes } from "./types";

type ConnectInput<Getters> = {
  [PublicType in Extract<keyof Getters, string>]: {
    readonly connect: {
      readonly type: PublicType;
      readonly where: CoreInputAt<Getters, PublicType, "whereUnique">;
    };
  };
}[Extract<keyof Getters, string>];

type ConnectOutput<Getters> = {
  [PublicType in Extract<keyof Getters, string>]: {
    readonly connect: {
      readonly type: PublicType;
      readonly where: CoreOutputAt<Getters, PublicType, "whereUnique">;
    };
  };
}[Extract<keyof Getters, string>];

export type PolymorphicCreateManySchema<Getters> = PolymorphicSchema<
  ConnectInput<Getters>,
  ConnectOutput<Getters>
>;

export function polymorphicCreateManyFactory<
  State extends VariantRelationState,
  Getters extends PolymorphicTargetSchemaGetters<State>,
>(
  state: State,
  targetSchemas: ExactPolymorphicTargetSchemaGetters<State, Getters>
): PolymorphicCreateManySchema<Getters> {
  const schemas: PolymorphicTargetSchemaGetters<State> = targetSchemas;
  return v.union(
    polymorphicPublicTypes(state).map((publicType) =>
      v.object(
        {
          connect: v.object(
            {
              type: v.literal(publicType),
              where: () => schemas[publicType]().core.whereUnique,
            },
            { partial: false }
          ),
        },
        { partial: false }
      )
    )
  ) as unknown as PolymorphicCreateManySchema<Getters>;
}
