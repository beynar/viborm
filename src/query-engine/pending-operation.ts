/**
 * Deferred operation lifecycle owned by the query engine.
 * Validation, SQL construction, and execution remain lazy until a lifecycle
 * method is called.
 */

import type { AnyDriver, QueryExecutionContext } from "@drivers";
import { PendingOperationError } from "@errors";
import type { Model } from "@schema/model";
import type {
  ExecutableOperation,
  SingleStatementPlan,
} from "../query-engine-v2/OperationExecutor";
import { OperationExecutor } from "../query-engine-v2/OperationExecutor";
import {
  constructRoutedOperation,
  executeRoutedOperation,
} from "../query-engine-v2/routing";
import {
  createPendingOperationContext,
  type OperationExecutionContext,
  observeOperationExecution,
  observePendingBatchPhase,
} from "./execution-context";
import { OperationCompiler } from "./OperationCompiler";
import { OperationResults } from "./OperationResults";
import { OperationRuntime } from "./OperationRuntime";
import type { OperationProgram } from "./operation-program";
import type { QueryEngine } from "./query-engine";
import {
  type BatchPreparationContext,
  isBatchOperation,
  type Operation,
  type PreparedBatchOperation,
  type PreparedQuery,
  type PrepareOptions,
} from "./types";

export const PENDING_OPERATION_SYMBOL = Symbol.for("viborm.pendingOperation");

type ExecutionWrapper<T> = (
  execute: (driver?: AnyDriver) => Promise<T>
) => Promise<T>;

type DeferredExecution<T> = (driverOverride?: AnyDriver) => Promise<T>;

const OR_THROW_SUFFIX = "OrThrow";

/** One user operation, from lazy creation through execution and parsing. */
export class PendingOperation<T> implements PromiseLike<T> {
  readonly [PENDING_OPERATION_SYMBOL] = true;
  readonly engine: QueryEngine;
  readonly model: Model<any>;
  readonly args: Record<string, unknown>;
  readonly modelName: string;
  readonly operation: Operation;
  readonly options: PrepareOptions;
  readonly context: OperationExecutionContext;
  private readonly compiler: OperationCompiler<T>;
  private readonly results: OperationResults<T>;
  private readonly runtime: OperationRuntime<T>;

  private promise: Promise<T> | null = null;
  private executedWith: AnyDriver | "default" | null = null;
  private readonly deferredExecution: DeferredExecution<T> | undefined;

  /**
   * Per-tree V2 routing (PLAN P5). When set, every lifecycle seam attempts to
   * construct the V2 operation for this payload (memoized in {@link v2Operation})
   * and delegates to the V2 executor; a payload V2 declines
   * (`UnsupportedOperationError`) runs the frozen V1 runtime unchanged. When
   * false — the migration escape hatch, and every non-client caller — this is
   * the pure V1 path, byte-identical to before the flip.
   */
  private readonly routeToV2: boolean;
  private v2Operation: ExecutableOperation | undefined;
  private v2Resolved = false;
  private v2ExecutorInstance: OperationExecutor | undefined;
  // The single-statement plan, memoized: `null` uncomputed, `undefined` when the
  // V2 operation is multi-statement (runs through the atomic-batch seam).
  private v2SinglePlan: SingleStatementPlan | undefined | null = null;

  private constructor(
    engine: QueryEngine,
    model: Model<any>,
    requestedOperation: Operation | `${Operation}OrThrow`,
    args: Record<string, unknown>,
    options?: PrepareOptions,
    context?: OperationExecutionContext,
    deferredExecution?: DeferredExecution<T>,
    routeToV2 = false
  ) {
    this.engine = engine;
    this.model = model;
    this.args = args;
    this.deferredExecution = deferredExecution;
    this.routeToV2 = routeToV2;
    const isOrThrow = requestedOperation.endsWith(OR_THROW_SUFFIX);
    this.operation = isOrThrow
      ? (requestedOperation.slice(0, -OR_THROW_SUFFIX.length) as Operation)
      : (requestedOperation as Operation);
    this.modelName = model["~"].names.ts ?? "unknown";
    this.options = Object.freeze({
      ...options,
      throwIfNotFound: isOrThrow || options?.throwIfNotFound,
      originalOperation: options?.originalOperation ?? requestedOperation,
    });
    this.context =
      context ??
      createPendingOperationContext(
        this.modelName,
        this.operation,
        engine.instrumentation,
        engine.clientId,
        engine.scopeId
      );
    this.compiler = new OperationCompiler(this);
    this.results = new OperationResults(this);
    this.runtime = new OperationRuntime(this, this.compiler, this.results);
  }

