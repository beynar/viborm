// biome-ignore-all lint/style/useFilenamingConvention: Architecture names this compiler child ManyToManyStatements.
import { isSql, type Sql, sql } from "@sql";
import { isRecord } from "@validation/value-guards";
import {
  buildJunctionDeleteCondition,
  buildJunctionInsert,
  buildJunctionInsertMany,
  buildJunctionInsertWhenTargetExists,
  buildJunctionMembership,
  buildJunctionParentValue,
  buildJunctionReferencedValuesSetMatch,
  buildJunctionSourceMatch,
  buildJunctionTargetSubqueriesMatch,
  buildJunctionTargetValue,
  buildTargetPkSubqueries,
  type JunctionSqlValues,
} from "./builders/many-to-many-utils";
import {
  classifyRelation,
  type JunctionBoundRelation,
  type JunctionSide,
} from "./builders/relation-data-builder";
import { buildSelect } from "./builders/select-builder";
import { buildSet } from "./builders/set-builder";
import { buildWhere } from "./builders/where-builder";
import { buildWhereUnique } from "./builders/where-unique-builder";
import { createChildScope, getColumnName, getTableName } from "./context";
import type { QueryScope, RelationInfo } from "./types";
import { QueryEngineError } from "./types";

export type ManyToManyOperation =
  | "junctionDelete"
  | "junctionDeleteTargets"
  | "junctionInsert"
  | "junctionInsertMany"
  | "membershipDifference"
  | "membershipRead"
  | "membershipUpdateMany";

/** Materializes declarative junction and membership statements for the compiler. */
export class ManyToManyStatements {
  private readonly ctx: QueryScope;
  private readonly lockReads: boolean;

  constructor(ctx: QueryScope, lockReads: boolean) {
    this.ctx = ctx;
    this.lockReads = lockReads;
  }

  materialize(
    relation: RelationInfo,
    operation: ManyToManyOperation,
    args: Record<string, unknown>
  ): Sql {
    // This guard IS the classification: it asks the engine's one classifier the
    // question it used to ask of `relation.type` itself, and refuses the same shape
    // with the same sentence. Classifying binds nothing, so a junction's sides are
    // still resolved where they are read, below.
    const classified = classifyRelation(this.ctx, relation);
    if (classified.kind !== "junction") {
      throw new QueryEngineError(
        `Relation statement references unknown many-to-many relation '${relation.name}'.`
      );
    }
    // One bound junction serves every statement below, where each used to
    // re-derive the same topology.
    const junction = classified.bind();
    const parentValues = buildJunctionParentValue(
      this.ctx,
      junction,
      sideValueRecord(junction.membership.source, args.parentValue),
      relation.name
    );

    switch (operation) {
      case "junctionInsert": {
        const targetValue = this.targetValue(junction, args);
        if (args.joinWhenTargetExists === true) {
          return buildJunctionInsertWhenTargetExists(
            this.ctx,
            junction,
            parentValues,
            targetValue
          );
        }
        return buildJunctionInsert(
          this.ctx,
          junction,
          parentValues,
          targetValue
        );
      }
      case "junctionInsertMany": {
        const targets = requireArray(args.targetValues, "targetValues");
        return buildJunctionInsertMany(
          this.ctx,
          junction,
          parentValues,
          this.targetValues(junction, targets)
        );
      }
      case "junctionDelete": {
        const source = buildJunctionSourceMatch(
          this.ctx,
          junction,
          parentValues
        );
        const where = isRecord(args.targetWhere)
          ? this.ctx.adapter.operators.and(
              source,
              buildJunctionTargetSubqueriesMatch(
                this.ctx,
                junction,
                buildTargetPkSubqueries(this.ctx, junction, args.targetWhere)
              )
            )
          : source;
        return this.ctx.adapter.mutations.delete(
          this.ctx.adapter.identifiers.escape(junction.membership.table),
          where
        );
      }
      case "junctionDeleteTargets": {
        const targets = requireArray(args.targetValues, "targetValues");
        const values = this.targetValues(junction, targets);
        const condition =
          values.length === 0
            ? this.falseCondition()
            : buildJunctionDeleteCondition(this.ctx, junction, values);
        return this.ctx.adapter.mutations.delete(
          this.ctx.adapter.identifiers.escape(junction.membership.table),
          condition
        );
      }
      case "membershipRead":
        return this.membershipRead(junction, parentValues, args);
      case "membershipDifference":
        return this.membershipDifference(junction, parentValues, args);
      case "membershipUpdateMany":
        return this.membershipUpdateMany(junction, parentValues, args);
      default: {
        const exhaustive: never = operation;
        throw new QueryEngineError(
          `Unknown relation statement operation '${exhaustive}'.`
        );
      }
    }
  }

