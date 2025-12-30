/**
 * Nested Create Builder
 *
 * Builds CTE-based SQL for nested create operations.
 * Allows creating parent and child records in a single SQL statement.
 *
 * Example output:
 * WITH "new_author" AS (
 *   INSERT INTO "Author" ("id", "name", "email")
 *   VALUES ($1, $2, $3)
 *   RETURNING *
 * )
 * INSERT INTO "posts" ("id", "title", "authorId")
 * SELECT $4, $5, "new_author"."id" FROM "new_author"
 * RETURNING ...
 */

import { sql, Sql } from "@sql";
import type { Model } from "@schema/model";
import type { QueryContext, RelationInfo } from "../types";
import { QueryEngineError } from "../types";
import {
  getTableName,
  getScalarFieldNames,
  getColumnName,
  createChildContext,
} from "../context";
import {
  separateData,
  RelationMutation,
  getFkDirection,
} from "./relation-data-builder";
import { buildValues } from "./values-builder";
import { getPrimaryKeyField } from "./correlation-utils";

// ============================================================
// TYPES
// ============================================================

/**
 * Result of building a nested create operation.
 *
 * For databases that support CTE with mutations (PostgreSQL, SQLite):
 *   - Returns a single SQL statement with CTEs
 *
 * For databases without CTE mutation support (MySQL):
 *   - Returns a batch of statements to execute sequentially
 */
interface NestedCreateResult {
  /** Strategy used: 'single' for CTE-based, 'batch' for sequential */
  strategy: "single" | "batch";
  /** The generated SQL (for single strategy) */
  sql: Sql;
  /** Batch of statements (for batch strategy - MySQL) */
  batch?: NestedCreateBatch;
  /** Whether nested creates were processed */
  hasNestedCreates: boolean;
}

/**
 * Batch of statements for databases that don't support CTE mutations.
 * The executor should run these in order within a transaction.
 */
export interface NestedCreateBatch {
  /** Parent INSERT statement */
  parentInsert: Sql;
  /** Primary key field name */
  parentPkField: string;
  /**
   * How to get the parent's PK after insert:
   * - 'auto': Use LAST_INSERT_ID() (for AUTO_INCREMENT)
   * - 'provided': PK is in the INSERT data (for UUID, ULID, etc.)
   */
  pkStrategy: "auto" | "provided";
  /** The provided PK value (when pkStrategy is 'provided') */
  providedPkValue?: unknown;
  /** Child INSERT statements */
  childInserts: {
    /** The SQL statement */
    sql: Sql;
    /** Field name where parent ID is set */
    fkField: string;
    /** Relation name for result mapping */
    relationName: string;
  }[];
  /** Final SELECT to retrieve the created data */
  finalSelect: Sql;
}

interface CteDefinition {
  name: string;
  query: Sql;
  model: Model<any>;
}

/**
 * Tracks child CTEs for a relation (for aggregating in final SELECT)
 */
interface RelationCteInfo {
  relationName: string;
  cteNames: string[];
  model: Model<any>;
  relationInfo: RelationInfo;
}

// ============================================================
// MAIN ENTRY POINT
// ============================================================

/**
 * Build a create operation that may include nested creates.
 *
 * For simple creates: returns standard INSERT
 * For nested creates with CTE support (PostgreSQL, SQLite): returns CTE-based multi-INSERT
 * For nested creates without CTE support (MySQL): returns batch of statements
 *
 * @param ctx - Query context
 * @param data - Create data (may include nested creates)
 * @param select - Optional select
 * @param include - Optional include
 * @returns Result with SQL and strategy info
 */
export function buildCreateWithNested(
  ctx: QueryContext,
  data: Record<string, unknown>,
  select?: Record<string, unknown>,
  include?: Record<string, unknown>
): NestedCreateResult {
  const { adapter } = ctx;
  const { scalar, relations } = separateData(ctx, data);

  // Find nested creates (relations where create is specified)
  const nestedCreates = Object.entries(relations).filter(
    ([, mutation]) => mutation.create !== undefined
  );

  if (nestedCreates.length === 0) {
    // No nested creates - return simple INSERT
    return {
      strategy: "single",
      sql: buildSimpleInsert(ctx, scalar, select, include),
      hasNestedCreates: false,
    };
  }

  // Check adapter capabilities
  if (adapter.capabilities.supportsCteWithMutations) {
    // PostgreSQL/SQLite: Use CTE-based approach
    return {
      strategy: "single",
      sql: buildCteNestedCreate(ctx, scalar, nestedCreates, select, include),
      hasNestedCreates: true,
    };
  } else {
    // MySQL: Use batch approach (multiple statements)
    return {
      strategy: "batch",
      sql: sql.empty, // Not used for batch strategy
      batch: buildBatchNestedCreate(
        ctx,
        scalar,
        nestedCreates,
        select,
        include
      ),
      hasNestedCreates: true,
    };
  }
}

