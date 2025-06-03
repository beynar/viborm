import { Sql } from "../sql/sql";
import { Model } from "../schema/model";
import { Operation } from "../types/client/operations/defintion";
import { Field, Relation } from "../schema";
import {
  BigIntFilter,
  BoolFilter,
  DateTimeFilter,
  EnumFilter,
  JsonFilter,
  ListFilter,
  NumberFilter,
  QueryMode,
  StringFilter,
} from "../types/client/query/filters-input";

import {
  BoolFieldUpdateOperationsInput,
  DateTimeFieldUpdateOperationsInput,
  EnumFieldUpdateOperationsInput,
  IntFieldUpdateOperationsInput,
  JsonFieldUpdateOperationsInput,
  StringFieldUpdateOperationsInput,
} from "../types/client/query/update-input";

import { BuilderContext } from "../query-parser/types";
import { BuiltIns } from "../types";

// ================================
// Query Clauses Type
// ================================

export interface QueryClauses {
  select: Sql;
  from: Sql;
  where?: Sql;
  orderBy?: Sql;
  limit?: Sql;
  groupBy?: Sql;
  having?: Sql;
  include?: Sql[];
}

// ================================
// Adapter Interface
// ================================

export interface DatabaseAdapter {
  // === OPERATIONS ===
  operations: {
    findMany: (ctx: BuilderContext, clauses: QueryClauses) => Sql;
    findFirst: (ctx: BuilderContext, clauses: QueryClauses) => Sql;
    findUnique: (ctx: BuilderContext, clauses: QueryClauses) => Sql;
    create: (ctx: BuilderContext, payload: any) => Sql;
    createMany: (ctx: BuilderContext, payload: any) => Sql;
    update: (ctx: BuilderContext, clauses: QueryClauses) => Sql;
    updateMany: (ctx: BuilderContext, clauses: QueryClauses) => Sql;
    delete: (ctx: BuilderContext, clauses: QueryClauses) => Sql;
    deleteMany: (ctx: BuilderContext, clauses: QueryClauses) => Sql;
    upsert: (ctx: BuilderContext, payload: any) => Sql;
    count: (ctx: BuilderContext, clauses: QueryClauses) => Sql;
    aggregate: (ctx: BuilderContext, clauses: QueryClauses) => Sql;
    groupBy: (ctx: BuilderContext, clauses: QueryClauses) => Sql;
    findUniqueOrThrow: (ctx: BuilderContext, clauses: QueryClauses) => Sql;
    findFirstOrThrow: (ctx: BuilderContext, clauses: QueryClauses) => Sql;
  };

  // === IDENTIFIER ESCAPING ===
  identifiers: {
    // Escape a single identifier (table, column, alias)
    escape: (identifier: string) => Sql;
    // Create a qualified column reference
    column: (alias: string, field: string) => Sql;
    // Create a table reference with alias
    table: (tableName: string, alias: string) => Sql;
    // Create an aliased expression
    aliased: (expression: Sql, alias: string) => Sql;
  };

  utils: {
    coalesce: (ctx: BuilderContext, statement: Sql) => Sql;
    escape: (ctx: BuilderContext, statement: Sql) => Sql;
    jsonObject: (ctx: BuilderContext, statement: Sql) => Sql;
    jsonArray: (ctx: BuilderContext, statement: Sql) => Sql;
    wrap: (ctx: BuilderContext, statement: Sql) => Sql;
  };

  // === AGGREGATE FUNCTIONS ===
  aggregates: {
    count: (ctx: BuilderContext, expression?: Sql) => Sql;
    sum: (ctx: BuilderContext, expression: Sql) => Sql;
    avg: (ctx: BuilderContext, expression: Sql) => Sql;
    min: (ctx: BuilderContext, expression: Sql) => Sql;
    max: (ctx: BuilderContext, expression: Sql) => Sql;
  };

