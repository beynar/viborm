// biome-ignore-all lint/style/useFilenamingConvention: Architecture names this runtime child OperationBatchRuntime.
import type { DatabaseAdapter } from "@adapters";
import type { AnyDriver } from "@drivers";
import type { QueryResult } from "@drivers/types";
import {
  isVibORMError,
  NestedWriteAssertionError,
  NestedWriteError,
  NotFoundError,
  TransactionError,
  VibORMErrorCode,
} from "@errors";
import { isSql, type Sql } from "@sql";
import type { BatchValueRef } from "./builders/values-builder";
import { createCorrelationId } from "./execution-context";
import type { OperationRuntime } from "./OperationRuntime";
import type {
  BranchStep,
  GuardStep,
  OperationProgram,
  OperationStep,
  ProgramFailure,
  ReadStep,
  UniqueConflictPin,
  WriteStep,
} from "./operation-program";
import { programValuesEqual, resolveProgramValues } from "./operation-program";
import type {
  BatchPreparationContext,
  OperationProgramBatchState,
  PreparedBatchGuard,
  PreparedBatchOperation,
  PreparedBatchRacePin,
} from "./types";

/** Specializes control-flow programs and lowers them to ordered atomic batches. */
export class OperationBatchRuntime<T> {
  private readonly runtime: OperationRuntime<T>;

  constructor(runtime: OperationRuntime<T>) {
    this.runtime = runtime;
  }

  async prepare(
    program: OperationProgram,
    driver: AnyDriver,
    context?: BatchPreparationContext
  ): Promise<PreparedBatchOperation<T> | undefined> {
    if (requiresSpecialization(program.steps)) {
      if (program.result.requiresAtomicResolution) return undefined;
      const plan = await this.specialize(program, driver, context);
      return {
        queries: plan.entries.map((entry) =>
          this.runtime.prepareStatement(entry.statement, driver)
        ),
        setupQueries: plan.state.setup.map((statement) =>
          this.runtime.prepareStatement(statement, driver)
        ),
        cleanupQueries: plan.state.cleanup.map((statement) =>
          this.runtime.prepareStatement(statement, driver)
        ),
        guards: preparedGuards(plan, this.runtime),
        racePins: preparedRacePins(plan),
        parseResult: (raw) => this.resolve(program, plan, raw, driver),
      };
    }
    if (!canLowerStatic(program)) return undefined;
    const entries = program.steps.map((step) => {
      if (step.kind !== "read" && step.kind !== "write") {
        throw new TransactionError(
          `Control step '${step.id}' cannot be lowered as a static statement.`
        );
      }
      if (!isSql(step.statement)) {
        throw new TransactionError(
          `Program step '${step.id}' requires transaction-time materialization.`
        );
      }
      return {
        step,
        statement: step.statement,
      };
    });
    return {
      queries: entries.map((entry) =>
        this.runtime.prepareStatement(entry.statement, driver)
      ),
      parseResult: (raw) =>
        this.resolve(program, { entries, outputs: new Map() }, raw, driver),
    };
  }

  async execute(program: OperationProgram, driver: AnyDriver): Promise<T> {
    const prepared = await this.prepare(program, driver);
    if (!prepared) {
      throw new TransactionError(
        `Driver '${driver.driverName}' cannot lower '${this.runtime.pending.operation}' to an atomic batch.`
      );
    }
    const setup = prepared.setupQueries ?? [];
    const cleanup = prepared.cleanupQueries ?? [];
    try {
      const raw = await driver._executeBatch(
        [...setup, ...prepared.queries, ...cleanup],
        undefined,
        this.runtime.pending.context.attribution
      );
      return prepared.parseResult(
        raw.slice(setup.length, setup.length + prepared.queries.length)
      );
    } catch (error) {
      const guards = (prepared.guards ?? []).map((guard) => ({
        ...guard,
        queryIndex: guard.queryIndex + setup.length,
      }));
      const attributed = await attributeOperationBatchError(
        error,
        guards,
        driver
      );
      const statementIndex = isVibORMError(attributed)
        ? attributed.meta.statementIndex
        : undefined;
      const racePin =
        typeof statementIndex === "number"
          ? prepared.racePins?.find(
              (candidate) =>
                candidate.queryIndex + setup.length === statementIndex
            )
          : undefined;
      throw racePin
        ? this.runtime.markRetryableRace(attributed, racePin.pin)
        : attributed;
    }
  }

