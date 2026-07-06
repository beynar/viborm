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

export async function executeRelationDelete(
  tx: AnyDriver,
  ctx: QueryContext,
  relationInfo: RelationInfo,
  deleteInput: boolean | Record<string, unknown> | Record<string, unknown>[],
  parentData: Record<string, unknown>
): Promise<void> {
  const { adapter } = ctx;
  const { targetModel, name } = relationInfo;
  const fkDir = getFkDirection(ctx, relationInfo);
  const targetTable = getTableName(targetModel);
  const childCtx = createChildContext(ctx, targetModel, ctx.nextAlias());
  let whereClause: Sql;
  let shouldRequireAffectedRow = false;

  if (deleteInput === true) {
    whereClause = buildFkMatchCondition(ctx, fkDir, targetModel, parentData);
  } else {
    const inputs = Array.isArray(deleteInput) ? deleteInput : [deleteInput];
    const conditions: Sql[] = [];

    for (const input of inputs) {
      if (typeof input === "object" && input !== null) {
        const condition = buildWhereUnique(childCtx, input, targetTable);
        conditions.push(condition);
      }
    }

    if (conditions.length === 0) {
      throw new NestedWriteError(
        `Invalid delete input for relation '${name}'`,
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
    shouldRequireAffectedRow = true;
  }

  if (fkDir.holdsFK) {
    assertFkCanBeSetNull(name, fkDir);
    const assignments = buildFkNullAssignments(ctx, fkDir, ctx.model);
    const setSql = sql.join(assignments, ", ");
    const parentTable = adapter.identifiers.escape(getTableName(ctx.model));
    const parentWhere = buildCurrentRecordMatchCondition(ctx, parentData);
    const disconnectSql = adapter.mutations.update(
      parentTable,
      setSql,
      parentWhere
    );
    await tx._execute(disconnectSql);

    for (const fkField of fkDir.fkFields) {
      parentData[fkField] = null;
    }
  }

  const table = adapter.identifiers.escape(targetTable);
  const deleteSql = adapter.mutations.delete(table, whereClause);

  const result = await tx._execute(deleteSql);
  if (shouldRequireAffectedRow) {
    await throwIfNoCorrelatedRowsAffected(result, name, "delete");
  }
}