  static create<T>(
    engine: QueryEngine,
    model: Model<any>,
    operation: Operation | `${Operation}OrThrow`,
    args: Record<string, unknown>,
    options?: PrepareOptions
  ): PendingOperation<T> {
    return new PendingOperation<T>(engine, model, operation, args, options);
  }

  /**
   * The production routing entry point (PLAN P5 item 1): a `PendingOperation`
   * that, when `routeToV2` is true, serves migrated trees through the V2 engine
   * and everything else through the frozen V1 runtime — one call never mixing
   * engines. `routeToV2 = false` reproduces {@link create} exactly (the escape
   * hatch and non-routed internals).
   */
  static createRouted<T>(
    engine: QueryEngine,
    model: Model<any>,
    operation: Operation | `${Operation}OrThrow`,
    args: Record<string, unknown>,
    options: PrepareOptions | undefined,
    routeToV2: boolean
  ): PendingOperation<T> {
    return new PendingOperation<T>(
      engine,
      model,
      operation,
      args,
      options,
      undefined,
      undefined,
      routeToV2
    );
  }

  /**
   * Construct (once) the V2 operation for this payload, or `undefined` when V2
   * does not own the tree. Routing is decided here — lazily, before any I/O —
   * so a validation error surfaces at execution time exactly as V1's does, never
   * synchronously at client-dispatch time.
   */
  private resolveV2(): ExecutableOperation | undefined {
    if (!this.routeToV2) return undefined;
    if (this.v2Resolved) return this.v2Operation;
    this.v2Operation = constructRoutedOperation(
      this.engine,
      this.model,
      this.options.originalOperation ?? this.operation,
      this.args
    );
    this.v2Resolved = true;
    return this.v2Operation;
  }

  private v2Executor(): OperationExecutor {
    if (!this.v2ExecutorInstance) {
      this.v2ExecutorInstance = new OperationExecutor(this.engine);
    }
    return this.v2ExecutorInstance;
  }

  /**
   * The single-statement plan for a V2-owned operation, memoized. `undefined`
   * means either V2 does not own this tree or the operation is multi-statement
   * (both fall through to the atomic-batch seam).
   */
  private resolveV2Single(): SingleStatementPlan | undefined {
    if (this.v2SinglePlan !== null) return this.v2SinglePlan;
    const operation = this.resolveV2();
    this.v2SinglePlan = operation
      ? this.v2Executor().singleStatementPlan(operation)
      : undefined;
    return this.v2SinglePlan;
  }

  private getPromise(): Promise<T> {
    if (this.executedWith !== null && this.executedWith !== "default") {
      throw PendingOperationError.alreadyExecutedWithDriver(
        this.modelName,
        this.operation
      );
    }

    if (!this.promise) {
      this.executedWith = "default";
      this.promise = this.runExecution();
    }
    return this.promise;
  }

  private runExecution(driverOverride?: AnyDriver): Promise<T> {
    if (this.deferredExecution) {
      return this.deferredExecution(driverOverride);
    }
    if (this.routeToV2) {
      return this.runRouted(driverOverride);
    }
    return this.runtime.execute(driverOverride);
  }

  /**
   * Execute through the V2 engine when it owns this tree, else the frozen V1
   * runtime — each under exactly ONE {@link observeOperationExecution} wrapper,
   * so the instrumentation shape (SPAN_OPERATION, error logging) is byte-identical
   * across the flip. A V2 construction rejection (a `ValidationError`, the
   * own-write preflight, the ATOM §7 refusal) is surfaced through the same
   * observation wrapper V1 uses for its validation errors.
   */
  private runRouted(driverOverride?: AnyDriver): Promise<T> {
    let operation: ExecutableOperation | undefined;
    try {
      operation = this.resolveV2();
    } catch (error) {
      return observeOperationExecution(this, () => Promise.reject(error));
    }
    if (!operation) {
      return this.runtime.execute(driverOverride);
    }
    const v2Operation = operation;
    return observeOperationExecution(this, () =>
      executeRoutedOperation<T>(
        this.v2Executor(),
        v2Operation,
        this.context.attribution,
        driverOverride
      )
    );
  }

  canBatch(): boolean {
    return true;
  }

  isBatchOperation(): boolean {
    return isBatchOperation(this.operation);
  }

  getArgs(): Record<string, unknown> {
    return this.args;
  }

  getModel(): string {
    return this.modelName;
  }

  getOperation(): string {
    return this.operation;
  }

  getExecutionContext(): QueryExecutionContext {
    return this.context.attribution;
  }

  getClientId(): symbol {
    return this.context.clientId;
  }

  getScopeId(): symbol {
    return this.context.scopeId;
  }

