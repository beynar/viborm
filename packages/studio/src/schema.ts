/**
 * The studio's view of a schema: each model as a table of columns, each
 * relation as the slot a row follows, and each resolved edge once, as the ERD
 * draws it. Everything here is READ from the two owners that already answer
 * it — scalar state for columns, the resolved relation index for topology
 * (`resolveSchemaOrThrow`) — and serialized as plain JSON for the browser.
 */

import { getModelSqlName } from "@src/schema/hydration";
import type { Model } from "@src/schema/model";
import { getModelKeyCatalog } from "@src/schema/model/keys";
import type { RelationSlot } from "@src/schema/relation/types";
import type { Scalar } from "@src/schema/scalars/base";
import type { ScalarType } from "@src/schema/scalars/common";
import type {
  ResolvedRelationEdge,
  ResolvedSlot,
} from "@src/schema/validation/relation-resolution";
import { resolvedEdges } from "@src/schema/validation/relation-resolution";
import { resolveSchemaOrThrow } from "@src/schema/validation/validator";

export interface StudioField {
  readonly name: string;
  /** The database column, when `.map()` renamed it. */
  readonly column: string;
  readonly type: ScalarType;
  readonly nullable: boolean;
  readonly list: boolean;
  readonly id: boolean;
  readonly unique: boolean;
  /** A create may leave it out: a default, a generator, or nullable. */
  readonly optional: boolean;
  /** The generator that fills it (`increment`, `uuid`, `now`, `updatedAt`, …). */
  readonly generated?: string;
  readonly enumValues?: readonly string[];
}

export interface StudioRelation {
  readonly name: string;
  readonly cardinality: "one" | "many";
  /** Every model the slot can reach; one entry except for a variant relation. */
  readonly targets: readonly string[];
  readonly storage: "foreignKey" | "junction" | "variant";
  /** This model holds the foreign key columns (`fields` → target `references`). */
  readonly owner: boolean;
  readonly fields: readonly string[];
  readonly references: readonly string[];
  /** The partner slot on the target, when the relation is ordinary. */
  readonly inverse?: string;
  readonly inverseCardinality?: "one" | "many";
}

export interface StudioModel {
  readonly name: string;
  readonly table: string;
  /** The primary key, which update and delete address one row by; absent, the model is read-only. */
  readonly key?: { readonly name?: string; readonly fields: readonly string[] };
  readonly fields: readonly StudioField[];
  readonly relations: readonly StudioRelation[];
}

/** Crow's foot ends: how many rows of its model one row on the other side stands for. */
export type StudioEnd = "one" | "zero-or-one" | "zero-or-many";

export interface StudioEdge {
  readonly id: string;
  readonly kind: "one-to-one" | "one-to-many" | "many-to-many" | "variant";
  readonly from: {
    readonly model: string;
    readonly relation: string;
    readonly columns: readonly string[];
  };
  readonly to: {
    readonly model: string;
    readonly relation?: string;
    readonly columns: readonly string[];
  };
  readonly fromEnd: StudioEnd;
  readonly toEnd: StudioEnd;
  /** The junction table a many-to-many edge is stored in. */
  readonly junction?: string;
}

export interface StudioSchema {
  readonly dialect: string;
  readonly models: readonly StudioModel[];
  readonly edges: readonly StudioEdge[];
}

/** Generators the database or the engine run without an installed default. */
const SERVER_GENERATED = new Set(["increment", "now", "updatedAt"]);

type Models = Readonly<Record<string, Model<any>>>;

/** The whole studio schema, from the models a loaded config's client holds. */
export function describeSchema(models: Models, dialect: string): StudioSchema {
  const index = resolveSchemaOrThrow({ ...models });
  const nameOf = new Map<Model<any>, string>();
  for (const [name, model] of Object.entries(models)) nameOf.set(model, name);
  // Every model the index reaches is one of the schema's own.
  const named = (model: Model<any>) => nameOf.get(model)!;

  return {
    dialect,
    models: Object.entries(models).map(([name, model]) =>
      describeModel(name, model, index.get(model), named)
    ),
    edges: [...resolvedEdges(index)].flatMap((edge) =>
      describeEdge(edge, named)
    ),
  };
}

function describeModel(
  name: string,
  model: Model<any>,
  slots: ReadonlyMap<string, ResolvedSlot> | undefined,
  named: (model: Model<any>) => string
): StudioModel {
  const state = model["~"].state;
  const catalog = getModelKeyCatalog(model);
  // A row is addressed by its primary key: the engine updates and deletes by it.
  const key = catalog.rowKey;
  const scalars: Record<string, Scalar> = state.scalars;
  const fields = Object.entries(scalars).map(([field, scalar]) => {
    const scalarState = scalar["~"].state;
    const values = scalarState.base as { values?: unknown };
    const generator = scalarState.autoGenerate?.kind;
    // A format such as `.ulid()` generates only where a default was installed.
    const generated =
      generator !== undefined &&
      (scalarState.hasDefault || SERVER_GENERATED.has(generator))
        ? generator
        : undefined;
    return {
      name: field,
      column: model["~"].getFieldName(field).sql,
      type: scalarState.type,
      nullable: scalarState.nullable,
      list: scalarState.array,
      id: scalarState.isId || (catalog.rowKey?.fields.includes(field) ?? false),
      unique: scalarState.isUnique,
      optional:
        scalarState.hasDefault ||
        generated !== undefined ||
        scalarState.nullable,
      ...(generated === undefined ? {} : { generated }),
      ...(scalarState.type === "enum" && Array.isArray(values.values)
        ? { enumValues: values.values.map(String) }
        : {}),
    } satisfies StudioField;
  });
  const relations = Object.keys(state.relations).flatMap((field) => {
    // A resolved schema resolves every slot of every model.
    return [describeRelation(field, model, slots!.get(field)!, named)];
  });
  return {
    name,
    table: getModelSqlName(model),
    ...(key
      ? {
          key: {
            ...(key.name === undefined ? {} : { name: key.name }),
            fields: key.fields,
          },
        }
      : {}),
    fields,
    relations,
  };
}

