import type { AnyModel } from "@schema/model";
import type { AnyPolymorphicRelation } from "@schema/relation/polymorphic";
import v from "../primitives/v";
import type { VibSchema } from "../types";

type RequiredPolymorphicRelationKeys<M extends AnyModel> = {
  [RelationKey in Extract<
    keyof M["~"]["state"]["polymorphicRelations"],
    string
  >]: M["~"]["state"]["polymorphicRelations"][RelationKey]["~"]["state"] extends {
    optional: true;
  }
    ? never
    : RelationKey;
}[Extract<keyof M["~"]["state"]["polymorphicRelations"], string>];

type IsAny<Value> = 0 extends 1 & Value ? true : false;

export type CreateManyAvailability<
  M extends AnyModel,
  AvailableSchema extends VibSchema,
  SatisfiedPolymorphicRelation extends string = never,
> = IsAny<M["~"]["state"]> extends true
  ? AvailableSchema
  : [
        Exclude<
          RequiredPolymorphicRelationKeys<M>,
          SatisfiedPolymorphicRelation
        >,
      ] extends [never]
    ? AvailableSchema
    : VibSchema<never, never>;

/** The scalar-only bulk boundary cannot construct a required polymorphic edge. */
export function getCreateManyRefusal(
  model: AnyModel,
  satisfiedPolymorphicRelation?: string
): { readonly relation: string; readonly message: string } | undefined {
  const relations: Readonly<Record<string, AnyPolymorphicRelation>> =
    model["~"].state.polymorphicRelations;
  for (const [relation, definition] of Object.entries(relations)) {
    if (relation === satisfiedPolymorphicRelation) continue;
    if (definition["~"].state.optional === true) continue;
    const modelName =
      model["~"].names.ts ?? model["~"].state.tableName ?? "model";
    return {
      relation,
      message: `createMany is not available for model '${modelName}' because required polymorphic relation '${relation}' cannot be supplied by a scalar-only bulk row. Use create instead.`,
    };
  }
  return undefined;
}

export function applyCreateManyAvailability<
  M extends AnyModel,
  AvailableSchema extends VibSchema,
  const SatisfiedPolymorphicRelation extends string = never,
>(
  model: M,
  availableSchema: AvailableSchema,
  satisfiedPolymorphicRelation?: SatisfiedPolymorphicRelation
): CreateManyAvailability<M, AvailableSchema, SatisfiedPolymorphicRelation>;
export function applyCreateManyAvailability(
  model: AnyModel,
  availableSchema: VibSchema,
  satisfiedPolymorphicRelation?: string
): VibSchema {
  const refusal = getCreateManyRefusal(model, satisfiedPolymorphicRelation);
  return refusal ? v.refused(refusal.message) : availableSchema;
}
