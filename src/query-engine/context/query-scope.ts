import { getModelKeyCatalog, type Model } from "@schema/model";
import type {
  AnyRelation,
  RelationCardinality,
  RelationSlot,
} from "@schema/relation";
import type { ResolvedSlot } from "@schema/validation/relation-resolution";
import type {
  QueryScope,
  RelationRef,
  ScopeSource,
  VariantCarrierSlot,
  VariantJunctionCarrierSlot,
} from "../types";

export function createQueryScope(
  source: ScopeSource,
  model: Model<any>
): QueryScope {
  let nextAliasId = 0;
  const nextAlias = () => `t${nextAliasId++}`;
  return {
    adapter: source.adapter,
    model,
    nextAlias,
    rootAlias: nextAlias(),
    // BY IDENTITY: the composition root resolved once and every scope opened
    // from it shares that index object (§11.4.10).
    relations: source.relations,
  };
}

export function createChildScope(
  parent: QueryScope,
  model: Model<any>,
  alias: string
): QueryScope {
  return {
    adapter: parent.adapter,
    model,
    nextAlias: parent.nextAlias,
    rootAlias: alias,
    mutationTable: parent.mutationTable,
    // BY IDENTITY, never rebuilt: one resolution serves every scope in a client
    // (§11.4.10), so a child scope shares the parent's index object.
    relations: parent.relations,
  };
}

/**
 * The ONE graph lookup: this scope's model, this field.
 *
 * A schema reaches the engine only through a boundary that resolved it, so a
 * name the model declares always has a slot here; `undefined` means the name is
 * not a relation on this model.
 */
export function resolvedSlot(
  scope: QueryScope,
  relationName: string
): ResolvedSlot | undefined {
  return scope.relations.get(scope.model)?.get(relationName);
}

/**
 * The carrier slot of a direct variant relation, or `undefined` when the name is
 * not one.
 *
 * A bound variant INVERSE is deliberately excluded: it carries a `member`, so it
 * addresses exactly one member of someone else's carrier and belongs to the
 * ordinary reference below, which is how the two traversal directions keep their
 * separate vocabularies.
 */
export function variantCarrier(
  scope: QueryScope,
  relationName: string
): VariantCarrierSlot | undefined {
  const resolved = resolvedSlot(scope, relationName);
  if (!resolved || resolved.member) return undefined;
  const edge = resolved.edge;
  // TWO branches, not one test over the edge union: `VariantCarrierSlot` is the
  // union of its two arms — spelled that way so `isVariantRowCarrier` subtracts
  // — and a pair whose `edge` is still the union belongs to neither arm.
  if (edge.kind === "variantRowCarrier") return { slot: resolved.slot, edge };
  if (edge.kind === "variantJunctionCarrier") {
    return { slot: resolved.slot, edge };
  }
  return undefined;
}

/**
 * A contextual reference to one addressable relation: an ordinary slot, or a
 * bound inverse view of one variant member.
 *
 * A direct variant CARRIER answers `undefined` here — it spans several targets,
 * so there is no single `targetModel` to address it by, and its callers reach it
 * through {@link variantCarrier} instead.
 */
export function lookupRelation(
  scope: QueryScope,
  relationName: string
): RelationRef | undefined {
  const resolved = resolvedSlot(scope, relationName);
  if (!resolved) return undefined;
  const targetModel = referenceTarget(resolved);
  if (!targetModel) return undefined;
  return {
    name: relationName,
    resolved,
    targetModel,
    cardinality: slotCardinality(resolved),
  };
}

/** The reference a caller already holding the resolved slot addresses it by. */
export function refFromSlot(resolved: ResolvedSlot): RelationRef | undefined {
  const targetModel = referenceTarget(resolved);
  if (!targetModel) return undefined;
  return {
    name: resolved.slot.field,
    resolved,
    targetModel,
    cardinality: slotCardinality(resolved),
  };
}

/**
 * The OWNER-oriented reference to one member of a junction carrier.
 *
 * `name` is VARIANT-QUALIFIED — `items.post`, not `items` — and that is a
 * decision, not an accident. `getStepModelName(targetModel, relationName)`
 * drives the step-id prefix and `StepScope.allocate` appends `#N` on repeats, so
 * a shared `items` across three variants would allocate `items.find`,
 * `items.find#1`, `items.find#2` — ids whose meaning depends on emission order.
 * Variant-qualified names give `items.post.find`, `items.video.find`:
 * deterministic, readable, collision-free.
 */
export function memberRef(
  carrier: VariantJunctionCarrierSlot,
  member: VariantJunctionCarrierSlot["edge"]["members"][number]
): RelationRef {
  return {
    name: `${carrier.slot.field}.${member.variant}`,
    resolved: { slot: carrier.slot, edge: carrier.edge, member },
    targetModel: member.topology.target.model,
    // The PUBLIC slot's shape, which is what the relation-mutation parser reads
    // to choose its vocabulary: a collection takes the ordinary to-many verbs
    // (`updateMany`/`deleteMany` legal, `update` addressed by a unique `where`)
    // whatever a given variant's inverse cardinality is. The member's own arity
    // lives on the BOUND relation, where slot replacement consults it.
    cardinality: "many",
  };
}