  execute(): Promise<T> {
    return this.getPromise();
  }

  executeWith(driver: AnyDriver): Promise<T> {
    if (this.executedWith === "default") {
      throw PendingOperationError.alreadyExecutedDefault(
        this.modelName,
        this.operation
      );
    }
    if (this.executedWith !== null && this.executedWith !== driver) {
      throw PendingOperationError.differentDriverConflict(
        this.modelName,
        this.operation
      );
    }

    if (!this.promise) {
      this.executedWith = driver;
      this.promise = this.runExecution(driver);
    }
    return this.promise;
  }

  prepare(driver?: AnyDriver): PreparedQuery | undefined {
    if (this.routeToV2 && this.resolveV2()) {
      // A single-statement V2 operation (every read, plus scalar bulk writes)
      // exposes its one statement through this seam, exactly as V1 does — the
      // cache flow and the array-batch "single" fast path depend on it. A
      // multi-statement (composed) operation returns undefined and uses the
      // atomic-batch seam.
      const single = this.resolveV2Single();
      if (!single) return undefined;
      return this.v2Executor().prepareSingleStatement(
        single,
        driver ?? this.engine.driver,
        this.context.attribution
      );
    }
    return this.runtime.prepare(driver);
  }

  /** @internal Inspect the declarative program without executing it. */
  compile(): OperationProgram {
    return this.compiler.compile();
  }

  async prepareBatch(
    driver?: AnyDriver,
    context?: BatchPreparationContext
  ): Promise<PreparedBatchOperation<T> | undefined> {
    const targetDriver = driver ?? this.engine.driver;
    if (this.routeToV2) {
      const operation = this.resolveV2();
      if (operation) {
        return this.v2Executor().prepareSharedBatch<T>(
          operation,
          targetDriver,
          this.context.attribution,
          this.operation
        );
      }
    }
    const prepared = await this.runtime.prepareBatch(targetDriver, context);
    return prepared;
  }

  parseResult(raw: { rows: unknown[]; rowCount: number }): T {
    if (this.routeToV2) {
      const operation = this.resolveV2();
      if (operation) {
        // parseResult pairs with the single-statement `prepare()` seam (the
        // array-batch "single" path calls prepare then parseResult), so resolve
        // the same plan and map the raw result through the fragment's outputs.
        const single = this.resolveV2Single();
        if (single) {
          return this.v2Executor().parseSingleStatement<T>(
            operation,
            single,
            raw
          );
        }
        return operation.parse<T>({ result: raw.rows });
      }
    }
    return this.results.resolvePrepared(raw, this.engine.driver, this.args);
  }

  /** Attribute native-batch preparation/parsing to this logical operation. */
  async observeBatchPhase<R>(
    driver: AnyDriver,
    execute: () => R | Promise<R>
  ): Promise<R> {
    return observePendingBatchPhase(this, driver, execute);
  }

  wrapExecutor(wrapper: ExecutionWrapper<T>): PendingOperation<T> {
    const deferredExecution: DeferredExecution<T> = (driverOverride) =>
      wrapper((driver) => this.runExecution(driver ?? driverOverride));
    return new PendingOperation(
      this.engine,
      this.model,
      this.operation,
      this.args,
      this.options,
      this.context,
      deferredExecution,
      // The wrapped clone keeps this operation's routing decision: its own
      // prepare/prepareBatch seams must reach the V2 engine for the array-batch
      // path, exactly as the original would.
      this.routeToV2
    );
  }

  then<TResult1 = T, TResult2 = never>(
    onfulfilled?: ((value: T) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null
  ): Promise<TResult1 | TResult2> {
    return this.getPromise().then(onfulfilled, onrejected);
  }

  catch<TResult = never>(
    onrejected?: ((reason: unknown) => TResult | PromiseLike<TResult>) | null
  ): Promise<T | TResult> {
    return this.getPromise().catch(onrejected);
  }

  finally(onfinally?: (() => void) | null): Promise<T> {
    return this.getPromise().finally(onfinally);
  }
}

export function isPendingOperation<T = unknown>(
  value: unknown
): value is PendingOperation<T> {
  return (
    value !== null &&
    typeof value === "object" &&
    PENDING_OPERATION_SYMBOL in value &&
    (value as Record<symbol, unknown>)[PENDING_OPERATION_SYMBOL] === true
  );
}

export type UnwrapPendingOperation<T> =
  T extends PendingOperation<infer U> ? U : T;

export type UnwrapPendingOperations<
  T extends readonly PendingOperation<unknown>[],
> = {
  [K in keyof T]: UnwrapPendingOperation<T[K]>;
};
