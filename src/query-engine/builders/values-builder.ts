/**
 * Values Builder
 *
 * Builds VALUES clause for INSERT operations.
 * Handles scalar fields, defaults, and auto-generated values.
 */

import type { CastType, DatabaseAdapter } from "@adapters/database-adapter";
import { type JsonNullKind, jsonNullKindOf } from "@schema/json-null";
import type { Model } from "@schema/model";
import type { Scalar } from "@schema/scalars/base";
import { isSql, type Sql } from "@sql";
import { canonicalizeDecimal } from "@validation/primitives/decimal";
import { getColumnName } from "../context";
import { QueryEngineError, type QueryScope } from "../types";
import { shouldOmitInsertValue } from "./generated-scalar";
import { planInsertRowShapes } from "./insert-row-shapes";
import {
  type PolymorphicStorageValue,
  polymorphicStorageMembers,
} from "./polymorphic-mutation";

export interface ValuesResult {
  columns: string[];
  values: Sql[][];
}

export interface ValuesGroup extends ValuesResult {
  inputIndexes: number[];
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
  data: Record<string, unknown> | Record<string, unknown>[],
  polymorphicStorage: readonly PolymorphicStorageValue<unknown>[] = []
): ValuesResult {
  const records = Array.isArray(data) ? data : [data];
  const groups = buildValueGroups(
    ctx,
    records,
    records.length === 1 ? polymorphicStorage : []
  );
  if (groups.length === 0) {
    return { columns: [], values: [] };
  }
  if (groups.length !== 1) {
    throw new QueryEngineError(
      "Heterogeneous insert rows require grouped execution."
    );
  }
  if (polymorphicStorage.length > 0 && records.length !== 1) {
    throw new QueryEngineError(
      "Polymorphic storage assignments require one record."
    );
  }
  const group = groups[0]!;
  return { columns: group.columns, values: group.values };
}

function lowerPolymorphicStorage(
  ctx: QueryScope,
  values: readonly PolymorphicStorageValue<unknown>[]
): { readonly columns: string[]; readonly values: Sql[] } {
  const members = polymorphicStorageMembers(ctx, values);
  const columns: string[] = [];
  const sqlValues: Sql[] = [];
  for (const { column, value } of members) {
    columns.push(column.name);
    sqlValues.push(
      buildScalarSqlValueForScalar(ctx, column.scalar, column.name, value)
    );
  }
  return { columns, values: sqlValues };
}

/** Build independently executable VALUES groups for heterogeneous rows. */
export function buildValueGroups(
  ctx: QueryScope,
  records: readonly Record<string, unknown>[],
  polymorphicStorage: readonly PolymorphicStorageValue<unknown>[] = []
): ValuesGroup[] {
  if (records.length === 0) {
    return [];
  }

  assertApplicationGeneratedValues(ctx, records);
  const fieldOrder = ctx.model["~"].scalarFieldNames;
  const shapes = planInsertRowShapes(fieldOrder, records, (field, value) =>
    shouldOmitInsertValue(ctx.model["~"].state.scalars[field], value)
  );
  const privateValues =
    polymorphicStorage.length > 0
      ? lowerPolymorphicStorage(ctx, polymorphicStorage)
      : undefined;

  return shapes.map((shape) => ({
    columns: [
      ...shape.fields.map((field) => getColumnName(ctx.model, field)),
      ...(privateValues?.columns ?? []),
    ],
    inputIndexes: [...shape.inputIndexes],
    values: shape.rows.map((record) => [
      ...shape.fields.map((field) =>
        buildScalarSqlValue(ctx, ctx.model, field, record[field])
      ),
      ...(privateValues?.values ?? []),
    ]),
  }));
}

