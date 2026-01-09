//#region src/migrations/types.d.ts
interface SchemaSnapshot {
  tables: TableDef[];
  enums?: EnumDef[] | undefined;
}
interface TableDef {
  name: string;
  columns: ColumnDef[];
  primaryKey?: PrimaryKeyDef | undefined;
  indexes: IndexDef[];
  foreignKeys: ForeignKeyDef[];
  uniqueConstraints: UniqueConstraintDef[];
}
interface ColumnDef {
  name: string;
  type: string;
  nullable: boolean;
  default?: string | undefined;
  autoIncrement?: boolean | undefined;
}
interface PrimaryKeyDef {
  columns: string[];
  name?: string | undefined;
}
interface IndexDef {
  name: string;
  columns: string[];
  unique: boolean;
  type?: "btree" | "hash" | "gin" | "gist" | undefined;
  where?: string | undefined;
}
interface ForeignKeyDef {
  name: string;
  columns: string[];
  referencedTable: string;
  referencedColumns: string[];
  onDelete?: ReferentialAction | undefined;
  onUpdate?: ReferentialAction | undefined;
}
type ReferentialAction = "cascade" | "setNull" | "restrict" | "noAction" | "setDefault";
interface UniqueConstraintDef {
  name: string;
  columns: string[];
}
interface EnumDef {
  name: string;
  values: string[];
}
type DiffOperation = {
  type: "createTable";
  table: TableDef;
} | {
  type: "dropTable";
  tableName: string;
} | {
  type: "renameTable";
  from: string;
  to: string;
} | {
  type: "addColumn";
  tableName: string;
  column: ColumnDef;
} | {
  type: "dropColumn";
  tableName: string;
  columnName: string;
} | {
  type: "renameColumn";
  tableName: string;
  from: string;
  to: string;
} | {
  type: "alterColumn";
  tableName: string;
  columnName: string;
  from: ColumnDef;
  to: ColumnDef;
} | {
  type: "createIndex";
  tableName: string;
  index: IndexDef;
} | {
  type: "dropIndex";
  indexName: string;
} | {
  type: "addForeignKey";
  tableName: string;
  fk: ForeignKeyDef;
} | {
  type: "dropForeignKey";
  tableName: string;
  fkName: string;
} | {
  type: "addUniqueConstraint";
  tableName: string;
  constraint: UniqueConstraintDef;
} | {
  type: "dropUniqueConstraint";
  tableName: string;
  constraintName: string;
} | {
  type: "addPrimaryKey";
  tableName: string;
  primaryKey: PrimaryKeyDef;
} | {
  type: "dropPrimaryKey";
  tableName: string;
  constraintName: string;
} | {
  type: "createEnum";
  enumDef: EnumDef;
} | {
  type: "dropEnum";
  enumName: string;
} | {
  type: "alterEnum";
  enumName: string;
  addValues?: string[] | undefined;
  removeValues?: string[] | undefined;
};
/** Detected when columns are added AND dropped in the same table */
type AmbiguousColumnChange = {
  type: "ambiguousColumn";
  tableName: string;
  droppedColumn: ColumnDef;
  addedColumn: ColumnDef;
};
/** Detected when tables are added AND dropped */
type AmbiguousTableChange = {
  type: "ambiguousTable";
  droppedTable: string;
  addedTable: string;
};
type AmbiguousChange = AmbiguousColumnChange | AmbiguousTableChange;
/** User's resolution for an ambiguous change */
type ChangeResolution = {
  type: "rename";
} | {
  type: "addAndDrop";
};
interface DiffResult {
  /** Operations that are unambiguous and ready to execute */
  operations: DiffOperation[];
  /** Changes that need user input to resolve */
  ambiguousChanges: AmbiguousChange[];
}
/** Callback to resolve ambiguous changes (used by CLI or programmatic API) */
type Resolver = (changes: AmbiguousChange[]) => Promise<Map<AmbiguousChange, ChangeResolution>>;
interface PushResult {
  /** All operations that were applied (or would be applied in dry-run) */
  operations: DiffOperation[];
  /** Whether the operations were actually applied to the database */
  applied: boolean;
  /** Generated SQL statements */
  sql: string[];
}
declare class MigrationError extends Error {
  readonly code?: string | undefined;
  constructor(message: string, code?: string | undefined);
}
//#endregion
//#region src/sql/sql.d.ts
/**
 * Values supported by SQL engine.
 */
