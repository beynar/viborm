import { Sql, sql } from "@sql";
import { DatabaseAdapter, QueryParts } from "../../database-adapter";
import { sqliteMigrations } from "./migrations";

/**
 * SQLite Database Adapter
 *
 * Implements the DatabaseAdapter interface for SQLite-specific SQL generation.
 *
 * Key SQLite features:
 * - Double-quote identifier escaping: "table"."column"
 * - No native ARRAY type - uses JSON for arrays
 * - LIKE is case-insensitive for ASCII by default
 * - json_object(), json_group_array() for JSON operations (SQLite 3.38+)
 * - RETURNING clause supported (SQLite 3.35+)
 * - No NULLS FIRST/LAST ordering
 * - ON CONFLICT DO UPDATE/NOTHING (same as PostgreSQL)
 * - || for string concatenation
 * - Boolean stored as 0/1 integers
 */
export class SQLiteAdapter implements DatabaseAdapter {
  // ============================================================
  // RAW
  // ============================================================

  raw = (sqlString: string): Sql => sql.raw`${sqlString}`;

  // ============================================================
  // IDENTIFIERS
  // ============================================================

  identifiers = {
    escape: (name: string): Sql => sql.raw`"${name}"`,

    column: (alias: string, field: string): Sql =>
      alias ? sql.raw`"${alias}"."${field}"` : sql.raw`"${field}"`,

    table: (tableName: string, alias: string): Sql =>
      sql.raw`"${tableName}" AS "${alias}"`,

    aliased: (expression: Sql, alias: string): Sql =>
      sql`${expression} AS ${sql.raw`"${alias}"`}`,
  };

  // ============================================================
  // LITERALS
  // ============================================================

  literals = {
    value: (v: unknown): Sql => sql`${v}`,

    null: (): Sql => sql.raw`NULL`,

    // SQLite uses 1/0 for booleans
    true: (): Sql => sql.raw`1`,

    false: (): Sql => sql.raw`0`,

    list: (values: Sql[]): Sql => {
      if (values.length === 0) return sql.raw`()`;
      return sql`(${sql.join(values, ", ")})`;
    },

    // SQLite requires JSON values to be stringified
    json: (v: unknown): Sql => sql`${JSON.stringify(v)}`,
  };

  // ============================================================
  // OPERATORS
  // ============================================================

  operators = {
    // Comparison
    eq: (left: Sql, right: Sql): Sql => sql`${left} = ${right}`,
    neq: (left: Sql, right: Sql): Sql => sql`${left} <> ${right}`,
    lt: (left: Sql, right: Sql): Sql => sql`${left} < ${right}`,
    lte: (left: Sql, right: Sql): Sql => sql`${left} <= ${right}`,
    gt: (left: Sql, right: Sql): Sql => sql`${left} > ${right}`,
    gte: (left: Sql, right: Sql): Sql => sql`${left} >= ${right}`,

    // Pattern matching
    like: (column: Sql, pattern: Sql): Sql => sql`${column} LIKE ${pattern}`,
    notLike: (column: Sql, pattern: Sql): Sql =>
      sql`${column} NOT LIKE ${pattern}`,
    // SQLite LIKE is case-insensitive for ASCII by default
    // Use COLLATE NOCASE for explicit case-insensitivity
    ilike: (column: Sql, pattern: Sql): Sql =>
      sql`${column} LIKE ${pattern} COLLATE NOCASE`,
    notIlike: (column: Sql, pattern: Sql): Sql =>
      sql`${column} NOT LIKE ${pattern} COLLATE NOCASE`,

    // Set membership
    in: (column: Sql, values: Sql): Sql => sql`${column} IN ${values}`,
    notIn: (column: Sql, values: Sql): Sql => sql`${column} NOT IN ${values}`,

    // Null checks
    isNull: (expr: Sql): Sql => sql`${expr} IS NULL`,
    isNotNull: (expr: Sql): Sql => sql`${expr} IS NOT NULL`,

    // Range
    between: (column: Sql, min: Sql, max: Sql): Sql =>
      sql`${column} BETWEEN ${min} AND ${max}`,
    notBetween: (column: Sql, min: Sql, max: Sql): Sql =>
      sql`${column} NOT BETWEEN ${min} AND ${max}`,

    // Logical
    and: (...conditions: Sql[]): Sql => {
      if (conditions.length === 0) return sql.raw`1`;
      if (conditions.length === 1) return conditions[0]!;
      return sql`(${sql.join(conditions, " AND ")})`;
    },

    or: (...conditions: Sql[]): Sql => {
      if (conditions.length === 0) return sql.raw`0`;
      if (conditions.length === 1) return conditions[0]!;
      return sql`(${sql.join(conditions, " OR ")})`;
    },

    not: (condition: Sql): Sql => sql`NOT (${condition})`,

    // Subquery existence
    exists: (subquery: Sql): Sql => sql`EXISTS (${subquery})`,
    notExists: (subquery: Sql): Sql => sql`NOT EXISTS (${subquery})`,
  };

