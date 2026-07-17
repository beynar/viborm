// biome-ignore-all lint/style/useFilenamingConvention: Architecture names this child RelationUpdates.

import { getPrimaryKeyFields } from "./builders/correlation-utils";
import {
  type FkDirection,
  getFkDirection,
  type RelationMutation,
  separateData,
} from "./builders/relation-data-builder";
import { createChildScope } from "./context";
import { ManyToManyMutations } from "./ManyToManyMutations";
import { assertUpdateOwnWriteSafety } from "./OwnWriteAnalyzer";
import {
  createOperationProgram,
  createReadStep,
  createResultSource,
  createWriteStep,
  type OperationProgram,
  type OperationStep,
  operationSelection,
} from "./operation-program";
import { assertPortablePrimaryKeyUpdateInput } from "./operations/mutation-identity";
import { RelationBranches } from "./RelationBranches";
import { type CapturedRow, RelationCaptures } from "./RelationCaptures";
import { planRelationMutationSteps } from "./RelationMutationPlan";
import {
  andWhere,
  childForeignKeys,
  correlatedWhere,
  fkAssignments,
  type ProgramRecord,
  parentForeignKeys,
  pickIdentity,
  primaryKeyFilter,
  primaryKeyWhere,
  records,
  relationFailure,
  relationTargetFailure,
  requireRecord,
  setAssignments,
  relationStatement as statement,
  uniqueRecords,
  updatedValues,
} from "./RelationProgramValues";
import { RelationRemovals } from "./RelationRemovals";
import { classifyRelationKeyScalarUpdate } from "./TargetConstraint";
import { NestedWriteError, type QueryScope } from "./types";
import type { WriteOperations } from "./WriteOperations";

/** Compiles deterministic FK-backed update and removal trees. */
export class RelationUpdates<T> {
  readonly writes: WriteOperations<T>;
  readonly captures: RelationCaptures<T>;
  readonly branches: RelationBranches<T>;
  readonly manyToMany: ManyToManyMutations<T>;
  private activeSteps: OperationStep[] = [];
  private nextStepId = 0;

  constructor(writes: WriteOperations<T>) {
    this.writes = writes;
    this.captures = new RelationCaptures(this);
    this.branches = new RelationBranches(this);
    this.manyToMany = new ManyToManyMutations(this);
  }

  get steps(): OperationStep[] {
    return this.activeSteps;
  }

  compile(ctx: QueryScope, args: Record<string, unknown>): OperationProgram {
    const data = requireRecord(args.data, "update", "data");
    assertUpdateOwnWriteSafety(
      ctx,
      data,
      requireRecord(args.where, "update", "where")
    );

    this.nextStepId = 0;
    this.activeSteps = [];
    const steps = this.activeSteps;
    const rootWhere = requireRecord(args.where, "update", "where");
    const captured = this.captures.capture(
      ctx,
      statement(ctx, "findMany", {
        whereUnique: rootWhere,
        take: 1,
        lock: "transaction",
      }),
      undefined
    );
    const finalRow = this.compileLocatedUpdate(ctx, captured, data);
    const result = createReadStep(
      this.stepId("read"),
      statement(ctx, "findUnique", {
        where: primaryKeyWhere(ctx, finalRow.identity),
        ...operationSelection(args),
      }),
      {
        expectedRows: { kind: "exact", count: 1 },
        missing: "not-found",
      }
    );
    steps.push(result);
    return createOperationProgram(
      "operation",
      steps,
      "update",
      args,
      { kind: "rows", results: [createResultSource(result)] },
      this.writes.resultShape("update", args),
      !ctx.adapter.capabilities.supportsReturning
    );
  }

  compileLocatedUpdate(
    ctx: QueryScope,
    captured: CapturedRow,
    data: Record<string, unknown>
  ): CapturedRow {
    const steps = this.steps;
    assertPortablePrimaryKeyUpdateInput(ctx.model, "update", { data });
    const { scalarData, relations } = separateData(ctx, data);
    assertRelationKeyUpdatesAreCompilable(ctx, scalarData, relations);
    const finalValues = updatedValues(captured.values, scalarData);
    this.compileRelationKeyGuards(
      ctx,
      relations,
      captured.values,
      finalValues,
      scalarData
    );
    if (Object.keys(scalarData).length > 0) {
      steps.push(
        createWriteStep(
          this.stepId("write"),
          statement(ctx, "update", {
            where: primaryKeyWhere(ctx, captured.identity),
            data: scalarData,
          }),
          {
            expectedCardinality: "one",
            affectedRows: "exact",
            maximumAffectedRows: 1,
          }
        )
      );
    }
    for (const mutation of Object.values(relations)) {
      this.compileRelation(ctx, mutation, finalValues, captured.values);
    }
    return {
      step: captured.step,
      values: finalValues,
      identity: pickIdentity(ctx, finalValues),
    };
  }