  private membershipRead(
    junction: JunctionBoundRelation,
    parentValues: JunctionSqlValues,
    args: Record<string, unknown>
  ): Sql {
    const child = createChildScope(
      this.ctx,
      junction.membership.target.model,
      this.ctx.nextAlias()
    );
    const table = getTableName(junction.membership.target.model);
    const membership = buildJunctionMembership(
      this.ctx,
      junction,
      parentValues,
      table
    );
    const predicates: Sql[] = [membership];
    if (isRecord(args.whereUnique)) {
      predicates.push(buildWhereUnique(child, args.whereUnique, table));
    }
    if (isRecord(args.where)) {
      const filter = buildWhere(
        { ...child, mutationTable: table },
        args.where,
        table
      );
      if (filter) predicates.push(filter);
    }
    if (isSql(args.predicate)) predicates.push(args.predicate);
    const selected = buildSelect(
      child,
      isRecord(args.select) ? args.select : undefined,
      undefined,
      table
    );
    const additionalColumns = Array.isArray(args.additionalColumns)
      ? args.additionalColumns.filter(isSql)
      : [];
    if (
      Array.isArray(args.additionalColumns) &&
      additionalColumns.length !== args.additionalColumns.length
    ) {
      throw new QueryEngineError(
        "Many-to-many membership read received an invalid additional column."
      );
    }
    return this.ctx.adapter.assemble.select({
      columns: additionalColumns.length
        ? sql.join([selected, ...additionalColumns], ", ")
        : selected,
      from: this.ctx.adapter.identifiers.escape(table),
      where: this.ctx.adapter.operators.and(...predicates),
      ...(typeof args.take === "number"
        ? { limit: this.ctx.adapter.literals.value(args.take) }
        : {}),
      ...(this.lockReads && args.lock === "transaction"
        ? { forUpdate: true }
        : {}),
    });
  }

  private membershipDifference(
    junction: JunctionBoundRelation,
    parentValues: JunctionSqlValues,
    args: Record<string, unknown>
  ): Sql {
    const table = getTableName(junction.membership.target.model);
    const child = createChildScope(
      this.ctx,
      junction.membership.target.model,
      this.ctx.nextAlias()
    );
    const membership = buildJunctionMembership(
      this.ctx,
      junction,
      parentValues,
      table
    );
    const filter = isRecord(args.where)
      ? buildWhere({ ...child, mutationTable: table }, args.where, table)
      : undefined;
    const connected = filter
      ? this.ctx.adapter.operators.and(membership, filter)
      : membership;
    const targets = requireArray(args.targetValues, "targetValues");
    const values = this.targetValues(junction, targets);
    const targetPredicates =
      values.length === 0
        ? undefined
        : this.targetSetPredicates(junction, values, table);
    const difference = args.difference;
    let where: Sql;
    if (difference === "added") {
      where =
        targetPredicates === undefined
          ? connected
          : this.ctx.adapter.operators.and(
              connected,
              targetPredicates.excludes
            );
    } else if (difference === "removed") {
      where =
        targetPredicates === undefined
          ? this.falseCondition()
          : this.ctx.adapter.operators.and(
              targetPredicates.matches,
              this.ctx.adapter.operators.not(connected)
            );
    } else {
      throw new QueryEngineError(
        "Membership difference statement has no valid direction."
      );
    }
    return this.ctx.adapter.assemble.select({
      columns: this.ctx.adapter.literals.value(1),
      from: this.ctx.adapter.identifiers.escape(table),
      where,
      limit: this.ctx.adapter.literals.value(1),
    });
  }

