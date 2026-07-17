// biome-ignore-all lint/style/useFilenamingConvention: Architecture names this compiler child ManyToManyMutations.
import {
  getManyToManyJoinInfo,
  type ManyToManyJoinInfo,
} from "./builders/many-to-many-utils";
import type {
  NestedUpsertInput,
  RelationMutation,
} from "./builders/relation-data-builder";
import { separateData } from "./builders/relation-data-builder";
import {
  ManyToManyMemberships,
  manyToManyChildContext,
  manyToManyStatement,
  requiredManyToManyValue,
} from "./ManyToManyMemberships";
import {
  createReadStep,
  createWriteStep,
  type ProgramFailure,
  type ProgramStatement,
} from "./operation-program";
import { assertPortablePrimaryKeyUpdateInput } from "./operations/mutation-identity";
import type { CapturedRow } from "./RelationCaptures";
import { planRelationMutationSteps } from "./RelationMutationPlan";
import {
  pickIdentity,
  primaryKeyFilter,
  primaryKeyWhere,
  records,
  relationFailure,
  relationStatement,
  relationTargetFailure,
} from "./RelationProgramValues";
import type { RelationUpdates } from "./RelationUpdates";
import type { QueryScope, RelationInfo } from "./types";
import { NestedWriteError } from "./types";
import { uniqueConflictTarget } from "./WritePrograms";

/** Compiles oriented many-to-many membership and target mutations. */
export class ManyToManyMutations<T> {
  private readonly updates: RelationUpdates<T>;
  private readonly memberships: ManyToManyMemberships<T>;

  constructor(updates: RelationUpdates<T>) {
    this.updates = updates;
    this.memberships = new ManyToManyMemberships(updates);
  }

  compile(
    parent: QueryScope,
    mutation: RelationMutation,
    parentValues: Record<string, unknown>,
    decisionParentValues: Record<string, unknown> = parentValues
  ): void {
    const relation = mutation.relationInfo;
    const join = getManyToManyJoinInfo(parent, relation);
    const parentValue = requiredManyToManyValue(
      parentValues,
      join.sourcePkField,
      relation.name
    );
    const decisionParentValue = requiredManyToManyValue(
      decisionParentValues,
      join.sourcePkField,
      relation.name
    );

    for (const step of planRelationMutationSteps(
      relation.name,
      mutation,
      "after"
    )) {
      switch (step.kind) {
        case "create":
          for (const data of step.inputs) {
            this.memberships.create(parent, relation, join, parentValue, data);
          }
          break;
        case "connect":
          for (const where of step.inputs) {
            this.memberships.connect(
              parent,
              relation,
              join,
              parentValue,
              where
            );
          }
          break;
        case "connectOrCreate":
          for (const input of step.inputs) {
            this.memberships.connectOrCreate(
              parent,
              relation,
              join,
              parentValue,
              input
            );
          }
          break;
        case "disconnect":
          this.memberships.disconnect(
            parent,
            relation,
            parentValue,
            step.input
          );
          break;
        case "set":
          this.memberships.set(parent, relation, join, parentValue, step.input);
          break;
        case "update":
          for (const input of step.inputs) {
            if (!input.selector) continue;
            this.update(
              parent,
              relation,
              decisionParentValue,
              parentValue,
              input.selector,
              input.data
            );
          }
          break;
        case "updateMany":
          for (const input of step.inputs) {
            this.updateMany(parent, relation, parentValue, input);
          }
          break;
        case "delete":
          this.delete(
            parent,
            relation,
            join,
            decisionParentValue,
            parentValue,
            step.input
          );
          break;
        case "deleteMany":
          for (const where of step.inputs) {
            this.deleteMany(
              parent,
              relation,
              join,
              decisionParentValue,
              parentValue,
              where,
              "deleteMany"
            );
          }
          break;
        case "upsert":
          for (const input of step.inputs) {
            this.upsert(
              parent,
              relation,
              join,
              decisionParentValue,
              parentValue,
              input
            );
          }
          break;
        default:
          throw new NestedWriteError(
            `Nested operation '${step.kind}' is not supported for many-to-many relation '${relation.name}'.`,
            relation.name,
            { meta: { operation: step.kind } }
          );
      }
    }
  }

  private update(
    parent: QueryScope,
    relation: RelationInfo,
    decisionParentValue: unknown,
    parentValue: unknown,
    where: Record<string, unknown>,
    data: Record<string, unknown>
  ): void {
    const child = manyToManyChildContext(parent, relation);
    const target = this.membershipDecision(
      parent,
      relation,
      child,
      decisionParentValue,
      parentValue,
      where,
      relationTargetFailure(relation, "update")
    );
    this.updates.compileLocatedUpdate(child, target, data);
  }

