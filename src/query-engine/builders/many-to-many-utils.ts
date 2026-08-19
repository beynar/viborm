/**
 * Many-to-Many Junction Utilities
 *
 * Shared logic for building M2M join conditions.
 * Read consumer: relation-traversal (the one traversal source — byte changes here
 * propagate through it to every read builder). Write consumer: JunctionStatements.
 */

import { type Sql, sql } from "@sql";
import { createChildScope, getColumnName, getTableName } from "../context";
import { NestedWriteError, QueryEngineError, type QueryScope } from "../types";
import type {
  BoundJunctionMembership,
  JunctionBoundRelation,
  JunctionReferenceMember,
  JunctionSide,
} from "./relation-data-builder";
import { buildScalarSqlValue } from "./values-builder";
import { buildWhereUnique } from "./where-unique-builder";

/**
 * Build the standard M2M join conditions
 *
 * Both conditions fold EVERY member of their side. With a scalar row key,
 * `operators.and` returns the single conjunct unchanged, so the emitted SQL is
 * the bare equality it has always been; compound sides retain every member.
 *
 * Takes the MEMBERSHIP rather than the bound relation: the two complete ordered
 * references are the whole input, and a direct polymorphic collection arm has a
 * membership without a `RelationInfo` to wrap it in.
 *
 * @returns correlationCondition: jt.sourceId = parent.id
 * @returns joinCondition: target.id = jt.targetId
 * @returns fromClause: junction_table jt, target_table t
 */