  private membershipUpdateMany(
    junction: JunctionBoundRelation,
    parentValues: JunctionSqlValues,
    args: Record<string, unknown>
  ): Sql {
    const child = createChildScope(
      this.ctx,
      junction.membership.target.model,
      this.ctx.nextAlias()
    );
    const table = getTableName(junction.membership.target.model);
    const membership = buildJunctionMembership(
      this.ctx,
      junction,
      parentValues,
      table
    );
    const filter = isRecord(args.where)
      ? buildWhere({ ...child, mutationTable: table }, args.where, table)
      : undefined;
    const data = requireRecord(args.data, "data");
    return this.ctx.adapter.mutations.update(
      this.ctx.adapter.identifiers.escape(table),
      buildSet(child, data),
      filter ? this.ctx.adapter.operators.and(membership, filter) : membership
    );
  }

  private targetValue(
    junction: JunctionBoundRelation,
    args: Record<string, unknown>
  ): JunctionSqlValues {
    const relationName = junction.relationInfo.name;
    if (args.targetValue !== undefined) {
      return buildJunctionTargetValue(
        this.ctx,
        junction,
        sideValueRecord(junction.membership.target, args.targetValue),
        relationName
      );
    }
    if (isRecord(args.targetWhere)) {
      return buildTargetPkSubqueries(this.ctx, junction, args.targetWhere);
    }
    throw new QueryEngineError(
      `Junction insert for relation '${relationName}' has no target.`
    );
  }

  private targetValues(
    junction: JunctionBoundRelation,
    values: unknown[]
  ): JunctionSqlValues[] {
    return values.map((value) =>
      buildJunctionTargetValue(
        this.ctx,
        junction,
        sideValueRecord(junction.membership.target, value),
        junction.relationInfo.name
      )
    );
  }

  private targetSetPredicates(
    junction: JunctionBoundRelation,
    values: readonly JunctionSqlValues[],
    qualifier: string
  ): { readonly matches: Sql; readonly excludes: Sql } {
    const side = junction.membership.target;
    const matches = buildJunctionReferencedValuesSetMatch(
      this.ctx,
      side,
      values,
      qualifier
    );
    if (side.members.length !== 1) {
      return { matches, excludes: this.ctx.adapter.operators.not(matches) };
    }
    const scalars = values.map((tuple) => {
      const value = tuple[0];
      if (!value || tuple.length !== 1) {
        throw new QueryEngineError(
          "Junction target has an incomplete scalar value."
        );
      }
      return value;
    });
    return {
      matches,
      excludes: this.ctx.adapter.operators.notIn(
        this.ctx.adapter.identifiers.column(
          qualifier,
          getColumnName(side.model, side.members[0]!.referencedField)
        ),
        sql`(${sql.join(scalars, ", ")})`
      ),
    };
  }

  private falseCondition(): Sql {
    return this.ctx.adapter.operators.eq(
      this.ctx.adapter.literals.value(1),
      this.ctx.adapter.literals.value(0)
    );
  }
}

/**
 * The compiler carries complete compound keys as field-keyed records. Preserve
 * the scalar call contract by wrapping a lone value only when the side has one
 * member and the value is not already keyed by that member.
 */
function sideValueRecord(
  side: JunctionSide,
  value: unknown
): Record<string, unknown> {
  if (isRecord(value)) {
    const complete = side.members.every(
      (member) =>
        value[member.referencedField] !== undefined ||
        value[getColumnName(side.model, member.referencedField)] !== undefined
    );
    if (complete) return value;
  }
  if (side.members.length === 1) {
    return { [side.members[0]!.referencedField]: value };
  }
  throw new QueryEngineError(
    "Compound junction side requires one value for every referenced field."
  );
}

function requireArray(value: unknown, field: string): unknown[] {
  if (Array.isArray(value)) return value;
  throw new QueryEngineError(`Relation statement is missing '${field}'.`);
}

function requireRecord(value: unknown, field: string): Record<string, unknown> {
  if (isRecord(value)) return value;
  throw new QueryEngineError(`Relation statement is missing '${field}'.`);
}
