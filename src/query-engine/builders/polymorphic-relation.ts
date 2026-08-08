import {
  getPolymorphicInverseBinding,
  manyToOne,
} from "@schema/relation";
import {
  QueryEngineError,
  type PolymorphicRelationInfo,
  type QueryScope,
  type RelationInfo,
  type ResolvedPolymorphicEdge,
  type ResolvedPolymorphicInverse,
} from "../types";

/** Resolve one validated public discriminator without conflating direct and inverse topology. */
export function resolvePolymorphicEdge(
  scope: QueryScope,
  relation: PolymorphicRelationInfo,
  publicType: string
): ResolvedPolymorphicEdge {
  const member = relation.storage.members.get(publicType);
  if (!member) {
    throw new QueryEngineError(
      `Unknown polymorphic target '${publicType}' for relation '${relation.name}'.`
    );
  }

  const base = manyToOne(() => member.targetModel)
    .fields(relation.storage.idColumn.name)
    .references(member.referencedField);
  const directRelation =
    relation.relation["~"].state.optional === true ? base.optional() : base;
  directRelation["~"].setSource(scope.model);

  return {
    publicType,
    storedType: member.storedType,
    targetModel: member.targetModel,
    referencedField: member.referencedField,
    storage: relation.storage,
    relationInfo: {
      name: relation.name,
      relation: directRelation,
      targetModel: member.targetModel,
      type: "manyToOne",
      isToMany: false,
      isToOne: true,
      isOptional: relation.relation["~"].state.optional === true,
      fields: [relation.storage.idColumn.name],
      references: [member.referencedField],
    },
  };
}

/** Resolve an ordinary one-to-many inverse against the child's private storage. */
export function resolvePolymorphicInverse(
  scope: QueryScope,
  relationInfo: RelationInfo
): ResolvedPolymorphicInverse | undefined {
  if (relationInfo.type !== "oneToMany") return undefined;
  const binding = getPolymorphicInverseBinding(
    relationInfo.targetModel,
    scope.model,
    relationInfo.relation["~"].state.name
  );
  if (!binding) return undefined;

  const storage = relationInfo.targetModel["~"].getPolymorphicStorage(
    binding.relationKey
  );
  const member = storage?.members.get(binding.publicType);
  if (!storage || !member) {
    throw new QueryEngineError(
      `Polymorphic inverse '${relationInfo.name}' has no resolved storage binding.`
    );
  }

  return {
    relationInfo,
    childRelationKey: binding.relationKey,
    publicType: binding.publicType,
    storedType: binding.storedType,
    sourceReferencedField: member.referencedField,
    storage,
  };
}
