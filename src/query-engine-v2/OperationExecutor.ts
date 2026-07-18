// biome-ignore-all lint/style/useFilenamingConvention: OperationExecutor is the architecture name.
import type { AnyDriver, QueryExecutionContext, QueryResult } from "@drivers";
import {
  assertNormalizedBatchResults,
  assertNormalizedQueryResult,
} from "@drivers/normalized-result";
import {
  NestedWriteAssertionError,
  NestedWriteError,
  NotFoundError,
  QueryEngineError,
  TransactionError,
} from "@errors";
import { isSql, Sql } from "@sql";
import { createCorrelationId } from "../query-engine/execution-context";
import type { QueryEngine } from "../query-engine/query-engine";
import { validateFragment } from "./FragmentValidator";
import {
  type Failure,
  type FragmentOutputSource,
  type GuardStep,
  isOperationValueReference,
  type OperationFragment,
  type OperationValueReference,
  type StatementOutputSource,
  type StatementStep,
} from "./OperationFragment";
import { isRecord } from "./shared";

type RuntimeValues = Map<string, Map<string, unknown>>;

/**
 * The internal contract the executor drives. The executor knows nothing about
 * what the operation means: it is handed a mode, a planning fragment, a
 * per-branch compiler, and a result parser, and it only runs already-compiled
 * fragments safely. Concrete operations own every semantic decision.
 */
export interface ExecutableOperation {
  readonly mode: "transaction" | "batch";
  planning(): OperationFragment;
  compile(known: Readonly<Record<string, unknown>>): OperationFragment;
  parse<T>(outputs: Readonly<Record<string, unknown>>): T;
}

interface BatchEntry {
  readonly statement: Sql;
  readonly step?: StatementStep;
  readonly guard?: GuardStep;
  readonly guardProbe?: Sql;
}

/**
 * A compiled atomic unit: the materialized entries plus the values threaded
 * through compilation and reused for output assembly. Shaped as a value so a
 * future `$transaction([...])` path can pull entries out of several operations
 * and merge them into one driver batch — the envelope is not privately owned.
 */
interface AtomicPlan {
  readonly fragment: OperationFragment;
  readonly entries: readonly BatchEntry[];
  readonly values: RuntimeValues;
}

export class OperationExecutor {
  private readonly engine: QueryEngine;

  constructor(engine: QueryEngine) {
    this.engine = engine;
  }

  execute<T>(
    operation: ExecutableOperation,
    context: QueryExecutionContext,
    driverOverride?: AnyDriver
  ): Promise<T> {
    // A caller-supplied driver is already inside its own atomic scope (the
    // client's callback-transaction seam); run the fragments on it linearly
    // rather than opening a second envelope.
    if (driverOverride) {
      return this.runLinearOn<T>(operation, context, driverOverride);
    }
    if (operation.mode === "transaction") {
      return this.runTransaction<T>(operation, context);
    }
    return this.runAtomicBatch<T>(operation, context);
  }

  private runTransaction<T>(
    operation: ExecutableOperation,
    context: QueryExecutionContext
  ): Promise<T> {
    return this.engine.driver.withTransaction(
      (driver) => this.runLinearOn<T>(operation, context, driver),
      undefined,
      context
    );
  }

  private async runLinearOn<T>(
    operation: ExecutableOperation,
    context: QueryExecutionContext,
    driver: AnyDriver
  ): Promise<T> {
    const planning = operation.planning();
    validateFragment(planning);
    const planningOutputs = await this.executeLinear(
      planning,
      driver,
      new Map(),
      context
    );
    const fragment = operation.compile(planningOutputs);
    validateFragment(fragment);
    const outputs = await this.executeLinear(
      fragment,
      driver,
      new Map(),
      context
    );
    return operation.parse<T>(outputs);
  }

  private async runAtomicBatch<T>(
    operation: ExecutableOperation,
    context: QueryExecutionContext
  ): Promise<T> {
    const plan = await this.buildAtomicPlan(
      operation,
      this.engine.driver,
      context
    );
    const outputs = await this.executeEntries(
      plan,
      this.engine.driver,
      context
    );
    return operation.parse<T>(outputs);
  }

  /**
   * The `prepareBatch` seam of the PendingOperation contract (PLAN P1.5): run
   * planning, compile the taken fragment, and RETURN the atomic-batch entries
   * plus a `parseResult` closure — consumable by the client's shared batch
   * protocol (the `$transaction([...])` array path), which merges entries from
   * several operations into one driver batch. It never executes them itself.
   */
  async prepareBatch<T>(
    operation: ExecutableOperation,
    driver: AnyDriver,
    context: QueryExecutionContext
  ): Promise<{
    readonly queries: readonly Sql[];
    parseResult(results: readonly QueryResult<unknown>[]): T;
  }> {
    const plan = await this.buildAtomicPlan(operation, driver, context);
    return {
      queries: plan.entries.map((entry) => entry.statement),
      parseResult: (results) =>
        operation.parse<T>(assembleOutputs(plan, results)),
    };
  }

