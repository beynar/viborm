// biome-ignore-all lint/style/useFilenamingConvention: OperationExecutor is the architecture name.
import type { AnyDriver, QueryExecutionContext, QueryResult } from "@drivers";
import {
  assertNormalizedBatchResults,
  assertNormalizedQueryResult,
} from "@drivers/normalized-result";
import {
  NestedWriteAssertionError,
  NestedWriteError,
  QueryEngineError,
  TransactionError,
} from "@errors";
import type { Model } from "@schema/model";
import { isSql, Sql } from "@sql";
import {
  createCorrelationId,
  createOperationExecutionContext,
} from "../query-engine/execution-context";
import type { QueryEngine } from "../query-engine/query-engine";
import { CreateOperation } from "./CreateOperation";
import {
  type GuardStep,
  isOperationValueReference,
  type OperationFragment,
  type OperationValueReference,
  type StatementOutputSource,
  type StatementStep,
} from "./OperationFragment";

type RuntimeValues = Map<string, Map<string, unknown>>;

interface BatchEntry {
  readonly statement: Sql;
  readonly step?: StatementStep;
  readonly guard?: GuardStep;
  readonly guardProbe?: Sql;
}

export class OperationExecutor {
  private readonly engine: QueryEngine;

  constructor(engine: QueryEngine) {
    this.engine = engine;
  }

  async executeCreate<T>(
    model: Model<any>,
    args: Record<string, unknown>
  ): Promise<T> {
    const operation = new CreateOperation(this.engine, model, args);
    const context = createOperationExecutionContext(
      getStepModelName(model, "model"),
      "create",
      this.engine.instrumentation
    );
    if (operation.mode === "transaction") {
      return this.executeTransaction<T>(operation, context);
    }
    const outputs = await this.executePlannedBatch(operation, context);
    return operation.parseResult<T>(outputs);
  }

  private executeTransaction<T>(
    operation: CreateOperation,
    context: QueryExecutionContext
  ): Promise<T> {
    return this.engine.driver.withTransaction(
      async (driver) => {
        const planningOutputs = await this.executeLinear(
          operation.createPlanningFragment(),
          driver,
          new Map(),
          context
        );
        const outputs = await this.executeLinear(
          operation.createFragment(planningOutputs),
          driver,
          new Map(),
          context
        );
        return operation.parseResult<T>(outputs);
      },
      undefined,
      context
    );
  }

  private async executePlannedBatch(
    operation: CreateOperation,
    context: QueryExecutionContext
  ): Promise<Readonly<Record<string, unknown>>> {
    const planningOutputs = await this.executeLinear(
      operation.createPlanningFragment(),
      this.engine.driver,
      new Map(),
      context
    );
    return this.executeBatch(
      operation.createFragment(planningOutputs),
      this.engine.driver,
      context
    );
  }

  private async executeLinear(
    fragment: OperationFragment,
    driver: AnyDriver,
    values: RuntimeValues,
    context: QueryExecutionContext
  ): Promise<Readonly<Record<string, unknown>>> {
    for (const step of fragment.steps) {
      if (step.kind === "guard") {
        throw new QueryEngineError(
          `Guard step '${step.id}' requires atomic batch execution.`
        );
      }
      const result = await driver._execute(
        materializeLinearSql(step.statement, values),
        context
      );
      assertNormalizedQueryResult(result, {
        provider: driver.driverName,
        operation: step.id,
      });
      values.set(step.id, extractOutputs(step, result));
    }
    return resolveFragmentOutputs(fragment, values);
  }

  private async executeBatch(
    fragment: OperationFragment,
    driver: AnyDriver,
    context: QueryExecutionContext
  ): Promise<Readonly<Record<string, unknown>>> {
    const values: RuntimeValues = new Map();
    const batchId = `operation_${createCorrelationId()}`;
    const batchEntries: BatchEntry[] = [];
    let nextReference = 0;
    let usesScratch = false;

    for (const step of fragment.steps) {
      if (step.kind === "guard") {
        const probe = materializeBatchSql(step.premise.statement, values);
        const statement =
          step.premise.kind === "exists"
            ? this.engine.adapter.assertions.exists(probe)
            : this.engine.adapter.assertions.notExists(probe);
        batchEntries.push({
          statement,
          guard: step,
          guardProbe: probe,
        });
        continue;
      }

      batchEntries.push({
        statement: materializeBatchSql(step.statement, values),
        step,
      });
      for (const [output, source] of Object.entries(step.outputs)) {
        if (source.kind !== "insertId") continue;
        usesScratch = true;
        const key = `ref_${nextReference}`;
        nextReference += 1;
        setRuntimeValue(
          values,
          step.id,
          output,
          this.engine.adapter.batchRefs.read(batchId, key)
        );
        batchEntries.push({
          statement: this.engine.adapter.batchRefs.storeLastInsertId(
            batchId,
            key
          ),
        });
      }
    }

    const entries = buildBatchEntries(
      batchEntries,
      this.engine.adapter,
      batchId,
      usesScratch
    );
    const queries = entries.map((entry) => driver._prepare(entry.statement));

    let results: QueryResult<unknown>[];
    try {
      results = await driver._executeBatch(queries, undefined, context);
    } catch (error) {
      throw await attributeGuardFailure(error, entries, driver, context);
    }
    assertNormalizedBatchResults(results, entries.length, {
      provider: driver.driverName,
      operation: "query-engine-v2",
    });

    for (let index = 0; index < entries.length; index += 1) {
      const step = entries[index]?.step;
      const result = results[index];
      if (!(step && result)) continue;
      mergeBatchOutputs(step, result, values);
    }
    return resolveFragmentOutputs(fragment, values);
  }
}

