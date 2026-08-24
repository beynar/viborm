/**
 * Raw SQL client surface — Prisma-shaped, safe by construction.
 *
 * Four methods, two families:
 *
 * - `$queryRaw` / `$executeRaw` are TAGGED TEMPLATES. Every interpolation
 *   becomes a bound parameter rendered in the driver's own placeholder style
 *   ($1, ?, :1), so a value can never reach the statement as text. They also
 *   accept a prebuilt `Sql` fragment (`sql`/`join`/`empty`/`raw`).
 * - `$queryRawUnsafe` / `$executeRawUnsafe` take a hand-written statement
 *   string plus positional parameters. The caller owns the escaping.
 *
 * `$queryRaw*` answers the ROWS (`T[]`); `$executeRaw*` answers the AFFECTED
 * COUNT (`number`) — Prisma's split, not a `QueryResult` envelope.
 *
 * The plain-string first argument on `$queryRaw`/`$executeRaw` is the
 * deprecated pre-tagged-template shape. It still runs, unchanged, for one
 * release, and announces itself once per method on the `warning` log channel.
 */

import type { AnyDriver, QueryExecutionContext, QueryResult } from "@drivers";
import { markVerbatimBatchQuery } from "@drivers/driver-batch-query-kind";
import { QueryError, VibORMErrorCode } from "@errors";
import type { InstrumentationContext } from "@instrumentation";
import {
  createOperationExecutionContext,
  observeTransactionBatchPhase,
} from "@query-engine/execution-context";
import { PendingExecution } from "@query-engine/pending-execution";
import type { QueryEngine } from "@query-engine/query-engine";
import {
  TRANSACTION_OPERATION_SYMBOL,
  type TransactionOperation,
} from "@query-engine/transaction-operation";
import type { PreparedQuery } from "@query-engine/types";
import { isSql, Sql } from "@sql";

/** The four raw methods, spelled exactly as a caller types them. */
export type RawMethodName =
  | "$executeRaw"
  | "$executeRawUnsafe"
  | "$queryRaw"
  | "$queryRawUnsafe";

/** What a safe raw call accepts as its first argument. */
export type RawQueryInput = Sql | TemplateStringsArray;

/**
 * The raw surface, on the client and on an interactive transaction client.
 */
export interface RawSurface {
  /**
   * Run a SELECT and get the rows. Interpolations are bound parameters.
   *
   * @example
   * ```ts
   * const rows = await client.$queryRaw<{ id: string }>`
   *   SELECT id FROM "user" WHERE age >= ${18}
   * `;
   * ```
   */
  $queryRaw<T = unknown>(
    query: RawQueryInput,
    ...values: unknown[]
  ): RawOperation<T[]>;
  /**
   * @deprecated Pass a tagged template (values are bound) or call
   * `$queryRawUnsafe(sql, ...params)` for a hand-written statement. The string
   * form is removed in the next release.
   */
  $queryRaw<T = unknown>(query: string, params?: unknown[]): RawOperation<T[]>;
  /**
   * Run a hand-written SELECT string with positional parameters. The statement
   * text is used verbatim — never build it from user input.
   */
  $queryRawUnsafe<T = unknown>(
    query: string,
    ...values: unknown[]
  ): RawOperation<T[]>;
  /**
   * Run a statement and get the affected row count. Interpolations are bound
   * parameters.
   */
  $executeRaw(query: RawQueryInput, ...values: unknown[]): RawOperation<number>;
  /**
   * @deprecated Pass a tagged template (values are bound) or call
   * `$executeRawUnsafe(sql, ...params)` for a hand-written statement. The
   * string form is removed in the next release.
   */
  $executeRaw(query: string, params?: unknown[]): RawOperation<number>;
  /**
   * Run a hand-written statement string with positional parameters. The
   * statement text is used verbatim — never build it from user input.
   */
  $executeRawUnsafe(query: string, ...values: unknown[]): RawOperation<number>;
}

/** Emitted once per method, the first time the legacy string form is used. */
export type LegacyRawWarner = (method: RawMethodName) => void;

export interface RawSurfaceOptions {
  /** The engine owns both the target driver and transaction-operation scope. */
  engine: QueryEngine;
  warnLegacyString: LegacyRawWarner;
}

function isTemplateStringsArray(value: unknown): value is TemplateStringsArray {
  // A tagged template hands its callee the cooked strings array carrying a
  // `raw` sibling array — the one shape a plain string or Sql never has.
  return Array.isArray(value) && Array.isArray(Reflect.get(value, "raw"));
}

