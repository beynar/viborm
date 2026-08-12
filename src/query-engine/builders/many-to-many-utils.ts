/**
 * Many-to-Many Junction Utilities
 *
 * Shared logic for building M2M join conditions.
 * Read consumer: relation-traversal (the one traversal source — byte changes here
 * propagate through it to every read builder). Write consumer: ManyToManyStatements.
 */

import { type Sql, sql } from "@sql";
import { createChildScope, getColumnName, getTableName } from "../context";
import { NestedWriteError, type QueryScope } from "../types";
import {
  type JunctionBoundRelation,
  junctionSideMember,
} from "./relation-data-builder";
import { buildScalarSqlValue } from "./values-builder";
import { buildWhereUnique } from "./where-unique-builder";

/**
 * Build the standard M2M join conditions
 *
 * Both conditions fold EVERY member of their side. With one member per side —
 * the only shape the binder resolves today — `operators.and` returns the single
 * conjunct unchanged, so the emitted SQL is the bare equality it has always been.
 *
 * @returns correlationCondition: jt.sourceId = parent.id
 * @returns joinCondition: target.id = jt.targetId
 * @returns fromClause: junction_table jt, target_table t
 */
export function buildManyToManyJoinParts(
  ctx: QueryScope,
  junction: JunctionBoundRelation,
  parentAlias: string,
  junctionAlias: string,
  targetAlias: string
): {
  correlationCondition: Sql;
  joinCondition: Sql;
  fromClause: Sql;
} {
  const { adapter } = ctx;
  const { table, source, target } = junction.membership;

  // 1. Correlation: jt.sourceId = parent.id
  const correlationCondition = adapter.operators.and(
    ...source.members.map((member) =>
      adapter.operators.eq(
        adapter.identifiers.column(junctionAlias, member.junctionField),
        adapter.identifiers.column(
          parentAlias,
          getColumnName(source.model, member.referencedField)
        )
      )
    )
  );

  // 2. Join: target.id = jt.targetId
  const joinCondition = adapter.operators.and(
    ...target.members.map((member) =>
      adapter.operators.eq(
        adapter.identifiers.column(
          targetAlias,
          getColumnName(target.model, member.referencedField)
        ),
        adapter.identifiers.column(junctionAlias, member.junctionField)
      )
    )
  );

  // 3. FROM clause
  const fromClause = sql`${adapter.identifiers.table(table, junctionAlias)}, ${adapter.identifiers.table(getTableName(target.model), targetAlias)}`;

  return { correlationCondition, joinCondition, fromClause };
}

// ============================================================
// JUNCTION WRITE BUILDERS
// Shared by the transaction and batch relation programs.
// ============================================================

/**
 * Resolve the parent's PK value (typed by the parent PK scalar) for junction
 * row writes. Parent rows come either as input data (TS field keys) or raw
 * driver rows (column keys), and in the batch engine the value may be a
 * batch reference — buildScalarSqlValue lowers all of these.
 */
export function buildJunctionParentValue(
  ctx: QueryScope,
  junction: JunctionBoundRelation,
  parentData: Record<string, unknown>,
  relationName: string
): Sql {
  const { model } = junction.membership.source;
  const { referencedField } = junctionSideMember(junction.membership.source);
  const raw =
    parentData[referencedField] ??
    parentData[getColumnName(model, referencedField)];
  if (raw === undefined || raw === null) {
    throw new NestedWriteError(
      `Cannot write many-to-many relation '${relationName}': parent record is missing primary key field '${referencedField}'.`,
      relationName
    );
  }
  return buildScalarSqlValue(ctx, model, referencedField, raw);
}

/**
 * Resolve a target record's PK value for junction row writes.
 */
export function buildJunctionTargetValue(
  ctx: QueryScope,
  junction: JunctionBoundRelation,
  targetRecord: Record<string, unknown>,
  relationName: string
): Sql {
  const { model } = junction.membership.target;
  const { referencedField } = junctionSideMember(junction.membership.target);
  const raw =
    targetRecord[referencedField] ??
    targetRecord[getColumnName(model, referencedField)];
  if (raw === undefined || raw === null) {
    throw new NestedWriteError(
      `Cannot write many-to-many relation '${relationName}': target record is missing primary key field '${referencedField}'.`,
      relationName
    );
  }
  return buildScalarSqlValue(ctx, model, referencedField, raw);
}

/**
 * INSERT a junction row, ignoring duplicates (connect is idempotent — the
 * junction PK (source, target) makes a repeat connect a no-op conflict).
 */
