/**
 * Cloudflare D1 Driver (Bindings)
 *
 * Driver implementation for Cloudflare D1 using Worker bindings.
 * Note: D1 does not support true transactions - batch() provides atomicity only.
 */

import type { DatabaseAdapter } from "@adapters/database-adapter";
import { SQLiteAdapter } from "@adapters/databases/sqlite/sqlite-adapter";
import {
  createClient as baseCreateClient,
  type DriverConfig,
  type VibORMClient,
} from "@client/client";
import type { D1Database } from "@cloudflare/workers-types";
import { QueryError } from "@errors";
import {
  Driver,
  type DriverResultParser,
  type QueryExecutionContext,
} from "../driver";
import { isNormalizedResultRow } from "../normalized-result";
import {
  classifySQLiteStatementResult,
  convertValuesForSQLite,
  sqliteResultParser,
  type TransactionOptionSupport,
  unsupportedCallbackTransactionError,
} from "../shared";
import type { BatchQuery, QueryResult } from "../types";

// ============================================================
// EXPORTED OPTIONS
// ============================================================

export interface D1DriverOptions {
  database: D1Database;
}

export type D1ClientConfig<C extends DriverConfig> = D1DriverOptions & C;

interface D1BindingResult<T> {
  success: true;
  results: T[] | null;
  meta: { changes: number };
}

const ROW_PRODUCING_OPERATIONS = new Set([
  "aggregate",
  "count",
  "create",
  "createManyAndReturn",
  "delete",
  "deleteManyAndReturn",
  "exist",
  "findFirst",
  "findMany",
  "findUnique",
  "groupBy",
  "update",
  "updateManyAndReturn",
  "upsert",
]);

function malformedD1Result(
  context: QueryExecutionContext,
  reason: string
): QueryError {
  const operation = context.operation ?? "execute";
  return new QueryError(
    `Driver "d1" returned a malformed result payload for operation "${operation}": ${reason}.`,
    { meta: { driver: "d1", ...context, operation } }
  );
}

function assertD1BindingResult<T>(
  result: unknown,
  context: QueryExecutionContext
): asserts result is D1BindingResult<T> {
  if (
    !isNormalizedResultRow(result) ||
    result.success !== true ||
    (result.results !== null &&
      !(
        Array.isArray(result.results) &&
        result.results.every(isNormalizedResultRow)
      )) ||
    !isNormalizedResultRow(result.meta) ||
    typeof result.meta.changes !== "number" ||
    !Number.isFinite(result.meta.changes) ||
    !Number.isSafeInteger(result.meta.changes) ||
    result.meta.changes < 0
  ) {
    throw malformedD1Result(
      context,
      "expected explicit object rows (or null) and non-negative changes metadata"
    );
  }
}

function normalizeD1Result<T>(
  result: unknown,
  sql: string,
  context: QueryExecutionContext,
  enforceOperationContract: boolean
): QueryResult<T> {
  const operation = context.operation ?? "execute";
  assertD1BindingResult<T>(result, context);
  let rows: T[];
  if (result.results === null) {
    const operationRequiresRows =
      enforceOperationContract && ROW_PRODUCING_OPERATIONS.has(operation);
    if (
      operationRequiresRows ||
      classifySQLiteStatementResult(sql) !== "no-rows"
    ) {
      throw malformedD1Result(
        context,
        "null results are not valid for a row-producing or unknown statement"
      );
    }
    rows = [];
  } else {
    rows = result.results;
  }
  return {
    rows,
    rowCount: result.meta.changes === 0 ? rows.length : result.meta.changes,
  };
}

// ============================================================
// DRIVER IMPLEMENTATION
// ============================================================

export class D1Driver extends Driver<D1Database, D1Database> {
  readonly adapter: DatabaseAdapter = new SQLiteAdapter();
  readonly result: DriverResultParser = sqliteResultParser;
  readonly supportsTransactions = false;
  readonly supportsBatch = true;

  private readonly driverOptions: D1DriverOptions;

  constructor(options: D1DriverOptions) {
    super("sqlite", "d1");
    this.driverOptions = options;
    // D1 database is passed directly from Worker environment
    this.client = options.database;
  }

