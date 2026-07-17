// biome-ignore-all lint/style/useFilenamingConvention: Architecture names this child RelationRemovals.
import {
  type FkDirection,
  getFkDirection,
  type RelationMutation,
} from "./builders/relation-data-builder";
import { createChildScope } from "./context";
import { createWriteStep } from "./operation-program";
import {
  andWhere,
  assertNullable,
  correlatedWhere,
  fkAssignments,
  nullAssignments,
  type ProgramRecord,
  primaryKeyFilter,
  primaryKeyWhere,
  records,
  relationFailure,
  relationStatement,
  relationTargetFailure,
  requiredFkFields,
  uniqueRecords,
} from "./RelationProgramValues";
import type { RelationUpdates } from "./RelationUpdates";
import type { QueryScope, RelationInfo } from "./types";
import { NestedWriteError } from "./types";

/** Compiles disconnect, set, delete, and deleteMany for one FK relation. */
export class RelationRemovals<T> {
  private readonly updates: RelationUpdates<T>;
  private readonly parent: QueryScope;
  private readonly mutation: RelationMutation;
  private readonly child: QueryScope;
  private readonly relation: RelationInfo;
  private readonly fk: FkDirection;

  constructor(
    updates: RelationUpdates<T>,
    parent: QueryScope,
    mutation: RelationMutation
  ) {
    this.updates = updates;
    this.parent = parent;
    this.mutation = mutation;
    this.relation = mutation.relationInfo;
    this.child = createChildScope(
      parent,
      this.relation.targetModel,
      parent.nextAlias()
    );
    this.fk = getFkDirection(parent, this.relation);
  }

  compileEarly(
    parentValues: ProgramRecord,
    decisionParentValues: ProgramRecord,
    parentIdentity: ProgramRecord
  ): void {
    if (this.mutation.disconnect !== undefined) {
      this.disconnect(
        this.mutation.disconnect,
        parentValues,
        decisionParentValues,
        parentIdentity
      );
    }
    if (this.mutation.delete !== undefined) {
      this.delete(
        this.mutation.delete,
        parentValues,
        decisionParentValues,
        parentIdentity
      );
    }
    if (this.mutation.set !== undefined) {
      this.set(this.mutation.set, parentValues);
    }
  }

  compileDeleteMany(
    parentValues: ProgramRecord,
    inputs: readonly Record<string, unknown>[]
  ): void {
    const steps = this.updates.steps;
    for (const where of inputs) {
      steps.push(
        createWriteStep(
          this.updates.stepId("write"),
          relationStatement(this.child, "deleteMany", {
            where: correlatedWhere(this.fk, parentValues, where),
          }),
          { expectedCardinality: "many", affectedRows: "unrestricted" }
        )
      );
    }
  }

  private disconnect(
    input: boolean | Record<string, unknown> | Record<string, unknown>[],
    parentValues: ProgramRecord,
    decisionParentValues: ProgramRecord,
    parentIdentity: ProgramRecord
  ): void {
    const steps = this.updates.steps;
    if (input === false) return;
    assertNullable(this.relation, this.fk);
    if (this.fk.holdsFK) {
      steps.push(
        createWriteStep(
          this.updates.stepId("write"),
          relationStatement(this.parent, "update", {
            where: primaryKeyWhere(this.parent, parentIdentity),
            data: nullAssignments(this.fk.fkFields),
          }),
          { expectedCardinality: "one", affectedRows: "exact" }
        )
      );
      for (const field of this.fk.fkFields) parentValues[field] = null;
      return;
    }
    if (input === true) {
      steps.push(
        createWriteStep(
          this.updates.stepId("write"),
          relationStatement(this.child, "updateMany", {
            where: correlatedWhere(this.fk, parentValues),
            data: nullAssignments(this.fk.fkFields),
          }),
          { expectedCardinality: "many", affectedRows: "unrestricted" }
        )
      );
      return;
    }
    const targets = uniqueRecords(records(input)).map((where) =>
      this.updates.captures.capture(
        this.child,
        relationStatement(this.child, "findMany", {
          whereUnique: where,
          filter: correlatedWhere(this.fk, parentValues),
          take: 1,
          lock: "transaction",
        }),
        relationStatement(this.child, "findMany", {
          whereUnique: where,
          filter: correlatedWhere(this.fk, decisionParentValues),
          take: 1,
        }),
        relationTargetFailure(this.relation, "disconnect")
      )
    );
    for (const target of targets) {
      steps.push(
        createWriteStep(
          this.updates.stepId("write"),
          relationStatement(this.child, "update", {
            where: primaryKeyWhere(this.child, target.identity),
            data: nullAssignments(this.fk.fkFields),
          }),
          {
            expectedCardinality: "one",
            affectedRows: "unrestricted",
            maximumAffectedRows: 1,
          }
        )
      );
      steps.push(
        this.updates.captures.existsGuard(
          relationStatement(this.child, "findMany", {
            whereUnique: primaryKeyWhere(this.child, target.identity),
            take: 1,
            lock: "transaction",
          }),
          relationTargetFailure(this.relation, "disconnect")
        )
      );
    }
  }

