/**
 * MySQL2 Driver
 *
 * Driver implementation for mysql2/promise with connection pooling.
 */

import { Buffer } from "node:buffer";
import type { DatabaseAdapter } from "@adapters/database-adapter";
import { MySQLAdapter } from "@adapters/databases/mysql/mysql-adapter";
import {
  createClientFromDriverConfig,
  type DriverConfig,
  type NoExtraDriverConfigKeys,
  type NoExtraNestedConfigKeys,
  type VibORMClient,
} from "@client/client";
import type { Schema } from "@client/types";
import { QueryError, TransactionError } from "@errors";
import type { Pool, PoolConnection, PoolOptions } from "mysql2/promise";
import { Driver, type QueryExecutionContext } from "../driver";
import {
  isNormalizedResultRow,
  type NormalizedResultContext,
  normalizeProviderInsertId,
  normalizeProviderRowCount,
} from "../normalized-result";
import {
  acquireWithMaxWait,
  type DriverTransactionOptions,
  isolationLevelStatement,
  nestedTransactionDispatchError,
  parseMySQLUrl,
  runTransactionLifecycle,
  type TransactionOptionSupport,
} from "../shared";
import type { QueryResult } from "../types";

// ============================================================
// EXPORTED OPTIONS
// ============================================================

export type MySQL2Options = PoolOptions;

export interface MySQL2DriverOptions {
  pool?: Pool;
  options?: PoolOptions;
  databaseUrl?: string;
}

export type MySQL2ClientConfig<C extends DriverConfig> = MySQL2DriverOptions &
  C;

// ============================================================
// DRIVER IMPLEMENTATION
// ============================================================

/** mysql2 escapes plain Uint8Array as an object — convert to Buffer for blobs. */
function convertValuesForMySQL(values: unknown[]): unknown[] {
  return values.map((v) =>
    v instanceof Uint8Array && !Buffer.isBuffer(v)
      ? Buffer.from(v.buffer, v.byteOffset, v.byteLength)
      : v
  );
}

function isMultiStatementFields(fields: unknown): boolean {
  return (
    Array.isArray(fields) &&
    fields.every(
      (fieldSet) => fieldSet === undefined || Array.isArray(fieldSet)
    )
  );
}

function malformedMySQL2Result(operation: string, reason: string): QueryError {
  return new QueryError(
    `Driver "mysql2" returned a malformed result for operation "${operation}": ${reason}.`,
    { meta: { driver: "mysql2", operation } }
  );
}

const CANONICAL_NEGATIVE_DECIMAL = /^-[1-9]\d*$/;

/** mysql2 echoes an explicit negative AUTO_INCREMENT key in ResultSetHeader.insertId. */
function normalizeMySQL2InsertId(
  value: unknown,
  context: NormalizedResultContext
): number | bigint | undefined {
  if (
    (typeof value === "number" && Number.isSafeInteger(value) && value < 0) ||
    (typeof value === "string" && CANONICAL_NEGATIVE_DECIMAL.test(value))
  ) {
    return undefined;
  }
  return normalizeProviderInsertId(value, context, { allowNumber: true });
}

/** SELECT returns a row array; mutations return a ResultSetHeader. */
function toQueryResult<T>(
  result: unknown,
  fields: unknown,
  operation: string
): QueryResult<T> {
  if (isMultiStatementFields(fields)) {
    throw new QueryError(
      `Driver "mysql2" returned multiple statement results for operation "${operation}"; VibORM requires exactly one statement result.`,
      { meta: { driver: "mysql2", operation } }
    );
  }

  if (Array.isArray(result)) {
    if (
      !Array.isArray(fields) ||
      fields.some((field) => !isNormalizedResultRow(field))
    ) {
      throw malformedMySQL2Result(
        operation,
        "row arrays require one flat field metadata array"
      );
    }
    return {
      rows: result as T[],
      rowCount: result.length,
    };
  }

  if (fields !== undefined) {
    throw malformedMySQL2Result(
      operation,
      "mutation results require undefined field metadata"
    );
  }
  if (!isNormalizedResultRow(result)) {
    throw malformedMySQL2Result(operation, "expected a mutation result object");
  }
  const context = { provider: "mysql2", operation };
  const insertId = normalizeMySQL2InsertId(result.insertId, context);
  return {
    rows: [] as T[],
    rowCount: normalizeProviderRowCount(result.affectedRows, context, {
      allowDecimalString: true,
    }),
    ...(insertId === undefined ? {} : { insertId }),
  };
}

export class MySQL2Driver extends Driver<Pool, PoolConnection> {
  readonly adapter: DatabaseAdapter = new MySQLAdapter();
  readonly maxBindParametersPerStatement: number | undefined = 65_535;

  private readonly driverOptions: MySQL2DriverOptions;

  constructor(options: MySQL2DriverOptions = {}) {
    super("mysql", "mysql2");
    if (options.options?.multipleStatements === true) {
      throw new QueryError(
        'Driver "mysql2" does not support options.multipleStatements=true because VibORM operations require one result per statement.',
        { meta: { driver: "mysql2", operation: "configuration" } }
      );
    }
    if (options.options?.rowsAsArray === true) {
      throw new QueryError(
        'Driver "mysql2" does not support options.rowsAsArray=true because VibORM requires row objects keyed by column name.',
        { meta: { driver: "mysql2", operation: "configuration" } }
      );
    }
    if (
      options.options?.nestTables === true ||
      typeof options.options?.nestTables === "string"
    ) {
      throw new QueryError(
        'Driver "mysql2" does not support enabled options.nestTables because VibORM requires flat row objects keyed by result aliases.',
        { meta: { driver: "mysql2", operation: "configuration" } }
      );
    }
    this.driverOptions = options;
    if (options.pool) {
      this.client = options.pool;
    }
  }

