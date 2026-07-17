// biome-ignore-all lint/style/useFilenamingConvention: Architecture names this child RelationMutations.
import { buildPrimaryKeyWhereUnique } from "./builders/correlation-utils";
import { planInsertRowShapes } from "./builders/insert-row-shapes";
import {
  buildConnectFkValues,
  type FkDirection,
  getFkDirection,
  type RelationMutation,
  separateData,
} from "./builders/relation-data-builder";
import {
  assertSingleRelationInput,
  getRelationMutationKinds,
} from "./builders/relation-mutation-parser";
import { createChildScope, getTableName } from "./context";
import { assertCreateOwnWriteSafety } from "./OwnWriteAnalyzer";
import {
  createOperationProgram,
  createReadStep,
  createResultSource,
  createWriteStep,
  type OperationProgram,
  type OperationStatement,
  type OperationStep,
  operationSelection,
  type ProducedValue,
  type ProgramFailure,
  type WriteStep,
} from "./operation-program";
import { assertPortableCreateManySkip } from "./operations/create-many-portability";
import { planNestedCreateIdentity } from "./operations/mutation-identity";
import { RelationUpdates } from "./RelationUpdates";
import { RelationUpserts } from "./RelationUpserts";
import type { QueryScope, RelationInfo } from "./types";
import { NestedWriteError, QueryEngineError } from "./types";
import type { WriteOperations } from "./WriteOperations";

type OperationValue = unknown | ProducedValue;
type OperationRecord = Record<string, OperationValue>;

interface CreateTree {
  readonly ctx: QueryScope;
  readonly scalarData: Record<string, unknown>;
  readonly relations: readonly CreateRelation[];
}

interface CreateRelation {
  readonly mutation: RelationMutation;
  readonly parent: QueryScope;
  readonly child: QueryScope;
  readonly fk: FkDirection | undefined;
  readonly creates: readonly CreateTree[];
}

/** Compiles FK-backed create/createMany/connect trees beneath writes. */
export class RelationMutations<T> {
  readonly writes: WriteOperations<T>;
  readonly updates: RelationUpdates<T>;
  private readonly upserts: RelationUpserts<T>;
  private nextStepId = 0;

  constructor(writes: WriteOperations<T>) {
    this.writes = writes;
    this.updates = new RelationUpdates(writes);
    this.upserts = new RelationUpserts(this);
  }

  compileCreate(
    ctx: QueryScope,
    args: Record<string, unknown>
  ): OperationProgram {
    const data = requireRecord(args.data, "create", "data");
    assertCreateOwnWriteSafety(ctx, data);
    const tree = this.normalizeCreateTree(ctx, data);

    this.nextStepId = 0;
    const steps: OperationStep[] = [];
    const root = this.updates.withSteps(steps, () =>
      this.compileRecord(tree, {}, steps)
    );
    const result = createReadStep(
      this.stepId("read"),
      operationStatement(ctx, "findUnique", {
        where: buildPrimaryKeyWhereUnique(ctx.model, root.identity),
        ...operationSelection(args),
      }),
      { expectedRows: { kind: "exact", count: 1 } }
    );
    steps.push(result);
    return createOperationProgram(
      "operation",
      steps,
      "create",
      args,
      { kind: "rows", results: [createResultSource(result)] },
      this.writes.resultShape("create", args),
      !ctx.adapter.capabilities.supportsReturning
    );
  }

  compileUpdate(
    ctx: QueryScope,
    args: Record<string, unknown>
  ): OperationProgram {
    this.nextStepId = 0;
    return this.updates.compile(ctx, args);
  }

  compileUpsert(
    ctx: QueryScope,
    args: Record<string, unknown>
  ): OperationProgram {
    this.nextStepId = 0;
    return this.upserts.compile(ctx, args);
  }

  appendCreate(
    ctx: QueryScope,
    data: Record<string, unknown>,
    injected: Record<string, unknown>,
    steps: OperationStep[]
  ): OperationRecord {
    return this.appendCreateOutcome(ctx, data, injected, steps).identity;
  }

  appendCreateOutcome(
    ctx: QueryScope,
    data: Record<string, unknown>,
    injected: Record<string, unknown>,
    steps: OperationStep[]
  ): { identity: OperationRecord; write: WriteStep } {
    const tree = this.normalizeCreateTree(ctx, data);
    return this.compileRecord(tree, injected, steps);
  }

  appendUpsertCreateOutcome(
    ctx: QueryScope,
    data: Record<string, unknown>,
    injected: Record<string, unknown>,
    steps: OperationStep[]
  ): { identity: OperationRecord; write: WriteStep } {
    const tree = this.normalizeCreateTree(ctx, data, "upsertCreate");
    return this.compileRecord(tree, injected, steps);
  }

