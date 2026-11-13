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
import {
  ClientInitializationError,
  QueryError,
  TransactionError,
  UnsupportedOperationError,
} from "@errors";
import type { Sql } from "@sql";
import type {
  ConnectionPool,
  IResult,
  config as MssqlConfig,
  Request,
  Transaction,
} from "mssql";
import {
  Driver,
  type QueryExecutionContext,
  TransactionBoundDriver,
} from "../driver";
import { getExecutionTransactionPhases } from "../execution-context";
import { normalizeProviderRowCount } from "../normalized-result";
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
import type { TransactionOptions } from "../shared/transaction-options";
import type { QueryResult } from "../types";
import {
  normalizeMssqlError,
  readErrorNumber,
  withServerNumber,
} from "./errors";

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

/** An `UPDATE` or a `DELETE`, alone or after its `WITH`. */
const COUNTED_STATEMENT = /^\s*(?:WITH\b[\s\S]*\)\s*)?(?:UPDATE|DELETE)\b/i;

/**
 * The rows a statement wrote, read in its own request: a trigger's own
 * statements add to `rowsAffected` (before the statement's count) unless
 * the trigger sets NOCOUNT, and may return rows of their own, but
 * `@@ROWCOUNT` after the statement is the statement's.
 */
const ROWCOUNT_COLUMN = "__viborm_rowcount";
const ROWCOUNT_SELECT = `;SELECT @@ROWCOUNT AS "${ROWCOUNT_COLUMN}"`;

/** The target of a VibORM `INSERT INTO "schema"."table"`. */
const INSERT_TARGET = /\bINSERT\s+INTO\s+((?:"(?:[^"]|"")*"\.)?"(?:[^"]|"")*")/;

/** "Cannot insert explicit value for identity column … IDENTITY_INSERT is OFF." */
const EXPLICIT_IDENTITY = 544;

const IDENTITY_SELECT = `;SELECT @@ROWCOUNT AS "${ROWCOUNT_COLUMN}", CAST(SCOPE_IDENTITY() AS BIGINT) AS "${INSERT_ID_COLUMN}"`;

/**
 * An `INSERT` that spells an identity column's value, as every other dialect
 * admits: the same statement with `IDENTITY_INSERT` on for its table, and off
 * again whether it succeeds or fails (the setting is the session's). The row
 * spelled its identity, so there is no generated one to report.
 */
function withExplicitIdentity(sql: string): string | undefined {
  const table = INSERT_TARGET.exec(sql)?.[1];
  if (table === undefined) return undefined;
  // `SET` resets `@@ROWCOUNT`: the INSERT's count is kept before it runs.
  return `DECLARE @viborm_rowcount INT; SET IDENTITY_INSERT ${table} ON; BEGIN TRY ;${sql}; SET @viborm_rowcount = @@ROWCOUNT; END TRY BEGIN CATCH SET IDENTITY_INSERT ${table} OFF; THROW; END CATCH; SET IDENTITY_INSERT ${table} OFF; SELECT @viborm_rowcount AS "${ROWCOUNT_COLUMN}"`;
}

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

/**
 * Transactions whose connection `mssql` has already released: one the
 * server rolled back itself (a deadlock victim, a batch-aborting error),
 * and one whose COMMIT failed. There is nothing left to roll back, to a
 * savepoint or whole, and the first error is the failure to report.
 */
const ABORTED_BY_SERVER = new WeakSet<Transaction>();

/**
 * A statement, or the COMMIT, of a transaction the server rolled back whole:
 * a deadlock, a statement under XACT_ABORT or a trigger's ROLLBACK, even
 * inside a savepoint, where PostgreSQL would lose the savepoint alone.
 */
const rolledBack = (cause?: unknown) =>
  new TransactionError(
    "SQL Server rolled back the whole transaction (a deadlock, XACT_ABORT or a trigger's ROLLBACK, even inside a savepoint): nothing it wrote is kept, and no statement runs in it any more.",
    {
      cause: cause as Error | undefined,
      meta: { driver: "mssql", reason: "transaction-rolled-back-by-server" },
    }
  );

/**
 * Transactions a raw COMMIT or ROLLBACK ended (Msg 266, the count now 0),
 * each to whether it committed. They are in {@link ABORTED_BY_SERVER} too.
 */
const ENDED_BY_STATEMENT = new WeakMap<Transaction, boolean>();

const endedByStatement = (committed: boolean, cause?: unknown) =>
  new TransactionError(
    committed
      ? "A raw COMMIT ended the transaction: what it wrote is committed, and no statement runs in it any more."
      : "A raw ROLLBACK ended the transaction: what it wrote is rolled back, and no statement runs in it any more.",
    {
      cause: cause as Error | undefined,
      meta: { driver: "mssql", reason: "transaction-ended-by-statement" },
    }
  );

/** What a statement, or the COMMIT, of a transaction that ended fails with. */
const ended = (transaction: Transaction) => {
  const committed = ENDED_BY_STATEMENT.get(transaction);
  return committed === undefined ? rolledBack() : endedByStatement(committed);
};

/** A statement that rolls back, as opposed to one that commits. */
const ROLLBACK_STATEMENT = /\bROLLBACK\b/i;

/** Msg 266 with the count back at 0: a statement ended the transaction. */
const TRANCOUNT_MISMATCH = 266;
const TRANCOUNT_ZERO = /current count = 0\b/;

/** Msg 1088: SET IDENTITY_INSERT on a table the login may not ALTER. */
const IDENTITY_INSERT_DENIED = 1088;

/** Msg 3609: the transaction ended in the trigger, the batch aborted. */
const TRIGGER_ENDED_TRANSACTION = 3609;

/** tedious refusing a request on a connection that has closed. */
const SESSION_GONE = /\bnot the Final state\b/;

/** Socket failures: the session is gone, and its transaction with it. */
const SOCKET_CODES = new Set(["ESOCKET", "ECONNRESET", "ECONNCLOSED"]);

/** Whether `error` says the session (and so its transaction) is gone. */
const sessionGone = (error: unknown): boolean =>
  SESSION_GONE.test((error as Error).message) ||
  SOCKET_CODES.has(Reflect.get(error as object, "code")) ||
  SOCKET_CODES.has(
    Reflect.get(
      (Reflect.get(error as object, "originalError") ?? {}) as object,
      "code"
    )
  );

/** `mssql`'s isolation constants, as `SET TRANSACTION ISOLATION LEVEL` names them. */
const LEVEL_NAMES: Record<number, string> = {
  1: "READ UNCOMMITTED",
  2: "READ COMMITTED",
  3: "REPEATABLE READ",
  4: "SERIALIZABLE",
  5: "SNAPSHOT",
};

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
  const database = decodeURIComponent(url.pathname.slice(1));
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
 * `bigint` as `BIGINT`, a whole `number` past the safe integers as `FLOAT`
 * (`mssql` infers BIGINT for any whole number, and 1e19 overflows it), and
 * everything else as `mssql` infers it.
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
    else if (typeof value === "number" && !Number.isSafeInteger(value))
      request.input(name, mssql.Float, value);
    else request.input(name, value);
  }
}

