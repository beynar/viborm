// biome-ignore-all lint/style/useFilenamingConvention: Architecture names this child OperationRuntime.
import type { AnyDriver, QueryExecutionContext } from "@drivers";
import type { QueryResult } from "@drivers/types";
import {
  isVibORMError,
  TransactionError,
  UniqueConstraintError,
  VibORMErrorCode,
} from "@errors";
import { SPAN_BUILD, SPAN_PARSE, SPAN_VALIDATE } from "@instrumentation";
import { runWithTracerSync } from "@instrumentation/run-with-tracer";
import { isSql, type Sql } from "@sql";
import { observeOperationExecution } from "./execution-context";
import {
  createProgramFailureError,
  OperationBatchRuntime,
} from "./OperationBatchRuntime";
import type { OperationCompiler } from "./OperationCompiler";
import type { OperationResults } from "./OperationResults";
import type {
  GuardStep,
  OperationProgram,
  OperationStep,
  ProducedOutput,
  ReadStep,
  UniqueConflictPin,
  WriteStep,
} from "./operation-program";
import { programValuesEqual, resolveProgramValues } from "./operation-program";
import type { PendingOperation } from "./pending-operation";
import type {
  BatchPreparationContext,
  PreparedBatchOperation,
  PreparedQuery,
} from "./types";

/** Executes direct and linear operation programs through one capability fork. */
export class OperationRuntime<T> {
  readonly pending: PendingOperation<T>;
  readonly compiler: OperationCompiler<T>;
  readonly results: OperationResults<T>;
  private readonly batch: OperationBatchRuntime<T>;
  private readonly retryableRaces = new WeakSet<Error>();

  constructor(
    pending: PendingOperation<T>,
    compiler: OperationCompiler<T>,
    results: OperationResults<T>
  ) {
    this.pending = pending;
    this.compiler = compiler;
    this.results = results;
    this.batch = new OperationBatchRuntime(this);
  }

  execute(driverOverride?: AnyDriver): Promise<T> {
    const driver = driverOverride ?? this.pending.engine.driver;
    return observeOperationExecution(this.pending, async (spanAttributes) => {
      const tracer = this.pending.engine.instrumentation?.tracer;
      const validated = tracer
        ? runWithTracerSync(
            tracer,
            { name: SPAN_VALIDATE, attributes: spanAttributes },
            () => this.compiler.validate()
          )
        : this.compiler.validate();
      const program = tracer
        ? runWithTracerSync(
            tracer,
            { name: SPAN_BUILD, attributes: spanAttributes },
            () => this.compiler.compileValidated(validated)
          )
        : this.compiler.compileValidated(validated);
      const resolve = (outputs: ReadonlyMap<string, QueryResult<unknown>>) =>
        tracer
          ? runWithTracerSync(
              tracer,
              { name: SPAN_PARSE, attributes: spanAttributes },
              () => this.results.resolve(program, outputs, driver)
            )
          : this.results.resolve(program, outputs, driver);
      try {
        return await this.executeProgram(program, driver, resolve);
      } catch (error) {
        if (!this.isExplicitProgramRace(error)) throw error;
        return this.executeProgram(program, driver, resolve);
      }
    });
  }

  prepare(driverOverride?: AnyDriver): PreparedQuery | undefined {
    const driver = driverOverride ?? this.pending.engine.driver;
    const program = this.compiler.compileValidated(this.compiler.validate());
    if (program.atomicity !== "statement" || program.steps.length !== 1) {
      return undefined;
    }
    const [step] = program.steps;
    if (
      !step ||
      (step.kind !== "read" && step.kind !== "write") ||
      !isSql(step.statement)
    ) {
      return undefined;
    }
    return this.prepareStatement(step.statement, driver);
  }

  async prepareBatch(
    driverOverride?: AnyDriver,
    context?: BatchPreparationContext
  ): Promise<PreparedBatchOperation<T> | undefined> {
    const driver = driverOverride ?? this.pending.engine.driver;
    const program = this.compiler.compileValidated(this.compiler.validate());
    return this.batch.prepare(program, driver, context);
  }

