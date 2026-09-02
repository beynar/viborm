/**
 * Construction fixtures: a schema is prepared once (hydrated, gated), its args
 * flow through the REAL parse boundary, and the resulting validated args are
 * handed to `constructPattern`. Summaries render a pattern as plain data so a
 * test asserts exact rows / cells / references / arms / variable order.
 */
import { getColumnName, getTableName, type Model } from "@schema/model";
import type { ResolvedRelationIndex } from "@schema/validation/relation-resolution";
import {
  type ReferenceCells,
  type ReferenceFamily,
  referenceCells,
} from "@src/query-engine/pattern/cells";
import {
  type CellsView,
  type Constructed,
  constructPattern,
  type WriteOperation,
} from "@src/query-engine/pattern/construct";
import type { Pattern, Variable } from "@src/query-engine/pattern/pattern";
import { parseValidated } from "@src/query-engine/write-engine/parse-boundary";
import { prepareSchema } from "@tests/fixtures/query-scope";
import { createSchemaRegistry } from "@validation";

type Schema = Record<string, Model<any>>;

const prepared = new WeakMap<Schema, ResolvedRelationIndex>();

export function indexOf(schema: Schema): ResolvedRelationIndex {
  let index = prepared.get(schema);
  if (!index) {
    index = prepareSchema(schema);
    prepared.set(schema, index);
  }
  return index;
}

const ARGS_KEY: Record<WriteOperation, string> = {
  create: "create",
  update: "update",
  delete: "delete",
  upsert: "upsert",
  createMany: "createMany",
  createManyAndReturn: "createManyAndReturn",
  updateMany: "updateMany",
  updateManyAndReturn: "updateManyAndReturn",
  deleteMany: "deleteMany",
  deleteManyAndReturn: "deleteManyAndReturn",
};

/** The operation schema's output for `args` — what the engine hands construction. */
export function validated(
  schema: Schema,
  model: Model<any>,
  operation: WriteOperation,
  args: Record<string, unknown>
): Record<string, unknown> {
  indexOf(schema);
  const schemas = createSchemaRegistry(schema).getModelSchemas(model) as {
    args: Record<string, any>;
  };
  const target = schemas.args[ARGS_KEY[operation]];
  if (!target) throw new Error(`no args schema for ${operation}`);
  return parseValidated(target, args, operation, "") as Record<string, unknown>;
}

export function construct(
  schema: Schema,
  model: Model<any>,
  operation: WriteOperation,
  args: Record<string, unknown>,
  cells: CellsView = withSourceCells
): Constructed {
  return constructPattern({
    index: indexOf(schema),
    model,
    operation,
    validatedArgs: validated(schema, model, operation, args),
    cells,
  });
}

/** Construct from already-validated args (for shapes the grammar refuses). */
export function constructRaw(
  schema: Schema,
  model: Model<any>,
  operation: WriteOperation,
  validatedArgs: Record<string, unknown>,
  cells: CellsView = withSourceCells
): Constructed {
  return constructPattern({
    index: indexOf(schema),
    model,
    operation,
    validatedArgs,
    cells,
  });
}

/**
 * The proposed K2 field, supplied by the harness: the pairing between a
 * reference row's own columns and the ASKING side's key. Read from the resolved
 * topology — this file may spell storage words; construct.ts may not.
 */
