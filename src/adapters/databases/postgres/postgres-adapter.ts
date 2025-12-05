import { Sql, sql } from "@sql";
import { DatabaseAdapter, QueryClauses } from "../../database-adapter";
import { BuilderContext } from "@query-parser";
import { QueryMode, StringFilter } from "@types";

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
    return this.identifiers.column(ctx.alias, ctx.fieldName!);
  }

  // ================================
  // IDENTIFIER ESCAPING
  // ================================

  identifiers = {
    escape: (identifier: string): Sql => sql.raw`"${identifier}"`,
    column: (alias: string, field: string): Sql =>
      sql.raw`"${alias}"."${field}"`,
    table: (tableName: string, alias: string): Sql =>
      sql.raw`"${tableName}" AS "${alias}"`,
    aliased: (expression: Sql, alias: string): Sql =>
      sql`${expression} AS "${sql.raw`${alias}`}"`,
  };

  // ================================
  // OPERATIONS
  // ================================

  operations = {
    findMany: (ctx: BuilderContext, clauses: QueryClauses): Sql => {
      // Build SELECT clause - combine main fields with relation subqueries
      let selectClause = clauses.select;
      if (clauses.include && clauses.include.length > 0) {
        // Add relation subqueries to the SELECT clause
        const allSelects = [clauses.select, ...clauses.include];
        selectClause = sql.join(allSelects, ", ");
      }

      const parts = [sql`SELECT`, selectClause, sql`FROM`, clauses.from];

      if (clauses.where) parts.push(sql`WHERE`, clauses.where);
      if (clauses.orderBy) parts.push(clauses.orderBy);
      if (clauses.limit) parts.push(clauses.limit);

      return sql.join(parts, " ");
    },

    findFirst: (ctx: BuilderContext, clauses: QueryClauses): Sql => {
      // Build SELECT clause - combine main fields with relation subqueries
      let selectClause = clauses.select;
      if (clauses.include && clauses.include.length > 0) {
        // Add relation subqueries to the SELECT clause
        const allSelects = [clauses.select, ...clauses.include];
        selectClause = sql.join(allSelects, ", ");
      }

      const parts = [sql`SELECT`, selectClause, sql`FROM`, clauses.from];

      if (clauses.where) parts.push(sql`WHERE`, clauses.where);
      if (clauses.orderBy) parts.push(clauses.orderBy);

      // PostgreSQL LIMIT 1 for findFirst
      parts.push(sql`LIMIT 1`);

      return sql.join(parts, " ");
    },

    findUnique: (ctx: BuilderContext, clauses: QueryClauses): Sql => {
      // Build SELECT clause - combine main fields with relation subqueries
      let selectClause = clauses.select;
      if (clauses.include && clauses.include.length > 0) {
        // Add relation subqueries to the SELECT clause
        const allSelects = [clauses.select, ...clauses.include];
        selectClause = sql.join(allSelects, ", ");
      }

      const parts = [sql`SELECT`, selectClause, sql`FROM`, clauses.from];

      if (clauses.where) parts.push(sql`WHERE`, clauses.where);

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
      const tableName = ctx.model["~"].tableName || ctx.model.name;
      // PostgreSQL RETURNING clause
      return sql`INSERT INTO "${sql.raw`${tableName}`}" ${sql.spreadValues(
        payload.data
      )} RETURNING *`;
    },

    createMany: (ctx: BuilderContext, payload: any): Sql => {
      const tableName = ctx.model["~"].tableName || ctx.model.name;
      return sql`INSERT INTO "${sql.raw`${tableName}`}" ${sql.spreadValues(
        payload.data
      )} RETURNING *`;
    },

    update: (ctx: BuilderContext, clauses: QueryClauses): Sql => {
      const tableName = ctx.model["~"].tableName || ctx.model.name;

      const parts = [sql`UPDATE "${sql.raw`${tableName}`}"`];

      // Add SET clause if provided
      if ((clauses as any).set) {
        parts.push(sql`SET`, (clauses as any).set);
      }

      // Add WHERE clause if provided
      if (clauses.where) {
        parts.push(sql`WHERE`, clauses.where);
      }

      parts.push(sql`RETURNING *`);

      return sql.join(parts, " ");
    },

    updateMany: (ctx: BuilderContext, clauses: QueryClauses): Sql => {
      const tableName = ctx.model["~"].tableName || ctx.model.name;

      const parts = [sql`UPDATE "${sql.raw`${tableName}`}"`];

      // Add SET clause if provided
      if ((clauses as any).set) {
        parts.push(sql`SET`, (clauses as any).set);
      }

      // Add WHERE clause if provided
      if (clauses.where) {
        parts.push(sql`WHERE`, clauses.where);
      }

      parts.push(sql`RETURNING *`);

      return sql.join(parts, " ");
    },

    delete: (ctx: BuilderContext, clauses: QueryClauses): Sql => {
      const tableName = ctx.model["~"].tableName || ctx.model.name;

      const parts = [sql`DELETE FROM "${sql.raw`${tableName}`}"`];

      // Add WHERE clause if provided
      if (clauses.where) {
        parts.push(sql`WHERE`, clauses.where);
      }

      parts.push(sql`RETURNING *`);

      return sql.join(parts, " ");
    },

    deleteMany: (ctx: BuilderContext, clauses: QueryClauses): Sql => {
      const tableName = ctx.model["~"].tableName || ctx.model.name;

      const parts = [sql`DELETE FROM "${sql.raw`${tableName}`}"`];

      // Add WHERE clause if provided
      if (clauses.where) {
        parts.push(sql`WHERE`, clauses.where);
      }

      parts.push(sql`RETURNING *`);

      return sql.join(parts, " ");
    },

    upsert: (ctx: BuilderContext, payload: any): Sql => {
      const tableName = ctx.model["~"].tableName || ctx.model.name;
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
      const parts = [sql`SELECT`, clauses.select, sql`FROM`, clauses.from];

      if (clauses.where) parts.push(sql`WHERE`, clauses.where);
      if (clauses.orderBy) parts.push(clauses.orderBy);

      return sql.join(parts, " ");
    },

    aggregate: (ctx: BuilderContext, clauses: QueryClauses): Sql => {
      const parts = [sql`SELECT`, clauses.select, sql`FROM`, clauses.from];

      if (clauses.where) parts.push(sql`WHERE`, clauses.where);
      if (clauses.orderBy) parts.push(clauses.orderBy);

      return sql.join(parts, " ");
    },

    groupBy: (ctx: BuilderContext, clauses: QueryClauses): Sql => {
      const parts = [sql`SELECT`, clauses.select, sql`FROM`, clauses.from];

      if (clauses.where) parts.push(sql`WHERE`, clauses.where);
      if (clauses.groupBy) parts.push(clauses.groupBy);
      if (clauses.having) parts.push(sql`HAVING`, clauses.having);
      if (clauses.orderBy) parts.push(clauses.orderBy);

      return sql.join(parts, " ");
    },

    exist: (ctx: BuilderContext, clauses: QueryClauses): Sql => {
      // Build inner query: SELECT 1 FROM table WHERE conditions LIMIT 1
      const innerParts = [sql`SELECT`, clauses.select, sql`FROM`, clauses.from];

      if (clauses.where) innerParts.push(sql`WHERE`, clauses.where);
      if (clauses.limit) innerParts.push(clauses.limit);

      const innerQuery = sql.join(innerParts, " ");

      // Wrap in EXISTS: SELECT EXISTS(inner_query)
      return sql`SELECT ${this.utils.exists(ctx, innerQuery)}`;
    },
  };

  // ================================
  // UTILITIES
  // ================================

  utils = {
    coalesce: (ctx: BuilderContext, statement: Sql): Sql =>
      sql`COALESCE(${statement}, '')`,
    escape: (ctx: BuilderContext, statement: Sql): Sql => sql`${statement}`,
    wrap: (ctx: BuilderContext, statement: Sql): Sql =>
      sql.wrap("(", statement, ")"),
    jsonObject: (ctx: BuilderContext, statement: Sql): Sql =>
      sql`json_build_object(${statement})`,
    jsonArray: (ctx: BuilderContext, statement: Sql): Sql =>
      sql`json_build_array(${statement})`,
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
      sql`${column} ILIKE ${pattern}`,
    notLike: (ctx: BuilderContext, column: Sql, pattern: Sql): Sql =>
      sql`${column} NOT LIKE ${pattern}`,
    notIlike: (ctx: BuilderContext, column: Sql, pattern: Sql): Sql =>
      sql`${column} NOT ILIKE ${pattern}`,

    // Range operators
    between: (ctx: BuilderContext, column: Sql, min: Sql, max: Sql): Sql =>
      sql`${column} BETWEEN ${min} AND ${max}`,
    notBetween: (ctx: BuilderContext, column: Sql, min: Sql, max: Sql): Sql =>
      sql`${column} NOT BETWEEN ${min} AND ${max}`,

    // Regular expression operators (PostgreSQL-specific)
    regexp: (ctx: BuilderContext, column: Sql, pattern: Sql): Sql =>
      sql`${column} ~ ${pattern}`,
    notRegexp: (ctx: BuilderContext, column: Sql, pattern: Sql): Sql =>
      sql`${column} !~ ${pattern}`,

    // Set membership operators
    in: (ctx: BuilderContext, column: Sql, values: Sql): Sql =>
      sql`${column} = ANY(${values})`,
    notIn: (ctx: BuilderContext, column: Sql, values: Sql): Sql =>
      sql`${column} != ALL(${values})`,

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
  // UPDATE OPERATIONS
  // ================================

  updates = {
    string: {
      set: (ctx: BuilderContext, value: string, mode?: QueryMode): Sql =>
        sql`${value}`,
    },

    int: {
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
    float: {
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

    bigint: {
      set: (ctx: BuilderContext, value: bigint | number | string): Sql =>
        sql`${value}`,
      increment: (ctx: BuilderContext, value: bigint | number | string): Sql =>
        sql`${this.column(ctx)} + ${value}`,
      decrement: (ctx: BuilderContext, value: bigint | number | string): Sql =>
        sql`${this.column(ctx)} - ${value}`,
      multiply: (ctx: BuilderContext, value: bigint | number | string): Sql =>
        sql`${this.column(ctx)} * ${value}`,
      divide: (ctx: BuilderContext, value: bigint | number | string): Sql =>
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
        sql`${JSON.stringify(value)}::jsonb`,
      merge: (ctx: BuilderContext, value: any): Sql =>
        sql`${this.column(ctx)} || ${JSON.stringify(value)}::jsonb`,
      path: (ctx: BuilderContext, value: any): Sql =>
        sql`${this.column(ctx)} #> ${`{${value.join(",")}}`}`,
    },

    enum: {
      set: (ctx: BuilderContext, value: string | number | null): Sql =>
        sql`${value}`,
    },

    list: {
      equals: (ctx: BuilderContext, value: any): Sql => sql`${value}`,
      has: (ctx: BuilderContext, value: any): Sql =>
        sql`array_append(${this.column(ctx)}, ${value})`,
      hasEvery: (ctx: BuilderContext, value: any): Sql =>
        sql`${this.column(ctx)} @> ${value}`,
      hasSome: (ctx: BuilderContext, value: any): Sql =>
        sql`${this.column(ctx)} && ${value}`,
      isEmpty: (ctx: BuilderContext, value: any): Sql =>
        sql`array_length(${this.column(ctx)}, 1) IS NULL`,
    },
  };

  // ================================
  // FILTER OPERATIONS
  // ================================

  filters = {
    string: {
      equals: (ctx: BuilderContext, value: any, mode?: QueryMode): Sql =>
        this.operators.eq(ctx, this.column(ctx), sql`${value}`),
      not: (ctx: BuilderContext, value: any, mode?: QueryMode): Sql =>
        this.operators.neq(ctx, this.column(ctx), sql`${value}`),
      in: (ctx: BuilderContext, value: any, mode?: QueryMode): Sql =>
        this.operators.in(ctx, this.column(ctx), sql`${value}`),
      notIn: (ctx: BuilderContext, value: any, mode?: QueryMode): Sql =>
        this.operators.notIn(ctx, this.column(ctx), sql`${value}`),
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
        sql.empty, // Mode is handled by other operations
      isEmpty: (ctx: BuilderContext, value: any, mode?: QueryMode): Sql =>
        value
          ? this.operators.eq(ctx, this.column(ctx), sql`''`)
          : this.operators.neq(ctx, this.column(ctx), sql`''`),
      search: (ctx: BuilderContext, value: any, mode?: QueryMode): Sql =>
        sql`to_tsvector(${this.column(ctx)}) @@ plainto_tsquery(${value})`,
    },

    number: {
      equals: (ctx: BuilderContext, value: any): Sql =>
        this.operators.eq(ctx, this.column(ctx), sql`${value}`),
      not: (ctx: BuilderContext, value: any): Sql =>
        this.operators.neq(ctx, this.column(ctx), sql`${value}`),
      in: (ctx: BuilderContext, value: any): Sql =>
        this.operators.in(ctx, this.column(ctx), sql`${value}`),
      notIn: (ctx: BuilderContext, value: any): Sql =>
        this.operators.notIn(ctx, this.column(ctx), sql`${value}`),
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
      in: (ctx: BuilderContext, value: any): Sql =>
        this.operators.in(ctx, this.column(ctx), sql`${value}`),
      notIn: (ctx: BuilderContext, value: any): Sql =>
        this.operators.notIn(ctx, this.column(ctx), sql`${value}`),
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
      in: (ctx: BuilderContext, value: any): Sql =>
        this.operators.in(ctx, this.column(ctx), sql`${value}`),
      notIn: (ctx: BuilderContext, value: any): Sql =>
        this.operators.notIn(ctx, this.column(ctx), sql`${value}`),
    },

    dateTime: {
      equals: (ctx: BuilderContext, value: any): Sql =>
        this.operators.eq(ctx, this.column(ctx), sql`${value}`),
      not: (ctx: BuilderContext, value: any): Sql =>
        this.operators.neq(ctx, this.column(ctx), sql`${value}`),
      in: (ctx: BuilderContext, value: any): Sql =>
        this.operators.in(ctx, this.column(ctx), sql`${value}`),
      notIn: (ctx: BuilderContext, value: any): Sql =>
        this.operators.notIn(ctx, this.column(ctx), sql`${value}`),
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
        this.operators.eq(
          ctx,
          this.column(ctx),
          sql`${JSON.stringify(value)}::jsonb`
        ),
      not: (ctx: BuilderContext, value: any): Sql =>
        this.operators.neq(
          ctx,
          this.column(ctx),
          sql`${JSON.stringify(value)}::jsonb`
        ),
      path: (ctx: BuilderContext, path: any): Sql =>
        sql`${this.column(ctx)} #> ${`{${path.join(",")}}`}`,
      string_contains: (ctx: BuilderContext, value: any): Sql => {
        const column = sql`${this.column(ctx)}::text`;
        const pattern = sql`${`%${value}%`}`;
        return this.operators.like(ctx, column, pattern);
      },
      string_starts_with: (ctx: BuilderContext, value: any): Sql => {
        const column = sql`${this.column(ctx)}::text`;
        const pattern = sql`${`${value}%`}`;
        return this.operators.like(ctx, column, pattern);
      },
      string_ends_with: (ctx: BuilderContext, value: any): Sql => {
        const column = sql`${this.column(ctx)}::text`;
        const pattern = sql`${`%${value}`}`;
        return this.operators.like(ctx, column, pattern);
      },
      array_contains: (ctx: BuilderContext, value: any): Sql =>
        sql`${this.column(ctx)} ? ${JSON.stringify(value)}`,
      array_starts_with: (ctx: BuilderContext, value: any): Sql =>
        sql`${this.column(ctx)} @> ${JSON.stringify(value)}::jsonb`,
      array_ends_with: (ctx: BuilderContext, value: any): Sql =>
        sql`${this.column(ctx)} <@ ${JSON.stringify(value)}::jsonb`,
    },

    enum: {
      equals: (ctx: BuilderContext, value: any): Sql =>
        this.operators.eq(ctx, this.column(ctx), sql`${value}`),
      not: (ctx: BuilderContext, value: any): Sql =>
        this.operators.neq(ctx, this.column(ctx), sql`${value}`),
      in: (ctx: BuilderContext, value: any): Sql =>
        this.operators.in(ctx, this.column(ctx), sql`${value}`),
      notIn: (ctx: BuilderContext, value: any): Sql =>
        this.operators.notIn(ctx, this.column(ctx), sql`${value}`),
    },

    list: {
      equals: (ctx: BuilderContext, value: any): Sql =>
        this.operators.eq(ctx, this.column(ctx), sql`${value}`),
      has: (ctx: BuilderContext, value: any): Sql =>
        sql`${value} = ANY(${this.column(ctx)})`,
      hasEvery: (ctx: BuilderContext, value: any): Sql =>
        sql`${this.column(ctx)} @> ${value}`,
      hasSome: (ctx: BuilderContext, value: any): Sql =>
        sql`${this.column(ctx)} && ${value}`,
      isEmpty: (ctx: BuilderContext, value: any): Sql =>
        value
          ? this.operators.isNull(
              ctx,
              sql`array_length(${this.column(ctx)}, 1)`
            )
          : sql`array_length(${this.column(ctx)}, 1) > 0`,
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
  // SUBQUERIES
  // ================================

  subqueries = {
    correlation: (ctx: BuilderContext, statement: Sql): Sql => {
      // Basic correlated subquery wrapper
      return sql`(${statement})`;
    },

    aggregate: (ctx: BuilderContext, statement: Sql): Sql => {
      // Get relation type from context if available
      const relation = ctx.relation;
      const relationType = relation ? relation["~"].relationType : null;

      // For One-to-One and Many-to-One relations, return single object or null
      if (relationType === "oneToOne" || relationType === "manyToOne") {
        return sql`(
          SELECT row_to_json(${sql.raw`${ctx.alias}`})
          FROM (${statement} LIMIT 1) ${sql.raw`${ctx.alias}`}
        )`;
      }

      // For One-to-Many and Many-to-Many relations, use array aggregation
      // This includes the default case when relationType is unknown
      return sql`(
        SELECT COALESCE(json_agg(row_to_json(${sql.raw`${ctx.alias}`})), '[]'::json)
        FROM (${statement}) ${sql.raw`${ctx.alias}`}
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
export const postgresAdapter = new PostgresAdapter();
