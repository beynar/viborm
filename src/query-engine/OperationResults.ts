// biome-ignore-all lint/style/useFilenamingConvention: Architecture names this child OperationResults.
import type { AnyDriver } from "@drivers";
import type { QueryResult } from "@drivers/types";
import { NestedWriteError, NotFoundError } from "@errors";
import type {
  OperationProgram,
  OperationStep,
  StepResultSource,
  WriteStep,
} from "./operation-program";
import type { PendingOperation } from "./pending-operation";
import { ResultParser } from "./result/ResultParser";
import { buildExpectedResultShape } from "./result/result-shape";
import { isBatchOperation, QueryEngineError } from "./types";

/** Resolves provider outputs from declared program sources. */
export class OperationResults<T> {
  private readonly pending: PendingOperation<T>;
  private readonly parsers = new WeakMap<AnyDriver, ResultParser>();

  constructor(pending: PendingOperation<T>) {
    this.pending = pending;
  }

  resolve(
    program: OperationProgram,
    results: ReadonlyMap<string, QueryResult<unknown>>,
    driver: AnyDriver
  ): T {
    const producedResults = new Map(
      executableSteps(program.steps).map((step) => [step.id, step.produces])
    );
    for (const source of program.result.source.results) {
      if (producedResults.get(source.step) !== source.result) {
        throw new QueryEngineError(
          `Program result '${source.result}' is not produced by step '${source.step}'.`
        );
      }
    }
    const raw =
      program.result.source.kind === "rowCount"
        ? {
            rowCount: this.sumRowCounts(program.result.source.results, results),
          }
        : this.collectRows(program.result.source.results, results);
    return this.parse(
      raw,
      driver,
      program.result.operation,
      program.result.args,
      program.result.shape
    );
  }

  assertStep(
    step: OperationStep,
    raw: QueryResult<unknown>,
    results: ReadonlyMap<string, QueryResult<unknown>>,
    driver: AnyDriver
  ): void {
    if (
      step.kind === "guard" ||
      step.kind === "branch" ||
      step.kind === "failure"
    ) {
      throw new QueryEngineError(
        `Program control step '${step.id}' has no provider result.`
      );
    }
    if (step.kind === "read") {
      const expectation = step.expectedRows;
      if (!expectation) return;
      const expected =
        expectation.kind === "exact"
          ? expectation.count
          : this.requireStepResult(results, expectation.step).rows.length;
      if (raw.rows.length === expected) return;
      if (step.failure) {
        throw new NestedWriteError(
          step.failure.message,
          step.failure.relation ?? this.pending.modelName,
          { meta: { raceable: step.failure.raceable } }
        );
      }
      if (raw.rows.length === 0 && step.missing === "not-found") {
        throw new NotFoundError(this.pending.modelName, this.pending.operation);
      }
      throw new QueryEngineError(
        `Program read '${step.id}' returned ${raw.rows.length} rows for model '${this.pending.modelName}'; expected exactly ${expected === 1 ? "one" : expected}.`,
        {
          meta: {
            driver: driver.driverName,
            operation: this.pending.operation,
            expectedRowCount: expected,
            actualRowCount: raw.rows.length,
          },
        }
      );
    }
    this.assertAffectedRows(step, raw, results, driver);
  }

  resolvePrepared(
    raw: QueryResult<unknown>,
    driver: AnyDriver,
    args: Record<string, unknown>
  ): T {
    const isDefinitiveUpdateMiss =
      this.pending.operation === "update" &&
      this.pending.engine.adapter.capabilities.supportsReturning;
    if (
      (isDefinitiveUpdateMiss || this.pending.operation === "delete") &&
      raw.rowCount === 0
    ) {
      throw new NotFoundError(this.pending.modelName, this.pending.operation);
    }
    const carrier = isBatchOperation(this.pending.operation)
      ? { rowCount: raw.rowCount }
      : raw.rows;
    return this.parse(
      carrier,
      driver,
      this.pending.operation,
      args,
      buildExpectedResultShape(this.pending.model, this.pending.operation, args)
    );
  }

  postProcess(result: T): T {
    if (this.pending.options.throwIfNotFound && result === null) {
      throw new NotFoundError(
        this.pending.modelName,
        this.pending.options.originalOperation ?? this.pending.operation
      );
    }
    return result;
  }

