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

import type { AnyDriver, QueryResult } from "@drivers";
import {
  QueryError,
  UnsupportedOperationError,
  VibORMErrorCode,
} from "@errors";
import type { InstrumentationContext } from "@instrumentation";
import { createOperationExecutionContext } from "@query-engine/execution-context";
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
  ): Promise<T[]>;
  /**
   * @deprecated Pass a tagged template (values are bound) or call
   * `$queryRawUnsafe(sql, ...params)` for a hand-written statement. The string
   * form is removed in the next release.
   */
  $queryRaw<T = unknown>(query: string, params?: unknown[]): Promise<T[]>;
  /**
   * Run a hand-written SELECT string with positional parameters. The statement
   * text is used verbatim — never build it from user input.
   */
  $queryRawUnsafe<T = unknown>(
    query: string,
    ...values: unknown[]
  ): Promise<T[]>;
  /**
   * Run a statement and get the affected row count. Interpolations are bound
   * parameters.
   */
  $executeRaw(query: RawQueryInput, ...values: unknown[]): Promise<number>;
  /**
   * @deprecated Pass a tagged template (values are bound) or call
   * `$executeRawUnsafe(sql, ...params)` for a hand-written statement. The
   * string form is removed in the next release.
   */
  $executeRaw(query: string, params?: unknown[]): Promise<number>;
  /**
   * Run a hand-written statement string with positional parameters. The
   * statement text is used verbatim — never build it from user input.
   */
  $executeRawUnsafe(query: string, ...values: unknown[]): Promise<number>;
}

/** Emitted once per method, the first time the legacy string form is used. */
export type LegacyRawWarner = (method: RawMethodName) => void;

export interface RawSurfaceOptions {
  /** The driver the statements run on — inside an open transaction, its tx-bound driver. */
  driver: AnyDriver;
  instrumentation: InstrumentationContext | undefined;
  warnLegacyString: LegacyRawWarner;
}

/**
 * Marks the promise a raw method returns. `$transaction([...])` reads it to
 * tell "you handed me a raw query" apart from "you handed me junk", and can
 * then say which one it is.
 */
const RAW_OPERATION = Symbol.for("viborm.rawOperation");

function tagRawOperation<T>(promise: Promise<T>): Promise<T> {
  Object.defineProperty(promise, RAW_OPERATION, {
    value: true,
    enumerable: false,
  });
  return promise;
}

/** True for the promise a `$queryRaw`/`$executeRaw` family method returned. */
export function isRawOperationPromise(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  return Reflect.get(value, RAW_OPERATION) === true;
}

/**
 * The typed refusal for a raw query handed to the array form of
 * `$transaction`. Raw statements execute the moment they are called, so there
 * is nothing left to defer into the batch — the interactive form is where raw
 * SQL joins a transaction.
 */
export function rawOperationInBatchError(): UnsupportedOperationError {
  return new UnsupportedOperationError(
    "$transaction([...]) cannot take a raw query: $queryRaw/$executeRaw run immediately and return a plain Promise, so there is no operation left to batch. Run raw SQL inside the interactive form instead: $transaction(async (tx) => { await tx.$executeRaw`...` }).",
    { meta: { method: "$transaction([...])" } }
  );
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

/**
 * Build the four raw methods bound to one driver.
 *
 * Inside an interactive transaction the driver is the transaction-bound one,
 * so raw statements travel the same single connection the model operations
 * use and roll back with them.
 */
export function createRawSurface(options: RawSurfaceOptions): RawSurface {
  const { driver, instrumentation, warnLegacyString } = options;

  const context = (method: RawMethodName) =>
    createOperationExecutionContext("$raw", method, instrumentation);

  const runSafe = <T>(
    method: RawMethodName,
    query: RawQueryInput | string,
    values: readonly unknown[]
  ): Promise<QueryResult<T>> => {
    if (isTemplateStringsArray(query)) {
      return driver._execute<T>(new Sql(query, values), context(method));
    }
    if (isSql(query)) {
      if (values.length > 0) throw fragmentWithValuesError(method);
      return driver._execute<T>(query, context(method));
    }
    if (typeof query === "string") {
      warnLegacyString(method);
      return driver._executeRaw<T>(
        query,
        legacyParams(values),
        context(method)
      );
    }
    throw invalidRawQueryError(method);
  };

  const runUnsafe = <T>(
    method: RawMethodName,
    query: string,
    values: readonly unknown[]
  ): Promise<QueryResult<T>> => {
    if (typeof query !== "string") throw invalidRawQueryError(method);
    return driver._executeRaw<T>(query, [...values], context(method));
  };

  // The thunk keeps execution eager — the driver is called in the same turn —
  // while an argument refusal still surfaces as a rejection, not a throw from
  // a function whose declared return type is a Promise.
  async function rowsOf<T>(run: () => Promise<QueryResult<T>>): Promise<T[]> {
    return (await run()).rows;
  }

  async function countOf(
    run: () => Promise<QueryResult<unknown>>
  ): Promise<number> {
    return (await run()).rowCount;
  }

  function $queryRaw<T = unknown>(
    query: RawQueryInput,
    ...values: unknown[]
  ): Promise<T[]>;
  function $queryRaw<T = unknown>(
    query: string,
    params?: unknown[]
  ): Promise<T[]>;
  function $queryRaw<T = unknown>(
    query: RawQueryInput | string,
    ...values: unknown[]
  ): Promise<T[]> {
    return tagRawOperation(
      rowsOf(() => runSafe<T>("$queryRaw", query, values))
    );
  }

  function $queryRawUnsafe<T = unknown>(
    query: string,
    ...values: unknown[]
  ): Promise<T[]> {
    return tagRawOperation(
      rowsOf(() => runUnsafe<T>("$queryRawUnsafe", query, values))
    );
  }

  function $executeRaw(
    query: RawQueryInput,
    ...values: unknown[]
  ): Promise<number>;
  function $executeRaw(query: string, params?: unknown[]): Promise<number>;
  function $executeRaw(
    query: RawQueryInput | string,
    ...values: unknown[]
  ): Promise<number> {
    return tagRawOperation(
      countOf(() => runSafe<unknown>("$executeRaw", query, values))
    );
  }

  function $executeRawUnsafe(
    query: string,
    ...values: unknown[]
  ): Promise<number> {
    return tagRawOperation(
      countOf(() => runUnsafe<unknown>("$executeRawUnsafe", query, values))
    );
  }

  return { $executeRaw, $executeRawUnsafe, $queryRaw, $queryRawUnsafe };
}
