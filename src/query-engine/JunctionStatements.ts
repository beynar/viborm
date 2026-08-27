// biome-ignore-all lint/style/useFilenamingConvention: Architecture names this compiler child JunctionStatements.
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
  buildJunctionTargetValuesMatch,
  buildTargetPkSubqueries,
  type JunctionDuplicatePolicy,
  type JunctionSqlValues,
} from "./builders/many-to-many-utils";
import type {
  JunctionBoundRelation,
  JunctionSide,
} from "./builders/relation-data-builder";
import { buildSelect } from "./builders/select-builder";
import { buildSet } from "./builders/set-builder";
import { buildWhere } from "./builders/where-builder";
import { buildWhereUnique } from "./builders/where-unique-builder";
import { createChildScope, getColumnName, getTableName } from "./context";
import type { QueryScope } from "./types";
import { QueryEngineError } from "./types";
import type { TargetConstraintPin } from "./write-engine/OperationFragment";

export type JunctionOperation =
  | "junctionDelete"
  | "junctionDeleteExact"
  | "junctionDeleteTargets"
  | "junctionInsert"
  | "junctionInsertMany"
  | "membershipDifference"
  | "membershipOwners"
  | "membershipRead"
  | "membershipUpdateMany";

/** A junction INSERT statement with its retry classification when one is needed. */
export interface JunctionInsertMaterialization {
  readonly statement: Sql;
  readonly racePin?: TargetConstraintPin;
}

export type JunctionInsertMaterializationMode =
  | "default"
  | "exactMembershipNoop";

/** Materializes declarative junction and membership statements for the compiler. */
export class JunctionStatements {
  private readonly ctx: QueryScope;
  private readonly lockReads: boolean;

  constructor(ctx: QueryScope, lockReads: boolean) {
    this.ctx = ctx;
    this.lockReads = lockReads;
  }

  /**
   * Materialize the one-row INSERT shape used by a singular member transition.
   *
   * MySQL cannot target its duplicate clause. On a singular member table its
   * target-side UNIQUE is slot occupancy, not an idempotent membership repeat,
   * so the statement must be plain INSERT and only the membership PK is pinned
   * as retryable. Targeted-upsert adapters retain the ordinary targeted clause.
   */
  materializeJunctionInsert(
    junction: JunctionBoundRelation,
    args: Record<string, unknown>,
    mode: JunctionInsertMaterializationMode = "default"
  ): JunctionInsertMaterialization {
    const racePin = this.singularMemberRacePin(junction);
    let duplicatePolicy: JunctionDuplicatePolicy = "skip";
    if (racePin) {
      duplicatePolicy =
        mode === "exactMembershipNoop" ? "exactMembershipNoop" : "surface";
    }
    return {
      statement: this.materialize(junction, "junctionInsert", {
        ...args,
        duplicatePolicy,
      }),
      ...(racePin ? { racePin } : {}),
    };
  }