/**
 * The deprecated `(sql, params?)` shape passed its parameters as ONE array.
 * That spelling is preserved exactly: a single array argument is the parameter
 * list, anything else is read positionally.
 */
function legacyParams(values: readonly unknown[]): unknown[] {
  if (values.length === 0) return [];
  const [first] = values;
  if (values.length === 1 && Array.isArray(first)) return [...first];
  return [...values];
}

function invalidRawQueryError(method: RawMethodName): QueryError {
  return new QueryError(
    `${method} expects a tagged template (${method}\`SELECT ...\`) or an Sql fragment built with sql\`...\`. Received a value that is neither.`,
    {
      code: VibORMErrorCode.INVALID_INPUT,
      meta: { method },
    }
  );
}

function fragmentWithValuesError(method: RawMethodName): QueryError {
  return new QueryError(
    `${method} received an Sql fragment together with extra values. The fragment already carries its parameters — interpolate them into it instead.`,
    {
      code: VibORMErrorCode.INVALID_INPUT,
      meta: { method },
    }
  );
}

/**
 * Build the once-per-method deprecation notice sink for one client.
 *
 * Nothing is emitted unless the `warning` log channel is configured — this is
 * an observation, and it never alters what the query does.
 */
export function createLegacyRawWarner(
  instrumentation: InstrumentationContext | undefined
): LegacyRawWarner {
  const announced = new Set<RawMethodName>();
  return (method) => {
    if (announced.has(method)) return;
    announced.add(method);
    instrumentation?.logger?.warn({
      timestamp: new Date(),
      model: "$raw",
      operation: method,
      meta: {
        deprecation: `${method}(sql: string, params?) is deprecated and is removed in the next release. Use ${method}\`...\` so values are bound, or ${method}Unsafe(sql, ...params) to keep a hand-written statement.`,
      },
    });
  };
}

type CapturedRawQuery =
  | {
      readonly family: "safe";
      readonly query: RawQueryInput | string;
      readonly values: readonly unknown[];
    }
  | {
      readonly family: "unsafe";
      readonly query: unknown;
      readonly values: readonly unknown[];
    };

type ResolvedRawQuery =
  | { readonly kind: "fragment"; readonly query: Sql }
  | {
      readonly kind: "verbatim";
      readonly sql: string;
      readonly params: readonly unknown[];
    };

type RawRow<T> = T extends (infer Row)[] ? Row : unknown;

function captureValues(values: readonly unknown[]): readonly unknown[] {
  if (values.length === 1 && Array.isArray(values[0])) {
    return Object.freeze([[...values[0]]]);
  }
  return Object.freeze([...values]);
}

/** A lazy raw statement that remains assignable to `Promise<T>`. */
export interface RawOperation<T> extends Promise<T> {
  readonly [TRANSACTION_OPERATION_SYMBOL]: true;
}