  // ============================================================
  // EXPRESSIONS
  // ============================================================

  expressions = {
    // Arithmetic
    add: (left: Sql, right: Sql): Sql => sql`(${left} + ${right})`,
    subtract: (left: Sql, right: Sql): Sql => sql`(${left} - ${right})`,
    multiply: (left: Sql, right: Sql): Sql => sql`(${left} * ${right})`,
    divide: (left: Sql, right: Sql): Sql => sql`(${left} / ${right})`,

    // String operations - SQLite uses || for concatenation
    concat: (...parts: Sql[]): Sql => {
      if (parts.length === 0) return sql.raw`''`;
      if (parts.length === 1) return parts[0]!;
      return sql`(${sql.join(parts, " || ")})`;
    },
    upper: (expr: Sql): Sql => sql`UPPER(${expr})`,
    lower: (expr: Sql): Sql => sql`LOWER(${expr})`,

    // Utility
    coalesce: (...exprs: Sql[]): Sql => sql`COALESCE(${sql.join(exprs, ", ")})`,
    greatest: (...exprs: Sql[]): Sql => sql`MAX(${sql.join(exprs, ", ")})`,
    least: (...exprs: Sql[]): Sql => sql`MIN(${sql.join(exprs, ", ")})`,
    cast: (expr: Sql, type: string): Sql =>
      sql`CAST(${expr} AS ${sql.raw`${type}`})`,
  };

  // ============================================================
  // AGGREGATES
  // ============================================================

  aggregates = {
    count: (expr?: Sql): Sql =>
      expr ? sql`COUNT(${expr})` : sql.raw`COUNT(*)`,
    countDistinct: (expr: Sql): Sql => sql`COUNT(DISTINCT ${expr})`,
    sum: (expr: Sql): Sql => sql`SUM(${expr})`,
    avg: (expr: Sql): Sql => sql`AVG(${expr})`,
    min: (expr: Sql): Sql => sql`MIN(${expr})`,
    max: (expr: Sql): Sql => sql`MAX(${expr})`,
  };

  // ============================================================
  // JSON (SQLite 3.38+ JSON functions)
  // ============================================================

  json = {
    object: (pairs: [string, Sql][]): Sql => {
      if (pairs.length === 0) return sql.raw`json_object()`;
      const args = pairs.flatMap(([key, value]) => [sql`${key}`, value]);
      return sql`json_object(${sql.join(args, ", ")})`;
    },

    array: (items: Sql[]): Sql => {
      if (items.length === 0) return sql.raw`json_array()`;
      return sql`json_array(${sql.join(items, ", ")})`;
    },

    emptyArray: (): Sql => sql.raw`json_array()`,

    agg: (expr: Sql): Sql =>
      sql`COALESCE(json_group_array(${expr}), json_array())`,

    rowToJson: (alias: string): Sql => {
      // SQLite doesn't have row_to_json - would need to build manually
      // This is a placeholder that returns the alias as a reference
      return sql`json_object(${sql.raw`'row', "${alias}".*`})`;
    },

    objectFromColumns: (columns: [string, Sql][]): Sql => {
      if (columns.length === 0) return sql.raw`json_object()`;
      const args = columns.flatMap(([key, value]) => [sql`${key}`, value]);
      return sql`json_object(${sql.join(args, ", ")})`;
    },

    extract: (column: Sql, path: string[]): Sql => {
      if (path.length === 0) return column;
      const jsonPath = "$." + path.join(".");
      return sql`json_extract(${column}, ${jsonPath})`;
    },

    extractText: (column: Sql, path: string[]): Sql => {
      // SQLite json_extract returns the value in native form
      // For text, we can cast or use as-is
      if (path.length === 0) return column;
      const jsonPath = "$." + path.join(".");
      return sql`json_extract(${column}, ${jsonPath})`;
    },
  };

