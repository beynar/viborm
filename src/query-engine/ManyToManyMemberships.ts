// biome-ignore-all lint/style/useFilenamingConvention: Architecture names this compiler child ManyToManyMemberships.
import type { ManyToManyJoinInfo } from "./builders/many-to-many-utils";
import type { ConnectOrCreateInput } from "./builders/relation-data-builder";
import { createChildScope, getTableName } from "./context";
import {
  createReadStep,
  createWriteStep,
  type ProgramFailure,
  type ProgramStatement,
  type RelationStatement,
} from "./operation-program";
import type { CapturedRow } from "./RelationCaptures";
import {
  pickIdentity,
  primaryKeyFilter,
  records,
  relationStatement,
  relationTargetFailure,
} from "./RelationProgramValues";
import type { RelationUpdates } from "./RelationUpdates";
import type { QueryScope, RelationInfo } from "./types";
import { NestedWriteError } from "./types";
import { uniqueConflictTarget } from "./WritePrograms";

/** Compiles target creation, capture, and oriented junction membership changes. */
export class ManyToManyMemberships<T> {
  private readonly updates: RelationUpdates<T>;

  constructor(updates: RelationUpdates<T>) {
    this.updates = updates;
  }

  create(
    parent: QueryScope,
    relation: RelationInfo,
    join: ManyToManyJoinInfo,
    parentValue: unknown,
    data: Record<string, unknown>
  ): void {
    const child = manyToManyChildContext(parent, relation);
    const identity = this.updates.writes.relations.appendCreate(
      child,
      data,
      {},
      this.updates.steps
    );
    this.insert(
      parent,
      relation,
      parentValue,
      requiredManyToManyValue(identity, join.targetPkField, relation.name)
    );
  }

  connect(
    parent: QueryScope,
    relation: RelationInfo,
    join: ManyToManyJoinInfo,
    parentValue: unknown,
    where: Record<string, unknown>
  ): void {
    const child = manyToManyChildContext(parent, relation);
    const target = this.updates.captures.capture(
      child,
      relationStatement(child, "findMany", {
        whereUnique: where,
        take: 1,
        lock: "transaction",
      }),
      undefined,
      relationTargetFailure(relation, "connect")
    );
    this.insert(
      parent,
      relation,
      parentValue,
      requiredManyToManyValue(target.values, join.targetPkField, relation.name)
    );
  }

  connectOrCreate(
    parent: QueryScope,
    relation: RelationInfo,
    join: ManyToManyJoinInfo,
    parentValue: unknown,
    input: ConnectOrCreateInput
  ): void {
    const child = manyToManyChildContext(parent, relation);
    const decision = this.decision(
      child,
      relationStatement(child, "findMany", {
        whereUnique: input.where,
        take: 1,
        lock: "transaction",
      })
    );
    const whenTrue = this.updates.collectSteps(() => {
      this.insert(
        parent,
        relation,
        parentValue,
        requiredManyToManyValue(
          decision.values,
          join.targetPkField,
          relation.name
        )
      );
    });
    let createStep = "";
    const whenFalse = this.updates.collectSteps(() => {
      const outcome = this.updates.writes.relations.appendCreateOutcome(
        child,
        input.create,
        {},
        this.updates.steps
      );
      createStep = outcome.write.id;
      this.insert(
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
        whenTrue: this.targetPin(
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
  }

  disconnect(
    parent: QueryScope,
    relation: RelationInfo,
    parentValue: unknown,
    input: boolean | Record<string, unknown> | Record<string, unknown>[]
  ): void {
    if (input === false) return;
    if (input === true) {
      throw new NestedWriteError(
        `Nested operation 'disconnect' on many-to-many relation '${relation.name}' requires a target selector.`,
        relation.name,
        { meta: { operation: "disconnect" } }
      );
    }
    for (const targetWhere of records(input)) {
      this.write(parent, relation, "junctionDelete", {
        parentValue,
        targetWhere,
      });
    }
  }

  set(
    parent: QueryScope,
    relation: RelationInfo,
    join: ManyToManyJoinInfo,
    parentValue: unknown,
    inputs: Record<string, unknown>[]
  ): void {
    const child = manyToManyChildContext(parent, relation);
    const targets = inputs.map((where) =>
      this.updates.captures.capture(
        child,
        relationStatement(child, "findMany", {
          whereUnique: where,
          take: 1,
          lock: "transaction",
        }),
        undefined,
        relationTargetFailure(relation, "set")
      )
    );
    this.write(parent, relation, "junctionDelete", { parentValue });
    if (targets.length === 0) return;
    this.write(parent, relation, "junctionInsertMany", {
      parentValue,
      targetValues: targets.map((target) =>
        requiredManyToManyValue(
          target.values,
          join.targetPkField,
          relation.name
        )
      ),
    });
  }

  insert(
    parent: QueryScope,
    relation: RelationInfo,
    parentValue: unknown,
    targetValue: unknown
  ): void {
    this.write(parent, relation, "junctionInsert", {
      parentValue,
      targetValue,
    });
  }

  write(
    parent: QueryScope,
    relation: RelationInfo,
    operation: RelationStatement["operation"],
    args: Record<string, unknown>
  ): void {
    this.updates.steps.push(
      createWriteStep(
        this.updates.stepId("write"),
        manyToManyStatement(parent, relation, operation, args),
        { expectedCardinality: "many", affectedRows: "unrestricted" }
      )
    );
  }

  private decision(
    child: QueryScope,
    statement: ProgramStatement
  ): CapturedRow {
    const id = this.updates.stepId("read");
    const producedValues = child.model["~"].scalarFieldNames.map((field) =>
      this.updates.writes.compiler.allocateProducedValue(id, field, "row")
    );
    const values = Object.fromEntries(
      producedValues.map((value) => [value.field, value])
    );
    const step = createReadStep(id, statement, { producedValues });
    this.updates.steps.push(step);
    return { step, values, identity: pickIdentity(child, values) };
  }

  private targetPin(
    child: QueryScope,
    where: Record<string, unknown>,
    captured: CapturedRow,
    failure: ProgramFailure
  ): import("./operation-program").GuardStep {
    return {
      id: this.updates.stepId("guard"),
      kind: "guard",
      premise: {
        kind: "exists",
        statement: relationStatement(child, "findMany", {
          whereUnique: where,
          filter: primaryKeyFilter(child, captured.identity),
          take: 1,
          lock: "transaction",
        }),
      },
      failure,
    };
  }
}

export function manyToManyStatement(
  parent: QueryScope,
  relation: RelationInfo,
  operation: RelationStatement["operation"],
  args: Record<string, unknown>
): RelationStatement {
  return {
    kind: "relation",
    operation,
    model: getTableName(parent.model),
    relation: relation.name,
    args,
  };
}

export function manyToManyChildContext(
  parent: QueryScope,
  relation: RelationInfo
): QueryScope {
  return createChildScope(parent, relation.targetModel, parent.nextAlias());
}

export function requiredManyToManyValue(
  values: Record<string, unknown>,
  field: string,
  relation: string
): unknown {
  const value = values[field];
  if (value !== undefined && value !== null) return value;
  throw new NestedWriteError(
    `Cannot write many-to-many relation '${relation}': missing primary key field '${field}'.`,
    relation
  );
}

function replacementFailure(
  relation: RelationInfo,
  operation: "connectOrCreate"
): ProgramFailure {
  return {
    kind: "nestedWrite",
    message: `Record was replaced by another transaction during nested ${operation}`,
    relation: relation.name,
    raceable: false,
  };
}
