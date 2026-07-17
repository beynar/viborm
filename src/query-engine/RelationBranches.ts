// biome-ignore-all lint/style/useFilenamingConvention: Architecture names this compiler child RelationBranches.
import type {
  ConnectOrCreateInput,
  FkDirection,
  NestedUpsertInput,
  RelationMutation,
} from "./builders/relation-data-builder";
import { createChildScope } from "./context";
import {
  createReadStep,
  createWriteStep,
  type OperationStatement,
  type ProducedValue,
  type ProgramFailure,
} from "./operation-program";
import type { CapturedRow } from "./RelationCaptures";
import {
  planRelationMutationSteps,
  type RelationMutationStep,
} from "./RelationMutationPlan";
import {
  childForeignKeys,
  correlatedWhere,
  parentForeignKeys,
  pickIdentity,
  primaryKeyFilter,
  primaryKeyWhere,
  relationFailure,
  relationStatement,
  setAssignments,
} from "./RelationProgramValues";
import type { RelationUpdates } from "./RelationUpdates";
import type { QueryScope, RelationInfo } from "./types";
import { NestedWriteError } from "./types";
import { uniqueConflictTarget } from "./WritePrograms";

/** Compiles relation existence decisions into shared program branches. */
export class RelationBranches<T> {
  private readonly updates: RelationUpdates<T>;

  constructor(updates: RelationUpdates<T>) {
    this.updates = updates;
  }

