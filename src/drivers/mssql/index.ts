/**
 * SQL Server Driver
 *
 * Driver implementation for `mssql` (tedious) with connection pooling, for
 * SQL Server 2022 and later and Azure SQL.
 */

import { Buffer } from "node:buffer";
import type { DatabaseAdapter } from "@adapters/database-adapter";
import { MssqlAdapter } from "@adapters/databases/mssql/mssql-adapter";
import {
  createClientFromDriverConfig,
  type DriverConfig,
  type LinkedClientConfig,
  type NoExtraDriverConfigKeys,
  type VibORMClient,
} from "@client/client";
import type { Schema } from "@client/types";
import { ClientInitializationError, QueryError } from "@errors";
import type { Sql } from "@sql";
import type {
  config as MssqlConfig,
  ConnectionPool,
  IResult,
  Request,
  Transaction,
} from "mssql";
import {
  Driver,
  type QueryExecutionContext,
  TransactionBoundDriver,
} from "../driver";
import { getExecutionTransactionPhases } from "../execution-context";
import {
  normalizeProviderInsertId,
  normalizeProviderRowCount,
} from "../normalized-result";
import {
  type DriverTransactionOptions,
  defineImmutableDriverFact,
  nestedTransactionDispatchError,
  resolveNamespaceOption,
  runTransactionLifecycle,
  type TransactionIsolationLevel,
  type TransactionOptionSupport,
} from "../shared";
import { refuseUnknownDriverConfigKeys } from "../shared/driver-options";
import type { QueryResult } from "../types";
import { normalizeMssqlError } from "./errors";

export type MssqlOptions = MssqlConfig;

export interface MssqlDriverOptions {
  /** A caller-owned, connected or unconnected `mssql` pool. */
  pool?: ConnectionPool;
  /** `mssql` pool configuration, over what `databaseUrl` names. */
  options?: Partial<MssqlConfig>;
  /**
   * `mssql://user:password@host:port/database` (or `sqlserver://`). Query
   * parameters `encrypt` and `trustServerCertificate` take `true`/`false`.
   */
  databaseUrl?: string;
  /** The SQL Server schema VibORM's tables live in: `dbo` by default. */
  namespace?: string;
}

export type MssqlClientConfig<C extends DriverConfig> = MssqlDriverOptions & C;

const MSSQL_CONFIG_KEYS: Record<keyof MssqlDriverOptions, true> = {
  pool: true,
  options: true,
  databaseUrl: true,
  namespace: true,
};

/**
 * SQL Server binds at most 2,100 parameters per request, and a parameterized
 * statement travels as `sp_executesql`, whose statement text and parameter
 * declaration are two of them.
 */
const MAX_BOUND_PARAMETERS = 2098;

const INSERT_ID_COLUMN = "__viborm_insert_id";

/**
 * An `INSERT`, alone or after its `WITH`: the statement whose identity value
 * the engine may need. `SCOPE_IDENTITY()` is exact for it only inside the same
 * request (one `sp_executesql` is one scope), so it is read there.
 */
const INSERT_STATEMENT = /^\s*(?:WITH\b[\s\S]*\)\s*)?INSERT\b/i;

/**
 * The shared savepoint protocol (`runSavepoint`), in T-SQL: `SAVE TRANSACTION`
 * and `ROLLBACK TRANSACTION`, with no release (a savepoint lives until its
 * transaction ends). A savepoint name is at most 32 characters.
 */
const SAVEPOINT_STATEMENT =
  /^(SAVEPOINT|ROLLBACK TO SAVEPOINT|RELEASE SAVEPOINT) sp_([0-9a-f]{32})$/;

function savepointStatement(sql: string): string | null | undefined {
  const match = SAVEPOINT_STATEMENT.exec(sql);
  if (!match) return undefined;
  const name = `s${match[2]!.slice(1)}`;
  if (match[1] === "SAVEPOINT") return `SAVE TRANSACTION ${name}`;
  if (match[1] === "ROLLBACK TO SAVEPOINT")
    return `ROLLBACK TRANSACTION ${name}`;
  return null;
}

const ISOLATION_LEVELS: Record<TransactionIsolationLevel, string> = {
  ReadUncommitted: "READ_UNCOMMITTED",
  ReadCommitted: "READ_COMMITTED",
  RepeatableRead: "REPEATABLE_READ",
  Serializable: "SERIALIZABLE",
};