  private async specialize(
    program: OperationProgram,
    driver: AnyDriver,
    context?: BatchPreparationContext
  ): Promise<SpecializedBatchPlan> {
    const plan: SpecializedBatchPlan = {
      entries: [],
      outputs: new Map(),
      values: new Map(),
      state: getBatchState(
        context,
        this.runtime.pending.context.attribution.correlationId
      ),
    };
    await this.specializeSteps(
      program.steps,
      collectBranchDecisionIds(program.steps),
      driver,
      plan
    );
    return plan;
  }

  private async specializeSteps(
    steps: readonly OperationStep[],
    decisions: ReadonlySet<string>,
    driver: AnyDriver,
    plan: SpecializedBatchPlan
  ): Promise<void> {
    for (const step of steps) {
      if (step.kind === "failure") {
        throw createProgramFailureError(
          step.failure,
          this.runtime.pending.modelName,
          this.runtime.pending.operation
        );
      }
      if (step.kind === "branch") {
        await this.specializeBranch(step, decisions, driver, plan);
        continue;
      }
      if (step.kind === "guard") {
        this.lowerGuard(step, plan);
        continue;
      }
      const statement = this.runtime.compiler.materializeStep(
        step.kind === "read" &&
          hasRowProducedValues(step) &&
          step.specializeStatement
          ? { ...step, statement: step.specializeStatement }
          : step,
        plan.outputs,
        plan.values,
        false
      );
      if (
        step.kind === "read" &&
        (decisions.has(step.id) || hasRowProducedValues(step))
      ) {
        const raw = await driver._execute(
          statement,
          this.runtime.pending.context.attribution
        );
        this.runtime.results.assertStep(step, raw, plan.outputs, driver);
        plan.outputs.set(step.id, raw);
        await this.runtime.captureProducedValues(
          step,
          raw,
          plan.values,
          driver
        );
        continue;
      }
      const race =
        plan.activeRace?.step === step.id ? plan.activeRace : undefined;
      plan.entries.push({ statement, step, ...(race ? { race } : {}) });
      this.lowerProducedStores(step, plan);
    }
  }

  private async specializeBranch(
    step: BranchStep,
    decisions: ReadonlySet<string>,
    driver: AnyDriver,
    plan: SpecializedBatchPlan
  ): Promise<void> {
    const decision = plan.outputs.get(step.premise.step);
    if (!decision) {
      throw new TransactionError(
        `Batch branch '${step.id}' has no planning result for '${step.premise.step}'.`
      );
    }
    const matched = decision.rows.length > 0;
    const pin = matched ? step.pin.whenTrue : step.pin.whenFalse;
    if (pin.kind === "guard") {
      this.lowerGuard(pin, plan);
    } else if (
      pin.kind === "uniqueConflict" &&
      !this.runtime.isExactUniqueConflictPin(pin)
    ) {
      throw new TransactionError(
        `Batch specialization cannot pin the missing upsert premise for model '${this.runtime.pending.modelName}'.`
      );
    }
    const previousRace = plan.activeRace;
    if (!matched && pin.kind === "uniqueConflict") plan.activeRace = pin;
    try {
      await this.specializeSteps(
        matched ? step.whenTrue : step.whenFalse,
        decisions,
        driver,
        plan
      );
    } finally {
      plan.activeRace = previousRace;
    }
  }

  private lowerGuard(step: GuardStep, plan: SpecializedBatchPlan): void {
    if (step.premise.kind === "notExistsWhenChanged") {
      const before = resolveProgramValues(step.premise.before, plan.values);
      const after = resolveProgramValues(step.premise.after, plan.values);
      if (programValuesEqual(before, after)) return;
    }
    const probe = this.runtime.compiler.materializeStatement(
      step.premise.statement,
      plan.outputs,
      plan.values,
      false
    );
    const statement =
      step.premise.kind === "notExists" ||
      step.premise.kind === "notExistsWhenChanged"
        ? this.runtime.pending.engine.adapter.assertions.notExists(probe)
        : this.runtime.pending.engine.adapter.assertions.exists(probe);
    plan.entries.push({ statement, guard: step, guardProbe: probe });
  }

