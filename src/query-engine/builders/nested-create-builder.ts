/**
 * Nested Create Builder
 *
 * Builds multi-statement SQL for nested create operations.
 * Uses a unified approach that works across all databases.
 *
 * ID Handling:
 * - App-generated IDs (UUID, ULID): literal value is used directly
 * - Auto-increment IDs: uses lastval() / last_insert_rowid() / LAST_INSERT_ID()
 *
 * Example output with app-generated ID:
 *   INSERT INTO "Author" ("id", "name") VALUES ($1, $2);
 *   INSERT INTO "posts" ("id", "title", "authorId") VALUES ($3, $4, $1);
 *   SELECT ... FROM "Author" WHERE "id" = $1;
 *
 * Example output with auto-increment (PostgreSQL):
 *   INSERT INTO "Author" ("name") VALUES ($1);
 *   INSERT INTO "posts" ("id", "title", "authorId") VALUES ($2, $3, lastval());
 *   SELECT ... FROM "Author" WHERE "id" = lastval();
 */

import type { Model } from "@schema/model";
import { type Sql, sql } from "@sql";
import {
  createChildContext,
  getColumnName,
  getScalarFieldNames,
  getTableName,
} from "../context";
import type { QueryContext, RelationInfo } from "../types";
import { QueryEngineError } from "../types";
import { getPrimaryKeyField } from "./correlation-utils";
import {
  getFkDirection,
  type RelationMutation,
  separateData,
} from "./relation-data-builder";
import { buildValues } from "./values-builder";

// ============================================================
// TYPES
// ============================================================

/**
 * Result of building a nested create operation.
 * Always returns a single SQL with multiple statements joined by semicolons.
 */
export interface NestedCreateResult {
  /** The generated SQL (multiple statements joined by ';') */
  sql: Sql;
  /** Whether nested creates were processed */
  hasNestedCreates: boolean;
  /** Number of statements (for result extraction in MySQL) */
  statementCount: number;
}

/**
 * Info about a child create for aggregation in final SELECT
 */
interface ChildCreateInfo {
  relationName: string;
  relationInfo: RelationInfo;
  model: Model<any>;
  /** Number of child records created */
  count: number;
}

// ============================================================
// MAIN ENTRY POINT
// ============================================================

/**
 * Build a create operation that may include nested creates.
 *
 * Uses a unified multi-statement approach for all databases:
 * 1. INSERT parent record
 * 2. INSERT child records (using lastInsertId() or literal for FK)
 * 3. SELECT to return the created data
 *
 * @param ctx - Query context
 * @param data - Create data (may include nested creates)
 * @param select - Optional select
 * @param include - Optional include
 * @returns Result with SQL and metadata
 */
export function buildCreateWithNested(
  ctx: QueryContext,
  data: Record<string, unknown>,
  select?: Record<string, unknown>,
  include?: Record<string, unknown>
): NestedCreateResult {
  const { scalar, relations } = separateData(ctx, data);

  // Find nested creates (relations where create is specified)
  const nestedCreates = Object.entries(relations).filter(
    ([, mutation]) => mutation.create !== undefined
  );

  if (nestedCreates.length === 0) {
    // No nested creates - return simple INSERT with RETURNING
    return {
      sql: buildSimpleInsert(ctx, scalar, select, include),
      hasNestedCreates: false,
      statementCount: 1,
    };
  }

  // Build multi-statement nested create
  return buildMultiStatementCreate(ctx, scalar, nestedCreates, select, include);
}

// ============================================================
// SIMPLE INSERT (no nested creates)
// ============================================================

/**
 * Build a simple INSERT statement (no nested creates)
 */
function buildSimpleInsert(
  ctx: QueryContext,
  data: Record<string, unknown>,
  select?: Record<string, unknown>,
  include?: Record<string, unknown>
): Sql {
  const { adapter } = ctx;
  const tableName = getTableName(ctx.model);

  // Build VALUES
  const { columns, values } = buildValues(ctx, data);

  if (columns.length === 0) {
    throw new QueryEngineError("No data to insert");
  }

  // Build INSERT
  const table = adapter.identifiers.escape(tableName);
  const insertSql = adapter.mutations.insert(table, columns, values);

  // Build RETURNING (if supported)
  if (adapter.capabilities.supportsReturning) {
    const returningCols = buildReturningColumns(ctx, select, "");
    const returningSql = adapter.mutations.returning(returningCols);
    if (returningSql.strings.join("").trim() !== "") {
      return sql`${insertSql} ${returningSql}`;
    }
  }

  return insertSql;
}

