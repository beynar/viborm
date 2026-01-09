import { a as QueryParts, i as MigrationAdapter, n as DeleteParts, o as UpdateParts, r as InsertParts, s as Sql, t as DatabaseAdapter } from "./database-adapter-C-t7bvr_.mjs";

//#region src/adapters/databases/mysql/mysql-adapter.d.ts

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
declare class MySQLAdapter implements DatabaseAdapter {
  raw: (sqlString: string) => Sql;
  identifiers: {
    escape: (name: string) => Sql;
    column: (alias: string, field: string) => Sql;
    table: (tableName: string, alias: string) => Sql;
    aliased: (expression: Sql, alias: string) => Sql;
  };
  literals: {
    value: (v: unknown) => Sql;
    null: () => Sql;
    true: () => Sql;
    false: () => Sql;
    list: (values: Sql[]) => Sql;
    json: (v: unknown) => Sql;
  };
  operators: {
    eq: (left: Sql, right: Sql) => Sql;
    neq: (left: Sql, right: Sql) => Sql;
    lt: (left: Sql, right: Sql) => Sql;
    lte: (left: Sql, right: Sql) => Sql;
    gt: (left: Sql, right: Sql) => Sql;
    gte: (left: Sql, right: Sql) => Sql;
    like: (column: Sql, pattern: Sql) => Sql;
    notLike: (column: Sql, pattern: Sql) => Sql;
    ilike: (column: Sql, pattern: Sql) => Sql;
    notIlike: (column: Sql, pattern: Sql) => Sql;
    in: (column: Sql, values: Sql) => Sql;
    notIn: (column: Sql, values: Sql) => Sql;
    isNull: (expr: Sql) => Sql;
    isNotNull: (expr: Sql) => Sql;
    between: (column: Sql, min: Sql, max: Sql) => Sql;
    notBetween: (column: Sql, min: Sql, max: Sql) => Sql;
    and: (...conditions: Sql[]) => Sql;
    or: (...conditions: Sql[]) => Sql;
    not: (condition: Sql) => Sql;
    exists: (subquery: Sql) => Sql;
    notExists: (subquery: Sql) => Sql;
  };
  expressions: {
    add: (left: Sql, right: Sql) => Sql;
    subtract: (left: Sql, right: Sql) => Sql;
    multiply: (left: Sql, right: Sql) => Sql;
    divide: (left: Sql, right: Sql) => Sql;
    concat: (...parts: Sql[]) => Sql;
    upper: (expr: Sql) => Sql;
    lower: (expr: Sql) => Sql;
    coalesce: (...exprs: Sql[]) => Sql;
    greatest: (...exprs: Sql[]) => Sql;
    least: (...exprs: Sql[]) => Sql;
    cast: (expr: Sql, type: string) => Sql;
  };
  aggregates: {
    count: (expr?: Sql) => Sql;
    countDistinct: (expr: Sql) => Sql;
    sum: (expr: Sql) => Sql;
    avg: (expr: Sql) => Sql;
    min: (expr: Sql) => Sql;
    max: (expr: Sql) => Sql;
  };
  json: {
    object: (pairs: [string, Sql][]) => Sql;
    array: (items: Sql[]) => Sql;
    emptyArray: () => Sql;
    agg: (expr: Sql) => Sql;
    rowToJson: (alias: string) => Sql;
    objectFromColumns: (columns: [string, Sql][]) => Sql;
    extract: (column: Sql, path: string[]) => Sql;
    extractText: (column: Sql, path: string[]) => Sql;
  };
  arrays: {
    literal: (items: Sql[]) => Sql;
    has: (column: Sql, value: Sql) => Sql;
    hasEvery: (column: Sql, values: Sql) => Sql;
    hasSome: (column: Sql, values: Sql) => Sql;
    isEmpty: (column: Sql) => Sql;
    length: (column: Sql) => Sql;
    get: (column: Sql, index: Sql) => Sql;
    push: (column: Sql, value: Sql) => Sql;
    set: (column: Sql, index: Sql, value: Sql) => Sql;
  };
  orderBy: {
    asc: (column: Sql) => Sql;
    desc: (column: Sql) => Sql;
    nullsFirst: (expr: Sql) => Sql;
    nullsLast: (expr: Sql) => Sql;
  };
  clauses: {
    select: (columns: Sql) => Sql;
    selectDistinct: (columns: Sql) => Sql;
    from: (table: Sql) => Sql;
    where: (condition: Sql) => Sql;
    orderBy: (orders: Sql) => Sql;
    limit: (count: Sql) => Sql;
    offset: (count: Sql) => Sql;
    groupBy: (columns: Sql) => Sql;
    having: (condition: Sql) => Sql;
  };
  set: {
    assign: (column: Sql, value: Sql) => Sql;
    increment: (column: Sql, by: Sql) => Sql;
    decrement: (column: Sql, by: Sql) => Sql;
    multiply: (column: Sql, by: Sql) => Sql;
    divide: (column: Sql, by: Sql) => Sql;
    push: (column: Sql, value: Sql) => Sql;
    unshift: (column: Sql, value: Sql) => Sql;
  };
  filters: {
    some: (subquery: Sql) => Sql;
    every: (subquery: Sql) => Sql;
    none: (subquery: Sql) => Sql;
    is: (subquery: Sql) => Sql;
    isNot: (subquery: Sql) => Sql;
  };
  subqueries: {
    scalar: (query: Sql) => Sql;
    correlate: (query: Sql, alias: string) => Sql;
    existsCheck: (from: Sql, where: Sql) => Sql;
  };
  assemble: {
    select: (parts: QueryParts) => Sql;
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
  private assembleDistinctOn;
  cte: {
    with: (definitions: {
      name: string;
      query: Sql;
    }[]) => Sql;
    recursive: (name: string, anchor: Sql, recursive: Sql, union?: "all" | "distinct") => Sql;
  };
  mutations: {
    insert: (table: Sql, columns: string[], values: Sql[][]) => Sql;
    update: (table: Sql, sets: Sql, where?: Sql) => Sql;
    delete: (table: Sql, where?: Sql) => Sql;
    returning: (_columns: Sql) => Sql;
    onConflict: (_target: Sql | null, action: Sql) => Sql;
  };
  joins: {
    inner: (table: Sql, condition: Sql) => Sql;
    left: (table: Sql, condition: Sql) => Sql;
    right: (table: Sql, condition: Sql) => Sql;
    full: (table: Sql, condition: Sql) => Sql;
    cross: (table: Sql) => Sql;
  };
  setOperations: {
    union: (...queries: Sql[]) => Sql;
    unionAll: (...queries: Sql[]) => Sql;
    intersect: (...queries: Sql[]) => Sql;
    except: (left: Sql, right: Sql) => Sql;
  };
  capabilities: {
    supportsReturning: boolean;
    supportsCteWithMutations: boolean;
    supportsFullOuterJoin: boolean;
  };
  lastInsertId: () => Sql;
  migrations: MigrationAdapter;
  vector: {
    literal: () => never;
    l2: () => never;
    cosine: () => never;
  };
  geospatial: {
    point: () => never;
    equals: () => never;
    intersects: () => never;
    contains: () => never;
    within: () => never;
    crosses: () => never;
    overlaps: () => never;
    touches: () => never;
    covers: () => never;
    dWithin: () => never;
  };
}
declare const mysqlAdapter: MySQLAdapter;
//#endregion
//#region src/adapters/databases/postgres/postgres-adapter.d.ts
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
declare class PostgresAdapter implements DatabaseAdapter {
  raw: (sqlString: string) => Sql;
  identifiers: {
    escape: (name: string) => Sql;
    column: (alias: string, field: string) => Sql;
    table: (tableName: string, alias: string) => Sql;
    aliased: (expression: Sql, alias: string) => Sql;
  };
  literals: {
    value: (v: unknown) => Sql;
    null: () => Sql;
    true: () => Sql;
    false: () => Sql;
    list: (values: Sql[]) => Sql;
    json: (v: unknown) => Sql;
  };
  operators: {
    eq: (left: Sql, right: Sql) => Sql;
    neq: (left: Sql, right: Sql) => Sql;
    lt: (left: Sql, right: Sql) => Sql;
    lte: (left: Sql, right: Sql) => Sql;
    gt: (left: Sql, right: Sql) => Sql;
    gte: (left: Sql, right: Sql) => Sql;
    like: (column: Sql, pattern: Sql) => Sql;
    notLike: (column: Sql, pattern: Sql) => Sql;
    ilike: (column: Sql, pattern: Sql) => Sql;
    notIlike: (column: Sql, pattern: Sql) => Sql;
    in: (column: Sql, values: Sql) => Sql;
    notIn: (column: Sql, values: Sql) => Sql;
    isNull: (expr: Sql) => Sql;
    isNotNull: (expr: Sql) => Sql;
    between: (column: Sql, min: Sql, max: Sql) => Sql;
    notBetween: (column: Sql, min: Sql, max: Sql) => Sql;
    and: (...conditions: Sql[]) => Sql;
    or: (...conditions: Sql[]) => Sql;
    not: (condition: Sql) => Sql;
    exists: (subquery: Sql) => Sql;
    notExists: (subquery: Sql) => Sql;
  };
  expressions: {
    add: (left: Sql, right: Sql) => Sql;
    subtract: (left: Sql, right: Sql) => Sql;
    multiply: (left: Sql, right: Sql) => Sql;
    divide: (left: Sql, right: Sql) => Sql;
    concat: (...parts: Sql[]) => Sql;
    upper: (expr: Sql) => Sql;
    lower: (expr: Sql) => Sql;
    coalesce: (...exprs: Sql[]) => Sql;
    greatest: (...exprs: Sql[]) => Sql;
    least: (...exprs: Sql[]) => Sql;
    cast: (expr: Sql, type: string) => Sql;
  };
  aggregates: {
    count: (expr?: Sql) => Sql;
    countDistinct: (expr: Sql) => Sql;
    sum: (expr: Sql) => Sql;
    avg: (expr: Sql) => Sql;
    min: (expr: Sql) => Sql;
    max: (expr: Sql) => Sql;
  };
  json: {
    object: (pairs: [string, Sql][]) => Sql;
    array: (items: Sql[]) => Sql;
    emptyArray: () => Sql;
    agg: (expr: Sql) => Sql;
    rowToJson: (alias: string) => Sql;
    objectFromColumns: (columns: [string, Sql][]) => Sql;
    extract: (column: Sql, path: string[]) => Sql;
    extractText: (column: Sql, path: string[]) => Sql;
  };
  arrays: {
    literal: (items: Sql[]) => Sql;
    has: (column: Sql, value: Sql) => Sql;
    hasEvery: (column: Sql, values: Sql) => Sql;
    hasSome: (column: Sql, values: Sql) => Sql;
    isEmpty: (column: Sql) => Sql;
    length: (column: Sql) => Sql;
    get: (column: Sql, index: Sql) => Sql;
    push: (column: Sql, value: Sql) => Sql;
    set: (column: Sql, index: Sql, value: Sql) => Sql;
  };
  orderBy: {
    asc: (column: Sql) => Sql;
    desc: (column: Sql) => Sql;
    nullsFirst: (expr: Sql) => Sql;
    nullsLast: (expr: Sql) => Sql;
  };
  clauses: {
    select: (columns: Sql) => Sql;
    selectDistinct: (columns: Sql) => Sql;
    from: (table: Sql) => Sql;
    where: (condition: Sql) => Sql;
    orderBy: (orders: Sql) => Sql;
    limit: (count: Sql) => Sql;
    offset: (count: Sql) => Sql;
    groupBy: (columns: Sql) => Sql;
    having: (condition: Sql) => Sql;
  };
  set: {
    assign: (column: Sql, value: Sql) => Sql;
    increment: (column: Sql, by: Sql) => Sql;
    decrement: (column: Sql, by: Sql) => Sql;
    multiply: (column: Sql, by: Sql) => Sql;
    divide: (column: Sql, by: Sql) => Sql;
    push: (column: Sql, value: Sql) => Sql;
    unshift: (column: Sql, value: Sql) => Sql;
  };
  filters: {
    some: (subquery: Sql) => Sql;
    every: (subquery: Sql) => Sql;
    none: (subquery: Sql) => Sql;
    is: (subquery: Sql) => Sql;
    isNot: (subquery: Sql) => Sql;
  };
  subqueries: {
    scalar: (query: Sql) => Sql;
    correlate: (query: Sql, alias: string) => Sql;
    existsCheck: (from: Sql, where: Sql) => Sql;
  };
  assemble: {
    select: (parts: QueryParts) => Sql;
  };
  cte: {
    with: (definitions: {
      name: string;
      query: Sql;
    }[]) => Sql;
    recursive: (name: string, anchor: Sql, recursive: Sql, union?: "all" | "distinct") => Sql;
  };
  mutations: {
    insert: (table: Sql, columns: string[], values: Sql[][]) => Sql;
    update: (table: Sql, sets: Sql, where?: Sql) => Sql;
    delete: (table: Sql, where?: Sql) => Sql;
    returning: (columns: Sql) => Sql;
    onConflict: (target: Sql | null, action: Sql) => Sql;
  };
  joins: {
    inner: (table: Sql, condition: Sql) => Sql;
    left: (table: Sql, condition: Sql) => Sql;
    right: (table: Sql, condition: Sql) => Sql;
    full: (table: Sql, condition: Sql) => Sql;
    cross: (table: Sql) => Sql;
  };
  setOperations: {
    union: (...queries: Sql[]) => Sql;
    unionAll: (...queries: Sql[]) => Sql;
    intersect: (...queries: Sql[]) => Sql;
    except: (left: Sql, right: Sql) => Sql;
  };
  capabilities: {
    supportsReturning: boolean;
    supportsCteWithMutations: boolean;
    supportsFullOuterJoin: boolean;
  };
  lastInsertId: () => Sql;
  migrations: MigrationAdapter;
  vector: {
    literal: (values: number[]) => Sql;
    l2: (column: Sql, vector: Sql) => Sql;
    cosine: (column: Sql, vector: Sql) => Sql;
  };
  geospatial: {
    point: (lng: Sql, lat: Sql) => Sql;
    equals: (geom1: Sql, geom2: Sql) => Sql;
    intersects: (geom1: Sql, geom2: Sql) => Sql;
    contains: (geom1: Sql, geom2: Sql) => Sql;
    within: (geom1: Sql, geom2: Sql) => Sql;
    crosses: (geom1: Sql, geom2: Sql) => Sql;
    overlaps: (geom1: Sql, geom2: Sql) => Sql;
    touches: (geom1: Sql, geom2: Sql) => Sql;
    covers: (geom1: Sql, geom2: Sql) => Sql;
    dWithin: (geom1: Sql, geom2: Sql, distance: Sql) => Sql;
  };
}
declare const postgresAdapter: PostgresAdapter;
//#endregion
//#region src/adapters/databases/sqlite/sqlite-adapter.d.ts
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
declare class SQLiteAdapter implements DatabaseAdapter {
  raw: (sqlString: string) => Sql;
  identifiers: {
    escape: (name: string) => Sql;
    column: (alias: string, field: string) => Sql;
    table: (tableName: string, alias: string) => Sql;
    aliased: (expression: Sql, alias: string) => Sql;
  };
  literals: {
    value: (v: unknown) => Sql;
    null: () => Sql;
    true: () => Sql;
    false: () => Sql;
    list: (values: Sql[]) => Sql;
    json: (v: unknown) => Sql;
  };
  operators: {
    eq: (left: Sql, right: Sql) => Sql;
    neq: (left: Sql, right: Sql) => Sql;
    lt: (left: Sql, right: Sql) => Sql;
    lte: (left: Sql, right: Sql) => Sql;
    gt: (left: Sql, right: Sql) => Sql;
    gte: (left: Sql, right: Sql) => Sql;
    like: (column: Sql, pattern: Sql) => Sql;
    notLike: (column: Sql, pattern: Sql) => Sql;
    ilike: (column: Sql, pattern: Sql) => Sql;
    notIlike: (column: Sql, pattern: Sql) => Sql;
    in: (column: Sql, values: Sql) => Sql;
    notIn: (column: Sql, values: Sql) => Sql;
    isNull: (expr: Sql) => Sql;
    isNotNull: (expr: Sql) => Sql;
    between: (column: Sql, min: Sql, max: Sql) => Sql;
    notBetween: (column: Sql, min: Sql, max: Sql) => Sql;
    and: (...conditions: Sql[]) => Sql;
    or: (...conditions: Sql[]) => Sql;
    not: (condition: Sql) => Sql;
    exists: (subquery: Sql) => Sql;
    notExists: (subquery: Sql) => Sql;
  };
  expressions: {
    add: (left: Sql, right: Sql) => Sql;
    subtract: (left: Sql, right: Sql) => Sql;
    multiply: (left: Sql, right: Sql) => Sql;
    divide: (left: Sql, right: Sql) => Sql;
    concat: (...parts: Sql[]) => Sql;
    upper: (expr: Sql) => Sql;
    lower: (expr: Sql) => Sql;
    coalesce: (...exprs: Sql[]) => Sql;
    greatest: (...exprs: Sql[]) => Sql;
    least: (...exprs: Sql[]) => Sql;
    cast: (expr: Sql, type: string) => Sql;
  };
  aggregates: {
    count: (expr?: Sql) => Sql;
    countDistinct: (expr: Sql) => Sql;
    sum: (expr: Sql) => Sql;
    avg: (expr: Sql) => Sql;
    min: (expr: Sql) => Sql;
    max: (expr: Sql) => Sql;
  };
  json: {
    object: (pairs: [string, Sql][]) => Sql;
    array: (items: Sql[]) => Sql;
    emptyArray: () => Sql;
    agg: (expr: Sql) => Sql;
    rowToJson: (alias: string) => Sql;
    objectFromColumns: (columns: [string, Sql][]) => Sql;
    extract: (column: Sql, path: string[]) => Sql;
    extractText: (column: Sql, path: string[]) => Sql;
  };
  arrays: {
    literal: (items: Sql[]) => Sql;
    has: (column: Sql, value: Sql) => Sql;
    hasEvery: (column: Sql, values: Sql) => Sql;
    hasSome: (column: Sql, values: Sql) => Sql;
    isEmpty: (column: Sql) => Sql;
    length: (column: Sql) => Sql;
    get: (column: Sql, index: Sql) => Sql;
    push: (column: Sql, value: Sql) => Sql;
    set: (column: Sql, index: Sql, value: Sql) => Sql;
  };
  orderBy: {
    asc: (column: Sql) => Sql;
    desc: (column: Sql) => Sql;
    nullsFirst: (expr: Sql) => Sql;
    nullsLast: (expr: Sql) => Sql;
  };
  clauses: {
    select: (columns: Sql) => Sql;
    selectDistinct: (columns: Sql) => Sql;
    from: (table: Sql) => Sql;
    where: (condition: Sql) => Sql;
    orderBy: (orders: Sql) => Sql;
    limit: (count: Sql) => Sql;
    offset: (count: Sql) => Sql;
    groupBy: (columns: Sql) => Sql;
    having: (condition: Sql) => Sql;
  };
  set: {
    assign: (column: Sql, value: Sql) => Sql;
    increment: (column: Sql, by: Sql) => Sql;
    decrement: (column: Sql, by: Sql) => Sql;
    multiply: (column: Sql, by: Sql) => Sql;
    divide: (column: Sql, by: Sql) => Sql;
    push: (column: Sql, value: Sql) => Sql;
    unshift: (column: Sql, value: Sql) => Sql;
  };
  filters: {
    some: (subquery: Sql) => Sql;
    every: (subquery: Sql) => Sql;
    none: (subquery: Sql) => Sql;
    is: (subquery: Sql) => Sql;
    isNot: (subquery: Sql) => Sql;
  };
  subqueries: {
    scalar: (query: Sql) => Sql;
    correlate: (query: Sql, alias: string) => Sql;
    existsCheck: (from: Sql, where: Sql) => Sql;
  };
  assemble: {
    select: (parts: QueryParts) => Sql;
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
  private assembleDistinctOn;
  cte: {
    with: (definitions: {
      name: string;
      query: Sql;
    }[]) => Sql;
    recursive: (name: string, anchor: Sql, recursive: Sql, union?: "all" | "distinct") => Sql;
  };
  mutations: {
    insert: (table: Sql, columns: string[], values: Sql[][]) => Sql;
    update: (table: Sql, sets: Sql, where?: Sql) => Sql;
    delete: (table: Sql, where?: Sql) => Sql;
    returning: (columns: Sql) => Sql;
    onConflict: (target: Sql | null, action: Sql) => Sql;
  };
  joins: {
    inner: (table: Sql, condition: Sql) => Sql;
    left: (table: Sql, condition: Sql) => Sql;
    right: (table: Sql, condition: Sql) => Sql;
    full: (table: Sql, condition: Sql) => Sql;
    cross: (table: Sql) => Sql;
  };
  setOperations: {
    union: (...queries: Sql[]) => Sql;
    unionAll: (...queries: Sql[]) => Sql;
    intersect: (...queries: Sql[]) => Sql;
    except: (left: Sql, right: Sql) => Sql;
  };
  capabilities: {
    supportsReturning: boolean;
    supportsCteWithMutations: boolean;
    supportsFullOuterJoin: boolean;
  };
  lastInsertId: () => Sql;
  migrations: MigrationAdapter;
  vector: {
    literal: () => never;
    l2: () => never;
    cosine: () => never;
  };
  geospatial: {
    point: () => never;
    equals: () => never;
    intersects: () => never;
    contains: () => never;
    within: () => never;
    crosses: () => never;
    overlaps: () => never;
    touches: () => never;
    covers: () => never;
    dWithin: () => never;
  };
}
declare const sqliteAdapter: SQLiteAdapter;
//#endregion
//#region src/adapters/types.d.ts
interface ValidationRule {
  type: string;
  params?: Record<string, unknown>;
  message?: string;
}
type AdapterError = ConnectionError | QueryError | ValidationError | SchemaError | ASTError;
interface ConnectionError {
  type: "connection";
  code: string;
  message: string;
  cause?: Error;
}
interface QueryError {
  type: "query";
  code: string;
  message: string;
  query?: string;
  parameters?: unknown[];
  cause?: Error;
}
interface ValidationError {
  type: "validation";
  field: string;
  rule: string;
  message: string;
  value?: unknown;
}
interface SchemaError {
  type: "schema";
  message: string;
  entity?: string;
  cause?: Error;
}
interface ASTError {
  type: "ast";
  message: string;
  node?: string;
  cause?: Error;
}
//#endregion
export { ASTError, AdapterError, ConnectionError, DatabaseAdapter, DeleteParts, InsertParts, MigrationAdapter, MySQLAdapter, PostgresAdapter, QueryError, QueryParts, SQLiteAdapter, SchemaError, UpdateParts, ValidationError, ValidationRule, mysqlAdapter, postgresAdapter, sqliteAdapter };
//# sourceMappingURL=adapters.d.mts.map