function materializeLinearSql(statement: Sql, values: RuntimeValues): Sql {
  return new Sql(
    statement.strings,
    statement.values.map((value) => {
      if (!isOperationValueReference(value)) return value;
      const resolved = resolveRuntimeValue(value, values);
      if (isSql(resolved)) {
        throw new QueryEngineError(
          `Operation reference '${value.step}.${value.output}' is not a concrete runtime value.`
        );
      }
      return resolved;
    })
  );
}

function materializeBatchSql(statement: Sql, values: RuntimeValues): Sql {
  return new Sql(
    statement.strings,
    statement.values.map((value) =>
      isOperationValueReference(value)
        ? resolveRuntimeValue(value, values)
        : value
    )
  );
}

function extractOutputs(
  step: StatementStep,
  result: QueryResult<unknown>
): Map<string, unknown> {
  const outputs = new Map<string, unknown>();
  for (const [name, source] of Object.entries(step.outputs)) {
    outputs.set(name, extractOutput(step.id, source, result));
  }
  return outputs;
}

function extractOutput(
  step: string,
  source: StatementOutputSource,
  result: QueryResult<unknown>
): unknown {
  if (source.kind === "rows") return result.rows;
  if (source.kind === "insertId") {
    if (result.insertId === undefined) {
      throw new TransactionError(
        `Step '${step}' did not produce an insert id.`
      );
    }
    return result.insertId;
  }
  const row = result.rows[0];
  if (
    !(isRecord(row) && Object.hasOwn(row, source.field)) ||
    row[source.field] === undefined
  ) {
    throw new TransactionError(
      `Step '${step}' did not produce row field '${source.field}'.`
    );
  }
  return row[source.field];
}

function mergeBatchOutputs(
  step: StatementStep,
  result: QueryResult<unknown>,
  values: RuntimeValues
): void {
  for (const [name, source] of Object.entries(step.outputs)) {
    if (source.kind === "insertId" && result.insertId === undefined) {
      const existing = values.get(step.id)?.get(name);
      if (isSql(existing)) continue;
    }
    setRuntimeValue(
      values,
      step.id,
      name,
      extractOutput(step.id, source, result)
    );
  }
}

function resolveFragmentOutputs(
  fragment: OperationFragment,
  values: RuntimeValues
): Readonly<Record<string, unknown>> {
  const outputs: Record<string, unknown> = {};
  for (const [name, reference] of Object.entries(fragment.outputs)) {
    const value = resolveRuntimeValue(reference, values);
    if (isSql(value) || isOperationValueReference(value)) {
      throw new QueryEngineError(
        `Fragment output '${name}' did not resolve to a runtime value.`
      );
    }
    outputs[name] = value;
  }
  return outputs;
}

function resolveRuntimeValue(
  reference: OperationValueReference,
  values: RuntimeValues
): unknown {
  const outputs = values.get(reference.step);
  if (!outputs?.has(reference.output)) {
    throw new QueryEngineError(
      `Operation reference '${reference.step}.${reference.output}' is unresolved.`
    );
  }
  return outputs.get(reference.output);
}

function setRuntimeValue(
  values: RuntimeValues,
  step: string,
  output: string,
  value: unknown
): void {
  let outputs = values.get(step);
  if (!outputs) {
    outputs = new Map();
    values.set(step, outputs);
  }
  outputs.set(output, value);
}

function buildBatchEntries(
  entries: BatchEntry[],
  adapter: QueryEngine["adapter"],
  batchId: string,
  usesScratch: boolean
): BatchEntry[] {
  if (!usesScratch) return entries;
  return [
    ...adapter.batchRefs.setup(batchId).map((statement) => ({ statement })),
    { statement: adapter.batchRefs.clear(batchId) },
    ...entries,
    { statement: adapter.batchRefs.cleanup(batchId) },
  ];
}

async function attributeGuardFailure(
  error: unknown,
  entries: readonly BatchEntry[],
  driver: AnyDriver,
  context: QueryExecutionContext
): Promise<unknown> {
  if (!(error instanceof NestedWriteAssertionError)) return error;
  const statementIndex = error.meta.statementIndex;
  if (typeof statementIndex === "number") {
    const guard = entries[statementIndex]?.guard;
    return guard ? createGuardError(guard) : error;
  }
  for (const entry of entries) {
    if (!(entry.guard && entry.guardProbe)) continue;
    const result = await driver._execute(entry.guardProbe, context);
    assertNormalizedQueryResult(result, {
      provider: driver.driverName,
      operation: entry.guard.id,
    });
    const exists = result.rows.length > 0;
    const holds = entry.guard.premise.kind === "exists" ? exists : !exists;
    if (!holds) return createGuardError(entry.guard);
  }
  return error;
}

function createGuardError(step: GuardStep): NestedWriteError {
  return new NestedWriteError(step.failure.message, step.failure.relation);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function getStepModelName(model: Model<any>, fallback: string): string {
  return model["~"].names.ts ?? model["~"].names.sql ?? fallback;
}