/**
 * Build RETURNING columns for mutations
 */
function buildReturningColumns(
  ctx: QueryContext,
  select: Record<string, unknown> | undefined,
  alias: string
): Sql {
  const scalarFields = getScalarFieldNames(ctx.model);

  if (select) {
    // Select specific fields
    const columns = scalarFields
      .filter((field) => select[field] === true)
      .map((field) => {
        const columnName = getColumnName(ctx.model, field);
        return ctx.adapter.identifiers.aliased(
          alias
            ? ctx.adapter.identifiers.column(alias, columnName)
            : ctx.adapter.identifiers.escape(columnName),
          field
        );
      });

    if (columns.length === 0) {
      return buildAllScalarColumns(ctx, alias);
    }

    return sql.join(columns, ", ");
  }

  return buildAllScalarColumns(ctx, alias);
}

/**
 * Build all scalar columns for RETURNING
 */
function buildAllScalarColumns(ctx: QueryContext, alias: string): Sql {
  const scalarFields = getScalarFieldNames(ctx.model);
  const columns = scalarFields.map((field) => {
    const columnName = getColumnName(ctx.model, field);
    return ctx.adapter.identifiers.aliased(
      alias
        ? ctx.adapter.identifiers.column(alias, columnName)
        : ctx.adapter.identifiers.escape(columnName),
      field
    );
  });
  return sql.join(columns, ", ");
}

// ============================================================
// MULTI-STATEMENT NESTED CREATE
// ============================================================

/**
 * Build multi-statement nested create.
 *
 * Strategy:
 * 1. Determine creation order based on FK direction
 * 2. Build INSERT statements in dependency order
 * 3. Final SELECT to retrieve all data
 *
 * All statements are joined with ';' for multi-statement execution.
 */