  /**
   * Materialize one junction statement against an ALREADY-BOUND junction.
   *
   * The bound value is the whole input, which is what retired the refusal that
   * used to stand here ("Relation statement references unknown many-to-many
   * relation '<n>'."): the question it asked — is this relation a junction? — is
   * now answered by {@link JunctionBoundRelation}, so no caller can ask it
   * wrongly and no classification runs twice. Every caller already held the
   * bound value, so the emitted SQL is unchanged.
   *
   * Taking the binding rather than re-deriving it is also what admits a junction
   * whose topology CANNOT be recovered from a name — a direct polymorphic
   * collection binds one member table per variant, and none of those carriers
   * lives in the source model's relation map.
   */
  materialize(
    junction: JunctionBoundRelation,
    operation: JunctionOperation,
    args: Record<string, unknown>
  ): Sql {
    const relationName = junction.relationRef.name;
    // ANSWERED BEFORE THE PARENT VALUE EXISTS, deliberately: this is the ONE
    // statement that asks about a target tuple with NO owner in hand — "who, if
    // anyone, holds this target" — and building a parent value from an absent
    // owner would refuse the question rather than answer it.
    if (operation === "membershipOwners") {
      return this.membershipOwners(junction, args);
    }
    const parentValues = buildJunctionParentValue(
      this.ctx,
      junction,
      sideValueRecord(junction.membership.source, args.parentValue),
      relationName
    );
    const duplicatePolicy = junctionDuplicatePolicy(args.duplicatePolicy);

    switch (operation) {
      case "junctionInsert": {
        const targetValue = this.targetValue(junction, args);
        if (
          args.joinWhenTargetExists === true ||
          duplicatePolicy === "exactMembershipNoop"
        ) {
          return buildJunctionInsertWhenTargetExists(
            this.ctx,
            junction,
            parentValues,
            targetValue,
            duplicatePolicy
          );
        }
        return buildJunctionInsert(
          this.ctx,
          junction,
          parentValues,
          targetValue,
          duplicatePolicy
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
          this.ctx.adapter.identifiers.table(junction.membership.table),
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
          this.ctx.adapter.identifiers.table(junction.membership.table),
          condition
        );
      }
      case "junctionDeleteExact": {
        // ONE `(owner, target)` row. `junctionDeleteTargets` scopes to *this*
        // owner and deletes whatever it holds; the transfer must delete the
        // CAPTURED PREVIOUS owner's row, which is a different question and
        // therefore a different statement.
        const target = this.targetValue(junction, args);
        return this.ctx.adapter.mutations.delete(
          this.ctx.adapter.identifiers.table(junction.membership.table),
          this.ctx.adapter.operators.and(
            buildJunctionSourceMatch(this.ctx, junction, parentValues),
            buildJunctionTargetValuesMatch(this.ctx, junction, [target])
          )
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

  /**
   * Who owns one complete target tuple, in the MEMBER TABLE's own columns.
   *
   * `LIMIT 2` and not `LIMIT 1`: one row is the answer, and TWO rows are the
   * malformed multi-owner state a singular member must never be in — a limit of
   * one would silently pick a winner instead of reporting it. `forUpdate` when
   * reads lock, because in an interactive transaction the row lock IS the
   * premise the transfer relies on.
   */
  private membershipOwners(
    junction: JunctionBoundRelation,
    args: Record<string, unknown>
  ): Sql {
    const target = this.targetValue(junction, args);
    const source = junction.membership.source;
    return this.ctx.adapter.assemble.select({
      columns: sql.join(
        source.members.map((member) =>
          this.ctx.adapter.identifiers.escape(member.junctionField)
        ),
        ", "
      ),
      from: this.ctx.adapter.identifiers.table(junction.membership.table),
      where: buildJunctionTargetValuesMatch(this.ctx, junction, [target]),
      limit: this.ctx.adapter.literals.value(2),
      ...(this.lockReads && args.lock === "transaction"
        ? { forUpdate: true }
        : {}),
    });
  }

  private singularMemberRacePin(
    junction: JunctionBoundRelation
  ): TargetConstraintPin | undefined {
    if (
      junction.cardinality !== "one" ||
      junction.membership.polymorphicMember !== true ||
      this.ctx.adapter.capabilities.supportsTargetedUpsert
    ) {
      return undefined;
    }
    const columns = [
      ...junction.membership.source.members,
      ...junction.membership.target.members,
    ].map((member) => member.junctionField);
    const table = junction.membership.table;
    return {
      fields: columns,
      table,
      columns,
      constraints: [`${table}_pkey`, "PRIMARY"],
    };
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
      from: this.ctx.adapter.identifiers.table(table),
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
      from: this.ctx.adapter.identifiers.table(table),
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
      this.ctx.adapter.identifiers.table(table),
      buildSet(child, data),
      filter ? this.ctx.adapter.operators.and(membership, filter) : membership
    );
  }

  private targetValue(
    junction: JunctionBoundRelation,
    args: Record<string, unknown>
  ): JunctionSqlValues {
    const relationName = junction.relationRef.name;
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
        junction.relationRef.name
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

function junctionDuplicatePolicy(value: unknown): JunctionDuplicatePolicy {
  if (value === "surface" || value === "exactMembershipNoop") return value;
  return "skip";
}

function requireArray(value: unknown, field: string): unknown[] {
  if (Array.isArray(value)) return value;
  throw new QueryEngineError(`Relation statement is missing '${field}'.`);
}

function requireRecord(value: unknown, field: string): Record<string, unknown> {
  if (isRecord(value)) return value;
  throw new QueryEngineError(`Relation statement is missing '${field}'.`);
}
