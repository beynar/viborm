// biome-ignore-all lint/style/useFilenamingConvention: Architecture names this child RelationCaptures.
import {
  createReadStep,
  type GuardStep,
  type OperationStatement,
  type ProgramFailure,
} from "./operation-program";
import {
  andWhere,
  type ProgramRecord,
  pickIdentity,
  primaryKeyFilter,
  relationStatement,
} from "./RelationProgramValues";
import type { RelationUpdates } from "./RelationUpdates";
import type { QueryScope } from "./types";

export interface CapturedRow {
  readonly step: ReturnType<typeof createReadStep>;
  readonly values: ProgramRecord;
  readonly identity: ProgramRecord;
}

/** Owns target capture and in-batch pin construction for relation updates. */
export class RelationCaptures<T> {
  private readonly updates: RelationUpdates<T>;

  constructor(updates: RelationUpdates<T>) {
    this.updates = updates;
  }

  capture(
    ctx: QueryScope,
    read: OperationStatement,
    specializeStatement: OperationStatement | undefined,
    failure?: ProgramFailure
  ): CapturedRow {
    const steps = this.updates.steps;
    const id = this.updates.stepId("read");
    const producedValues = ctx.model["~"].scalarFieldNames.map((field) =>
      this.updates.writes.compiler.allocateProducedValue(id, field, "row")
    );
    const values = Object.fromEntries(
      producedValues.map((value) => [value.field, value])
    );
    const step = createReadStep(id, withoutTransactionLock(read), {
      expectedRows: { kind: "exact", count: 1 },
      producedValues,
      ...(specializeStatement ? { specializeStatement } : {}),
      ...(failure ? {} : { missing: "not-found" as const }),
      failure,
    });
    steps.push(step);
    const identity = pickIdentity(ctx, values);
    const pinFailure = failure ?? {
      kind: "notFound" as const,
      message: "Update target record was not found.",
      raceable: false,
    };
    steps.push(
      this.existsGuard(pinCapturedRead(ctx, read, identity), pinFailure)
    );
    return { step, values, identity };
  }

  existsGuard(
    statement: OperationStatement,
    failure: ProgramFailure
  ): GuardStep {
    return {
      id: this.updates.stepId("guard"),
      kind: "guard",
      premise: {
        kind: "exists",
        statement,
      },
      failure,
    };
  }
}

function withoutTransactionLock(
  statement: OperationStatement
): OperationStatement {
  const { lock: _lock, ...unlocked } = statement;
  return unlocked;
}

function pinCapturedRead(
  ctx: QueryScope,
  read: OperationStatement,
  identity: ProgramRecord
): OperationStatement {
  const filter = isRecord(read.args.filter) ? read.args.filter : {};
  return relationStatement(ctx, "findMany", {
    ...read.args,
    filter: andWhere(filter, primaryKeyFilter(ctx, identity)),
    lock: "transaction",
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