/**
 * How a statement's result is read: its one result set as its rows, or (a
 * write, which returns none of its own) the count and the generated
 * identity its trailing SELECT reads, from the request's last result set.
 */
type ResultShape = "rows" | "counted" | "identity";

/** `SCOPE_IDENTITY()` as the BIGINT text it is cast to. */
const IDENTITY_TEXT = /^-?\d+$/;

/** A generated key the driver read back, or a malformed one refused. */
function identityOf(
  id: unknown,
  context: { provider: string; operation: string }
): bigint {
  if (typeof id === "string" && IDENTITY_TEXT.test(id)) return BigInt(id);
  throw new QueryError(
    `Driver "mssql" returned a malformed insert id for operation "${context.operation}".`,
    { meta: { driver: "mssql", operation: context.operation } }
  );
}

function toQueryResult<T>(
  result: IResult<unknown>,
  operation: string,
  shape: ResultShape
): QueryResult<T> {
  const context = { provider: "mssql", operation };
  const sets = result.recordsets as unknown as unknown[][];
  if (shape !== "rows") {
    const last: unknown = sets.at(-1)?.[0];
    const read = (column: string): unknown =>
      typeof last === "object" && last !== null
        ? Reflect.get(last, column)
        : undefined;
    // NULL where the table has no identity column; any other value is the
    // key, 0 and negative seeds included (`CAST(… AS BIGINT)`, read as text).
    const id = shape === "identity" ? read(INSERT_ID_COLUMN) : undefined;
    const insertId =
      id === null || id === undefined ? undefined : identityOf(id, context);
    return {
      rows: [],
      rowCount: normalizeProviderRowCount(read(ROWCOUNT_COLUMN) ?? 0, context),
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
  readonly #tx: Transaction;

  constructor(
    base: Driver<ConnectionPool, Transaction>,
    tx: Transaction,
    context?: QueryExecutionContext
  ) {
    super(base, tx, context);
    this.#tx = tx;
  }

  // After the server rolled the transaction back, every statement and nested
  // transaction says so, as the statement that met it did.
  override _execute<T = Record<string, unknown>>(
    query: Sql,
    context?: QueryExecutionContext
  ): Promise<QueryResult<T>> {
    return ABORTED_BY_SERVER.has(this.#tx)
      ? Promise.reject(ended(this.#tx))
      : super._execute<T>(query, context);
  }

  override _executeRaw<T = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
    context?: QueryExecutionContext
  ): Promise<QueryResult<T>> {
    return ABORTED_BY_SERVER.has(this.#tx)
      ? Promise.reject(ended(this.#tx))
      : super._executeRaw<T>(sql, params, context);
  }

  override _transaction<T>(
    fn: (tx: Transaction) => Promise<T>,
    options?: TransactionOptions,
    context?: QueryExecutionContext
  ): Promise<T> {
    return ABORTED_BY_SERVER.has(this.#tx)
      ? Promise.reject(ended(this.#tx))
      : super._transaction(fn, options, context);
  }

  protected override buildStatement(query: Sql): string {
    return numberedStatement(query);
  }

  protected override normalizeStatementFailure(
    error: unknown,
    sql: string,
    params: unknown[],
    context: QueryExecutionContext,
    forceErrorContext: boolean
  ): Error {
    return withServerNumber(
      super.normalizeStatementFailure(
        error,
        sql,
        params,
        context,
        forceErrorContext
      ),
      error
    );
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
    // A supplied pool goes through `initClient` too, which connects it if
    // the caller has not.
  }

  async #provider(): Promise<MssqlTypes> {
    this.#mssql ??= await import("mssql");
    return this.#mssql;
  }

  protected override buildStatement(query: Sql): string {
    return numberedStatement(query);
  }

  protected override normalizeStatementFailure(
    error: unknown,
    sql: string,
    params: unknown[],
    context: QueryExecutionContext,
    forceErrorContext: boolean
  ): Error {
    return withServerNumber(
      super.normalizeStatementFailure(
        error,
        sql,
        params,
        context,
        forceErrorContext
      ),
      error
    );
  }

  /**
   * T-SQL names its parameters (`@p1`), and the statement is numbered here
   * from its own text: past the bind budget it is refused, never bound with
   * equal values merged into a `?NNN` text this driver does not read.
   */
  protected override get numbersPlaceholders(): boolean {
    return false;
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
      // Connected once if it never was; a pool its owner closed stays closed,
      // and its requests fail as a closed connection's (`ECONNCLOSED`).
      const closed =
        (this.suppliedPool as unknown as { pool?: unknown }).pool === null;
      if (!(closed || this.suppliedPool.connected))
        await this.suppliedPool.connect();
      return this.suppliedPool;
    }
    const pool = new mssql.ConnectionPool(
      this.connectionOptions as MssqlConfig
    );
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
    const operation = context?.operation ?? "execute";
    if (COUNTED_STATEMENT.test(sql))
      return this.#run<T>(
        client,
        `${sql}${ROWCOUNT_SELECT}`,
        params,
        operation,
        "counted"
      );
    if (!INSERT_STATEMENT.test(sql))
      return this.#run<T>(client, sql, params, operation, "rows");
    try {
      return await this.#run<T>(
        client,
        `${sql}${IDENTITY_SELECT}`,
        params,
        operation,
        "identity",
        true
      );
    } catch (error) {
      const explicit =
        readErrorNumber(error) === EXPLICIT_IDENTITY
          ? withExplicitIdentity(sql)
          : undefined;
      if (explicit === undefined) throw normalizeMssqlError(error);
      try {
        return await this.#run<T>(
          client,
          explicit,
          params,
          operation,
          "counted",
          true
        );
      } catch (refused) {
        if (readErrorNumber(refused) !== IDENTITY_INSERT_DENIED)
          throw normalizeMssqlError(refused);
        throw new UnsupportedOperationError(
          "An explicit value for an IDENTITY key needs SET IDENTITY_INSERT, which needs ALTER permission on the table: grant ALTER to this login, or leave the key to SQL Server.",
          { cause: normalizeMssqlError(refused) as Error }
        );
      }
    }
  }

  protected async executeRaw<T>(
    client: ConnectionPool | Transaction,
    sql: string,
    params: unknown[] | undefined,
    context?: QueryExecutionContext
  ): Promise<QueryResult<T>> {
    const savepoint = savepointStatement(sql);
    if (
      savepoint === null ||
      (savepoint?.startsWith("ROLLBACK") &&
        ABORTED_BY_SERVER.has(client as Transaction))
    )
      return { rows: [], rowCount: 0 };
    return this.#run<T>(
      client,
      savepoint ?? sql,
      params ?? [],
      context?.operation ?? "executeRaw",
      "rows"
    );
  }

  async #run<T>(
    client: ConnectionPool | Transaction,
    sql: string,
    params: unknown[],
    operation: string,
    shape: ResultShape,
    raw = false
  ): Promise<QueryResult<T>> {
    if (ABORTED_BY_SERVER.has(client as Transaction))
      throw ended(client as Transaction);
    const mssql = await this.#provider();
    const request = client.request();
    let result: IResult<unknown>;
    try {
      bind(mssql, request, params);
      result = await request.query(sql);
    } catch (error) {
      // A trigger's ROLLBACK ended the transaction under this statement: it
      // says so as every statement after it does. Any other error keeps its
      // own (a deadlock, a constraint, a judged write's refusal).
      const number = readErrorNumber(error);
      if (number === TRIGGER_ENDED_TRANSACTION) throw rolledBack(error);
      // A raw COMMIT or ROLLBACK ended this transaction: nothing is left
      // open, and the statements after it say how it ended.
      if (
        number === TRANCOUNT_MISMATCH &&
        client instanceof mssql.Transaction &&
        TRANCOUNT_ZERO.test((error as Error).message)
      ) {
        const committed = !ROLLBACK_STATEMENT.test(sql);
        ENDED_BY_STATEMENT.set(client, committed);
        ABORTED_BY_SERVER.add(client);
        throw endedByStatement(committed, error);
      }
      if (raw) throw error;
      throw normalizeMssqlError(error);
    }
    return toQueryResult<T>(result, operation, shape);
  }

  /** The isolation level is `BEGIN TRANSACTION`'s own argument in `mssql`. */
  protected override transactionOptionSupport(): TransactionOptionSupport {
    return {
      // Handed to this driver, which opens the transaction at that level.
      isolationLevel: "pre-begin",
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
    transaction.on("rollback", (aborted: boolean) => {
      if (aborted) ABORTED_BY_SERVER.add(transaction);
    });
    const level = options?.isolationLevel;
    // A session keeps the level a transaction set past its end, and `mssql`
    // lends it again: it goes back to the pool's own level first, in a batch
    // of its own (a parameterized request's SET ends with its scope).
    const configured =
      (client as unknown as { config: MssqlConfig }).config.options
        ?.isolationLevel ?? mssql.ISOLATION_LEVEL.READ_COMMITTED;
    const restore =
      level === undefined ||
      mssql.ISOLATION_LEVEL[
        ISOLATION_LEVELS[level] as keyof typeof mssql.ISOLATION_LEVEL
      ] === configured
        ? undefined
        : `SET TRANSACTION ISOLATION LEVEL ${LEVEL_NAMES[configured] ?? "READ COMMITTED"}`;
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
      commit: async () => {
        // Rolled back by the server, or ended by a raw statement: the
        // outcome is known. `mssql` still holds a raw statement's connection,
        // which its (failing) ROLLBACK hands back to the pool.
        if (ABORTED_BY_SERVER.has(transaction)) {
          if (ENDED_BY_STATEMENT.has(transaction))
            await transaction.rollback().catch(() => undefined);
          throw ended(transaction);
        }
        if (restore) await transaction.request().batch(restore);
        try {
          await transaction.commit();
        } catch (error) {
          // `mssql` has released the connection, so there is nothing to roll
          // back from here, and the COMMIT may have reached the server or
          // not: nobody can say which.
          ABORTED_BY_SERVER.add(transaction);
          const unknown = new TransactionError(
            'Driver "mssql" could not confirm the COMMIT: the transaction may or may not have been committed.',
            {
              cause: normalizeMssqlError(error) as Error,
              meta: { driver: "mssql", reason: "commit-outcome-unknown" },
            }
          );
          // A lost session took its transaction with it. A live one (a
          // timeout cancelled the COMMIT) may still hold it open, on a
          // connection the pool lends again: the driver refuses further work.
          if (!sessionGone(error)) this.transactionCleanupFailed(unknown);
          throw unknown;
        }
      },
      rollback: async () => {
        if (ABORTED_BY_SERVER.has(transaction)) {
          if (ENDED_BY_STATEMENT.has(transaction))
            await transaction.rollback().catch(() => undefined);
          return;
        }
        try {
          if (restore) await transaction.request().batch(restore);
          await transaction.rollback();
        } catch (error) {
          // A killed session: the connection is closed, and the transaction
          // went with it. Any other failure leaves a session whose state is
          // unknown, which `mssql` still hands back to the pool: the driver
          // then refuses further work (`transactionCleanupFailed`).
          if (!sessionGone(error)) throw error;
        }
      },
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