type Value = unknown;
/**
 * Supported value or SQL instance.
 */
type RawValue = Value | Sql;
/**
 * A SQL instance can be nested within each other to build SQL strings.
 */
declare class Sql {
  readonly values: Value[];
  readonly strings: string[];
  constructor(rawStrings: readonly string[], rawValues: readonly RawValue[]);
  toStatement(placeholder?: "$n" | ":n" | "?"): string;
}
//#endregion
//#region src/adapters/database-adapter.d.ts
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
interface DatabaseAdapter {
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
    eq: (left: Sql, right: Sql) => Sql;
    neq: (left: Sql, right: Sql) => Sql;
    lt: (left: Sql, right: Sql) => Sql;
    lte: (left: Sql, right: Sql) => Sql;
    gt: (left: Sql, right: Sql) => Sql;
    gte: (left: Sql, right: Sql) => Sql;
    like: (column: Sql, pattern: Sql) => Sql;
    notLike: (column: Sql, pattern: Sql) => Sql;
    /** Case-insensitive LIKE (PG: ILIKE, MySQL: LIKE, SQLite: LIKE COLLATE NOCASE) */
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
  /**
   * EXPRESSIONS
   * Computed values and functions
   */
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
    with: (definitions: {
      name: string;
      query: Sql;
    }[]) => Sql;
    /** Build recursive CTE: WITH RECURSIVE name AS (anchor UNION ALL recursive) */
    recursive: (name: string, anchor: Sql, recursive: Sql, union?: "all" | "distinct") => Sql;
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
}
/**
 * Migration-specific adapter methods
 */
interface MigrationAdapter {
  /** Introspect current database schema */
  introspect: (executeRaw: <T>(sql: string, params?: unknown[]) => Promise<{
    rows: T[];
  }>) => Promise<SchemaSnapshot>;
  /** Generate DDL SQL string for a diff operation */
  generateDDL: (operation: DiffOperation) => string;
  /** Map VibORM field type to native SQL type */
  mapFieldType: (fieldType: string, options?: {
    array?: boolean;
    autoIncrement?: boolean;
  }) => string;
}
/**
 * Type for query parts assembly
 */
interface QueryParts {
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
interface InsertParts {
  table: Sql;
  columns: string[];
  values: Sql[][];
  onConflict?: Sql;
  returning?: Sql;
}
/**
 * Type for update parts assembly
 */
interface UpdateParts {
  table: Sql;
  set: Sql;
  where?: Sql;
  returning?: Sql;
}
/**
 * Type for delete parts assembly
 */
interface DeleteParts {
  table: Sql;
  where?: Sql;
  returning?: Sql;
}
//#endregion
export { SchemaSnapshot as C, Resolver as S, UniqueConstraintDef as T, IndexDef as _, QueryParts as a, PushResult as b, AmbiguousChange as c, ChangeResolution as d, ColumnDef as f, ForeignKeyDef as g, EnumDef as h, MigrationAdapter as i, AmbiguousColumnChange as l, DiffResult as m, DeleteParts as n, UpdateParts as o, DiffOperation as p, InsertParts as r, Sql as s, DatabaseAdapter as t, AmbiguousTableChange as u, MigrationError as v, TableDef as w, ReferentialAction as x, PrimaryKeyDef as y };
//# sourceMappingURL=database-adapter-C-t7bvr_.d.mts.map