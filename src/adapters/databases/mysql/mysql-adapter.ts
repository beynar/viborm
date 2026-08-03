import { unsupportedGeospatial, unsupportedVector } from "@errors";
import { type Sql, sql } from "@sql";
import type { DatabaseAdapter, QueryParts } from "../../database-adapter";
import { createMySqlBatchRefs } from "../../shared/batch-refs";
import {
  normalizeCountResult,
  parseIntegerBoolean,
  tryParseJsonString,
} from "../../shared/result-parsing";
import {
  assembleDistinctOnEmulation,
  assembleSelectQuery,
} from "../../shared/select-assembly";
import {
  buildJsonPath,
  createAggregateFunctions,
  createCastExpression,
  createCommonExpressions,
  createComparisonOperators,
  createCoreJoins,
  createCteBuilders,
  createDirectionOrderBy,
  createEmulatedNullsOrderBy,
  createExistenceOperators,
  createIdentifierQuoter,
  createIdentifiers,
  createInsertStatement,
  createLateralJoins,
  createLogicalOperators,
  createMembershipOperators,
  createMutationCommands,
  createNullOperators,
  createNumericSetOperations,
  createRangeOperators,
  createRawSql,
  createRelationFilters,
  createSetOperations,
  createStandardClauses,
  createStandardLiterals,
  createSubqueries,
  escapeLikeLiteral,
  stringifyJson,
} from "../../shared/standard-sql";

const quoteIdent = createIdentifierQuoter("`");
const ASCII_UPPERCASE = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const ASCII_LOWERCASE = "abcdefghijklmnopqrstuvwxyz";

const asciiCaseFold = (expr: Sql): Sql => {
  let folded = expr;
  for (let index = 0; index < ASCII_UPPERCASE.length; index++) {
    const upper = sql.raw`'${ASCII_UPPERCASE[index]}'`;
    const lower = sql.raw`'${ASCII_LOWERCASE[index]}'`;
    folded = sql`REPLACE(${folded}, ${upper}, ${lower})`;
  }
  return folded;
};

// MySQL DATETIME rejects ISO-8601's 'Z' suffix ("Incorrect datetime value"),
// so datetimes are stored as naive UTC wall-clock 'YYYY-MM-DD HH:MM:SS.mmm'.
const toMySqlDateTime = (iso: string): string =>
  new Date(iso).toISOString().slice(0, 23).replace("T", " ");

// Naive datetime string as it comes back from MySQL (top-level on string
// drivers, or inside JSON_ARRAYAGG/JSON_OBJECT includes): no 'Z'/offset.
const NAIVE_DATETIME_REGEX =
  /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(\.\d+)?$/;

/** Reattach UTC to a naive MySQL datetime string so it parses as the stored instant. */
const naiveDateTimeToIso = (value: string): string | undefined => {
  const match = NAIVE_DATETIME_REGEX.exec(value);
  if (!match) return undefined;
  const fraction = match[3] ? match[3].padEnd(4, "0").slice(0, 4) : ".000";
  return `${match[1]}T${match[2]}${fraction}Z`;
};

/** Replace a single-integer-parameter fragment with an inline literal. */
const inlineIntegerLiteral = (fragment: Sql): Sql => {
  const value = fragment.values.length === 1 ? fragment.values[0] : undefined;
  return typeof value === "number" && Number.isInteger(value)
    ? sql.raw`${String(value)}`
    : fragment;
};

/**
 * MySQL Database Adapter
 *
 * Implements the DatabaseAdapter interface for MySQL-specific SQL generation.
 *
 * Key MySQL features:
 * - Backtick identifier escaping: `table`.`column`
 * - No native ARRAY type - uses JSON for arrays
 * - Portable string filters override the database collation explicitly
 * - JSON_OBJECT(), JSON_ARRAYAGG() for JSON operations
 * - No RETURNING clause (use LAST_INSERT_ID())
 * - No NULLS FIRST/LAST ordering
 * - ON DUPLICATE KEY UPDATE for upserts
 */
