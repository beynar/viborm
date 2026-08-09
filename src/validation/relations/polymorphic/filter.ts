import type { PolymorphicRelationState } from "@schema/relation";
import v from "@validation/primitives/v";
import { createSchema, fail, validateSchema } from "../../primitives/helpers";
import type { VibSchema } from "../../types";
import { isRecord } from "../../value-guards";
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

type PresenceFilter =
  | { readonly is: null; readonly isNot?: never }
  | { readonly is?: never; readonly isNot: null };

export type PolymorphicFilterSchema<
  State extends PolymorphicRelationState,
  Getters,
> = PolymorphicSchema<
  | FilterInput<Getters>
  | (State["optional"] extends true ? PresenceFilter | null : never),
  | FilterOutput<Getters>
  | (State["optional"] extends true ? PresenceFilter : never)
>;

export function polymorphicFilterFactory<
  State extends PolymorphicRelationState,
  Getters extends PolymorphicTargetSchemaGetters<State>,
>(
  state: State,
  targetSchemas: ExactPolymorphicTargetSchemaGetters<State, Getters>
): PolymorphicFilterSchema<State, Getters> {
  const schemaGetters: PolymorphicTargetSchemaGetters<State> = targetSchemas;
  const targetMembers = polymorphicPublicTypes(state).flatMap((publicType) => {
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
  const targetFilter = v.union(targetMembers);
  const isNull = v.object({ is: v.literal(null) }, { partial: false });
  const isNotNull = v.object({ isNot: v.literal(null) }, { partial: false });
  const presenceMembers: readonly [typeof isNull, typeof isNotNull] = [
    isNull,
    isNotNull,
  ];
  const presenceFilter = v.union(presenceMembers);
  const nullShorthand = v.literal(null, {
    transform: (): { readonly is: null } => ({ is: null }),
  });
  const optional = state.optional === true;
  const options: readonly VibSchema<unknown, unknown>[] = optional
    ? [nullShorthand, presenceFilter, targetFilter]
    : [targetFilter];
  const schema = createSchema<unknown, unknown>("union", (value) => {
    if (value === null) {
      return optional
        ? validateSchema(nullShorthand, value)
        : fail("Expected polymorphic filter with a type");
    }
    if (!isRecord(value)) return fail("Expected object");
    if (Object.hasOwn(value, "type")) {
      return validateSchema(targetFilter, value);
    }
    return optional
      ? validateSchema(presenceFilter, value)
      : fail("Expected polymorphic filter with a type");
  });
  (schema as { options?: unknown }).options = options;
  return schema as PolymorphicFilterSchema<State, Getters>;
}
