import type { Sql } from "@sql";

/**
 * DatabaseAdapter Interface
 *
 * A monadic, composable interface for database-specific SQL generation.
 * Each method is a pure function that transforms Sql fragments or primitives
 * into new Sql fragments, enabling clean composition without side effects.
 *
 * DESIGN PRINCIPLES:
 * - Pure functions: Same inputs always produce same outputs
 * - Composable: Outputs can be inputs to other methods
 * - Database-agnostic inputs: Query engine speaks neutral language
 * - Database-specific outputs: Adapter handles syntax differences
 *
 * USAGE:
 * The query engine calls adapter methods to build SQL fragments,
 * then composes them into complete queries. The adapter never
 * needs to understand query semantics - just SQL syntax.
 */
export interface DatabaseAdapter {
  /**
   * RAW
   * Escape hatch for raw SQL strings (use sparingly)
   */
  raw: (sqlString: string) => Sql;

  /**
   * IDENTIFIERS
   * Database-specific identifier escaping (table names, column names, aliases)
   */
  identifiers: {
    /** Escape a single identifier: "name" or `name` */
    escape: (name: string) => Sql;
    /** Create qualified column reference: "alias"."field" */
    column: (alias: string, field: string) => Sql;
    /** Create table with alias: "table" AS "alias" */
    table: (tableName: string, alias: string) => Sql;
    /** Create aliased expression: expr AS "alias" */
    aliased: (expression: Sql, alias: string) => Sql;
  };

  /**
   * LITERALS
   * Value wrapping with proper parameterization
   */
  literals: {
    /** Wrap a value as parameterized SQL */
    value: (v: unknown) => Sql;
    /** NULL keyword */
    null: () => Sql;
    /** TRUE literal (database-specific: TRUE vs 1) */
    true: () => Sql;
    /** FALSE literal (database-specific: FALSE vs 0) */
    false: () => Sql;
    /** Create a value list: ($1, $2, $3) */
    list: (values: Sql[]) => Sql;
    /** JSON value (PG: native, MySQL/SQLite: JSON.stringify) */
    json: (v: unknown) => Sql;
  };

  /**
   * OPERATORS
   * Comparison and logical operators (pure Sql -> Sql)
   */
  operators: {
    // Comparison
    eq: (left: Sql, right: Sql) => Sql;
    neq: (left: Sql, right: Sql) => Sql;
    lt: (left: Sql, right: Sql) => Sql;
    lte: (left: Sql, right: Sql) => Sql;
    gt: (left: Sql, right: Sql) => Sql;
    gte: (left: Sql, right: Sql) => Sql;

    // Pattern matching
    like: (column: Sql, pattern: Sql) => Sql;
    notLike: (column: Sql, pattern: Sql) => Sql;
    /** Case-insensitive LIKE (PG: ILIKE, MySQL: LIKE, SQLite: LIKE COLLATE NOCASE) */
    ilike: (column: Sql, pattern: Sql) => Sql;
    notIlike: (column: Sql, pattern: Sql) => Sql;

    // Set membership
    in: (column: Sql, values: Sql) => Sql;
    notIn: (column: Sql, values: Sql) => Sql;

    // Null checks
    isNull: (expr: Sql) => Sql;
    isNotNull: (expr: Sql) => Sql;

    // Range
    between: (column: Sql, min: Sql, max: Sql) => Sql;
    notBetween: (column: Sql, min: Sql, max: Sql) => Sql;

    // Logical
    and: (...conditions: Sql[]) => Sql;
    or: (...conditions: Sql[]) => Sql;
    not: (condition: Sql) => Sql;

    // Subquery existence
    exists: (subquery: Sql) => Sql;
    notExists: (subquery: Sql) => Sql;
  };

  /**
   * EXPRESSIONS
   * Computed values and functions
   */
  expressions: {
    // Arithmetic
    add: (left: Sql, right: Sql) => Sql;
    subtract: (left: Sql, right: Sql) => Sql;
    multiply: (left: Sql, right: Sql) => Sql;
    divide: (left: Sql, right: Sql) => Sql;

    // String operations
    concat: (...parts: Sql[]) => Sql;
    upper: (expr: Sql) => Sql;
    lower: (expr: Sql) => Sql;

    // Utility
    coalesce: (...exprs: Sql[]) => Sql;
    greatest: (...exprs: Sql[]) => Sql;
    least: (...exprs: Sql[]) => Sql;
    cast: (expr: Sql, type: string) => Sql;
  };

