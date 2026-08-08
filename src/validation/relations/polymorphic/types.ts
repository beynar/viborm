import type { PolymorphicRelationState } from "@schema/relation";
import type { InferInput, InferOutput, VibSchema } from "@validation/types";

interface PolymorphicTargetSchemas {
  readonly core: {
    readonly create: VibSchema;
    readonly where: VibSchema;
    readonly whereUnique: VibSchema;
    readonly select: VibSchema;
    readonly include: VibSchema;
    readonly omit: VibSchema;
  };
}

export type PolymorphicTargetSchemaGetters<
  State extends PolymorphicRelationState,
> = {
  readonly [PublicType in keyof State["targets"]]: () => PolymorphicTargetSchemas;
};

export type ExactPolymorphicTargetSchemaGetters<
  State extends PolymorphicRelationState,
  Getters extends PolymorphicTargetSchemaGetters<State>,
> = Getters & Record<Exclude<keyof Getters, keyof State["targets"]>, never>;

type SchemasAt<
  Getters,
  PublicType extends keyof Getters,
> = Getters[PublicType] extends () => infer Schemas ? Schemas : never;

type CoreSchemaAt<
  Getters,
  PublicType extends keyof Getters,
  CoreKey extends PropertyKey,
> = SchemasAt<Getters, PublicType> extends {
  readonly core: infer Core;
}
  ? CoreKey extends keyof Core
    ? Core[CoreKey]
    : never
  : never;

export type CoreInputAt<
  Getters,
  PublicType extends keyof Getters,
  CoreKey extends PropertyKey,
> = InferInput<CoreSchemaAt<Getters, PublicType, CoreKey>>;

export type CoreOutputAt<
  Getters,
  PublicType extends keyof Getters,
  CoreKey extends PropertyKey,
> = InferOutput<CoreSchemaAt<Getters, PublicType, CoreKey>>;

export type PolymorphicSchema<Input, Output = Input> = VibSchema<Input, Output>;

export const polymorphicPublicTypes = <State extends PolymorphicRelationState>(
  state: State
): Extract<keyof State["targets"], string>[] =>
  Object.keys(state.targets) as Extract<keyof State["targets"], string>[];