function buildMultiStatementCreate(
  ctx: QueryContext,
  parentScalar: Record<string, unknown>,
  nestedCreates: [string, RelationMutation][],
  select?: Record<string, unknown>,
  include?: Record<string, unknown>
): NestedCreateResult {
  const { adapter } = ctx;
  const statements: Sql[] = [];
  const childCreateInfos: ChildCreateInfo[] = [];

  // Get parent's PK field and check if it's provided
  const parentPkField = getPrimaryKeyField(ctx.model);
  const providedPkValue = parentScalar[parentPkField];

  // Helper to get parent ID reference for child FKs
  const getParentIdRef = (): Sql => {
    if (providedPkValue !== undefined) {
      // App-generated ID (UUID, ULID) - use literal
      return adapter.literals.value(providedPkValue);
    }
    // Auto-increment - use lastInsertId()
    return adapter.lastInsertId();
  };

  // Analyze FK directions to determine creation order
  const childFirstCreates: [string, RelationMutation][] = [];
  const parentFirstCreates: [string, RelationMutation][] = [];

  for (const [relationName, mutation] of nestedCreates) {
    const fkDir = getFkDirection(ctx, mutation.relationInfo);

    if (fkDir.holdsFK) {
      // Parent holds FK - need to create child first, then parent with FK
      childFirstCreates.push([relationName, mutation]);
    } else {
      // Child holds FK - create parent first, then child with FK
      parentFirstCreates.push([relationName, mutation]);
    }
  }

  // ---- Handle child-first creates (parent holds FK) ----
  // These are rare (e.g., to-one where parent references child)
  // We need to INSERT child first, then reference its ID in parent
  const parentDataWithFks = { ...parentScalar };

  for (const [relationName, mutation] of childFirstCreates) {
    const childDataArray = Array.isArray(mutation.create)
      ? mutation.create
      : [mutation.create];
    const { targetModel } = mutation.relationInfo;
    const childCtx = createChildContext(ctx, targetModel, "");
    const childTableName = getTableName(targetModel);
    const childTable = adapter.identifiers.escape(childTableName);
    const fkDir = getFkDirection(ctx, mutation.relationInfo);

    // Insert child first
    for (let i = 0; i < childDataArray.length; i++) {
      const childData = childDataArray[i];
      if (!childData) continue;

      const { columns, values } = buildValues(
        childCtx,
        childData as Record<string, unknown>
      );
      statements.push(adapter.mutations.insert(childTable, columns, values));
    }

    // Set FK on parent to reference child (using lastInsertId of child)
    // This only works for single child creates; arrays would need special handling
    if (childDataArray.length === 1) {
      for (let i = 0; i < fkDir.fkFields.length; i++) {
        const fkField = fkDir.fkFields[i]!;
        // Check if child provided its own ID
        const childData = childDataArray[0] as Record<string, unknown>;
        const childPkField = getPrimaryKeyField(targetModel);
        const childPkValue = childData?.[childPkField];

        if (childPkValue !== undefined) {
          parentDataWithFks[fkField] = childPkValue;
        } else {
          parentDataWithFks[fkField] = adapter.lastInsertId();
        }
      }
    }

    childCreateInfos.push({
      relationName,
      relationInfo: mutation.relationInfo,
      model: targetModel,
      count: childDataArray.filter(Boolean).length,
    });
  }

  // ---- Insert parent ----
  const parentTableName = getTableName(ctx.model);
  const parentTable = adapter.identifiers.escape(parentTableName);
  const { columns: parentColumns, values: parentValues } = buildValues(
    ctx,
    parentDataWithFks
  );
  statements.push(
    adapter.mutations.insert(parentTable, parentColumns, parentValues)
  );

  // ---- Handle parent-first creates (child holds FK) ----
  // Most common case: child has FK to parent
  for (const [relationName, mutation] of parentFirstCreates) {
    const childDataArray = Array.isArray(mutation.create)
      ? mutation.create
      : [mutation.create];
    const { targetModel } = mutation.relationInfo;
    const childCtx = createChildContext(ctx, targetModel, "");
    const childTableName = getTableName(targetModel);
    const childTable = adapter.identifiers.escape(childTableName);
    const fkDir = getFkDirection(ctx, mutation.relationInfo);

    // Group all children of this relation into a single multi-row INSERT
    const allChildRows: Sql[][] = [];

    for (const childData of childDataArray) {
      if (!childData) continue;

      // Add FK to child data
      const childDataWithFk = { ...(childData as Record<string, unknown>) };
      const fkField = fkDir.fkFields[0]!;
      childDataWithFk[fkField] = getParentIdRef();

      const { columns, values } = buildValues(childCtx, childDataWithFk);

      // For multi-row INSERT, we need consistent columns
      // Just add each as a separate INSERT for simplicity
      // (Could optimize to single multi-row INSERT later)
      statements.push(adapter.mutations.insert(childTable, columns, values));
    }

    childCreateInfos.push({
      relationName,
      relationInfo: mutation.relationInfo,
      model: targetModel,
      count: childDataArray.filter(Boolean).length,
    });
  }

  // ---- Build final SELECT ----
  const finalSelect = buildFinalSelect(
    ctx,
    getParentIdRef(),
    childCreateInfos,
    select,
    include
  );
  statements.push(finalSelect);

  return {
    sql: sql.join(statements, "; "),
    hasNestedCreates: true,
    statementCount: statements.length,
  };
}

/**
 * Build the final SELECT statement that returns the created parent record
 * with relation counts or data if requested
 */