export class MySQLAdapter implements DatabaseAdapter {
  // ============================================================
  // RAW
  // ============================================================

  raw = createRawSql();

  // ============================================================
  // IDENTIFIERS
  // ============================================================

  identifiers = createIdentifiers(quoteIdent);

  // ============================================================
  // LITERALS
  // ============================================================

  literals = {
    ...createStandardLiterals(),

    true: (): Sql => sql.raw`TRUE`,

    false: (): Sql => sql.raw`FALSE`,

    // MySQL requires JSON values to be stringified
    json: (v: unknown): Sql => sql`${JSON.stringify(v)}`,

    dateTime: (iso: string): Sql => sql`${toMySqlDateTime(iso)}`,

    // The cast is load-bearing, not decoration. MySQL's comparison rules say
    // that when one side is a number and the other a string, BOTH are converted
    // to double and compared as floating point — so `amount = '0.1'` against a
    // DECIMAL(65,30) column would silently answer at float precision on an
    // otherwise exact column. Casting the operand keeps the whole comparison in
    // MySQL's exact decimal domain, at the same 65/30 the DDL uses.
    decimal: (canonical: string): Sql =>
      sql`CAST(${canonical} AS DECIMAL(65,30))`,
  };

  // ============================================================
  // OPERATORS
  // ============================================================

  operators = {
    // Comparison
    ...createComparisonOperators(),

    // Pattern matching
    // Explicit ESCAPE '\' pairs with wildcard escaping in the where-builder.
    // The literal is doubled ('\\') because MySQL's default mode treats
    // backslash as a string-literal escape; under NO_BACKSLASH_ESCAPES it
    // fails loudly rather than silently matching wildcards.
    like: (column: Sql, pattern: Sql): Sql =>
      sql`${column} LIKE ${pattern} ESCAPE '\\\\'`,
    notLike: (column: Sql, pattern: Sql): Sql =>
      sql`${column} NOT LIKE ${pattern} ESCAPE '\\\\'`,
    ilike: (column: Sql, pattern: Sql): Sql =>
      sql`${asciiCaseFold(column)} LIKE ${asciiCaseFold(pattern)} ESCAPE '\\\\'`,
    notIlike: (column: Sql, pattern: Sql): Sql =>
      sql`${asciiCaseFold(column)} NOT LIKE ${asciiCaseFold(pattern)} ESCAPE '\\\\'`,
    containsText: (column: Sql, value: Sql): Sql =>
      sql`LOCATE(BINARY ${value}, BINARY ${column}) > 0`,
    startsWithText: (column: Sql, value: Sql): Sql =>
      sql`LEFT(BINARY ${column}, OCTET_LENGTH(${value})) = BINARY ${value}`,
    endsWithText: (column: Sql, value: Sql): Sql =>
      sql`RIGHT(BINARY ${column}, OCTET_LENGTH(${value})) = BINARY ${value}`,
    // Two conjuncts, because on MySQL no single predicate is both exact and
    // index-usable. The index stores the column's own collation's sort keys —
    // `utf8mb4_0900_ai_ci` on a default install, which is case- AND
    // accent-insensitive — so any comparison forced to BINARY cannot range on
    // it. Measured on MySQL 8 (Docker, 20k rows): `col LIKE 'x%'` is a `range`
    // over 111 rows, while both `col LIKE BINARY 'x%'` and the
    // `LEFT(BINARY col, …)` spelling above degrade to a full `index` scan of
    // all 19731 entries.
    //
    // So the collation-native LIKE goes first as an index accelerator, and the
    // BINARY predicate — byte-identical to `startsWithText` above — follows as
    // the semantics. The accelerator can never drop a row the BINARY conjunct
    // would keep: byte-equal strings compare equal under every collation, so a
    // binary prefix match implies the collation-native one. It is not a second
    // guard on the same invariant — it decides no row's membership, only which
    // rows the server has to look at.
    //
    // Parenthesized because this fragment gets composed into AND/OR chains.
    startsWithPrefix: (column: Sql, value: string): Sql =>
      sql`(${column} LIKE ${`${escapeLikeLiteral(value)}%`} ESCAPE '\\\\' AND LEFT(BINARY ${column}, OCTET_LENGTH(${value})) = BINARY ${value})`,

    // Set membership
    ...createMembershipOperators(),

    // Null checks
    ...createNullOperators(),

    // Range
    ...createRangeOperators(),

    // Logical
    ...createLogicalOperators(this.literals.true, this.literals.false),

    // Subquery existence
    ...createExistenceOperators(),
  };

