import type { AnyModel } from "@schema/model";
import type {
  AnyPolymorphicRelation,
  PolymorphicRelationState,
} from "@schema/relation";
import { lazyRecord } from "@validation/lazy";
import type { ModelSchemas } from "@validation/model";

export {
  type PolymorphicCreateInput,
  type PolymorphicCreateOutput,
  type PolymorphicCreateSchema,
  polymorphicCreateFactory,
} from "./create";
export {
  type PolymorphicFilterSchema,
  polymorphicFilterFactory,
} from "./filter";
export {
  type PolymorphicIncludeSchema,
  type PolymorphicProjectionInput,
  type PolymorphicProjectionOutput,
  type PolymorphicSelectSchema,
  polymorphicIncludeFactory,
  polymorphicSelectFactory,
} from "./select-include";
export type {
  ExactPolymorphicTargetSchemaGetters,
  PolymorphicTargetSchemaGetters,
} from "./types";
export {
  type PolymorphicUpdateSchema,
  polymorphicUpdateFactory,
} from "./update";

import {
  type PolymorphicCreateSchema,
  polymorphicCreateFactory,
} from "./create";
import {
  type PolymorphicFilterSchema,
  polymorphicFilterFactory,
} from "./filter";
import {
  type PolymorphicIncludeSchema,
  type PolymorphicSelectSchema,
  polymorphicIncludeFactory,
  polymorphicSelectFactory,
} from "./select-include";
import type { PolymorphicTargetSchemaGetters } from "./types";
import {
  type PolymorphicUpdateSchema,
  polymorphicUpdateFactory,
} from "./update";

type TargetModel<
  State extends PolymorphicRelationState,
  PublicType extends keyof State["targets"],
> = State["targets"][PublicType] extends () => infer Target
  ? Target extends AnyModel
    ? Target
    : never
  : never;

export type RegisteredPolymorphicTargetSchemas<
  State extends PolymorphicRelationState,
> = {
  readonly [PublicType in keyof State["targets"]]: () => ModelSchemas<
    TargetModel<State, PublicType>
  >;
};

export interface PolymorphicRelationSchemas<
  State extends PolymorphicRelationState,
  Getters extends PolymorphicTargetSchemaGetters<State>,
> {
  readonly filter: PolymorphicFilterSchema<State, Getters>;
  readonly create: PolymorphicCreateSchema<Getters>;
  readonly update: PolymorphicUpdateSchema<State, Getters>;
  readonly select: PolymorphicSelectSchema<Getters>;
  readonly include: PolymorphicIncludeSchema<Getters>;
}

export type GetPolymorphicRelationsSchemas<Source extends AnyModel> = {
  readonly [RelationKey in keyof Source["~"]["state"]["polymorphicRelations"]]: Source["~"]["state"]["polymorphicRelations"][RelationKey]["~"]["state"] extends infer State extends PolymorphicRelationState
    ? PolymorphicRelationSchemas<
        State,
        RegisteredPolymorphicTargetSchemas<State>
      >
    : never;
};

function getTargetSchemas<
  State extends PolymorphicRelationState,
>(
  relation: AnyPolymorphicRelation,
  resolve: (model: AnyModel) => ModelSchemas<AnyModel>
): RegisteredPolymorphicTargetSchemas<State> {
  const getters: Record<string, () => ModelSchemas<AnyModel>> = {};
  for (const entry of relation["~"].targetEntries()) {
    getters[entry.publicType] = () => resolve(entry.targetModel as AnyModel);
  }
  return getters as unknown as RegisteredPolymorphicTargetSchemas<State>;
}

export function getPolymorphicRelationsSchemas<Source extends AnyModel>(
  source: Source,
  resolve: (model: AnyModel) => ModelSchemas<AnyModel>
): GetPolymorphicRelationsSchemas<Source> {
  const builders: Record<string, () => unknown> = {};
  for (const relationKey of Object.keys(
    source["~"].state.polymorphicRelations
  )) {
    const relation = source["~"].state.polymorphicRelations[relationKey]!;
    builders[relationKey] = () => {
      const state = relation["~"].state;
      const targets = getTargetSchemas<typeof state>(relation, resolve);
      return lazyRecord({
        filter: () => polymorphicFilterFactory(state, targets),
        create: () => polymorphicCreateFactory(state, targets),
        update: () => polymorphicUpdateFactory(state, targets),
        select: () => polymorphicSelectFactory(relation, targets),
        include: () => polymorphicIncludeFactory(relation, targets),
      });
    };
  }
  return lazyRecord(builders) as GetPolymorphicRelationsSchemas<Source>;
}
