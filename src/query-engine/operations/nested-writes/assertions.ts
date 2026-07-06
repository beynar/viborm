import type { AnyDriver } from "@drivers";
import type { Model } from "@schema/model";
import { type Sql, sql } from "@sql";
import type { FkDirection } from "../../builders/relation-data-builder";
import { buildWhereUnique } from "../../builders/where-unique-builder";
import { createChildContext, getTableName } from "../../context";
import { NestedWriteError, type QueryContext } from "../../types";
import type { PlanState } from "./batch-references";
import {
  fetchRequiredUniqueRecord,
  recordNotFoundError,
} from "./record-access";

export type UniqueInput = Record<string, unknown>;

export function normalizeUniqueInputs(
  input: Record<string, unknown> | Record<string, unknown>[]
): UniqueInput[] {
  return Array.isArray(input) ? input : [input];
}

export function assertSingleRelationInput(
  relationName: string,
  operation: string,
  inputs: UniqueInput[]
): void {
  if (inputs.length <= 1) {
    return;
  }

  throw new NestedWriteError(
    `Cannot use multiple '${operation}' inputs for to-one relation '${relationName}'.`,
    relationName
  );
}

export function getNonNullableFkFields(fkDir: FkDirection): string[] {
  return fkDir.fkFields.filter((fkField) => {
    const field = fkDir.fkHolder["~"].state.scalars[fkField];
    return field?.["~"].state.nullable !== true;
  });
}

export function assertFkCanBeSetNull(
  relationName: string,
  fkDir: FkDirection
): void {
  const nonNullableFkFields = getNonNullableFkFields(fkDir);

  if (nonNullableFkFields.length === 0) {
    return;
  }

  throw new NestedWriteError(
    `Cannot disconnect relation '${relationName}' because foreign key field(s) ${nonNullableFkFields.join(
      ", "
    )} are required.`,
    relationName
  );
}

export async function assertUniqueRecordsExist(
  tx: AnyDriver,
  ctx: QueryContext,
  targetModel: Model<any>,
  inputs: UniqueInput[],
  relationName: string,
  operation: string
): Promise<void> {
  await Promise.all(
    inputs.map((input) =>
      fetchRequiredUniqueRecord(tx, ctx, targetModel, input, {
        relationName,
        operation,
        kind: "target",
      })
    )
  );
}

export async function throwIfNoCorrelatedRowsAffected(
  result: { rowCount: number },
  relationName: string,
  operation: string
): Promise<void> {
  if (result.rowCount > 0) {
    return;
  }

  throw recordNotFoundError({ relationName, operation, kind: "correlated" });
}

export function appendAssertUniqueExists(
  state: PlanState,
  ctx: QueryContext,
  model: Model<any>,
  where: Record<string, unknown>
): void {
  const childCtx =
    model === ctx.model ? ctx : createChildContext(ctx, model, ctx.nextAlias());
  const whereClause = buildWhereUnique(childCtx, where, getTableName(model));
  appendAssertWhereExists(state, ctx, model, whereClause);
}

export function appendAssertUniqueMissing(
  state: PlanState,
  ctx: QueryContext,
  model: Model<any>,
  where: Record<string, unknown>
): void {
  const childCtx =
    model === ctx.model ? ctx : createChildContext(ctx, model, ctx.nextAlias());
  const whereClause = buildWhereUnique(childCtx, where, getTableName(model));
  state.statements.push(
    ctx.adapter.assertions.notExists(buildSelectOne(ctx, model, whereClause))
  );
}

export function appendAssertWhereMissing(
  state: PlanState,
  ctx: QueryContext,
  model: Model<any>,
  whereClause: Sql
): void {
  state.statements.push(
    ctx.adapter.assertions.notExists(buildSelectOne(ctx, model, whereClause))
  );
}

export function appendAssertWhereExists(
  state: PlanState,
  ctx: QueryContext,
  model: Model<any>,
  whereClause: Sql
): void {
  state.statements.push(
    ctx.adapter.assertions.exists(buildSelectOne(ctx, model, whereClause))
  );
}

function buildSelectOne(
  ctx: QueryContext,
  model: Model<any>,
  whereClause: Sql
): Sql {
  return sql.join(
    [
      ctx.adapter.clauses.select(sql`1`),
      ctx.adapter.clauses.from(
        ctx.adapter.identifiers.escape(getTableName(model))
      ),
      ctx.adapter.clauses.where(whereClause),
      ctx.adapter.clauses.limit(ctx.adapter.literals.value(1)),
    ],
    " "
  );
}