  protected async initClient(): Promise<D1Database> {
    // D1 database binding is passed in constructor
    return this.driverOptions.database;
  }

  protected async closeClient(_db: D1Database): Promise<void> {
    // D1 bindings don't need to be closed
  }

  protected async execute<T>(
    client: D1Database,
    sql: string,
    params: unknown[],
    context?: QueryExecutionContext
  ): Promise<QueryResult<T>> {
    return this.executeStatement<T>(
      client,
      sql,
      params,
      context ?? { operation: "execute" }
    );
  }

  private async executeStatement<T>(
    client: D1Database,
    sql: string,
    params: unknown[],
    context: QueryExecutionContext
  ): Promise<QueryResult<T>> {
    const values = convertValuesForSQLite(params);
    const stmt = client.prepare(sql).bind(...values);
    const result: unknown = await stmt.run<T>();
    return normalizeD1Result<T>(result, sql, context, true);
  }

  protected async executeRaw<T>(
    client: D1Database,
    sql: string,
    params: unknown[] | undefined,
    context?: QueryExecutionContext
  ): Promise<QueryResult<T>> {
    return this.executeStatement<T>(
      client,
      sql,
      params ?? [],
      context ?? { operation: "executeRaw" }
    );
  }

  /**
   * D1 bindings expose `batch()` and no callback transaction. There is no
   * BEGIN to configure, no interactive body to time out, and no slot to wait
   * for — every option is refused rather than quietly dropped.
   */
  protected override transactionOptionSupport(): TransactionOptionSupport {
    return {
      isolationLevel: "unsupported",
      isolationLevelReason:
        "D1 bindings execute batches through batch(), which opens no transaction VibORM can set an isolation level on",
      timeout: false,
      timeoutReason:
        "D1 bindings run a batch as one provider call with no interactive body to interrupt",
      maxWait: "unsupported",
      maxWaitReason:
        "D1 bindings submit the batch immediately with no connection to acquire",
    };
  }

  protected transaction<T>(
    _client: D1Database,
    _fn: (tx: D1Database) => Promise<T>
  ): Promise<T> {
    return Promise.reject(unsupportedCallbackTransactionError(this.driverName));
  }

  /**
   * Execute multiple queries atomically using D1's native batch() API.
   * All queries succeed or all fail together.
   */
  protected async executeBatch<T>(
    client: D1Database,
    queries: BatchQuery[],
    context?: QueryExecutionContext
  ): Promise<QueryResult<T>[]> {
    const batchContext = context ?? { operation: "executeBatch" };
    const statements: ReturnType<D1Database["prepare"]>[] = [];
    for (const query of queries) {
      const statementContext = query.context ?? batchContext;
      try {
        const values = query.params ? convertValuesForSQLite(query.params) : [];
        statements.push(client.prepare(query.sql).bind(...values));
      } catch (error) {
        throw this.normalizeExecutionError(
          error,
          query.sql,
          this.getBatchDiagnosticParameters(query),
          statementContext
        );
      }
    }

    // Execute all statements atomically
    const results: unknown = await client.batch<T>(statements);

    if (!Array.isArray(results) || results.length !== queries.length) {
      const actualResultCount = Array.isArray(results) ? results.length : 0;
      throw malformedD1Result(
        batchContext,
        `expected ${queries.length} statement results but received ${actualResultCount}`
      );
    }

    const normalized: QueryResult<T>[] = [];
    for (let index = 0; index < results.length; index += 1) {
      const query = queries[index];
      if (!query) {
        throw malformedD1Result(
          batchContext,
          `missing statement metadata at batch result index ${index}`
        );
      }
      normalized.push(
        normalizeD1Result<T>(
          results[index],
          query.sql,
          query.context ?? batchContext,
          false
        )
      );
    }
    return normalized;
  }
}

// ============================================================
// CONVENIENCE FUNCTION
// ============================================================

export function createClient<C extends DriverConfig>(
  config: D1ClientConfig<C>
) {
  const { database, ...restConfig } = config;

  const driver = new D1Driver({ database });

  return baseCreateClient({
    ...restConfig,
    driver,
  }) as VibORMClient<C & { driver: D1Driver }>;
}
