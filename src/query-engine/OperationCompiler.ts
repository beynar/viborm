// biome-ignore-all lint/style/useFilenamingConvention: Architecture names this child OperationCompiler.
import type { QueryResult } from "@drivers/types";
import type { Sql } from "@sql";
import { createQueryScope } from "./context";
import {
  isProgramReadOperation,
  type OperationProgram,
  type OperationStep,
  type ProducedRows,
  type ProducedValue,
  type ProgramReadOperation,
  type ProgramStatement,
  READ_STEP_ID,
} from "./operation-program";
import {
  buildAggregate,
  buildCount,
  buildFind,
  buildFindUnique,
  buildGroupBy,
} from "./operations";
import type { PendingOperation } from "./pending-operation";
import { buildExpectedResultShape } from "./result/result-shape";
import type { QueryScope } from "./types";
import { QueryEngineError } from "./types";
import { validate } from "./validator";
import { WriteOperations } from "./WriteOperations";

/** Compiles one validated operation into its database-agnostic program. */
export class OperationCompiler<T> {
  readonly pending: PendingOperation<T>;
  readonly writes: WriteOperations<T>;
  private nextProducedValueId = 0;

  constructor(pending: PendingOperation<T>) {
    this.pending = pending;
    this.writes = new WriteOperations(this);
  }

  validate(): Record<string, unknown> {
    return validate<Record<string, unknown>>(
      this.pending.engine.schemaRegistry,
      this.pending.model,
      this.pending.operation,
      this.pending.args
    );
  }

  compile(): OperationProgram {
    return this.compileValidated(this.validate());
  }

  compileValidated(args: Record<string, unknown>): OperationProgram {
    this.nextProducedValueId = 0;
    const ctx = createQueryScope(
      this.pending.engine.adapter,
      this.pending.model
    );
    const operation = this.pending.operation;
    if (isProgramReadOperation(operation)) {
      return this.compileReadProgram(ctx, operation, args);
    }
    return this.writes.compile(ctx, operation, args);
  }

  materializeStep(
    step: OperationStep,
    results: ReadonlyMap<string, QueryResult<unknown>>,
    values: ReadonlyMap<string, unknown>,
    lockReads = true
  ): Sql {
    if (
      step.kind === "guard" ||
      step.kind === "branch" ||
      step.kind === "failure"
    ) {
      throw new QueryEngineError(`Program step '${step.id}' has no statement.`);
    }
    return this.materializeStatement(
      step.statement,
      results,
      values,
      lockReads
    );
  }

  materializeStatement(
    statement: ProgramStatement,
    results: ReadonlyMap<string, QueryResult<unknown>>,
    values: ReadonlyMap<string, unknown>,
    lockReads = true
  ): Sql {
    return this.writes.materialize(statement, results, values, lockReads);
  }

  allocateProducedValue(
    producer: string,
    field: string,
    source: ProducedValue["source"]
  ): ProducedValue {
    const value: ProducedValue = {
      kind: "producedValue",
      id: `value:${this.nextProducedValueId}`,
      producer,
      field,
      source,
    };
    this.nextProducedValueId += 1;
    return value;
  }

  allocateProducedRows(producer: string, field: string): ProducedRows {
    const value: ProducedRows = {
      kind: "producedRows",
      id: `value:${this.nextProducedValueId}`,
      producer,
      field,
    };
    this.nextProducedValueId += 1;
    return value;
  }

  private compileReadProgram(
    ctx: QueryScope,
    operation: ProgramReadOperation,
    args: Record<string, unknown>
  ): OperationProgram {
    const step = {
      id: READ_STEP_ID,
      kind: "read" as const,
      statement: this.compileRead(ctx, operation, args),
      produces: `${READ_STEP_ID}:result`,
    };
    const shape = buildExpectedResultShape(this.pending.model, operation, args);
    return {
      atomicity: "statement",
      steps: [step],
      result: {
        source: {
          kind: "rows",
          results: [{ step: step.id, result: step.produces }],
        },
        operation,
        args,
        shape,
      },
    };
  }

  private compileRead(
    ctx: QueryScope,
    operation: ProgramReadOperation,
    args: Record<string, unknown>
  ): Sql {
    switch (operation) {
      case "findUnique":
        return buildFindUnique(ctx, requireFindUniqueArgs(args));
      case "findFirst":
        return buildFind(ctx, args, { limit: 1 });
      case "findMany": {
        const take = args.take;
        if (take !== undefined && typeof take !== "number") {
          throw new QueryEngineError(
            "Validated findMany arguments contain a non-numeric take value."
          );
        }
        return buildFind(ctx, args, { limit: take });
      }
      case "count":
      case "exist":
        return buildCount(ctx, args);
      case "aggregate":
        return buildAggregate(ctx, args);
      case "groupBy": {
        const by = args.by;
        if (typeof by !== "string" && !Array.isArray(by)) {
          throw new QueryEngineError(
            "Validated groupBy arguments are missing a valid by value."
          );
        }
        return buildGroupBy(ctx, { ...args, by });
      }
      default: {
        const exhaustive: never = operation;
        throw new QueryEngineError(`Unknown read operation: ${exhaustive}`);
      }
    }
  }
}

function requireFindUniqueArgs(args: Record<string, unknown>): {
  where: Record<string, unknown>;
  select?: Record<string, unknown>;
  include?: Record<string, unknown>;
  forUpdate?: boolean;
} {
  if (!isRecord(args.where)) {
    throw new QueryEngineError(
      "Validated findUnique arguments are missing a where object."
    );
  }
  return {
    where: args.where,
    ...(isRecord(args.select) ? { select: args.select } : {}),
    ...(isRecord(args.include) ? { include: args.include } : {}),
    ...(args.forUpdate === true ? { forUpdate: true } : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
