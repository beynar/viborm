import type { AnyModel } from "@schema/model";
import type { ClearableMembership } from "@schema/relation/clearability";
import type { ResolvedJunctionSide } from "@schema/relation/junction-topology";
import type { PolymorphicStorageColumn } from "@schema/relation/polymorphic";
import type { Scalar } from "@schema/scalars/base";
import type {
  ResolvedSlot,
  ResolvedStoredReference,
} from "@schema/validation/relation-resolution";
import { assertInvariant } from "./invariant";
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
 * One variant-carrier member: the slot's own bound member, or the arm the
 * caller named. A carrier addressed with no variant names every arm at once,
 * which this one-membership view cannot represent; the caller addresses an arm
 * or composes the arms itself (g4/unit02/note.md §10.3).
 *
 * INVARIANT, not a refusal (N4 row 49). Every caller reads the slot first: a
 * bound inverse carries `resolved.member`, a carrier slot is walked arm by arm
 * over `edge.members`, and the one arm name a payload supplies is the tagged
 * grammar's `type`, which validation pins to a literal union of the configured
 * public variants before the engine sees it.
 */
function variantMember<T>(
  resolved: T | undefined,
  tagged: T | undefined,
  name: string,
  variant: string | undefined
): T {
  const member = resolved ?? tagged;
  assertInvariant(
    member !== undefined,
    `Variant carrier '${name}' was addressed with ${
      variant === undefined ? "no arm" : `the undeclared arm '${variant}'`
    }: every caller addresses one declared arm or composes the arms itself.`
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
      name,
      variant
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
      name,
      variant
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

/**
 * The private `(type, id)` columns this model's variant ROW carriers store, in
 * declaration order. ONE enumeration of them, so what a field resolves to and
 * what {@link buildStoredFieldsView} says the row stores cannot drift apart.
 */
function carrierColumns(
  schema: EngineSchema,
  model: AnyModel
): PolymorphicStorageColumn[] {
  const columns: PolymorphicStorageColumn[] = [];
  for (const { edge, member } of schema.index.get(model)!.values())
    if (edge.kind === "variantRowCarrier" && !member)
      columns.push(edge.storage.typeColumn, edge.storage.idColumn);
  return columns;
}

/**
 * INVARIANT, not a refusal (N4 row 48): a model stores its declared scalars and
 * its row carriers' columns, and nothing asks this owner for anything else. A
 * field name arrives from admission, which matched it against the model's
 * declared scalar keys, or from the resolved topology itself — a membership
 * pair, a carrier discriminator, a junction side's referenced field, a row key,
 * or {@link buildStoredFieldsView}, which enumerates exactly those two sets.
 */
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
  const column = carrierColumns(schema, model).find(
    (candidate) => candidate.name === field
  );
  assertInvariant(
    column,
    `'${field}' is neither a declared scalar of '${model["~"].names.sql}' nor one of its variant carrier columns.`
  );
  return column;
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
  return [
    ...model["~"].scalarFieldNames,
    ...carrierColumns(schema, model).map((column) => column.name),
  ];
}