class DeferredRawOperation<T>
  implements RawOperation<T>, TransactionOperation<T>
{
  readonly [TRANSACTION_OPERATION_SYMBOL] = true;
  readonly [Symbol.toStringTag] = "Promise";

  private readonly execution: PendingExecution<T>;
  private readonly context: QueryExecutionContext;
  private readonly engine: QueryEngine;
  private readonly method: RawMethodName;
  private readonly captured: CapturedRawQuery;
  private readonly parse: (raw: QueryResult<RawRow<T>>) => T;
  private readonly warnLegacyString: LegacyRawWarner;
  private resolved: ResolvedRawQuery | undefined;

  constructor(
    engine: QueryEngine,
    method: RawMethodName,
    captured: CapturedRawQuery,
    parse: (raw: QueryResult<RawRow<T>>) => T,
    warnLegacyString: LegacyRawWarner
  ) {
    this.engine = engine;
    this.method = method;
    this.captured = captured;
    this.parse = parse;
    this.warnLegacyString = warnLegacyString;
    this.execution = new PendingExecution<T>("$raw", method);
    this.context = createOperationExecutionContext(
      "$raw",
      method,
      engine.instrumentation
    );
  }

  private resolve(): ResolvedRawQuery {
    if (this.resolved) return this.resolved;

    const { query, values } = this.captured;
    if (this.captured.family === "unsafe") {
      if (typeof query !== "string") throw invalidRawQueryError(this.method);
      this.resolved = {
        kind: "verbatim",
        sql: query,
        params: [...values],
      };
      return this.resolved;
    }

    if (isTemplateStringsArray(query)) {
      this.resolved = {
        kind: "fragment",
        query: new Sql(query, values),
      };
      return this.resolved;
    }
    if (isSql(query)) {
      if (values.length > 0) throw fragmentWithValuesError(this.method);
      this.resolved = { kind: "fragment", query };
      return this.resolved;
    }
    if (typeof query === "string") {
      this.warnLegacyString(this.method);
      this.resolved = {
        kind: "verbatim",
        sql: query,
        params: legacyParams(values),
      };
      return this.resolved;
    }
    throw invalidRawQueryError(this.method);
  }

  private async run(driver: AnyDriver): Promise<T> {
    const query = this.resolve();
    const raw =
      query.kind === "fragment"
        ? await driver._execute<RawRow<T>>(query.query, this.context)
        : await driver._executeRaw<RawRow<T>>(
            query.sql,
            [...query.params],
            this.context
          );
    return this.parse(raw);
  }

  private getPromise(): Promise<T> {
    return this.execution.executeDefault(() => this.run(this.engine.driver));
  }

  reserveWith(driver: AnyDriver): void {
    this.execution.reserveWith(driver);
  }

  executeWith(driver: AnyDriver): Promise<T> {
    return this.execution.executeWith(driver, () => this.run(driver));
  }

  prepare(driver: AnyDriver = this.engine.driver): PreparedQuery {
    const query = this.resolve();
    if (query.kind === "verbatim") {
      return markVerbatimBatchQuery({
        sql: query.sql,
        params: [...query.params],
        context: this.context,
      });
    }
    const prepared = driver._prepare(query.query);
    return {
      sql: prepared.sql,
      params: prepared.params ? [...prepared.params] : [],
      context: this.context,
    };
  }

  parseResult(raw: QueryResult<RawRow<T>>): T {
    return this.parse(raw);
  }

  observeBatchPhase<R>(
    driver: AnyDriver,
    execute: () => R | Promise<R>
  ): Promise<R> {
    return observeTransactionBatchPhase(this, driver, execute);
  }

  getModel(): string {
    return "$raw";
  }

  getOperation(): string {
    return this.method;
  }

  getExecutionContext(): QueryExecutionContext {
    return this.context;
  }

  getClientId(): symbol {
    return this.engine.clientId;
  }

  getScopeId(): symbol {
    return this.engine.scopeId;
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

/**
 * Build the four raw methods bound to one query-engine scope.
 *
 * Inside an interactive transaction the engine carries the transaction-bound
 * driver and scope identity, so raw and model operations share both ownership
 * checks and execution.
 */
export function createRawSurface(options: RawSurfaceOptions): RawSurface {
  const { engine, warnLegacyString } = options;

  function $queryRaw<T = unknown>(
    query: RawQueryInput,
    ...values: unknown[]
  ): RawOperation<T[]>;
  function $queryRaw<T = unknown>(
    query: string,
    params?: unknown[]
  ): RawOperation<T[]>;
  function $queryRaw<T = unknown>(
    query: RawQueryInput | string,
    ...values: unknown[]
  ): RawOperation<T[]> {
    return new DeferredRawOperation<T[]>(
      engine,
      "$queryRaw",
      { family: "safe", query, values: captureValues(values) },
      (raw) => raw.rows,
      warnLegacyString
    );
  }

  function $queryRawUnsafe<T = unknown>(
    query: string,
    ...values: unknown[]
  ): RawOperation<T[]> {
    return new DeferredRawOperation<T[]>(
      engine,
      "$queryRawUnsafe",
      { family: "unsafe", query, values: captureValues(values) },
      (raw) => raw.rows,
      warnLegacyString
    );
  }

  function $executeRaw(
    query: RawQueryInput,
    ...values: unknown[]
  ): RawOperation<number>;
  function $executeRaw(query: string, params?: unknown[]): RawOperation<number>;
  function $executeRaw(
    query: RawQueryInput | string,
    ...values: unknown[]
  ): RawOperation<number> {
    return new DeferredRawOperation<number>(
      engine,
      "$executeRaw",
      { family: "safe", query, values: captureValues(values) },
      (raw) => raw.rowCount,
      warnLegacyString
    );
  }

  function $executeRawUnsafe(
    query: string,
    ...values: unknown[]
  ): RawOperation<number> {
    return new DeferredRawOperation<number>(
      engine,
      "$executeRawUnsafe",
      { family: "unsafe", query, values: captureValues(values) },
      (raw) => raw.rowCount,
      warnLegacyString
    );
  }

  return { $executeRaw, $executeRawUnsafe, $queryRaw, $queryRawUnsafe };
}