  private async executeProgram(
    program: OperationProgram,
    driver: AnyDriver,
    resolve: (outputs: ReadonlyMap<string, QueryResult<unknown>>) => T
  ): Promise<T> {
    if (program.atomicity === "statement") {
      const [step] = program.steps;
      if (
        program.steps.length !== 1 ||
        !step ||
        (step.kind !== "read" && step.kind !== "write")
      ) {
        throw new TransactionError(
          "Statement-atomic programs require one executable step."
        );
      }
      return resolve(await this.executeLinear(program, driver));
    }
    if (!(driver.supportsTransactions || driver.supportsBatch)) {
      throw new TransactionError(
        `Driver '${driver.driverName}' supports neither transactions nor atomic batch execution.`,
        {
          meta: {
            driver: driver.driverName,
            operation: this.pending.operation,
          },
        }
      );
    }
    if (driver.supportsTransactions) {
      return driver.withTransaction(
        async (transactionDriver) =>
          resolve(await this.executeLinear(program, transactionDriver)),
        undefined,
        this.pending.context.attribution
      );
    }
    if (
      driver.supportsBatch &&
      program.atomicity === "operation" &&
      !program.result.requiresAtomicResolution
    ) {
      return this.batch.execute(program, driver);
    }
    throw new TransactionError(
      atomicExecutionErrorMessage(program, driver, this.pending.operation),
      {
        meta: {
          driver: driver.driverName,
          operation: this.pending.operation,
        },
      }
    );
  }

  private async executeLinear(
    program: OperationProgram,
    driver: AnyDriver
  ): Promise<ReadonlyMap<string, QueryResult<unknown>>> {
    const execution: LinearProgramExecution = {
      outputs: new Map(),
      values: new Map(),
    };
    await this.executeSteps(program.steps, driver, execution);
    return execution.outputs;
  }

  private async executeSteps(
    steps: readonly OperationStep[],
    driver: AnyDriver,
    execution: LinearProgramExecution
  ): Promise<void> {
    for (const step of steps) {
      if (step.kind === "failure") {
        throw createProgramFailureError(
          step.failure,
          this.pending.modelName,
          this.pending.operation
        );
      }
      if (step.kind === "guard") {
        await this.executeGuard(
          step,
          driver,
          execution.outputs,
          execution.values
        );
        continue;
      }
      if (step.kind === "branch") {
        const decision = execution.outputs.get(step.premise.step);
        if (!decision) {
          throw new TransactionError(
            `Program branch '${step.id}' depends on incomplete step '${step.premise.step}'.`
          );
        }
        const matched = decision.rows.length > 0;
        const pin = matched ? step.pin.whenTrue : step.pin.whenFalse;
        if (pin.kind === "guard") {
          await this.executeGuard(
            pin,
            driver,
            execution.outputs,
            execution.values
          );
        }
        const previousPin = execution.uniqueConflictPin;
        if (!matched && pin.kind === "uniqueConflict") {
          execution.uniqueConflictPin = pin;
        }
        try {
          await this.executeSteps(
            matched ? step.whenTrue : step.whenFalse,
            driver,
            execution
          );
        } finally {
          execution.uniqueConflictPin = previousPin;
        }
        continue;
      }
      const dependency = step.requiresRowsFrom;
      if (dependency) {
        const output = execution.outputs.get(dependency);
        if (!output) {
          throw new TransactionError(
            `Program step '${step.id}' depends on incomplete step '${dependency}'.`
          );
        }
        if (output.rowCount === 0 && output.rows.length === 0) {
          execution.outputs.set(step.id, { rows: [], rowCount: 0 });
          continue;
        }
      }
      const statement = this.compiler.materializeStep(
        step,
        execution.outputs,
        execution.values
      );
      let raw: QueryResult<unknown>;
      try {
        raw =
          step.kind === "write" && step.onUniqueConflict === "skip"
            ? await executeSkippableWrite(
                driver,
                statement,
                this.pending.context.attribution
              )
            : await driver._execute(
                statement,
                this.pending.context.attribution
              );
      } catch (error) {
        const pin = execution.uniqueConflictPin;
        throw pin?.step === step.id
          ? this.markRetryableRace(error, pin)
          : error;
      }
      this.results.assertStep(step, raw, execution.outputs, driver);
      execution.outputs.set(step.id, raw);
      await this.captureProducedValues(step, raw, execution.values, driver);
    }
  }