  // ============================================================
  // EXPRESSIONS
  // ============================================================

  expressions = {
    ...createCommonExpressions(),

    asciiCaseFold,
    caseSensitiveText: (expr: Sql): Sql => sql`BINARY ${expr}`,

    // String operations - MySQL uses CONCAT() function
    concat: (...parts: Sql[]): Sql => {
      if (parts.length === 0) return sql.raw`''`;
      if (parts.length === 1) return parts[0]!;
      return sql`CONCAT(${sql.join(parts, ", ")})`;
    },

    greatest: (...exprs: Sql[]): Sql => sql`GREATEST(${sql.join(exprs, ", ")})`,
    least: (...exprs: Sql[]): Sql => sql`LEAST(${sql.join(exprs, ", ")})`,

    // MySQL type mappings - MySQL doesn't support TEXT in CAST
    cast: createCastExpression({
      text: "CHAR",
      integer: "SIGNED",
      boolean: "UNSIGNED",
      numeric: "DECIMAL",
      // NOT the bare `DECIMAL` above: bare `DECIMAL` is `DECIMAL(10,0)`, which
      // rounds every fraction away. The exact-decimal cast carries the same
      // 65/30 the DDL and `literals.decimal` use.
      decimal: "DECIMAL(65,30)",
    }),

    blobToHex: (expr: Sql): Sql => sql`LOWER(HEX(${expr}))`,
  };

  // ============================================================
  // AGGREGATES
  // ============================================================

  aggregates = createAggregateFunctions();

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

    emptyArray: (): Sql => sql.raw`JSON_ARRAY()`,

    agg: (expr: Sql): Sql =>
      sql`COALESCE(JSON_ARRAYAGG(${expr}), JSON_ARRAY())`,

    objectFromColumns: (columns: [string, Sql][]): Sql => {
      if (columns.length === 0) return sql.raw`JSON_OBJECT()`;
      const args = columns.flatMap(([key, value]) => [sql`${key}`, value]);
      return sql`JSON_OBJECT(${sql.join(args, ", ")})`;
    },

    // buildJsonPath quotes/escapes key segments and maps integer segments
    // to array indices; '$' alone extracts the document root
    extract: (column: Sql, path: string[]): Sql =>
      sql`JSON_EXTRACT(${column}, ${buildJsonPath(path)})`,

    extractText: (column: Sql, path: string[]): Sql =>
      sql`JSON_UNQUOTE(JSON_EXTRACT(${column}, ${buildJsonPath(path)}))`,

    // JSON_TYPE spells numbers three ways depending on how the literal was
    // stored; anything else (including an absent path, where JSON_TYPE is
    // NULL) falls through the CASE to NULL
    numberAtPath: (column: Sql, path: string[]): Sql => {
      const jsonPath = buildJsonPath(path);
      return sql`(CASE WHEN JSON_TYPE(JSON_EXTRACT(${column}, ${jsonPath})) IN ('INTEGER', 'DOUBLE', 'DECIMAL') THEN CAST(JSON_UNQUOTE(JSON_EXTRACT(${column}, ${jsonPath})) AS DOUBLE) END)`;
    },