/**
 * How many targets one resolved slot's public shape admits — the ONE fact the
 * declaration still states directly (§3.1), read off the model's own relation
 * map. The index is built from that map, so the lookup cannot miss.
 */
function slotCardinality(resolved: ResolvedSlot): RelationCardinality {
  const relations: Record<string, AnyRelation> =
    resolved.slot.source["~"].state.relations;
  return relations[resolved.slot.field]!["~"].state.cardinality;
}

/**
 * The model a reference traverses TO, or `undefined` for a spanning carrier.
 *
 * The ASKING SLOT decides, never the scope's model: a self edge names one model
 * on both sides, and only its two fields tell the directions apart.
 */
function referenceTarget(resolved: ResolvedSlot): Model<any> | undefined {
  const edge = resolved.edge;
  if (edge.kind === "foreignKey" || edge.kind === "junction") {
    const [first, second] = edge.endpoints;
    return isSlot(first, resolved.slot) ? second.source : first.source;
  }
  // A carrier slot spans every member and reaches no single model; a
  // member-RESTRICTED slot reaches the other end of that one member — the
  // variant when the asking slot is the carrier, the carrier's own model when it
  // is the bound inverse.
  if (!resolved.member) return undefined;
  if (!isSlot(edge.carrier, resolved.slot)) return edge.carrier.source;
  return "targetModel" in resolved.member
    ? resolved.member.targetModel
    : resolved.member.topology.target.model;
}

/** `(model, field)` is the whole contextual identity of a slot. */
function isSlot(one: RelationSlot, other: RelationSlot): boolean {
  return one.source === other.source && one.field === other.field;
}

/**
 * Return the named compound primary-key constraint and its ordered members —
 * a derived view of the model-key catalog: the row key, when it is a grouped
 * constraint rather than a bare scalar.
 */
export function getCompoundIdConstraint(
  model: Model<any>
): { name: string; fields: string[] } | undefined {
  const rowKey = getModelKeyCatalog(model).rowKey;
  return rowKey?.name === undefined
    ? undefined
    : { name: rowKey.name, fields: [...rowKey.fields] };
}

/**
 * Return the ordered scalar fields that form the model primary key — the
 * catalog row key's TOTAL view. The `["id"]` fallback for a model with no
 * declared key is load-bearing: thirty call sites and the converted dead-guard
 * family rely on this function never answering an empty list.
 */
export function getPrimaryKeyFields(model: Model<any>): string[] {
  const rowKey = getModelKeyCatalog(model).rowKey;
  return rowKey ? [...rowKey.fields] : ["id"];
}

export { getColumnName, getTableName } from "@schema/model";

export function getScalarFieldNames(model: Model<any>): string[] {
  return model["~"].scalarFieldNames;
}

export function getDefaultScalarFieldNames(model: Model<any>): string[] {
  const omitted = model["~"].state.omit;
  if (!omitted) return getScalarFieldNames(model);
  return getScalarFieldNames(model).filter(
    (fieldName) =>
      !Object.hasOwn(omitted, fieldName) || omitted[fieldName] !== true
  );
}

export function getRelationNames(model: Model<any>): string[] {
  return model["~"].relationNames;
}

export function isScalarField(model: Model<any>, fieldName: string): boolean {
  return model["~"].scalarFieldSet.has(fieldName);
}

/**
 * Whether the column behind a scalar field can hold SQL NULL.
 *
 * A NOT NULL column makes every null-placement request unobservable, which is
 * what lets the paginated ORDER BY drop the placement key and the cursor
 * predicate use a row-value comparison.
 */
export function isNullableScalarField(
  model: Model<any>,
  fieldName: string
): boolean {
  return model["~"].state.scalars[fieldName]?.["~"].state.nullable === true;
}

export function isRelation(model: Model<any>, fieldName: string): boolean {
  return model["~"].relationSet.has(fieldName);
}

export function isVariantRelation(
  scope: QueryScope,
  fieldName: string
): boolean {
  return variantCarrier(scope, fieldName) !== undefined;
}

/**
 * The COLLECTION half of {@link isVariantRelation}, split out because root
 * `createMany` routing needs exactly that half and nothing wider.
 *
 * A direct variant TO-ONE key in a bulk row stores private owner columns on
 * the row itself, and the grouped cross-row probe route
 * (`write-engine/bulk-polymorphic-connect.ts`) compiles it into the maximal
 * grouped INSERT — a shipped SQL contract pinned byte-for-byte. A COLLECTION key
 * has no such analogue: its membership lives in per-variant member junction rows
 * that only exist after the owner row does, so the row is relation-BEARING and
 * belongs to the record series.
 */
export function isVariantCollectionRelation(
  scope: QueryScope,
  fieldName: string
): boolean {
  return (
    variantCarrier(scope, fieldName)?.edge.kind === "variantJunctionCarrier"
  );
}