  // ============================================================
  // ARRAYS (JSON-based for SQLite)
  // ============================================================

  arrays = {
    // SQLite uses JSON arrays
    literal: (items: Sql[]): Sql => {
      if (items.length === 0) return sql.raw`json_array()`;
      return sql`json_array(${sql.join(items, ", ")})`;
    },

    // Check if value exists in JSON array using json_each
    has: (column: Sql, value: Sql): Sql =>
      sql`EXISTS (SELECT 1 FROM json_each(${column}) WHERE value = ${value})`,

    hasEvery: (column: Sql, values: Sql): Sql =>
      sql`(SELECT COUNT(*) FROM json_each(${values}) WHERE value IN (SELECT value FROM json_each(${column}))) = json_array_length(${values})`,

    hasSome: (column: Sql, values: Sql): Sql =>
      sql`EXISTS (SELECT 1 FROM json_each(${column}) AS a, json_each(${values}) AS b WHERE a.value = b.value)`,

    isEmpty: (column: Sql): Sql =>
      sql`(json_array_length(${column}) = 0 OR ${column} IS NULL)`,

    length: (column: Sql): Sql => sql`json_array_length(${column})`,

    get: (column: Sql, index: Sql): Sql =>
      sql`json_extract(${column}, '$[' || ${index} || ']')`,

    push: (column: Sql, value: Sql): Sql =>
      sql`json_insert(${column}, '$[#]', ${value})`,

    set: (column: Sql, index: Sql, value: Sql): Sql =>
      sql`json_set(${column}, '$[' || ${index} || ']', ${value})`,
  };

  // ============================================================
  // ORDER BY
  // ============================================================

  orderBy = {
    asc: (column: Sql): Sql => sql`${column} ASC`,
    desc: (column: Sql): Sql => sql`${column} DESC`,
    // SQLite doesn't support NULLS FIRST/LAST natively
    nullsFirst: (expr: Sql): Sql => expr, // No-op
    nullsLast: (expr: Sql): Sql => expr, // No-op
  };

  // ============================================================
  // CLAUSES
  // ============================================================

  clauses = {
    select: (columns: Sql): Sql => sql`SELECT ${columns}`,
    selectDistinct: (columns: Sql): Sql => sql`SELECT DISTINCT ${columns}`,
    from: (table: Sql): Sql => sql`FROM ${table}`,
    where: (condition: Sql): Sql => sql`WHERE ${condition}`,
    orderBy: (orders: Sql): Sql => sql`ORDER BY ${orders}`,
    limit: (count: Sql): Sql => sql`LIMIT ${count}`,
    offset: (count: Sql): Sql => sql`OFFSET ${count}`,
    groupBy: (columns: Sql): Sql => sql`GROUP BY ${columns}`,
    having: (condition: Sql): Sql => sql`HAVING ${condition}`,
  };

  // ============================================================
  // SET (UPDATE operations)
  // ============================================================

  set = {
    assign: (column: Sql, value: Sql): Sql => sql`${column} = ${value}`,

    increment: (column: Sql, by: Sql): Sql =>
      sql`${column} = ${column} + ${by}`,

    decrement: (column: Sql, by: Sql): Sql =>
      sql`${column} = ${column} - ${by}`,

    multiply: (column: Sql, by: Sql): Sql => sql`${column} = ${column} * ${by}`,

    divide: (column: Sql, by: Sql): Sql => sql`${column} = ${column} / ${by}`,

    push: (column: Sql, value: Sql): Sql =>
      sql`${column} = json_insert(${column}, '$[#]', ${value})`,

    unshift: (column: Sql, value: Sql): Sql =>
      sql`${column} = json('[' || json(${value}) || CASE WHEN COALESCE(${column}, '[]') = '[]' THEN ']' ELSE ',' || substr(${column}, 2) END)`,
  };

  // ============================================================
  // FILTERS (Relation subquery wrappers)
  // ============================================================

  filters = {
    some: (subquery: Sql): Sql => sql`EXISTS (${subquery})`,
    every: (subquery: Sql): Sql => sql`NOT EXISTS (${subquery})`,
    none: (subquery: Sql): Sql => sql`NOT EXISTS (${subquery})`,
    is: (subquery: Sql): Sql => sql`EXISTS (${subquery})`,
    isNot: (subquery: Sql): Sql => sql`NOT EXISTS (${subquery})`,
  };

