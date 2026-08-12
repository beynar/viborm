import { manyToOne } from "@schema/relation";
import {
  type PolymorphicRelationInfo,
  QueryEngineError,
  type QueryScope,
  type ResolvedPolymorphicEdge,
} from "../types";
import {
  type BoundPolymorphicMembership,
  buildPolymorphicMembership,
} from "./relation-data-builder";

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
      cardinality: "one",
      isOptional: relation.relation["~"].state.optional === true,
      fields: [relation.storage.idColumn.name],
      references: [member.referencedField],
    },
  };
}

/**
 * The physical membership a resolved DIRECT edge writes — the same bound
 * membership an inverse edge on that private pair binds, so the two intents
 * produce one topology and one OwnWrite scope.
 *
 * The holder is the storage's owner because that IS the scope the payload was
 * parsed against: a scope exposes only its own model's polymorphic storage
 * (`getPolymorphicRelations`), so `storage.ownerModel` and the resolving
 * `scope.model` are the same instance — and membership-scope equality compares
 * model identity.
 */
export function directPolymorphicMembership(
  edge: ResolvedPolymorphicEdge
): BoundPolymorphicMembership {
  return buildPolymorphicMembership(
    edge.storage.ownerModel,
    edge.targetModel,
    edge.storage,
    edge
  );
}