  private normalizeCreateTree(
    ctx: QueryScope,
    data: Record<string, unknown>,
    context: "create" | "upsertCreate" = "create"
  ): CreateTree {
    const normalized = separateData(ctx, data);
    const relations: CreateRelation[] = [];
    for (const mutation of Object.values(normalized.relations)) {
      assertCreateMutationIsCompilable(mutation, context);
      const child = createChildScope(
        ctx,
        mutation.relationInfo.targetModel,
        ctx.nextAlias()
      );
      const creates: CreateTree[] = [];
      for (const input of mutation.create ? records(mutation.create) : []) {
        const tree = this.normalizeCreateTree(child, input);
        creates.push(tree);
      }
      relations.push({
        mutation,
        parent: ctx,
        child,
        fk:
          mutation.relationInfo.type === "manyToMany"
            ? undefined
            : getFkDirection(ctx, mutation.relationInfo),
        creates,
      });
    }
    return { ctx, scalarData: normalized.scalarData, relations };
  }

  private compileRecord(
    tree: CreateTree,
    injected: OperationRecord,
    steps: OperationStep[]
  ): { identity: OperationRecord; write: WriteStep } {
    const { ctx } = tree;
    const data: OperationRecord = { ...tree.scalarData };
    Object.assign(data, injected);
    for (const relation of tree.relations) {
      if (relation.fk?.holdsFK) {
        this.compileRelation(relation, data, steps, "before");
      }
    }

    const stepId = this.stepId("write");
    const { identity, producedValues } = this.createIdentity(ctx, data, stepId);
    const write = createWriteStep(
      stepId,
      operationStatement(ctx, "create", { data }),
      {
        expectedCardinality: "one",
        affectedRows: "exact",
        ...(producedValues.length > 0 ? { producedValues } : {}),
      }
    );
    steps.push(write);

    for (const relation of tree.relations) {
      if (!relation.fk?.holdsFK) {
        this.compileRelation(relation, identity, steps, "after");
      }
    }
    return { identity, write };
  }

  private compileRelation(
    normalized: CreateRelation,
    parentValues: OperationRecord,
    steps: OperationStep[],
    timing: "before" | "after"
  ): void {
    const { mutation, child, fk } = normalized;
    const relation = mutation.relationInfo;
    if (!fk) {
      this.updates.manyToMany.compile(
        normalized.parent,
        mutation,
        parentValues
      );
      return;
    }
    if (normalized.creates.length > 0) {
      assertSingleRelationInput(relation, "create", normalized.creates);
      for (const create of normalized.creates) {
        const outcome = this.compileRecord(
          create,
          timing === "before"
            ? {}
            : relationForeignKeys(fk, parentValues, "parent"),
          steps
        );
        if (timing === "before") {
          Object.assign(
            parentValues,
            relationForeignKeys(fk, outcome.identity, "child")
          );
        }
      }
    }
    if (timing === "after" && mutation.createMany) {
      this.compileCreateMany(
        child,
        fk,
        mutation.createMany.data,
        mutation.createMany.skipDuplicates,
        parentValues,
        steps
      );
    }
    if (mutation.connect) {
      const inputs = records(mutation.connect);
      assertSingleRelationInput(relation, "connect", inputs);
      for (const input of inputs) {
        steps.push(this.targetGuard(child, relation, input, "connect"));
        if (timing === "before") {
          Object.assign(
            parentValues,
            buildConnectFkValues(normalized.parent, relation, input)
          );
          continue;
        }
        steps.push(
          createWriteStep(
            this.stepId("write"),
            operationStatement(child, "update", {
              where: input,
              data: updateAssignments(
                relationForeignKeys(fk, parentValues, "parent")
              ),
            }),
            {
              expectedCardinality: "one",
              affectedRows: "exact",
              maximumAffectedRows: 1,
            }
          )
        );
      }
    }
    if (mutation.connectOrCreate) {
      this.updates.branches.compileConnectOrCreate(
        normalized.parent,
        mutation,
        fk,
        parentValues,
        false
      );
    }
  }