  protected async initClient(): Promise<Pool> {
    const mysql = await import("mysql2/promise");

    let options: PoolOptions = {
      // DATETIME is stored as naive UTC wall-clock; read it back as UTC
      // instead of shifting by the process timezone
      timezone: "Z",
      // BIGINT/DECIMAL values outside Number's safe range arrive as strings
      // (the result parser converts them losslessly) instead of lossy numbers
      supportBigNumbers: true,
      // DATE as plain "YYYY-MM-DD" — the result parser builds a UTC-midnight
      // Date, matching every other driver (mysql2 would build local midnight)
      dateStrings: ["DATE"],
      ...this.driverOptions.options,
    };

    // Parse databaseUrl if provided (same logic as createClient)
    if (this.driverOptions.databaseUrl) {
      options = {
        ...options,
        ...parseMySQLUrl(this.driverOptions.databaseUrl),
      };
    }

    return mysql.createPool(options);
  }

  protected async closeClient(pool: Pool): Promise<void> {
    await pool.end();
  }

  protected async execute<T>(
    client: Pool | PoolConnection,
    sql: string,
    params: unknown[],
    context?: QueryExecutionContext
  ): Promise<QueryResult<T>> {
    const operation = context?.operation ?? "execute";
    const [result, fields] = await client.execute(
      sql,
      convertValuesForMySQL(params)
    );
    return toQueryResult<T>(result, fields, operation);
  }

  protected async executeRaw<T>(
    client: Pool | PoolConnection,
    sql: string,
    params: unknown[] | undefined,
    context?: QueryExecutionContext
  ): Promise<QueryResult<T>> {
    const operation = context?.operation ?? "executeRaw";
    const [result, fields] = await client.query(
      sql,
      params && convertValuesForMySQL(params)
    );
    return toQueryResult<T>(result, fields, operation);
  }

  /**
   * MySQL rejects `SET TRANSACTION ISOLATION LEVEL` once a transaction is open
   * (ER_CANT_CHANGE_TX_CHARACTERISTICS), so the level must be set on the
   * transaction's own connection *before* BEGIN, where it applies to exactly
   * the next transaction on that session. mysql2 pools hand out a connection we
   * can wait for with a bound and release if we stop waiting.
   */
  protected override transactionOptionSupport(): TransactionOptionSupport {
    return {
      isolationLevel: "pre-begin",
      timeout: true,
      maxWait: "acquisition",
    };
  }

  protected async transaction<T>(
    client: Pool | PoolConnection,
    fn: (tx: PoolConnection) => Promise<T>,
    _context?: QueryExecutionContext,
    options?: DriverTransactionOptions
  ): Promise<T> {
    if (!("getConnection" in client)) {
      throw nestedTransactionDispatchError(this.driverName);
    }

    // Start a new transaction from pool
    const pool = client as Pool;
    const connection = await acquireWithMaxWait(
      () => pool.getConnection(),
      (acquired) => acquired.release(),
      options?.maxWaitMs,
      { driverName: this.driverName, form: "callback" }
    );
    let shouldDestroy = false;
    const runOrDestroy = async (operation: () => Promise<void>) => {
      try {
        await operation();
      } catch (error) {
        shouldDestroy = true;
        throw error;
      }
    };
    const isolationLevel = options?.isolationLevel;
    return runTransactionLifecycle({
      begin: () =>
        runOrDestroy(async () => {
          // Session-scoped-next-transaction: this statement must land before
          // beginTransaction() to bind to the transaction it opens.
          if (isolationLevel) {
            await connection.query(isolationLevelStatement(isolationLevel));
          }
          await connection.beginTransaction();
        }),
      callback: () => fn(connection),
      commit: () => runOrDestroy(() => connection.commit()),
      rollback: () => runOrDestroy(() => connection.rollback()),
      close: () => {
        try {
          if (shouldDestroy) {
            connection.destroy();
            return;
          }
          connection.release();
        } catch (error) {
          super.transactionCleanupFailed(
            new TransactionError(
              'Driver "mysql2" could not release an unsafe transaction connection.',
              { meta: { driver: "mysql2", method: "$transaction" } }
            )
          );
          throw error;
        }
      },
    });
  }

  protected override transactionCleanupFailed(_error: Error): void {
    // A connection with failed cleanup is destroyed; the pool remains usable.
  }
}

// ============================================================
// CONVENIENCE FUNCTION
// ============================================================

export function createClient<S extends Schema, C extends DriverConfig<S>>(
  config: MySQL2ClientConfig<C> &
    DriverConfig<S> &
    NoExtraDriverConfigKeys<C, MySQL2DriverOptions, S> &
    NoExtraNestedConfigKeys<C, S>
): VibORMClient<C & { driver: MySQL2Driver }> {
  const { pool, options = {}, databaseUrl, ...restConfig } = config;

  if (databaseUrl) {
    Object.assign(options, parseMySQLUrl(databaseUrl));
  }

  const driver = new MySQL2Driver({
    pool,
    options,
  });

  return createClientFromDriverConfig({
    ...restConfig,
    driver,
  }) as VibORMClient<C & { driver: MySQL2Driver }>;
}
