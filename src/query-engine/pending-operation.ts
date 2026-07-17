/**
 * Deferred operation lifecycle owned by the query engine.
 * Validation, SQL construction, and execution remain lazy until a lifecycle
 * method is called.
 */

import type { AnyDriver, QueryExecutionContext } from "@drivers";
import { PendingOperationError } from "@errors";
import type { Model } from "@schema/model";
import {
  createPendingOperationContext,
  type OperationExecutionContext,
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

  private constructor(
    engine: QueryEngine,
    model: Model<any>,
    requestedOperation: Operation | `${Operation}OrThrow`,
    args: Record<string, unknown>,
    options?: PrepareOptions,
    context?: OperationExecutionContext,
    deferredExecution?: DeferredExecution<T>
  ) {
    this.engine = engine;
    this.model = model;
    this.args = args;
    this.deferredExecution = deferredExecution;
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
    return this.runtime.execute(driverOverride);
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
    const prepared = await this.runtime.prepareBatch(targetDriver, context);
    return prepared;
  }

  parseResult(raw: { rows: unknown[]; rowCount: number }): T {
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
      deferredExecution
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