// ============================================================
// SIMPLE INSERT
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
  const { adapter, rootAlias } = ctx;
  const tableName = getTableName(ctx.model);

  // Build VALUES
  const { columns, values } = buildValues(ctx, data);

  if (columns.length === 0) {
    throw new QueryEngineError("No data to insert");
  }

  // Build INSERT
  const table = adapter.identifiers.escape(tableName);
  const insertSql = adapter.mutations.insert(table, columns, values);

  // Build RETURNING (use empty alias for mutations)
  const returningCols = buildReturningColumns(ctx, select, include, "");
  const returningSql = adapter.mutations.returning(returningCols);

  if (returningSql.strings.join("").trim() === "") {
    return insertSql;
  }

  return sql`${insertSql} ${returningSql}`;
}

/**
 * Build RETURNING columns for mutations
 */
function buildReturningColumns(
  ctx: QueryContext,
  select: Record<string, unknown> | undefined,
  include: Record<string, unknown> | undefined,
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
      // Fallback to all scalars
      return buildAllScalarColumns(ctx, alias);
    }

    return sql.join(columns, ", ");
  }

  // Default: return all scalar fields
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
// CTE-BASED NESTED CREATE
// ============================================================

/**
 * Build CTE-based nested create
 *
 * Strategy:
 * 1. Determine creation order based on FK direction
 * 2. Build CTEs for each INSERT in dependency order
 * 3. Final query selects from parent CTE with nested data (including newly created children)
 */
function buildCteNestedCreate(
  ctx: QueryContext,
  parentScalar: Record<string, unknown>,
  nestedCreates: [string, RelationMutation][],
  select?: Record<string, unknown>,
  include?: Record<string, unknown>
): Sql {
  const { adapter } = ctx;
  const cteDefinitions: CteDefinition[] = [];
  const parentCteName = "new_parent";

  // Track child CTEs by relation name for final SELECT
  const relationCtes: RelationCteInfo[] = [];

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

  // Process child-first creates (parent holds FK)
  // These need CTEs for the child, then parent references them
  let parentDataWithFks = { ...parentScalar };

  for (const [relationName, mutation] of childFirstCreates) {
    const childDataArray = Array.isArray(mutation.create)
      ? mutation.create
      : [mutation.create];
    const cteNames: string[] = [];

    for (let i = 0; i < childDataArray.length; i++) {
      const childData = childDataArray[i];
      if (!childData) continue;

      const childCteName =
        childDataArray.length === 1
          ? `new_${relationName}`
          : `new_${relationName}_${i}`;
      const childCte = buildChildFirstCte(
        ctx,
        mutation.relationInfo,
        childData as Record<string, unknown>,
        childCteName
      );
      cteDefinitions.push(childCte);
      cteNames.push(childCteName);
    }

    // Add FK reference from parent to first child CTE (for to-one relations)
    if (cteNames.length > 0) {
      const fkDir = getFkDirection(ctx, mutation.relationInfo);
      for (let i = 0; i < fkDir.fkFields.length; i++) {
        const fkField = fkDir.fkFields[i]!;
        const pkField = fkDir.pkFields[i]!;
        parentDataWithFks[fkField] = sql`(SELECT ${adapter.identifiers.escape(
          pkField
        )} FROM ${adapter.identifiers.escape(cteNames[0]!)})`;
      }

      relationCtes.push({
        relationName,
        cteNames,
        model: mutation.relationInfo.targetModel,
        relationInfo: mutation.relationInfo,
      });
    }
  }

  // Build parent CTE
  const parentCte = buildParentCte(ctx, parentDataWithFks, parentCteName);
  cteDefinitions.push(parentCte);

  // Process parent-first creates (child holds FK)
  // Build child INSERT statements that reference parent CTE
  for (const [relationName, mutation] of parentFirstCreates) {
    const childDataArray = Array.isArray(mutation.create)
      ? mutation.create
      : [mutation.create];
    const cteNames: string[] = [];

    for (let i = 0; i < childDataArray.length; i++) {
      const childData = childDataArray[i];
      if (!childData) continue;

      const childCteName = `new_${relationName}_${i}`;
      const childCte = buildParentFirstCte(
        ctx,
        mutation.relationInfo,
        childData as Record<string, unknown>,
        parentCteName,
        childCteName
      );
      cteDefinitions.push(childCte);
      cteNames.push(childCteName);
    }

    if (cteNames.length > 0) {
      relationCtes.push({
        relationName,
        cteNames,
        model: mutation.relationInfo.targetModel,
        relationInfo: mutation.relationInfo,
      });
    }
  }

  // Build the final WITH clause
  const withClause = adapter.cte.with(
    cteDefinitions.map((cte) => ({ name: cte.name, query: cte.query }))
  );

  // Build final SELECT from parent CTE (with nested relation data if requested)
  const finalSelect = buildFinalSelect(
    ctx,
    parentCteName,
    relationCtes,
    select,
    include
  );

  return sql`${withClause} ${finalSelect}`;
}

