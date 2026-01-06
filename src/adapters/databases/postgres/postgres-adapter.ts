import { type Sql, sql } from "@sql";
import type { DatabaseAdapter, QueryParts } from "../../database-adapter";
import { postgresMigrations } from "./migrations";

/**
 * PostgreSQL Database Adapter
 *
 * Implements the DatabaseAdapter interface for PostgreSQL-specific SQL generation.
 *
 * Key PostgreSQL features:
 * - Double-quote identifier escaping: "table"."column"
 * - Native ARRAY type with operators: @>, &&, ANY()
 * - ILIKE for case-insensitive matching
 * - json_build_object(), json_agg() for JSON operations
 * - RETURNING clause for mutations
 * - NULLS FIRST/LAST ordering
 * - ON CONFLICT DO UPDATE/NOTHING
 */
export class PostgresAdapter implements DatabaseAdapter {
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

    true: (): Sql => sql.raw`TRUE`,

    false: (): Sql => sql.raw`FALSE`,

    list: (values: Sql[]): Sql => {
      if (values.length === 0) return sql.raw`()`;
      return sql`(${sql.join(values, ", ")})`;
    },

    // PostgreSQL handles JSON natively
    json: (v: unknown): Sql => sql`${v}`,
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
    ilike: (column: Sql, pattern: Sql): Sql => sql`${column} ILIKE ${pattern}`,
    notIlike: (column: Sql, pattern: Sql): Sql =>
      sql`${column} NOT ILIKE ${pattern}`,

    // Set membership
    in: (column: Sql, values: Sql): Sql => sql`${column} = ANY(${values})`,
    notIn: (column: Sql, values: Sql): Sql => sql`${column} <> ALL(${values})`,

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

    // String operations
    concat: (...parts: Sql[]): Sql => {
      if (parts.length === 0) return sql.raw`''`;
      if (parts.length === 1) return parts[0]!;
      return sql`(${sql.join(parts, " || ")})`;
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
      if (pairs.length === 0) return sql.raw`'{}'::json`;
      const args = pairs.flatMap(([key, value]) => [sql.raw`'${key}'`, value]);
      return sql`json_build_object(${sql.join(args, ", ")})`;
    },

    array: (items: Sql[]): Sql => {
      if (items.length === 0) return sql.raw`'[]'::json`;
      return sql`json_build_array(${sql.join(items, ", ")})`;
    },

    emptyArray: (): Sql => sql.raw`'[]'::json`,

    agg: (expr: Sql): Sql => sql`COALESCE(json_agg(${expr}), '[]'::json)`,

    rowToJson: (alias: string): Sql => sql`row_to_json(${sql.raw`"${alias}"`})`,

    objectFromColumns: (columns: [string, Sql][]): Sql => {
      if (columns.length === 0) return sql.raw`'{}'::json`;
      const args = columns.flatMap(([key, value]) => [
        sql.raw`'${key}'`,
        value,
      ]);
      return sql`json_build_object(${sql.join(args, ", ")})`;
    },

    extract: (column: Sql, path: string[]): Sql => {
      if (path.length === 0) return column;
      if (path.length === 1) return sql`${column}->${path[0]}`;
      const pathStr = path.join(",");
      return sql`${column}#>'{${sql.raw`${pathStr}`}}'`;
    },

