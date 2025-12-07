import { Sql, sql } from "@sql";
import { DatabaseAdapter, QueryParts } from "../../database-adapter";

/**
 * MySQL Database Adapter
 *
 * Implements the DatabaseAdapter interface for MySQL-specific SQL generation.
 *
 * Key MySQL features:
 * - Backtick identifier escaping: `table`.`column`
 * - No native ARRAY type - uses JSON for arrays
 * - LIKE is case-insensitive by default (with collation)
 * - JSON_OBJECT(), JSON_ARRAYAGG() for JSON operations
 * - No RETURNING clause (use LAST_INSERT_ID())
 * - No NULLS FIRST/LAST ordering
 * - ON DUPLICATE KEY UPDATE for upserts
 */
export class MySQLAdapter implements DatabaseAdapter {
  // ============================================================
  // RAW
  // ============================================================

  raw = (sqlString: string): Sql => sql.raw`${sqlString}`;

  // ============================================================
  // IDENTIFIERS
  // ============================================================

  identifiers = {
    escape: (name: string): Sql => sql.raw`\`${name}\``,

    column: (alias: string, field: string): Sql =>
      sql.raw`\`${alias}\`.\`${field}\``,

    table: (tableName: string, alias: string): Sql =>
      sql.raw`\`${tableName}\` AS \`${alias}\``,

    aliased: (expression: Sql, alias: string): Sql =>
      sql`${expression} AS ${sql.raw`\`${alias}\``}`,
  };

  // ============================================================
  // LITERALS
  // ============================================================

  literals = {
    value: (v: unknown): Sql => sql`${v}`,

    null: (): Sql => sql.raw`NULL`,

    true: (): Sql => sql.raw`TRUE`,

    false: (): Sql => sql.raw`FALSE`,

    list: (values: Sql[]): Sql => {
      if (values.length === 0) return sql.raw`()`;
      return sql`(${sql.join(values, ", ")})`;
    },

    // MySQL requires JSON values to be stringified
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
    // MySQL LIKE is case-insensitive by default with most collations
    // Use BINARY for case-sensitive, or COLLATE for explicit control
    ilike: (column: Sql, pattern: Sql): Sql =>
      sql`${column} LIKE ${pattern} COLLATE utf8mb4_unicode_ci`,
    notIlike: (column: Sql, pattern: Sql): Sql =>
      sql`${column} NOT LIKE ${pattern} COLLATE utf8mb4_unicode_ci`,

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
      if (conditions.length === 0) return sql.raw`TRUE`;
      if (conditions.length === 1) return conditions[0]!;
      return sql`(${sql.join(conditions, " AND ")})`;
    },

    or: (...conditions: Sql[]): Sql => {
      if (conditions.length === 0) return sql.raw`FALSE`;
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

    // String operations - MySQL uses CONCAT() function
    concat: (...parts: Sql[]): Sql => {
      if (parts.length === 0) return sql.raw`''`;
      if (parts.length === 1) return parts[0]!;
      return sql`CONCAT(${sql.join(parts, ", ")})`;
    },
    upper: (expr: Sql): Sql => sql`UPPER(${expr})`,
    lower: (expr: Sql): Sql => sql`LOWER(${expr})`,

    // Utility
    coalesce: (...exprs: Sql[]): Sql => sql`COALESCE(${sql.join(exprs, ", ")})`,
    greatest: (...exprs: Sql[]): Sql => sql`GREATEST(${sql.join(exprs, ", ")})`,
    least: (...exprs: Sql[]): Sql => sql`LEAST(${sql.join(exprs, ", ")})`,
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
  // JSON
  // ============================================================

  json = {
    object: (pairs: [string, Sql][]): Sql => {
      if (pairs.length === 0) return sql.raw`JSON_OBJECT()`;
      const args = pairs.flatMap(([key, value]) => [sql`${key}`, value]);
      return sql`JSON_OBJECT(${sql.join(args, ", ")})`;
    },

    array: (items: Sql[]): Sql => {
      if (items.length === 0) return sql.raw`JSON_ARRAY()`;
      return sql`JSON_ARRAY(${sql.join(items, ", ")})`;
    },

    agg: (expr: Sql): Sql =>
      sql`COALESCE(JSON_ARRAYAGG(${expr}), JSON_ARRAY())`,

    rowToJson: (alias: string): Sql => {
      // MySQL 8.0+ doesn't have row_to_json, we need to explicitly build object
      // This is a simplified version - real implementation would need column list
      return sql`JSON_OBJECT(${sql.raw`'*', \`${alias}\`.*`})`;
    },

    objectFromColumns: (columns: [string, Sql][]): Sql => {
      if (columns.length === 0) return sql.raw`JSON_OBJECT()`;
      const args = columns.flatMap(([key, value]) => [sql`${key}`, value]);
      return sql`JSON_OBJECT(${sql.join(args, ", ")})`;
    },

    extract: (column: Sql, path: string[]): Sql => {
      if (path.length === 0) return column;
      const jsonPath = "$." + path.join(".");
      return sql`JSON_EXTRACT(${column}, ${jsonPath})`;
    },

    extractText: (column: Sql, path: string[]): Sql => {
      if (path.length === 0) return column;
      const jsonPath = "$." + path.join(".");
      return sql`JSON_UNQUOTE(JSON_EXTRACT(${column}, ${jsonPath}))`;
    },
  };

  // ============================================================
  // ARRAYS (JSON-based for MySQL)
  // ============================================================

  arrays = {
    // MySQL uses JSON arrays
    literal: (items: Sql[]): Sql => {
      if (items.length === 0) return sql.raw`JSON_ARRAY()`;
      return sql`JSON_ARRAY(${sql.join(items, ", ")})`;
    },

    // Note: For proper type handling, the query engine should wrap string values
    // with CAST(value AS JSON) or use JSON_QUOTE for strings
    has: (column: Sql, value: Sql): Sql =>
      sql`JSON_CONTAINS(${column}, ${value})`,

    hasEvery: (column: Sql, values: Sql): Sql =>
      sql`JSON_CONTAINS(${column}, ${values})`,

    hasSome: (column: Sql, values: Sql): Sql =>
      sql`JSON_OVERLAPS(${column}, ${values})`,

    isEmpty: (column: Sql): Sql =>
      sql`(JSON_LENGTH(${column}) = 0 OR ${column} IS NULL)`,

    length: (column: Sql): Sql => sql`JSON_LENGTH(${column})`,

    get: (column: Sql, index: Sql): Sql =>
      sql`JSON_EXTRACT(${column}, CONCAT('$[', ${index}, ']'))`,

    push: (column: Sql, value: Sql): Sql =>
      sql`JSON_ARRAY_APPEND(${column}, '$', ${value})`,

    set: (column: Sql, index: Sql, value: Sql): Sql =>
      sql`JSON_SET(${column}, CONCAT('$[', ${index}, ']'), ${value})`,
  };

  // ============================================================
  // ORDER BY
  // ============================================================

  orderBy = {
    asc: (column: Sql): Sql => sql`${column} ASC`,
    desc: (column: Sql): Sql => sql`${column} DESC`,
    // MySQL doesn't support NULLS FIRST/LAST natively
    // Workaround: ORDER BY ISNULL(col), col
    nullsFirst: (expr: Sql): Sql => expr, // No-op, would need complex workaround
    nullsLast: (expr: Sql): Sql => expr, // No-op, would need complex workaround
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
      sql`${column} = JSON_ARRAY_APPEND(${column}, '$', ${value})`,

    unshift: (column: Sql, value: Sql): Sql =>
      sql`${column} = JSON_ARRAY_INSERT(${column}, '$[0]', ${value})`,
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
      sql`(${query}) AS ${sql.raw`\`${alias}\``}`,

    existsCheck: (from: Sql, where: Sql): Sql =>
      sql`SELECT 1 FROM ${from} WHERE ${where}`,
  };

  // ============================================================
  // ASSEMBLE (Build complete SQL statements)
  // ============================================================

  assemble = {
    select: (parts: QueryParts): Sql => {
      // MySQL doesn't support DISTINCT ON natively
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
      sql`SELECT ${parts.columns}, ROW_NUMBER() OVER (PARTITION BY ${parts.distinct} ORDER BY ${rowNumberOrder}) AS \`_rn\``,
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
        (alias) => sql.raw`\`${alias}\``
      );
      outerSelect = sql`SELECT ${sql.join(aliasColumns, ", ")} FROM (${innerQuery}) AS \`_distinct_subquery\``;
    } else {
      // Fallback to SELECT * (includes _rn)
      outerSelect = sql`SELECT * FROM (${innerQuery}) AS \`_distinct_subquery\``;
    }

    // Outer query that filters for first row of each partition
    const outerFragments: Sql[] = [
      outerSelect,
      sql.raw`WHERE \`_rn\` = 1`,
    ];

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
  // CTE (Common Table Expressions - MySQL 8.0+)
  // ============================================================

  cte = {
    with: (definitions: { name: string; query: Sql }[]): Sql => {
      const defs = definitions.map(
        ({ name, query }) => sql`${sql.raw`\`${name}\``} AS (${query})`
      );
      return sql`WITH ${sql.join(defs, ", ")}`;
    },

    recursive: (
      name: string,
      anchor: Sql,
      recursive: Sql,
      union: "all" | "distinct" = "all"
    ): Sql => {
      const unionKeyword =
        union === "all" ? sql.raw`UNION ALL` : sql.raw`UNION`;
      return sql`WITH RECURSIVE ${sql.raw`\`${name}\``} AS (
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
      const cols = columns.map((c) => sql.raw`\`${c}\``);
      const rows = values.map((row) => sql`(${sql.join(row, ", ")})`);
      return sql`INSERT INTO ${table} (${sql.join(
        cols,
        ", "
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

    // MySQL doesn't support RETURNING - returns empty
    // Use LAST_INSERT_ID() or SELECT after mutation
    returning: (_columns: Sql): Sql => sql.empty,

    // MySQL uses ON DUPLICATE KEY UPDATE syntax
    onConflict: (_target: Sql | null, action: Sql): Sql => {
      return sql`ON DUPLICATE KEY UPDATE ${action}`;
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

    right: (table: Sql, condition: Sql): Sql =>
      sql`RIGHT JOIN ${table} ON ${condition}`,

    // MySQL doesn't support FULL OUTER JOIN directly
    // Would need UNION of LEFT and RIGHT joins
    full: (table: Sql, condition: Sql): Sql =>
      sql`LEFT JOIN ${table} ON ${condition}`,

    cross: (table: Sql): Sql => sql`CROSS JOIN ${table}`,
  };
}

// Export singleton instance
export const mysqlAdapter = new MySQLAdapter();
