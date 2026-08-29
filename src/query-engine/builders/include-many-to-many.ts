import { assembleAdapterSelect } from "@adapters/adapter-internals";
import { type Sql, sql } from "@sql";
import { createChildScope } from "../context";
import type { QueryScope, RelationRef } from "../types";
import type { BuildNestedSelection, IncludeResult } from "./include-builder";
import { assembleInnerQuery, type IncludeOptions } from "./include-query";
import { buildNestedReadWindow } from "./nested-read-window";
import {
  buildPolymorphicMemberOrphanProbe,
  buildPolymorphicMemberOuterFrom,
} from "./polymorphic-member-join-parts";
import type { JunctionRelationTraversal } from "./relation-traversal";
import { buildWhere } from "./where-builder";

/**
 * Build include for a junction relation using LATERAL join.
 *
 * Strategy:
 * LEFT JOIN LATERAL (
 *   SELECT json_agg(inner._json) AS _result
 *   FROM (
 *     SELECT json_expr AS _json
 *     FROM junction jt, target t [nestedJoins...]
 *     WHERE correlation AND join AND [innerWhere]
 *     [ORDER/LIMIT/OFFSET]
 *   ) inner
 * ) lateralAlias ON TRUE
 */
export function buildManyToManyLateralInclude(
  buildNestedSelection: BuildNestedSelection,
  ctx: QueryScope,
  relationRef: RelationRef,
  includeValue: Record<string, unknown>,
  traversal: JunctionRelationTraversal
): IncludeResult {
  const { adapter } = ctx;
  const options = includeValue as IncludeOptions;
  const { select, include } = options;

  // The junction and target aliases are the traversal's; the lateral wrap is this
  // builder's own and follows them.
  const { targetAlias } = traversal;
  const lateralAlias = ctx.nextAlias();

  const baseConditions = traversal.conditions();
  const fromClause = traversal.from();

  // Create child context for target
  const childCtx = createChildScope(ctx, relationRef.targetModel, targetAlias);

  // Build JSON expression and collect nested lateral joins
  const selectResult = buildNestedSelection(childCtx, select, include);
  const jsonExpr = selectResult.sql;
  const nestedJoins = selectResult.lateralJoins;

  // Correlation, junction join, relation filter, cursor and window in one place
  const window = buildNestedReadWindow(
    childCtx,
    options,
    targetAlias,
    baseConditions
  );
  const innerJoins = [...nestedJoins, ...window.joins];

  // Build inner query using shared helper
  const jsonColAlias = "_json";
  const aliasedJsonExpr = adapter.identifiers.aliased(jsonExpr, jsonColAlias);

  const innerQuery = assembleInnerQuery(adapter, {
    selectExpr: aliasedJsonExpr,
    from: fromClause,
    joins: innerJoins,
    where: window.where,
    orderBy: window.orderBy,
    take: window.limit,
    skip: window.offset,
    distinct: window.distinct,
    distinctColumnAliases: [jsonColAlias],
  });

  // Wrap with aggregation inside the lateral subquery
  const innerAlias = ctx.nextAlias();
  const jsonColumn = adapter.identifiers.column(innerAlias, jsonColAlias);
  const aggExpr = adapter.json.agg(jsonColumn);
  const resultColAlias = "_result";
  const aliasedAggExpr = adapter.identifiers.aliased(aggExpr, resultColAlias);

  const lateralSubquery = sql.join(
    [
      adapter.clauses.select(aliasedAggExpr),
      adapter.clauses.from(
        sql`(${innerQuery}) ${adapter.identifiers.escape(innerAlias)}`
      ),
    ],
    " "
  );
  const lateralJoin = adapter.joins.lateralLeft(lateralSubquery, lateralAlias);
  const column = adapter.identifiers.column(lateralAlias, resultColAlias);

  return { column, lateralJoin };
}

/**
 * Build include for a junction relation using the junction table.
 *
 * SQL pattern:
 * SELECT COALESCE(json_agg(t0), '[]') FROM (
 *   SELECT json_build_object('id', t.id, 'name', t.name)
 *   FROM junction_table jt, target_table t
 *   WHERE jt.sourceId = parent.id AND t.id = jt.targetId
 *   [AND inner_where]
 *   [ORDER BY ...]
 *   [LIMIT/OFFSET]
 * ) t0
 */
export function buildManyToManyInclude(
  buildNestedSelection: BuildNestedSelection,
  ctx: QueryScope,
  relationRef: RelationRef,
  includeValue: Record<string, unknown>,
  traversal: JunctionRelationTraversal
): Sql {
  const { adapter } = ctx;
  const options = includeValue as IncludeOptions;
  const { select, include } = options;

  const { targetAlias } = traversal;
  const baseConditions = traversal.conditions();
  const fromClause = traversal.from();

  // Create child context for target
  const childCtx = createChildScope(ctx, relationRef.targetModel, targetAlias);

  // Build the JSON object for selected fields
  const jsonExpr = buildNestedSelection(childCtx, select, include).sql;

  // Correlation, junction join, relation filter, cursor and window in one place
  const window = buildNestedReadWindow(
    childCtx,
    options,
    targetAlias,
    baseConditions
  );

  // Build inner query using shared helper
  const jsonColAlias = "_json";
  const aliasedJsonExpr = adapter.identifiers.aliased(jsonExpr, jsonColAlias);

  const innerQuery = assembleInnerQuery(adapter, {
    selectExpr: aliasedJsonExpr,
    from: fromClause,
    joins: window.joins,
    where: window.where,
    orderBy: window.orderBy,
    take: window.limit,
    skip: window.offset,
    distinct: window.distinct,
    distinctColumnAliases: [jsonColAlias],
  });

  // Wrap with aggregation
  const subAlias = ctx.nextAlias();
  const jsonColumn = adapter.identifiers.column(subAlias, jsonColAlias);
  const rows = adapter.subqueries.scalar(
    sql.join(
      [
        adapter.clauses.select(adapter.json.agg(jsonColumn)),
        adapter.clauses.from(
          sql`(${innerQuery}) ${adapter.identifiers.escape(subAlias)}`
        ),
      ],
      " "
    )
  );
  // A to-many leaf owes a ROW ARRAY; an object is the shape its parser names.
  // An ordinary pair table carries no flag and leaves this expression untouched.
  return guardJunctionIntegrity(
    ctx,
    traversal,
    rows,
    adapter.json.objectFromColumns([])
  );
}