  private parse(
    raw: unknown[] | { rowCount: number },
    driver: AnyDriver,
    operation: OperationProgram["result"]["operation"],
    args: Record<string, unknown>,
    shape: OperationProgram["result"]["shape"]
  ): T {
    const parsed = this.getParser(driver).parse<T>(operation, raw, args, shape);
    const paginated =
      operation === "findMany" &&
      typeof args.take === "number" &&
      args.take < 0 &&
      Array.isArray(parsed)
        ? ([...parsed].reverse() as T)
        : parsed;
    return this.postProcess(paginated);
  }

  private getParser(driver: AnyDriver): ResultParser {
    const existing = this.parsers.get(driver);
    if (existing) return existing;
    const parser = new ResultParser(
      this.pending.engine.adapter,
      this.pending.model,
      driver
    );
    this.parsers.set(driver, parser);
    return parser;
  }

  private assertAffectedRows(
    step: WriteStep,
    raw: QueryResult<unknown>,
    results: ReadonlyMap<string, QueryResult<unknown>>,
    driver: AnyDriver
  ): void {
    if (
      step.expectedCardinality === "one" &&
      step.affectedRows === "exact" &&
      raw.rowCount !== 1
    ) {
      if (raw.rowCount === 0 && step.missing === "not-found") {
        throw new NotFoundError(this.pending.modelName, this.pending.operation);
      }
      throw new QueryEngineError(
        `${this.pending.operation} affected ${raw.rowCount} rows for model '${this.pending.modelName}'; expected exactly one.`,
        {
          meta: {
            driver: driver.driverName,
            operation: this.pending.operation,
            expectedRowCount: 1,
            actualRowCount: raw.rowCount,
          },
        }
      );
    }
    const maximum = step.maximumAffectedRows;
    if (maximum === undefined) return;
    const expected =
      typeof maximum === "number"
        ? maximum
        : this.requireStepResult(results, maximum.rowsFrom).rows.length;
    if (raw.rowCount <= expected) return;
    throw new QueryEngineError(
      `${this.pending.operation} affected ${raw.rowCount} rows for model '${this.pending.modelName}'; expected at most ${expected === 1 ? "one" : expected}.`
    );
  }

  private collectRows(
    sources: readonly StepResultSource[],
    results: ReadonlyMap<string, QueryResult<unknown>>
  ): unknown[] {
    if (sources.every((source) => source.inputIndex === undefined)) {
      return sources.flatMap(
        (source) => this.requireStepResult(results, source.step).rows
      );
    }
    const indexed: Array<unknown | undefined> = [];
    for (const source of sources) {
      if (source.inputIndex === undefined) {
        throw new QueryEngineError(
          "Program result mixes indexed and unindexed rows."
        );
      }
      const rows = this.requireStepResult(results, source.step).rows;
      if (rows.length > 1) {
        throw new QueryEngineError(
          `Program result '${source.step}' returned ${rows.length} rows for one input.`
        );
      }
      if (rows.length === 1) indexed[source.inputIndex] = rows[0];
    }
    return indexed.filter((row) => row !== undefined);
  }

  private sumRowCounts(
    sources: readonly StepResultSource[],
    results: ReadonlyMap<string, QueryResult<unknown>>
  ): number {
    let count = 0;
    for (const source of sources) {
      count += this.requireStepResult(results, source.step).rowCount;
    }
    return count;
  }

  private requireStepResult(
    results: ReadonlyMap<string, QueryResult<unknown>>,
    step: string
  ): QueryResult<unknown> {
    const result = results.get(step);
    if (result) return result;
    throw new QueryEngineError(`Program step '${step}' has no result.`);
  }
}

function executableSteps(
  steps: readonly OperationStep[]
): Extract<OperationStep, { kind: "read" | "write" }>[] {
  const executable: Extract<OperationStep, { kind: "read" | "write" }>[] = [];
  for (const step of steps) {
    if (step.kind === "read" || step.kind === "write") {
      executable.push(step);
      continue;
    }
    if (step.kind === "branch") {
      executable.push(...executableSteps(step.whenTrue));
      executable.push(...executableSteps(step.whenFalse));
    }
  }
  return executable;
}