  isExactUniqueConflictPin(pin: UniqueConflictPin): boolean {
    return isExactUniqueConflictPin(pin);
  }

  markRetryableRace(error: unknown, pin: UniqueConflictPin): unknown {
    if (!this.isExactUniqueConflictPin(pin)) return error;
    if (error instanceof UniqueConstraintError) {
      if (matchesPinnedUniqueConstraint(error, pin)) {
        this.retryableRaces.add(error);
      }
      return error;
    }
    if (
      isVibORMError(error) &&
      (error.code === VibORMErrorCode.DEADLOCK ||
        error.code === VibORMErrorCode.SERIALIZATION_FAILURE)
    ) {
      this.retryableRaces.add(error);
    }
    return error;
  }

  private isExplicitProgramRace(error: unknown): boolean {
    if (error instanceof Error && this.retryableRaces.delete(error))
      return true;
    return isVibORMError(error) && error.meta.raceable === true;
  }

  private async executeGuard(
    step: GuardStep,
    driver: AnyDriver,
    outputs: ReadonlyMap<string, QueryResult<unknown>>,
    values: ReadonlyMap<string, unknown>
  ): Promise<void> {
    if (step.premise.kind === "affectedRows") {
      const result = outputs.get(step.premise.step);
      if (result && result.rowCount >= step.premise.minimum) return;
      throw createProgramFailureError(
        step.failure,
        this.pending.modelName,
        this.pending.operation
      );
    }
    if (step.premise.kind === "notExistsWhenChanged") {
      const before = resolveProgramValues(step.premise.before, values);
      const after = resolveProgramValues(step.premise.after, values);
      if (programValuesEqual(before, after)) return;
    }
    const statement = this.compiler.materializeStatement(
      step.premise.statement,
      outputs,
      values
    );
    const result = await driver._execute(
      statement,
      this.pending.context.attribution
    );
    const exists = result.rows.length > 0;
    if (
      (step.premise.kind === "exists" && exists) ||
      (step.premise.kind !== "exists" && !exists)
    ) {
      return;
    }
    throw createProgramFailureError(
      step.failure,
      this.pending.modelName,
      this.pending.operation
    );
  }

  async captureProducedValues(
    step: ReadStep | WriteStep,
    raw: QueryResult<unknown>,
    values: Map<string, unknown>,
    driver: AnyDriver
  ): Promise<void> {
    if (step.kind === "read" && raw.rows.length === 0) {
      for (const produced of step.producedValues ?? []) {
        if (produced.kind === "producedRows") values.set(produced.id, []);
      }
      return;
    }
    for (const produced of step.producedValues ?? []) {
      let value = readProducedValue(produced, raw);
      if (
        value === undefined &&
        produced.kind === "producedValue" &&
        produced.source === "insertId"
      ) {
        const statement = this.pending.engine.adapter.clauses.select(
          this.pending.engine.adapter.identifiers.aliased(
            this.pending.engine.adapter.lastInsertId(),
            produced.field
          )
        );
        const selected = await driver._execute<Record<string, unknown>>(
          statement,
          this.pending.context.attribution
        );
        value = selected.rows[0]?.[produced.field];
      }
      const invalidRows =
        produced.kind === "producedRows" &&
        Array.isArray(value) &&
        value.some((entry) => entry === undefined);
      if (
        value === undefined ||
        invalidRows ||
        (value === null &&
          produced.kind === "producedValue" &&
          produced.source === "insertId")
      ) {
        throw new TransactionError(
          `Program step '${step.id}' did not produce '${produced.field}'.`
        );
      }
      values.set(produced.id, value);
    }
  }

  prepareStatement(statement: Sql, driver: AnyDriver): PreparedQuery {
    const prepared = driver._prepare(statement);
    return {
      sql: prepared.sql,
      params: prepared.params ?? [],
      context: this.pending.context.attribution,
    };
  }
}

