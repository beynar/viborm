import type { AnyDriver } from "@drivers";
import { type Sql, sql } from "@sql";
import { getFkDirection } from "../../builders/relation-data-builder";
import { buildWhereUnique } from "../../builders/where-unique-builder";
import { createChildContext, getTableName } from "../../context";
import type { QueryContext, RelationInfo } from "../../types";
import { throwIfNoCorrelatedRowsAffected } from "./assertions";
import type { TransactionContext } from "./create";
import {
  buildCurrentFkValueAssignmentsFromRecord,
  buildCurrentRecordMatchCondition,
  buildFkValueAssignments,
} from "./fk";
import { fetchRequiredUniqueRecord } from "./record-access";

export async function executeRelationConnect(
  tx: AnyDriver,
  ctx: QueryContext,
  relationInfo: RelationInfo,
  connectInput: Record<string, unknown>,
  parentData: Record<string, unknown>,
  _txCtx: TransactionContext
): Promise<void> {
  const { adapter } = ctx;
  const { targetModel, name } = relationInfo;
  const fkDir = getFkDirection(ctx, relationInfo);

  if (fkDir.holdsFK) {
    const targetRecord = await fetchRequiredUniqueRecord(
      tx,
      ctx,
      targetModel,
      connectInput,
      {
        relationName: name,
        operation: "connect",
        kind: "target",
      }
    );
    const assignments = buildCurrentFkValueAssignmentsFromRecord(
      ctx,
      fkDir,
      targetRecord,
      parentData,
      name
    );
    const setSql = sql.join(assignments, ", ");
    const table = adapter.identifiers.escape(getTableName(ctx.model));
    const whereClause = buildCurrentRecordMatchCondition(ctx, parentData);
    const updateSql = adapter.mutations.update(table, setSql, whereClause);
    const result = await tx._execute(updateSql);
    await throwIfNoCorrelatedRowsAffected(result, name, "connect");
    return;
  }

  const targetTable = getTableName(targetModel);
  const childCtx = createChildContext(ctx, targetModel, ctx.nextAlias());
  const whereClause = buildWhereUnique(childCtx, connectInput, targetTable);
  const assignments: Sql[] = buildFkValueAssignments(
    ctx,
    fkDir,
    targetModel,
    parentData
  );
  const setSql = sql.join(assignments, ", ");
  const table = adapter.identifiers.escape(targetTable);
  const updateSql = adapter.mutations.update(table, setSql, whereClause);

  const result = await tx._execute(updateSql);
  await throwIfNoCorrelatedRowsAffected(result, name, "connect");
}
