import type { AnyDriver } from "@drivers";
import type { Model } from "@schema/model";
import { type Sql, sql } from "@sql";
import { buildWhere } from "../../builders/where-builder";
import { buildWhereUnique } from "../../builders/where-unique-builder";
import {
  createChildContext,
  getTableName,
  translateRowToFieldNames,
} from "../../context";
import { NestedWriteError, type QueryContext } from "../../types";

/**
 * Single home for the fetch-one-record helpers used across nested writes:
 * SELECT * ... WHERE ... LIMIT 1, execute, translate the row to field names,
 * and (for the required variants) throw the not-found error described by
 * `RecordNotFound`.
 */
export interface RecordNotFound {
  relationName: string;
  operation: string;
  /**
   * Which not-found message the failure surfaces:
   * - "target": the referenced target record does not exist
   * - "correlated": the target exists but is not attached to this parent
   * - "nested-write": top-level batch nested write target missing
   */
  kind: "target" | "correlated" | "nested-write";
}

export function recordNotFoundError(
  notFound: RecordNotFound
): NestedWriteError {
  const { relationName, operation, kind } = notFound;
  switch (kind) {
    case "target":
      return new NestedWriteError(
        `Cannot ${operation} relation '${relationName}': target record was not found.`,
        relationName
      );
    case "correlated":
      return new NestedWriteError(
        `Cannot ${operation} relation '${relationName}': target record was not found for this parent.`,
        relationName
      );
    case "nested-write":
      return new NestedWriteError(
        `Cannot ${operation} nested write: target record was not found.`,
        relationName
      );
    default: {
      const exhaustive: never = kind;
      return exhaustive;
    }
  }
}

export function buildSelectOneSql(
  ctx: QueryContext,
  targetModel: Model<any>,
  whereClause: Sql
): Sql {
  const table = ctx.adapter.identifiers.escape(getTableName(targetModel));
  return sql.join(
    [
      ctx.adapter.clauses.select(sql`*`),
      ctx.adapter.clauses.from(table),
      ctx.adapter.clauses.where(whereClause),
      ctx.adapter.clauses.limit(ctx.adapter.literals.value(1)),
    ],
    " "
  );
}

export function buildUniqueWithWhere(
  ctx: QueryContext,
  model: Model<any>,
  uniqueWhere: Record<string, unknown>,
  where: Record<string, unknown>
): Sql {
  const tableName = getTableName(model);
  const targetCtx =
    model === ctx.model ? ctx : createChildContext(ctx, model, ctx.nextAlias());
  const uniqueClause = buildWhereUnique(targetCtx, uniqueWhere, tableName);
  const whereClause = buildWhere(targetCtx, where, tableName);
  return whereClause
    ? ctx.adapter.operators.and(uniqueClause, whereClause)
    : uniqueClause;
}

export async function fetchOptionalWhereRecord(
  driver: AnyDriver,
  ctx: QueryContext,
  model: Model<any>,
  whereClause: Sql
): Promise<Record<string, unknown> | undefined> {
  const result = await driver._execute<Record<string, unknown>>(
    buildSelectOneSql(ctx, model, whereClause)
  );
  const row = result.rows[0];
  return row && translateRowToFieldNames(model, row);
}

export async function fetchOptionalUniqueRecord(
  driver: AnyDriver,
  ctx: QueryContext,
  model: Model<any>,
  where: Record<string, unknown>
): Promise<Record<string, unknown> | undefined> {
  const childCtx =
    model === ctx.model ? ctx : createChildContext(ctx, model, ctx.nextAlias());
  const whereClause = buildWhereUnique(childCtx, where, getTableName(model));
  return fetchOptionalWhereRecord(driver, childCtx, model, whereClause);
}

export async function fetchOptionalUniqueWithWhereRecord(
  driver: AnyDriver,
  ctx: QueryContext,
  model: Model<any>,
  uniqueWhere: Record<string, unknown>,
  where: Record<string, unknown>
): Promise<Record<string, unknown> | undefined> {
  return fetchOptionalWhereRecord(
    driver,
    ctx,
    model,
    buildUniqueWithWhere(ctx, model, uniqueWhere, where)
  );
}

export async function fetchRequiredWhereRecord(
  driver: AnyDriver,
  ctx: QueryContext,
  model: Model<any>,
  whereClause: Sql,
  notFound: RecordNotFound
): Promise<Record<string, unknown>> {
  const record = await fetchOptionalWhereRecord(
    driver,
    ctx,
    model,
    whereClause
  );
  if (!record) {
    throw recordNotFoundError(notFound);
  }
  return record;
}

export async function fetchRequiredUniqueRecord(
  driver: AnyDriver,
  ctx: QueryContext,
  model: Model<any>,
  where: Record<string, unknown>,
  notFound: RecordNotFound
): Promise<Record<string, unknown>> {
  const record = await fetchOptionalUniqueRecord(driver, ctx, model, where);
  if (!record) {
    throw recordNotFoundError(notFound);
  }
  return record;
}
