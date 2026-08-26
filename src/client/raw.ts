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
import { transferPreparedStatement } from "@drivers/prepared-statement-provenance";
import {
  InvalidTransactionInputError,
  QueryError,
  VibORMErrorCode,
} from "@errors";
import { lookupResolvedExtensionHandlers } from "@extensions/chain";
import { observeOperation } from "@extensions/observation";
import {
  executePreparedQuery,
  type RawQueryKind,
  retainWriteOutcomeFailure,
  type WriteOutcomeNotifications,
} from "@extensions/query";
import type { InstrumentationContext } from "@instrumentation";
import {
  createOperationExecutionContext,
  createRawOperationInstrumentationFacts,
  observeTransactionBatchPhase,
} from "@query-engine/execution-context";
import { PendingExecution } from "@query-engine/pending-execution";
import type { QueryEngine } from "@query-engine/query-engine";
import { snapshotQueryInput } from "@query-engine/query-inspection";
import {
  registerTransactionOperationOwner,
  type TransactionOperation,
  type TransactionOperationOwner,
} from "@query-engine/transaction-operation";
import { isSql, Sql } from "@sql";

/** The four raw methods, spelled exactly as a caller types them. */
export type RawMethodName =
  | "$executeRaw"
  | "$executeRawUnsafe"
  | "$queryRaw"
  | "$queryRawUnsafe";

/** The exact runtime inventory used by client routing and extension lookup. */
export const RAW_METHOD_NAMES = Object.freeze({
  $executeRaw: true,
  $executeRawUnsafe: true,
  $queryRaw: true,
  $queryRawUnsafe: true,
} satisfies Readonly<Record<RawMethodName, true>>);

function rawQueryKind(method: RawMethodName): RawQueryKind {
  if (method === "$queryRaw") return "queryRaw";
  if (method === "$executeRaw") return "executeRaw";
  if (method === "$queryRawUnsafe") return "queryRawUnsafe";
  return "executeRawUnsafe";
}

/** The execute families are the only raw calls that publish write outcomes. */
function isRawWrite(method: RawMethodName): boolean {
  return method === "$executeRaw" || method === "$executeRawUnsafe";
}

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
export interface RawOperation<T> extends Promise<T> {}

const rawOperationConstruction = Object.freeze({});

type CreateDeferredRawOperation = <T>(
  engine: QueryEngine,
  method: RawMethodName,
  captured: CapturedRawQuery,
  parse: (raw: QueryResult<RawRow<T>>) => T,
  warnLegacyString: LegacyRawWarner
) => DeferredRawOperation<T>;

let createDeferredRawOperation: CreateDeferredRawOperation;

let rawTransactionOwner: TransactionOperationOwner<
  DeferredRawOperation<unknown>
>;

