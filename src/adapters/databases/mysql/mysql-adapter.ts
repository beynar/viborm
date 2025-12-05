import { Sql, sql } from "@sql";
import { DatabaseAdapter, QueryClauses } from "../../database-adapter";
import { BuilderContext } from "../../../query-parser/types";
import { QueryMode } from "../../../types/query/filters-input";

/**
 * MySQL Database Adapter
 *
 * Implements MySQL-specific SQL generation including:
 * - MySQL backtick identifier escaping
 * - MySQL syntax for queries and operations
 * - MySQL-specific functions and operators
 * - Proper handling of MySQL data types
 */
export class MySQLAdapter implements DatabaseAdapter {
  // ================================
  // UTILITY METHODS
  // ================================

  /**
   * Creates a column accessor for the current context
   * Returns mysql-style backtick identifiers for safe SQL composition
   */
  private column(ctx: BuilderContext): Sql {
    return this.identifiers.column(ctx.alias, ctx.fieldName!);
  }

  // ================================
  // IDENTIFIER ESCAPING (MySQL-specific backticks)
  // ================================

  identifiers = {
    escape: (identifier: string): Sql => sql.raw`\`${identifier}\``,
    column: (alias: string, field: string): Sql =>
      sql.raw`\`${alias}\`.\`${field}\``,
    table: (tableName: string, alias: string): Sql =>
      sql.raw`\`${tableName}\` AS \`${alias}\``,
    aliased: (expression: Sql, alias: string): Sql =>
      sql`${expression} AS \`${alias}\``,
  };

  // ================================
  // OPERATIONS (MySQL-specific implementations)
  // ================================

  operations = {
    findMany: (ctx: BuilderContext, clauses: QueryClauses): Sql => {
      const parts = [clauses.select, clauses.from];

      if (clauses.where) parts.push(clauses.where);
      if (clauses.orderBy) parts.push(clauses.orderBy);
      if (clauses.limit) parts.push(clauses.limit);

      return sql.join(parts, " ");
    },

    findFirst: (ctx: BuilderContext, clauses: QueryClauses): Sql => {
      const parts = [clauses.select, clauses.from];

      if (clauses.where) parts.push(clauses.where);
      if (clauses.orderBy) parts.push(clauses.orderBy);

      // MySQL LIMIT 1
      parts.push(sql`LIMIT 1`);

      return sql.join(parts, " ");
    },

    findUnique: (ctx: BuilderContext, clauses: QueryClauses): Sql => {
      const parts = [clauses.select, clauses.from];

      if (clauses.where) parts.push(clauses.where);

      // MySQL LIMIT 1
      parts.push(sql`LIMIT 1`);

      return sql.join(parts, " ");
    },

    findUniqueOrThrow: (ctx: BuilderContext, clauses: QueryClauses): Sql => {
      return this.operations.findUnique(ctx, clauses);
    },

    findFirstOrThrow: (ctx: BuilderContext, clauses: QueryClauses): Sql => {
      return this.operations.findFirst(ctx, clauses);
    },

    create: (ctx: BuilderContext, payload: any): Sql => {
      const tableName = ctx.model["~"].tableName || ctx.model.name;
      // MySQL doesn't have RETURNING, but we can simulate with SELECT
      return sql`INSERT INTO ${this.identifiers.escape(
        tableName
      )} ${sql.spreadValues(payload.data)}`;
    },

    createMany: (ctx: BuilderContext, payload: any): Sql => {
      const tableName = ctx.model["~"].tableName || ctx.model.name;
      return sql`INSERT INTO ${this.identifiers.escape(
        tableName
      )} ${sql.spreadValues(payload.data)}`;
    },

    update: (ctx: BuilderContext, clauses: QueryClauses): Sql => {
      const tableName = ctx.model["~"].tableName || ctx.model.name;
      const data = (ctx as any).data || {};

      const setClause = sql.join(
        Object.entries(data).map(
          ([field, value]) => sql`${this.identifiers.escape(field)} = ${value}`
        ),
        ", "
      );

      const parts = [
        sql`UPDATE ${this.identifiers.escape(tableName)} SET ${setClause}`,
      ];

      if (clauses.where) parts.push(clauses.where);

      return sql.join(parts, " ");
    },

    updateMany: (ctx: BuilderContext, clauses: QueryClauses): Sql => {
      return this.operations.update(ctx, clauses);
    },

    delete: (ctx: BuilderContext, clauses: QueryClauses): Sql => {
      const tableName = ctx.model["~"].tableName || ctx.model.name;

      const parts = [sql`DELETE FROM ${this.identifiers.escape(tableName)}`];

      if (clauses.where) parts.push(clauses.where);

      return sql.join(parts, " ");
    },

    deleteMany: (ctx: BuilderContext, clauses: QueryClauses): Sql => {
      return this.operations.delete(ctx, clauses);
    },

    upsert: (ctx: BuilderContext, payload: any): Sql => {
      const tableName = ctx.model["~"].tableName || ctx.model.name;

      // MySQL ON DUPLICATE KEY UPDATE
      const updateClause = sql.join(
        Object.entries(payload.update).map(
          ([field, value]) => sql`${this.identifiers.escape(field)} = ${value}`
        ),
        ", "
      );

      return sql`INSERT INTO ${this.identifiers.escape(
        tableName
      )} ${sql.spreadValues(
        payload.create
      )} ON DUPLICATE KEY UPDATE ${updateClause}`;
    },

    count: (ctx: BuilderContext, clauses: QueryClauses): Sql => {
      const parts = [clauses.select, clauses.from];

      if (clauses.where) parts.push(clauses.where);

      return sql.join(parts, " ");
    },

    aggregate: (ctx: BuilderContext, clauses: QueryClauses): Sql => {
      const parts = [clauses.select, clauses.from];

      if (clauses.where) parts.push(clauses.where);

      return sql.join(parts, " ");
    },

    groupBy: (ctx: BuilderContext, clauses: QueryClauses): Sql => {
      const parts = [clauses.select, clauses.from];

      if (clauses.where) parts.push(clauses.where);

      return sql.join(parts, " ");
    },

    exist: (ctx: BuilderContext, clauses: QueryClauses): Sql => {
      // Build inner query: SELECT 1 FROM table WHERE conditions LIMIT 1
      const innerParts = [sql`SELECT`, clauses.select, sql`FROM`, clauses.from];

      if (clauses.where) innerParts.push(sql`WHERE`, clauses.where);
      if (clauses.limit) innerParts.push(clauses.limit);

      const innerQuery = sql.join(innerParts, " ");

      // Wrap in EXISTS: SELECT EXISTS(inner_query)
      return sql`SELECT EXISTS(${innerQuery})`;
    },
  };