/** Group bulk rows whose private polymorphic assignments can differ per row. */
export function buildValueGroupsWithRowStorage(
  ctx: QueryScope,
  records: readonly Record<string, unknown>[],
  storageByRow: readonly (readonly PolymorphicStorageValue<unknown>[])[]
): ValuesGroup[] {
  if (records.length === 0) return [];
  assertApplicationGeneratedValues(ctx, records);
  const fieldOrder = ctx.model["~"].scalarFieldNames;
  const groups: ValuesGroup[] = [];
  let activeGroup: ValuesGroup | undefined;
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]!;
    const columns: string[] = [];
    const values: Sql[] = [];
    for (const field of fieldOrder) {
      if (
        shouldOmitInsertValue(
          ctx.model["~"].state.scalars[field],
          record[field]
        )
      ) {
        continue;
      }
      columns.push(getColumnName(ctx.model, field));
      values.push(buildScalarSqlValue(ctx, ctx.model, field, record[field]));
    }
    const rowStorage = storageByRow[index];
    if (rowStorage && rowStorage.length > 0) {
      const privateValues = lowerPolymorphicStorage(ctx, rowStorage);
      for (const column of privateValues.columns) columns.push(column);
      for (const value of privateValues.values) values.push(value);
    }
    if (activeGroup) {
      let hasSameColumns = activeGroup.columns.length === columns.length;
      for (
        let columnIndex = 0;
        hasSameColumns && columnIndex < activeGroup.columns.length;
        columnIndex += 1
      ) {
        hasSameColumns =
          activeGroup.columns[columnIndex] === columns[columnIndex];
      }
      if (hasSameColumns) {
        activeGroup.values.push(values);
        activeGroup.inputIndexes.push(index);
        continue;
      }
    }
    activeGroup = { columns, values: [values], inputIndexes: [index] };
    groups.push(activeGroup);
  }
  return groups;
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
 * Lower a JSON null sentinel to the value it names. This is the ONE place the
 * two nulls of a JSON column part ways in write position:
 *
 *   - `DbNull`   -> SQL NULL: the column holds no document.
 *   - `JsonNull` -> the JSON document `null`, serialized like any other
 *     document, so PG stores `'null'::jsonb`, MySQL a JSON null, and SQLite
 *     the canonical text `null` — the three spellings the filter side
 *     compares against.
 *
 * `AnyNull` is filter-only and the validation layer refuses it in write
 * position by name (see {@link file://../../validation/primitives/json-null.ts});
 * the throw here is the fail-closed backstop for an untyped caller reaching
 * the builder directly, not a second validation pass.
 */
function jsonNullWriteValue(
  ctx: QueryScope,
  fieldName: string,
  kind: JsonNullKind
): Sql {
  switch (kind) {
    case "DbNull":
      return ctx.adapter.literals.null();
    case "JsonNull":
      return ctx.adapter.literals.json(null);
    default:
      throw new QueryEngineError(
        `AnyNull matches both nulls, so it cannot be written to field '${fieldName}'. Use DbNull for the database NULL or JsonNull for the JSON value null.`
      );
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
  const field = model["~"].state.scalars[fieldName];
  return buildScalarSqlValueForScalar(ctx, field, fieldName, value);
}

/** Lower a value against an explicit destination scalar, including private columns. */
export function buildScalarSqlValueForScalar(
  ctx: QueryScope,
  field: Scalar | undefined,
  fieldName: string,
  value: unknown
): Sql {
  if (value === undefined || value === null) {
    return ctx.adapter.literals.null();
  }

  const sentinel = jsonNullKindOf(value);
  if (sentinel) {
    return jsonNullWriteValue(ctx, fieldName, sentinel);
  }

  if (isSql(value)) {
    // Pass through Sql values directly (e.g., subqueries from connect)
    return value;
  }

  // Get scalar type if available
  const scalarState = field?.["~"]?.state;
  const scalarType = scalarState?.type;

  // List scalars take the whole array in the dialect's storage format
  // (native array on PG, JSON on MySQL/SQLite)
  if (scalarState?.array && Array.isArray(value)) {
    return ctx.adapter.arrays.value(value);
  }

  // JSON scalars always store serialized JSON — primitives included — so every
  // dialect receives valid JSON text (a bare 'hello' is not valid JSON on PG)
  if (scalarType === "json") {
    return ctx.adapter.literals.json(value);
  }

  // Datetime ISO strings need dialect-specific serialization (MySQL rejects 'Z')
  if (scalarType === "datetime" && typeof value === "string") {
    return ctx.adapter.literals.dateTime(value);
  }

  if (scalarType === "decimal") {
    return decimalLiteral(ctx.adapter, fieldName, value);
  }

  return ctx.adapter.literals.value(value);
}

/**
 * Bind a decimal through the dialect's exact-decimal path.
 *
 * The value has already been canonicalized by the decimal schema on the way in;
 * canonicalizing again here is cheap and closes the paths that reach a binding
 * without one (a `set` inside an atomic update object, a connect-derived FK,
 * a relation-correlated FK lowered by `referenceSql`). A value that cannot be
 * canonicalized is a bug upstream, not a value to bind — binding it would hand
 * the database a float spelling for an exact column.
 *
 * This takes the ADAPTER rather than a `QueryScope` because the FK lowering in
 * `write-engine/fragment-builders.ts` reaches it holding the destination
 * model, not the destination scope, and every decimal binding in the codebase
 * has to be this one function or the two spellings drift apart — which is
 * exactly how a decimal relation key came to be written two different ways in
 * one statement pair.
 */
export function decimalLiteral(
  adapter: DatabaseAdapter,
  fieldName: string,
  value: unknown
): Sql {
  const canonical = canonicalizeDecimal(value);
  if (canonical === undefined) {
    throw new QueryEngineError(
      `Decimal field '${fieldName}' received a value that is not an exact decimal.`
    );
  }
  return adapter.literals.decimal(canonical);
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
  const sentinel = jsonNullKindOf(value);
  if (sentinel) {
    return jsonNullWriteValue(ctx, fieldName, sentinel);
  }
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
  if (state?.type === "decimal" && value !== null && value !== undefined) {
    return decimalLiteral(ctx.adapter, fieldName, value);
  }
  return ctx.adapter.literals.value(value);
}

/** The declared scalar type of a model field, or `undefined` when the model does
 *  not declare `fieldName` as a scalar. One accessor, so the two questions the
 *  write-side lowering asks about a destination column ("which cast?", "which
 *  literal spelling?") read the same state. */
export function getScalarType(
  model: Model<any>,
  fieldName: string
): string | undefined {
  return model["~"].state.scalars[fieldName]?.["~"].state.type;
}

export function getScalarTypeForScalar(
  scalar: Scalar | undefined
): string | undefined {
  return scalar?.["~"].state.type;
}

/**
 * The cast a value must wear to land in this field's column domain.
 *
 * `decimal` is deliberately NOT `numeric`: `numeric` is the float cast, and on
 * two of three dialects it destroys an exact decimal (SQLite NUMERIC affinity
 * rounds the canonical spelling into a double; MySQL's bare `DECIMAL` is
 * `DECIMAL(10,0)` and rounds away every fraction). See {@link CastType}.
 *
 * A TEMPORAL column (`date`/`datetime`/`time`) wears NO cast. It used to answer
 * `text`, which names a domain no dialect's temporal column has: the DDL emits
 * `timestamptz`/`date`/`time` on PostgreSQL and `DATETIME(3)`/`DATE`/`TIME(3)`
 * on MySQL, and only SQLite stores the value as TEXT. Measured on PGlite and on
 * PostgreSQL 16.14: `SET "atRef" = CAST($1 AS TEXT)` against a `timestamptz`
 * column raises **42804** — `column "atRef" is of type timestamp with time zone
 * but expression is of type text`. An UNCAST bind takes its type from the
 * assignment target on all three dialects, which is exactly what every ordinary
 * temporal write already does: {@link buildScalarSqlValue} casts nothing.
 *
 * WHICH temporal value this serves, so it is not read as a second copy of the
 * `literals.dateTime` branch in `referenceSql`: only the DEFERRED one. A
 * CONCRETE temporal key never arrives at the cast — `referenceSql` spells it
 * through the adapter's `dateTime` literal and returns before this answer is
 * used. What is left here is the relation key whose value does not exist at
 * build time: a `Ref` into a located parent's captured column, which the
 * executor resolves and binds. Restore `text` for the temporal cases and the
 * witness that dies is the UPDATE root's `connect` — the parent is located, its
 * key is a `Ref`, and PostgreSQL 16.14 answers 42804 (falsified live, Docker and
 * PGlite, both substrates); every concrete-key witness stays green, because the
 * other branch already owns them.
 */
export function getScalarCastType(
  model: Model<any>,
  fieldName: string
): CastType | undefined {
  switch (getScalarType(model, fieldName)) {
    case "int":
    case "bigint":
      return "integer";
    case "float":
      return "numeric";
    case "decimal":
      return "decimal";
    case "boolean":
      return "boolean";
    case "string":
      return "text";
    default:
      return undefined;
  }
}

export function getScalarCastTypeForScalar(
  scalar: Scalar | undefined
): CastType | undefined {
  switch (getScalarTypeForScalar(scalar)) {
    case "int":
    case "bigint":
      return "integer";
    case "float":
      return "numeric";
    case "decimal":
      return "decimal";
    case "boolean":
      return "boolean";
    case "string":
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
  data: Record<string, unknown>,
  polymorphicStorage: readonly PolymorphicStorageValue<unknown>[] = []
): Sql {
  const { columns, values } = buildValues(ctx, data, polymorphicStorage);

  if (values.length === 0) {
    throw new QueryEngineError("No columns to insert");
  }

  const table = ctx.adapter.identifiers.escape(tableName);
  if (columns.length === 0) {
    return ctx.adapter.mutations.insertDefault(table);
  }
  return ctx.adapter.mutations.insert(table, columns, values);
}
