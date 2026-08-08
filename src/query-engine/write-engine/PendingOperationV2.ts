// biome-ignore-all lint/style/useFilenamingConvention: PendingOperationV2 is the architecture name.
import type { AnyDriver, QueryExecutionContext, QueryResult } from "@drivers";
import type { Sql } from "@sql";
import type { QueryEngine } from "../query-engine";
import type { PreparedQuery } from "../types";
import type { ExecutableOperation } from "./OperationExecutor";
import { OperationExecutor } from "./OperationExecutor";

/**
 * A focused wrapper proving the callback-transaction, caching, and
 * `$transaction([...])` batch seams over any {@link ExecutableOperation}. The
 * public `PendingOperation` owns client routing and uses the same
 * operation-to-executor contract; this class remains a contract-test fixture.
 */
export class PendingOperationV2<T> {
  private readonly engine: QueryEngine;
  private readonly operation: ExecutableOperation;
  private readonly context: QueryExecutionContext;
  private readonly executor: OperationExecutor;

  constructor(
    engine: QueryEngine,
    operation: ExecutableOperation,
    context: QueryExecutionContext
  ) {
    this.engine = engine;
    this.operation = operation;
    this.context = context;
    this.executor = new OperationExecutor(engine);
  }

  /**
   * Run the operation and return its parsed result. A `driverOverride` is the
   * callback-transaction seam: the operation runs linearly on the caller's
   * already-transactional driver instead of opening a second envelope.
   */
  execute(driverOverride?: AnyDriver): Promise<T> {
    return this.executor.execute<T>(
      this.operation,
      this.context,
      driverOverride
    );
  }

  /** Callback-transaction alias: execute on a caller-provided tx-bound driver. */
  executeWith(driver: AnyDriver): Promise<T> {
    return this.execute(driver);
  }

  /**
   * The cache flow's single-statement seam. A composed nested write is never a
   * single statement, so — exactly as V1 — this returns `undefined`, and the
   * caller falls back to {@link execute}.
   */
  prepare(): PreparedQuery | undefined {
    return undefined;
  }

  /**
   * Return this operation's atomic-batch entries plus a `parseResult` closure,
   * consumable by the shared batch protocol (the array-`$transaction` path).
   * It does not execute them.
   */
  async prepareBatch(driver?: AnyDriver): Promise<{
    readonly queries: readonly Sql[];
    parseResult(results: readonly QueryResult<unknown>[]): T;
  }> {
    return this.executor.prepareBatch<T>(
      this.operation,
      driver ?? this.engine.driver,
      this.context
    );
  }

  /**
   * Parse a single terminal read result into the public shape (the cache-flow
   * seam's counterpart to {@link prepare}). The composed operation exposes its
   * result under the `result` output.
   */
  parseResult(raw: { rows: unknown[]; rowCount: number }): T {
    return this.operation.parse<T>({ result: raw.rows });
  }
}
