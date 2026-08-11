// biome-ignore-all lint/style/useFilenamingConvention: Architecture names this compiler child ManyToManyStatements.
import { isSql, type Sql, sql } from "@sql";
import { isRecord } from "@validation/value-guards";
import {
  buildJunctionDeleteCondition,
  buildJunctionInsert,
  buildJunctionInsertMany,
  buildJunctionMembership,
  buildJunctionParentValue,
  buildJunctionSourceMatch,
  buildJunctionTargetIn,
  buildJunctionTargetValue,
  buildTargetPkSubquery,
} from "./builders/many-to-many-utils";
import {
  classifyRelation,
  type JunctionBoundRelation,
  junctionSideMember,
} from "./builders/relation-data-builder";
import { buildSelect } from "./builders/select-builder";
import { buildSet } from "./builders/set-builder";
import { buildScalarSqlValue } from "./builders/values-builder";
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
    const parentValue = buildJunctionParentValue(
      this.ctx,
      junction,
      {
        [junctionSideMember(junction.membership.source).referencedField]:
          args.parentValue,
      },
      relation.name
    );

    switch (operation) {
      case "junctionInsert": {
        const targetValue = this.targetValue(junction, args);
        return buildJunctionInsert(
          this.ctx,
          junction,
          parentValue,
          targetValue
        );
      }
      case "junctionInsertMany": {
        const targets = requireArray(args.targetValues, "targetValues");
        return buildJunctionInsertMany(
          this.ctx,
          junction,
          parentValue,
          this.targetValues(junction, targets)
        );
      }
      case "junctionDelete": {
        const source = buildJunctionSourceMatch(
          this.ctx,
          junction,
          parentValue
        );
        const where = isRecord(args.targetWhere)
          ? this.ctx.adapter.operators.and(
              source,
              buildJunctionTargetIn(
                this.ctx,
                junction,
                buildTargetPkSubquery(this.ctx, junction, args.targetWhere)
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
            : buildJunctionDeleteCondition(
                this.ctx,
                junction,
                sql`(${sql.join(values, ", ")})`
              );
        return this.ctx.adapter.mutations.delete(
          this.ctx.adapter.identifiers.escape(junction.membership.table),
          condition
        );
      }
      case "membershipRead":
        return this.membershipRead(junction, parentValue, args);
      case "membershipDifference":
        return this.membershipDifference(junction, parentValue, args);
      case "membershipUpdateMany":
        return this.membershipUpdateMany(junction, parentValue, args);
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
    parentValue: Sql,
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
      parentValue,
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
    parentValue: Sql,
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
      parentValue,
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
    const pk = this.ctx.adapter.identifiers.column(
      table,
      getColumnName(
        junction.membership.target.model,
        junctionSideMember(junction.membership.target).referencedField
      )
    );
    const difference = args.difference;
    let where: Sql;
    if (difference === "added") {
      where =
        values.length === 0
          ? connected
          : this.ctx.adapter.operators.and(
              connected,
              this.ctx.adapter.operators.notIn(
                pk,
                sql`(${sql.join(values, ", ")})`
              )
            );
    } else if (difference === "removed") {
      where =
        values.length === 0
          ? this.falseCondition()
          : this.ctx.adapter.operators.and(
              this.ctx.adapter.operators.in(
                pk,
                sql`(${sql.join(values, ", ")})`
              ),
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
    parentValue: Sql,
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
      parentValue,
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
  ): Sql {
    const relationName = junction.relationInfo.name;
    if (args.targetValue !== undefined) {
      return buildJunctionTargetValue(
        this.ctx,
        junction,
        {
          [junctionSideMember(junction.membership.target).referencedField]:
            args.targetValue,
        },
        relationName
      );
    }
    if (isRecord(args.targetWhere)) {
      return buildTargetPkSubquery(this.ctx, junction, args.targetWhere);
    }
    throw new QueryEngineError(
      `Junction insert for relation '${relationName}' has no target.`
    );
  }

  private targetValues(
    junction: JunctionBoundRelation,
    values: unknown[]
  ): Sql[] {
    const referencedField = junctionSideMember(
      junction.membership.target
    ).referencedField;
    return values.map((value) =>
      buildScalarSqlValue(
        this.ctx,
        junction.membership.target.model,
        referencedField,
        value
      )
    );
  }

  private falseCondition(): Sql {
    return this.ctx.adapter.operators.eq(
      this.ctx.adapter.literals.value(1),
      this.ctx.adapter.literals.value(0)
    );
  }
}

function requireArray(value: unknown, field: string): unknown[] {
  if (Array.isArray(value)) return value;
  throw new QueryEngineError(`Relation statement is missing '${field}'.`);
}

function requireRecord(value: unknown, field: string): Record<string, unknown> {
  if (isRecord(value)) return value;
  throw new QueryEngineError(`Relation statement is missing '${field}'.`);
}
