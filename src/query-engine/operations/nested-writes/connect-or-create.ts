import type { AnyDriver } from "@drivers";
import { sql } from "@sql";
import {
  type ConnectOrCreateInput,
  getFkDirection,
} from "../../builders/relation-data-builder";
import { buildWhereUnique } from "../../builders/where-unique-builder";
import {
  createChildContext,
  getTableName,
  translateRowToFieldNames,
} from "../../context";
import type { QueryContext, RelationInfo } from "../../types";
import { executeRelationConnect } from "./connect";
import type { TransactionContext } from "./create";
import { connectCreatedRecordToCurrentParent } from "./fk";
import type { RelationMutationExecutors } from "./relation-mutation";

export async function executeConnectOrCreate(
  tx: AnyDriver,
  ctx: QueryContext,
  relationInfo: RelationInfo,
  input: ConnectOrCreateInput,
  timing: "before" | "after",
  parentData: Record<string, unknown>,
  txCtx: TransactionContext,
  createRelation: RelationMutationExecutors["create"]
): Promise<Record<string, unknown> | undefined> {
  const { adapter } = ctx;
  const { targetModel } = relationInfo;
  const childCtx = createChildContext(ctx, targetModel, ctx.nextAlias());
  const targetTable = getTableName(targetModel);
  const alias = childCtx.rootAlias;
  const whereClause = buildWhereUnique(childCtx, input.where, alias);
  const selectSql = sql.join(
    [
      adapter.clauses.select(sql`*`),
      adapter.clauses.from(
        sql`${adapter.identifiers.escape(targetTable)} ${adapter.identifiers.escape(alias)}`
      ),
      adapter.clauses.where(whereClause),
      adapter.clauses.limit(adapter.literals.value(1)),
    ],
    " "
  );

  const result = await tx._execute<Record<string, unknown>>(selectSql);

  if (result.rows.length > 0) {
    const foundRecord = translateRowToFieldNames(targetModel, result.rows[0]!);
    const fkDir = getFkDirection(ctx, relationInfo);

    if (fkDir.holdsFK && timing === "after") {
      await connectCreatedRecordToCurrentParent(
        tx,
        ctx,
        relationInfo,
        foundRecord,
        parentData,
        "connectOrCreate"
      );
      return foundRecord;
    }

    if (!fkDir.holdsFK && timing === "after") {
      await executeRelationConnect(
        tx,
        ctx,
        relationInfo,
        input.where,
        parentData,
        txCtx
      );
      const refetchResult =
        await tx._execute<Record<string, unknown>>(selectSql);
      const refetched = refetchResult.rows[0];
      return refetched
        ? translateRowToFieldNames(targetModel, refetched)
        : foundRecord;
    }

    return foundRecord;
  }

  return createRelation(
    tx,
    ctx,
    relationInfo,
    input.create,
    timing,
    parentData
  );
}
