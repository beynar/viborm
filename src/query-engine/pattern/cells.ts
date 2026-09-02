/**
 * K2 — the cell map (pattern-engine-ideal-state.md §4, §13.2).
 *
 * The resolved relation index (`relation-resolution.ts`) already publishes one
 * trusted edge per (model, field). This module is the engine's one VIEW of that
 * edge as cells: which row holds the reference, in which columns, whether it is
 * a junction row of its own, whether a discriminator selects the referenced
 * table, whether the reference is unique, clearable, and what the database does
 * when the referenced key changes.
 *
 * Nothing here decides anything about verbs, substrates, or phases. A word such
 * as "parentHeld", "childHeld", "junction", "polymorphic" must not appear in the
 * engine outside this file: the census in tests/pattern enforces that.
 */
import type { Model } from "@schema/model";
import { getColumnName, getModelKeyCatalog, getTableName } from "@schema/model";
import { clearableMembership } from "@schema/relation";
import type {
  ResolvedRelationIndex,
  ResolvedSlot,
} from "@schema/validation/relation-resolution";

export type KeyChangeAction = "cascade" | "restrict" | "setNull" | "none";

export interface CellSide {
  readonly model: Model<any>;
  readonly table: string;
  /** Ordered physical columns, model-key-catalog order for a key. */
  readonly columns: readonly string[];
  /** The public fields those columns realize, index-aligned with `columns`. */
  readonly fields: readonly string[];
}

/**
 * One reference between two rows, as cells. For a junction, `holder` is the
 * junction row itself and `viaJunction` names both sides; for a row-held
 * reference, `holder` is whichever endpoint stores the columns.
 */
export interface ReferenceCells {
  readonly relation: { readonly model: Model<any>; readonly field: string };
  /** The row that stores the reference. */
  readonly holder: CellSide;
  /** The row whose key is stored. */
  readonly referenced: CellSide;
  /** Which public endpoint the holder is: the asking slot's own model, or its target. */
  readonly holderIsSource: boolean;
  /** Paired member for member; the ONE pairing (never re-pair by index). */
  readonly cells: readonly {
    readonly holderColumn: string;
    readonly referencedColumn: string;
  }[];
  /** Present when the reference lives in a junction row of its own. */
  readonly viaJunction?: {
    readonly table: string;
    readonly source: CellSide;
    readonly target: CellSide;
    /** The reference row's own columns paired with the SOURCE endpoint's referenced fields. */
    readonly sourceCells: readonly {
      readonly holderColumn: string;
      readonly referencedColumn: string;
    }[];
    /** The reference row's own columns paired with the TARGET endpoint's referenced fields. */
    readonly targetCells: readonly {
      readonly holderColumn: string;
      readonly referencedColumn: string;
    }[];
    /** The pairing toward the ASKING endpoint (the parent row); `referencedCells` is the pairing toward the referenced endpoint, always `cells`. */
    readonly askingCells: readonly {
      readonly holderColumn: string;
      readonly referencedColumn: string;
    }[];
    readonly referencedCells: readonly {
      readonly holderColumn: string;
      readonly referencedColumn: string;
    }[];
  };
  /** Present when a stored discriminator selects the referenced table. */
  readonly discriminator?: {
    readonly column: string;
    readonly storedValue: string;
    readonly variant: string;
  };
  /** Cardinality one on the holder's columns (a unique reference or a singular member junction). */
  readonly unique: boolean;
  /** May the holder's reference cells be cleared without deleting the holder. */
  readonly nullable: boolean;
  readonly onKeyChange: KeyChangeAction;
  /** Public cardinality of the asking slot. */
  readonly cardinality: "one" | "many";
}

/**
 * A slot resolves to one reference, or to one reference per variant when the
 * payload selects the target (a direct polymorphic slot). The engine binds the
 * variant from the payload or the stored discriminator and then works with one
 * `ReferenceCells`; it never branches on this union past that point.
 */