class DeferredRawOperation<T>
  implements RawOperation<T>, TransactionOperation<T>
{
  readonly [Symbol.toStringTag] = "Promise";

  readonly #engine: QueryEngine;
  readonly #execution: PendingExecution<T>;
  readonly #context: QueryExecutionContext;
  readonly #method: RawMethodName;
  readonly #captured: CapturedRawQuery;
  readonly #parse: (raw: QueryResult<RawRow<T>>) => T;
  readonly #warnLegacyString: LegacyRawWarner;
  #resolved: ResolvedRawQuery | undefined;
  #observationCommitCertainty: "committed" | "may-have-committed" | undefined;

  static {
    createDeferredRawOperation = <T>(
      engine: QueryEngine,
      method: RawMethodName,
      captured: CapturedRawQuery,
      parse: (raw: QueryResult<RawRow<T>>) => T,
      warnLegacyString: LegacyRawWarner
    ) =>
      new DeferredRawOperation<T>(
        rawOperationConstruction,
        engine,
        method,
        captured,
        parse,
        warnLegacyString
      );
    rawTransactionOwner = Object.freeze({
      clientId: (operation) => operation.#engine.clientId,
      scopeId: (operation) => operation.#engine.scopeId,
      model: () => "$raw",
      operation: (operation) => operation.#method,
      context: (operation) => operation.#context,
      requiresInterception: (operation) => {
        const handlers = lookupResolvedExtensionHandlers(
          operation.#engine.extensionChain,
          "query",
          undefined,
          operation.#method
        );
        return handlers !== undefined && handlers.length > 0;
      },
      prepareAdmission: (operation) => {
        operation.#resolve();
      },
      stagePackageWriteOutcomes: () => undefined,
      startInterception: (operation, child, outcomes, control) => {
        const handlers = lookupResolvedExtensionHandlers(
          operation.#engine.extensionChain,
          "query",
          undefined,
          operation.#method
        );
        if (handlers === undefined || handlers.length === 0) return child();
        const query = operation.#resolve();
        const inspectionInput =
          query.kind === "fragment"
            ? { query: query.query }
            : { sql: query.sql, params: [...query.params] };
        const queryContext = Object.freeze({
          mode: "array" as const,
          kind: rawQueryKind(operation.#method),
          model: undefined,
          operation: operation.#method,
          input: snapshotQueryInput(inspectionInput),
        });
        return executePreparedQuery<unknown, Record<string, unknown>>(
          queryContext,
          handlers,
          child,
          isRawWrite(operation.#method),
          outcomes,
          control
        );
      },
      executeCore: (operation, driver, notifications) =>
        operation.#execution.executeReserved(() =>
          operation.#runResolved(driver, operation.#resolve(), notifications)
        ),
      isWrite: (operation) => isRawWrite(operation.#method),
      hasObservation: (operation) =>
        (operation.#engine.extensionChain?.observe.length ?? 0) > 0,
      observe: (operation, child, readCompletionFacts) => {
        const observers = operation.#engine.extensionChain?.observe;
        if (observers === undefined || observers.length === 0) return child();
        return observeOperation(
          observers,
          operation.#method,
          undefined,
          child,
          readCompletionFacts,
          operation.#readInstrumentationFacts()
        );
      },
      reserveWith: (operation, driver) => {
        operation.#execution.reserveWith(driver);
      },
      executeWith: (operation, driver) => {
        const execute = () =>
          operation.#runResolved(driver, operation.#resolve());
        const observers = operation.#engine.extensionChain?.observe;
        if (observers === undefined || observers.length === 0) {
          return operation.#execution.executeWith(driver, execute);
        }
        return operation.#execution.executeWith(driver, () =>
          observeOperation(
            observers,
            operation.#method,
            undefined,
            execute,
            () =>
              operation.#observationCommitCertainty === undefined
                ? undefined
                : {
                    commitCertainty: operation.#observationCommitCertainty,
                  },
            operation.#readInstrumentationFacts()
          )
        );
      },
      prepare: (operation, driver = operation.#engine.driver) => {
        const query = operation.#resolve();
        if (query.kind === "verbatim") {
          return markVerbatimBatchQuery({
            sql: query.sql,
            params: [...query.params],
            context: operation.#context,
          });
        }
        const prepared = driver._prepare(query.query, operation.#context);
        return transferPreparedStatement(prepared, {
          sql: prepared.sql,
          params: prepared.params ? [...prepared.params] : [],
          context: operation.#context,
        });
      },
      prepareBatch: async () => undefined,
      parseResult: (operation, raw) => operation.#parse(raw),
      observeBatchPhase: (operation, driver, execute) =>
        observeTransactionBatchPhase(operation.#context, driver, execute),
    } satisfies TransactionOperationOwner<DeferredRawOperation<unknown>>);
    registerTransactionOperationOwner(
      DeferredRawOperation.prototype,
      (value): value is DeferredRawOperation<unknown> => #engine in value,
      rawTransactionOwner
    );
    Object.freeze(DeferredRawOperation.prototype);
  }

  private constructor(
    construction: typeof rawOperationConstruction,
    engine: QueryEngine,
    method: RawMethodName,
    captured: CapturedRawQuery,
    parse: (raw: QueryResult<RawRow<T>>) => T,
    warnLegacyString: LegacyRawWarner
  ) {
    if (construction !== rawOperationConstruction) {
      throw new InvalidTransactionInputError();
    }
    this.#engine = engine;
    this.#method = method;
    this.#captured = captured;
    this.#parse = parse;
    this.#warnLegacyString = warnLegacyString;
    this.#execution = new PendingExecution<T>("$raw", method);
    this.#context = createOperationExecutionContext(
      "$raw",
      method,
      engine.instrumentation,
      engine.extensionChain
    );
    Object.freeze(this);
  }

  #resolve(): ResolvedRawQuery {
    if (this.#resolved) return this.#resolved;

    const { query, values } = this.#captured;
    if (this.#captured.family === "unsafe") {
      if (typeof query !== "string") throw invalidRawQueryError(this.#method);
      this.#resolved = {
        kind: "verbatim",
        sql: query,
        params: [...values],
      };
      return this.#resolved;
    }

    if (isTemplateStringsArray(query)) {
      this.#resolved = {
        kind: "fragment",
        query: new Sql(query, values),
      };
      return this.#resolved;
    }
    if (isSql(query)) {
      if (values.length > 0) throw fragmentWithValuesError(this.#method);
      this.#resolved = { kind: "fragment", query };
      return this.#resolved;
    }
    if (typeof query === "string") {
      this.#warnLegacyString(this.#method);
      this.#resolved = {
        kind: "verbatim",
        sql: query,
        params: legacyParams(values),
      };
      return this.#resolved;
    }
    throw invalidRawQueryError(this.#method);
  }

  #run(driver: AnyDriver): Promise<T> {
    const handlers = lookupResolvedExtensionHandlers(
      this.#engine.extensionChain,
      "query",
      undefined,
      this.#method
    );
    if (handlers === undefined || handlers.length === 0) {
      return this.#runResolved(
        driver,
        this.#resolve(),
        this.#withObservationNotifications()
      );
    }
    let query: ResolvedRawQuery;
    try {
      query = this.#resolve();
    } catch (error) {
      return Promise.reject(error);
    }
    const inspectionInput =
      query.kind === "fragment"
        ? { query: query.query }
        : { sql: query.sql, params: [...query.params] };
    const context = Object.freeze({
      mode: this.#engine.transactionWriteOutcomes ? "transaction" : "direct",
      kind: rawQueryKind(this.#method),
      model: undefined,
      operation: this.#method,
      input: snapshotQueryInput(inspectionInput),
    });
    return executePreparedQuery<T, Record<string, unknown>>(
      context,
      handlers,
      (notifications) =>
        this.#runResolved(
          driver,
          query,
          this.#withObservationNotifications(notifications)
        ),
      isRawWrite(this.#method),
      this.#engine.transactionWriteOutcomes
    );
  }

  async #runResolved(
    driver: AnyDriver,
    query: ResolvedRawQuery,
    notifications?: WriteOutcomeNotifications
  ): Promise<T> {
    const writeNotifications = isRawWrite(this.#method)
      ? notifications
      : undefined;
    let raw: QueryResult<RawRow<T>>;
    try {
      raw =
        query.kind === "fragment"
          ? await driver._execute<RawRow<T>>(query.query, this.#context)
          : await driver._executeRaw<RawRow<T>>(
              query.sql,
              [...query.params],
              this.#context
            );
    } catch (error) {
      try {
        await writeNotifications?.mayHaveCommitted();
      } catch (outcomeFailure) {
        throw retainWriteOutcomeFailure(error, outcomeFailure);
      }
      throw error;
    }

    let parseOutcome:
      | { readonly status: "success"; readonly value: T }
      | { readonly status: "failure"; readonly error: unknown };
    try {
      parseOutcome = { status: "success", value: this.#parse(raw) };
    } catch (error) {
      parseOutcome = { status: "failure", error };
    }
    try {
      await writeNotifications?.committed();
    } catch (outcomeFailure) {
      if (parseOutcome.status === "failure") {
        throw retainWriteOutcomeFailure(parseOutcome.error, outcomeFailure);
      }
      throw outcomeFailure;
    }
    if (parseOutcome.status === "failure") throw parseOutcome.error;
    return parseOutcome.value;
  }

  #getPromise(): Promise<T> {
    return this.#execution.executeDefault(() => {
      const observers = this.#engine.extensionChain?.observe;
      if (observers === undefined || observers.length === 0) {
        return this.#run(this.#engine.driver);
      }
      return observeOperation(
        observers,
        this.#method,
        undefined,
        () => this.#run(this.#engine.driver),
        () =>
          this.#observationCommitCertainty === undefined
            ? undefined
            : { commitCertainty: this.#observationCommitCertainty },
        this.#readInstrumentationFacts()
      );
    });
  }

  #readInstrumentationFacts() {
    return createRawOperationInstrumentationFacts(
      this.#engine.driver,
      this.#context,
      this.#method
    );
  }

  #withObservationNotifications(
    notifications?: WriteOutcomeNotifications
  ): WriteOutcomeNotifications | undefined {
    if (
      this.#engine.transactionWriteOutcomes !== undefined ||
      (this.#engine.extensionChain?.observe.length ?? 0) === 0
    ) {
      return notifications;
    }
    const publish = async (
      certainty: "committed" | "may-have-committed",
      notify: (() => Promise<void>) | undefined
    ): Promise<void> => {
      let notificationFailed = false;
      let notificationFailure: unknown;
      try {
        await notify?.();
      } catch (error) {
        notificationFailed = true;
        notificationFailure = error;
      }
      if (
        certainty === "committed" ||
        this.#observationCommitCertainty === undefined
      ) {
        this.#observationCommitCertainty = certainty;
      }
      if (notificationFailed) throw notificationFailure;
    };
    return Object.freeze({
      committed: () => publish("committed", notifications?.committed),
      mayHaveCommitted: () =>
        publish("may-have-committed", notifications?.mayHaveCommitted),
    });
  }

  then<TResult1 = T, TResult2 = never>(
    onfulfilled?: ((value: T) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null
  ): Promise<TResult1 | TResult2> {
    return this.#getPromise().then(onfulfilled, onrejected);
  }

  catch<TResult = never>(
    onrejected?: ((reason: unknown) => TResult | PromiseLike<TResult>) | null
  ): Promise<T | TResult> {
    return this.#getPromise().catch(onrejected);
  }

  finally(onfinally?: (() => void) | null): Promise<T> {
    return this.#getPromise().finally(onfinally);
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
    return createDeferredRawOperation<T[]>(
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
    return createDeferredRawOperation<T[]>(
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
    return createDeferredRawOperation<number>(
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
    return createDeferredRawOperation<number>(
      engine,
      "$executeRawUnsafe",
      { family: "unsafe", query, values: captureValues(values) },
      (raw) => raw.rowCount,
      warnLegacyString
    );
  }

  return { $executeRaw, $executeRawUnsafe, $queryRaw, $queryRawUnsafe };
}