  // ============================================================
  // SUBQUERIES
  // ============================================================

  subqueries = {
    scalar: (query: Sql): Sql => sql`(${query})`,

    correlate: (query: Sql, alias: string): Sql =>
      sql`(${query}) AS ${sql.raw`"${alias}"`}`,

    existsCheck: (from: Sql, where: Sql): Sql =>
      sql`SELECT 1 FROM ${from} WHERE ${where}`,
  };

  // ============================================================
  // ASSEMBLE (Build complete SQL statements)
  // ============================================================

  assemble = {
    select: (parts: QueryParts): Sql => {
      // SQLite doesn't support DISTINCT ON natively
      // Simulate using ROW_NUMBER() OVER (PARTITION BY ... ORDER BY ...)
      if (parts.distinct) {
        return this.assembleDistinctOn(parts);
      }

      const fragments: Sql[] = [
        sql`SELECT ${parts.columns}`,
        sql`FROM ${parts.from}`,
      ];

      if (parts.joins && parts.joins.length > 0) {
        fragments.push(...parts.joins);
      }

      if (parts.where) {
        fragments.push(sql`WHERE ${parts.where}`);
      }

      if (parts.groupBy) {
        fragments.push(sql`GROUP BY ${parts.groupBy}`);
      }

      if (parts.having) {
        fragments.push(sql`HAVING ${parts.having}`);
      }

      if (parts.orderBy) {
        fragments.push(sql`ORDER BY ${parts.orderBy}`);
      }

      if (parts.limit) {
        fragments.push(sql`LIMIT ${parts.limit}`);
      }

      if (parts.offset) {
        fragments.push(sql`OFFSET ${parts.offset}`);
      }

      return sql.join(fragments, " ");
    },
  };

  /**
   * Simulate DISTINCT ON using ROW_NUMBER() window function.
   *
   * Generates:
   * SELECT col1, col2, ... FROM (
   *   SELECT columns, ROW_NUMBER() OVER (PARTITION BY distinct_cols ORDER BY order_cols) AS _rn
   *   FROM table
   *   WHERE ...
   * ) AS _distinct_subquery
   * WHERE _rn = 1
   * ORDER BY ...
   * LIMIT ... OFFSET ...
   */
  private assembleDistinctOn(parts: QueryParts): Sql {
    // Build the ORDER BY for ROW_NUMBER() - use provided orderBy or default to distinct columns
    const rowNumberOrder = parts.orderBy || parts.distinct!;

    // Inner query with ROW_NUMBER()
    const innerFragments: Sql[] = [
      sql`SELECT ${parts.columns}, ROW_NUMBER() OVER (PARTITION BY ${parts.distinct} ORDER BY ${rowNumberOrder}) AS "_rn"`,
      sql`FROM ${parts.from}`,
    ];

    if (parts.joins && parts.joins.length > 0) {
      innerFragments.push(...parts.joins);
    }

    if (parts.where) {
      innerFragments.push(sql`WHERE ${parts.where}`);
    }

    if (parts.groupBy) {
      innerFragments.push(sql`GROUP BY ${parts.groupBy}`);
    }

    if (parts.having) {
      innerFragments.push(sql`HAVING ${parts.having}`);
    }

    const innerQuery = sql.join(innerFragments, " ");

    // Build outer SELECT - use explicit column aliases to exclude _rn
    let outerSelect: Sql;
    if (parts.distinctColumnAliases && parts.distinctColumnAliases.length > 0) {
      // Select only the original columns, excluding _rn
      const aliasColumns = parts.distinctColumnAliases.map(
        (alias) => sql.raw`"${alias}"`,
      );
      outerSelect = sql`SELECT ${sql.join(
        aliasColumns,
        ", ",
      )} FROM (${innerQuery}) AS "_distinct_subquery"`;
    } else {
      // Fallback to SELECT * (includes _rn)
      outerSelect = sql`SELECT * FROM (${innerQuery}) AS "_distinct_subquery"`;
    }

    // Outer query that filters for first row of each partition
    const outerFragments: Sql[] = [outerSelect, sql.raw`WHERE "_rn" = 1`];

    if (parts.orderBy) {
      outerFragments.push(sql`ORDER BY ${parts.orderBy}`);
    }

    if (parts.limit) {
      outerFragments.push(sql`LIMIT ${parts.limit}`);
    }

    if (parts.offset) {
      outerFragments.push(sql`OFFSET ${parts.offset}`);
    }

    return sql.join(outerFragments, " ");
  }