export type ReferenceFamily =
  | { readonly kind: "single"; readonly cells: ReferenceCells }
  | {
      readonly kind: "variants";
      readonly byVariant: ReadonlyMap<string, ReferenceCells>;
    };

function side(model: Model<any>, fields: readonly string[]): CellSide {
  return {
    model,
    table: getTableName(model),
    columns: fields.map((field) => getColumnName(model, field)),
    fields,
  };
}

function sameSlot(
  one: { readonly source: Model<any>; readonly field: string },
  other: { readonly source: Model<any>; readonly field: string }
): boolean {
  return one.source === other.source && one.field === other.field;
}

function rowKeyFields(model: Model<any>): readonly string[] {
  return getModelKeyCatalog(model).rowKey?.fields ?? [];
}

function keyChange(action: string | undefined): KeyChangeAction {
  if (action === "cascade") return "cascade";
  if (action === "setNull") return "setNull";
  if (action === undefined) return "restrict";
  return action === "noAction" ? "restrict" : "restrict";
}

function slotCardinality(slot: ResolvedSlot): "one" | "many" {
  const relation = slot.slot.source["~"].state.relations[slot.slot.field];
  return relation?.["~"].state.cardinality === "many" ? "many" : "one";
}

/** The clearability owner's verdict, read as "may the reference cells be cleared". */
function clearable(slot: ResolvedSlot): boolean {
  return clearableMembership(slot).kind !== "none";
}

function foreignKeyCells(
  slot: ResolvedSlot,
  edge: Extract<ResolvedSlot["edge"], { readonly kind: "foreignKey" }>
): ReferenceCells {
  const [a, b] = edge.endpoints;
  const holderSlot = edge.owner;
  const referencedSlot = holderSlot === a ? b : a;
  const holderModel = holderSlot.source;
  const referencedModel = referencedSlot.source;
  const foreignFields = edge.reference.members.map((m) => m.foreignField);
  const referencedFields = edge.reference.members.map((m) => m.referencedField);
  return {
    relation: { model: slot.slot.source, field: slot.slot.field },
    holder: side(holderModel, foreignFields),
    referenced: side(referencedModel, referencedFields),
    holderIsSource:
      holderSlot.source === slot.slot.source &&
      holderSlot.field === slot.slot.field,
    cells: edge.reference.members.map((m) => ({
      holderColumn: getColumnName(holderModel, m.foreignField),
      referencedColumn: getColumnName(referencedModel, m.referencedField),
    })),
    unique: edge.unique,
    nullable: clearable(slot),
    onKeyChange: keyChange(edge.reference.onUpdate),
    cardinality: slotCardinality(slot),
  };
}

function junctionCells(
  slot: ResolvedSlot,
  topology: import("@schema/relation/junction-topology").ResolvedJunctionTopology,
  options: {
    readonly uniqueTarget: boolean;
    readonly variant?: string;
    readonly onUpdate?: string;
    /** Is the asking slot the topology's source side (decided by slot identity, exact on a self-relation). */
    readonly sourceIsAsking: boolean;
  }
): ReferenceCells {
  const sourceSide = side(
    topology.source.model,
    topology.source.members.map((m) => m.referencedField)
  );
  const targetSide = side(
    topology.target.model,
    topology.target.members.map((m) => m.referencedField)
  );
  const { sourceIsAsking } = options;
  const referenced = sourceIsAsking ? targetSide : sourceSide;
  const junctionMembers = sourceIsAsking
    ? topology.target.members
    : topology.source.members;
  const pairs = (
    members: readonly { junctionField: string; referencedField: string }[],
    model: Model<any>
  ) =>
    members.map((m) => ({
      holderColumn: m.junctionField,
      referencedColumn: getColumnName(model, m.referencedField),
    }));
  const sourcePairs = pairs(topology.source.members, topology.source.model);
  const targetPairs = pairs(topology.target.members, topology.target.model);
  const junctionSide: CellSide = {
    model: referenced.model,
    table: topology.table,
    columns: junctionMembers.map((m) => m.junctionField),
    fields: junctionMembers.map((m) => m.referencedField),
  };
  return {
    relation: { model: slot.slot.source, field: slot.slot.field },
    holder: junctionSide,
    referenced,
    holderIsSource: false,
    cells: sourceIsAsking ? targetPairs : sourcePairs,
    viaJunction: {
      table: topology.table,
      source: sourceSide,
      target: targetSide,
      sourceCells: sourcePairs,
      targetCells: targetPairs,
      askingCells: sourceIsAsking ? sourcePairs : targetPairs,
      referencedCells: sourceIsAsking ? targetPairs : sourcePairs,
    },
    unique: options.uniqueTarget,
    nullable: true,
    onKeyChange: keyChange(options.onUpdate),
    cardinality: slotCardinality(slot),
  };
}