export const withSourceCells: CellsView = (index, model, field) => {
  const slot = index.get(model)?.get(field);
  if (!slot) return referenceCells(index, model, field);
  // K2 today resolves a row carrier's PRIVATE storage columns through
  // `getColumnName`, which only knows scalars, and throws. The harness builds
  // the view K2 documents (proposed cells.ts fix in the report) so construction
  // — which never reads the edge — can be exercised on these families.
  if (slot.edge.kind === "variantRowCarrier") {
    const { edge } = slot;
    const holderModel = edge.carrier.source;
    const cardinality =
      slot.slot.source["~"].state.relations[slot.slot.field]?.["~"].state
        .cardinality === "many"
        ? "many"
        : "one";
    const rowCells = (
      member: (typeof edge.members)[number]
    ): ReferenceCells => ({
      relation: { model: slot.slot.source, field: slot.slot.field },
      holder: {
        model: holderModel,
        table: getTableName(holderModel),
        columns: [edge.storage.idColumn.name],
        fields: [edge.storage.idColumn.name],
      },
      referenced: {
        model: member.targetModel,
        table: getTableName(member.targetModel),
        columns: [getColumnName(member.targetModel, member.referencedField)],
        fields: [member.referencedField],
      },
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
      cardinality,
    });
    if (slot.member && "targetModel" in slot.member) {
      return { kind: "single", cells: rowCells(slot.member) };
    }
    return {
      kind: "variants",
      byVariant: new Map(edge.members.map((m) => [m.variant, rowCells(m)])),
    };
  }
  const family = referenceCells(index, model, field);
  const augment = (
    cells: ReferenceCells,
    variant: string | undefined
  ): ReferenceCells => {
    if (!cells.viaJunction) return cells;
    const { edge } = slot;
    const topology =
      edge.kind === "junction"
        ? edge.topology
        : edge.kind === "variantJunctionCarrier"
          ? ((slot.member && "topology" in slot.member
              ? slot.member.topology
              : undefined) ??
            edge.members.find((m) => m.variant === variant)?.topology)
          : undefined;
    if (!topology) return cells;
    const askingIsSource =
      topology.source.model === model && topology.target.model !== model
        ? true
        : topology.source.model === model && topology.target.model === model
          ? cells.holder.columns[0] ===
            topology.target.members[0]?.junctionField
          : false;
    const members = askingIsSource
      ? topology.source.members
      : topology.target.members;
    const sourceCells = members.map((m) => ({
      holderColumn: m.junctionField,
      referencedColumn: getColumnName(model, m.referencedField),
    }));
    return {
      ...cells,
      viaJunction: { ...cells.viaJunction, sourceCells },
    } as ReferenceCells;
  };
  if (family.kind === "single") {
    return { kind: "single", cells: augment(family.cells, undefined) };
  }
  const byVariant = new Map<string, ReferenceCells>();
  for (const [variant, cells] of family.byVariant) {
    byVariant.set(variant, augment(cells, variant));
  }
  return { kind: "variants", byVariant } as ReferenceFamily;
};

// ---------------------------------------------------------------------------
// Summaries
// ---------------------------------------------------------------------------

export function bindingOf(variable: Variable): string {
  const b = variable.binding;
  switch (b.kind) {
    case "literal":
      return `lit(${JSON.stringify(b.value)})`;
    case "generated":
      return "gen";
    case "matched":
      return `matched(r${b.row}.${b.column})`;
    case "returned":
      return `returned(r${b.row}.${b.column})`;
    default:
      return "?";
  }
}

export interface RowSummary {
  readonly id: number;
  readonly table: string;
  readonly mode: string;
  readonly cardinality: string;
  readonly fresh: boolean;
  readonly arm?: number;
  readonly key: readonly string[];
  readonly newKey?: readonly string[];
  readonly decision?: true;
}

export function rows(pattern: Pattern): readonly RowSummary[] {
  return pattern.rows.map((row) => ({
    id: row.id,
    table: row.table.table,
    mode: row.mode,
    cardinality: row.cardinality,
    fresh: row.fresh,
    ...(row.arm === undefined ? {} : { arm: row.arm }),
    key: row.key.map(bindingOf),
    ...(row.newKey ? { newKey: row.newKey.map(bindingOf) } : {}),
    ...(row.matchIsDecision ? { decision: true as const } : {}),
  }));
}

export interface CellSummary {
  readonly row: number;
  readonly column: string;
  readonly mode: string;
  readonly value: string;
  readonly arm?: number;
  readonly relative?: string;
}

export function cells(pattern: Pattern, row?: number): readonly CellSummary[] {
  return pattern.cells
    .filter((cell) => row === undefined || cell.row === row)
    .map((cell) => {
      const arm = (cell as { arm?: number }).arm;
      return {
        row: cell.row,
        column: cell.column,
        mode: cell.mode,
        value: bindingOf(cell.value),
        ...(arm === undefined ? {} : { arm }),
        ...(cell.relative
          ? {
              relative: `${cell.relative.operation}(${bindingOf(cell.relative.operand)})`,
            }
          : {}),
      };
    });
}

export interface ReferenceSummary {
  readonly holder: number;
  readonly referenced: number;
  readonly columns: readonly string[];
  readonly discriminator?: string;
  readonly arm?: number;
  readonly relation: string;
}

export function references(pattern: Pattern): readonly ReferenceSummary[] {
  return pattern.references.map((reference) => {
    const arm = (reference as { arm?: number }).arm;
    return {
      holder: reference.holder,
      referenced: reference.referenced,
      columns: reference.columns.map(
        (c) => `${c.holderColumn}->${c.referencedColumn}`
      ),
      ...(reference.discriminator
        ? {
            discriminator: `${reference.discriminator.column}=${bindingOf(reference.discriminator.value)}`,
          }
        : {}),
      ...(arm === undefined ? {} : { arm }),
      relation: reference.relation.field,
    };
  });
}

export function arms(pattern: Pattern): readonly string[] {
  return pattern.arms.map((arm) => `${arm.id}:${arm.taken}@r${arm.decision}`);
}

export function variables(pattern: Pattern): readonly string[] {
  return pattern.variables.map(
    (v) => `v${v.id}=${bindingOf(v)}${v.scalar ? `:${v.scalar.field}` : ""}`
  );
}