/**
 * Build CTE for child-first creation (when parent holds FK)
 * Creates the child record and parent will reference it
 */
function buildChildFirstCte(
  ctx: QueryContext,
  relationInfo: RelationInfo,
  childData: Record<string, unknown>,
  cteName: string
): CteDefinition {
  const { adapter } = ctx;
  const { targetModel } = relationInfo;

  const childCtx = createChildContext(ctx, targetModel, "");
  const tableName = getTableName(targetModel);

  // Build child INSERT
  const { columns, values } = buildValues(childCtx, childData);
  const table = adapter.identifiers.escape(tableName);
  const insertSql = adapter.mutations.insert(table, columns, values);

  // Add RETURNING *
  const query = sql`${insertSql} RETURNING *`;

  return { name: cteName, query, model: targetModel };
}

/**
 * Build CTE for parent record
 */
function buildParentCte(
  ctx: QueryContext,
  parentData: Record<string, unknown>,
  cteName: string
): CteDefinition {
  const { adapter } = ctx;
  const tableName = getTableName(ctx.model);

  // Build parent INSERT
  const { columns, values } = buildValues(ctx, parentData);
  const table = adapter.identifiers.escape(tableName);
  const insertSql = adapter.mutations.insert(table, columns, values);

  // Add RETURNING *
  const query = sql`${insertSql} RETURNING *`;

  return { name: cteName, query, model: ctx.model };
}

/**
 * Build CTE for parent-first creation (when child holds FK)
 * Creates the child record with FK referencing parent CTE
 */
function buildParentFirstCte(
  ctx: QueryContext,
  relationInfo: RelationInfo,
  childData: Record<string, unknown>,
  parentCteName: string,
  cteName: string
): CteDefinition {
  const { adapter } = ctx;
  const { targetModel } = relationInfo;
  const fkDir = getFkDirection(ctx, relationInfo);

  const childCtx = createChildContext(ctx, targetModel, "");
  const tableName = getTableName(targetModel);

  // Build child data with FK from parent CTE
  const childDataWithFk = { ...childData };

  // Add FK fields referencing parent CTE
  for (let i = 0; i < fkDir.fkFields.length; i++) {
    const fkField = fkDir.fkFields[i]!;
    const pkField = fkDir.pkFields[i]!;
    // Reference the parent CTE's PK
    childDataWithFk[fkField] = sql`(SELECT ${adapter.identifiers.escape(
      pkField
    )} FROM ${adapter.identifiers.escape(parentCteName)})`;
  }

  // Build child INSERT
  const { columns, values } = buildValues(childCtx, childDataWithFk);
  const table = adapter.identifiers.escape(tableName);
  const insertSql = adapter.mutations.insert(table, columns, values);

  // Add RETURNING *
  const query = sql`${insertSql} RETURNING *`;

  return { name: cteName, query, model: targetModel };
}

/**
 * Build the final SELECT statement that returns the created parent record
 * and optionally includes newly created child records
 */