  // === DATA BUILDERS ===
  updates: {
    string: Record<
      keyof StringFieldUpdateOperationsInput,
      (ctx: BuilderContext, value: string, mode?: QueryMode) => Sql
    >;
    number: Record<
      keyof IntFieldUpdateOperationsInput,
      (ctx: BuilderContext, value: number) => Sql
    >;
    int?: Record<
      keyof IntFieldUpdateOperationsInput,
      (ctx: BuilderContext, value: number) => Sql
    >;
    float?: Record<
      keyof IntFieldUpdateOperationsInput,
      (ctx: BuilderContext, value: number) => Sql
    >;

    boolean: Record<
      keyof BoolFieldUpdateOperationsInput,
      (ctx: BuilderContext, value: boolean) => Sql
    >;
    dateTime: Record<
      keyof DateTimeFieldUpdateOperationsInput,
      (ctx: BuilderContext, value: Date) => Sql
    >;
    json: Record<
      keyof JsonFieldUpdateOperationsInput,
      (ctx: BuilderContext, value: any) => Sql
    >;
    enum: Record<
      keyof EnumFieldUpdateOperationsInput<any>,
      (ctx: BuilderContext, value: string | number | null) => Sql
    >;
    list: Record<
      keyof ListFilter<any>,
      (ctx: BuilderContext, value: any) => Sql
    >;
  };

  // === FILTER BUILDERS ===
  filters: {
    string: Record<
      keyof StringFilter,
      (ctx: BuilderContext, value: string, mode?: QueryMode) => Sql
    >;
    number: Record<
      keyof NumberFilter,
      (ctx: BuilderContext, value: number) => Sql
    >;
    int?: Record<
      keyof NumberFilter,
      (ctx: BuilderContext, value: number) => Sql
    >;
    float?: Record<
      keyof NumberFilter,
      (ctx: BuilderContext, value: number) => Sql
    >;
    bigint?: Record<
      keyof BigIntFilter,
      (ctx: BuilderContext, value: bigint) => Sql
    >;
    boolean?: Record<
      keyof BoolFilter,
      (ctx: BuilderContext, value: boolean) => Sql
    >;

    dateTime?: Record<
      keyof DateTimeFilter,
      (ctx: BuilderContext, value: Date) => Sql
    >;
    json?: Record<keyof JsonFilter, (ctx: BuilderContext, value: any) => Sql>;

    enum?: Record<
      keyof EnumFilter<any>,
      (ctx: BuilderContext, value: string | number | null) => Sql
    >;

    list?: Record<
      keyof ListFilter<any>,
      (ctx: BuilderContext, value: any) => Sql
    >;

    relations: {
      direct: (ctx: BuilderContext, statement: Sql) => Sql;
      some: (ctx: BuilderContext, statement: Sql) => Sql;
      every: (ctx: BuilderContext, statement: Sql) => Sql;
      none: (ctx: BuilderContext, statement: Sql) => Sql;
      exists: (ctx: BuilderContext, statement: Sql) => Sql;
      notExists: (ctx: BuilderContext, statement: Sql) => Sql;
    };
  };

  subqueries: {
    // Build correlated subqueries for relation filters
    correlation: (ctx: BuilderContext, statement: Sql) => Sql;
    // Build aggregate subqueries for mimicking JOINS
    aggregate: (ctx: BuilderContext, statement: Sql) => Sql;
  };

  builders: {
    select: (ctx: BuilderContext, statement: Sql) => Sql;
    from: (ctx: BuilderContext, statement: Sql) => Sql;
    where: (ctx: BuilderContext, statement: Sql) => Sql;
    orderBy: (ctx: BuilderContext, statement: Sql) => Sql;
    limit: (ctx: BuilderContext, statement: Sql) => Sql;
    take: (ctx: BuilderContext, statement: Sql) => Sql;
    skip: (ctx: BuilderContext, statement: Sql) => Sql;
    groupBy: (ctx: BuilderContext, statement: Sql) => Sql;
    having: (ctx: BuilderContext, statement: Sql) => Sql;
    count: (ctx: BuilderContext, statement: Sql) => Sql;
    aggregate: (ctx: BuilderContext, statement: Sql) => Sql;
    NOT: (ctx: BuilderContext, statement: Sql) => Sql;
    OR: (ctx: BuilderContext, ...statements: Sql[]) => Sql;
    AND: (ctx: BuilderContext, ...statements: Sql[]) => Sql;
  };

  // === CTE BUILDERS ===
  cte: {
    // Build WITH clause from CTE definitions
    build: (ctes: Array<{ alias: string; query: Sql }>) => Sql;
  };
}