  private set(
    inputs: Record<string, unknown>[],
    parentValues: ProgramRecord
  ): void {
    const steps = this.updates.steps;
    if (this.fk.holdsFK) {
      throw new NestedWriteError(
        `'set' operation is not supported for relation '${this.relation.name}' where current model holds FK. Use 'connect' instead for to-one relations.`,
        this.relation.name
      );
    }
    const targets = inputs.map((where) =>
      this.updates.captures.capture(
        this.child,
        relationStatement(this.child, "findMany", {
          whereUnique: where,
          take: 1,
          lock: "transaction",
        }),
        undefined,
        relationTargetFailure(this.relation, "set")
      )
    );
    const parentWhere = correlatedWhere(this.fk, parentValues);
    const departingWhere =
      targets.length === 0
        ? parentWhere
        : {
            AND: [
              parentWhere,
              {
                NOT: {
                  OR: targets.map((target) =>
                    primaryKeyFilter(this.child, target.identity)
                  ),
                },
              },
            ],
          };
    const required = requiredFkFields(this.fk);
    if (required.length > 0) {
      steps.push({
        id: this.updates.stepId("guard"),
        kind: "guard",
        premise: {
          kind: "notExists",
          statement: relationStatement(this.child, "findMany", {
            where: departingWhere,
            take: 1,
            lock: "transaction",
          }),
        },
        failure: relationFailure(
          this.relation,
          `Cannot set relation '${this.relation.name}' because foreign key field(s) ${required.join(", ")} are required: rows removed from the set cannot be disconnected. Delete them instead.`
        ),
      });
    } else {
      steps.push(
        createWriteStep(
          this.updates.stepId("write"),
          relationStatement(this.child, "updateMany", {
            where: departingWhere,
            data: nullAssignments(this.fk.fkFields),
          }),
          { expectedCardinality: "many", affectedRows: "unrestricted" }
        )
      );
    }
    for (const target of targets) {
      const connectedWhere = andWhere(
        primaryKeyFilter(this.child, target.identity),
        correlatedWhere(this.fk, parentValues)
      );
      steps.push(
        createWriteStep(
          this.updates.stepId("write"),
          relationStatement(this.child, "update", {
            where: primaryKeyWhere(this.child, target.identity),
            data: fkAssignments(this.fk, parentValues),
          }),
          {
            expectedCardinality: "one",
            affectedRows: "unrestricted",
            maximumAffectedRows: 1,
          }
        )
      );
      steps.push(
        this.updates.captures.existsGuard(
          relationStatement(this.child, "findMany", {
            filter: connectedWhere,
            take: 1,
            lock: "transaction",
          }),
          relationTargetFailure(this.relation, "set")
        )
      );
    }
  }

  private delete(
    input: boolean | Record<string, unknown> | Record<string, unknown>[],
    parentValues: ProgramRecord,
    decisionParentValues: ProgramRecord,
    parentIdentity: ProgramRecord
  ): void {
    const steps = this.updates.steps;
    if (input === false) return;
    const laxDeleteWhere =
      input === true ? correlatedWhere(this.fk, parentValues) : undefined;
    const targets =
      input === true
        ? []
        : uniqueRecords(records(input)).map((where) =>
            this.updates.captures.capture(
              this.child,
              relationStatement(this.child, "findMany", {
                whereUnique: where,
                filter: correlatedWhere(this.fk, parentValues),
                take: 1,
                lock: "transaction",
              }),
              relationStatement(this.child, "findMany", {
                whereUnique: where,
                filter: correlatedWhere(this.fk, decisionParentValues),
                take: 1,
              }),
              relationTargetFailure(this.relation, "delete")
            )
          );
    if (this.fk.holdsFK) {
      assertNullable(this.relation, this.fk);
      steps.push(
        createWriteStep(
          this.updates.stepId("write"),
          relationStatement(this.parent, "update", {
            where: primaryKeyWhere(this.parent, parentIdentity),
            data: nullAssignments(this.fk.fkFields),
          }),
          { expectedCardinality: "one", affectedRows: "exact" }
        )
      );
      for (const field of this.fk.fkFields) parentValues[field] = null;
    }
    if (input === true) {
      steps.push(
        createWriteStep(
          this.updates.stepId("write"),
          relationStatement(this.child, "deleteMany", {
            where: laxDeleteWhere,
          }),
          { expectedCardinality: "many", affectedRows: "unrestricted" }
        )
      );
      return;
    }
    for (const target of targets) {
      steps.push(
        createWriteStep(
          this.updates.stepId("write"),
          relationStatement(this.child, "delete", {
            where: primaryKeyWhere(this.child, target.identity),
          }),
          { expectedCardinality: "one", affectedRows: "exact" }
        )
      );
    }
  }
}