  compileConnectOrCreate(
    parent: QueryScope,
    mutation: RelationMutation,
    fk: FkDirection,
    parentValues: Record<string, unknown>,
    updateParent: boolean
  ): void {
    const relation = mutation.relationInfo;
    const child = createChildScope(
      parent,
      relation.targetModel,
      parent.nextAlias()
    );
    const inputs = dedupeConnectOrCreate(mutation);
    if (relation.isToOne && inputs.length > 1) {
      throw new NestedWriteError(
        `Cannot use multiple 'connectOrCreate' inputs for to-one relation '${relation.name}'.`,
        relation.name
      );
    }
    for (const input of inputs) {
      const decision = this.decision(
        child,
        relationStatement(child, "findMany", {
          whereUnique: input.where,
          take: 1,
          lock: "transaction",
        })
      );
      const whenTrue = this.updates.collectSteps(() => {
        if (fk.holdsFK) return;
        this.updates.steps.push(
          createWriteStep(
            this.updates.stepId("write"),
            relationStatement(child, "update", {
              where: primaryKeyWhere(child, decision.identity),
              data: setAssignments(childForeignKeys(fk, parentValues)),
            }),
            {
              expectedCardinality: "one",
              affectedRows: "unrestricted",
              maximumAffectedRows: 1,
            }
          )
        );
      });
      let createStep = "";
      let createdIdentity: Record<string, unknown> = {};
      const whenFalse = this.updates.collectSteps(() => {
        const outcome = this.updates.writes.relations.appendCreateOutcome(
          child,
          input.create,
          fk.holdsFK ? {} : childForeignKeys(fk, parentValues),
          this.updates.steps
        );
        createStep = outcome.write.id;
        createdIdentity = outcome.identity;
      });
      this.updates.steps.push({
        id: this.updates.stepId("branch"),
        kind: "branch",
        premise: { step: decision.step.id, test: "hasRows" },
        pin: {
          whenTrue: this.capturedGuard(
            child,
            input.where,
            decision,
            replacementFailure(relation, "connectOrCreate")
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
      if (fk.holdsFK) {
        const selectedTarget = Object.fromEntries(
          fk.pkFields.map((targetField) => {
            return [
              targetField,
              {
                kind: "fallbackValue",
                preferred: requireProducedValue(
                  decision.values[targetField],
                  targetField
                ),
                fallback: createdIdentity[targetField],
              },
            ];
          })
        );
        if (updateParent) {
          this.updateParentForeignKey(parent, fk, selectedTarget, parentValues);
        } else {
          Object.assign(parentValues, parentForeignKeys(fk, selectedTarget));
        }
      }
    }
  }

  compileUpsert(
    parent: QueryScope,
    step: Extract<RelationMutationStep, { kind: "upsert" }>,
    fk: FkDirection,
    parentValues: Record<string, unknown>,
    decisionParentValues: Record<string, unknown>
  ): void {
    const relation = step.context.relationInfo;
    const child = createChildScope(
      parent,
      relation.targetModel,
      parent.nextAlias()
    );
    for (const input of step.inputs) {
      this.compileOneUpsert(
        parent,
        child,
        relation,
        fk,
        input,
        parentValues,
        decisionParentValues
      );
    }
  }

  private compileOneUpsert(
    parent: QueryScope,
    child: QueryScope,
    relation: RelationInfo,
    fk: FkDirection,
    input: NestedUpsertInput,
    parentValues: Record<string, unknown>,
    decisionParentValues: Record<string, unknown>
  ): void {
    if (!(relation.isToOne || input.where)) {
      throw new NestedWriteError(
        `Nested operation 'upsert' on to-many relation '${relation.name}' requires 'where'.`,
        relation.name,
        { meta: { operation: "upsert", field: "where" } }
      );
    }
    const membershipParentValues = { ...parentValues };
    const executionArgs = {
      ...(input.where ? { whereUnique: input.where } : {}),
      filter: correlatedWhere(fk, membershipParentValues),
      take: 1,
      lock: "transaction",
    };
    const specializationArgs = {
      ...(input.where ? { whereUnique: input.where } : {}),
      filter: correlatedWhere(fk, decisionParentValues),
      take: 1,
    };
    const decision = this.decision(
      child,
      relationStatement(child, "findMany", executionArgs),
      relationStatement(child, "findMany", specializationArgs)
    );
    const whenTrue = this.updates.collectSteps(() => {
      this.updates.compileLocatedUpdate(child, decision, input.update);
    });
    let createStep = "";
    let createdIdentity: Record<string, unknown> = {};
    const whenFalse = this.updates.collectSteps(() => {
      if (input.where) {
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
      }
      const outcome = this.updates.writes.relations.appendUpsertCreateOutcome(
        child,
        input.create,
        fk.holdsFK ? {} : childForeignKeys(fk, parentValues),
        this.updates.steps
      );
      createStep = outcome.write.id;
      createdIdentity = outcome.identity;
    });
    const missingPin = input.where
      ? {
          kind: "uniqueConflict" as const,
          step: createStep,
          where: input.where,
          create: input.create,
          target: uniqueConflictTarget(child, input.where),
        }
      : { kind: "none" as const };
    this.updates.steps.push({
      id: this.updates.stepId("branch"),
      kind: "branch",
      premise: { step: decision.step.id, test: "hasRows" },
      pin: {
        whenTrue: this.capturedMembershipGuard(
          child,
          fk,
          membershipParentValues,
          input.where,
          decision,
          replacementFailure(relation, "upsert")
        ),
        whenFalse: missingPin,
      },
      whenTrue,
      whenFalse,
    });
    if (fk.holdsFK) {
      const selectedTarget = Object.fromEntries(
        fk.pkFields.map((targetField) => [
          targetField,
          {
            kind: "fallbackValue",
            preferred: requireProducedValue(
              decision.values[targetField],
              targetField
            ),
            fallback: createdIdentity[targetField],
          },
        ])
      );
      this.updateParentForeignKey(parent, fk, selectedTarget, parentValues);
    }
  }

  decision(
    ctx: QueryScope,
    statement: OperationStatement,
    specializeStatement?: OperationStatement
  ): CapturedRow {
    const id = this.updates.stepId("read");
    const producedValues = ctx.model["~"].scalarFieldNames.map((field) =>
      this.updates.writes.compiler.allocateProducedValue(id, field, "row")
    );
    const values = Object.fromEntries(
      producedValues.map((value) => [value.field, value])
    );
    const step = createReadStep(id, statement, {
      producedValues,
      ...(specializeStatement ? { specializeStatement } : {}),
    });
    this.updates.steps.push(step);
    return { step, values, identity: pickIdentity(ctx, values) };
  }

  private capturedGuard(
    ctx: QueryScope,
    whereUnique: Record<string, unknown>,
    captured: CapturedRow,
    failure: ProgramFailure
  ): import("./operation-program").GuardStep {
    return {
      id: this.updates.stepId("guard"),
      kind: "guard",
      premise: {
        kind: "exists",
        statement: relationStatement(ctx, "findMany", {
          whereUnique,
          filter: primaryKeyFilter(ctx, captured.identity),
          take: 1,
          lock: "transaction",
        }),
      },
      failure,
    };
  }

  private capturedMembershipGuard(
    ctx: QueryScope,
    fk: FkDirection,
    parentValues: Record<string, unknown>,
    whereUnique: Record<string, unknown> | undefined,
    captured: CapturedRow,
    failure: ProgramFailure
  ): import("./operation-program").GuardStep {
    return {
      id: this.updates.stepId("guard"),
      kind: "guard",
      premise: {
        kind: "exists",
        statement: relationStatement(ctx, "findMany", {
          ...(whereUnique ? { whereUnique } : {}),
          filter: {
            AND: [
              correlatedWhere(fk, parentValues),
              primaryKeyFilter(ctx, captured.identity),
            ],
          },
          take: 1,
          lock: "transaction",
        }),
      },
      failure,
    };
  }

  private updateParentForeignKey(
    parent: QueryScope,
    fk: FkDirection,
    targetValues: Record<string, unknown>,
    parentValues: Record<string, unknown>
  ): void {
    const values = parentForeignKeys(fk, targetValues);
    this.updates.steps.push(
      createWriteStep(
        this.updates.stepId("write"),
        relationStatement(parent, "update", {
          where: primaryKeyWhere(parent, pickIdentity(parent, parentValues)),
          data: setAssignments(values),
        }),
        { expectedCardinality: "one", affectedRows: "exact" }
      )
    );
    Object.assign(parentValues, values);
  }
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

function dedupeConnectOrCreate(
  mutation: RelationMutation
): ConnectOrCreateInput[] {
  const step = mutation.connectOrCreate
    ? importConnectOrCreatePlan(mutation)
    : undefined;
  return step?.inputs ?? [];
}

function importConnectOrCreatePlan(
  mutation: RelationMutation
): { inputs: ConnectOrCreateInput[] } | undefined {
  for (const step of planRelationMutationSteps(
    mutation.relationInfo.name,
    mutation,
    "after"
  )) {
    if (step.kind === "connectOrCreate") return step;
  }
  return undefined;
}

function requireProducedValue(value: unknown, field: string): ProducedValue {
  if (isProducedValue(value)) return value;
  throw new NestedWriteError(
    `Connect-or-create decision did not capture '${field}'.`,
    field
  );
}

function isProducedValue(value: unknown): value is ProducedValue {
  return (
    value !== null &&
    typeof value === "object" &&
    "kind" in value &&
    value.kind === "producedValue" &&
    "id" in value &&
    typeof value.id === "string" &&
    "producer" in value &&
    typeof value.producer === "string" &&
    "field" in value &&
    typeof value.field === "string" &&
    "source" in value &&
    (value.source === "row" || value.source === "insertId")
  );
}
