/**
 * Neon HTTP Driver
 *
 * Driver implementation for @neondatabase/serverless - Neon's HTTP-based PostgreSQL driver.
 *
 * Note: Neon's HTTP API uses non-interactive transactions. This means:
 * - Batch transactions ($transaction([...])) work via executeBatch
 * - Callback transactions ($transaction(async (tx) => {...})) are NOT supported
 *   because Neon HTTP requires all queries to be submitted at once
 */

import type { DatabaseAdapter } from "@adapters/database-adapter";
import { PostgresAdapter } from "@adapters/databases/postgres/postgres-adapter";
import {
  createClient as baseCreateClient,
  type DriverConfig,
  type VibORMClient,
} from "@client/client";
import { QueryError, unsupportedGeospatial, unsupportedVector } from "@errors";
import type {
  NeonQueryFunction,
  NeonQueryFunctionInTransaction,
} from "@neondatabase/serverless";
import { Driver, type QueryExecutionContext } from "../driver";
import { isNormalizedResultRow } from "../normalized-result";
import {
  normalizePostgresRowCount,
  type TransactionOptionSupport,
  unsupportedCallbackTransactionError,
} from "../shared";
import type { BatchQuery, QueryResult } from "../types";

// ============================================================
// EXPORTED OPTIONS
// ============================================================

export interface NeonHTTPDriverOptions {
  databaseUrl?: string;
  options?: {
    fetchOptions?: RequestInit;
  };
  pgvector?: boolean;
  postgis?: boolean;
}

export type NeonHTTPClientConfig<C extends DriverConfig> =
  NeonHTTPDriverOptions & C;

// ============================================================
// TYPE DECLARATIONS
// ============================================================

/**
 * NeonQuery is the main query function returned by neon().
 * Configured with arrayMode=false (object rows) and fullResults=true (includes rowCount).
 */
type NeonQuery = NeonQueryFunction<false, true>;

/**
 * NeonTx is the transaction-bound query function passed to transaction callbacks.
 * Configured with arrayMode=false and fullResults=true to match the main client.
 */
type NeonTx = NeonQueryFunctionInTransaction<false, true>;

interface NeonFullResult<T> {
  fields: unknown[];
  command: string;
  rowCount: number | null;
  rows: T[];
  rowAsArray: false;
}

function malformedNeonResult(
  context: QueryExecutionContext,
  reason: string
): QueryError {
  const operation = context.operation ?? "execute";
  return new QueryError(
    `Driver "neon-http" returned a malformed result payload for operation "${operation}": ${reason}.`,
    { meta: { driver: "neon-http", ...context, operation } }
  );
}

function assertNeonFullResult<T>(
  result: unknown,
  context: QueryExecutionContext
): asserts result is NeonFullResult<T> {
  if (
    !(isNormalizedResultRow(result) && Array.isArray(result.fields)) ||
    typeof result.command !== "string" ||
    !Object.hasOwn(result, "rowCount") ||
    (result.rowCount !== null &&
      (typeof result.rowCount !== "number" ||
        !Number.isFinite(result.rowCount) ||
        !Number.isSafeInteger(result.rowCount) ||
        result.rowCount < 0)) ||
    !Array.isArray(result.rows) ||
    !result.rows.every(isNormalizedResultRow) ||
    result.rowAsArray !== false
  ) {
    throw malformedNeonResult(
      context,
      "expected fullResults object with object rows and explicit rowCount"
    );
  }
}

// ============================================================
// DRIVER IMPLEMENTATION
// ============================================================

/**
 * Type guard to check if client is NeonQuery (has transaction method)
 * vs NeonTx (transaction callback that only accepts sql + params)
 */
function isNeonQueryFunction(client: NeonQuery | NeonTx): client is NeonQuery {
  return typeof (client as NeonQuery).transaction === "function";
}

export class NeonHTTPDriver extends Driver<NeonQuery, NeonTx> {
  readonly adapter: DatabaseAdapter;

  // Neon HTTP only supports non-interactive (batch) transactions
  // Callback-style transactions are not supported
  readonly supportsTransactions = false;
  readonly supportsBatch = true;

  private readonly driverOptions: NeonHTTPDriverOptions;

  constructor(options: NeonHTTPDriverOptions = {}) {
    super("postgresql", "neon-http");
    this.driverOptions = options;

    const adapter = new PostgresAdapter();
    adapter.capabilities.supportsVector = options.pgvector === true;
    if (!options.pgvector) adapter.vector = unsupportedVector;
    if (!options.postgis) adapter.geospatial = unsupportedGeospatial;
    this.adapter = adapter;
  }

  protected async initClient(): Promise<NeonQuery> {
    const { neon, types } = await import("@neondatabase/serverless");

    if (!this.driverOptions.databaseUrl) {
      throw new Error("Neon HTTP driver requires a databaseUrl");
    }

    // DATE (1082) / TIMESTAMP WITHOUT TIME ZONE (1114): the default parsers
    // build process-local Dates, shifting the stored value by the process
    // timezone. Return raw strings — the shared result parser builds UTC
    // Dates from them, matching every other driver.
    const identityParser = (value: string) => value;
    // pg-types declares getTypeParser with per-format overloads that a single
    // wrapper function can't express — the cast is unavoidable here
    const getTypeParser = ((oid: number, format?: string) => {
      if ((oid === 1082 || oid === 1114) && format !== "binary") {
        return identityParser;
      }
      return types.getTypeParser(oid as never, format as never);
    }) as typeof types.getTypeParser;
    const utcSafeTypes: typeof types = { ...types, getTypeParser };

    // Always use arrayMode=false (object rows) and fullResults=true (includes rowCount)
    const client = neon(this.driverOptions.databaseUrl, {
      fetchOptions: this.driverOptions.options?.fetchOptions,
      fullResults: true,
      arrayMode: false,
      types: utcSafeTypes,
    });

    return client;
  }