  compileCreateMany(
    ctx: QueryScope,
    fk: FkDirection,
    inputs: Record<string, unknown>[],
    skipDuplicates: boolean | undefined,
    parentIdentity: OperationRecord,
    steps: OperationStep[]
  ): void {
    if (inputs.length === 0) return;
    const inputShapes = planInsertRowShapes(
      ctx.model["~"].scalarFieldNames,
      inputs,
      (_field, value) => value === undefined
    );
    assertPortableCreateManySkip(
      skipDuplicates === true,
      inputShapes.some((shape) => shape.fields.length === 0)
    );
    const rows = inputs.map((input) => ({
      ...input,
      ...relationForeignKeys(fk, parentIdentity, "parent"),
    }));
    const groups = planInsertRowShapes(
      ctx.model["~"].scalarFieldNames,
      rows,
      (_field, value) => value === undefined
    );
    const recoverUnique =
      skipDuplicates === true &&
      ctx.adapter.mutations.skipDuplicatesStrategy === "recoverableUniqueError";
    for (const group of groups) {
      const units = recoverUnique
        ? group.rows.map((row) => [row])
        : [[...group.rows]];
      for (const data of units) {
        steps.push(
          createWriteStep(
            this.stepId("write"),
            operationStatement(ctx, "createMany", {
              data,
              ...(skipDuplicates === true ? { skipDuplicates: true } : {}),
            }),
            {
              expectedCardinality: "many",
              affectedRows: "unrestricted",
              maximumAffectedRows: data.length,
              ...(recoverUnique ? { onUniqueConflict: "skip" } : {}),
            }
          )
        );
      }
    }
  }

  private targetGuard(
    ctx: QueryScope,
    relation: RelationInfo,
    where: Record<string, unknown>,
    operation: string
  ): import("./operation-program").GuardStep {
    const failure: ProgramFailure = {
      kind: "nestedWrite",
      message: `Cannot ${operation} relation '${relation.name}': target record was not found.`,
      relation: relation.name,
      raceable: false,
    };
    return {
      id: this.stepId("guard"),
      kind: "guard",
      premise: {
        kind: "exists",
        statement: {
          ...operationStatement(ctx, "findUnique", { where }),
          lock: "transaction",
        },
      },
      failure,
    };
  }

  private createIdentity(
    ctx: QueryScope,
    data: OperationRecord,
    producer: string
  ): { identity: OperationRecord; producedValues: ProducedValue[] } {
    const plan = planNestedCreateIdentity(ctx.model, data);
    if (!plan.generatedField) {
      return { identity: plan.identity, producedValues: [] };
    }
    const field = plan.generatedField;
    delete data[field];
    const produced = this.writes.compiler.allocateProducedValue(
      producer,
      field,
      "insertId"
    );
    return {
      identity: { ...plan.identity, [field]: produced },
      producedValues: [produced],
    };
  }

  private stepId(kind: "guard" | "read" | "write"): string {
    const id = `${kind}:relation:${this.nextStepId}`;
    this.nextStepId += 1;
    return id;
  }
}

function assertCreateMutationIsCompilable(
  mutation: RelationMutation,
  context: "create" | "upsertCreate"
): void {
  const operation = getRelationMutationKinds(mutation).find(
    (kind) =>
      kind !== "create" &&
      kind !== "createMany" &&
      kind !== "connect" &&
      kind !== "connectOrCreate"
  );
  if (!operation) return;

  const relation = mutation.relationInfo.name;
  const branch =
    context === "create" ? "parent create" : "upsert create branch";
  throw new NestedWriteError(
    `Nested operation '${operation}' on relation '${relation}' is not supported in ${branch}. Only create, createMany, connect, and connectOrCreate are allowed there.`,
    relation,
    { meta: { operation, context } }
  );
}

function operationStatement(
  ctx: QueryScope,
  operation: OperationStatement["operation"],
  args: Record<string, unknown>
): OperationStatement {
  return {
    kind: "operation",
    operation,
    model: getTableName(ctx.model),
    args,
  };
}

function relationForeignKeys(
  fk: FkDirection,
  identity: OperationRecord,
  source: "child" | "parent"
): OperationRecord {
  const data: OperationRecord = {};
  for (let index = 0; index < fk.fkFields.length; index++) {
    const field = fk.fkFields[index]!;
    const referenced = fk.pkFields[index]!;
    const value = identity[referenced];
    if (value === undefined) {
      throw new NestedWriteError(
        source === "child"
          ? `Cannot connect relation: child is missing primary key field '${referenced}'.`
          : `Cannot create related rows: parent is missing primary key field '${referenced}'.`,
        field
      );
    }
    data[field] = value;
  }
  return data;
}

function updateAssignments(data: OperationRecord): OperationRecord {
  return Object.fromEntries(
    Object.entries(data).map(([field, value]) => [field, { set: value }])
  );
}

function records(
  value: Record<string, unknown> | Record<string, unknown>[]
): Record<string, unknown>[] {
  return Array.isArray(value) ? value : [value];
}

function requireRecord(
  value: unknown,
  operation: string,
  field: string
): Record<string, unknown> {
  if (isRecord(value)) return value;
  throw new QueryEngineError(
    `Validated ${operation} arguments are missing a ${field} object.`
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
