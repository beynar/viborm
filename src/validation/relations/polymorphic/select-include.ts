import type {
  AnyPolymorphicRelation,
  PolymorphicRelation,
  PolymorphicRelationState,
} from "@schema/relation";
import { withOmitProjection } from "@validation/model/args/omit";
import { rejectSelectInclude } from "@validation/model/args/select-include-exclusivity";
import { projectableScalarNames } from "@validation/model/core/projection";
import v from "@validation/primitives/v";
import type { InferInput, InferOutput } from "@validation/types";
import type {
  ExactPolymorphicTargetSchemaGetters,
  PolymorphicSchema,
  PolymorphicTargetSchemaGetters,
} from "./types";
import { polymorphicPublicTypes } from "./types";

type ProjectionInput<Schemas> = Schemas extends () => infer TargetSchemas
  ? TargetSchemas extends {
      readonly core: {
        readonly select: infer Select;
        readonly include: infer Include;
        readonly omit: infer Omit;
      };
    }
    ?
        | true
        | {
            readonly select: InferInput<Select>;
            readonly include?: never;
            readonly omit?: never;
          }
        | {
            readonly select?: never;
            readonly include?: InferInput<Include>;
            readonly omit?: InferInput<Omit>;
          }
    : never
  : never;

type ProjectionOutput<Schemas> = Schemas extends () => infer TargetSchemas
  ? TargetSchemas extends {
      readonly core: {
        readonly select: infer Select;
        readonly include: infer Include;
      };
    }
    ?
        | true
        | {
            readonly select?: InferOutput<Select>;
            readonly include?: InferOutput<Include>;
          }
    : never
  : never;

export type PolymorphicProjectionInput<Getters> = {
  readonly [PublicType in keyof Getters]?: ProjectionInput<Getters[PublicType]>;
};

export type PolymorphicProjectionOutput<Getters> = {
  readonly [PublicType in keyof Getters]?: ProjectionOutput<
    Getters[PublicType]
  >;
};

export type PolymorphicSelectSchema<Getters> = PolymorphicSchema<
  boolean | PolymorphicProjectionInput<Getters>,
  boolean | PolymorphicProjectionOutput<Getters>
>;

export type PolymorphicIncludeSchema<Getters> =
  PolymorphicSelectSchema<Getters>;

export function polymorphicSelectFactory<
  State extends PolymorphicRelationState,
  Getters extends PolymorphicTargetSchemaGetters<State>,
>(
  relation: PolymorphicRelation<State>,
  targetSchemas: ExactPolymorphicTargetSchemaGetters<State, Getters>
): PolymorphicSelectSchema<Getters>;
export function polymorphicSelectFactory(
  relation: AnyPolymorphicRelation,
  targetSchemas: PolymorphicTargetSchemaGetters<PolymorphicRelationState>
): PolymorphicSelectSchema<
  PolymorphicTargetSchemaGetters<PolymorphicRelationState>
>;
export function polymorphicSelectFactory(
  relation: AnyPolymorphicRelation,
  targetSchemas: PolymorphicTargetSchemaGetters<PolymorphicRelationState>
): PolymorphicSelectSchema<
  PolymorphicTargetSchemaGetters<PolymorphicRelationState>
> {
  const state = relation["~"].state;
  const schemaGetters = targetSchemas;
  const targetModels = new Map<string, Parameters<typeof withOmitProjection>[1]>();
  for (const { publicType, targetModel } of relation["~"].targetEntries()) {
    targetModels.set(
      publicType,
      targetModel as Parameters<typeof withOmitProjection>[1]
    );
  }
  const entries: Record<string, () => ReturnType<typeof v.union>> = {};
  for (const publicType of polymorphicPublicTypes(state)) {
    const schemas = schemaGetters[publicType]!;
    const target = targetModels.get(publicType)!;
    entries[publicType] = () =>
      v.union([
        v.literal(true),
        v.lazy(() => {
          const targetSchemasAtParse = schemas();
          const targetModel = target;
          const node = withOmitProjection(
            rejectSelectInclude(
              v.object({
                select: () => targetSchemasAtParse.core.select,
                include: () => targetSchemasAtParse.core.include,
                omit: () => targetSchemasAtParse.core.omit,
              })
            ),
            targetModel,
            `polymorphic.${publicType}`
          );
          return v.coerce(node, (value) => {
            if (value.select !== undefined) return value;
            const select: Record<string, true> = {};
            for (const field of projectableScalarNames(targetModel)) {
              select[field] = true;
            }
            return Object.keys(select).length === 0
              ? value
              : { ...value, select };
          });
        }),
      ]);
  }
  return v.union([
    v.boolean(),
    v.object(entries),
  ]) as PolymorphicSelectSchema<
    PolymorphicTargetSchemaGetters<PolymorphicRelationState>
  >;
}

export const polymorphicIncludeFactory = polymorphicSelectFactory;