function buildFinalSelect(
  ctx: QueryContext,
  parentCteName: string,
  relationCtes: RelationCteInfo[],
  select?: Record<string, unknown>,
  include?: Record<string, unknown>
): Sql {
  const { adapter } = ctx;
  const scalarFields = getScalarFieldNames(ctx.model);

  // Build scalar column selection
  let columns: Sql[];

  if (select) {
    columns = scalarFields
      .filter((field) => select[field] === true)
      .map((field) => {
        const columnName = getColumnName(ctx.model, field);
        return adapter.identifiers.aliased(
          adapter.identifiers.column(parentCteName, columnName),
          field
        );
      });

    if (columns.length === 0) {
      columns = scalarFields.map((field) => {
        const columnName = getColumnName(ctx.model, field);
        return adapter.identifiers.aliased(
          adapter.identifiers.column(parentCteName, columnName),
          field
        );
      });
    }
  } else {
    columns = scalarFields.map((field) => {
      const columnName = getColumnName(ctx.model, field);
      return adapter.identifiers.aliased(
        adapter.identifiers.column(parentCteName, columnName),
        field
      );
    });
  }

  // Check if any nested relations should be included in the result
  const requestedRelations = getRequestedRelations(select, include);

  // Add relation columns for newly created children
  for (const relCte of relationCtes) {
    const relationConfig = requestedRelations[relCte.relationName];
    if (relationConfig) {
      const relationColumn = buildRelationFromCtes(ctx, relCte, relationConfig);
      columns.push(
        adapter.identifiers.aliased(relationColumn, relCte.relationName)
      );
    }
  }

  const columnsSql = sql.join(columns, ", ");
  const fromTable = adapter.identifiers.escape(parentCteName);

  return sql`SELECT ${columnsSql} FROM ${fromTable}`;
}

/**
 * Extract which relations are requested from select/include
 */
function getRequestedRelations(
  select?: Record<string, unknown>,
  include?: Record<string, unknown>
): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  // From select: relation: true or relation: { select: ... }
  if (select) {
    for (const [key, value] of Object.entries(select)) {
      if (value && typeof value === "object" && "select" in value) {
        // Nested select on relation
        result[key] = value;
      } else if (value === true) {
        // Simple boolean select on relation (might be a relation)
        result[key] = true;
      }
    }
  }

  // From include: relation: true or relation: { ... }
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
 * Build a JSON aggregation column from child CTEs
 */
function buildRelationFromCtes(
  ctx: QueryContext,
  relCte: RelationCteInfo,
  config: unknown
): Sql {
  const { adapter } = ctx;
  const { cteNames, model, relationInfo } = relCte;

  // Get fields to select from the child model
  const childScalarFields = getScalarFieldNames(model);

  // Determine which fields to include
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

  // Build JSON object pairs for each field
  const jsonPairs: [string, Sql][] = fieldsToSelect.map((field) => {
    const columnName = getColumnName(model, field);
    return [field, adapter.identifiers.column("_cte", columnName)];
  });

  // Build the subquery that unions all child CTEs
  if (cteNames.length === 1) {
    // Single CTE - simple subquery
    const cteName = cteNames[0]!;
    const jsonObj = adapter.json.object(jsonPairs);

    // For to-one relations, return single object; for to-many, return array
    if (relationInfo.isToMany) {
      // json.agg already includes COALESCE with empty array fallback
      return sql`(SELECT ${adapter.json.agg(
        jsonObj
      )} FROM ${adapter.identifiers.escape(cteName)} AS "_cte")`;
    } else {
      return sql`(SELECT ${jsonObj} FROM ${adapter.identifiers.escape(
        cteName
      )} AS "_cte" LIMIT 1)`;
    }
  } else {
    // Multiple CTEs - union them together using adapter's setOperations
    const unionParts = cteNames.map(
      (cteName) => sql`SELECT * FROM ${adapter.identifiers.escape(cteName)}`
    );
    const unionQuery = adapter.setOperations.unionAll(...unionParts);
    const jsonObj = adapter.json.object(jsonPairs);

    // json.agg already includes COALESCE with empty array fallback
    return sql`(SELECT ${adapter.json.agg(
      jsonObj
    )} FROM (${unionQuery}) AS "_cte")`;
  }
}

// ============================================================
// BATCH STRATEGY (MySQL)
// ============================================================