  protected async closeClient(_client: NeonQuery): Promise<void> {
    // HTTP client doesn't need to be closed
  }

  protected async execute<T>(
    client: NeonQuery | NeonTx,
    sql: string,
    params: unknown[],
    context?: QueryExecutionContext
  ): Promise<QueryResult<T>> {
    return this.executeQuery<T>(client, sql, params, context, "execute");
  }

  private async executeQuery<T>(
    client: NeonQuery | NeonTx,
    sql: string,
    params: unknown[],
    context: QueryExecutionContext | undefined,
    fallbackOperation: string
  ): Promise<QueryResult<T>> {
    const executionContext = context ?? { operation: fallbackOperation };
    // NeonQuery supports options, NeonTx only accepts (sql, params)
    const result = isNeonQueryFunction(client)
      ? await client(sql, params, { arrayMode: false, fullResults: true })
      : await client(sql, params);

    return this.parseResult<T>(result, executionContext);
  }

  protected async executeRaw<T>(
    client: NeonQuery | NeonTx,
    sql: string,
    params: unknown[] | undefined,
    context?: QueryExecutionContext
  ): Promise<QueryResult<T>> {
    return this.executeQuery<T>(
      client,
      sql,
      params ?? [],
      context,
      "executeRaw"
    );
  }

  /**
   * Neon HTTP sends the whole batch as one request through `client.transaction`
   * and offers no callback transaction. The provider opens and closes that
   * transaction server-side in a single round trip: VibORM has no BEGIN to
   * configure, no interactive body to interrupt, and no slot to wait for, so
   * every option is refused rather than quietly dropped.
   */
  protected override transactionOptionSupport(): TransactionOptionSupport {
    return {
      isolationLevel: "unsupported",
      isolationLevelReason:
        "Neon HTTP submits the batch as one request and never exposes a transaction VibORM can issue SET TRANSACTION ISOLATION LEVEL on",
      timeout: false,
      timeoutReason:
        "Neon HTTP runs a batch as one provider call with no interactive body to interrupt",
      maxWait: "unsupported",
      maxWaitReason:
        "Neon HTTP submits the batch immediately with no connection to acquire",
    };
  }

  protected transaction<T>(
    _client: NeonQuery | NeonTx,
    _fn: (tx: NeonTx) => Promise<T>
  ): Promise<T> {
    return Promise.reject(unsupportedCallbackTransactionError(this.driverName));
  }

  /**
   * Execute multiple queries atomically using Neon's transaction() function.
   * This provides atomic batch execution with full PostgreSQL transaction semantics.
   */
  protected async executeBatch<T>(
    client: NeonQuery,
    queries: BatchQuery[],
    context?: QueryExecutionContext
  ): Promise<QueryResult<T>[]> {
    const batchContext = context ?? { operation: "executeBatch" };
    // Use Neon's transaction function with a callback that returns query array
    const results: unknown = await client.transaction((txFn) =>
      queries.map((query) => {
        const statementContext = query.context ?? batchContext;
        try {
          return txFn(query.sql, query.params ?? []);
        } catch (error) {
          throw this.normalizeExecutionError(
            error,
            query.sql,
            this.getBatchDiagnosticParameters(query),
            statementContext
          );
        }
      })
    );

    if (!Array.isArray(results) || results.length !== queries.length) {
      const actualResultCount = Array.isArray(results) ? results.length : 0;
      throw malformedNeonResult(
        batchContext,
        `expected ${queries.length} statement results but received ${actualResultCount}`
      );
    }

    return results.map((result, index) =>
      this.parseResult<T>(result, queries[index]?.context ?? batchContext)
    );
  }

  /**
   * Parse Neon result into QueryResult format.
   */
  private parseResult<T>(
    result: unknown,
    context: QueryExecutionContext
  ): QueryResult<T> {
    const operation = context.operation ?? "execute";
    assertNeonFullResult<T>(result, context);
    return {
      rows: result.rows,
      rowCount: normalizePostgresRowCount(
        result.rowCount,
        result.command,
        result.rows,
        {
          provider: "neon-http",
          operation,
          model: context.model,
          correlationId: context.correlationId,
        }
      ),
    };
  }
}

// ============================================================
// CONVENIENCE FUNCTION
// ============================================================

export function createClient<C extends DriverConfig>(
  config: NeonHTTPClientConfig<C>
) {
  const { databaseUrl, options, pgvector, postgis, ...restConfig } = config;

  const driver = new NeonHTTPDriver({
    databaseUrl,
    options,
    pgvector,
    postgis,
  });

  return baseCreateClient({
    ...restConfig,
    driver,
  }) as VibORMClient<C & { driver: NeonHTTPDriver }>;
}
