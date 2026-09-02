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
 */

import type { AnyDriver, QueryExecutionContext, QueryResult } from "@drivers";
import { markVerbatimBatchQuery } from "@drivers/driver-batch-query-kind";
import { transferPreparedStatement } from "@drivers/prepared-statement-provenance";
import { validateRawParameters } from "@drivers/provider-parameter-snapshot";
import {
  InvalidTransactionInputError,
  QueryError,
  VibORMErrorCode,
} from "@errors";
import {
  lookupResolvedExtensionHandlers,
  type ResolvedExtensionHandler,
} from "@extensions/chain";
import { observeOperation } from "@extensions/observation";
import {
  executePreparedQuery,
  type RawQueryKind,
  retainWriteOutcomeFailure,
  type WriteOutcomeNotifications,
} from "@extensions/query";
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
   * Run a hand-written statement string with positional parameters. The
   * statement text is used verbatim — never build it from user input.
   */
  $executeRawUnsafe(query: string, ...values: unknown[]): RawOperation<number>;
}

export interface RawSurfaceOptions {
  /** The engine owns both the target driver and transaction-operation scope. */
  engine: QueryEngine;
}

function isTemplateStringsArray(value: unknown): value is TemplateStringsArray {
  // A tagged template hands its callee the cooked strings array carrying a
  // `raw` sibling array — the one shape a plain string or Sql never has.
  return Array.isArray(value) && Array.isArray(Reflect.get(value, "raw"));
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

function invalidRawDateError(
  method: RawMethodName,
  parameterIndex: number
): QueryError {
  return new QueryError(
    `${method} received an invalid Date as bound parameter ${parameterIndex}. An invalid Date names no instant, so a provider either refuses the statement after dispatch or binds it as null.`,
    {
      code: VibORMErrorCode.INVALID_INPUT,
      meta: { method, parameterIndex },
    }
  );
}

function unsupportedRawArrayError(
  method: RawMethodName,
  parameterIndex: number
): QueryError {
  return new QueryError(
    `${method} received raw array parameter ${parameterIndex} with custom inherited or accessor behavior. VibORM cannot validate that behavior without invoking caller code before dispatch.`,
    {
      code: VibORMErrorCode.INVALID_INPUT,
      meta: { method, parameterIndex },
    }
  );
}

function hasOwnIndex(values: readonly unknown[], index: number): boolean {
  return Object.hasOwn(values, index);
}

function copyIndexedValues(values: readonly unknown[]): unknown[] {
  const copy = new Array<unknown>(values.length);
  for (let index = 0; index < values.length; index += 1) {
    if (hasOwnIndex(values, index)) copy[index] = values[index];
  }
  return copy;
}

function copySqlStrings(strings: readonly string[]): string[] {
  const copy = new Array<string>(strings.length);
  for (let index = 0; index < strings.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(strings, index);
    if (
      descriptor === undefined ||
      !("value" in descriptor) ||
      typeof descriptor.value !== "string"
    ) {
      throw new TypeError("Sql fragment strings must be plain string values");
    }
    copy[index] = descriptor.value;
  }
  return copy;
}

function createOperationSql(query: Sql): Sql {
  return new Sql(
    copySqlStrings(query.strings),
    copyIndexedValues(query.values)
  );
}

function validateRawParametersBeforeInterception(
  method: RawMethodName,
  params: readonly unknown[]
): void {
  validateRawParameters(params, {
    invalidDate: (parameterIndex) =>
      invalidRawDateError(method, parameterIndex),
    unsupportedArray: (parameterIndex) =>
      unsupportedRawArrayError(method, parameterIndex),
  });
}

type CapturedRawQuery =
  | {
      readonly family: "safe";
      readonly query: RawQueryInput;
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
  return Object.freeze(copyIndexedValues(values));
}

/**
 * The nominal marker that separates a raw operation from a bare promise. It is
 * `declare`d, so it exists only in the type system: nothing is added to the
 * value at runtime and the packed public surface gains no export.
 */
declare const RAW_OPERATION: unique symbol;

/**
 * A lazy raw statement that remains assignable to `Promise<T>`.
 *
 * The brand is load-bearing. Without it this interface is STRUCTURALLY
 * identical to `Promise<T>`, so `$transaction([Promise.resolve(1)])`
 * typechecked and then threw `InvalidTransactionInputError` at runtime: an
 * array member has to be an object the transaction-operation owner registry
 * recognises (`readTransactionOperation`), which a bare promise is not. The
 * type now refuses what the implementation refuses.
 */
export interface RawOperation<T> extends Promise<T> {
  readonly [RAW_OPERATION]: true;
}

const rawOperationConstruction = Object.freeze({});

type CreateDeferredRawOperation = <T>(
  engine: QueryEngine,
  method: RawMethodName,
  captured: CapturedRawQuery,
  parse: (raw: QueryResult<RawRow<T>>) => T
) => DeferredRawOperation<T>;

let createDeferredRawOperation: CreateDeferredRawOperation;

let rawTransactionOwner: TransactionOperationOwner<
  DeferredRawOperation<unknown>
>;

class DeferredRawOperation<T>
  implements RawOperation<T>, TransactionOperation<T>
{
  // Type-only: the brand has no runtime representation, and the registry - not
  // this field - is what authenticates an array member.
  declare readonly [RAW_OPERATION]: true;

  readonly [Symbol.toStringTag] = "Promise";

  readonly #engine: QueryEngine;
  readonly #execution: PendingExecution<T>;
  readonly #context: QueryExecutionContext;
  readonly #method: RawMethodName;
  readonly #captured: CapturedRawQuery;
  readonly #parse: (raw: QueryResult<RawRow<T>>) => T;
  readonly #queryHandlers: readonly ResolvedExtensionHandler[] | undefined;
  #resolved: ResolvedRawQuery | undefined;
  #observationCommitCertainty: "committed" | "may-have-committed" | undefined;

  static {
    createDeferredRawOperation = <T>(
      engine: QueryEngine,
      method: RawMethodName,
      captured: CapturedRawQuery,
      parse: (raw: QueryResult<RawRow<T>>) => T
    ) =>
      new DeferredRawOperation<T>(
        rawOperationConstruction,
        engine,
        method,
        captured,
        parse
      );
    rawTransactionOwner = Object.freeze({
      clientId: (operation) => operation.#engine.clientId,
      scopeId: (operation) => operation.#engine.scopeId,
      model: () => "$raw",
      operation: (operation) => operation.#method,
      context: (operation) => operation.#context,
      requiresInterception: (operation) =>
        operation.#queryHandlers !== undefined &&
        operation.#queryHandlers.length > 0,
      prepareAdmission: (operation) => {
        operation.#resolve();
      },
      stagePackageWriteOutcomes: () => undefined,
      startInterception: (operation, child, outcomes, control) => {
        const handlers = operation.#queryHandlers;
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
    parse: (raw: QueryResult<RawRow<T>>) => T
  ) {
    if (construction !== rawOperationConstruction) {
      throw new InvalidTransactionInputError();
    }
    this.#engine = engine;
    this.#method = method;
    this.#captured = captured;
    this.#parse = parse;
    this.#queryHandlers = lookupResolvedExtensionHandlers(
      engine.extensionChain,
      "query",
      undefined,
      method
    );
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

    // Refusing before memoizing keeps a rejected statement rejected however
    // many times admission, interception, and execution ask for it.
    const resolved = this.#resolveQuery();
    validateRawParametersBeforeInterception(
      this.#method,
      resolved.kind === "fragment" ? resolved.query.values : resolved.params
    );
    this.#resolved = resolved;
    return resolved;
  }

  #resolveQuery(): ResolvedRawQuery {
    const { query, values } = this.#captured;
    if (this.#captured.family === "unsafe") {
      if (typeof query !== "string") throw invalidRawQueryError(this.#method);
      return { kind: "verbatim", sql: query, params: [...values] };
    }

    if (isTemplateStringsArray(query)) {
      return { kind: "fragment", query: new Sql(query, values) };
    }
    if (isSql(query)) {
      if (values.length > 0) throw fragmentWithValuesError(this.#method);
      return { kind: "fragment", query: createOperationSql(query) };
    }
    throw invalidRawQueryError(this.#method);
  }

  #run(driver: AnyDriver): Promise<T> {
    const handlers = this.#queryHandlers;
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
  const { engine } = options;

  function $queryRaw<T = unknown>(
    query: RawQueryInput,
    ...values: unknown[]
  ): RawOperation<T[]>;
  function $queryRaw<T = unknown>(
    query: RawQueryInput,
    ...values: unknown[]
  ): RawOperation<T[]> {
    return createDeferredRawOperation<T[]>(
      engine,
      "$queryRaw",
      { family: "safe", query, values: captureValues(values) },
      (raw) => raw.rows
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
      (raw) => raw.rows
    );
  }

  function $executeRaw(
    query: RawQueryInput,
    ...values: unknown[]
  ): RawOperation<number>;
  function $executeRaw(
    query: RawQueryInput,
    ...values: unknown[]
  ): RawOperation<number> {
    return createDeferredRawOperation<number>(
      engine,
      "$executeRaw",
      { family: "safe", query, values: captureValues(values) },
      (raw) => raw.rowCount
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
      (raw) => raw.rowCount
    );
  }

  return { $executeRaw, $executeRawUnsafe, $queryRaw, $queryRawUnsafe };
}