interface LinearProgramExecution {
  readonly outputs: Map<string, QueryResult<unknown>>;
  readonly values: Map<string, unknown>;
  uniqueConflictPin?: UniqueConflictPin;
}

/** Execute one duplicate-skippable write behind a savepoint. */
export async function executeSkippableWrite(
  driver: AnyDriver,
  statement: Sql,
  context: QueryExecutionContext
): Promise<QueryResult<unknown>> {
  try {
    return await driver.withTransaction(
      (savepointDriver) => savepointDriver._execute(statement, context),
      undefined,
      context
    );
  } catch (error) {
    if (
      isVibORMError(error) &&
      error.code === VibORMErrorCode.UNIQUE_CONSTRAINT
    ) {
      return { rows: [], rowCount: 0 };
    }
    throw error;
  }
}

function readProducedValue(
  produced: ProducedOutput,
  raw: QueryResult<unknown>
): unknown {
  if (produced.kind === "producedRows") {
    return raw.rows.map((row) =>
      row !== null && typeof row === "object" && !Array.isArray(row)
        ? (row as Record<string, unknown>)[produced.field]
        : undefined
    );
  }
  if (produced.source === "insertId") return raw.insertId;
  const row = raw.rows[0];
  if (row === null || typeof row !== "object" || Array.isArray(row)) {
    return undefined;
  }
  return (row as Record<string, unknown>)[produced.field];
}

function isExactUniqueConflictPin(pin: UniqueConflictPin): boolean {
  const whereKeys = Object.keys(pin.where).filter(
    (key) => pin.where[key] !== undefined
  );
  const [selector] = whereKeys;
  if (!selector || whereKeys.length !== 1) return false;
  const selectorValue = pin.where[selector];
  const values = isRecord(selectorValue)
    ? selectorValue
    : { [selector]: selectorValue };
  const valueFields = Object.keys(values);
  return (
    pin.target.fields.length > 0 &&
    pin.target.fields.length === pin.target.columns.length &&
    pin.target.constraints.length > 0 &&
    sameStrings([...valueFields].sort(), [...pin.target.fields].sort()) &&
    pin.target.fields.every(
      (field) =>
        Object.is(pin.create[field], values[field]) &&
        values[field] !== undefined
    )
  );
}

/**
 * Unique races are retryable only when normalized provider metadata identifies
 * the exact probed constraint. Missing or contradictory attribution fails closed.
 */
function matchesPinnedUniqueConstraint(
  error: UniqueConstraintError,
  pin: UniqueConflictPin
): boolean {
  const expectedColumns = pin.target.columns.map(normalizeIdentifier).sort();
  if (
    error.meta.table &&
    normalizeIdentifier(error.meta.table) !==
      normalizeIdentifier(pin.target.table)
  ) {
    return false;
  }

  let hasTargetAttribution = false;
  if (error.meta.columns) {
    hasTargetAttribution = true;
    const actualColumns = error.meta.columns.map(normalizeIdentifier).sort();
    if (!sameStrings(actualColumns, expectedColumns)) return false;
  }
  if (error.meta.constraint) {
    hasTargetAttribution = true;
    const expectedConstraints = new Set(
      pin.target.constraints.map(normalizeIdentifier)
    );
    if (!expectedConstraints.has(normalizeIdentifier(error.meta.constraint))) {
      return false;
    }
  }
  return hasTargetAttribution;
}

function normalizeIdentifier(identifier: string): string {
  const segments = identifier.split(".");
  return (segments.at(-1) ?? identifier).replace(/["`[\]]/g, "").toLowerCase();
}

function sameStrings(
  left: readonly string[],
  right: readonly string[]
): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function atomicExecutionErrorMessage(
  program: OperationProgram,
  driver: AnyDriver,
  operation: string
): string {
  if (!program.result.requiresAtomicResolution) {
    return `Driver '${driver.driverName}' cannot guarantee atomic execution for '${operation}'.`;
  }
  if (operation === "upsert") {
    return "cannot execute non-returning upsert writes atomically because public result parsing cannot be rolled back after an atomic batch commits";
  }
  return `Driver '${driver.driverName}' cannot execute '${operation}' because public result parsing cannot be rolled back.`;
}
