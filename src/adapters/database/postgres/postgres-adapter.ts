import { Sql, sql } from "../../../sql/sql";
import { DatabaseAdapter, QueryClauses } from "../database-adapter";
import { BuilderContext } from "../query-parser";
import { QueryMode, StringFilter } from "../../../types/client/query/filters";
import { Relation } from "../../../schema";

/**
 * PostgreSQL Database Adapter
 *
 * Implements PostgreSQL-specific SQL generation including:
 * - PostgreSQL syntax for queries and operations
 * - JSON operators and functions
 * - RETURNING clauses for mutations
 * - PostgreSQL-specific data types and operators
 */
export class PostgresAdapter implements DatabaseAdapter {
  // ================================
  // UTILITY METHODS
  // ================================

  /**
   * Creates a column accessor for the current context
   * Returns sql.raw`"alias"."fieldName"` for safe SQL composition
   */
  private column(ctx: BuilderContext): Sql {
    return sql.raw`"${ctx.alias}"."${ctx.fieldName}"`;
  }

  // ================================
  // OPERATIONS
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

      // PostgreSQL LIMIT 1 for findFirst
      parts.push(sql`LIMIT 1`);

      return sql.join(parts, " ");
    },

    findUnique: (ctx: BuilderContext, clauses: QueryClauses): Sql => {
      const parts = [clauses.select, clauses.from];

      if (clauses.where) parts.push(clauses.where);

      // PostgreSQL LIMIT 1 for unique queries
      parts.push(sql`LIMIT 1`);

      return sql.join(parts, " ");
    },

    findUniqueOrThrow: (ctx: BuilderContext, clauses: QueryClauses): Sql => {
      // Same as findUnique - error handling happens at application level
      return this.operations.findUnique(ctx, clauses);
    },

    findFirstOrThrow: (ctx: BuilderContext, clauses: QueryClauses): Sql => {
      // Same as findFirst - error handling happens at application level
      return this.operations.findFirst(ctx, clauses);
    },

    create: (ctx: BuilderContext, payload: any): Sql => {
      const tableName = ctx.model.tableName || ctx.model.name;
      // PostgreSQL RETURNING clause
      return sql`INSERT INTO "${sql.raw`${tableName}`}" ${sql.spreadValues(
        payload.data
      )} RETURNING *`;
    },

    createMany: (ctx: BuilderContext, payload: any): Sql => {
      const tableName = ctx.model.tableName || ctx.model.name;
      return sql`INSERT INTO "${sql.raw`${tableName}`}" ${sql.spreadValues(
        payload.data
      )} RETURNING *`;
    },

    update: (ctx: BuilderContext, clauses: QueryClauses): Sql => {
      const tableName = ctx.model.tableName || ctx.model.name;

      // Extract data from context - this will need to be passed differently
      // For now, we'll assume data is in ctx
      const data = (ctx as any).data || {};

      const setClause = sql.join(
        Object.entries(data).map(
          ([field, value]) => sql`"${field}" = ${value}`
        ),
        ", "
      );

      const parts = [sql`UPDATE "${tableName}" SET ${setClause}`];

      if (clauses.where) parts.push(clauses.where);
      parts.push(sql`RETURNING *`);

      return sql.join(parts, " ");
    },

    updateMany: (ctx: BuilderContext, clauses: QueryClauses): Sql => {
      const tableName = ctx.model.tableName || ctx.model.name;

      // Extract data from context
      const data = (ctx as any).data || {};

      const setClause = sql.join(
        Object.entries(data).map(
          ([field, value]) => sql`"${field}" = ${value}`
        ),
        ", "
      );

      const parts = [sql`UPDATE "${tableName}" SET ${setClause}`];

      if (clauses.where) parts.push(clauses.where);
      parts.push(sql`RETURNING *`);

      return sql.join(parts, " ");
    },

    delete: (ctx: BuilderContext, clauses: QueryClauses): Sql => {
      const tableName = ctx.model.tableName || ctx.model.name;

      const parts = [sql`DELETE FROM "${tableName}"`];

      if (clauses.where) parts.push(clauses.where);
      parts.push(sql`RETURNING *`);

      return sql.join(parts, " ");
    },

    deleteMany: (ctx: BuilderContext, clauses: QueryClauses): Sql => {
      const tableName = ctx.model.tableName || ctx.model.name;

      const parts = [sql`DELETE FROM "${tableName}"`];

      if (clauses.where) parts.push(clauses.where);
      parts.push(sql`RETURNING *`);

      return sql.join(parts, " ");
    },

    upsert: (ctx: BuilderContext, payload: any): Sql => {
      const tableName = ctx.model.tableName || ctx.model.name;
      const where = payload.where;
      const create = payload.create;
      const update = payload.update;

      // PostgreSQL ON CONFLICT DO UPDATE
      const fields = Object.keys(create);
      const fieldList = sql.join(
        fields.map((field) => sql.raw`"${field}"`),
        ", "
      );
      const valueList = sql.join(
        Object.values(create).map((value) => sql`${value}`),
        ", "
      );

      // Assume primary key conflict (simplified)
      const updateClause = sql.join(
        Object.entries(update).map(
          ([field, value]) => sql`"${field}" = ${value}`
        ),
        ", "
      );

      return sql`INSERT INTO "${sql.raw`${tableName}`}" ${sql.spreadValues(
        payload.data
      )} ON CONFLICT (id) DO UPDATE SET ${sql.spreadValues(
        payload.update
      )} RETURNING *`;
    },

    count: (ctx: BuilderContext, clauses: QueryClauses): Sql => {
      const parts = [clauses.select, clauses.from];

      if (clauses.where) parts.push(clauses.where);

      return sql.join(parts, " ");
    },

    aggregate: (ctx: BuilderContext, clauses: QueryClauses): Sql => {
      const parts = [clauses.select, clauses.from];

      if (clauses.where) parts.push(clauses.where);
      if (clauses.orderBy) parts.push(clauses.orderBy);

      return sql.join(parts, " ");
    },

    groupBy: (ctx: BuilderContext, clauses: QueryClauses): Sql => {
      const parts = [clauses.select, clauses.from];

      if (clauses.where) parts.push(clauses.where);
      if (clauses.orderBy) parts.push(clauses.orderBy);

      return sql.join(parts, " ");
    },
  };

  // ================================
  // UTILITIES
  // ================================

  utils = {
    coalesce: (ctx: BuilderContext): Sql => sql`COALESCE`,
    escape: (ctx: BuilderContext): Sql => sql`quote_ident`,
    jsonObject: (ctx: BuilderContext): Sql => sql`json_build_object`,
    jsonArray: (ctx: BuilderContext): Sql => sql`json_agg`,
  };

  // ================================
  // UPDATE OPERATIONS
  // ================================

  updates = {
    string: {
      set: (ctx: BuilderContext, value: string, mode?: QueryMode): Sql =>
        sql`${value}`,
    },

    number: {
      set: (ctx: BuilderContext, value: number): Sql => sql`${value}`,
      increment: (ctx: BuilderContext, value: number): Sql =>
        sql`${ctx.alias}.${ctx.fieldName} + ${value}`,
      decrement: (ctx: BuilderContext, value: number): Sql =>
        sql`${ctx.alias}.${ctx.fieldName} - ${value}`,
      multiply: (ctx: BuilderContext, value: number): Sql =>
        sql`${ctx.alias}.${ctx.fieldName} * ${value}`,
      divide: (ctx: BuilderContext, value: number): Sql =>
        sql`${ctx.alias}.${ctx.fieldName} / ${value}`,
    },

    boolean: {
      set: (ctx: BuilderContext, value: boolean): Sql => sql`${value}`,
    },

    dateTime: {
      set: (ctx: BuilderContext, value: Date): Sql => sql`${value}`,
    },

    json: {
      set: (ctx: BuilderContext, value: any): Sql =>
        sql`${JSON.stringify(value)}::jsonb`,
    },

    enum: {
      set: (ctx: BuilderContext, value: string | number | null): Sql =>
        sql`${value}`,
    },

    list: {
      equals: (ctx: BuilderContext, value: any): Sql => sql`${value}`,
      has: (ctx: BuilderContext, value: any): Sql =>
        sql`array_append(${ctx.alias}.${ctx.fieldName}, ${value})`,
      hasEvery: (ctx: BuilderContext, value: any): Sql =>
        sql`${ctx.alias}.${ctx.fieldName} @> ${value}`,
      hasSome: (ctx: BuilderContext, value: any): Sql =>
        sql`${ctx.alias}.${ctx.fieldName} && ${value}`,
      isEmpty: (ctx: BuilderContext, value: any): Sql =>
        sql`array_length(${ctx.alias}.${ctx.fieldName}, 1) IS NULL`,
    },
  };

  // ================================
  // FILTER OPERATIONS
  // ================================

  filters = {
    string: {
      equals: (ctx: BuilderContext, value: any, mode?: QueryMode): Sql =>
        sql`${this.column(ctx)} = ${value}`,
      not: (ctx: BuilderContext, value: any, mode?: QueryMode): Sql =>
        sql`${this.column(ctx)} != ${value}`,
      in: (ctx: BuilderContext, value: any, mode?: QueryMode): Sql =>
        sql`${this.column(ctx)} = ANY(${value})`,
      notIn: (ctx: BuilderContext, value: any, mode?: QueryMode): Sql =>
        sql`${this.column(ctx)} != ALL(${value})`,
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
          return sql`${col} ILIKE ${`%${value}%`}`;
        }
        return sql`${col} LIKE ${`%${value}%`}`;
      },
      startsWith: (ctx: BuilderContext, value: any, mode?: QueryMode): Sql => {
        const col = this.column(ctx);
        if (mode === "insensitive") {
          return sql`${col} ILIKE ${`${value}%`}`;
        }
        return sql`${col} LIKE ${`${value}%`}`;
      },
      endsWith: (ctx: BuilderContext, value: any, mode?: QueryMode): Sql => {
        const col = this.column(ctx);
        if (mode === "insensitive") {
          return sql`${col} ILIKE ${`%${value}`}`;
        }
        return sql`${col} LIKE ${`%${value}`}`;
      },
      mode: (ctx: BuilderContext, value: any, mode?: QueryMode): Sql =>
        sql.empty, // Mode is handled by other operations
      isEmpty: (ctx: BuilderContext, value: any, mode?: QueryMode): Sql =>
        value ? sql`${this.column(ctx)} = ''` : sql`${this.column(ctx)} != ''`,
      search: (ctx: BuilderContext, value: any, mode?: QueryMode): Sql =>
        sql`to_tsvector(${this.column(ctx)}) @@ plainto_tsquery(${value})`,
    },

    number: {
      equals: (ctx: BuilderContext, value: any): Sql =>
        sql`${this.column(ctx)} = ${value}`,
      not: (ctx: BuilderContext, value: any): Sql =>
        sql`${this.column(ctx)} != ${value}`,
      in: (ctx: BuilderContext, value: any): Sql =>
        sql`${this.column(ctx)} = ANY(${value})`,
      notIn: (ctx: BuilderContext, value: any): Sql =>
        sql`${this.column(ctx)} != ALL(${value})`,
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
        sql`${this.column(ctx)} = ANY(${value})`,
      notIn: (ctx: BuilderContext, value: any): Sql =>
        sql`${this.column(ctx)} != ALL(${value})`,
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
        sql`${this.column(ctx)} = ANY(${value})`,
      notIn: (ctx: BuilderContext, value: any): Sql =>
        sql`${this.column(ctx)} != ALL(${value})`,
    },

    dateTime: {
      equals: (ctx: BuilderContext, value: any): Sql =>
        sql`${this.column(ctx)} = ${value}`,
      not: (ctx: BuilderContext, value: any): Sql =>
        sql`${this.column(ctx)} != ${value}`,
      in: (ctx: BuilderContext, value: any): Sql =>
        sql`${this.column(ctx)} = ANY(${value})`,
      notIn: (ctx: BuilderContext, value: any): Sql =>
        sql`${this.column(ctx)} != ALL(${value})`,
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
        sql`${this.column(ctx)} = ${JSON.stringify(value)}::jsonb`,
      not: (ctx: BuilderContext, value: any): Sql =>
        sql`${this.column(ctx)} != ${JSON.stringify(value)}::jsonb`,
      path: (ctx: BuilderContext, path: any): Sql =>
        sql`${this.column(ctx)} #> ${`{${path.join(",")}}`}`,
      string_contains: (ctx: BuilderContext, value: any): Sql =>
        sql`${this.column(ctx)}::text LIKE ${`%${value}%`}`,
      string_starts_with: (ctx: BuilderContext, value: any): Sql =>
        sql`${this.column(ctx)}::text LIKE ${`${value}%`}`,
      string_ends_with: (ctx: BuilderContext, value: any): Sql =>
        sql`${this.column(ctx)}::text LIKE ${`%${value}`}`,
      array_contains: (ctx: BuilderContext, value: any): Sql =>
        sql`${this.column(ctx)} ? ${JSON.stringify(value)}`,
      array_starts_with: (ctx: BuilderContext, value: any): Sql =>
        sql`${this.column(ctx)} @> ${JSON.stringify(value)}::jsonb`,
      array_ends_with: (ctx: BuilderContext, value: any): Sql =>
        sql`${this.column(ctx)} <@ ${JSON.stringify(value)}::jsonb`,
    },

    enum: {
      equals: (ctx: BuilderContext, value: any): Sql =>
        sql`${this.column(ctx)} = ${value}`,
      not: (ctx: BuilderContext, value: any): Sql =>
        sql`${this.column(ctx)} != ${value}`,
      in: (ctx: BuilderContext, value: any): Sql =>
        sql`${this.column(ctx)} = ANY(${value})`,
      notIn: (ctx: BuilderContext, value: any): Sql =>
        sql`${this.column(ctx)} != ALL(${value})`,
    },

    list: {
      equals: (ctx: BuilderContext, value: any): Sql =>
        sql`${this.column(ctx)} = ${value}`,
      has: (ctx: BuilderContext, value: any): Sql =>
        sql`${value} = ANY(${this.column(ctx)})`,
      hasEvery: (ctx: BuilderContext, value: any): Sql =>
        sql`${this.column(ctx)} @> ${value}`,
      hasSome: (ctx: BuilderContext, value: any): Sql =>
        sql`${this.column(ctx)} && ${value}`,
      isEmpty: (ctx: BuilderContext, value: any): Sql =>
        value
          ? sql`array_length(${this.column(ctx)}, 1) IS NULL`
          : sql`array_length(${this.column(ctx)}, 1) > 0`,
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
  // SUBQUERIES
  // ================================

  subqueries = {
    correlation: (ctx: BuilderContext, statement: Sql): Sql => {
      // Basic correlated subquery wrapper
      return sql`(${statement})`;
    },

    aggregate: (ctx: BuilderContext, statement: Sql): Sql => {
      // PostgreSQL JSON aggregation for relations
      return sql`(
        SELECT COALESCE(json_agg(row_to_json(${ctx.alias})), '[]'::json)
        FROM (${statement}) ${ctx.alias}
      )`;
    },
  };

  // ================================
  // BUILDERS
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
export const postgresAdapter = new PostgresAdapter();