export function buildManyToManyJoinParts(
  ctx: QueryScope,
  membership: BoundJunctionMembership,
  parentAlias: string,
  junctionAlias: string,
  targetAlias: string
): {
  correlationCondition: Sql;
  joinCondition: Sql;
  fromClause: Sql;
} {
  const { adapter } = ctx;
  const { table, source, target } = membership;

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
export type JunctionSqlValues = readonly Sql[];

export function buildJunctionParentValue(
  ctx: QueryScope,
  junction: JunctionBoundRelation,
  parentData: Record<string, unknown>,
  relationName: string
): JunctionSqlValues {
  return buildJunctionSideValues(
    ctx,
    junction.membership.source,
    parentData,
    relationName,
    "parent"
  );
}

/**
 * Resolve a target record's PK value for junction row writes.
 */
export function buildJunctionTargetValue(
  ctx: QueryScope,
  junction: JunctionBoundRelation,
  targetRecord: Record<string, unknown>,
  relationName: string
): JunctionSqlValues {
  return buildJunctionSideValues(
    ctx,
    junction.membership.target,
    targetRecord,
    relationName,
    "target"
  );
}

function buildJunctionSideValues(
  ctx: QueryScope,
  side: JunctionSide,
  record: Record<string, unknown>,
  relationName: string,
  position: "parent" | "target"
): JunctionSqlValues {
  return side.members.map((member) => {
    const raw =
      record[member.referencedField] ??
      record[getColumnName(side.model, member.referencedField)];
    if (raw === undefined || raw === null) {
      throw new NestedWriteError(
        `Cannot write many-to-many relation '${relationName}': ${position} record is missing primary key field '${member.referencedField}'.`,
        relationName
      );
    }
    return buildScalarSqlValue(ctx, side.model, member.referencedField, raw);
  });
}

/**
 * The duplicate-skip clause for a junction INSERT, TARGETED at the complete
 * membership key — every source junction column, then every target one.
 *
 * WHAT THE TARGET SEPARATES. An identical `(owner, target)` membership row is
 * idempotent, so it is skipped. A DIFFERENT owner already holding the target is
 * NOT a duplicate: on a polymorphic member table whose inverse is singular, the
 * serializer emits a UNIQUE over the complete target side, and that collision is
 * the whole slot-occupancy signal. A verb with transfer semantics vacates the
 * slot through its own primitive first; a plain insert that bypasses the
 * primitive must surface the native unique failure. The UNTARGETED
 * `ON CONFLICT DO NOTHING` this used to emit swallows both alike — measured on
 * PGlite: with a `(o,t)` PK and a `UNIQUE (t)`, inserting a second owner for an
 * occupied `t` raises under `ON CONFLICT (o,t)` and returns silently under
 * `ON CONFLICT`.
 *
 * UNIFORM across every junction, ordinary pair tables included (polymorphic
 * cardinality plan §9.4, open question 1). A pair table's PK is its only unique
 * constraint, so naming it changes which rows are skipped not at all — while a
 * `cardinality`-shaped branch here would be a SECOND answer to "how does a
 * junction insert skip duplicates", and one answer per question is the rule this
 * estate is built on. The cost is byte churn in the junction pins, nothing else.
 *
 * COLUMN ORDER is the INSERT's own — source side then target side — which need
 * not be the member table's declared PK order (the serializer declares it in
 * canonical `sourceIsFirst` order). PostgreSQL and SQLite infer the arbiter
 * index from the conflict target as a SET: a reordered COMPLETE key infers the
 * same index, an INCOMPLETE one infers nothing and raises. Both were measured
 * before this was written, so the reordering is a fact rather than a hope.
 *
 * MYSQL keeps the untargeted no-op update, because `ON DUPLICATE KEY UPDATE`
 * carries no target at all — that is what
 * `capabilities.supportsTargetedUpsert` names, and its own doc comment explains
 * why the difference is a wrong answer rather than a missing optimization. It
 * stays correct for every junction whose PK is its sole unique constraint.
 *
 * SEAM — Package D fence B (plan §1.7). A member table with a SINGULAR inverse
 * also carries the target-side UNIQUE, which MySQL would swallow here. §1.7
 * answers that with a plain INSERT plus a `TargetConstraintPin` naming the
 * membership PK, so an exact duplicate still converges as an idempotent
 * reconnect while an occupied slot does not. The pin can only be attached by the
 * Part that owns the write step; it is not expressible in an `Sql`, which is why
 * the branch lands with its consumer rather than ahead of it.
 */
function junctionDuplicateSkip(
  ctx: QueryScope,
  sourceFields: readonly string[],
  targetFields: readonly string[],
  duplicateNoopColumn: string
): { readonly prefix: Sql; readonly suffix: Sql } {
  const { adapter } = ctx;
  if (!adapter.capabilities.supportsTargetedUpsert) {
    return adapter.mutations.skipDuplicates(duplicateNoopColumn);
  }
  const membershipKey = sql.join(
    [...sourceFields, ...targetFields].map((field) =>
      adapter.identifiers.escape(field)
    ),
    ", "
  );
  return {
    prefix: sql.empty,
    suffix: adapter.mutations.onConflict(membershipKey, sql`NOTHING`),
  };
}

/**
 * INSERT a junction row, ignoring duplicates (connect is idempotent — the
 * junction PK (source, target) makes a repeat connect a no-op conflict).
 */
export function buildJunctionInsert(
  ctx: QueryScope,
  junction: JunctionBoundRelation,
  parentValues: JunctionSqlValues,
  targetValues: JunctionSqlValues
): Sql {
  return buildJunctionInsertMany(ctx, junction, parentValues, [targetValues]);
}

/**
 * Insert one junction row only when the complete target row key exists.
 *
 * A scalar-only `createMany({ skipDuplicates: true })` row can spell its target
 * key and still skip because a different row owns another unique constraint.
 * The target key remains authoritative: an exact-key duplicate links, while an
 * alternate-key conflict whose target key is absent produces no junction row.
 */
export function buildJunctionInsertWhenTargetExists(
  ctx: QueryScope,
  junction: JunctionBoundRelation,
  parentValues: JunctionSqlValues,
  targetValues: JunctionSqlValues
): Sql {
  const { adapter } = ctx;
  const { source, target } = junction.membership;
  assertJunctionValueArity(source, parentValues);
  assertJunctionValueArity(target, targetValues);
  const sourceFields = source.members.map((member) => member.junctionField);
  const targetFields = target.members.map((member) => member.junctionField);
  const sourceField = sourceFields[0];
  if (sourceField === undefined) {
    throw new QueryEngineError(
      "Junction source has no stored-reference member."
    );
  }
  const targetTable = getTableName(target.model);
  const selectedTargetValues = target.members.map((member) =>
    adapter.identifiers.column(
      targetTable,
      getColumnName(target.model, member.referencedField)
    )
  );
  const select = adapter.assemble.select({
    columns: sql.join([...parentValues, ...selectedTargetValues], ", "),
    from: adapter.identifiers.escape(targetTable),
    where: buildJunctionReferencedValuesMatch(
      ctx,
      target,
      targetValues,
      targetTable
    ),
  });
  const { prefix, suffix } = junctionDuplicateSkip(
    ctx,
    sourceFields,
    targetFields,
    sourceField
  );
  const insert = adapter.mutations.insert(
    adapter.identifiers.escape(junction.membership.table),
    [...sourceFields, ...targetFields],
    { select },
    prefix
  );
  return sql`${insert} ${suffix}`;
}

/** INSERT junction rows in one portable duplicate-skipping statement. */
export function buildJunctionInsertMany(
  ctx: QueryScope,
  junction: JunctionBoundRelation,
  parentValues: JunctionSqlValues,
  targetValues: readonly JunctionSqlValues[]
): Sql {
  const { adapter } = ctx;
  const membership = junction.membership;
  assertJunctionValueArity(membership.source, parentValues);
  for (const target of targetValues) {
    assertJunctionValueArity(membership.target, target);
  }
  const sourceFields = membership.source.members.map(
    (member) => member.junctionField
  );
  const targetFields = membership.target.members.map(
    (member) => member.junctionField
  );
  const sourceField = sourceFields[0];
  if (sourceField === undefined) {
    throw new QueryEngineError(
      "Junction source has no stored-reference member."
    );
  }
  const table = adapter.identifiers.escape(membership.table);
  const { prefix, suffix } = junctionDuplicateSkip(
    ctx,
    sourceFields,
    targetFields,
    sourceField
  );
  const insertSql = adapter.mutations.insert(
    table,
    [...sourceFields, ...targetFields],
    targetValues.map((target) => [...parentValues, ...target]),
    prefix
  );
  return sql`${insertSql} ${suffix}`;
}

/** Condition: junction.source = parentValue (unqualified, for junction DML). */
export function buildJunctionSourceMatch(
  ctx: QueryScope,
  junction: JunctionBoundRelation,
  parentValues: JunctionSqlValues,
  qualifier?: string
): Sql {
  return buildJunctionSideMatch(
    ctx,
    junction.membership.source.members,
    parentValues,
    qualifier
  );
}

/** Condition: a junction target side equals any complete target row key. */
export function buildJunctionTargetValuesMatch(
  ctx: QueryScope,
  junction: JunctionBoundRelation,
  targetValues: readonly JunctionSqlValues[],
  qualifier?: string
): Sql {
  const side = junction.membership.target;
  if (side.members.length === 1) {
    const [member] = side.members;
    if (member === undefined) {
      throw new QueryEngineError(
        "Junction target has no stored-reference member."
      );
    }
    const values = targetValues.map((target) => {
      assertJunctionValueArity(side, target);
      const value = target[0];
      if (!value) {
        throw new QueryEngineError("Junction target has no scalar value.");
      }
      return value;
    });
    const column = junctionColumn(ctx, member, qualifier);
    return ctx.adapter.operators.in(column, sql`(${sql.join(values, ", ")})`);
  }
  return ctx.adapter.operators.or(
    ...targetValues.map((target) =>
      buildJunctionSideMatch(ctx, side.members, target, qualifier)
    )
  );
}

/** Match target junction columns to scalar subqueries selected by one unique row. */
export function buildJunctionTargetSubqueriesMatch(
  ctx: QueryScope,
  junction: JunctionBoundRelation,
  targetValues: JunctionSqlValues,
  qualifier?: string
): Sql {
  const side = junction.membership.target;
  assertJunctionValueArity(side, targetValues);
  if (side.members.length === 1) {
    const value = targetValues[0];
    if (!value) {
      throw new QueryEngineError("Junction target has no scalar subquery.");
    }
    return ctx.adapter.operators.in(
      junctionColumn(ctx, side.members[0]!, qualifier),
      value
    );
  }
  return buildJunctionSideMatch(ctx, side.members, targetValues, qualifier);
}

/** Condition on an endpoint table: its complete referenced key equals one tuple. */
export function buildJunctionReferencedValuesMatch(
  ctx: QueryScope,
  side: JunctionSide,
  values: JunctionSqlValues,
  qualifier: string
): Sql {
  assertJunctionValueArity(side, values);
  return ctx.adapter.operators.and(
    ...side.members.map((member, index) => {
      const value = values[index];
      if (!value) {
        throw new QueryEngineError(
          "Junction referenced side has an incomplete value tuple."
        );
      }
      return ctx.adapter.operators.eq(
        ctx.adapter.identifiers.column(
          qualifier,
          getColumnName(side.model, member.referencedField)
        ),
        value
      );
    })
  );
}

/** Condition on an endpoint table: its complete referenced key is in a tuple set. */
export function buildJunctionReferencedValuesSetMatch(
  ctx: QueryScope,
  side: JunctionSide,
  values: readonly JunctionSqlValues[],
  qualifier: string
): Sql {
  if (side.members.length === 1) {
    const column = ctx.adapter.identifiers.column(
      qualifier,
      getColumnName(side.model, side.members[0]!.referencedField)
    );
    const scalars = values.map((tuple) => {
      assertJunctionValueArity(side, tuple);
      const value = tuple[0];
      if (!value) {
        throw new QueryEngineError("Junction target has no scalar value.");
      }
      return value;
    });
    return ctx.adapter.operators.in(column, sql`(${sql.join(scalars, ", ")})`);
  }
  return ctx.adapter.operators.or(
    ...values.map((tuple) =>
      buildJunctionReferencedValuesMatch(ctx, side, tuple, qualifier)
    )
  );
}

/**
 * Scalar subquery resolving a target row's PK from a where-unique input:
 * (SELECT target.pk FROM target WHERE <unique>)
 */
export function buildTargetPkSubqueries(
  ctx: QueryScope,
  junction: JunctionBoundRelation,
  whereUnique: Record<string, unknown>
): JunctionSqlValues {
  const { adapter } = ctx;
  const target = junction.membership.target;
  const { model } = target;
  const targetTableName = getTableName(model);
  const childCtx = createChildScope(ctx, model, ctx.nextAlias());
  const whereClause = buildWhereUnique(childCtx, whereUnique, targetTableName);
  return target.members.map((member) => {
    const pkCol = adapter.identifiers.column(
      targetTableName,
      getColumnName(model, member.referencedField)
    );
    return sql`(SELECT ${pkCol} FROM ${adapter.identifiers.escape(targetTableName)} WHERE ${whereClause})`;
  });
}

/**
 * Condition on the target table: row is connected to the parent through the
 * junction: target.pk IN (SELECT junction.target FROM junction WHERE source = parent)
 */
export function buildJunctionMembership(
  ctx: QueryScope,
  junction: JunctionBoundRelation,
  parentValues: JunctionSqlValues,
  targetTableOrAlias: string
): Sql {
  const { adapter } = ctx;
  const target = junction.membership.target;
  const junctionTable = adapter.identifiers.escape(junction.membership.table);
  if (target.members.length === 1) {
    const sourceMatch = buildJunctionSourceMatch(ctx, junction, parentValues);
    const targetMember = target.members[0]!;
    const childPkCol = adapter.identifiers.column(
      targetTableOrAlias,
      getColumnName(target.model, targetMember.referencedField)
    );
    const targetCol = adapter.identifiers.escape(targetMember.junctionField);
    return sql`${childPkCol} IN (SELECT ${targetCol} FROM ${junctionTable} WHERE ${sourceMatch})`;
  }
  const sourceMatch = buildJunctionSourceMatch(
    ctx,
    junction,
    parentValues,
    junction.membership.table
  );
  const targetMatch = adapter.operators.and(
    ...target.members.map((member) =>
      adapter.operators.eq(
        adapter.identifiers.column(
          targetTableOrAlias,
          getColumnName(target.model, member.referencedField)
        ),
        adapter.identifiers.column(
          junction.membership.table,
          member.junctionField
        )
      )
    )
  );
  const exists = adapter.assemble.select({
    columns: adapter.literals.value(1),
    from: junctionTable,
    where: adapter.operators.and(sourceMatch, targetMatch),
  });
  return adapter.operators.exists(exists);
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
  targetValues: readonly JunctionSqlValues[]
): Sql {
  const condition = buildJunctionTargetValuesMatch(ctx, junction, targetValues);
  if (junction.membership.target.model !== ctx.model) {
    return condition;
  }
  return ctx.adapter.operators.or(
    condition,
    buildJunctionSideValuesSetMatch(
      ctx,
      junction.membership.source,
      targetValues
    )
  );
}

function buildJunctionSideValuesSetMatch(
  ctx: QueryScope,
  side: JunctionSide,
  values: readonly JunctionSqlValues[],
  qualifier?: string
): Sql {
  if (side.members.length === 1) {
    const scalars = values.map((tuple) => {
      assertJunctionValueArity(side, tuple);
      const value = tuple[0];
      if (!value) {
        throw new QueryEngineError("Junction side has no scalar value.");
      }
      return value;
    });
    return ctx.adapter.operators.in(
      junctionColumn(ctx, side.members[0]!, qualifier),
      sql`(${sql.join(scalars, ", ")})`
    );
  }
  return ctx.adapter.operators.or(
    ...values.map((tuple) =>
      buildJunctionSideMatch(ctx, side.members, tuple, qualifier)
    )
  );
}

function buildJunctionSideMatch(
  ctx: QueryScope,
  members: readonly JunctionReferenceMember[],
  values: JunctionSqlValues,
  qualifier?: string
): Sql {
  if (members.length !== values.length) {
    throw new QueryEngineError(
      "Junction side value count does not match its stored reference."
    );
  }
  return ctx.adapter.operators.and(
    ...members.map((member, index) => {
      const value = values[index];
      if (!value) {
        throw new QueryEngineError(
          "Junction side has an incomplete value tuple."
        );
      }
      return ctx.adapter.operators.eq(
        junctionColumn(ctx, member, qualifier),
        value
      );
    })
  );
}

function junctionColumn(
  ctx: QueryScope,
  member: JunctionReferenceMember,
  qualifier?: string
): Sql {
  return qualifier
    ? ctx.adapter.identifiers.column(qualifier, member.junctionField)
    : ctx.adapter.identifiers.escape(member.junctionField);
}

function assertJunctionValueArity(
  side: JunctionSide,
  values: JunctionSqlValues
): void {
  if (values.length !== side.members.length) {
    throw new QueryEngineError(
      "Junction side value count does not match its stored reference."
    );
  }
}