function buildFinalSelect(
  ctx: QueryContext,
  parentIdRef: Sql,
  childCreateInfos: ChildCreateInfo[],
  select?: Record<string, unknown>,
  include?: Record<string, unknown>
): Sql {
  const { adapter } = ctx;
  const tableName = getTableName(ctx.model);
  const parentTable = adapter.identifiers.escape(tableName);
  const parentPkField = getPrimaryKeyField(ctx.model);
  const parentPkColumn = getColumnName(ctx.model, parentPkField);

  // Build scalar columns
  const scalarFields = getScalarFieldNames(ctx.model);
  let columns: Sql[];

  if (select) {
    columns = scalarFields
      .filter((field) => select[field] === true)
      .map((field) => {
        const columnName = getColumnName(ctx.model, field);
        return adapter.identifiers.aliased(
          adapter.identifiers.escape(columnName),
          field
        );
      });

    if (columns.length === 0) {
      columns = scalarFields.map((field) => {
        const columnName = getColumnName(ctx.model, field);
        return adapter.identifiers.aliased(
          adapter.identifiers.escape(columnName),
          field
        );
      });
    }
  } else {
    columns = scalarFields.map((field) => {
      const columnName = getColumnName(ctx.model, field);
      return adapter.identifiers.aliased(
        adapter.identifiers.escape(columnName),
        field
      );
    });
  }

  // Check if relations should be included
  const requestedRelations = getRequestedRelations(select, include);

  // Add relation subqueries for included relations
  for (const childInfo of childCreateInfos) {
    const relationConfig = requestedRelations[childInfo.relationName];
    if (relationConfig) {
      const relationSubquery = buildRelationSubquery(
        ctx,
        childInfo,
        relationConfig,
        parentIdRef
      );
      columns.push(
        adapter.identifiers.aliased(relationSubquery, childInfo.relationName)
      );
    }
  }

  const columnsSql = sql.join(columns, ", ");
  const whereSql = sql`${adapter.identifiers.escape(
    parentPkColumn
  )} = ${parentIdRef}`;

  return sql.join([
    adapter.clauses.select(columnsSql),
    adapter.clauses.from(parentTable),
    adapter.clauses.where(whereSql),
  ], " ");
}

/**
 * Extract which relations are requested from select/include
 */
function getRequestedRelations(
  select?: Record<string, unknown>,
  include?: Record<string, unknown>
): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  if (select) {
    for (const [key, value] of Object.entries(select)) {
      if (value && typeof value === "object" && "select" in value) {
        result[key] = value;
      } else if (value === true) {
        result[key] = true;
      }
    }
  }

  if (include) {
    for (const [key, value] of Object.entries(include)) {
      if (value) {
        result[key] = value;
      }
    }
  }

  return result;
}

/**
 * Build a subquery to fetch the newly created related records
 */
function buildRelationSubquery(
  ctx: QueryContext,
  childInfo: ChildCreateInfo,
  config: unknown,
  parentIdRef: Sql
): Sql {
  const { adapter } = ctx;
  const { model, relationInfo } = childInfo;

  // Get the FK direction to know how to correlate
  const fkDir = getFkDirection(ctx, relationInfo);
  const childTableName = getTableName(model);
  const childTable = adapter.identifiers.escape(childTableName);
  const childAlias = "_child";

  // Get fields to select
  const childScalarFields = getScalarFieldNames(model);
  let fieldsToSelect: string[];

  if (typeof config === "object" && config !== null && "select" in config) {
    const selectConfig = (config as { select: Record<string, boolean> }).select;
    fieldsToSelect = childScalarFields.filter((f) => selectConfig[f] === true);
    if (fieldsToSelect.length === 0) {
      fieldsToSelect = childScalarFields;
    }
  } else {
    fieldsToSelect = childScalarFields;
  }

  // Build JSON object pairs
  const jsonPairs: [string, Sql][] = fieldsToSelect.map((field) => {
    const columnName = getColumnName(model, field);
    return [field, adapter.identifiers.column(childAlias, columnName)];
  });

  const jsonObj = adapter.json.object(jsonPairs);

  // Build correlation condition
  const fkField = fkDir.fkFields[0]!;
  const fkColumn = getColumnName(model, fkField);
  const correlation = sql`${adapter.identifiers.column(
    childAlias,
    fkColumn
  )} = ${parentIdRef}`;

  // Build subquery
  if (relationInfo.isToMany) {
    // Return array
    return sql`(SELECT COALESCE(${adapter.json.agg(
      jsonObj
    )}, ${adapter.json.emptyArray()}) FROM ${childTable} AS ${adapter.identifiers.escape(
      childAlias
    )} WHERE ${correlation})`;
  }
  // Return single object
  return sql`(SELECT ${jsonObj} FROM ${childTable} AS ${adapter.identifiers.escape(
    childAlias
  )} WHERE ${correlation} LIMIT 1)`;
}