    extractText: (column: Sql, path: string[]): Sql => {
      if (path.length === 0) return column;
      if (path.length === 1) return sql`${column}->>${path[0]}`;
      const pathStr = path.join(",");
      return sql`${column}#>>'{${sql.raw`${pathStr}`}}'`;
    },
  };

  // ============================================================
  // ARRAYS (Native PostgreSQL arrays)
  // ============================================================

  arrays = {
    literal: (items: Sql[]): Sql => {
      if (items.length === 0) return sql.raw`'{}'`;
      return sql`ARRAY[${sql.join(items, ", ")}]`;
    },

    has: (column: Sql, value: Sql): Sql => sql`${value} = ANY(${column})`,

    hasEvery: (column: Sql, values: Sql): Sql => sql`${column} @> ${values}`,

    hasSome: (column: Sql, values: Sql): Sql => sql`${column} && ${values}`,

    isEmpty: (column: Sql): Sql =>
      sql`(cardinality(${column}) = 0 OR ${column} IS NULL)`,

    length: (column: Sql): Sql => sql`cardinality(${column})`,

    get: (column: Sql, index: Sql): Sql => sql`${column}[${index}]`,

    push: (column: Sql, value: Sql): Sql =>
      sql`array_append(${column}, ${value})`,

    set: (column: Sql, index: Sql, value: Sql): Sql =>
      sql`${column}[:${index}-1] || ARRAY[${value}] || ${column}[${index}+1:]`,
  };

  // ============================================================
  // ORDER BY
  // ============================================================

  orderBy = {
    asc: (column: Sql): Sql => sql`${column} ASC`,
    desc: (column: Sql): Sql => sql`${column} DESC`,
    nullsFirst: (expr: Sql): Sql => sql`${expr} NULLS FIRST`,
    nullsLast: (expr: Sql): Sql => sql`${expr} NULLS LAST`,
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
      sql`${column} = array_append(${column}, ${value})`,

    unshift: (column: Sql, value: Sql): Sql =>
      sql`${column} = array_prepend(${value}, ${column})`,
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
      // PostgreSQL supports DISTINCT ON (columns)
      const selectClause = parts.distinct
        ? sql`SELECT DISTINCT ON (${parts.distinct}) ${parts.columns}`
        : sql`SELECT ${parts.columns}`;

      const fragments: Sql[] = [selectClause, sql`FROM ${parts.from}`];

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

  // ============================================================
  // CTE (Common Table Expressions)
  // ============================================================

  cte = {
    with: (definitions: { name: string; query: Sql }[]): Sql => {
      const defs = definitions.map(
        ({ name, query }) => sql`${sql.raw`"${name}"`} AS (${query})`
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

    returning: (columns: Sql): Sql => sql`RETURNING ${columns}`,

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

    right: (table: Sql, condition: Sql): Sql =>
      sql`RIGHT JOIN ${table} ON ${condition}`,

    full: (table: Sql, condition: Sql): Sql =>
      sql`FULL OUTER JOIN ${table} ON ${condition}`,

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
    supportsReturning: true,
    supportsCteWithMutations: true,
    supportsFullOuterJoin: true,
  };

  lastInsertId = (): Sql => sql.raw`lastval()`;

  // ============================================================
  // MIGRATIONS
  // ============================================================

  migrations = postgresMigrations;

  // ============================================================
  // VECTOR (pgvector)
  // ============================================================

  vector = {
    literal: (values: number[]): Sql => sql`${`[${values.join(",")}]`}::vector`,

    l2: (column: Sql, vector: Sql): Sql => sql`${column} <-> ${vector}`,

    cosine: (column: Sql, vector: Sql): Sql => sql`${column} <=> ${vector}`,
  };

  // ============================================================
  // GEOSPATIAL (PostGIS)
  // ============================================================

  geospatial = {
    point: (lng: Sql, lat: Sql): Sql =>
      sql`ST_SetSRID(ST_MakePoint(${lng}, ${lat}), 4326)`,

    equals: (geom1: Sql, geom2: Sql): Sql => sql`ST_Equals(${geom1}, ${geom2})`,

    intersects: (geom1: Sql, geom2: Sql): Sql =>
      sql`ST_Intersects(${geom1}, ${geom2})`,

    contains: (geom1: Sql, geom2: Sql): Sql =>
      sql`ST_Contains(${geom1}, ${geom2})`,

    within: (geom1: Sql, geom2: Sql): Sql => sql`ST_Within(${geom1}, ${geom2})`,

    crosses: (geom1: Sql, geom2: Sql): Sql =>
      sql`ST_Crosses(${geom1}, ${geom2})`,

    overlaps: (geom1: Sql, geom2: Sql): Sql =>
      sql`ST_Overlaps(${geom1}, ${geom2})`,

    touches: (geom1: Sql, geom2: Sql): Sql =>
      sql`ST_Touches(${geom1}, ${geom2})`,

    covers: (geom1: Sql, geom2: Sql): Sql => sql`ST_Covers(${geom1}, ${geom2})`,

    dWithin: (geom1: Sql, geom2: Sql, distance: Sql): Sql =>
      sql`ST_DWithin(${geom1}::geography, ${geom2}::geography, ${distance})`,
  };
}

// Export singleton instance
export const postgresAdapter = new PostgresAdapter();
