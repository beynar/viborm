import type { AnyDriver } from "@drivers";
import { type Sql, sql } from "@sql";
import { getFkDirection } from "../../builders/relation-data-builder";
import { buildWhereUnique } from "../../builders/where-unique-builder";
import { createChildContext, getTableName } from "../../context";
import {
  NestedWriteError,
  type QueryContext,
  type RelationInfo,
} from "../../types";
import {
  assertFkCanBeSetNull,
  throwIfNoCorrelatedRowsAffected,
} from "./assertions";
import {
  buildCurrentRecordMatchCondition,
  buildFkMatchCondition,
  buildFkNullAssignments,
  combineWithParentCorrelation,
} from "./fk";

export async function executeRelationDisconnect(
  tx: AnyDriver,
  ctx: QueryContext,
  relationInfo: RelationInfo,
  disconnectInput:
    | boolean
    | Record<string, unknown>
    | Record<string, unknown>[],
  parentData: Record<string, unknown>
): Promise<void> {
  const { adapter } = ctx;
  const { targetModel, name } = relationInfo;
  const fkDir = getFkDirection(ctx, relationInfo);

  if (fkDir.holdsFK) {
    assertFkCanBeSetNull(name, fkDir);

    const assignments = buildFkNullAssignments(ctx, fkDir, ctx.model);
    const setSql = sql.join(assignments, ", ");
    const table = adapter.identifiers.escape(getTableName(ctx.model));
    const whereClause = buildCurrentRecordMatchCondition(ctx, parentData);
    const updateSql = adapter.mutations.update(table, setSql, whereClause);
    const result = await tx._execute(updateSql);
    await throwIfNoCorrelatedRowsAffected(result, name, "disconnect");

    for (const fkField of fkDir.fkFields) {
      parentData[fkField] = null;
    }

    return;
  }

  assertFkCanBeSetNull(name, fkDir);

  const targetTable = getTableName(targetModel);
  const childCtx = createChildContext(ctx, targetModel, ctx.nextAlias());
  let whereClause: Sql;

  if (disconnectInput === true) {
    whereClause = buildFkMatchCondition(ctx, fkDir, targetModel, parentData);
  } else {
    const inputs = Array.isArray(disconnectInput)
      ? disconnectInput
      : [disconnectInput];
    const conditions: Sql[] = [];

    for (const input of inputs) {
      if (typeof input === "object" && input !== null) {
        const condition = buildWhereUnique(childCtx, input, targetTable);
        conditions.push(condition);
      }
    }

    if (conditions.length === 0) {
      throw new NestedWriteError(
        `Invalid disconnect input for relation '${name}'`,
        name
      );
    }

    whereClause =
      conditions.length === 1
        ? conditions[0]!
        : adapter.operators.or(...conditions);
    whereClause = combineWithParentCorrelation(
      ctx,
      fkDir,
      targetModel,
      whereClause,
      parentData
    );
  }

  const assignments = buildFkNullAssignments(ctx, fkDir, targetModel);
  const setSql = sql.join(assignments, ", ");
  const table = adapter.identifiers.escape(targetTable);
  const updateSql = adapter.mutations.update(table, setSql, whereClause);

  const result = await tx._execute(updateSql);
  if (disconnectInput !== true) {
    await throwIfNoCorrelatedRowsAffected(result, name, "disconnect");
  }
}