  // ================================
  // UTILITIES (MySQL-specific)
  // ================================

  utils = {
    coalesce: (ctx: BuilderContext, statement: Sql): Sql =>
      sql`COALESCE(${statement}, '')`,
    escape: (ctx: BuilderContext, statement: Sql): Sql => sql`${statement}`,
    jsonObject: (ctx: BuilderContext, statement: Sql): Sql =>
      sql`JSON_OBJECT(${statement})`,
    wrap: (ctx: BuilderContext, statement: Sql): Sql =>
      sql.wrap("(", statement, ")"),
    jsonArray: (ctx: BuilderContext, statement: Sql): Sql =>
      sql`JSON_ARRAY(${statement})`,
    exists: (ctx: BuilderContext, statement: Sql): Sql =>
      sql`EXISTS(${statement})`,
    caseInsensitive: (ctx: BuilderContext, statement: Sql): Sql =>
      sql`UPPER(${statement})`,
  };

  // ================================
  // OPERATORS
  // ================================

  operators = {
    // Comparison operators
    eq: (ctx: BuilderContext, left: Sql, right: Sql): Sql =>
      sql`${left} = ${right}`,
    neq: (ctx: BuilderContext, left: Sql, right: Sql): Sql =>
      sql`${left} != ${right}`,
    lt: (ctx: BuilderContext, left: Sql, right: Sql): Sql =>
      sql`${left} < ${right}`,
    lte: (ctx: BuilderContext, left: Sql, right: Sql): Sql =>
      sql`${left} <= ${right}`,
    gt: (ctx: BuilderContext, left: Sql, right: Sql): Sql =>
      sql`${left} > ${right}`,
    gte: (ctx: BuilderContext, left: Sql, right: Sql): Sql =>
      sql`${left} >= ${right}`,

    // Pattern matching operators
    like: (ctx: BuilderContext, column: Sql, pattern: Sql): Sql =>
      sql`${column} LIKE ${pattern}`,
    ilike: (ctx: BuilderContext, column: Sql, pattern: Sql): Sql =>
      sql`${column} LIKE ${pattern} COLLATE utf8mb4_unicode_ci`,
    notLike: (ctx: BuilderContext, column: Sql, pattern: Sql): Sql =>
      sql`${column} NOT LIKE ${pattern}`,
    notIlike: (ctx: BuilderContext, column: Sql, pattern: Sql): Sql =>
      sql`${column} NOT LIKE ${pattern} COLLATE utf8mb4_unicode_ci`,

    // Range operators
    between: (ctx: BuilderContext, column: Sql, min: Sql, max: Sql): Sql =>
      sql`${column} BETWEEN ${min} AND ${max}`,
    notBetween: (ctx: BuilderContext, column: Sql, min: Sql, max: Sql): Sql =>
      sql`${column} NOT BETWEEN ${min} AND ${max}`,

    // Regular expression operators (MySQL-specific)
    regexp: (ctx: BuilderContext, column: Sql, pattern: Sql): Sql =>
      sql`${column} REGEXP ${pattern}`,
    notRegexp: (ctx: BuilderContext, column: Sql, pattern: Sql): Sql =>
      sql`${column} NOT REGEXP ${pattern}`,

    // Set membership operators
    in: (ctx: BuilderContext, column: Sql, values: Sql): Sql =>
      sql`${column} IN (${values})`,
    notIn: (ctx: BuilderContext, column: Sql, values: Sql): Sql =>
      sql`${column} NOT IN (${values})`,

    // Logical operators
    and: (ctx: BuilderContext, ...conditions: Sql[]): Sql => {
      if (conditions.length === 0) return sql.empty;
      if (conditions.length === 1) return conditions[0]!;
      return sql`(${sql.join(conditions, " AND ")})`;
    },
    or: (ctx: BuilderContext, ...conditions: Sql[]): Sql => {
      if (conditions.length === 0) return sql.empty;
      if (conditions.length === 1) return conditions[0]!;
      return sql`(${sql.join(conditions, " OR ")})`;
    },
    not: (ctx: BuilderContext, condition: Sql): Sql => sql`NOT (${condition})`,

    // Null operators
    isNull: (ctx: BuilderContext, column: Sql): Sql => sql`${column} IS NULL`,
    isNotNull: (ctx: BuilderContext, column: Sql): Sql =>
      sql`${column} IS NOT NULL`,

    // Existence operators for subqueries
    exists: (ctx: BuilderContext, subquery: Sql): Sql =>
      sql`EXISTS (${subquery})`,
    notExists: (ctx: BuilderContext, subquery: Sql): Sql =>
      sql`NOT EXISTS (${subquery})`,
  };