  private lowerProducedStores(
    step: ReadStep | WriteStep,
    plan: SpecializedBatchPlan
  ): void {
    for (const produced of step.producedValues ?? []) {
      if (produced.kind === "producedRows" || produced.source !== "insertId") {
        throw new TransactionError(
          `Batch step '${step.id}' cannot capture row field '${produced.field}' after execution.`
        );
      }
      initializeBatchState(plan.state, this.runtime.pending.engine.adapter);
      const reference: BatchValueRef = {
        kind: "batchValueRef",
        batchId: plan.state.batchId,
        key: `ref_${plan.state.nextReference}`,
      };
      plan.state.nextReference += 1;
      plan.values.set(produced.id, reference);
      plan.entries.push({
        statement:
          this.runtime.pending.engine.adapter.batchRefs.storeLastInsertId(
            reference.batchId,
            reference.key
          ),
      });
    }
  }

  private resolve(
    program: OperationProgram,
    plan: Pick<SpecializedBatchPlan, "entries" | "outputs">,
    raw: QueryResult<unknown>[],
    driver: AnyDriver
  ): T {
    if (raw.length > plan.entries.length) {
      throw new TransactionError(
        `Driver '${driver.driverName}' returned ${raw.length} batch results for ${plan.entries.length} statements.`
      );
    }
    const outputs = new Map(plan.outputs);
    for (let index = 0; index < plan.entries.length; index++) {
      const result = raw[index];
      if (!result) {
        throw new TransactionError(
          `Driver '${driver.driverName}' omitted result ${index} for '${this.runtime.pending.operation}'.`
        );
      }
      const step = plan.entries[index]!.step;
      if (!step) continue;
      this.runtime.results.assertStep(step, result, outputs, driver);
      outputs.set(step.id, result);
    }
    return this.runtime.results.resolve(program, outputs, driver);
  }
}

interface SpecializedBatchEntry {
  readonly statement: Sql;
  readonly step?: ReadStep | WriteStep;
  readonly guard?: GuardStep;
  readonly guardProbe?: Sql;
  readonly race?: UniqueConflictPin;
}

interface SpecializedBatchPlan {
  readonly entries: SpecializedBatchEntry[];
  readonly outputs: Map<string, QueryResult<unknown>>;
  readonly values: Map<string, unknown>;
  readonly state: OperationProgramBatchState;
  activeRace?: UniqueConflictPin;
}

export function hasControlSteps(steps: readonly OperationStep[]): boolean {
  return steps.some(
    (step) =>
      step.kind === "guard" || step.kind === "branch" || step.kind === "failure"
  );
}

function requiresSpecialization(steps: readonly OperationStep[]): boolean {
  return steps.some((step) => {
    if (
      step.kind === "guard" ||
      step.kind === "branch" ||
      step.kind === "failure"
    ) {
      return true;
    }
    return !isSql(step.statement) || (step.producedValues?.length ?? 0) > 0;
  });
}

function canLowerStatic(program: OperationProgram): boolean {
  return (
    (program.atomicity === "operation" ||
      program.result.operation === "createMany" ||
      program.result.operation === "createManyAndReturn") &&
    !program.result.requiresAtomicResolution &&
    program.steps.every(
      (step) =>
        (step.kind === "read" || step.kind === "write") &&
        isSql(step.statement) &&
        step.requiresRowsFrom === undefined &&
        !(step.kind === "write" && step.onUniqueConflict === "skip")
    )
  );
}

function collectBranchDecisionIds(
  steps: readonly OperationStep[],
  ids = new Set<string>()
): ReadonlySet<string> {
  for (const step of steps) {
    if (step.kind !== "branch") continue;
    ids.add(step.premise.step);
    collectBranchDecisionIds(step.whenTrue, ids);
    collectBranchDecisionIds(step.whenFalse, ids);
  }
  return ids;
}

function hasRowProducedValues(step: ReadStep): boolean {
  return (
    step.producedValues?.some(
      (value) => value.kind === "producedRows" || value.source === "row"
    ) ?? false
  );
}