/** `mssql://user:password@host:port/database?encrypt=false` as pool options. */
function parseMssqlUrl(databaseUrl: string): Partial<MssqlConfig> {
  let url: URL;
  try {
    url = new URL(databaseUrl);
  } catch {
    throw new ClientInitializationError(
      'Driver "mssql" could not parse its databaseUrl.'
    );
  }
  if (url.protocol !== "mssql:" && url.protocol !== "sqlserver:")
    throw new ClientInitializationError(
      'Driver "mssql" needs a databaseUrl starting with mssql:// or sqlserver://.'
    );
  const flag = (name: string): boolean | undefined => {
    const value = url.searchParams.get(name);
    return value === null ? undefined : value === "true";
  };
  const encrypt = flag("encrypt");
  const trustServerCertificate = flag("trustServerCertificate");
  const database = decodeURIComponent(url.pathname.replace(/^\//, ""));
  return {
    server: url.hostname,
    ...(url.port ? { port: Number(url.port) } : {}),
    ...(url.username ? { user: decodeURIComponent(url.username) } : {}),
    ...(url.password ? { password: decodeURIComponent(url.password) } : {}),
    ...(database ? { database } : {}),
    options: {
      ...(encrypt === undefined ? {} : { encrypt }),
      ...(trustServerCertificate === undefined
        ? {}
        : { trustServerCertificate }),
    },
  };
}

type MssqlTypes = typeof import("mssql");

/**
 * Bind every value with a type T-SQL reads exactly: a `Date` as `DATETIME2`
 * (the inferred `DATETIME` rounds to 1/300 s), bytes as `VARBINARY`, a
 * `bigint` as `BIGINT`, and everything else as `mssql` infers it.
 */
function bind(mssql: MssqlTypes, request: Request, params: unknown[]): void {
  for (const [index, value] of params.entries()) {
    const name = `p${index + 1}`;
    if (value instanceof Date) request.input(name, mssql.DateTime2(7), value);
    else if (value instanceof Uint8Array)
      request.input(
        name,
        mssql.VarBinary(mssql.MAX),
        Buffer.isBuffer(value)
          ? value
          : Buffer.from(value.buffer, value.byteOffset, value.byteLength)
      );
    else if (typeof value === "bigint")
      request.input(name, mssql.BigInt, value.toString());
    else request.input(name, value);
  }
}

function toQueryResult<T>(
  result: IResult<unknown>,
  operation: string,
  identity: boolean
): QueryResult<T> {
  const context = { provider: "mssql", operation };
  const sets = result.recordsets as unknown as unknown[][];
  if (identity) {
    // NULL where the table has no identity column.
    const identityRow: unknown = sets.at(-1)?.[0];
    const value =
      typeof identityRow === "object" && identityRow !== null
        ? Reflect.get(identityRow, INSERT_ID_COLUMN)
        : null;
    const insertId =
      value === null || value === undefined
        ? undefined
        : normalizeProviderInsertId(value, context, { allowNumber: true });
    return {
      rows: [],
      rowCount: normalizeProviderRowCount(result.rowsAffected[0] ?? 0, context),
      ...(insertId === undefined ? {} : { insertId }),
    };
  }
  if (sets.length > 1)
    throw new QueryError(
      `Driver "mssql" returned ${sets.length} result sets for operation "${operation}"; VibORM requires exactly one statement result.`,
      { meta: { driver: "mssql", operation } }
    );
  const rows = (sets[0] ?? []) as T[];
  return {
    rows,
    rowCount:
      sets.length === 1
        ? rows.length
        : normalizeProviderRowCount(
            result.rowsAffected.reduce((sum, count) => sum + count, 0),
            context
          ),
  };
}

/** `@p1`, `@p2`, …: T-SQL's named parameters. */
function numberedStatement(query: Sql): string {
  const strings = query.strings;
  let text = strings[0]!;
  for (let index = 1; index < strings.length; index++)
    text += `@p${index}${strings[index]}`;
  return text;
}

/** The transaction's view, numbering its parameters the same way. */
class MssqlTransactionDriver extends TransactionBoundDriver<
  ConnectionPool,
  Transaction
> {
  protected override buildStatement(query: Sql): string {
    return numberedStatement(query);
  }

  protected override createTransactionBoundDriver(
    tx: Transaction,
    context: QueryExecutionContext
  ): TransactionBoundDriver<ConnectionPool, Transaction> {
    return new MssqlTransactionDriver(this, tx, context);
  }
}

export class MssqlDriver extends Driver<ConnectionPool, Transaction> {
  declare readonly adapter: DatabaseAdapter;
  readonly maxBindParametersPerStatement: number | undefined =
    MAX_BOUND_PARAMETERS;

  private readonly suppliedPool: ConnectionPool | undefined;
  private readonly connectionOptions: Partial<MssqlConfig>;
  #mssql: MssqlTypes | undefined;

  constructor(options: MssqlDriverOptions = {}) {
    const namespace = resolveNamespaceOption(options);
    const urlOptions = options.databaseUrl
      ? parseMssqlUrl(options.databaseUrl)
      : {};
    super("mssql", "mssql");
    this.suppliedPool = options.pool;
    this.connectionOptions = {
      ...urlOptions,
      ...options.options,
      options: {
        // Every statement VibORM writes quotes identifiers with `"`.
        enableQuotedIdentifier: true,
        ...urlOptions.options,
        ...options.options?.options,
      },
    };
    defineImmutableDriverFact(this, "adapter", new MssqlAdapter(namespace));
    if (this.suppliedPool) this.client = this.suppliedPool;
  }

  async #provider(): Promise<MssqlTypes> {
    this.#mssql ??= await import("mssql");
    return this.#mssql;
  }

  protected override buildStatement(query: Sql): string {
    return numberedStatement(query);
  }

  protected override createTransactionBoundDriver(
    tx: Transaction,
    context: QueryExecutionContext
  ): TransactionBoundDriver<ConnectionPool, Transaction> {
    return new MssqlTransactionDriver(this, tx, context);
  }

  protected async initClient(): Promise<ConnectionPool> {
    const mssql = await this.#provider();
    if (this.suppliedPool !== undefined) {
      if (!this.suppliedPool.connected) await this.suppliedPool.connect();
      return this.suppliedPool;
    }
    const pool = new mssql.ConnectionPool(this.connectionOptions as MssqlConfig);
    await pool.connect();
    return pool;
  }

  protected async closeClient(pool: ConnectionPool): Promise<void> {
    if (pool === this.suppliedPool) return;
    await pool.close();
  }

  protected async execute<T>(
    client: ConnectionPool | Transaction,
    sql: string,
    params: unknown[],
    context?: QueryExecutionContext
  ): Promise<QueryResult<T>> {
    const identity = INSERT_STATEMENT.test(sql);
    return this.#run<T>(
      client,
      identity
        ? `${sql};SELECT CAST(SCOPE_IDENTITY() AS BIGINT) AS "${INSERT_ID_COLUMN}"`
        : sql,
      params,
      context?.operation ?? "execute",
      identity
    );
  }

  protected async executeRaw<T>(
    client: ConnectionPool | Transaction,
    sql: string,
    params: unknown[] | undefined,
    context?: QueryExecutionContext
  ): Promise<QueryResult<T>> {
    const savepoint = savepointStatement(sql);
    if (savepoint === null) return { rows: [], rowCount: 0 };
    return this.#run<T>(
      client,
      savepoint ?? sql,
      params ?? [],
      context?.operation ?? "executeRaw",
      false
    );
  }

  async #run<T>(
    client: ConnectionPool | Transaction,
    sql: string,
    params: unknown[],
    operation: string,
    identity: boolean
  ): Promise<QueryResult<T>> {
    const mssql = await this.#provider();
    const request = client.request();
    bind(mssql, request, params);
    let result: IResult<unknown>;
    try {
      result = await request.query(sql);
    } catch (error) {
      if (process.env.VIBORM_MSSQL_DEBUG) console.error("MSSQL-DEBUG", (error as Error).message, "\n", sql, "\n", JSON.stringify(params)); // DEBUG-REMOVE
      throw normalizeMssqlError(error);
    }
    return toQueryResult<T>(result, operation, identity);
  }

  /** The isolation level is `BEGIN TRANSACTION`'s own argument in `mssql`. */
  protected override transactionOptionSupport(): TransactionOptionSupport {
    return {
      isolationLevel: "provider",
      timeout: true,
      maxWait: "unsupported",
      maxWaitReason:
        "the mssql pool acquires a transaction's connection inside BEGIN TRANSACTION, which no caller bound can interrupt",
    };
  }

  protected async transaction<T>(
    client: ConnectionPool | Transaction,
    fn: (tx: Transaction) => Promise<T>,
    context?: QueryExecutionContext,
    options?: DriverTransactionOptions
  ): Promise<T> {
    if (!("connected" in client)) {
      throw nestedTransactionDispatchError(this.driverName);
    }
    const mssql = await this.#provider();
    const transaction = new mssql.Transaction(client);
    const level = options?.isolationLevel;
    return runTransactionLifecycle({
      begin: async () => {
        await transaction.begin(
          level === undefined
            ? undefined
            : mssql.ISOLATION_LEVEL[
                ISOLATION_LEVELS[level] as keyof typeof mssql.ISOLATION_LEVEL
              ]
        );
      },
      callback: () => fn(transaction),
      commit: () => transaction.commit(),
      rollback: () => transaction.rollback(),
      phases: getExecutionTransactionPhases(context),
    });
  }
}

export function createClient<S extends Schema, C extends DriverConfig<S>>(
  config: MssqlClientConfig<C> &
    DriverConfig<S> &
    NoExtraDriverConfigKeys<C, MssqlDriverOptions, S>
): VibORMClient<{
  [P in keyof LinkedClientConfig<
    C & { driver: MssqlDriver }
  >]: LinkedClientConfig<C & { driver: MssqlDriver }>[P];
}> {
  refuseUnknownDriverConfigKeys(config, "mssql", MSSQL_CONFIG_KEYS);
  const { pool, options, databaseUrl } = config;
  const driver = new MssqlDriver({
    namespace: resolveNamespaceOption(config),
    pool,
    options,
    databaseUrl,
  });
  return createClientFromDriverConfig<S, C, MssqlDriver>(config, driver);
}