  /**
   * AGGREGATES
   * Aggregate functions
   */
  aggregates: {
    count: (expr?: Sql) => Sql;
    countDistinct: (expr: Sql) => Sql;
    sum: (expr: Sql) => Sql;
    avg: (expr: Sql) => Sql;
    min: (expr: Sql) => Sql;
    max: (expr: Sql) => Sql;
  };

  /**
   * JSON
   * Database-specific JSON building and extraction
   */
  json: {
    /** Build JSON object from key-value pairs */
    object: (pairs: [string, Sql][]) => Sql;
    /** Build JSON array from items */
    array: (items: Sql[]) => Sql;
    /** Empty JSON array literal: '[]'::json (PG), JSON_ARRAY() (MySQL), '[]' (SQLite) */
    emptyArray: () => Sql;
    /** Aggregate rows into JSON array */
    agg: (expr: Sql) => Sql;
    /** Convert row to JSON object (PG only - use objectFromColumns for MySQL/SQLite) */
    rowToJson: (alias: string) => Sql;
    /** Build JSON object from explicit column list (works on all databases) */
    objectFromColumns: (columns: [string, Sql][]) => Sql;
    /** Extract value from JSON by path */
    extract: (column: Sql, path: string[]) => Sql;
    /** Extract value as text */
    extractText: (column: Sql, path: string[]) => Sql;
  };

  /**
   * ARRAYS
   * Array operations (PG: native arrays, MySQL/SQLite: JSON-based)
   */
  arrays: {
    /** Create array literal */
    literal: (items: Sql[]) => Sql;
    /** Check if array contains value */
    has: (column: Sql, value: Sql) => Sql;
    /** Check if array contains all values */
    hasEvery: (column: Sql, values: Sql) => Sql;
    /** Check if array contains any value */
    hasSome: (column: Sql, values: Sql) => Sql;
    /** Check if array is empty */
    isEmpty: (column: Sql) => Sql;
    /** Get array length */
    length: (column: Sql) => Sql;
    /** Get element at index */
    get: (column: Sql, index: Sql) => Sql;
    /** Append value to array */
    push: (column: Sql, value: Sql) => Sql;
    /** Set value at index */
    set: (column: Sql, index: Sql, value: Sql) => Sql;
  };

  /**
   * ORDER BY
   * Ordering helpers
   */
  orderBy: {
    asc: (column: Sql) => Sql;
    desc: (column: Sql) => Sql;
    /** NULLS FIRST (PG only, no-op for MySQL/SQLite) */
    nullsFirst: (expr: Sql) => Sql;
    /** NULLS LAST (PG only, no-op for MySQL/SQLite) */
    nullsLast: (expr: Sql) => Sql;
  };

  /**
   * CLAUSES
   * SQL clause keywords
   */
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

  /**
   * SET
   * UPDATE SET operations
   */
  set: {
    /** Simple assignment: "col" = value */
    assign: (column: Sql, value: Sql) => Sql;
    /** Increment: "col" = "col" + value */
    increment: (column: Sql, by: Sql) => Sql;
    /** Decrement: "col" = "col" - value */
    decrement: (column: Sql, by: Sql) => Sql;
    /** Multiply: "col" = "col" * value */
    multiply: (column: Sql, by: Sql) => Sql;
    /** Divide: "col" = "col" / value */
    divide: (column: Sql, by: Sql) => Sql;
    /** Array push (database-specific): append to array */
    push: (column: Sql, value: Sql) => Sql;
    /** Array unshift (database-specific): prepend to array */
    unshift: (column: Sql, value: Sql) => Sql;
  };

  /**
   * FILTERS
   * Relation filter wrappers for subqueries
   */
  filters: {
    /** EXISTS wrapper for "some" relation filter (to-many) */
    some: (subquery: Sql) => Sql;
    /** NOT EXISTS wrapper for "every" - negated condition (to-many) */
    every: (subquery: Sql) => Sql;
    /** NOT EXISTS wrapper for "none" (to-many) */
    none: (subquery: Sql) => Sql;
    /** EXISTS wrapper for "is" relation filter (to-one) */
    is: (subquery: Sql) => Sql;
    /** NOT EXISTS wrapper for "isNot" relation filter (to-one) */
    isNot: (subquery: Sql) => Sql;
  };