  // ================================
  // AGGREGATE FUNCTIONS
  // ================================

  aggregates = {
    count: (ctx: BuilderContext, expression?: Sql): Sql =>
      expression ? sql`COUNT(${expression})` : sql`COUNT(*)`,
    sum: (ctx: BuilderContext, expression: Sql): Sql => sql`SUM(${expression})`,
    avg: (ctx: BuilderContext, expression: Sql): Sql => sql`AVG(${expression})`,
    min: (ctx: BuilderContext, expression: Sql): Sql => sql`MIN(${expression})`,
    max: (ctx: BuilderContext, expression: Sql): Sql => sql`MAX(${expression})`,
  };

  // ================================
  // UPDATE OPERATIONS (MySQL-specific)
  // ================================

  updates = {
    string: {
      set: (ctx: BuilderContext, value: string, mode?: QueryMode): Sql =>
        sql`${value}`,
    },

    number: {
      set: (ctx: BuilderContext, value: number): Sql => sql`${value}`,
      increment: (ctx: BuilderContext, value: number): Sql =>
        sql`${this.column(ctx)} + ${value}`,
      decrement: (ctx: BuilderContext, value: number): Sql =>
        sql`${this.column(ctx)} - ${value}`,
      multiply: (ctx: BuilderContext, value: number): Sql =>
        sql`${this.column(ctx)} * ${value}`,
      divide: (ctx: BuilderContext, value: number): Sql =>
        sql`${this.column(ctx)} / ${value}`,
    },

    decimal: {
      set: (ctx: BuilderContext, value: number): Sql => sql`${value}`,
      increment: (ctx: BuilderContext, value: number): Sql =>
        sql`${this.column(ctx)} + ${value}`,
      decrement: (ctx: BuilderContext, value: number): Sql =>
        sql`${this.column(ctx)} - ${value}`,
      multiply: (ctx: BuilderContext, value: number): Sql =>
        sql`${this.column(ctx)} * ${value}`,
      divide: (ctx: BuilderContext, value: number): Sql =>
        sql`${this.column(ctx)} / ${value}`,
    },

    boolean: {
      set: (ctx: BuilderContext, value: boolean): Sql => sql`${value}`,
    },

    dateTime: {
      set: (ctx: BuilderContext, value: Date): Sql => sql`${value}`,
    },

    json: {
      set: (ctx: BuilderContext, value: any): Sql =>
        sql`${JSON.stringify(value)}`,
    },

    enum: {
      set: (ctx: BuilderContext, value: string | number | null): Sql =>
        sql`${value}`,
    },

    list: {
      equals: (ctx: BuilderContext, value: any): Sql => sql`${value}`,
      has: (ctx: BuilderContext, value: any): Sql =>
        sql`JSON_CONTAINS(${this.column(ctx)}, ${JSON.stringify(value)})`,
      hasEvery: (ctx: BuilderContext, value: any): Sql =>
        sql`JSON_CONTAINS(${this.column(ctx)}, ${JSON.stringify(value)})`,
      hasSome: (ctx: BuilderContext, value: any): Sql =>
        sql`JSON_OVERLAPS(${this.column(ctx)}, ${JSON.stringify(value)})`,
      isEmpty: (ctx: BuilderContext, value: any): Sql =>
        value
          ? sql`JSON_LENGTH(${this.column(ctx)}) = 0`
          : sql`JSON_LENGTH(${this.column(ctx)}) > 0`,
    },
  };

