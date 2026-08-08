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

type ConnectInput<Getters> = {
  [PublicType in Extract<keyof Getters, string>]: {
    readonly connect: {
      readonly type: PublicType;
      readonly where: CoreInputAt<Getters, PublicType, "whereUnique">;
    };
    readonly disconnect?: never;
  };
}[Extract<keyof Getters, string>];

type ConnectOutput<Getters> = {
  [PublicType in Extract<keyof Getters, string>]: {
    readonly connect: {
      readonly type: PublicType;
      readonly where: CoreOutputAt<Getters, PublicType, "whereUnique">;
    };
    readonly disconnect?: never;
  };
}[Extract<keyof Getters, string>];

type Disconnect<State extends PolymorphicRelationState> =
  State["optional"] extends true
    ? { readonly connect?: never; readonly disconnect: true }
    : never;

export type PolymorphicUpdateSchema<
  State extends PolymorphicRelationState,
  Getters,
> = PolymorphicSchema<
  ConnectInput<Getters> | Disconnect<State>,
  ConnectOutput<Getters> | Disconnect<State>
>;

export function polymorphicUpdateFactory<
  State extends PolymorphicRelationState,
  Getters extends PolymorphicTargetSchemaGetters<State>,
>(
  state: State,
  targetSchemas: ExactPolymorphicTargetSchemaGetters<State, Getters>
): PolymorphicUpdateSchema<State, Getters> {
  const schemaGetters: PolymorphicTargetSchemaGetters<State> = targetSchemas;
  const members = polymorphicPublicTypes(state).map((publicType) => {
    const schemas = schemaGetters[publicType];
    return v.object(
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
    );
  });
  if (state.optional === true) {
    members.push(
      v.object({ disconnect: v.literal(true) }, { partial: false }) as never
    );
  }
  return v.union(members) as unknown as PolymorphicUpdateSchema<State, Getters>;
}
