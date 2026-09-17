import type { AnyModel } from "@schema/model";
import type { ClearableMembership } from "@schema/relation/clearability";
import type { ResolvedJunctionSide } from "@schema/relation/junction-topology";
import type { Scalar } from "@schema/scalars/base";
import type {
  ResolvedSlot,
  ResolvedStoredReference,
} from "@schema/validation/relation-resolution";
import type { EngineSchema } from "./schema";

export type Membership = {
  scope: Pick<ResolvedSlot, "edge" | "member">;
  clearability: ClearableMembership;
  name: string;
  source: AnyModel;
  target: AnyModel;
  many: boolean;
  discriminator?: { side: "source" | "target"; field: string; value: string };
} & (
  | {
      kind: "reference";
      owner: "source" | "target";
      pairs: readonly { source: string; target: string }[];
      reference?: ResolvedStoredReference;
    }
  | {
      kind: "junction";
      table: string;
      sourceSide: ResolvedJunctionSide;
      targetSide: ResolvedJunctionSide;
      uniqueSide?: "source" | "target";
    }
);

export type PhysicalField = {
  readonly name: string;
  readonly scalar: Scalar;
  readonly nullable: boolean;
};

/** Orient the already resolved storage once; no declaration getter or inverse search. */
export function bindMembership(
  schema: EngineSchema,
  source: AnyModel,
  name: string,
  variant?: string
): Membership {
  return schema.membership(source, name, variant);
}

/**
 * One variant-carrier member, or the candidate's registered unimplemented
 * identity. A carrier addressed with no variant names every arm at once, which
 * this one-membership view cannot represent; the caller must address an arm or
 * compose the arms itself (g4/unit02/note.md §10.3).
 */
function variantMember<T>(
  resolved: T | undefined,
  tagged: T | undefined,
  name: string
): T {
  const member = resolved ?? tagged;
  if (member === undefined)
    throw new Error(
      `Raptor 3 G1 variant carrier membership is not implemented: ${name}`
    );
  return member;
}

export function buildMembershipView(
  schema: EngineSchema,
  source: AnyModel,
  name: string,
  variant?: string
): Membership {
  const resolved = schema.index.get(source)!.get(name)!;
  const edge = resolved.edge;
  const clearability = schema.clearability(resolved);
  const many =
    source["~"].state.relations[name]!["~"].state.cardinality === "many";
  if (edge.kind === "variantRowCarrier") {
    const member = variantMember(
      resolved.member,
      edge.members.find((member) => member.variant === variant),
      name
    );
    const direct = resolved.member === undefined;
    return {
      scope: Object.freeze({ edge, member }),
      clearability,
      name: direct ? `${name}.${member.variant}` : name,
      source,
      many,
      target: direct ? member.targetModel : edge.carrier.source,
      kind: "reference",
      owner: direct ? "source" : "target",
      pairs: [
        {
          source: direct ? edge.storage.idColumn.name : member.referencedField,
          target: direct ? member.referencedField : edge.storage.idColumn.name,
        },
      ],
      discriminator: {
        side: direct ? "source" : "target",
        field: edge.storage.typeColumn.name,
        value: member.entry.storedValue,
      },
    };
  }
  if (edge.kind === "variantJunctionCarrier") {
    const member = variantMember(
      resolved.member,
      edge.members.find((member) => member.variant === variant),
      name
    );
    const direct = resolved.member === undefined;
    return {
      scope: Object.freeze({ edge, member }),
      clearability,
      name: direct ? `${name}.${member.variant}` : name,
      source,
      many,
      target: direct
        ? member.topology.target.model
        : member.topology.source.model,
      kind: "junction",
      table: member.topology.table,
      sourceSide: direct ? member.topology.source : member.topology.target,
      targetSide: direct ? member.topology.target : member.topology.source,
      uniqueSide: member.uniqueTarget
        ? direct
          ? "target"
          : "source"
        : undefined,
    };
  }
  const endpoint = edge.endpoints[0];
  const opposite =
    endpoint.source === source && endpoint.field === name
      ? edge.endpoints[1]
      : endpoint;
  const base = {
    scope: resolved,
    clearability,
    name,
    source,
    target: opposite.source,
    many,
  };
  if (edge.kind === "foreignKey") {
    const owns = edge.owner.source === source && edge.owner.field === name;
    return {
      ...base,
      kind: "reference",
      owner: owns ? "source" : "target",
      reference: edge.reference,
      pairs: edge.reference.members.map((pair) => ({
        source: owns ? pair.foreignField : pair.referencedField,
        target: owns ? pair.referencedField : pair.foreignField,
      })),
    };
  }
  const topology = edge.topology;
  // The SLOT decides, not the model: a self junction names one model on both
  // sides and only its two fields tell the directions apart. `opposite` above
  // already resolved that identity, and `endpoints[0]`/`endpoints[1]` are the
  // slots `topology.source`/`topology.target` were built from.
  const forward = opposite === edge.endpoints[1];
  return {
    ...base,
    kind: "junction",
    table: topology.table,
    sourceSide: forward ? topology.source : topology.target,
    targetSide: forward ? topology.target : topology.source,
  };
}

export function freezeMembershipView(view: Membership): Membership {
  if (view.kind === "reference") {
    for (const pair of view.pairs) Object.freeze(pair);
    Object.freeze(view.pairs);
    if (view.discriminator) Object.freeze(view.discriminator);
  }
  return Object.freeze(view);
}

/** Private carrier columns are resolved schema fields, never public scalar declarations. */
export function physicalField(
  schema: EngineSchema,
  model: AnyModel,
  field: string
): PhysicalField {
  return schema.physicalField(model, field);
}

export function buildPhysicalFieldView(
  schema: EngineSchema,
  model: AnyModel,
  field: string
): PhysicalField {
  const scalar = model["~"].state.scalars[field];
  if (scalar)
    return {
      name: model["~"].getFieldName(field).sql,
      scalar,
      nullable: scalar["~"].state.nullable === true,
    };
  for (const resolved of schema.index.get(model)!.values()) {
    if (resolved.edge.kind !== "variantRowCarrier" || resolved.member) continue;
    const { typeColumn, idColumn } = resolved.edge.storage;
    if (field === typeColumn.name) return typeColumn;
    if (field === idColumn.name) return idColumn;
  }
  throw new Error(`Raptor 3 G1 physical field is not implemented: ${field}`);
}

export function storedFields(
  schema: EngineSchema,
  model: AnyModel
): readonly string[] {
  return schema.storedFields(model);
}

export function buildStoredFieldsView(
  schema: EngineSchema,
  model: AnyModel
): string[] {
  const fields = [...model["~"].scalarFieldNames];
  for (const resolved of schema.index.get(model)!.values()) {
    if (resolved.edge.kind !== "variantRowCarrier" || resolved.member) continue;
    fields.push(
      resolved.edge.storage.typeColumn.name,
      resolved.edge.storage.idColumn.name
    );
  }
  return fields;
}