  private updateMany(
    parent: QueryScope,
    relation: RelationInfo,
    parentValue: unknown,
    input: { where?: Record<string, unknown>; data: Record<string, unknown> }
  ): void {
    const child = manyToManyChildContext(parent, relation);
    assertPortablePrimaryKeyUpdateInput(child.model, "updateMany", {
      data: input.data,
    });
    const { scalarData, relations } = separateData(child, input.data);
    this.updates.assertUpdateManyDataIsCompilable(relation.name, relations);
    if (Object.keys(scalarData).length === 0) return;
    this.memberships.write(parent, relation, "membershipUpdateMany", {
      parentValue,
      ...(input.where ? { where: input.where } : {}),
      data: scalarData,
    });
  }

  private delete(
    parent: QueryScope,
    relation: RelationInfo,
    join: ManyToManyJoinInfo,
    decisionParentValue: unknown,
    parentValue: unknown,
    input: boolean | Record<string, unknown> | Record<string, unknown>[]
  ): void {
    if (input === false) return;
    if (input === true) {
      this.deleteMany(
        parent,
        relation,
        join,
        decisionParentValue,
        parentValue,
        {},
        "delete"
      );
      return;
    }
    const child = manyToManyChildContext(parent, relation);
    for (const where of records(input)) {
      const target = this.membershipDecision(
        parent,
        relation,
        child,
        decisionParentValue,
        parentValue,
        where,
        relationTargetFailure(relation, "delete")
      );
      const targetValue = requiredManyToManyValue(
        target.values,
        join.targetPkField,
        relation.name
      );
      this.memberships.write(parent, relation, "junctionDeleteTargets", {
        parentValue,
        targetValues: [targetValue],
      });
      this.updates.steps.push(
        createWriteStep(
          this.updates.stepId("write"),
          relationStatement(child, "delete", {
            where: primaryKeyWhere(child, target.identity),
          }),
          { expectedCardinality: "one", affectedRows: "exact" }
        )
      );
    }
  }

  private deleteMany(
    parent: QueryScope,
    relation: RelationInfo,
    join: ManyToManyJoinInfo,
    decisionParentValue: unknown,
    parentValue: unknown,
    where: Record<string, unknown>,
    operation: "delete" | "deleteMany"
  ): void {
    const readId = this.updates.stepId("read");
    const targetValues = this.updates.writes.compiler.allocateProducedRows(
      readId,
      join.targetPkField
    );
    this.updates.steps.push(
      createReadStep(
        readId,
        manyToManyStatement(parent, relation, "membershipRead", {
          parentValue,
          where,
          select: { [join.targetPkField]: true },
        }),
        {
          specializeStatement: manyToManyStatement(
            parent,
            relation,
            "membershipRead",
            {
              parentValue: decisionParentValue,
              where,
              select: { [join.targetPkField]: true },
            }
          ),
          producedValues: [targetValues],
        }
      )
    );
    const failure = raceFailure(relation, operation);
    this.updates.steps.push(
      differenceGuard(
        this.updates.stepId("guard"),
        parent,
        relation,
        parentValue,
        where,
        targetValues,
        "added",
        failure
      ),
      differenceGuard(
        this.updates.stepId("guard"),
        parent,
        relation,
        parentValue,
        where,
        targetValues,
        "removed",
        failure
      )
    );
    this.memberships.write(parent, relation, "junctionDeleteTargets", {
      parentValue,
      targetValues,
    });
    const child = manyToManyChildContext(parent, relation);
    this.updates.steps.push(
      createWriteStep(
        this.updates.stepId("write"),
        relationStatement(child, "deleteMany", {
          where: {
            [join.targetPkField]: { in: targetValues },
          },
        }),
        { expectedCardinality: "many", affectedRows: "unrestricted" }
      )
    );
  }

  private upsert(
    parent: QueryScope,
    relation: RelationInfo,
    join: ManyToManyJoinInfo,
    decisionParentValue: unknown,
    parentValue: unknown,
    input: NestedUpsertInput
  ): void {
    if (!input.where) {
      throw new NestedWriteError(
        `Nested operation 'upsert' on many-to-many relation '${relation.name}' requires 'where'.`,
        relation.name,
        { meta: { operation: "upsert", field: "where" } }
      );
    }
    const child = manyToManyChildContext(parent, relation);
    const decision = this.membershipOptionalDecision(
      parent,
      relation,
      child,
      decisionParentValue,
      parentValue,
      input.where
    );
    const whenTrue = this.updates.collectSteps(() => {
      this.updates.compileLocatedUpdate(child, decision, input.update);
    });
    let createStep = "";
    const whenFalse = this.updates.collectSteps(() => {
      this.updates.steps.push({
        id: this.updates.stepId("guard"),
        kind: "guard",
        premise: {
          kind: "notExists",
          statement: relationStatement(child, "findMany", {
            whereUnique: input.where,
            take: 1,
            lock: "transaction",
          }),
        },
        failure: relationFailure(
          relation,
          `Cannot upsert relation '${relation.name}': target record was not found for this parent.`
        ),
      });
      const outcome = this.updates.writes.relations.appendUpsertCreateOutcome(
        child,
        input.create,
        {},
        this.updates.steps
      );
      createStep = outcome.write.id;
      this.memberships.insert(
        parent,
        relation,
        parentValue,
        requiredManyToManyValue(
          outcome.identity,
          join.targetPkField,
          relation.name
        )
      );
    });
    this.updates.steps.push({
      id: this.updates.stepId("branch"),
      kind: "branch",
      premise: { step: decision.step.id, test: "hasRows" },
      pin: {
        whenTrue: membershipPin(
          this.updates.stepId("guard"),
          parent,
          relation,
          parentValue,
          input.where,
          primaryKeyFilter(child, decision.identity),
          replacementFailure(relation, "upsert")
        ),
        whenFalse: {
          kind: "uniqueConflict",
          step: createStep,
          where: input.where,
          create: input.create,
          target: uniqueConflictTarget(child, input.where),
        },
      },
      whenTrue,
      whenFalse,
    });
  }

