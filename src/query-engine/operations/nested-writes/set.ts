import type { AnyDriver } from "@drivers";
import { type Sql, sql } from "@sql";
import {
  type FkDirection,
  getFkDirection,
} from "../../builders/relation-data-builder";
import { buildWhereUnique } from "../../builders/where-unique-builder";
import { createChildContext, getTableName } from "../../context";
import {
  NestedWriteError,
  type QueryContext,
  type RelationInfo,
} from "../../types";
import {
  getNonNullableFkFields,
  throwIfNoCorrelatedRowsAffected,
} from "./assertions";
import {
  buildFkMatchCondition,
  buildFkNullAssignments,
  buildFkValueAssignments,
} from "./fk";
import { fetchRequiredUniqueRecord } from "./record-access";

export async function executeRelationSet(
  tx: AnyDriver,
  ctx: QueryContext,
  relationInfo: RelationInfo,
  setItems: Record<string, unknown>[],
  parentData: Record<string, unknown>
): Promise<void> {
  const { adapter } = ctx;
  const { targetModel, name } = relationInfo;
  const fkDir = getFkDirection(ctx, relationInfo);

  if (fkDir.holdsFK) {
    throw new NestedWriteError(
      `'set' operation is not supported for relation '${name}' where current model holds FK. ` +
        `Use 'connect' instead for to-one relations.`,
      name
    );
  }

  for (const pkField of fkDir.pkFields) {
    if (parentData[pkField] === undefined || parentData[pkField] === null) {
      throw new NestedWriteError(
        `Cannot execute 'set' for relation '${name}': parent record is missing primary key field '${pkField}'. ` +
          "Ensure the parent record is saved before performing nested operations.",
        name
      );
    }
  }

  const targetTable = getTableName(targetModel);
  const childCtx = createChildContext(ctx, targetModel, ctx.nextAlias());
  const table = adapter.identifiers.escape(targetTable);

  // Resolve every target up front: asserts each exists and yields its current
  // FK values so unchanged rows can be skipped below.
  const targetRecords: Record<string, unknown>[] = [];
  for (const setItem of setItems) {
    targetRecords.push(
      await fetchRequiredUniqueRecord(tx, ctx, targetModel, setItem, {
        relationName: name,
        operation: "set",
        kind: "target",
      })
    );
  }

  // Only rows connected to the parent but NOT in the new set leave the
  // relation; rows staying connected are never rewritten.
  const departingWhere = buildDepartingRowsCondition(
    ctx,
    fkDir,
    relationInfo,
    setItems,
    parentData,
    childCtx
  );

  const requiredFkFields = getNonNullableFkFields(fkDir);
  if (requiredFkFields.length > 0) {
    // Required FK: departing rows cannot be orphaned. Error only when rows
    // would actually depart — a no-op set succeeds (Prisma parity).
    await assertNoDepartingRows(
      tx,
      ctx,
      table,
      departingWhere,
      name,
      requiredFkFields
    );
  } else {
    const nullAssignments = buildFkNullAssignments(ctx, fkDir, targetModel);
    const disconnectSql = adapter.mutations.update(
      table,
      sql.join(nullAssignments, ", "),
      departingWhere
    );
    await tx._execute(disconnectSql);
  }

  const valueAssignments = buildFkValueAssignments(
    ctx,
    fkDir,
    targetModel,
    parentData
  );
  const connectSetSql = sql.join(valueAssignments, ", ");

  for (let index = 0; index < setItems.length; index++) {
    // Skip rows already connected: rewriting them is wasted work, and MySQL
    // reports a no-change UPDATE as 0 affected rows, which would trip the
    // rows-affected guard below.
    if (isAlreadyConnected(fkDir, targetRecords[index]!, parentData)) {
      continue;
    }

    const whereClause = buildWhereUnique(
      childCtx,
      setItems[index]!,
      targetTable
    );
    const connectSql = adapter.mutations.update(
      table,
      connectSetSql,
      whereClause
    );
    const result = await tx._execute(connectSql);
    await throwIfNoCorrelatedRowsAffected(result, name, "set");
  }
}

export function buildDepartingRowsCondition(
  ctx: QueryContext,
  fkDir: FkDirection,
  relationInfo: RelationInfo,
  setItems: Record<string, unknown>[],
  parentData: Record<string, unknown>,
  childCtx: QueryContext
): Sql {
  const { adapter } = ctx;
  const targetTable = getTableName(relationInfo.targetModel);
  const fkMatch = buildFkMatchCondition(
    ctx,
    fkDir,
    relationInfo.targetModel,
    parentData
  );

  if (setItems.length === 0) {
    return fkMatch;
  }

  const memberConditions = setItems.map((setItem) =>
    buildWhereUnique(childCtx, setItem, targetTable)
  );
  const memberWhere =
    memberConditions.length === 1
      ? memberConditions[0]!
      : adapter.operators.or(...memberConditions);

  // COALESCE to FALSE before negating: when a connected row has NULL in a
  // unique column referenced by a set item, memberWhere evaluates to NULL and
  // NOT(NULL) is NULL — the row would silently stay connected instead of
  // departing (SQL three-valued logic).
  return adapter.operators.and(
    fkMatch,
    adapter.operators.not(
      adapter.expressions.coalesce(memberWhere, adapter.literals.false())
    )
  );
}

async function assertNoDepartingRows(
  tx: AnyDriver,
  ctx: QueryContext,
  table: Sql,
  departingWhere: Sql,
  relationName: string,
  requiredFkFields: string[]
): Promise<void> {
  const { adapter } = ctx;
  const checkSql = sql.join(
    [
      adapter.clauses.select(sql`1`),
      adapter.clauses.from(table),
      adapter.clauses.where(departingWhere),
      adapter.clauses.limit(adapter.literals.value(1)),
    ],
    " "
  );
  const result = await tx._execute(checkSql);

  if (result.rows.length === 0) {
    return;
  }

  throw new NestedWriteError(
    `Cannot set relation '${relationName}' because foreign key field(s) ${requiredFkFields.join(
      ", "
    )} are required: rows removed from the set cannot be disconnected. Delete them instead.`,
    relationName
  );
}

function isAlreadyConnected(
  fkDir: FkDirection,
  targetRecord: Record<string, unknown>,
  parentData: Record<string, unknown>
): boolean {
  return fkDir.fkFields.every((fkField, index) => {
    const currentValue = targetRecord[fkField];
    const parentValue = parentData[fkDir.pkFields[index]!];
    if (currentValue === null || currentValue === undefined) {
      return false;
    }
    if (parentValue === null || parentValue === undefined) {
      return false;
    }
    // String comparison bridges driver value types (number vs bigint ids).
    return (
      currentValue === parentValue ||
      String(currentValue) === String(parentValue)
    );
  });
}