  /**
   * SUBQUERIES
   * Subquery wrappers
   */
  subqueries: {
    /** Scalar subquery: (SELECT ...) */
    scalar: (query: Sql) => Sql;
    /** Correlated subquery with alias */
    correlate: (query: Sql, alias: string) => Sql;
    /** Build EXISTS-style subquery: SELECT 1 FROM table WHERE condition */
    existsCheck: (from: Sql, where: Sql) => Sql;
  };

  /**
   * ASSEMBLE
   * Build complete SQL statements from parts
   */
  assemble: {
    /** Assemble a complete SELECT query from parts */
    select: (parts: QueryParts) => Sql;
  };

  /**
   * CTE
   * Common Table Expressions
   */
  cte: {
    /** Build WITH clause: WITH name AS (query), ... */
    with: (definitions: { name: string; query: Sql }[]) => Sql;
    /** Build recursive CTE: WITH RECURSIVE name AS (anchor UNION ALL recursive) */
    recursive: (
      name: string,
      anchor: Sql,
      recursive: Sql,
      union?: "all" | "distinct"
    ) => Sql;
  };

  /**
   * MUTATIONS
   * Insert, Update, Delete operations
   */
  mutations: {
    /** INSERT INTO table (cols) VALUES (...) */
    insert: (table: Sql, columns: string[], values: Sql[][]) => Sql;
    /** UPDATE table SET ... WHERE ... */
    update: (table: Sql, sets: Sql, where?: Sql) => Sql;
    /** DELETE FROM table WHERE ... */
    delete: (table: Sql, where?: Sql) => Sql;
    /** RETURNING clause (PG/SQLite) or empty (MySQL) */
    returning: (columns: Sql) => Sql;
    /** ON CONFLICT / ON DUPLICATE KEY */
    onConflict: (target: Sql | null, action: Sql) => Sql;
    /**
     * Skip duplicate key errors (for createMany with skipDuplicates: true)
     * PostgreSQL/SQLite: ON CONFLICT DO NOTHING (suffix)
     * MySQL: INSERT IGNORE (prefix)
     */
    skipDuplicates: () => { prefix: Sql; suffix: Sql };
  };

  /**
   * CAPABILITIES
   * Database feature flags for conditional query building
   */
  capabilities: {
    /** Whether database supports RETURNING clause (PG, SQLite 3.35+) */
    supportsReturning: boolean;
    /** Whether database supports CTEs with data-modifying statements (PG, SQLite) */
    supportsCteWithMutations: boolean;
    /** Whether database supports FULL OUTER JOIN */
    supportsFullOuterJoin: boolean;
    /**
     * Whether database supports LATERAL joins (PG 9.3+, MySQL 8.0.14+)
     * When true, include builder uses lateral joins for better performance
     * When false, falls back to correlated subqueries
     */
    supportsLateralJoins: boolean;
  };

  /**
   * LAST INSERT ID
   * Returns SQL for getting the last auto-generated ID.
   * Used in multi-statement nested creates to reference parent's ID in child inserts.
   *
   * PostgreSQL: lastval() - returns last value from any sequence in session
   * SQLite: last_insert_rowid() - returns last ROWID inserted
   * MySQL: LAST_INSERT_ID() - returns last AUTO_INCREMENT value
   */
  lastInsertId: () => Sql;

  /**
   * JOINS
   * Join operations
   */
  joins: {
    inner: (table: Sql, condition: Sql) => Sql;
    left: (table: Sql, condition: Sql) => Sql;
    right: (table: Sql, condition: Sql) => Sql;
    full: (table: Sql, condition: Sql) => Sql;
    cross: (table: Sql) => Sql;
    /**
     * LATERAL subquery join (PostgreSQL 9.3+, MySQL 8.0.14+)
     * Allows referencing columns from preceding tables in the subquery.
     * Used for efficient nested includes.
     *
     * @param subquery - The lateral subquery (must be a complete SELECT)
     * @param alias - Alias for the lateral result
     * @returns JOIN LATERAL (subquery) AS alias ON true
     */
    lateral: (subquery: Sql, alias: string) => Sql;
    /**
     * LEFT JOIN LATERAL - same as lateral but with LEFT JOIN semantics
     * Returns NULL for the joined columns when subquery returns no rows.
     *
     * @param subquery - The lateral subquery (must be a complete SELECT)
     * @param alias - Alias for the lateral result
     * @returns LEFT JOIN LATERAL (subquery) AS alias ON true
     */
    lateralLeft: (subquery: Sql, alias: string) => Sql;
  };