function getBatchState(
  context: BatchPreparationContext | undefined,
  correlationId?: string
): OperationProgramBatchState {
  if (context?.operationProgramState) {
    if (!isProgramBatchState(context.operationProgramState)) {
      throw new TransactionError("Invalid operation-program batch state.");
    }
    return context.operationProgramState;
  }
  const state: OperationProgramBatchState = {
    batchId: `operation_${correlationId ?? createCorrelationId()}`,
    nextReference: 0,
    initialized: false,
    setup: [],
    cleanup: [],
  };
  if (context) context.operationProgramState = state;
  return state;
}

function initializeBatchState(
  state: OperationProgramBatchState,
  adapter: DatabaseAdapter
): void {
  if (state.initialized) return;
  state.initialized = true;
  state.setup.push(
    ...adapter.batchRefs.setup(state.batchId),
    adapter.batchRefs.clear(state.batchId)
  );
  state.cleanup.push(adapter.batchRefs.cleanup(state.batchId));
}

function isProgramBatchState(
  value: unknown
): value is OperationProgramBatchState {
  return (
    value !== null &&
    typeof value === "object" &&
    "batchId" in value &&
    "nextReference" in value &&
    "setup" in value &&
    "cleanup" in value
  );
}

function preparedGuards<T>(
  plan: SpecializedBatchPlan,
  runtime: OperationRuntime<T>
): PreparedBatchGuard[] {
  const guards: PreparedBatchGuard[] = [];
  for (let queryIndex = 0; queryIndex < plan.entries.length; queryIndex++) {
    const entry = plan.entries[queryIndex]!;
    if (!(entry.guard && entry.guardProbe)) continue;
    guards.push({
      queryIndex,
      premise:
        entry.guard.premise.kind === "notExists" ||
        entry.guard.premise.kind === "notExistsWhenChanged"
          ? "notExists"
          : "exists",
      probe: entry.guardProbe,
      failure: entry.guard.failure,
      model: runtime.pending.modelName,
      operation: runtime.pending.operation,
    });
  }
  return guards;
}

function preparedRacePins(plan: SpecializedBatchPlan): PreparedBatchRacePin[] {
  return plan.entries.flatMap((entry, queryIndex) =>
    entry.race ? [{ queryIndex, pin: entry.race }] : []
  );
}

export async function attributeOperationBatchError(
  error: unknown,
  guards: readonly PreparedBatchGuard[],
  driver: AnyDriver
): Promise<unknown> {
  if (!(error instanceof NestedWriteAssertionError)) return error;
  const statementIndex = isVibORMError(error)
    ? error.meta.statementIndex
    : undefined;
  if (typeof statementIndex === "number") {
    const guard = guards.find(
      (candidate) => candidate.queryIndex === statementIndex
    );
    if (guard) {
      return createProgramFailureError(
        guard.failure,
        guard.model,
        guard.operation
      );
    }
    return error;
  }
  for (const guard of guards) {
    const result = await driver._execute(guard.probe, {
      operation: "batchGuardAttribution",
    });
    const exists = result.rows.length > 0;
    if (guard.premise === "exists" ? !exists : exists) {
      return createProgramFailureError(
        guard.failure,
        guard.model,
        guard.operation
      );
    }
  }
  if (guards.length > 0) return error;
  return new NestedWriteError(
    "Nested write assertion failed: a batch precondition (e.g. a connect/disconnect target or ownership check) did not hold.",
    "",
    {
      code: VibORMErrorCode.NESTED_WRITE_ASSERTION_FAILED,
      cause: error,
    }
  );
}

export function createProgramFailureError(
  failure: ProgramFailure,
  model: string,
  operation: PreparedBatchGuard["operation"]
): Error {
  if (failure.kind === "notFound") {
    return new NotFoundError(model, operation);
  }
  if (failure.kind === "nestedWrite") {
    const error = new NestedWriteError(failure.message, failure.relation ?? "");
    if (failure.raceable) error.meta.raceable = true;
    return error;
  }
  return new TransactionError(failure.message, {
    meta: { model, operation },
  });
}
