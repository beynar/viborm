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
  type VibORMClient,
} from "@client/client";
import type { Schema } from "@client/types";
import {
  ClientInitializationError,
  QueryError,
  TransactionError,
} from "@errors";
import type { Pool, PoolConnection, PoolOptions } from "mysql2/promise";
import { Driver, type QueryExecutionContext } from "../driver";
import { getExecutionTransactionPhases } from "../execution-context";
import {
  isNormalizedResultRow,
  type NormalizedResultContext,
  normalizeProviderInsertId,
  normalizeProviderRowCount,
} from "../normalized-result";
import {
  acquireWithMaxWait,
  type DriverTransactionOptions,
  defineImmutableDriverFact,
  isolationLevelStatement,
  type MigrationNamespaceAttestation,
  type MySQLConnectionOptions,
  nestedTransactionDispatchError,
  type PinnedSessionReservation,
  parseMySQLUrl,
  resolveMigrationNamespaceAttestationOption,
  resolveNamespaceOption,
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
  /**
   * The MySQL database this driver's persistent objects live in. Omitted, the
   * target is derived from a driver-created pool's own configuration, and a
   * driver that resolves none keeps the existing unqualified mode.
   */
  namespace?: string;
  /**
   * Caller-owned assertion that qualified `database.table` references and the
   * pinned migration session's `USE` cannot be redirected by VTGate
   * schema-routing rules or an equivalent proxy. It selects nothing, is never
   * inferred, and only effectful live migration work requires it.
   */
  migrationNamespaceAttestation?: MigrationNamespaceAttestation;
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

/**
 * The target derived from a pool this driver will create: the URL's database
 * path, then the connection options' `database`. A supplied `Pool` is opaque —
 * VibORM does not inspect mysql2 internals, so only an explicit `namespace` can
 * bind one. A pathless URL contributes nothing, and neither does an empty
 * `options.database`: §1.3's empty candidate is an absent one rather than a
 * name handed to identifier validation. A non-empty derived name is validated
 * exactly like an explicit one, by the adapter that installs it.
 */
function deriveMySQL2Namespace(
  configuration: Omit<MySQL2Configuration, "namespace">
): string | undefined {
  if (configuration.suppliedPool) return undefined;
  const configured =
    configuration.urlOptions?.database ??
    configuration.connectionOptions.database;
  return configured === "" ? undefined : configured;
}

/** What this driver settles from its caller's object, each source read once. */
interface MySQL2Configuration {
  readonly namespace: string | undefined;
  /** The parsed `databaseUrl`, or `undefined` when the caller supplied none. */
  readonly urlOptions: MySQLConnectionOptions | undefined;
  /**
   * The EXACT pool the caller supplied, or absent when this driver makes its
   * own. Identity, settled once, is the whole ownership answer: the caller's
   * options object is theirs to change, and a `pool` key deleted after
   * construction used to make `$disconnect()` end a transport VibORM was handed.
   */
  readonly suppliedPool: Pool | undefined;
  /**
   * The caller's connection record, copied once.
   *
   * A copy of THIS record, not of what it points at: a nested `ssl` object or
   * stream is the caller's to own, and the keys that decide where a pool
   * connects — host, port, user, database — all live here. It is also what the
   * constructor's refusals read, so the options this driver validated are the
   * exact options it later connects with.
   */
  readonly connectionOptions: PoolOptions;
}

/**
 * The one immutable ORM target for this driver, in the plan's exact order: an
 * explicit `namespace`, then the driver-created pool's own derivation.
 *
 * `databaseUrl` is read once and parsed once, here, and the parse is kept: a
 * second read at connect time would let a caller-owned accessor hand the
 * provider a different URL than the one that decided the target. A present URL
 * is parsed even when an explicit `namespace` outranks it, because an unusable
 * connection string is a construction failure either way; `""`, `null`, and an
 * absent property are the same absent request. Both rules are the convenience
 * wrapper's too, so the two entry points cannot disagree.
 *
 * None of these sources is transport evidence: the attestation is read
 * separately and never derived from a resolved target.
 */
function resolveMySQL2Configuration(
  options: MySQL2DriverOptions
): MySQL2Configuration {
  const explicit = resolveNamespaceOption(options);
  const databaseUrl = options.databaseUrl;
  const captured = {
    urlOptions: databaseUrl ? parseMySQL2ConfiguredUrl(databaseUrl) : undefined,
    suppliedPool: options.pool,
    connectionOptions: { ...options.options },
  };
  return {
    namespace: explicit ?? deriveMySQL2Namespace(captured),
    ...captured,
  };
}

/** The URL now decides a target, so a malformed one fails at construction. */
function parseMySQL2ConfiguredUrl(databaseUrl: string): MySQLConnectionOptions {
  try {
    return parseMySQLUrl(databaseUrl);
  } catch (cause) {
    throw new ClientInitializationError(
      'Driver "mysql2" could not parse its databaseUrl.',
      { cause: cause instanceof Error ? cause : undefined }
    );
  }
}

export class MySQL2Driver extends Driver<Pool, PoolConnection> {
  declare readonly adapter: DatabaseAdapter;
  readonly maxBindParametersPerStatement: number | undefined = 65_535;

  /** The caller's `databaseUrl` as parsed at construction; see above. */
  private readonly urlOptions: MySQLConnectionOptions | undefined;
  /** The caller's pool and connection record, as construction captured them. */
  private readonly suppliedPool: Pool | undefined;
  private readonly connectionOptions: PoolOptions;

  constructor(options: MySQL2DriverOptions = {}) {
    // Both facts are read before `super(...)` so the transport assertion is
    // installed by the base constructor and no option can be read twice.
    const attestation = resolveMigrationNamespaceAttestationOption(options);
    const configuration = resolveMySQL2Configuration(options);
    super("mysql", "mysql2", {}, attestation);
    if (configuration.connectionOptions.multipleStatements === true) {
      throw new ClientInitializationError(
        'Driver "mysql2" does not support options.multipleStatements=true because VibORM operations require one result per statement.',
        { meta: { driver: "mysql2", operation: "configuration" } }
      );
    }
    if (configuration.connectionOptions.rowsAsArray === true) {
      throw new ClientInitializationError(
        'Driver "mysql2" does not support options.rowsAsArray=true because VibORM requires row objects keyed by column name.',
        { meta: { driver: "mysql2", operation: "configuration" } }
      );
    }
    if (
      configuration.connectionOptions.nestTables === true ||
      typeof configuration.connectionOptions.nestTables === "string"
    ) {
      throw new ClientInitializationError(
        'Driver "mysql2" does not support enabled options.nestTables because VibORM requires flat row objects keyed by result aliases.',
        { meta: { driver: "mysql2", operation: "configuration" } }
      );
    }
    this.urlOptions = configuration.urlOptions;
    this.suppliedPool = configuration.suppliedPool;
    this.connectionOptions = configuration.connectionOptions;
    defineImmutableDriverFact(
      this,
      "adapter",
      new MySQLAdapter(configuration.namespace)
    );
    if (this.suppliedPool) {
      this.client = this.suppliedPool;
    }
  }

  /**
   * The pool this driver connects through.
   *
   * A caller's pool is RETURNED rather than replaced: reconnecting after a
   * `$disconnect()` used to build a second pool behind their back — a transport
   * they never asked for, pointed at whatever their options record said by
   * then, and then never closed, because the ownership question was still
   * answered "supplied".
   */
  protected async initClient(): Promise<Pool> {
    if (this.suppliedPool !== undefined) {
      return this.suppliedPool;
    }
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
      ...this.connectionOptions,
    };

    // The URL still wins over the copied connection options, from the one
    // parse construction made: this driver never re-reads the caller's
    // `databaseUrl`, so the pool cannot be pointed somewhere the resolved
    // target never saw.
    if (this.urlOptions) {
      options = { ...options, ...this.urlOptions };
    }

    // The pool this driver creates defaults to the same database the adapter
    // qualifies with, whichever source resolved it. A supplied pool never
    // reaches here, so VibORM never changes a caller's connection state.
    if (this.adapter.namespace !== undefined) {
      options = { ...options, database: this.adapter.namespace };
    }

    return mysql.createPool(options);
  }

  /**
   * Ends only a pool this driver created.
   *
   * A supplied pool belongs to the caller, who may be sharing it with other
   * clients or with their own code, and §5.3's rule is that VibORM never
   * changes a caller's connection state. `$disconnect()` used to end it
   * regardless, so disconnecting one client tore down every other consumer of
   * that pool.
   *
   * The test is on the pool's IDENTITY against what construction captured, so
   * it answers for the pool actually being closed rather than for whatever the
   * caller's record says now: every pool this driver made is ended, and the one
   * it was handed never is.
   */
  protected async closeClient(pool: Pool): Promise<void> {
    if (pool === this.suppliedPool) {
      return;
    }
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
    context?: QueryExecutionContext,
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
      phases: getExecutionTransactionPhases(context),
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

  /**
   * One `PoolConnection` from `pool.getConnection()` — plan §3.5's pinned
   * producer for MySQL2.
   *
   * It is ALWAYS destroyed, never released, and the `discard` flag is therefore
   * ignored: this session has executed `USE` to select the migration target and
   * may have executed author-owned statements from a manual artifact, and
   * mysql2's release resets neither. Returning it to an owned or a supplied
   * pool would leak that state into unrelated queries. This is correctness, not
   * an optimization.
   */
  protected override async pinnedSession(): Promise<
    PinnedSessionReservation<Pool | PoolConnection>
  > {
    const client = await this.getClient({ operation: "pinnedSession" });
    if (!("getConnection" in client)) {
      throw nestedTransactionDispatchError(this.driverName);
    }
    const connection = await client.getConnection();
    return {
      session: connection,
      release: () => {
        connection.destroy();
        return Promise.resolve();
      },
    };
  }
}

// ============================================================
// CONVENIENCE FUNCTION
// ============================================================

export function createClient<S extends Schema, C extends DriverConfig<S>>(
  config: MySQL2ClientConfig<C> &
    DriverConfig<S> &
    NoExtraDriverConfigKeys<C, MySQL2DriverOptions, S>
): VibORMClient<C & { driver: MySQL2Driver }> {
  const { pool, options = {}, databaseUrl } = config;
  const attestation = resolveMigrationNamespaceAttestationOption(config);
  const namespace = resolveNamespaceOption(config);

  const driverOptions: MySQL2DriverOptions = {
    pool,
    // The URL still wins over the caller's option keys, on a copy this wrapper
    // owns rather than in the caller's record.
    options: databaseUrl
      ? { ...options, ...parseMySQL2ConfiguredUrl(databaseUrl) }
      : options,
  };
  if (namespace !== undefined) driverOptions.namespace = namespace;
  if (attestation !== undefined) {
    driverOptions.migrationNamespaceAttestation = attestation;
  }

  const driver = new MySQL2Driver(driverOptions);

  return createClientFromDriverConfig(config, driver) as VibORMClient<
    C & { driver: MySQL2Driver }
  >;
}