  assertUpdateManyDataIsCompilable(
    relationName: string,
    relations: Record<string, RelationMutation>
  ): void {
    const relationKeys = Object.keys(relations);
    if (relationKeys.length === 0) return;
    throw new NestedWriteError(
      `Nested relation writes inside updateMany data for relation '${relationName}' are not supported.`,
      relationName,
      { meta: { operation: "updateMany", relations: relationKeys } }
    );
  }

  collectSteps(compile: () => void): readonly OperationStep[] {
    const parent = this.activeSteps;
    const collected: OperationStep[] = [];
    this.activeSteps = collected;
    try {
      compile();
      return collected;
    } finally {
      this.activeSteps = parent;
    }
  }

  withSteps<R>(steps: OperationStep[], compile: () => R): R {
    const parent = this.activeSteps;
    this.activeSteps = steps;
    try {
      return compile();
    } finally {
      this.activeSteps = parent;
    }
  }

  private compileRelation(
    parent: QueryScope,
    mutation: RelationMutation,
    parentValues: ProgramRecord,
    decisionParentValues: ProgramRecord
  ): void {
    const steps = this.steps;
    const parentIdentity = pickIdentity(parent, parentValues);
    const relation = mutation.relationInfo;
    if (relation.type === "manyToMany") {
      this.manyToMany.compile(
        parent,
        mutation,
        parentValues,
        decisionParentValues
      );
      return;
    }
    const child = createChildScope(
      parent,
      relation.targetModel,
      parent.nextAlias()
    );
    const fk = getFkDirection(parent, relation);
    const planningParentValues = fk.holdsFK
      ? parentValues
      : decisionParentValues;
    const mutationSteps = planRelationMutationSteps(
      relation.name,
      mutation,
      "after"
    );

    if (mutation.create) {
      for (const data of records(mutation.create)) {
        const injected = fk.holdsFK ? {} : childForeignKeys(fk, parentValues);
        const identity = this.writes.relations.appendCreate(
          child,
          data,
          injected,
          steps
        );
        if (fk.holdsFK) {
          this.updateParentForeignKey(parent, fk, identity, parentValues);
        }
      }
    }
    if (mutation.createMany) {
      this.writes.relations.compileCreateMany(
        child,
        fk,
        mutation.createMany.data,
        mutation.createMany.skipDuplicates,
        parentValues,
        steps
      );
    }
    if (mutation.connect) {
      for (const where of uniqueRecords(records(mutation.connect))) {
        const target = this.captures.capture(
          child,
          statement(child, "findMany", {
            whereUnique: where,
            take: 1,
            lock: "transaction",
          }),
          undefined,
          relationTargetFailure(relation, "connect")
        );
        if (fk.holdsFK) {
          this.updateParentForeignKey(parent, fk, target.values, parentValues);
          continue;
        }
        steps.push(
          createWriteStep(
            this.stepId("write"),
            statement(child, "update", {
              where: primaryKeyWhere(child, target.identity),
              data: fkAssignments(fk, parentValues),
            }),
            {
              expectedCardinality: "one",
              affectedRows: "unrestricted",
              maximumAffectedRows: 1,
            }
          )
        );
        steps.push(
          this.captures.existsGuard(
            statement(child, "findMany", {
              filter: andWhere(
                primaryKeyFilter(child, target.identity),
                correlatedWhere(fk, parentValues)
              ),
              take: 1,
              lock: "transaction",
            }),
            relationTargetFailure(relation, "connect")
          )
        );
      }
    }
    if (mutation.connectOrCreate) {
      this.branches.compileConnectOrCreate(
        parent,
        mutation,
        fk,
        parentValues,
        true
      );
    }

    const removals = new RelationRemovals(this, parent, mutation);
    removals.compileEarly(parentValues, planningParentValues, parentIdentity);

    const updateStep = mutationSteps.find((step) => step.kind === "update");
    if (updateStep) {
      for (const input of updateStep.inputs) {
        const captured = this.captures.capture(
          child,
          statement(child, "findMany", {
            ...(input.selector ? { whereUnique: input.selector } : {}),
            filter: correlatedWhere(fk, parentValues),
            take: 1,
            lock: "transaction",
          }),
          statement(child, "findMany", {
            ...(input.selector ? { whereUnique: input.selector } : {}),
            filter: correlatedWhere(fk, planningParentValues),
            take: 1,
          }),
          relationTargetFailure(relation, "update")
        );
        this.compileLocatedUpdate(child, captured, input.data);
      }
    }
    const updateManyStep = mutationSteps.find(
      (step) => step.kind === "updateMany"
    );
    if (updateManyStep) {
      for (const parsed of updateManyStep.inputs) {
        assertPortablePrimaryKeyUpdateInput(child.model, "updateMany", {
          data: parsed.data,
        });
        const { scalarData, relations: updateManyRelations } = separateData(
          child,
          parsed.data
        );
        this.assertUpdateManyDataIsCompilable(
          relation.name,
          updateManyRelations
        );
        if (Object.keys(scalarData).length === 0) continue;
        steps.push(
          createWriteStep(
            this.stepId("write"),
            statement(child, "updateMany", {
              where: correlatedWhere(fk, parentValues, parsed.where),
              data: scalarData,
            }),
            { expectedCardinality: "many", affectedRows: "unrestricted" }
          )
        );
      }
    }
    const upsertStep = mutationSteps.find((step) => step.kind === "upsert");
    if (upsertStep) {
      this.branches.compileUpsert(
        parent,
        upsertStep,
        fk,
        parentValues,
        planningParentValues
      );
    }
    const deleteManyStep = mutationSteps.find(
      (step) => step.kind === "deleteMany"
    );
    removals.compileDeleteMany(parentValues, deleteManyStep?.inputs ?? []);
  }