/**
 * The one entry point. Resolves the slot's edge into cells. A variant row
 * carrier from its own slot yields one reference per variant (the payload
 * selects); an inverse view of one member yields that member's reference with
 * the discriminator fixed.
 */
export function referenceCells(
  index: ResolvedRelationIndex,
  model: Model<any>,
  field: string
): ReferenceFamily {
  const slot = index.get(model)?.get(field);
  if (!slot) {
    throw new Error(
      `query-engine pattern: no resolved slot for ${getTableName(model)}.${field}`
    );
  }
  const { edge } = slot;
  // biome-ignore lint/style/useDefaultSwitchClause: ResolvedRelationEdge is exhaustive.
  switch (edge.kind) {
    case "foreignKey":
      return { kind: "single", cells: foreignKeyCells(slot, edge) };
    case "junction":
      return {
        kind: "single",
        cells: junctionCells(slot, edge.topology, {
          uniqueTarget: false,
          onUpdate: edge.onUpdate,
          sourceIsAsking: sameSlot(edge.endpoints[0], slot.slot),
        }),
      };
    case "variantRowCarrier": {
      const rowCells = (
        member: (typeof edge.members)[number]
      ): ReferenceCells => {
        const holderModel = edge.carrier.source;
        return {
          relation: { model: slot.slot.source, field: slot.slot.field },
          // The private (type, id) storage names are physical columns, not
          // scalar fields: never resolve them through the field registry.
          holder: {
            model: holderModel,
            table: getTableName(holderModel),
            columns: [edge.storage.idColumn.name],
            fields: [edge.storage.idColumn.name],
          },
          referenced: side(member.targetModel, [member.referencedField]),
          holderIsSource: holderModel === slot.slot.source,
          cells: [
            {
              holderColumn: edge.storage.idColumn.name,
              referencedColumn: getColumnName(
                member.targetModel,
                member.referencedField
              ),
            },
          ],
          discriminator: {
            column: edge.storage.typeColumn.name,
            storedValue: member.entry.storedValue,
            variant: member.variant,
          },
          unique: edge.uniqueTarget,
          nullable: edge.storage.idColumn.nullable,
          onKeyChange: "none",
          cardinality: slotCardinality(slot),
        };
      };
      if (slot.member && "targetModel" in slot.member) {
        return { kind: "single", cells: rowCells(slot.member) };
      }
      return {
        kind: "variants",
        byVariant: new Map(edge.members.map((m) => [m.variant, rowCells(m)])),
      };
    }
    case "variantJunctionCarrier": {
      const memberCells = (
        member: (typeof edge.members)[number]
      ): ReferenceCells =>
        junctionCells(slot, member.topology, {
          uniqueTarget: member.uniqueTarget,
          variant: member.variant,
          sourceIsAsking: member.topology.source.model === slot.slot.source,
        });
      if (slot.member && "topology" in slot.member) {
        return { kind: "single", cells: memberCells(slot.member) };
      }
      return {
        kind: "variants",
        byVariant: new Map(
          edge.members.map((m) => [m.variant, memberCells(m)])
        ),
      };
    }
  }
}

/** Convenience for callers that already hold the model's row key. */
export function rowKeySide(model: Model<any>): CellSide {
  return side(model, rowKeyFields(model));
}
