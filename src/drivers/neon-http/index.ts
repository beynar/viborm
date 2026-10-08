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
  createClientFromDriverConfig,
  type DriverConfig,
  type NoExtraDriverConfigKeys,
  type VibORMClient,
} from "@client/client";
import type { Schema } from "@client/types";
import {
  ClientInitializationError,
  QueryError,
  unsupportedVector,
} from "@errors";
import type {
  CustomTypesConfig,
  NeonQueryFunction,
} from "@neondatabase/serverless";
import { Driver, type QueryExecutionContext } from "../driver";
import { isNormalizedResultRow } from "../normalized-result";
import {
  type BatchTransactionOptions,
  defineImmutableDriverFact,
  normalizePostgresRowCount,
  resolveNamespaceOption,
  type TransactionOptionSupport,
  unsupportedCallbackTransactionError,
} from "../shared";
import type {
  BatchQuery,
  CommittedBatchNotification,
  QueryResult,
} from "../types";

// ============================================================
// EXPORTED OPTIONS
// ============================================================

export interface NeonHTTPDriverOptions {
  databaseUrl?: string;
  options?: {
    fetchOptions?: RequestInit;
    authToken?: string | (() => Promise<string> | string);
  };
  pgvector?: boolean;
  postgis?: boolean;
  /** The PostgreSQL schema this driver's persistent objects live in. Defaults to `public`. */
  namespace?: string;
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

export class NeonHTTPDriver extends Driver<NeonQuery, NeonQuery> {
  declare readonly adapter: DatabaseAdapter;
  readonly maxBindParametersPerStatement: number | undefined = 65_535;

  // Neon HTTP only supports non-interactive (batch) transactions
  // Callback-style transactions are not supported
  readonly supportsTransactions = false;
  readonly supportsBatch = true;

  // Hosted rollback, durable visibility and malformed post-commit metadata
  // witnesses qualify this notification before driver result validation.
  readonly supportsOrderedCommittedSegments = true;

  private readonly driverOptions: NeonHTTPDriverOptions;
  private queryTypes: CustomTypesConfig | undefined;

  constructor(options: NeonHTTPDriverOptions = {}) {
    super("postgresql", "neon-http");
    const namespace = resolveNamespaceOption(options);
    this.driverOptions = options;

    const adapter = new PostgresAdapter(namespace, options.postgis === true);
    adapter.capabilities.supportsVector = options.pgvector === true;
    if (!options.pgvector) adapter.vector = unsupportedVector;
    defineImmutableDriverFact(this, "adapter", adapter);
  }

  protected async initClient(): Promise<NeonQuery> {
    const { neon, types } = await import("@neondatabase/serverless");

    if (!this.driverOptions.databaseUrl) {
      throw new ClientInitializationError(
        "Neon HTTP driver requires a databaseUrl",
        { meta: { driver: this.driverName } }
      );
    }

    // DATE (1082) / TIMESTAMP WITHOUT TIME ZONE (1114): the default parsers
    // build process-local Dates, shifting the stored value by the process
    // timezone. Return raw strings — the shared result parser builds UTC
    // Dates from them, matching every other driver.
    const identityParser = (value: string) => value;
    // pg-types declares getTypeParser with per-format overloads that a single
    // wrapper function can't express — the cast is unavoidable here
    const getTypeParser = ((oid: number, format?: string) => {
      if (
        [1082, 1114, 1184, 1115, 1182, 1185].includes(oid) &&
        format !== "binary"
      ) {
        return identityParser;
      }
      return types.getTypeParser(oid as never, format as never);
    }) as typeof types.getTypeParser;
    this.queryTypes = { getTypeParser };

    // Always use arrayMode=false (object rows) and fullResults=true (includes rowCount)
    const client = neon(this.driverOptions.databaseUrl, {
      fetchOptions: this.driverOptions.options?.fetchOptions,
      authToken: this.driverOptions.options?.authToken,
      fullResults: true,
      arrayMode: false,
    });

    return client;
  }

  protected async closeClient(_client: NeonQuery): Promise<void> {
    // HTTP client doesn't need to be closed
  }

  protected async execute<T>(
    client: NeonQuery,
    sql: string,
    params: unknown[],
    context?: QueryExecutionContext
  ): Promise<QueryResult<T>> {
    return this.executeQuery<T>(client, sql, params, context, "execute");
  }

  private async executeQuery<T>(
    client: NeonQuery,
    sql: string,
    params: unknown[],
    context: QueryExecutionContext | undefined,
    fallbackOperation: string
  ): Promise<QueryResult<T>> {
    const executionContext = context ?? { operation: fallbackOperation };
    const result = await client.query(sql, params, {
      arrayMode: false,
      fullResults: true,
      types: this.queryTypes,
    });

    return this.parseResult<T>(result, executionContext);
  }

  protected async executeRaw<T>(
    client: NeonQuery,
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
   * transaction server-side in a single round trip. The SDK receives the
   * requested isolation level; timeout/maxWait need an interactive body or
   * acquired connection, which this HTTP transport does not have.
   */
  protected override transactionOptionSupport(): TransactionOptionSupport {
    return {
      isolationLevel: "provider",
      timeout: false,
      timeoutReason:
        "Neon HTTP runs a batch as one provider call with no interactive body to interrupt",
      maxWait: "unsupported",
      maxWaitReason:
        "Neon HTTP submits the batch immediately with no connection to acquire",
    };
  }

  protected transaction<T>(
    _client: NeonQuery,
    _fn: (tx: NeonQuery) => Promise<T>
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
    context?: QueryExecutionContext,
    committed?: CommittedBatchNotification,
    options?: BatchTransactionOptions
  ): Promise<QueryResult<T>[]> {
    const batchContext = context ?? { operation: "executeBatch" };
    // Query promises retain their own parser options in the public SDK API.
    const results: unknown = await client.transaction(
      queries.map((query) => {
        const statementContext = query.context ?? batchContext;
        try {
          return client.query(query.sql, query.params ?? [], {
            types: this.queryTypes,
          });
        } catch (error) {
          throw this.normalizeStatementFailure(
            error,
            query.sql,
            this.getBatchDiagnosticParameters(query),
            statementContext,
            true
          );
        }
      }),
      {
        isolationLevel: options?.isolationLevel,
        arrayMode: false,
        fullResults: true,
      }
    );
    await committed?.();

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

export function createClient<S extends Schema, C extends DriverConfig<S>>(
  config: NeonHTTPClientConfig<C> &
    DriverConfig<S> &
    NoExtraDriverConfigKeys<C, NeonHTTPDriverOptions, S>
): VibORMClient<C & { driver: NeonHTTPDriver }> {
  const { databaseUrl, options, pgvector, postgis } = config;
  const namespace = resolveNamespaceOption(config);

  const driver = new NeonHTTPDriver({
    databaseUrl,
    options,
    pgvector,
    postgis,
    namespace,
  });

  return createClientFromDriverConfig(config, driver) as VibORMClient<
    C & { driver: NeonHTTPDriver }
  >;
}
