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

type FilterInputFor<Getters, PublicType extends keyof Getters> =
  | { readonly type: PublicType; readonly is?: never; readonly isNot?: never }
  | {
      readonly type: PublicType;
      readonly is: CoreInputAt<Getters, PublicType, "where">;
      readonly isNot?: never;
    }
  | {
      readonly type: PublicType;
      readonly is?: never;
      readonly isNot: CoreInputAt<Getters, PublicType, "where">;
    };

type FilterOutputFor<Getters, PublicType extends keyof Getters> =
  | { readonly type: PublicType; readonly is?: never; readonly isNot?: never }
  | {
      readonly type: PublicType;
      readonly is: CoreOutputAt<Getters, PublicType, "where">;
      readonly isNot?: never;
    }
  | {
      readonly type: PublicType;
      readonly is?: never;
      readonly isNot: CoreOutputAt<Getters, PublicType, "where">;
    };

type FilterInput<Getters> = {
  [PublicType in keyof Getters]: FilterInputFor<Getters, PublicType>;
}[keyof Getters];

type FilterOutput<Getters> = {
  [PublicType in keyof Getters]: FilterOutputFor<Getters, PublicType>;
}[keyof Getters];

export type PolymorphicFilterSchema<
  State extends PolymorphicRelationState,
  Getters,
> = PolymorphicSchema<
  FilterInput<Getters> | (State["optional"] extends true ? null : never),
  FilterOutput<Getters> | (State["optional"] extends true ? null : never)
>;

export function polymorphicFilterFactory<
  State extends PolymorphicRelationState,
  Getters extends PolymorphicTargetSchemaGetters<State>,
>(
  state: State,
  targetSchemas: ExactPolymorphicTargetSchemaGetters<State, Getters>
): PolymorphicFilterSchema<State, Getters> {
  const schemaGetters: PolymorphicTargetSchemaGetters<State> = targetSchemas;
  const members = polymorphicPublicTypes(state).flatMap((publicType) => {
    const schemas = schemaGetters[publicType];
    return [
      v.object({ type: v.literal(publicType) }, { partial: false }),
      v.object(
        {
          type: v.literal(publicType),
          is: () => schemas().core.where,
        },
        { partial: false }
      ),
      v.object(
        {
          type: v.literal(publicType),
          isNot: () => schemas().core.where,
        },
        { partial: false }
      ),
    ];
  });
  if (state.optional === true) members.push(v.literal(null) as never);
  return v.union(members) as PolymorphicFilterSchema<State, Getters>;
}
