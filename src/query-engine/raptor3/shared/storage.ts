import type { AnyModel } from "@schema/model";
import type { ResolvedJunctionSide } from "@schema/relation/junction-topology";
import type { Scalar } from "@schema/scalars/base";
import type {
  ResolvedSlot,
  ResolvedStoredReference,
} from "@schema/validation/relation-resolution";
import type { EngineSchema } from "./schema";

export type Membership = {
  scope: Pick<ResolvedSlot, "edge" | "member">;
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

/** Orient the already resolved storage once; no declaration getter or inverse search. */
export function bindMembership(
  schema: EngineSchema,
  source: AnyModel,
  name: string,
  variant?: string
): Membership {
  const resolved = schema.index.get(source)!.get(name)!;
  const edge = resolved.edge;
  const many =
    source["~"].state.relations[name]!["~"].state.cardinality === "many";
  if (edge.kind === "variantRowCarrier") {
    const member =
      resolved.member ??
      edge.members.find((member) => member.variant === variant)!;
    const direct = resolved.member === undefined;
    return {
      scope: { edge, member },
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
    const member =
      resolved.member ??
      edge.members.find((member) => member.variant === variant)!;
    const direct = resolved.member === undefined;
    return {
      scope: { edge, member },
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
  const forward = topology.source.model === source;
  return {
    ...base,
    kind: "junction",
    table: topology.table,
    sourceSide: forward ? topology.source : topology.target,
    targetSide: forward ? topology.target : topology.source,
  };
}

/** Private carrier columns are resolved schema fields, never public scalar declarations. */
export function physicalField(
  schema: EngineSchema,
  model: AnyModel,
  field: string
): { name: string; scalar: Scalar; nullable: boolean } {
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

export function storedFields(schema: EngineSchema, model: AnyModel): string[] {
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