  // ================================
  // FILTER OPERATIONS (MySQL-specific)
  // ================================

  filters = {
    string: {
      equals: (ctx: BuilderContext, value: any, mode?: QueryMode): Sql =>
        this.operators.eq(ctx, this.column(ctx), sql`${value}`),
      not: (ctx: BuilderContext, value: any, mode?: QueryMode): Sql =>
        this.operators.neq(ctx, this.column(ctx), sql`${value}`),
      in: (ctx: BuilderContext, value: any, mode?: QueryMode): Sql => {
        const values = sql.join(
          value.map((v: any) => sql`${v}`),
          ", "
        );
        return this.operators.in(ctx, this.column(ctx), values);
      },
      notIn: (ctx: BuilderContext, value: any, mode?: QueryMode): Sql => {
        const values = sql.join(
          value.map((v: any) => sql`${v}`),
          ", "
        );
        return this.operators.notIn(ctx, this.column(ctx), values);
      },
      lt: (ctx: BuilderContext, value: any, mode?: QueryMode): Sql =>
        this.operators.lt(ctx, this.column(ctx), sql`${value}`),
      lte: (ctx: BuilderContext, value: any, mode?: QueryMode): Sql =>
        this.operators.lte(ctx, this.column(ctx), sql`${value}`),
      gt: (ctx: BuilderContext, value: any, mode?: QueryMode): Sql =>
        this.operators.gt(ctx, this.column(ctx), sql`${value}`),
      gte: (ctx: BuilderContext, value: any, mode?: QueryMode): Sql =>
        this.operators.gte(ctx, this.column(ctx), sql`${value}`),
      contains: (ctx: BuilderContext, value: any, mode?: QueryMode): Sql => {
        const column = this.column(ctx);
        const pattern = sql`${`%${value}%`}`;
        if (mode === "insensitive") {
          return this.operators.ilike(ctx, column, pattern);
        }
        return this.operators.like(ctx, column, pattern);
      },
      startsWith: (ctx: BuilderContext, value: any, mode?: QueryMode): Sql => {
        const column = this.column(ctx);
        const pattern = sql`${`${value}%`}`;
        if (mode === "insensitive") {
          return this.operators.ilike(ctx, column, pattern);
        }
        return this.operators.like(ctx, column, pattern);
      },
      endsWith: (ctx: BuilderContext, value: any, mode?: QueryMode): Sql => {
        const column = this.column(ctx);
        const pattern = sql`${`%${value}`}`;
        if (mode === "insensitive") {
          return this.operators.ilike(ctx, column, pattern);
        }
        return this.operators.like(ctx, column, pattern);
      },
      mode: (ctx: BuilderContext, value: any, mode?: QueryMode): Sql =>
        sql.empty,
      isEmpty: (ctx: BuilderContext, value: any, mode?: QueryMode): Sql =>
        value
          ? this.operators.eq(ctx, this.column(ctx), sql`''`)
          : this.operators.neq(ctx, this.column(ctx), sql`''`),
      search: (ctx: BuilderContext, value: any, mode?: QueryMode): Sql =>
        sql`MATCH(${this.column(ctx)}) AGAINST(${value} IN BOOLEAN MODE)`,
    },

    number: {
      equals: (ctx: BuilderContext, value: any): Sql =>
        this.operators.eq(ctx, this.column(ctx), sql`${value}`),
      not: (ctx: BuilderContext, value: any): Sql =>
        this.operators.neq(ctx, this.column(ctx), sql`${value}`),
      in: (ctx: BuilderContext, value: any): Sql => {
        const values = sql.join(
          value.map((v: any) => sql`${v}`),
          ", "
        );
        return this.operators.in(ctx, this.column(ctx), values);
      },
      notIn: (ctx: BuilderContext, value: any): Sql => {
        const values = sql.join(
          value.map((v: any) => sql`${v}`),
          ", "
        );
        return this.operators.notIn(ctx, this.column(ctx), values);
      },
      lt: (ctx: BuilderContext, value: any): Sql =>
        this.operators.lt(ctx, this.column(ctx), sql`${value}`),
      lte: (ctx: BuilderContext, value: any): Sql =>
        this.operators.lte(ctx, this.column(ctx), sql`${value}`),
      gt: (ctx: BuilderContext, value: any): Sql =>
        this.operators.gt(ctx, this.column(ctx), sql`${value}`),
      gte: (ctx: BuilderContext, value: any): Sql =>
        this.operators.gte(ctx, this.column(ctx), sql`${value}`),
    },

    bigint: {
      equals: (ctx: BuilderContext, value: any): Sql =>
        this.operators.eq(ctx, this.column(ctx), sql`${value}`),
      not: (ctx: BuilderContext, value: any): Sql =>
        this.operators.neq(ctx, this.column(ctx), sql`${value}`),
      in: (ctx: BuilderContext, value: any): Sql => {
        const values = sql.join(
          value.map((v: any) => sql`${v}`),
          ", "
        );
        return this.operators.in(ctx, this.column(ctx), values);
      },
      notIn: (ctx: BuilderContext, value: any): Sql => {
        const values = sql.join(
          value.map((v: any) => sql`${v}`),
          ", "
        );
        return this.operators.notIn(ctx, this.column(ctx), values);
      },
      lt: (ctx: BuilderContext, value: any): Sql =>
        this.operators.lt(ctx, this.column(ctx), sql`${value}`),
      lte: (ctx: BuilderContext, value: any): Sql =>
        this.operators.lte(ctx, this.column(ctx), sql`${value}`),
      gt: (ctx: BuilderContext, value: any): Sql =>
        this.operators.gt(ctx, this.column(ctx), sql`${value}`),
      gte: (ctx: BuilderContext, value: any): Sql =>
        this.operators.gte(ctx, this.column(ctx), sql`${value}`),
    },

    boolean: {
      equals: (ctx: BuilderContext, value: any): Sql =>
        this.operators.eq(ctx, this.column(ctx), sql`${value}`),
      not: (ctx: BuilderContext, value: any): Sql =>
        this.operators.neq(ctx, this.column(ctx), sql`${value}`),
      in: (ctx: BuilderContext, value: any): Sql => {
        const values = sql.join(
          value.map((v: any) => sql`${v}`),
          ", "
        );
        return this.operators.in(ctx, this.column(ctx), values);
      },
      notIn: (ctx: BuilderContext, value: any): Sql => {
        const values = sql.join(
          value.map((v: any) => sql`${v}`),
          ", "
        );
        return this.operators.notIn(ctx, this.column(ctx), values);
      },
    },

    dateTime: {
      equals: (ctx: BuilderContext, value: any): Sql =>
        this.operators.eq(ctx, this.column(ctx), sql`${value}`),
      not: (ctx: BuilderContext, value: any): Sql =>
        this.operators.neq(ctx, this.column(ctx), sql`${value}`),
      in: (ctx: BuilderContext, value: any): Sql => {
        const values = sql.join(
          value.map((v: any) => sql`${v}`),
          ", "
        );
        return this.operators.in(ctx, this.column(ctx), values);
      },
      notIn: (ctx: BuilderContext, value: any): Sql => {
        const values = sql.join(
          value.map((v: any) => sql`${v}`),
          ", "
        );
        return this.operators.notIn(ctx, this.column(ctx), values);
      },
      lt: (ctx: BuilderContext, value: any): Sql =>
        this.operators.lt(ctx, this.column(ctx), sql`${value}`),
      lte: (ctx: BuilderContext, value: any): Sql =>
        this.operators.lte(ctx, this.column(ctx), sql`${value}`),
      gt: (ctx: BuilderContext, value: any): Sql =>
        this.operators.gt(ctx, this.column(ctx), sql`${value}`),
      gte: (ctx: BuilderContext, value: any): Sql =>
        this.operators.gte(ctx, this.column(ctx), sql`${value}`),
    },

    json: {
      equals: (ctx: BuilderContext, value: any): Sql =>
        this.operators.eq(ctx, this.column(ctx), sql`${JSON.stringify(value)}`),
      not: (ctx: BuilderContext, value: any): Sql =>
        this.operators.neq(
          ctx,
          this.column(ctx),
          sql`${JSON.stringify(value)}`
        ),
      path: (ctx: BuilderContext, path: any): Sql =>
        sql`JSON_EXTRACT(${this.column(ctx)}, ${`$.${path.join(".")}`})`,
      string_contains: (ctx: BuilderContext, value: any): Sql => {
        const column = sql`JSON_UNQUOTE(${this.column(ctx)})`;
        const pattern = sql`${`%${value}%`}`;
        return this.operators.like(ctx, column, pattern);
      },
      string_starts_with: (ctx: BuilderContext, value: any): Sql => {
        const column = sql`JSON_UNQUOTE(${this.column(ctx)})`;
        const pattern = sql`${`${value}%`}`;
        return this.operators.like(ctx, column, pattern);
      },
      string_ends_with: (ctx: BuilderContext, value: any): Sql => {
        const column = sql`JSON_UNQUOTE(${this.column(ctx)})`;
        const pattern = sql`${`%${value}`}`;
        return this.operators.like(ctx, column, pattern);
      },
      array_contains: (ctx: BuilderContext, value: any): Sql =>
        sql`JSON_CONTAINS(${this.column(ctx)}, ${JSON.stringify(value)})`,
      array_starts_with: (ctx: BuilderContext, value: any): Sql =>
        sql`JSON_CONTAINS(${this.column(ctx)}, ${JSON.stringify(value)})`,
      array_ends_with: (ctx: BuilderContext, value: any): Sql =>
        sql`JSON_CONTAINS(${this.column(ctx)}, ${JSON.stringify(value)})`,
    },

    enum: {
      equals: (ctx: BuilderContext, value: any): Sql =>
        this.operators.eq(ctx, this.column(ctx), sql`${value}`),
      not: (ctx: BuilderContext, value: any): Sql =>
        this.operators.neq(ctx, this.column(ctx), sql`${value}`),
      in: (ctx: BuilderContext, value: any): Sql => {
        const values = sql.join(
          value.map((v: any) => sql`${v}`),
          ", "
        );
        return this.operators.in(ctx, this.column(ctx), values);
      },
      notIn: (ctx: BuilderContext, value: any): Sql => {
        const values = sql.join(
          value.map((v: any) => sql`${v}`),
          ", "
        );
        return this.operators.notIn(ctx, this.column(ctx), values);
      },
    },

    list: {
      equals: (ctx: BuilderContext, value: any): Sql =>
        this.operators.eq(ctx, this.column(ctx), sql`${JSON.stringify(value)}`),
      has: (ctx: BuilderContext, value: any): Sql =>
        sql`JSON_CONTAINS(${this.column(ctx)}, ${JSON.stringify(value)})`,
      hasEvery: (ctx: BuilderContext, value: any): Sql =>
        sql`JSON_CONTAINS(${this.column(ctx)}, ${JSON.stringify(value)})`,
      hasSome: (ctx: BuilderContext, value: any): Sql =>
        sql`JSON_OVERLAPS(${this.column(ctx)}, ${JSON.stringify(value)})`,
      isEmpty: (ctx: BuilderContext, value: any): Sql =>
        value
          ? this.operators.eq(
              ctx,
              sql`JSON_LENGTH(${this.column(ctx)})`,
              sql`0`
            )
          : this.operators.gt(
              ctx,
              sql`JSON_LENGTH(${this.column(ctx)})`,
              sql`0`
            ),
    },

    relations: {
      direct: (ctx: BuilderContext, statement: Sql): Sql => statement,
      some: (ctx: BuilderContext, statement: Sql): Sql =>
        this.operators.exists(ctx, statement),
      every: (ctx: BuilderContext, statement: Sql): Sql =>
        this.operators.notExists(ctx, statement),
      none: (ctx: BuilderContext, statement: Sql): Sql =>
        this.operators.notExists(ctx, statement),
      exists: (ctx: BuilderContext, statement: Sql): Sql =>
        this.operators.exists(ctx, statement),
      notExists: (ctx: BuilderContext, statement: Sql): Sql =>
        this.operators.notExists(ctx, statement),
    },
  } as unknown as DatabaseAdapter["filters"];