function describeRelation(
  field: string,
  model: Model<any>,
  resolved: ResolvedSlot,
  named: (model: Model<any>) => string
): StudioRelation {
  const cardinality = model["~"].state.relations[field]!["~"].state.cardinality;
  const { edge } = resolved;
  if (edge.kind === "foreignKey") {
    const partner = edge.endpoints.find(
      (endpoint) => !(endpoint.source === model && endpoint.field === field)
    )!;
    const owner = edge.owner.source === model && edge.owner.field === field;
    return {
      name: field,
      cardinality,
      targets: [named(partner.source)],
      storage: "foreignKey",
      owner,
      fields: owner
        ? edge.reference.members.map((member) => member.foreignField)
        : [],
      references: owner
        ? edge.reference.members.map((member) => member.referencedField)
        : [],
      ...partnerOf(partner),
    };
  }
  if (edge.kind === "junction") {
    const partner = edge.endpoints.find(
      (endpoint) => !(endpoint.source === model && endpoint.field === field)
    )!;
    return {
      name: field,
      cardinality,
      targets: [named(partner.source)],
      storage: "junction",
      owner: false,
      fields: [],
      references: [],
      ...partnerOf(partner),
    };
  }
  // A variant member viewed from its ordinary inverse reaches the carrier's model.
  if (resolved.member) {
    return {
      name: field,
      cardinality,
      targets: [named(edge.carrier.source)],
      storage: "variant",
      owner: false,
      fields: [],
      references: [],
      ...partnerOf(edge.carrier),
    };
  }
  return {
    name: field,
    cardinality,
    targets: edge.members.map((member) =>
      named(
        "targetModel" in member
          ? member.targetModel
          : member.topology.target.model
      )
    ),
    storage: "variant",
    // The carrier's type and id columns are private storage, not model fields.
    owner: false,
    fields: [],
    references: [],
  };
}

const partnerOf = (slot: RelationSlot) => ({
  inverse: slot.field,
  inverseCardinality:
    slot.source["~"].state.relations[slot.field]!["~"].state.cardinality,
});

function describeEdge(
  edge: ResolvedRelationEdge,
  named: (model: Model<any>) => string
): StudioEdge[] {
  if (edge.kind === "foreignKey") {
    const { owner } = edge;
    const target = edge.endpoints.find((endpoint) => endpoint !== owner)!;
    const scalars = owner.source["~"].state.scalars;
    const nullable = edge.reference.members.some(
      (member) => scalars[member.foreignField]?.["~"].state.nullable === true
    );
    const { unique } = edge;
    return [
      {
        id: `${named(owner.source)}.${owner.field}`,
        kind: unique ? "one-to-one" : "one-to-many",
        from: {
          model: named(owner.source),
          relation: owner.field,
          columns: edge.reference.members.map((member) => member.foreignField),
        },
        to: {
          model: named(target.source),
          relation: target.field,
          columns: edge.reference.members.map(
            (member) => member.referencedField
          ),
        },
        fromEnd: unique ? "zero-or-one" : "zero-or-many",
        toEnd: nullable ? "zero-or-one" : "one",
      },
    ];
  }
  if (edge.kind === "junction") {
    // The resolver orients the topology as the endpoints: source first.
    const [source, target] = edge.endpoints;
    const { topology } = edge;
    return [
      {
        id: `${named(source.source)}.${source.field}`,
        kind: "many-to-many",
        from: {
          model: named(source.source),
          relation: source.field,
          columns: topology.source.members.map(
            (member) => member.referencedField
          ),
        },
        to: {
          model: named(target.source),
          relation: target.field,
          columns: topology.target.members.map(
            (member) => member.referencedField
          ),
        },
        fromEnd: "zero-or-many",
        toEnd: "zero-or-many",
        junction: topology.table,
      },
    ];
  }
  const carrier = edge.carrier;
  return edge.members.map((member): StudioEdge => {
    const targetModel =
      "targetModel" in member
        ? member.targetModel
        : member.topology.target.model;
    return {
      id: `${named(carrier.source)}.${carrier.field}.${member.variant}`,
      kind: "variant",
      from: {
        model: named(carrier.source),
        relation: carrier.field,
        columns: [],
      },
      to: {
        model: named(targetModel),
        ...(member.inverse ? { relation: member.inverse.field } : {}),
        columns:
          "referencedField" in member
            ? [member.referencedField]
            : member.topology.target.members.map(
                (entry) => entry.referencedField
              ),
      },
      fromEnd: "zero-or-many",
      toEnd: "zero-or-one",
    };
  });
}