  /**
   * SET OPERATIONS
   * UNION, INTERSECT, EXCEPT operations
   */
  setOperations: {
    /** UNION (removes duplicates) */
    union: (...queries: Sql[]) => Sql;
    /** UNION ALL (keeps duplicates) */
    unionAll: (...queries: Sql[]) => Sql;
    /** INTERSECT */
    intersect: (...queries: Sql[]) => Sql;
    /** EXCEPT / MINUS */
    except: (left: Sql, right: Sql) => Sql;
  };

  /**
   * MIGRATIONS
   * Database introspection and DDL generation for schema migrations
   */
  migrations: MigrationAdapter;

  /**
   * VECTOR
   * Vector operations for similarity search (pgvector)
   *
   * Matches filter schema: { l2, cosine }
   * Drivers that don't support vector operations can override
   * this property with an object that throws FeatureNotSupportedError.
   */
  vector: {
    /** Create a vector literal from number array: '[1,2,3]'::vector */
    literal: (values: number[]) => Sql;
    /** L2 (Euclidean) distance operator for ORDER BY: column <-> vector */
    l2: (column: Sql, vector: Sql) => Sql;
    /** Cosine distance operator for ORDER BY: column <=> vector */
    cosine: (column: Sql, vector: Sql) => Sql;
  };

  /**
   * GEOSPATIAL
   * Geospatial operations (PostGIS)
   *
   * Matches filter schema: { equals, intersects, contains, within, crosses, overlaps, touches, covers, dWithin }
   * Drivers that don't support geospatial operations can override
   * this property with an object that throws FeatureNotSupportedError.
   */
  geospatial: {
    /** Create a point from longitude/latitude: ST_SetSRID(ST_MakePoint(lng, lat), 4326) */
    point: (lng: Sql, lat: Sql) => Sql;
    /** ST_Equals: geometries are spatially equal */
    equals: (geom1: Sql, geom2: Sql) => Sql;
    /** ST_Intersects: geometries share any space */
    intersects: (geom1: Sql, geom2: Sql) => Sql;
    /** ST_Contains: geom1 completely contains geom2 */
    contains: (geom1: Sql, geom2: Sql) => Sql;
    /** ST_Within: geom1 is completely within geom2 */
    within: (geom1: Sql, geom2: Sql) => Sql;
    /** ST_Crosses: geometries cross each other */
    crosses: (geom1: Sql, geom2: Sql) => Sql;
    /** ST_Overlaps: geometries overlap */
    overlaps: (geom1: Sql, geom2: Sql) => Sql;
    /** ST_Touches: geometries touch at boundary */
    touches: (geom1: Sql, geom2: Sql) => Sql;
    /** ST_Covers: geom1 covers geom2 (no points of geom2 outside geom1) */
    covers: (geom1: Sql, geom2: Sql) => Sql;
    /** ST_DWithin: geometries are within specified distance (meters for geography) */
    dWithin: (geom1: Sql, geom2: Sql, distance: Sql) => Sql;
  };

