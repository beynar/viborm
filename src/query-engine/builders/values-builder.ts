/**
 * Values Builder
 *
 * Builds VALUES clause for INSERT operations.
 * Handles scalar fields, defaults, and auto-generated values.
 */

import type {
  BatchReferenceSqlAdapter,
  CastType,
} from "@adapters/database-adapter";
import type { Model } from "@schema/model";
import { isSql, type Sql } from "@sql";
import { getColumnName } from "../context";
import { QueryEngineError, type QueryScope } from "../types";
import { shouldOmitInsertValue } from "./generated-scalar";
import { planInsertRowShapes } from "./insert-row-shapes";

export interface ValuesResult {
  columns: string[];
  values: Sql[][];
}

export interface ValuesGroup extends ValuesResult {
  inputIndexes: number[];
}

/**
 * The Axis-A value carrier (§0.1, §3.1). A single nested-write value threads
 * through statement boundaries as one of three things: a literal known now, a
 * pre-built `Sql` fragment (a connect target-PK subquery), or a `BatchValueRef`
 * — a symbol the planned substrate defers through the scratch table
 * (`batchRefs.store`/`read`). `buildScalarSqlValue` is the one leaf that lowers
 * all three, so the carrier lives here beside it rather than in a mode file:
 * operation programs and the shared FK/condition builders speak it, while the
 * SQL lowering remains adapter-owned.
 */
export interface BatchValueRef {
  readonly kind: "batchValueRef";
  readonly batchId: string;
  readonly key: string;
}

/** A value that flows through a relation write: a literal, a pre-built `Sql`
 *  fragment, or a deferred `BatchValueRef` lowered by atomic-batch runtime. */
export type BatchResolvableValue = unknown | Sql | BatchValueRef;

export function isBatchValueRef(value: unknown): value is BatchValueRef {
  return (
    value !== null &&
    typeof value === "object" &&
    (value as { kind?: unknown }).kind === "batchValueRef" &&
    typeof (value as { batchId?: unknown }).batchId === "string" &&
    typeof (value as { key?: unknown }).key === "string"
  );
}

/**
 * Lower a carrier value for a consuming statement: a `BatchValueRef` becomes the
 * adapter's `batchRefs.read` subquery (the planned substrate's deferred read);
 * anything else passes through unchanged. `buildScalarSqlValue` applies the
 * mandatory TEXT round-trip cast-back on top of the read result.
 */
export function lowerBatchResolvableValue(
  adapter: unknown,
  value: BatchResolvableValue
): unknown | Sql {
  if (!isBatchValueRef(value)) {
    return value;
  }

  const batchRefs = getBatchReferenceSqlAdapter(adapter);
  if (!batchRefs) {
    throw new QueryEngineError(
      "Batch reference SQL support is not available for this adapter."
    );
  }
  return batchRefs.read(value.batchId, value.key);
}

function getBatchReferenceSqlAdapter(
  adapter: unknown
): BatchReferenceSqlAdapter | undefined {
  if (
    adapter !== null &&
    typeof adapter === "object" &&
    isBatchReferenceSqlAdapter((adapter as { batchRefs?: unknown }).batchRefs)
  ) {
    return (adapter as { batchRefs: BatchReferenceSqlAdapter }).batchRefs;
  }
  return undefined;
}

function isBatchReferenceSqlAdapter(
  value: unknown
): value is BatchReferenceSqlAdapter {
  return (
    value !== null &&
    typeof value === "object" &&
    typeof (value as { read?: unknown }).read === "function" &&
    typeof (value as { store?: unknown }).store === "function"
  );
}

/**
 * Build VALUES for INSERT from create data
 *
 * @param ctx - Query context
 * @param data - Create input data (single record or array)
 * @returns Object with columns (actual DB column names) and values arrays
 */
export function buildValues(
  ctx: QueryScope,
  data: Record<string, unknown> | Record<string, unknown>[]
): ValuesResult {
  const records = Array.isArray(data) ? data : [data];
  const groups = buildValueGroups(ctx, records);
  if (groups.length === 0) {
    return { columns: [], values: [] };
  }
  if (groups.length !== 1) {
    throw new QueryEngineError(
      "Heterogeneous insert rows require grouped execution."
    );
  }
  return { columns: groups[0]!.columns, values: groups[0]!.values };
}

/** Build independently executable VALUES groups for heterogeneous rows. */
export function buildValueGroups(
  ctx: QueryScope,
  records: readonly Record<string, unknown>[]
): ValuesGroup[] {
  if (records.length === 0) {
    return [];
  }

  assertApplicationGeneratedValues(ctx, records);
  const fieldOrder = ctx.model["~"].scalarFieldNames;
  const shapes = planInsertRowShapes(fieldOrder, records, (field, value) =>
    shouldOmitInsertValue(ctx.model["~"].state.scalars[field], value)
  );

  return shapes.map((shape) => ({
    columns: shape.fields.map((field) => getColumnName(ctx.model, field)),
    inputIndexes: [...shape.inputIndexes],
    values: shape.rows.map((record) =>
      shape.fields.map((field) =>
        buildScalarSqlValue(ctx, ctx.model, field, record[field])
      )
    ),
  }));
}