  // ============================================================
  // CTE (Common Table Expressions)
  // ============================================================

  cte = {
    with: (definitions: { name: string; query: Sql }[]): Sql => {
      const defs = definitions.map(
        ({ name, query }) => sql`${sql.raw`"${name}"`} AS (${query})`,
      );
      return sql`WITH ${sql.join(defs, ", ")}`;
    },

    recursive: (
      name: string,
      anchor: Sql,
      recursive: Sql,
      union: "all" | "distinct" = "all",
    ): Sql => {
      const unionKeyword =
        union === "all" ? sql.raw`UNION ALL` : sql.raw`UNION`;
      return sql`WITH RECURSIVE ${sql.raw`"${name}"`} AS (
        ${anchor}
        ${unionKeyword}
        ${recursive}
      )`;
    },
  };

  // ============================================================
  // MUTATIONS
  // ============================================================

  mutations = {
    insert: (table: Sql, columns: string[], values: Sql[][]): Sql => {
      const cols = columns.map((c) => sql.raw`"${c}"`);
      const rows = values.map((row) => sql`(${sql.join(row, ", ")})`);
      return sql`INSERT INTO ${table} (${sql.join(
        cols,
        ", ",
      )}) VALUES ${sql.join(rows, ", ")}`;
    },

    update: (table: Sql, sets: Sql, where?: Sql): Sql => {
      if (where) {
        return sql`UPDATE ${table} SET ${sets} WHERE ${where}`;
      }
      return sql`UPDATE ${table} SET ${sets}`;
    },

    delete: (table: Sql, where?: Sql): Sql => {
      if (where) {
        return sql`DELETE FROM ${table} WHERE ${where}`;
      }
      return sql`DELETE FROM ${table}`;
    },

    // SQLite 3.35+ supports RETURNING
    returning: (columns: Sql): Sql => sql`RETURNING ${columns}`,

    // SQLite uses same syntax as PostgreSQL for ON CONFLICT
    onConflict: (target: Sql | null, action: Sql): Sql => {
      if (target) {
        return sql`ON CONFLICT (${target}) DO ${action}`;
      }
      return sql`ON CONFLICT DO ${action}`;
    },
  };

  // ============================================================
  // JOINS
  // ============================================================

  joins = {
    inner: (table: Sql, condition: Sql): Sql =>
      sql`INNER JOIN ${table} ON ${condition}`,

    left: (table: Sql, condition: Sql): Sql =>
      sql`LEFT JOIN ${table} ON ${condition}`,

    // SQLite doesn't support RIGHT JOIN - use LEFT JOIN with tables swapped
    right: (table: Sql, condition: Sql): Sql =>
      sql`LEFT JOIN ${table} ON ${condition}`,

    // SQLite doesn't support FULL OUTER JOIN
    full: (table: Sql, condition: Sql): Sql =>
      sql`LEFT JOIN ${table} ON ${condition}`,

    cross: (table: Sql): Sql => sql`CROSS JOIN ${table}`,
  };

  // ============================================================
  // SET OPERATIONS
  // ============================================================

  setOperations = {
    union: (...queries: Sql[]): Sql => sql.join(queries, " UNION "),

    unionAll: (...queries: Sql[]): Sql => sql.join(queries, " UNION ALL "),

    intersect: (...queries: Sql[]): Sql => sql.join(queries, " INTERSECT "),

    except: (left: Sql, right: Sql): Sql => sql`${left} EXCEPT ${right}`,
  };

  // ============================================================
  // CAPABILITIES
  // ============================================================

  capabilities = {
    supportsReturning: true, // SQLite 3.35+
    supportsCteWithMutations: true,
    supportsFullOuterJoin: false,
  };

  lastInsertId = (): Sql => sql.raw`last_insert_rowid()`;

  // ============================================================
  // MIGRATIONS
  // ============================================================

  migrations = sqliteMigrations;
}

// Export singleton instance
export const sqliteAdapter = new SQLiteAdapter();