  private membershipDecision(
    parent: QueryScope,
    relation: RelationInfo,
    child: QueryScope,
    decisionParentValue: unknown,
    parentValue: unknown,
    where: Record<string, unknown>,
    failure: ProgramFailure
  ): CapturedRow {
    const captured = this.membershipOptionalDecision(
      parent,
      relation,
      child,
      decisionParentValue,
      parentValue,
      where,
      failure
    );
    this.updates.steps.push(
      membershipPin(
        this.updates.stepId("guard"),
        parent,
        relation,
        parentValue,
        where,
        primaryKeyFilter(child, captured.identity),
        failure
      )
    );
    return captured;
  }

  private membershipOptionalDecision(
    parent: QueryScope,
    relation: RelationInfo,
    child: QueryScope,
    decisionParentValue: unknown,
    parentValue: unknown,
    where: Record<string, unknown>,
    failure?: ProgramFailure
  ): CapturedRow {
    const read = manyToManyStatement(parent, relation, "membershipRead", {
      parentValue,
      whereUnique: where,
      take: 1,
    });
    const specialize = manyToManyStatement(parent, relation, "membershipRead", {
      parentValue: decisionParentValue,
      whereUnique: where,
      take: 1,
    });
    return this.decision(child, read, specialize, failure);
  }

  private decision(
    child: QueryScope,
    statement: ProgramStatement,
    specializeStatement?: ProgramStatement,
    failure?: ProgramFailure
  ): CapturedRow {
    const id = this.updates.stepId("read");
    const producedValues = child.model["~"].scalarFieldNames.map((field) =>
      this.updates.writes.compiler.allocateProducedValue(id, field, "row")
    );
    const values = Object.fromEntries(
      producedValues.map((value) => [value.field, value])
    );
    const step = createReadStep(id, statement, {
      producedValues,
      ...(specializeStatement ? { specializeStatement } : {}),
      ...(failure
        ? { expectedRows: { kind: "exact" as const, count: 1 }, failure }
        : {}),
    });
    this.updates.steps.push(step);
    return { step, values, identity: pickIdentity(child, values) };
  }
}

function membershipPin(
  id: string,
  parent: QueryScope,
  relation: RelationInfo,
  parentValue: unknown,
  whereUnique: Record<string, unknown>,
  where: Record<string, unknown>,
  failure: ProgramFailure
): import("./operation-program").GuardStep {
  return {
    id,
    kind: "guard",
    premise: {
      kind: "exists",
      statement: manyToManyStatement(parent, relation, "membershipRead", {
        parentValue,
        whereUnique,
        where,
        lock: "transaction",
        take: 1,
      }),
    },
    failure,
  };
}

function differenceGuard(
  id: string,
  parent: QueryScope,
  relation: RelationInfo,
  parentValue: unknown,
  where: Record<string, unknown>,
  targetValues: unknown,
  difference: "added" | "removed",
  failure: ProgramFailure
): import("./operation-program").GuardStep {
  return {
    id,
    kind: "guard",
    premise: {
      kind: "notExists",
      statement: manyToManyStatement(parent, relation, "membershipDifference", {
        parentValue,
        where,
        targetValues,
        difference,
      }),
    },
    failure,
  };
}

function raceFailure(
  relation: RelationInfo,
  operation: "delete" | "deleteMany"
): ProgramFailure {
  return {
    kind: "nestedWrite",
    message: `Concurrent membership change during '${operation}' on many-to-many relation '${relation.name}': retry to converge.`,
    relation: relation.name,
    raceable: true,
  };
}

function replacementFailure(
  relation: RelationInfo,
  operation: "connectOrCreate" | "upsert"
): ProgramFailure {
  return relationFailure(
    relation,
    `Record was replaced by another transaction during nested ${operation}`
  );
}