    // CAST(... AS BINARY) yields VARBINARY, so < / > compare bytes instead of
    // the column's (case- and accent-insensitive by default) collation
    stringAtPath: (column: Sql, path: string[]): Sql => {
      const jsonPath = buildJsonPath(path);
      return sql`(CASE WHEN JSON_TYPE(JSON_EXTRACT(${column}, ${jsonPath})) = 'STRING' THEN CAST(JSON_UNQUOTE(JSON_EXTRACT(${column}, ${jsonPath})) AS BINARY) END)`;
    },

    contains: (target: Sql, value: Sql): Sql =>
      sql`JSON_CONTAINS(${target}, ${value})`,

    lastElement: (target: Sql): Sql => sql`JSON_EXTRACT(${target}, '$[last]')`,

    // Comparing a JSON column to a plain string coerces the string to a JSON
    // string scalar (always-false for documents); CAST parses it as JSON
    value: (v: unknown): Sql => sql`CAST(${stringifyJson(v)} AS JSON)`,
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

    value: (values: unknown[]): Sql =>
      sql`CAST(${stringifyJson(values)} AS JSON)`,

    // JSON_CONTAINS requires a JSON document as candidate; a bare string
    // parameter throws ER_INVALID_JSON_TEXT. JSON_ARRAY keeps the parameter's
    // type (strings quoted, numbers not): [x] ⊆ column ⟺ x ∈ column
    has: (column: Sql, value: Sql): Sql =>
      sql`JSON_CONTAINS(${column}, JSON_ARRAY(${value}))`,

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
    ...createDirectionOrderBy(),
    // MySQL doesn't support NULLS FIRST/LAST natively - emulated
    ...createEmulatedNullsOrderBy(),
  };

  // ============================================================
  // CLAUSES
  // ============================================================

  // mysql2's binary protocol binds JS numbers as DOUBLE, which MySQL rejects
  // in integer-only positions ("Incorrect arguments to mysqld_stmt_execute").
  // Inline integer LIMIT/OFFSET values instead of parameterizing them.
  clauses = {
    ...createStandardClauses(),
    limit: (count: Sql): Sql => sql`LIMIT ${inlineIntegerLiteral(count)}`,
    offset: (count: Sql): Sql => sql`OFFSET ${inlineIntegerLiteral(count)}`,
  };

  // ============================================================
  // SET (UPDATE operations)
  // ============================================================

  // JSON_MERGE_PRESERVE concatenates arrays element-wise; JSON_ARRAY_APPEND
  // would append the whole param as a single (stringified) element.
  set = {
    ...createNumericSetOperations(),

    // MySQL `/` yields DECIMAL and rounds when assigned to an integer column.
    // Truncate explicitly so integer division matches PostgreSQL and SQLite.
    divide: (column: Sql, by: Sql, columnIsInteger?: boolean): Sql =>
      columnIsInteger
        ? sql`${column} = TRUNCATE(${column} / ${by}, 0)`
        : sql`${column} = ${column} / ${by}`,

    push: (column: Sql, values: unknown[]): Sql =>
      sql`${column} = JSON_MERGE_PRESERVE(COALESCE(${column}, JSON_ARRAY()), CAST(${stringifyJson(values)} AS JSON))`,

    unshift: (column: Sql, values: unknown[]): Sql =>
      sql`${column} = JSON_MERGE_PRESERVE(CAST(${stringifyJson(values)} AS JSON), COALESCE(${column}, JSON_ARRAY()))`,
  };

  // ============================================================
  // FILTERS (Relation subquery wrappers)
  // ============================================================

  filters = createRelationFilters();

  // ============================================================
  // SUBQUERIES
  // ============================================================

  subqueries = createSubqueries(quoteIdent);

  // ============================================================
  // ASSEMBLE (Build complete SQL statements)
  // ============================================================

  // MySQL has no bare OFFSET; per the manual, use an all-ones LIMIT sentinel
  noLimitValue = sql.raw`18446744073709551615`;

  assemble = {
    select: (rawParts: QueryParts): Sql => {
      // Inline integer LIMIT/OFFSET (see clauses above for why)
      const parts: QueryParts = {
        ...rawParts,
        limit: rawParts.limit && inlineIntegerLiteral(rawParts.limit),
        offset: rawParts.offset && inlineIntegerLiteral(rawParts.offset),
      };

      // MySQL doesn't support DISTINCT ON natively
      // Simulate using ROW_NUMBER() OVER (PARTITION BY ... ORDER BY ...)
      if (parts.distinct) {
        return assembleDistinctOnEmulation(
          parts,
          parts.distinct,
          this.identifiers.escape,
          this.noLimitValue
        );
      }

      return assembleSelectQuery(sql`SELECT ${parts.columns}`, parts, {
        forUpdate: "append",
        noLimitValue: this.noLimitValue,
      });
    },
  };

  // ============================================================
  // CTE (Common Table Expressions - MySQL 8.0+)
  // ============================================================

  cte = createCteBuilders(quoteIdent);

  // ============================================================
  // MUTATIONS
  // ============================================================

  mutations = {
    skipDuplicatesStrategy: "recoverableUniqueError" as const,
    insert: createInsertStatement(quoteIdent),
    insertDefault: (table: Sql): Sql => sql`INSERT INTO ${table} () VALUES ()`,

    ...createMutationCommands(),

    // MySQL doesn't support RETURNING - returns empty
    // Use LAST_INSERT_ID() or SELECT after mutation
    returning: (_columns: Sql): Sql => sql.empty,

    // This low-level MySQL primitive ignores `_target`: ON DUPLICATE KEY UPDATE
    // fires on any unique collision. Public non-returning upserts therefore do
    // not execute this primitive; the query engine uses a locked, target-aware
    // branch so an unrelated unique collision still throws on every database.
    onConflict: (_target: Sql | null, action: Sql, _targetWhere?: Sql): Sql => {
      return sql`ON DUPLICATE KEY UPDATE ${action}`;
    },

    // MySQL doesn't need UPDATE SET prefix - onConflict already includes UPDATE
    onConflictUpdate: (sets: Sql, _setWhere?: Sql): Sql => sets,

    // A self-assignment reacts only to duplicate-key conflicts. Unlike
    // INSERT IGNORE, unrelated constraint and conversion failures still abort.
    skipDuplicates: (duplicateNoopColumn: string) => {
      const column = sql.raw`${quoteIdent(duplicateNoopColumn)}`;
      return {
        prefix: sql.empty,
        suffix: sql`ON DUPLICATE KEY UPDATE ${column} = ${column}`,
      };
    },
  };

  assertions = {
    exists: (query: Sql): Sql =>
      sql`SELECT CASE WHEN EXISTS (${query}) THEN 1 ELSE JSON_EXTRACT('x', '$') END AS \`__viborm_assert__\``,
    notExists: (query: Sql): Sql =>
      sql`SELECT CASE WHEN NOT EXISTS (${query}) THEN 1 ELSE JSON_EXTRACT('x', '$') END AS \`__viborm_assert__\``,
  };

  // ============================================================
  // JOINS
  // ============================================================

  joins = {
    ...createCoreJoins(),

    // MySQL doesn't support FULL OUTER JOIN (would need a UNION of LEFT and
    // RIGHT joins). Never silently downgrade to LEFT JOIN: that drops rows.
    // The query engine never calls this today.
    full: (_table: Sql, _condition: Sql): Sql => {
      throw new Error(
        "MySQL does not support FULL OUTER JOIN. Check adapter.capabilities.supportsFullOuterJoin before calling."
      );
    },

    // MySQL 8.0.14+ supports LATERAL
    ...createLateralJoins(quoteIdent),
  };

  // ============================================================
  // SET OPERATIONS
  // ============================================================

  setOperations = createSetOperations();

  // ============================================================
  // CAPABILITIES
  // ============================================================

  capabilities = {
    supportsReturning: false,
    supportsCteWithMutations: false, // MySQL CTEs are read-only
    supportsFullOuterJoin: false,
    supportsLateralJoins: true, // MySQL 8.0.14+
    supportsVector: false,
    supportsUpsertWhere: false, // ON DUPLICATE KEY UPDATE doesn't support WHERE clauses
    // ERROR 1093: UPDATE/DELETE can't select from the mutated table in a
    // subquery. The engine wraps relation-filter subqueries in a derived
    // table when this is false (requires MySQL 8.0.14+ for outer references
    // in derived tables).
    supportsMutationTargetInSubquery: false,
    // MySQL's single-table UPDATE/DELETE take a native LIMIT, which is also the
    // only portable spelling here: the PK-subquery form would re-read the
    // mutated table and trip the same ERROR 1093 as above.
    supportsMutationRowLimit: true,
    supportsExactDecimal: true, // `DECIMAL(65,30)`: exact, fixed precision
  };

  lastInsertId = (): Sql => sql.raw`LAST_INSERT_ID()`;

  batchRefs = createMySqlBatchRefs({
    table: sql.raw`\`__viborm_batch_refs\``,
    batchIdColumn: sql.raw`\`batch_id\``,
    keyColumn: sql.raw`\`ref_key\``,
    valueColumn: sql.raw`\`ref_value\``,
    duplicateValue: sql.raw`VALUES(\`ref_value\`)`,
    createTable: sql.raw`CREATE TEMPORARY TABLE IF NOT EXISTS \`__viborm_batch_refs\` (\`batch_id\` VARCHAR(191) NOT NULL, \`ref_key\` VARCHAR(191) NOT NULL, \`ref_value\` TEXT, PRIMARY KEY (\`batch_id\`, \`ref_key\`))`,
    castValue: (valueSql) => sql`CAST((${valueSql}) AS CHAR)`,
    lastInsertId: () => this.lastInsertId(),
  });

  // ============================================================
  // VECTOR (not natively supported in MySQL)
  // ============================================================

  vector = unsupportedVector;

  // ============================================================
  // GEOSPATIAL (not natively supported in MySQL adapter)
  // ============================================================

  geospatial = unsupportedGeospatial;

  // ============================================================
  // RESULT PARSING
  // MySQL: Parse JSON strings, convert 0/1 to booleans
  // ============================================================

  result = {
    parseResult: (
      raw: unknown,
      operation: import("../../../query-engine/types").Operation,
      next: (value?: unknown) => unknown
    ): unknown => {
      // Normalize raw count expressions to VibORM's private result carrier.
      if (operation === "count" || operation === "exist") {
        const normalized = normalizeCountResult(raw);
        if (normalized) {
          return next(normalized);
        }
      }
      return next();
    },

    parseRelation: (
      value: unknown,
      _type: import("../../../schema/relation/types").RelationType,
      next: (value?: unknown) => unknown
    ): unknown => {
      // MySQL returns JSON as strings - parse before delegating
      const parsed = tryParseJsonString(value);
      if (parsed !== undefined) {
        return next(parsed);
      }
      return next();
    },

    parseField: (
      value: unknown,
      scalarType: string,
      next: (value?: unknown) => unknown
    ): unknown => {
      // MySQL stores booleans as TINYINT(1) - 0/1
      if (scalarType === "boolean") {
        const parsed = parseIntegerBoolean(value);
        if (parsed !== undefined) {
          return next(parsed);
        }
      }
      // Datetime strings are naive UTC wall-clock; without this, the default
      // parser's new Date(str) would shift them by the process timezone
      if (scalarType === "datetime" && typeof value === "string") {
        const iso = naiveDateTimeToIso(value);
        if (iso !== undefined) {
          return next(iso);
        }
      }
      return next();
    },
  };
}

// Export singleton instance
export const mysqlAdapter = new MySQLAdapter();