  private compileRelationKeyGuards(
    parent: QueryScope,
    relations: Record<string, RelationMutation>,
    before: ProgramRecord,
    after: ProgramRecord,
    scalarData: Record<string, unknown>
  ): void {
    for (const mutation of Object.values(relations)) {
      const relation = mutation.relationInfo;
      if (relation.type === "manyToMany") continue;
      const fk = getFkDirection(parent, relation);
      if (fk.holdsFK || fk.onUpdate === "cascade") continue;
      const changedFields = fk.pkFields.filter(
        (field) => scalarData[field] !== undefined
      );
      if (changedFields.length === 0) continue;
      const child = createChildScope(
        parent,
        relation.targetModel,
        parent.nextAlias()
      );
      const action = fk.onUpdate ?? "restrict";
      this.steps.push({
        id: this.stepId("guard"),
        kind: "guard",
        premise: {
          kind: "notExistsWhenChanged",
          before: changedFields.map((field) => before[field]),
          after: changedFields.map((field) => after[field]),
          statement: statement(child, "findMany", {
            filter: correlatedWhere(fk, before),
            take: 1,
            lock: "transaction",
          }),
        },
        failure: relationFailure(
          relation,
          `Cannot update relation '${relation.name}' with onUpdate('${action}') while the current relation is occupied.`
        ),
      });
    }
  }

  private updateParentForeignKey(
    parent: QueryScope,
    fk: FkDirection,
    targetValues: ProgramRecord,
    parentValues: ProgramRecord
  ): void {
    const steps = this.steps;
    const parentIdentity = pickIdentity(parent, parentValues);
    const values = parentForeignKeys(fk, targetValues);
    steps.push(
      createWriteStep(
        this.stepId("write"),
        statement(parent, "update", {
          where: primaryKeyWhere(parent, parentIdentity),
          data: setAssignments(values),
        }),
        { expectedCardinality: "one", affectedRows: "exact" }
      )
    );
    Object.assign(parentValues, values);
    Object.assign(parentIdentity, values);
  }

  stepId(kind: "branch" | "failure" | "guard" | "read" | "write"): string {
    const id = `${kind}:relation-update:${this.nextStepId}`;
    this.nextStepId += 1;
    return id;
  }
}

function assertRelationKeyUpdatesAreCompilable(
  ctx: QueryScope,
  scalarData: Record<string, unknown>,
  relations: Record<string, RelationMutation>
): void {
  const primaryKeyFields = new Set(getPrimaryKeyFields(ctx.model));

  for (const mutation of Object.values(relations)) {
    if (mutation.relationInfo.type === "manyToMany") continue;

    const fk = getFkDirection(ctx, mutation.relationInfo);
    const relationKeyFields = fk.holdsFK ? fk.fkFields : fk.pkFields;
    for (const field of relationKeyFields) {
      if (scalarData[field] === undefined) continue;
      if (primaryKeyFields.has(field) && !fk.holdsFK) continue;
      if (classifyRelationKeyScalarUpdate(scalarData[field]).resolved) continue;

      throw new NestedWriteError(
        `Cannot update relation key field '${field}' with a non-literal operation while mutating relation '${mutation.relationInfo.name}'. Use a literal value or '{ set: ... }'.`,
        mutation.relationInfo.name,
        {
          meta: {
            operation: "update",
            field,
            relation: mutation.relationInfo.name,
          },
        }
      );
    }
  }
}