  // ================================
  // SUBQUERIES (MySQL-specific)
  // ================================

  subqueries = {
    correlation: (ctx: BuilderContext, statement: Sql): Sql => {
      return sql`(${statement})`;
    },

    aggregate: (ctx: BuilderContext, statement: Sql): Sql => {
      // MySQL JSON aggregation
      return sql`(
        SELECT COALESCE(JSON_ARRAYAGG(JSON_OBJECT(${sql.raw`*`})), JSON_ARRAY())
        FROM (${statement}) ${ctx.alias}
      )`;
    },
  };

  // ================================
  // BUILDERS (MySQL-specific)
  // ================================

  builders = {
    select: (ctx: BuilderContext, statement: Sql): Sql =>
      sql`SELECT ${statement}`,
    from: (ctx: BuilderContext, statement: Sql): Sql => sql`FROM ${statement}`,
    where: (ctx: BuilderContext, statement: Sql): Sql =>
      sql`WHERE ${statement}`,
    orderBy: (ctx: BuilderContext, statement: Sql): Sql =>
      sql`ORDER BY ${statement}`,
    limit: (ctx: BuilderContext, statement: Sql): Sql =>
      sql`LIMIT ${statement}`,
    take: (ctx: BuilderContext, statement: Sql): Sql => sql`LIMIT ${statement}`,
    skip: (ctx: BuilderContext, statement: Sql): Sql =>
      sql`OFFSET ${statement}`,
    groupBy: (ctx: BuilderContext, statement: Sql): Sql =>
      sql`GROUP BY ${statement}`,
    having: (ctx: BuilderContext, statement: Sql): Sql =>
      sql`HAVING ${statement}`,
    count: (ctx: BuilderContext, statement: Sql): Sql =>
      sql`COUNT(${statement})`,
    aggregate: (ctx: BuilderContext, statement: Sql): Sql => statement,
  };

  // ================================
  // CTE BUILDERS
  // ================================

  cte = {
    build: (ctes: Array<{ alias: string; query: Sql }>): Sql => {
      const cteDefinitions = ctes.map(
        ({ alias, query }) => sql`${sql.raw`${alias}`} AS (${query})`
      );
      return sql`WITH ${sql.join(cteDefinitions, ", ")}`;
    },
  };
}

// Export singleton instance
export const mysqlAdapter = new MySQLAdapter();