/**
 * Build a batch of statements for MySQL nested creates.
 *
 * Since MySQL doesn't support CTEs with mutations, we generate:
 * 1. Parent INSERT statement
 * 2. Child INSERT statements with placeholder for parent ID
 * 3. Final SELECT to retrieve all data
 *
 * The executor runs these in a transaction, substituting LAST_INSERT_ID()
 * for the parent ID placeholder.
 */
function buildBatchNestedCreate(
  ctx: QueryContext,
  parentScalar: Record<string, unknown>,
  nestedCreates: [string, RelationMutation][],
  select?: Record<string, unknown>,
  include?: Record<string, unknown>
): NestedCreateBatch {
  const { adapter } = ctx;
  const tableName = getTableName(ctx.model);
  const parentPkField = getPrimaryKeyField(ctx.model);

  // 1. Build parent INSERT
  const { columns: parentColumns, values: parentValues } = buildValues(
    ctx,
    parentScalar
  );
  const parentTable = adapter.identifiers.escape(tableName);
  const parentInsert = adapter.mutations.insert(
    parentTable,
    parentColumns,
    parentValues
  );

  // Determine PK strategy: is the PK provided in the data or auto-generated?
  const providedPkValue = parentScalar[parentPkField];
  const pkStrategy = providedPkValue !== undefined ? "provided" : "auto";

  // Helper to get the FK value for child INSERTs
  const getFkValue = (): Sql => {
    if (pkStrategy === "provided") {
      // Use the provided PK value directly
      return adapter.literals.value(providedPkValue);
    } else {
      // Use LAST_INSERT_ID() for auto-increment
      return sql.raw`LAST_INSERT_ID()`;
    }
  };

  // 2. Build child INSERTs
  const childInserts: NestedCreateBatch["childInserts"] = [];

  for (const [relationName, mutation] of nestedCreates) {
    const fkDir = getFkDirection(ctx, mutation.relationInfo);

    // Only handle parent-first creates (child holds FK)
    // For child-first creates (parent holds FK), the parent INSERT already has the FK
    if (!fkDir.holdsFK) {
      const childDataArray = Array.isArray(mutation.create)
        ? mutation.create
        : [mutation.create];
      const { targetModel } = mutation.relationInfo;
      const childCtx = createChildContext(ctx, targetModel, "");
      const childTableName = getTableName(targetModel);
      const childTable = adapter.identifiers.escape(childTableName);

      for (const childData of childDataArray) {
        if (!childData) continue;

        // Build child data with the FK value
        const childDataWithFk = { ...(childData as Record<string, unknown>) };
        const fkField = fkDir.fkFields[0]!;

        // Set FK to either the provided PK value or LAST_INSERT_ID()
        childDataWithFk[fkField] = getFkValue();

        const { columns: childColumns, values: childValues } = buildValues(
          childCtx,
          childDataWithFk
        );
        const childSql = adapter.mutations.insert(
          childTable,
          childColumns,
          childValues
        );

        childInserts.push({
          sql: childSql,
          fkField,
          relationName,
        });
      }
    }
  }

  // 3. Build final SELECT to retrieve all created data
  // For MySQL, we need to query back the data since there's no RETURNING
  const parentPkColumn = getColumnName(ctx.model, parentPkField);
  const scalarFields = getScalarFieldNames(ctx.model);
  const selectCols = scalarFields.map((field) => {
    const columnName = getColumnName(ctx.model, field);
    return adapter.identifiers.aliased(
      adapter.identifiers.escape(columnName),
      field
    );
  });

  // Use provided PK or LAST_INSERT_ID() in final SELECT
  const pkCondition =
    pkStrategy === "provided"
      ? sql`${adapter.identifiers.escape(
          parentPkColumn
        )} = ${adapter.literals.value(providedPkValue)}`
      : sql`${adapter.identifiers.escape(parentPkColumn)} = LAST_INSERT_ID()`;

  const finalSelect = sql`SELECT ${sql.join(
    selectCols,
    ", "
  )} FROM ${parentTable} WHERE ${pkCondition}`;

  return {
    parentInsert,
    parentPkField,
    pkStrategy,
    providedPkValue: pkStrategy === "provided" ? providedPkValue : undefined,
    childInserts,
    finalSelect,
  };
}
