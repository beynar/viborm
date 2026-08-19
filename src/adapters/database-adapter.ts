import type { Sql } from "@sql";
import type { DatabaseAdapterCapabilities } from "./adapter-capabilities";
import type { BatchReferenceSqlAdapter, CastType } from "./adapter-core-types";
import type { QueryParts } from "./adapter-query-parts";
import type { AdapterResultParser } from "./adapter-result-parser";

export type { DatabaseAdapterCapabilities } from "./adapter-capabilities";
export type { BatchReferenceSqlAdapter, CastType } from "./adapter-core-types";
export type {
  DeleteParts,
  InsertParts,
  QueryParts,
  UpdateParts,
} from "./adapter-query-parts";
export type { AdapterResultParser } from "./adapter-result-parser";

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
    /** Datetime value from a validated ISO-8601 string (PG/SQLite: as-is, MySQL: naive UTC 'YYYY-MM-DD HH:MM:SS.mmm') */
    dateTime: (iso: string) => Sql;
    /**
     * Decimal operand from a canonical decimal string.
     *
     * The value binds as text and the DIALECT decides how to read it, because
     * the reading is where precision is won or lost. PG and MySQL cast it into
     * their exact decimal type — MySQL in particular compares a `DECIMAL`
     * column against an uncast string operand as a *double*, which would make
     * an exact column compare inexactly with nothing to show for it. SQLite has
     * no exact decimal type at all and stores the canonical text, so there the
     * operand stays text and equality is exact by construction.
     */
    decimal: (canonical: string) => Sql;
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
    /** Case-insensitive LIKE. */
    ilike: (column: Sql, pattern: Sql) => Sql;
    notIlike: (column: Sql, pattern: Sql) => Sql;
    /** Case-sensitive substring predicates, independent of database collation. */
    containsText: (column: Sql, value: Sql) => Sql;
    startsWithText: (column: Sql, value: Sql) => Sql;
    endsWithText: (column: Sql, value: Sql) => Sql;
    /**
     * `startsWithText` for a plain string operand, spelled so the dialect's
     * planner can turn it into an index range.
     *
     * Same answer as `startsWithText` on every input — it exists only because
     * `startsWithText` wraps the COLUMN in a function (`LEFT`/`substr`), which
     * no planner can range on. This one takes the raw JS string instead of a
     * bound `Sql` so the adapter can escape it into its own pattern language
     * and bind the finished pattern; a pattern assembled in SQL from the
     * operand would be non-constant and lose the range again.
     *
     * Only the where-builder's default-mode, plain-string, `string`-scalar path
     * reaches it. A field-reference operand, a JSON path, an enum column and
     * `mode: "insensitive"` all keep `startsWithText`: each of those either has
     * no client-side string to escape, or already wraps the column in a fold
     * that forecloses the range anyway.
     *
     * Each dialect's implementation must hold the case-sensitivity contract
     * `startsWithText` documents. See the per-adapter comments — the three
     * answers are not the same shape, and the measurements that forced that
     * are recorded in `docs/architecture/query-performance-plan.md`, §7.3.
     */
    startsWithPrefix: (column: Sql, value: string) => Sql;

    /**
     * `column = value` and `column IN (values)` on a TEXT column, under the
     * case-sensitive semantics `caseSensitiveText` spells, written so the
     * dialect's planner can still use an index.
     *
     * `column` arrives unwrapped: each adapter applies its own
     * `caseSensitiveText` where its own semantics need it, and is free to put
     * an index-usable conjunct in front of it. On PostgreSQL and SQLite that
     * is exactly `caseSensitiveText(column) <op> …` and nothing more — their
     * case-sensitive spellings are already index-usable. MySQL's is not: the
     * `BINARY` cast is a function of the column, so the planner drops to a full
     * scan, and MySQL adds a collation-native conjunct in front. See
     * `docs/architecture/query-performance-plan.md`, §10.2 for the plans.
     *
     * The operands are BOUND values, never referenced columns — the caller
     * routes a reference to the plain comparison, which has no index lookup to
     * preserve.
     */
    exactTextEq: (column: Sql, value: Sql) => Sql;
    exactTextIn: (column: Sql, values: Sql) => Sql;

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
    /** Portable searched CASE expression. */
    caseWhen: (
      branches: readonly { readonly when: Sql; readonly then: Sql }[],
      otherwise: Sql
    ) => Sql;

    // Arithmetic
    add: (left: Sql, right: Sql) => Sql;
    subtract: (left: Sql, right: Sql) => Sql;
    multiply: (left: Sql, right: Sql) => Sql;
    divide: (left: Sql, right: Sql) => Sql;

    // String operations
    concat: (...parts: Sql[]) => Sql;
    upper: (expr: Sql) => Sql;
    lower: (expr: Sql) => Sql;
    /** Fold ASCII A-Z to a-z without provider-native Unicode case folding. */
    asciiCaseFold: (expr: Sql) => Sql;
    /** Force exact text comparison semantics independent of column/database collation. */
    caseSensitiveText: (expr: Sql) => Sql;

    // Utility
    coalesce: (...exprs: Sql[]) => Sql;
    /** Reserved — not called by the query engine yet. */
    greatest: (...exprs: Sql[]) => Sql;
    /** Reserved — not called by the query engine yet. */
    least: (...exprs: Sql[]) => Sql;
    cast: (expr: Sql, type: CastType) => Sql;
    /**
     * Hex-encode a binary column for JSON embedding — JSON can't hold binary
     * (PG: encode(x, 'hex'), MySQL/SQLite: lower(hex(x))).
     * The result parser decodes hex back to Uint8Array.
     */
    blobToHex: (expr: Sql) => Sql;
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
    /** Convert a SQL predicate into a JSON boolean value. */
    boolean: (condition: Sql) => Sql;
    /** Preserve a SQL expression as a JSON document when embedding it in JSON. */
    document: (expression: Sql) => Sql;
    /** Build JSON object from key-value pairs */
    object: (pairs: [string, Sql][]) => Sql;
    /** Build JSON array from items */
    array: (items: Sql[]) => Sql;
    /** Empty JSON array literal: '[]'::json (PG), JSON_ARRAY() (MySQL), '[]' (SQLite) */
    emptyArray: () => Sql;
    /** Aggregate rows into JSON array */
    agg: (expr: Sql) => Sql;
    /** Build JSON object from explicit column list (works on all databases) */
    objectFromColumns: (columns: [string, Sql][]) => Sql;
    /**
     * Extract the JSON value at a path (empty path = document root) in a
     * form comparable against `json.value` params. Integer segments address
     * array elements. Used by JSON path filters in the where-builder.
     */
    extract: (column: Sql, path: string[]) => Sql;
    /**
     * Extract the value at a path as text (strings unquoted; empty path =
     * document root). Used by JSON string_contains/starts_with/ends_with.
     */
    extractText: (column: Sql, path: string[]) => Sql;
    /**
     * The value at `path` as a double-precision number, or SQL NULL when the
     * path is absent or the JSON value there is NOT a JSON number. Every
     * dialect gates the cast behind its own JSON type test (PG jsonb_typeof,
     * MySQL JSON_TYPE, SQLite json_type) so a non-numeric value yields NULL
     * instead of a cast error. Used by JSON lt/lte/gt/gte with number
     * operands: NULL never satisfies a comparison, so mismatched types and
     * absent paths never match and never error.
     */
    numberAtPath: (column: Sql, path: string[]) => Sql;
    /**
     * The value at `path` as unquoted text under a byte-ordered collation
     * (PG COLLATE "C", MySQL VARBINARY, SQLite COLLATE BINARY), or SQL NULL
     * when the path is absent or the JSON value there is NOT a JSON string.
     * The forced collation makes `<`/`>` code-point ordering on every
     * dialect instead of the database's default (locale) collation. Used by
     * JSON lt/lte/gt/gte with string operands.
     */
    stringAtPath: (column: Sql, path: string[]) => Sql;
    /**
     * JSON array containment: target is an array containing every element
     * of the candidate JSON array value (PG @>, MySQL JSON_CONTAINS,
     * SQLite json_each). Used by the array_contains filter.
     */
    contains: (target: Sql, value: Sql) => Sql;
    /**
     * Last element of a JSON array (PG -> -1, MySQL $[last],
     * SQLite $[#-1]). Used by the array_ends_with filter.
     */
    lastElement: (target: Sql) => Sql;
    /**
     * Parameterized JSON value usable in comparisons against a JSON column.
     * PG: plain param (jsonb), MySQL: CAST(? AS JSON) so equality compares
     * JSON documents instead of coercing to a JSON string scalar,
     * SQLite: canonical JSON text param.
     */
    value: (v: unknown) => Sql;
  };

  /**
   * ARRAYS
   * Array operations (PG: native arrays, MySQL/SQLite: JSON-based)
   */
  arrays: {
    /** Create array literal */
    literal: (items: Sql[]) => Sql;
    /**
     * Parameterized value for a complete list in the dialect's storage
     * format: native array param (PG), CAST(? AS JSON) (MySQL), canonical
     * JSON text param (SQLite). Used for list writes and equals/not filters.
     */
    value: (values: unknown[]) => Sql;
    /** Check if array contains value */
    has: (column: Sql, value: Sql) => Sql;
    /** Check if array contains all values */
    hasEvery: (column: Sql, values: Sql) => Sql;
    /** Check if array contains any value */
    hasSome: (column: Sql, values: Sql) => Sql;
    /** Check if array is empty */
    isEmpty: (column: Sql) => Sql;
    /** Get array length. Reserved — not called by the query engine yet. */
    length: (column: Sql) => Sql;
    /** Get element at index. Reserved — not called by the query engine yet. */
    get: (column: Sql, index: Sql) => Sql;
    /** Append value to array */
    push: (column: Sql, value: Sql) => Sql;
    /** Set value at index. Reserved — not called by the query engine yet. */
    set: (column: Sql, index: Sql, value: Sql) => Sql;
  };

  /**
   * ORDER BY
   * Ordering helpers
   */
  orderBy: {
    asc: (column: Sql) => Sql;
    desc: (column: Sql) => Sql;
    /** Directed order placing NULLs first (native on PG, IS NULL sort-key emulation on MySQL/SQLite) */
    nullsFirst: (column: Sql, direction: "asc" | "desc") => Sql;
    /** Directed order placing NULLs last (native on PG, IS NULL sort-key emulation on MySQL/SQLite) */
    nullsLast: (column: Sql, direction: "asc" | "desc") => Sql;
  };

  /**
   * CLAUSES
   * SQL clause keywords
   */
  /**
   * LIMIT value meaning "no limit", for dialects that reject OFFSET without
   * LIMIT (MySQL: 18446744073709551615, SQLite: -1).
   * Omit when the dialect supports bare OFFSET (PostgreSQL).
   */
  noLimitValue?: Sql;

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
    /**
     * Divide: "col" = "col" / value.
     * `columnIsInteger` tells the adapter the target column is integer-typed
     * so it can force integer division where the dialect would otherwise do
     * real division. SQLite binds the operand as REAL, while MySQL `/` returns
     * a decimal quotient even for integer columns; both adapters use the flag
     * to preserve truncation toward zero. PostgreSQL integer division already
     * has that behavior and ignores the flag.
     */
    divide: (column: Sql, by: Sql, columnIsInteger?: boolean) => Sql;
    /**
     * Array push: append each element of `values` to the list column
     * (PG: array_cat, MySQL: JSON_MERGE_PRESERVE, SQLite: JSON text concat).
     * Takes raw JS values so each dialect can serialize the whole list.
     */
    push: (column: Sql, values: unknown[]) => Sql;
    /** Array unshift: prepend each element of `values` to the list column */
    unshift: (column: Sql, values: unknown[]) => Sql;
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
    /** How top-level bulk create realizes duplicate-only skipping. */
    skipDuplicatesStrategy: "sql" | "recoverableUniqueError";
    /** INSERT INTO table (cols) from literal rows or a SELECT source. */
    insert: (
      table: Sql,
      columns: string[],
      source: Sql[][] | { readonly select: Sql },
      prefix?: Sql
    ) => Sql;
    /** Insert one row using only database defaults. */
    insertDefault: (table: Sql) => Sql;
    /** UPDATE table SET ... WHERE ... */
    update: (table: Sql, sets: Sql, where?: Sql) => Sql;
    /** DELETE FROM table WHERE ... */
    delete: (table: Sql, where?: Sql) => Sql;
    /** RETURNING clause (PG/SQLite) or empty (MySQL) */
    returning: (columns: Sql) => Sql;
    /**
     * ON CONFLICT / ON DUPLICATE KEY
     * @param target - Conflict target columns (e.g., "id")
     * @param action - Action to take (e.g., UPDATE SET ...)
     * @param targetWhere - Optional WHERE for partial unique index matching
     *                      PostgreSQL: ON CONFLICT (id) WHERE <targetWhere> DO UPDATE ...
     */
    onConflict: (target: Sql | null, action: Sql, targetWhere?: Sql) => Sql;
    /**
     * Build update action for ON CONFLICT (PG/SQLite: UPDATE SET ..., MySQL: just the SET part)
     * @param sets - SET clause assignments
     * @param setWhere - Optional WHERE for conditional updates
     *                   PostgreSQL: ... DO UPDATE SET x = y WHERE <setWhere>
     */
    onConflictUpdate: (sets: Sql, setWhere?: Sql) => Sql;
    /**
     * Skip duplicate key errors (for createMany with skipDuplicates: true)
     * PostgreSQL/SQLite: ON CONFLICT DO NOTHING (suffix)
     * MySQL: duplicate-key-only no-op update (suffix)
     *
     * UNTARGETED ON PURPOSE, and that is the whole distinction from
     * {@link DatabaseAdapter.mutations.onConflict}: `createMany({
     * skipDuplicates: true })` promises to skip a row that collides with ANY
     * unique constraint, so naming one would be the wrong answer. A JUNCTION
     * membership insert asks the opposite question — skip only an exact repeat
     * of this complete `(owner, target)` key, and let a target-side UNIQUE
     * (a singular polymorphic member's occupied slot) raise — so it goes
     * through the targeted door instead. See `junctionDuplicateSkip` in
     * `query-engine/builders/many-to-many-utils.ts`; do not route it back here.
     */
    skipDuplicates: (duplicateNoopColumn: string) => {
      prefix: Sql;
      suffix: Sql;
    };
  };

  /**
   * ASSERTIONS
   * Dialect-specific statements that abort a batch when a precondition fails.
   */
  assertions: {
    /** Abort unless the provided SELECT returns at least one row. */
    exists: (query: Sql) => Sql;
    /** Abort unless the provided SELECT returns no rows. */
    notExists: (query: Sql) => Sql;
  };

  capabilities: DatabaseAdapterCapabilities;

  /**
   * LAST INSERT ID
   * Returns SQL for getting the last auto-generated ID.
   * Used only where the provider exposes an exact statement-local identity.
   *
   * PostgreSQL: lastval() exists for legacy/direct SQL uses, but batchRefs does not
   * expose it because another generated column or trigger can change the session value
   * SQLite: last_insert_rowid() - returns last ROWID inserted
   * MySQL: LAST_INSERT_ID() - returns last AUTO_INCREMENT value
   */
  lastInsertId: () => Sql;

  /**
   * BATCH REFS
   * @internal Temp/reference storage used by atomic batch plans to pass
   * generated values between statements without exposing dialect-specific SQL
   * to query-engine or user APIs.
   */
  batchRefs: BatchReferenceSqlAdapter;

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
   * VECTOR
   * Vector operations for similarity search (pgvector)
   *
   * Matches filter schema: { l2, cosine }
   * Drivers that don't support vector operations can override
   * this property with an object that throws FeatureNotSupportedError.
   *
   * Reserved — the query engine does not call these yet; vector filters are
   * rejected in the where-builder today.
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
   *
   * Reserved — the query engine does not call these yet; geospatial filters
   * are rejected in the where-builder today.
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

  result: AdapterResultParser;
}