export function buildJunctionInsert(
  ctx: QueryScope,
  junction: JunctionBoundRelation,
  parentValue: Sql,
  targetValue: Sql
): Sql {
  return buildJunctionInsertMany(ctx, junction, parentValue, [targetValue]);
}

/** INSERT junction rows in one portable duplicate-skipping statement. */
export function buildJunctionInsertMany(
  ctx: QueryScope,
  junction: JunctionBoundRelation,
  parentValue: Sql,
  targetValues: readonly Sql[]
): Sql {
  const { adapter } = ctx;
  const membership = junction.membership;
  const sourceField = junctionSideMember(membership.source).junctionField;
  const targetField = junctionSideMember(membership.target).junctionField;
  const table = adapter.identifiers.escape(membership.table);
  const { prefix, suffix } = adapter.mutations.skipDuplicates(sourceField);
  const insertSql = adapter.mutations.insert(
    table,
    [sourceField, targetField],
    targetValues.map((targetValue) => [parentValue, targetValue]),
    prefix
  );
  return sql`${insertSql} ${suffix}`;
}

/** Condition: junction.source = parentValue (unqualified, for junction DML). */
export function buildJunctionSourceMatch(
  ctx: QueryScope,
  junction: JunctionBoundRelation,
  parentValue: Sql
): Sql {
  return ctx.adapter.operators.eq(
    ctx.adapter.identifiers.escape(
      junctionSideMember(junction.membership.source).junctionField
    ),
    parentValue
  );
}

/** Condition: junction.target IN (values | subquery) (for junction DML). */
export function buildJunctionTargetIn(
  ctx: QueryScope,
  junction: JunctionBoundRelation,
  targetValues: Sql
): Sql {
  return ctx.adapter.operators.in(
    ctx.adapter.identifiers.escape(
      junctionSideMember(junction.membership.target).junctionField
    ),
    targetValues
  );
}

/**
 * Scalar subquery resolving a target row's PK from a where-unique input:
 * (SELECT target.pk FROM target WHERE <unique>)
 */
export function buildTargetPkSubquery(
  ctx: QueryScope,
  junction: JunctionBoundRelation,
  whereUnique: Record<string, unknown>
): Sql {
  const { adapter } = ctx;
  const target = junction.membership.target;
  const { model } = target;
  const targetTableName = getTableName(model);
  const childCtx = createChildScope(ctx, model, ctx.nextAlias());
  const whereClause = buildWhereUnique(childCtx, whereUnique, targetTableName);
  const pkCol = adapter.identifiers.column(
    targetTableName,
    getColumnName(model, junctionSideMember(target).referencedField)
  );
  return sql`(SELECT ${pkCol} FROM ${adapter.identifiers.escape(targetTableName)} WHERE ${whereClause})`;
}

/**
 * Condition on the target table: row is connected to the parent through the
 * junction: target.pk IN (SELECT junction.target FROM junction WHERE source = parent)
 */
export function buildJunctionMembership(
  ctx: QueryScope,
  junction: JunctionBoundRelation,
  parentValue: Sql,
  targetTableOrAlias: string
): Sql {
  const { adapter } = ctx;
  const target = junction.membership.target;
  const targetMember = junctionSideMember(target);
  const childPkCol = adapter.identifiers.column(
    targetTableOrAlias,
    getColumnName(target.model, targetMember.referencedField)
  );
  const targetCol = adapter.identifiers.escape(targetMember.junctionField);
  const junctionTable = adapter.identifiers.escape(junction.membership.table);
  const sourceMatch = buildJunctionSourceMatch(ctx, junction, parentValue);
  return sql`${childPkCol} IN (SELECT ${targetCol} FROM ${junctionTable} WHERE ${sourceMatch})`;
}

/**
 * Junction rows referencing the given target PKs — from any parent, and on
 * self-referential relations also rows where the target is the SOURCE. Used to
 * delete every junction row pointing at a child that is being deleted so the
 * child DELETE cannot trip an FK constraint (§9 m2m delete/deleteMany).
 */
export function buildJunctionDeleteCondition(
  ctx: QueryScope,
  junction: JunctionBoundRelation,
  targetPks: Sql
): Sql {
  const condition = buildJunctionTargetIn(ctx, junction, targetPks);
  if (junction.membership.target.model !== ctx.model) {
    return condition;
  }
  return ctx.adapter.operators.or(
    condition,
    ctx.adapter.operators.in(
      ctx.adapter.identifiers.escape(
        junctionSideMember(junction.membership.source).junctionField
      ),
      targetPks
    )
  );
}