  private async buildAtomicPlan(
    operation: ExecutableOperation,
    driver: AnyDriver,
    context: QueryExecutionContext
  ): Promise<AtomicPlan> {
    const planning = operation.planning();
    validateFragment(planning);
    const planningOutputs = await this.executeLinear(
      planning,
      driver,
      new Map(),
      context
    );
    const fragment = operation.compile(planningOutputs);
    validateFragment(fragment);
    return this.compileToEntries(fragment);
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
      enforcePostcondition(step, result, context);
      values.set(step.id, extractOutputs(step, result));
    }
    return resolveFragmentOutputs(fragment, values);
  }

  /** Compile-to-entries half: lower a fragment into a runnable atomic unit. */
  private compileToEntries(fragment: OperationFragment): AtomicPlan {
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
        batchEntries.push({ statement, guard: step, guardProbe: probe });
        continue;
      }

      if (step.expects) {
        // Batch lowering of postconditions is later-phase work. A step carrying
        // one must fail closed here — never a silent skip (ATOM §1).
        throw new QueryEngineError(
          `Step '${step.id}' carries a postcondition that is not yet enforced in batch mode.`
        );
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

    return {
      fragment,
      entries: buildBatchEntries(
        batchEntries,
        this.engine.adapter,
        batchId,
        usesScratch
      ),
      values,
    };
  }

  /** Execute-entries half: run the atomic unit and assemble declared outputs. */
  private async executeEntries(
    plan: AtomicPlan,
    driver: AnyDriver,
    context: QueryExecutionContext
  ): Promise<Readonly<Record<string, unknown>>> {
    const { fragment, entries, values } = plan;
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
    return assembleOutputs(plan, results);
  }
}

/**
 * Assemble a fragment's declared outputs from one atomic batch's results —
 * shared by the executed path and the `prepareBatch` seam so a returned plan
 * parses identically to an executed one.
 */
function assembleOutputs(
  plan: AtomicPlan,
  results: readonly QueryResult<unknown>[]
): Readonly<Record<string, unknown>> {
  const { fragment, entries, values } = plan;
  for (let index = 0; index < entries.length; index += 1) {
    const step = entries[index]?.step;
    const result = results[index];
    if (!(step && result)) continue;
    mergeBatchOutputs(step, result, values);
  }
  return resolveFragmentOutputs(fragment, values);
}

function enforcePostcondition(
  step: StatementStep,
  result: QueryResult<unknown>,
  context: QueryExecutionContext
): void {
  const expects = step.expects;
  if (!expects) return;
  if (expects.kind === "exactlyOneRow") {
    if (result.rows.length !== 1) {
      throw failureError(expects.failure, context);
    }
    return;
  }
  const satisfied =
    typeof expects.expected === "number"
      ? result.rowCount === expects.expected
      : result.rowCount >= expects.expected.min;
  if (!satisfied) {
    throw failureError(expects.failure, context);
  }
}

function failureError(failure: Failure, context: QueryExecutionContext): Error {
  if (failure.kind === "nestedWrite") {
    const error = new NestedWriteError(failure.message, failure.relation ?? "");
    if (failure.raceable) error.meta.raceable = true;
    return error;
  }
  if (failure.kind === "notFound") {
    return new NotFoundError(
      context.model ?? "record",
      context.operation ?? "query"
    );
  }
  return new TransactionError(failure.message, {
    meta: {
      model: context.model ?? "record",
      operation: context.operation ?? "query",
    },
  });
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
  if (source.kind === "rowCount") return result.rowCount;
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
  for (const [name, source] of Object.entries(fragment.outputs)) {
    outputs[name] = isReferenceList(source)
      ? resolveOutputList(name, source, values)
      : resolveSingleOutput(name, source, values);
  }
  return outputs;
}

function isReferenceList(
  source: FragmentOutputSource
): source is readonly OperationValueReference[] {
  return Array.isArray(source);
}

function resolveSingleOutput(
  name: string,
  reference: OperationValueReference,
  values: RuntimeValues
): unknown {
  const value = resolveRuntimeValue(reference, values);
  if (isSql(value) || isOperationValueReference(value)) {
    throw new QueryEngineError(
      `Fragment output '${name}' did not resolve to a runtime value.`
    );
  }
  return value;
}

/**
 * An ordered list of refs resolves by concatenating rows or summing counts
 * (ATOM §1). The list is homogeneous: mixing row and count sources is a typed
 * error, never a silent coercion.
 */
function resolveOutputList(
  name: string,
  references: readonly OperationValueReference[],
  values: RuntimeValues
): unknown {
  const resolved = references.map((reference) =>
    resolveSingleOutput(name, reference, values)
  );
  if (resolved.every(Array.isArray)) {
    return resolved.flat();
  }
  if (resolved.every((value) => typeof value === "number")) {
    return (resolved as number[]).reduce((sum, value) => sum + value, 0);
  }
  if (resolved.every((value) => typeof value === "bigint")) {
    return (resolved as bigint[]).reduce((sum, value) => sum + value, 0n);
  }
  throw new QueryEngineError(
    `Fragment output '${name}' names sources that neither all concatenate as rows nor all sum as counts.`
  );
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
    return guard ? failureError(guard.failure, context) : error;
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
    if (!holds) return failureError(entry.guard.failure, context);
  }
  return error;
}
