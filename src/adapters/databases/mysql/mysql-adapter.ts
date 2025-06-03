import { Sql, sql } from "@sql";
import { DatabaseAdapter, QueryClauses } from "../../database-adapter";
import { BuilderContext } from "../../../query-parser/types";
import { QueryMode } from "../../../types/client/query/filters-input";

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
      const tableName = ctx.model.tableName || ctx.model.name;
      // MySQL doesn't have RETURNING, but we can simulate with SELECT
      return sql`INSERT INTO ${this.identifiers.escape(
        tableName
      )} ${sql.spreadValues(payload.data)}`;
    },

    createMany: (ctx: BuilderContext, payload: any): Sql => {
      const tableName = ctx.model.tableName || ctx.model.name;
      return sql`INSERT INTO ${this.identifiers.escape(
        tableName
      )} ${sql.spreadValues(payload.data)}`;
    },

    update: (ctx: BuilderContext, clauses: QueryClauses): Sql => {
      const tableName = ctx.model.tableName || ctx.model.name;
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
      const tableName = ctx.model.tableName || ctx.model.name;

      const parts = [sql`DELETE FROM ${this.identifiers.escape(tableName)}`];

      if (clauses.where) parts.push(clauses.where);

      return sql.join(parts, " ");
    },

    deleteMany: (ctx: BuilderContext, clauses: QueryClauses): Sql => {
      return this.operations.delete(ctx, clauses);
    },

    upsert: (ctx: BuilderContext, payload: any): Sql => {
      const tableName = ctx.model.tableName || ctx.model.name;

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
        sql`${this.column(ctx)} = ${value}`,
      not: (ctx: BuilderContext, value: any, mode?: QueryMode): Sql =>
        sql`${this.column(ctx)} != ${value}`,
      in: (ctx: BuilderContext, value: any, mode?: QueryMode): Sql =>
        sql`${this.column(ctx)} IN (${sql.join(
          value.map((v: any) => sql`${v}`),
          ", "
        )})`,
      notIn: (ctx: BuilderContext, value: any, mode?: QueryMode): Sql =>
        sql`${this.column(ctx)} NOT IN (${sql.join(
          value.map((v: any) => sql`${v}`),
          ", "
        )})`,
      lt: (ctx: BuilderContext, value: any, mode?: QueryMode): Sql =>
        sql`${this.column(ctx)} < ${value}`,
      lte: (ctx: BuilderContext, value: any, mode?: QueryMode): Sql =>
        sql`${this.column(ctx)} <= ${value}`,
      gt: (ctx: BuilderContext, value: any, mode?: QueryMode): Sql =>
        sql`${this.column(ctx)} > ${value}`,
      gte: (ctx: BuilderContext, value: any, mode?: QueryMode): Sql =>
        sql`${this.column(ctx)} >= ${value}`,
      contains: (ctx: BuilderContext, value: any, mode?: QueryMode): Sql => {
        const col = this.column(ctx);
        if (mode === "insensitive") {
          return sql`${col} LIKE ${`%${value}%`} COLLATE utf8mb4_unicode_ci`;
        }
        return sql`${col} LIKE ${`%${value}%`}`;
      },
      startsWith: (ctx: BuilderContext, value: any, mode?: QueryMode): Sql => {
        const col = this.column(ctx);
        if (mode === "insensitive") {
          return sql`${col} LIKE ${`${value}%`} COLLATE utf8mb4_unicode_ci`;
        }
        return sql`${col} LIKE ${`${value}%`}`;
      },
      endsWith: (ctx: BuilderContext, value: any, mode?: QueryMode): Sql => {
        const col = this.column(ctx);
        if (mode === "insensitive") {
          return sql`${col} LIKE ${`%${value}`} COLLATE utf8mb4_unicode_ci`;
        }
        return sql`${col} LIKE ${`%${value}`}`;
      },
      mode: (ctx: BuilderContext, value: any, mode?: QueryMode): Sql =>
        sql.empty,
      isEmpty: (ctx: BuilderContext, value: any, mode?: QueryMode): Sql =>
        value ? sql`${this.column(ctx)} = ''` : sql`${this.column(ctx)} != ''`,
      search: (ctx: BuilderContext, value: any, mode?: QueryMode): Sql =>
        sql`MATCH(${this.column(ctx)}) AGAINST(${value} IN BOOLEAN MODE)`,
    },

    number: {
      equals: (ctx: BuilderContext, value: any): Sql =>
        sql`${this.column(ctx)} = ${value}`,
      not: (ctx: BuilderContext, value: any): Sql =>
        sql`${this.column(ctx)} != ${value}`,
      in: (ctx: BuilderContext, value: any): Sql =>
        sql`${this.column(ctx)} IN (${sql.join(
          value.map((v: any) => sql`${v}`),
          ", "
        )})`,
      notIn: (ctx: BuilderContext, value: any): Sql =>
        sql`${this.column(ctx)} NOT IN (${sql.join(
          value.map((v: any) => sql`${v}`),
          ", "
        )})`,
      lt: (ctx: BuilderContext, value: any): Sql =>
        sql`${this.column(ctx)} < ${value}`,
      lte: (ctx: BuilderContext, value: any): Sql =>
        sql`${this.column(ctx)} <= ${value}`,
      gt: (ctx: BuilderContext, value: any): Sql =>
        sql`${this.column(ctx)} > ${value}`,
      gte: (ctx: BuilderContext, value: any): Sql =>
        sql`${this.column(ctx)} >= ${value}`,
    },

    bigint: {
      equals: (ctx: BuilderContext, value: any): Sql =>
        sql`${this.column(ctx)} = ${value}`,
      not: (ctx: BuilderContext, value: any): Sql =>
        sql`${this.column(ctx)} != ${value}`,
      in: (ctx: BuilderContext, value: any): Sql =>
        sql`${this.column(ctx)} IN (${sql.join(
          value.map((v: any) => sql`${v}`),
          ", "
        )})`,
      notIn: (ctx: BuilderContext, value: any): Sql =>
        sql`${this.column(ctx)} NOT IN (${sql.join(
          value.map((v: any) => sql`${v}`),
          ", "
        )})`,
      lt: (ctx: BuilderContext, value: any): Sql =>
        sql`${this.column(ctx)} < ${value}`,
      lte: (ctx: BuilderContext, value: any): Sql =>
        sql`${this.column(ctx)} <= ${value}`,
      gt: (ctx: BuilderContext, value: any): Sql =>
        sql`${this.column(ctx)} > ${value}`,
      gte: (ctx: BuilderContext, value: any): Sql =>
        sql`${this.column(ctx)} >= ${value}`,
    },

    boolean: {
      equals: (ctx: BuilderContext, value: any): Sql =>
        sql`${this.column(ctx)} = ${value}`,
      not: (ctx: BuilderContext, value: any): Sql =>
        sql`${this.column(ctx)} != ${value}`,
      in: (ctx: BuilderContext, value: any): Sql =>
        sql`${this.column(ctx)} IN (${sql.join(
          value.map((v: any) => sql`${v}`),
          ", "
        )})`,
      notIn: (ctx: BuilderContext, value: any): Sql =>
        sql`${this.column(ctx)} NOT IN (${sql.join(
          value.map((v: any) => sql`${v}`),
          ", "
        )})`,
    },

    dateTime: {
      equals: (ctx: BuilderContext, value: any): Sql =>
        sql`${this.column(ctx)} = ${value}`,
      not: (ctx: BuilderContext, value: any): Sql =>
        sql`${this.column(ctx)} != ${value}`,
      in: (ctx: BuilderContext, value: any): Sql =>
        sql`${this.column(ctx)} IN (${sql.join(
          value.map((v: any) => sql`${v}`),
          ", "
        )})`,
      notIn: (ctx: BuilderContext, value: any): Sql =>
        sql`${this.column(ctx)} NOT IN (${sql.join(
          value.map((v: any) => sql`${v}`),
          ", "
        )})`,
      lt: (ctx: BuilderContext, value: any): Sql =>
        sql`${this.column(ctx)} < ${value}`,
      lte: (ctx: BuilderContext, value: any): Sql =>
        sql`${this.column(ctx)} <= ${value}`,
      gt: (ctx: BuilderContext, value: any): Sql =>
        sql`${this.column(ctx)} > ${value}`,
      gte: (ctx: BuilderContext, value: any): Sql =>
        sql`${this.column(ctx)} >= ${value}`,
    },

    json: {
      equals: (ctx: BuilderContext, value: any): Sql =>
        sql`${this.column(ctx)} = ${JSON.stringify(value)}`,
      not: (ctx: BuilderContext, value: any): Sql =>
        sql`${this.column(ctx)} != ${JSON.stringify(value)}`,
      path: (ctx: BuilderContext, path: any): Sql =>
        sql`JSON_EXTRACT(${this.column(ctx)}, ${`$.${path.join(".")}`})`,
      string_contains: (ctx: BuilderContext, value: any): Sql =>
        sql`JSON_UNQUOTE(${this.column(ctx)}) LIKE ${`%${value}%`}`,
      string_starts_with: (ctx: BuilderContext, value: any): Sql =>
        sql`JSON_UNQUOTE(${this.column(ctx)}) LIKE ${`${value}%`}`,
      string_ends_with: (ctx: BuilderContext, value: any): Sql =>
        sql`JSON_UNQUOTE(${this.column(ctx)}) LIKE ${`%${value}`}`,
      array_contains: (ctx: BuilderContext, value: any): Sql =>
        sql`JSON_CONTAINS(${this.column(ctx)}, ${JSON.stringify(value)})`,
      array_starts_with: (ctx: BuilderContext, value: any): Sql =>
        sql`JSON_CONTAINS(${this.column(ctx)}, ${JSON.stringify(value)})`,
      array_ends_with: (ctx: BuilderContext, value: any): Sql =>
        sql`JSON_CONTAINS(${this.column(ctx)}, ${JSON.stringify(value)})`,
    },

    enum: {
      equals: (ctx: BuilderContext, value: any): Sql =>
        sql`${this.column(ctx)} = ${value}`,
      not: (ctx: BuilderContext, value: any): Sql =>
        sql`${this.column(ctx)} != ${value}`,
      in: (ctx: BuilderContext, value: any): Sql =>
        sql`${this.column(ctx)} IN (${sql.join(
          value.map((v: any) => sql`${v}`),
          ", "
        )})`,
      notIn: (ctx: BuilderContext, value: any): Sql =>
        sql`${this.column(ctx)} NOT IN (${sql.join(
          value.map((v: any) => sql`${v}`),
          ", "
        )})`,
    },

    list: {
      equals: (ctx: BuilderContext, value: any): Sql =>
        sql`${this.column(ctx)} = ${JSON.stringify(value)}`,
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

    relations: {
      direct: (ctx: BuilderContext, statement: Sql): Sql => statement,
      some: (ctx: BuilderContext, statement: Sql): Sql =>
        sql`EXISTS (${statement})`,
      every: (ctx: BuilderContext, statement: Sql): Sql =>
        sql`NOT EXISTS (${statement})`,
      none: (ctx: BuilderContext, statement: Sql): Sql =>
        sql`NOT EXISTS (${statement})`,
      exists: (ctx: BuilderContext, statement: Sql): Sql =>
        sql`EXISTS (${statement})`,
      notExists: (ctx: BuilderContext, statement: Sql): Sql =>
        sql`NOT EXISTS (${statement})`,
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
    NOT: (ctx: BuilderContext, statement: Sql): Sql => sql`NOT (${statement})`,
    OR: (ctx: BuilderContext, ...statements: Sql[]): Sql =>
      sql`(${sql.join(statements, " OR ")})`,
    AND: (ctx: BuilderContext, ...statements: Sql[]): Sql =>
      sql`(${sql.join(statements, " AND ")})`,
  };
}

// Export singleton instance
export const mysqlAdapter = new MySQLAdapter();
