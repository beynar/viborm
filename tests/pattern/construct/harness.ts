/**
 * Construction fixtures: a schema is prepared once (hydrated, gated), its args
 * flow through the REAL parse boundary, and the resulting validated args are
 * handed to `constructPattern`. Summaries render a pattern as plain data so a
 * test asserts exact rows / cells / references / arms / variable order.
 */
import type { Model } from "@schema/model";
import type { ResolvedRelationIndex } from "@schema/validation/relation-resolution";
import { referenceCells } from "@src/query-engine/pattern/cells";
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
  cells: CellsView = referenceCells
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
  cells: CellsView = referenceCells
): Constructed {
  return constructPattern({
    index: indexOf(schema),
    model,
    operation,
    validatedArgs,
    cells,
  });
}

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