function assertApplicationGeneratedValues(
  ctx: QueryScope,
  records: readonly Record<string, unknown>[]
): void {
  for (const fieldName of ctx.model["~"].scalarFieldNames) {
    const scalar = ctx.model["~"].state.scalars[fieldName];
    const genType = scalar?.["~"].state.autoGenerate;
    if (!genType) {
      continue;
    }
    for (const record of records) {
      if (
        genType === "increment" &&
        (record[fieldName] === 0 || record[fieldName] === 0n)
      ) {
        throw new QueryEngineError(
          `Explicit zero is not portable for auto-increment field '${fieldName}'.`
        );
      }
      if (genType === "increment") {
        continue;
      }
      if (!shouldOmitInsertValue(scalar, record[fieldName])) {
        continue;
      }
      throw new QueryEngineError(
        `Auto-generated value '${genType}' for field '${fieldName}' must be provided explicitly or ` +
          "handled by the database. Application-level ID generation (uuid, ulid, cuid) is not yet implemented."
      );
    }
  }
}

/**
 * Build value SQL for a single field, handling special types
 */
export function buildScalarSqlValue(
  ctx: QueryScope,
  model: Model<any>,
  fieldName: string,
  value: unknown
): Sql {
  if (value === undefined || value === null) {
    return ctx.adapter.literals.null();
  }

  const loweredValue = lowerBatchResolvableValue(ctx.adapter, value);
  if (isBatchValueRef(value)) {
    return castBatchRefValue(ctx, model, fieldName, loweredValue as Sql);
  }

  if (isSql(loweredValue)) {
    // Pass through Sql values directly (e.g., subqueries from connect)
    return loweredValue;
  }

  // Get scalar type if available
  const field = model["~"].state.scalars[fieldName];
  const scalarState = field?.["~"]?.state;
  const scalarType = scalarState?.type;

  // List scalars take the whole array in the dialect's storage format
  // (native array on PG, JSON on MySQL/SQLite)
  if (scalarState?.array && Array.isArray(loweredValue)) {
    return ctx.adapter.arrays.value(loweredValue);
  }

  // JSON scalars always store serialized JSON — primitives included — so every
  // dialect receives valid JSON text (a bare 'hello' is not valid JSON on PG)
  if (scalarType === "json") {
    return ctx.adapter.literals.json(loweredValue);
  }

  // Datetime ISO strings need dialect-specific serialization (MySQL rejects 'Z')
  if (scalarType === "datetime" && typeof loweredValue === "string") {
    return ctx.adapter.literals.dateTime(loweredValue);
  }

  return ctx.adapter.literals.value(loweredValue);
}

/**
 * Parameterize a scalar comparison/assignment value against ctx.model,
 * routing datetime ISO strings through the adapter's dialect-specific
 * serialization. Used by where/set/cursor builders.
 */
export function scalarValueLiteral(
  ctx: QueryScope,
  fieldName: string,
  value: unknown
): Sql {
  const state = ctx.model["~"].state.scalars[fieldName]?.["~"].state;
  // Whole-list values (e.g. { set: [...] }) use the dialect's storage format
  if (state?.array && Array.isArray(value)) {
    return ctx.adapter.arrays.value(value);
  }
  if (state?.type === "datetime" && typeof value === "string") {
    return ctx.adapter.literals.dateTime(value);
  }
  // JSON scalars store serialized JSON, primitives included (see buildScalarSqlValue)
  if (state?.type === "json" && value !== null && value !== undefined) {
    return ctx.adapter.literals.json(value);
  }
  return ctx.adapter.literals.value(value);
}

function castBatchRefValue(
  ctx: QueryScope,
  model: Model<any>,
  fieldName: string,
  value: Sql
): Sql {
  const castType = getScalarCastType(model, fieldName);
  return castType ? ctx.adapter.expressions.cast(value, castType) : value;
}

export function getScalarCastType(
  model: Model<any>,
  fieldName: string
): CastType | undefined {
  const scalarType = model["~"].state.scalars[fieldName]?.["~"].state.type;

  switch (scalarType) {
    case "int":
    case "bigint":
      return "integer";
    case "float":
    case "decimal":
      return "numeric";
    case "boolean":
      return "boolean";
    case "string":
    case "date":
    case "datetime":
    case "time":
      return "text";
    default:
      return undefined;
  }
}

/**
 * Build a single INSERT statement
 */
export function buildInsert(
  ctx: QueryScope,
  tableName: string,
  data: Record<string, unknown>
): Sql {
  const { columns, values } = buildValues(ctx, data);

  if (values.length === 0) {
    throw new QueryEngineError("No columns to insert");
  }

  const table = ctx.adapter.identifiers.escape(tableName);
  if (columns.length === 0) {
    return ctx.adapter.mutations.insertDefault(table);
  }
  return ctx.adapter.mutations.insert(table, columns, values);
}

/**
 * Build INSERT for createMany
 */
export function buildInsertMany(
  ctx: QueryScope,
  tableName: string,
  data: Record<string, unknown>[]
): Sql {
  const { columns, values } = buildValues(ctx, data);

  if (values.length === 0) {
    throw new QueryEngineError("No data to insert");
  }

  const table = ctx.adapter.identifiers.escape(tableName);
  if (columns.length === 0) {
    if (values.length !== 1) {
      throw new QueryEngineError(
        "Multiple default-only rows require grouped execution."
      );
    }
    return ctx.adapter.mutations.insertDefault(table);
  }
  return ctx.adapter.mutations.insert(table, columns, values);
}
