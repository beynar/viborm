/**
 * Relation Traversal
 *
 * The ONE owner of a read's PHYSICAL traversal of a relation: the aliases the
 * traversal spends, the FROM source those aliases name, the conditions that tie
 * the traversed rows to the parent row, and the tables the traversal reads.
 *
 * It is not a read AST. It owns nothing semantic: selection, aggregation, lateral
 * strategy, windows, filter quantifiers, negation, ordering, result parsing and
 * mutation-target hiding all stay with the builders that own those meanings. A
 * builder constructs one traversal per relation occurrence and keeps its own
 * statement shape around it.
 *
 * DIRECT polymorphic reads are deliberately outside: `polymorphic-read-builder.ts`
 * traverses a payload-selected variant target-first, and a payload-selected
 * polymorphic field is not a bound relation.
 */

import type { Sql } from "@sql";
import { getTableName } from "../context";
import type { QueryScope, RelationInfo } from "../types";
import { buildCorrelation } from "./correlation-utils";
import { buildManyToManyJoinParts } from "./many-to-many-utils";
import {
  type ChildHeldRelation,
  classifyRelation,
  type JunctionBoundRelation,
  type ParentHeldRelation,
} from "./relation-data-builder";

/**
 * A traversal of a relation whose membership one of the two ROWS stores — the
 * classifier's `rowHeld` answer, read as one table.
 *
 * `conditions()` returns EXACTLY ONE element, and that element is already folded:
 * a compound foreign key and a polymorphic inverse each compare several columns,
 * and those conjuncts are one group. Handing them back as several elements would
 * flatten the group as soon as a caller appends an inner `where`
 * (`((a AND b) AND inner)` becomes `(a AND b AND inner)`), which is a different
 * statement.
 */
export type OrdinaryRelationTraversal = {
  readonly kind: "ordinary";
  /** The alias the traversed rows are read under. */
  readonly targetAlias: string;
  readonly relation: () => ParentHeldRelation | ChildHeldRelation;
  /** `target AS tN` */
  readonly from: () => Sql;
  /** The parent correlation, pre-folded — always one element. */
  readonly conditions: () => readonly Sql[];
  readonly tables: () => readonly string[];
};

/**
 * A traversal of a relation whose membership a JUNCTION table stores.
 *
 * `conditions()` returns the two conjuncts the junction owner produces —
 * parent correlation, then junction/target join — as separate elements, because
 * that flat shape is the statement the junction read has always emitted.
 */
export type JunctionRelationTraversal = {
  readonly kind: "junction";
  /** The alias the junction rows are read under. */
  readonly junctionAlias: string;
  /** The alias the traversed rows are read under. */
  readonly targetAlias: string;
  readonly junction: () => JunctionBoundRelation;
  /** `junction AS tJ, target AS tT` */
  readonly from: () => Sql;
  /** Parent correlation and junction join, in that order — always two elements. */
  readonly conditions: () => readonly Sql[];
  readonly tables: () => readonly string[];
};

export type RelationTraversal =
  | OrdinaryRelationTraversal
  | JunctionRelationTraversal;

/**
 * Build the physical traversal of one relation occurrence.
 *
 * TWO TIMINGS, deliberately different:
 *
 * - CLASSIFICATION and ALIASES are eager. Which arm a relation takes decides how
 *   many aliases the traversal spends, and alias numbers are SQL bytes — every
 *   read builder allocates them exactly here, before its lateral alias and before
 *   any nested selection or nested where. Constructing a traversal is therefore
 *   the only alias allocation it performs; the lateral, inner, sub and
 *   mutation-hide aliases stay with the builders that own those wraps.
 * - TOPOLOGY is lazy and memoized. Binding resolves inverses and junction sides,
 *   and both can refuse. A caller that classifies (spends aliases) and then
 *   short-circuits — an `every: {}` quantifier with no inner condition — must
 *   still short-circuit silently, exactly as it did when the bind sat below its
 *   early return.
 */
export function buildRelationTraversal(
  ctx: QueryScope,
  relationInfo: RelationInfo,
  parentAlias: string
): RelationTraversal {
  const classified = classifyRelation(ctx, relationInfo);

  if (classified.kind === "junction") {
    const junctionAlias = ctx.nextAlias();
    const targetAlias = ctx.nextAlias();
    return buildJunctionTraversal(
      ctx,
      classified.bind,
      parentAlias,
      junctionAlias,
      targetAlias
    );
  }

  const targetAlias = ctx.nextAlias();
  return buildOrdinaryTraversal(
    ctx,
    relationInfo,
    classified.bind,
    parentAlias,
    targetAlias
  );
}

function buildOrdinaryTraversal(
  ctx: QueryScope,
  relationInfo: RelationInfo,
  bind: () => ParentHeldRelation | ChildHeldRelation,
  parentAlias: string,
  targetAlias: string
): OrdinaryRelationTraversal {
  let bound: ParentHeldRelation | ChildHeldRelation | undefined;
  const relation = (): ParentHeldRelation | ChildHeldRelation => {
    bound ??= bind();
    return bound;
  };

  // The target TABLE is knowable from the relation's public target model, so
  // neither the FROM source nor the mutation-target table list forces a bind —
  // the same order the builders read them in today.
  const targetTable = (): string => getTableName(relationInfo.targetModel);

  let correlation: Sql | undefined;
  return {
    kind: "ordinary",
    targetAlias,
    relation,
    from: () => ctx.adapter.identifiers.table(targetTable(), targetAlias),
    conditions: () => {
      correlation ??= buildCorrelation(
        ctx,
        relation(),
        parentAlias,
        targetAlias
      );
      return [correlation];
    },
    tables: () => [targetTable()],
  };
}

function buildJunctionTraversal(
  ctx: QueryScope,
  bind: () => JunctionBoundRelation,
  parentAlias: string,
  junctionAlias: string,
  targetAlias: string
): JunctionRelationTraversal {
  let bound: JunctionBoundRelation | undefined;
  const junction = (): JunctionBoundRelation => {
    bound ??= bind();
    return bound;
  };

  // One resolution of the junction algebra, whichever part is asked for first —
  // the single `buildManyToManyJoinParts` call the four call prologues each made.
  type JoinParts = ReturnType<typeof buildManyToManyJoinParts>;
  let parts: JoinParts | undefined;
  const resolve = (): JoinParts => {
    parts ??= buildManyToManyJoinParts(
      ctx,
      junction(),
      parentAlias,
      junctionAlias,
      targetAlias
    );
    return parts;
  };

  return {
    kind: "junction",
    junctionAlias,
    targetAlias,
    junction,
    from: () => resolve().fromClause,
    conditions: () => {
      const { correlationCondition, joinCondition } = resolve();
      return [correlationCondition, joinCondition];
    },
    tables: () => {
      const { table, target } = junction().membership;
      return [table, getTableName(target.model)];
    },
  };
}