/**
 * Guard a junction read leaf with its MEMBERSHIP-FIRST integrity facts.
 *
 * Only a polymorphic collection member table gets this: an ordinary pair table's
 * bytes are unchanged, which is what the flag on the membership is for. Real
 * target foreign keys make an orphan exceptional, but a disabled constraint or a
 * hostile raw write must still fail loudly when the relation is READ.
 *
 * Both facts are computed in SIBLING scalar subqueries that carry no user filter,
 * no cursor and no window, so they sit OUTSIDE — and therefore ahead of — the
 * projection's `WHERE` and `LIMIT`: a target filter that would leave exactly one
 * visible row cannot hide a duplicate membership, and a `LIMIT 1` cannot hide an
 * orphan.
 *
 * The refusal is carried in the VALUE, not raised in SQL: no provider has a
 * portable `RAISE`. Each branch emits a JSON array where the leaf's contract
 * demands one row object, or a JSON object where it demands an array — shapes
 * the strict result parser already refuses by name, and shapes no projection of
 * a model row can produce.
 */
function guardJunctionIntegrity(
  ctx: QueryScope,
  traversal: JunctionRelationTraversal,
  projected: Sql,
  malformed: Sql
): Sql {
  const membership = traversal.membership();
  if (!membership.polymorphicMember) return projected;

  const { adapter } = ctx;
  const [correlationCondition, joinCondition] = traversal.conditions();
  const membershipCount = adapter.subqueries.scalar(
    assembleAdapterSelect(adapter, {
      columns: adapter.aggregates.count(),
      from: adapter.identifiers.table(
        membership.table,
        traversal.junctionAlias
      ),
      where: correlationCondition,
    })
  );
  const orphanCount = adapter.subqueries.scalar(
    assembleAdapterSelect(adapter, {
      columns: adapter.aggregates.count(),
      from: buildPolymorphicMemberOuterFrom(
        ctx,
        membership,
        joinCondition,
        traversal.junctionAlias,
        traversal.targetAlias
      ),
      where: adapter.operators.and(
        correlationCondition,
        buildPolymorphicMemberOrphanProbe(
          ctx,
          membership,
          traversal.targetAlias
        )
      ),
    })
  );

  const branches: { readonly when: Sql; readonly then: Sql }[] = [
    // ORPHANED MEMBERSHIP — the membership row survives, its target does not.
    {
      when: adapter.operators.gt(orphanCount, adapter.literals.value(0)),
      then: malformed,
    },
  ];
  if (traversal.cardinality() === "one") {
    // DUPLICATE MEMBERSHIP — a singular inverse holding more than one member is
    // malformed provider state even if a missing unique constraint allowed it.
    branches.push({
      when: adapter.operators.gt(membershipCount, adapter.literals.value(1)),
      then: malformed,
    });
  }
  return adapter.expressions.caseWhen(branches, projected);
}

/**
 * Build the include leaf of a SINGULAR junction traversal — a non-owning
 * `s.toOne` bound to a collection member whose inverse is singular.
 *
 * Ordinary relation schemas, ordinary to-one result: the zero/one projected row,
 * `LIMIT 1`, `null` when absent. The only addition is the integrity guard, and
 * it is evaluated before the row subquery contributes anything.
 */
export function buildSingularJunctionInclude(
  buildNestedSelection: BuildNestedSelection,
  ctx: QueryScope,
  relationRef: RelationRef,
  includeValue: Record<string, unknown>,
  traversal: JunctionRelationTraversal
): Sql {
  const { adapter } = ctx;
  const options = includeValue as IncludeOptions;
  const { select, include, where } = options;
  const { targetAlias } = traversal;
  const childCtx = createChildScope(ctx, relationRef.targetModel, targetAlias);

  const jsonExpr = buildNestedSelection(childCtx, select, include).sql;
  const conditions: Sql[] = [...traversal.conditions()];
  const innerWhere = buildWhere(childCtx, where, targetAlias);
  if (innerWhere) conditions.push(innerWhere);

  const row = adapter.subqueries.scalar(
    assembleInnerQuery(adapter, {
      selectExpr: jsonExpr,
      from: traversal.from(),
      where: adapter.operators.and(...conditions),
      take: 1,
    })
  );
  // A to-one leaf owes ONE ROW OBJECT; an array is the shape its parser names.
  return guardJunctionIntegrity(ctx, traversal, row, adapter.json.emptyArray());
}
