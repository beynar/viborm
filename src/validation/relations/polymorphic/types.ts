import type { VariantRelationState } from "@schema/relation";
import type { VariantEntries } from "@schema/relation/static-membership";
import type { InferInput, InferOutput, VibSchema } from "@validation/types";

/**
 * The slice of a target model's `ModelSchemas` a polymorphic family reaches
 * for. The runtime value is always the full `ModelSchemas`; this interface is
 * the DECLARED reach, and it is the thing hand-built doubles in the type tests
 * must satisfy.
 *
 * `orderBy` is here because a COLLECTION arm node is the ordinary to-many nested
 * node (`buildToManyNestedNode`), which offers `orderBy` on the related model.
 * The to-one families never asked for it, which is why it was absent.
 *
 * `whereUniqueExtended` is here because the COLLECTION WRITE family addresses a
 * member exactly where the ordinary to-many operation does (`toManyUpdateFactory`:
 * `update`, `upsert` and `delete` all take it). That is a deliberate divergence
 * from the to-one polymorphic `update`, whose `where` merely FILTERS the one
 * connected record and is therefore the plain `where` — a slot already names its
 * target, a collection member does not.
 */
interface PolymorphicTargetSchemas {
  readonly core: {
    readonly create: VibSchema;
    readonly update: VibSchema;
    readonly where: VibSchema;
    readonly whereUnique: VibSchema;
    readonly whereUniqueExtended: VibSchema;
    readonly orderBy: VibSchema;
    readonly select: VibSchema;
    readonly include: VibSchema;
    readonly omit: VibSchema;
  };
}

export type PolymorphicTargetSchemaGetters<State extends VariantRelationState> =
  {
    readonly [PublicType in keyof VariantEntries<State>]: () => PolymorphicTargetSchemas;
  };

export type ExactPolymorphicTargetSchemaGetters<
  State extends VariantRelationState,
  Getters extends PolymorphicTargetSchemaGetters<State>,
> = Getters &
  Record<Exclude<keyof Getters, keyof VariantEntries<State>>, never>;

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

export const polymorphicPublicTypes = <State extends VariantRelationState>(
  state: State
): Extract<keyof VariantEntries<State>, string>[] =>
  Object.keys(state.target.entries) as Extract<
    keyof VariantEntries<State>,
    string
  >[];
