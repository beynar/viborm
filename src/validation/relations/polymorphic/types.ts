import type { VariantRelationState } from "@schema/relation";
import type { VariantEntries } from "@schema/relation/static-membership";
import v from "@validation/primitives/v";
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

/** Which side of a schema a tagged item spells: what a caller writes, or what a parse emits. */
export type Side = "input" | "output";

/**
 * A verb's fields, each named by the target `core` schema it takes. The ONE
 * description {@link Tagged} reads at the type level and `taggedVerbs` reads at
 * runtime, so the two cannot name different schemas.
 */
export type TaggedFields = Readonly<
  Record<string, keyof PolymorphicTargetSchemas["core"]>
>;

/**
 * One verb's item: a union over the configured public types, each member
 * carrying its discriminator and that variant's own schemas. `Required` names
 * the fields a payload must spell; the others are optional.
 */
export type Tagged<
  Getters,
  Fields extends TaggedFields,
  Direction extends Side,
  Required extends keyof Fields = keyof Fields,
> = {
  [PublicType in Extract<keyof Getters, string>]: {
    readonly type: PublicType;
  } & {
    readonly [Field in Required]: CoreAt<
      Getters,
      PublicType,
      Fields[Field],
      Direction
    >;
  } & {
    readonly [Field in Exclude<keyof Fields, Required>]?: CoreAt<
      Getters,
      PublicType,
      Fields[Field],
      Direction
    >;
  };
}[Extract<keyof Getters, string>];

type CoreAt<
  Getters,
  PublicType extends keyof Getters,
  CoreKey extends PropertyKey,
  Direction extends Side,
> = Direction extends "input"
  ? CoreInputAt<Getters, PublicType, CoreKey>
  : CoreOutputAt<Getters, PublicType, CoreKey>;

export type TaggedSchema<
  Getters,
  Fields extends TaggedFields,
  Required extends keyof Fields = keyof Fields,
> = VibSchema<
  Tagged<Getters, Fields, "input", Required>,
  Tagged<Getters, Fields, "output", Required>
>;

export type PolymorphicSchema<Input, Output = Input> = VibSchema<Input, Output>;

export type TaggedOptions = ({ partial: false } | { atLeast: string[] }) & {
  refuse?: (value: Record<string, unknown>) => string | undefined;
};

/**
 * The tagged-union builders of one relation: one `v.object` per configured
 * public type, discriminated by a `type` literal. `core` builds a verb from its
 * {@link TaggedFields}; `custom` is for the one verb whose fields are not bare
 * `core` schemas.
 */
export const taggedVerbs = <
  State extends VariantRelationState,
  Getters extends PolymorphicTargetSchemaGetters<State>,
>(
  state: State,
  schemaGetters: PolymorphicTargetSchemaGetters<State>
) => {
  const publicTypes = polymorphicPublicTypes(state);
  const custom = (
    fields: (
      publicType: (typeof publicTypes)[number]
    ) => Record<string, unknown>,
    options: TaggedOptions = { partial: false }
  ): VibSchema =>
    v.union(
      publicTypes.map((publicType) =>
        v.object(
          { type: v.literal(publicType), ...fields(publicType) },
          options
        )
      )
    ) as unknown as VibSchema;
  const core = <
    const Fields extends TaggedFields,
    Required extends keyof Fields & string = keyof Fields & string,
  >(
    fields: Fields,
    atLeast?: Required[]
  ) =>
    custom(
      (publicType) =>
        Object.fromEntries(
          Object.entries(fields).map(([field, coreKey]) => [
            field,
            () => schemaGetters[publicType]().core[coreKey],
          ])
        ),
      atLeast ? { atLeast: ["type", ...atLeast] } : { partial: false }
    ) as unknown as TaggedSchema<Getters, Fields, Required>;
  return { core, custom };
};

export const polymorphicPublicTypes = <State extends VariantRelationState>(
  state: State
): Extract<keyof VariantEntries<State>, string>[] =>
  Object.keys(state.target.entries) as Extract<
    keyof VariantEntries<State>,
    string
  >[];