  /**
   * RESULT PARSING
   * Database-specific result parsing middleware.
   * Each method receives a `next` function that calls the default parsing logic.
   *
   * ## Usage Pattern
   *
   * - `next()` - Continue with original value (passthrough)
   * - `next(transformed)` - Continue with transformed value
   * - `return value` - Short-circuit, skip default parsing
   *
   * ## Database Behaviors
   *
   * - **PostgreSQL**: Mostly passthrough (native JSON, native booleans)
   * - **MySQL/SQLite**: Parse JSON strings, convert 0/1 to booleans
   */
  result: {
    /**
     * Parse operation result (count, aggregate, etc.)
     *
     * @param raw - Raw database result
     * @param operation - Query operation type
     * @param next - Call to continue with default parsing
     *   - `next()` uses original raw value
     *   - `next(transformed)` uses the transformed value
     *
     * @returns Parsed result or result of `next()`
     *
     * @example
     * // Normalize COUNT(*) column name
     * parseResult: (raw, op, next) => {
     *   if (op === 'count') {
     *     const normalized = normalizeCountResult(raw);
     *     if (normalized) return next(normalized);
     *   }
     *   return next();
     * }
     */
    parseResult: (
      raw: unknown,
      operation: import("../query-engine/types").Operation,
      next: (value?: unknown) => unknown
    ) => unknown;

    /**
     * Parse relation value (nested JSON from includes)
     *
     * @param value - Raw relation value from database
     * @param type - Relation type (oneToMany, manyToOne, etc.)
     * @param next - Call to continue with default parsing
     *   - `next()` uses original value
     *   - `next(parsed)` uses the parsed value
     *
     * @returns Parsed relation or result of `next()`
     *
     * @example
     * // Parse JSON strings (MySQL/SQLite)
     * parseRelation: (value, type, next) => {
     *   const parsed = tryParseJsonString(value);
     *   return parsed !== undefined ? next(parsed) : next();
     * }
     */
    parseRelation: (
      value: unknown,
      type: import("../schema/relation/types").RelationType,
      next: (value?: unknown) => unknown
    ) => unknown;

    /**
     * Parse field value by type
     *
     * @param value - Raw field value from database
     * @param fieldType - Field type (boolean, datetime, bigint, etc.)
     * @param next - Call to continue with default parsing
     *   - `next()` uses original value
     *   - `next(converted)` uses the converted value
     *
     * @returns Parsed value, or result of `next()`, or short-circuit return
     *
     * @example
     * // Convert 0/1 to boolean (SQLite/MySQL)
     * parseField: (value, fieldType, next) => {
     *   if (fieldType === 'boolean') {
     *     const bool = parseIntegerBoolean(value);
     *     if (bool !== undefined) return bool; // Short-circuit
     *   }
     *   return next();
     * }
     */
    parseField: (
      value: unknown,
      fieldType: string,
      next: (value?: unknown) => unknown
    ) => unknown;
  };
}

/**
 * Migration-specific adapter methods
 */
export interface MigrationAdapter {
  /** Introspect current database schema */
  introspect: (
    executeRaw: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>
  ) => Promise<import("../migrations/types").SchemaSnapshot>;

  /** Generate DDL SQL string for a diff operation */
  generateDDL: (
    operation: import("../migrations/types").DiffOperation
  ) => string;

  /**
   * Map VibORM field to native SQL type.
   * Uses full field state to access properties like withTimezone.
   */
  mapFieldType: (
    field: import("../schema/fields/base").Field,
    fieldState: import("../schema/fields/common").FieldState
  ) => string;

  /**
   * Get the SQL default expression for a field.
   * Returns undefined if no default or if generated at runtime.
   */
  getDefaultExpression: (
    fieldState: import("../schema/fields/common").FieldState
  ) => string | undefined;

  /**
   * Whether this database supports native enum types.
   * PostgreSQL: true (CREATE TYPE ... AS ENUM)
   * MySQL/SQLite: false (uses VARCHAR/TEXT)
   */
  supportsNativeEnums: boolean;

  /**
   * Get the column type for an enum field.
   * PostgreSQL: returns the enum type name (e.g., "users_status_enum")
   * MySQL/SQLite: returns VARCHAR or TEXT
   */
  getEnumColumnType: (
    tableName: string,
    columnName: string,
    values: string[]
  ) => string;
}

/**
 * Type for query parts assembly
 */
export interface QueryParts {
  columns: Sql;
  from: Sql;
  joins?: Sql[];
  where?: Sql;
  groupBy?: Sql;
  having?: Sql;
  orderBy?: Sql;
  limit?: Sql;
  offset?: Sql;
  /** DISTINCT ON columns (PostgreSQL), or simulated via ROW_NUMBER() (MySQL/SQLite) */
  distinct?: Sql;
  /** Column alias names for outer SELECT when using DISTINCT simulation (MySQL/SQLite) */
  distinctColumnAliases?: string[];
}

/**
 * Type for insert parts assembly
 */
export interface InsertParts {
  table: Sql;
  columns: string[];
  values: Sql[][];
  onConflict?: Sql;
  returning?: Sql;
}

/**
 * Type for update parts assembly
 */
export interface UpdateParts {
  table: Sql;
  set: Sql;
  where?: Sql;
  returning?: Sql;
}

/**
 * Type for delete parts assembly
 */
export interface DeleteParts {
  table: Sql;
  where?: Sql;
  returning?: Sql;
}
