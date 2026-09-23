import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { PgDriver } from "@drivers/pg";
import { MySQL2Driver } from "@drivers/mysql2";
import { withSuppressedFailure } from "@drivers/shared";
import type {
  AnyDriver,
  BatchQuery,
  QueryExecutionContext,
  QueryResult,
} from "@drivers";
import {
  createIdentifierQuoter,
  createQualifiedIdentifierRenderer,
} from "@src/sql/identifiers";
import { Pool as PgPool, type PoolClient } from "pg";
import {
  type Pool as MySQLPool,
  type PoolConnection,
  type RowDataPacket,
} from "mysql2/promise";
import type {
  CandidateEngineFactory,
  PreparedScenario,
  RunObservation,
  StateRows,
} from "../harness/protocol";
import { observeFailure } from "../harness/sqlite-world";

const provider = process.env.VIBORM_RAPTOR3_PROVIDER;
assert(
  provider === "pg" || provider === "mysql",
  "Required live provider is pg or mysql"
);
const portText = process.env.VIBORM_RAPTOR3_PROVIDER_PORT;
assert(
  portText && /^\d+$/.test(portText),
  "Required live provider loopback port is missing or invalid"
);
const port = Number(portText);
assert(
  Number.isInteger(port) && port > 0 && port <= 65535,
  "Invalid live provider port"
);
export const liveProvider = provider;

type NativeRead = (statement: string) => Promise<Record<string, unknown>[]>;
type NativeWrite = (statement: string, parameters?: unknown[]) => Promise<void>;
export interface LiveNames {
  readonly namespace: string;
  quote(identifier: string): string;
  table(identifier: string): string;
}
export interface LiveFixture extends Pick<PreparedScenario, "assert"> {
  invoke(
    driver: AnyDriver,
    factory?: CandidateEngineFactory,
    peerDriver?: AnyDriver
  ): Promise<unknown>;
  readonly actorCount?: 2;
  readonly expectedExecutions?: number;
  readonly initial: StateRows;
  readonly tables: Record<string, { name: string; order: readonly string[] }>;
  observeState?(state: StateRows): string | undefined;
  /** Test-owned fault boundary, only after a real native PostgreSQL rollback. */
  afterRollback?(): void | Promise<void>;
}
export interface LiveStatement {
  actor?: "actor" | "peer";
  sql: string;
  parameters: unknown[];
  completed: boolean;
}
export interface LiveCompletion {
  statement: LiveStatement;
  rows: readonly unknown[];
  rowCount: number;
  transactionOpen: boolean;
}
export interface LivePeer extends LiveNames {
  readonly actorConnectionId: number;
  readonly peerConnectionId: number;
  write: NativeWrite;
  inspect(): Promise<StateRows>;
}
export type LiveBarrier = (
  completion: LiveCompletion,
  state: StateRows,
  peer: LivePeer
) => Promise<string | undefined>;

async function readPostgres(client: PgPool | PoolClient, statement: string) {
  return (await client.query<Record<string, unknown>>(statement)).rows;
}
async function readMySQL(
  client: MySQLPool | PoolConnection,
  statement: string
) {
  const [rows] = await client.query<RowDataPacket[]>(statement);
  return rows.map((row) => ({ ...row }));
}

/** The two fixture families share native transport and evidence ownership. */
class LiveObservation implements LiveNames {
  readonly reachedCuts: string[] = [];
  readonly statements: LiveStatement[] = [];
  readonly completions: LiveCompletion[] = [];
  readonly failedBatches: {
    failure?: unknown;
    nativeFailure?: unknown;
    correlationId?: string;
    queries: BatchQuery[];
  }[] = [];
  readonly rollbacks: { failure?: unknown }[] = [];
  private failure: { cause: unknown } | undefined;
  backgroundTransportFailure: { cause: unknown } | undefined;
  readonly quote = createIdentifierQuoter(provider === "pg" ? '"' : "`");
  readonly table;
  peer?: LivePeer;
  constructor(
    readonly fixture: LiveFixture,
    readonly namespace: string,
    readonly barrier?: LiveBarrier
  ) {
    this.table = createQualifiedIdentifierRenderer(this.quote, namespace);
  }
  async inspect(read: NativeRead): Promise<StateRows> {
    const state: StateRows = {};
    for (const [name, table] of Object.entries(this.fixture.tables)) {
      const rows = await read(`SELECT * FROM ${this.table(table.name)}`);
      rows.sort((left, right) => {
        for (const key of table.order) {
          const a = left[key];
          const b = right[key];
          if (a === b) continue;
          if (typeof a === "number" && typeof b === "number") return a - b;
          assert(
            typeof a === "string" && typeof b === "string",
            "Unexpected live fixture ordering key"
          );
          return a < b ? -1 : 1;
        }
        return 0;
      });
      state[name] = rows;
    }
    return state;
  }
  entered(
    sql: string,
    parameters: unknown[],
    actor?: "actor" | "peer"
  ): LiveStatement {
    const statement = {
      sql,
      parameters: [...parameters],
      completed: false,
      ...(actor ? { actor } : {}),
    };
    this.statements.push(statement);
    return statement;
  }
  async completed(
    read: NativeRead,
    statement: LiveStatement,
    response: QueryResult<unknown>,
    transactionOpen: boolean
  ) {
    statement.completed = true;
    try {
      // Rows remain borrowed by the ORM. Native fixture evidence takes its own
      // snapshot before any result parser can consume or change the response.
      const completion = {
        statement,
        rows: structuredClone(response.rows),
        rowCount: response.rowCount,
        transactionOpen,
      };
      this.completions.push(completion);
      const state = await this.inspect(read);
      const cut = this.fixture.observeState?.(state);
      if (cut !== undefined) this.reachedCuts.push(cut);
      if (this.barrier) {
        assert(
          this.peer,
          "A live barrier requires its separate peer connection"
        );
        const externalCut = await this.barrier(completion, state, this.peer);
        if (externalCut !== undefined) this.reachedCuts.push(externalCut);
      }
    } catch (cause) {
      this.failure ??= { cause };
      throw cause;
    }
  }
  assertHealthy() {
    if (this.failure) throw this.failure.cause;
  }
  /**
   * A background transport failure is the RUN's failure.
   *
   * It is filed where a body failure is filed, so every existing
   * `assertHealthy()` call site surfaces it with no new concept; `runLiveWorld`
   * additionally rethrows it at teardown when nothing else failed, because a
   * borrowed pool that died after the last assertion must not leave a green
   * cell behind. See `watchPool` below for why the fixture subscribes at all.
   */
  transportFailed(cause: unknown) {
    this.failure ??= { cause };
    this.backgroundTransportFailure ??= { cause };
  }
  async rolledBack() {
    const event: { failure?: unknown } = {};
    this.rollbacks.push(event);
    try {
      await this.fixture.afterRollback?.();
    } catch (failure) {
      event.failure = failure;
      throw failure;
    }
  }
}

class ObservedPgDriver extends PgDriver {
  constructor(
    pool: PgPool,
    protected readonly observation: LiveObservation,
    private readonly actor?: "actor" | "peer"
  ) {
    super({ pool, namespace: observation.namespace });
  }
  protected override async execute<T>(
    client: PgPool | PoolClient,
    sql: string,
    params: unknown[],
    context?: QueryExecutionContext
  ): Promise<QueryResult<T>> {
    const statement = this.observation.entered(sql, params, this.actor);
    const response = await super.execute<T>(client, sql, params, context);
    await this.observation.completed(
      (query) => readPostgres(client, query),
      statement,
      response,
      "release" in client
    );
    return response;
  }
}
class ObservedMySQLDriver extends MySQL2Driver {
  constructor(
    pool: MySQLPool,
    protected readonly observation: LiveObservation,
    private readonly actor?: "actor" | "peer"
  ) {
    super({ pool, namespace: observation.namespace });
  }
  protected override async execute<T>(
    client: MySQLPool | PoolConnection,
    sql: string,
    params: unknown[],
    context?: QueryExecutionContext
  ): Promise<QueryResult<T>> {
    const statement = this.observation.entered(sql, params, this.actor);
    const response = await super.execute<T>(client, sql, params, context);
    await this.observation.completed(
      (query) => readMySQL(client, query),
      statement,
      response,
      !("getConnection" in client)
    );
    return response;
  }
}

// Same real transaction owner as stock drivers; the base batch runner retains
// typed dispatch, per-statement attribution and normalized provider failures.
class AtomicPgDriver extends ObservedPgDriver {
  override readonly supportsTransactions = false;
  override readonly supportsBatch = true;
  protected override async executeBatch<T>(
    client: PgPool | PoolClient,
    queries: BatchQuery[],
    context?: QueryExecutionContext
  ): Promise<QueryResult<T>[]> {
    try {
      return await this.transaction(
        client,
        (tx) => super.executeBatch<T>(tx, queries, context),
        context
      );
    } catch (nativeFailure) {
      this.observation.failedBatches.push({
        nativeFailure,
        correlationId: context?.correlationId,
        queries,
      });
      throw nativeFailure;
    }
  }
  override async _executeBatch<T>(
    ...args: Parameters<PgDriver["_executeBatch"]>
  ): Promise<QueryResult<T>[]> {
    try {
      return await super._executeBatch<T>(...args);
    } catch (failure) {
      const unnormalized = this.observation.failedBatches.filter(
        (batch) =>
          !Object.hasOwn(batch, "failure") &&
          batch.correlationId === args[2]?.correlationId
      );
      assert(
        unnormalized.length <= 1,
        "Native failure attribution must identify one submission"
      );
      if (unnormalized[0]) unnormalized[0].failure = failure;
      else this.observation.failedBatches.push({ failure, queries: args[0] });
      throw failure;
    }
  }
}
class AtomicMySQLDriver extends ObservedMySQLDriver {
  override readonly supportsTransactions = false;
  override readonly supportsBatch = true;
  protected override executeBatch<T>(
    client: MySQLPool | PoolConnection,
    queries: BatchQuery[],
    context?: QueryExecutionContext
  ): Promise<QueryResult<T>[]> {
    return this.transaction(
      client,
      (tx) => super.executeBatch<T>(tx, queries, context),
      context
    );
  }
  override async _executeBatch<T>(
    ...args: Parameters<MySQL2Driver["_executeBatch"]>
  ): Promise<QueryResult<T>[]> {
    try {
      return await super._executeBatch<T>(...args);
    } catch (failure) {
      this.observation.failedBatches.push({ failure, queries: args[0] });
      throw failure;
    }
  }
}

/**
 * The pool the SHIPPED DRIVER itself would build for these options.
 *
 * `new PgPool(options)` and `createPool(options)` here used to bypass the
 * driver's own pool configuration: PostgreSQL's DATE/TIMESTAMP text parsers
 * (`utcSafeTypes`, `src/drivers/pg/index.ts`) and MySQL's `timezone: "Z"`,
 * `supportBigNumbers` and `dateStrings: ["DATE"]`
 * (`src/drivers/mysql2/index.ts`). A temporal or wide-numeric column therefore
 * decoded under this fixture the way it decodes nowhere in production — for
 * the shipped engine and the candidate alike, which is why the difference only
 * ever surfaced as a codec failure with no engine to blame. The pool now comes
 * from the driver's own factory and the fixture borrows the same transport for
 * its raw SQL, so seeding, inspection and both engines see one configuration.
 *
 * No `namespace` is passed to the factory: the per-run namespace does not exist
 * when the pool is built, and on MySQL the namespace IS the connection
 * database. The observed drivers above still carry it, so every statement the
 * ORM issues is still qualified by the per-run namespace.
 */
class PgPoolFactory extends PgDriver {
  ownPool(): Promise<PgPool> {
    return this.getClient() as Promise<PgPool>;
  }
}
class MySQLPoolFactory extends MySQL2Driver {
  ownPool(): Promise<MySQLPool> {
    return this.getClient() as Promise<MySQLPool>;
  }
}

/**
 * Subscribe the FIXTURE to the PostgreSQL pool it borrowed.
 *
 * `PgDriver.initClient()` retains the background failures of a pool it built
 * in a WeakMap keyed on that driver, and the factory instance above is
 * discarded the moment the pool is taken — so the retained failure became
 * unreadable and a run could pass over a dead transport. Under the pre-repair
 * bare `new PgPool(options)` there was no listener at all and Node failed the
 * run loudly; this restores that, through the observation instead of through
 * an uncaught exception.
 *
 * PostgreSQL only, because the defect is: `MySQL2Driver.initClient()`
 * subscribes to nothing, so a borrowed mysql2 pool behaves exactly as the
 * fixture-built one did.
 */
function watchPgPool(observation: LiveObservation, pool: PgPool): PgPool {
  pool.on("error", (failure) => observation.transportFailed(failure));
  return pool;
}

/** One fresh namespace per invocation; only the test-owned server removes it. */
export async function runLiveWorld(
  fixture: LiveFixture,
  definitions: (names: LiveNames) => Record<string, string>,
  candidateFactory?: CandidateEngineFactory,
  substrate: "interactive" | "atomic-batch" = "interactive",
  barrier?: LiveBarrier
) {
  const namespace = `r3_${randomUUID().replaceAll("-", "")}`;
  const observation = new LiveObservation(fixture, namespace, barrier);
  const connection = {
    host: "127.0.0.1",
    port,
    database: "raptor3_g2",
    password: "",
  };
  const pgOptions = {
    ...connection,
    user: "postgres",
    ssl: false as const,
    max: 1,
    connectionTimeoutMillis: 10_000,
  };
  const mysqlOptions = {
    ...connection,
    user: "root",
    connectionLimit: 1,
    connectTimeout: 10_000,
  };
  const pg =
    provider === "pg"
      ? watchPgPool(
          observation,
          await new PgPoolFactory({ options: pgOptions }).ownPool()
        )
      : undefined;
  const mysql =
    provider === "mysql"
      ? await new MySQLPoolFactory({ options: mysqlOptions }).ownPool()
      : undefined;
  if (fixture.afterRollback) {
    assert(pg, "Native post-rollback injection is admitted on PostgreSQL only");
    pg.on("connect", (client) => {
      const query = client.query;
      // Native control uses the promise overload; every other overload keeps
      // its original return and callback behavior.
      client.query = function (this: PoolClient, ...args: unknown[]) {
        const pending = Reflect.apply(query, this, args);
        if (args[0] !== "ROLLBACK") return pending;
        return (pending as Promise<unknown>).then(async (response) => {
          await observation.rolledBack();
          return response;
        });
      } as PoolClient["query"];
    });
  }
  const pools: { end(): Promise<void> }[] = [pg ?? mysql!];
  let peerDriver: AnyDriver | undefined;
  const write: NativeWrite = async (statement, parameters = []) => {
    if (pg) await pg.query(statement, parameters);
    else await mysql!.query(statement, parameters);
  };
  const read: NativeRead = (statement) =>
    pg ? readPostgres(pg, statement) : readMySQL(mysql!, statement);
  let bodyFailed = false;
  let bodyFailure: unknown;
  let operationFailed = false;
  let terminalFailure: unknown;
  try {
    await write(
      provider === "pg"
        ? `CREATE SCHEMA ${observation.quote(namespace)}`
        : `CREATE DATABASE ${observation.quote(namespace)} CHARACTER SET utf8mb4 COLLATE utf8mb4_bin`
    );
    const tables = definitions(observation);
    for (const [name, table] of Object.entries(fixture.tables)) {
      await write(
        `CREATE TABLE ${observation.table(table.name)} (${tables[table.name]})${provider === "mysql" ? " ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin" : ""}`
      );
      for (const row of fixture.initial[name]!) {
        // StateRows erases this fixture boundary's fixed scalar-row fields.
        const fields = Object.entries(row as Record<string, unknown>);
        const placeholders = fields.map((_, index) =>
          provider === "pg" ? `$${index + 1}` : "?"
        );
        await write(
          `INSERT INTO ${observation.table(table.name)} (${fields.map(([field]) => observation.quote(field)).join(",")}) VALUES (${placeholders.join(",")})`,
          fields.map(([, value]) => value)
        );
      }
    }
    if (barrier) {
      const peerPg = pg
        ? watchPgPool(
            observation,
            await new PgPoolFactory({ options: pgOptions }).ownPool()
          )
        : undefined;
      const peerMySQL = mysql
        ? await new MySQLPoolFactory({ options: mysqlOptions }).ownPool()
        : undefined;
      pools.push(peerPg ?? peerMySQL!);
      const peerRead: NativeRead = (statement) =>
        peerPg
          ? readPostgres(peerPg, statement)
          : readMySQL(peerMySQL!, statement);
      const identityQuery =
        provider === "pg"
          ? "SELECT pg_backend_pid() AS id"
          : "SELECT CONNECTION_ID() AS id";
      const actorConnectionId = (await read(identityQuery))[0]?.id;
      const peerConnectionId = (await peerRead(identityQuery))[0]?.id;
      assert(
        typeof actorConnectionId === "number" &&
          typeof peerConnectionId === "number",
        "Native connections must expose their actual numeric identities"
      );
      assert.notEqual(
        actorConnectionId,
        peerConnectionId,
        "External work requires a different real connection"
      );
      observation.peer = {
        namespace,
        quote: observation.quote,
        table: observation.table,
        actorConnectionId,
        peerConnectionId,
        write: async (statement, parameters = []) => {
          if (peerPg) await peerPg.query(statement, parameters);
          else await peerMySQL!.query(statement, parameters);
        },
        inspect: () => observation.inspect(peerRead),
      };
      if (fixture.actorCount === 2) {
        peerDriver = peerPg
          ? substrate === "atomic-batch"
            ? new AtomicPgDriver(peerPg, observation, "peer")
            : new ObservedPgDriver(peerPg, observation, "peer")
          : substrate === "atomic-batch"
            ? new AtomicMySQLDriver(peerMySQL!, observation, "peer")
            : new ObservedMySQLDriver(peerMySQL!, observation, "peer");
      }
    }
    assert(
      fixture.actorCount !== 2 || peerDriver,
      "Two ORM actors require the owned peer connection"
    );
    const initial = await observation.inspect(read);
    const driver = pg
      ? substrate === "atomic-batch"
        ? new AtomicPgDriver(
            pg,
            observation,
            fixture.actorCount === 2 ? "actor" : undefined
          )
        : new ObservedPgDriver(
            pg,
            observation,
            fixture.actorCount === 2 ? "actor" : undefined
          )
      : substrate === "atomic-batch"
        ? new AtomicMySQLDriver(
            mysql!,
            observation,
            fixture.actorCount === 2 ? "actor" : undefined
          )
        : new ObservedMySQLDriver(
            mysql!,
            observation,
            fixture.actorCount === 2 ? "actor" : undefined
          );
    let candidateEntries = 0;
    const tracked: CandidateEngineFactory | undefined =
      candidateFactory &&
      ((config) => {
        const engine = candidateFactory(config);
        return {
          execute(...args) {
            candidateEntries++;
            return engine.execute(...args);
          },
          prepareBatch(...args) {
            candidateEntries++;
            return engine.prepareBatch(...args);
          },
        };
      });
    let outcome: RunObservation["outcome"];
    try {
      outcome = {
        kind: "success",
        value: await fixture.invoke(driver, tracked, peerDriver),
      };
    } catch (failure) {
      operationFailed = true;
      terminalFailure = failure;
      outcome = { kind: "failure", failure: observeFailure(failure) };
    }
    const observed: RunObservation = {
      outcome,
      initial,
      final: await observation.inspect(read),
      defaults: [],
      reachedCuts: observation.reachedCuts,
    };
    return {
      fixture,
      observation: observed,
      provider: liveProvider,
      namespace,
      candidateEntries,
      statements: observation.statements,
      completions: observation.completions,
      batchFailures: observation.failedBatches.map((batch) => batch.failure),
      failedBatches: observation.failedBatches,
      rollbacks: observation.rollbacks,
      terminalFailure,
      connections: observation.peer && {
        actor: observation.peer.actorConnectionId,
        peer: observation.peer.peerConnectionId,
      },
      assertHealthy() {
        observation.assertHealthy();
        assert.equal(
          candidateEntries,
          candidateFactory
            ? (fixture.expectedExecutions ?? fixture.actorCount ?? 1)
            : 0,
          "live candidate entry count"
        );
      },
    };
  } catch (failure) {
    bodyFailed = true;
    bodyFailure = failure;
    throw failure;
  } finally {
    // Start both closes even if one rejects; neither borrowed driver owns them.
    const closed = await Promise.allSettled(pools.map((pool) => pool.end()));
    let closeFailed = false;
    let closeFailure: unknown;
    for (const outcome of closed) {
      if (outcome.status !== "rejected") continue;
      closeFailure = closeFailed
        ? withSuppressedFailure(closeFailure, outcome.reason)
        : outcome.reason;
      closeFailed = true;
    }
    if (closeFailed) {
      if (bodyFailed) throw withSuppressedFailure(bodyFailure, closeFailure);
      if (operationFailed)
        throw withSuppressedFailure(terminalFailure, closeFailure);
      throw closeFailure;
    }
    // Nothing else failed, so a background transport failure has no other way
    // out: the last `assertHealthy()` may have run before the pool died.
    if (!bodyFailed && observation.backgroundTransportFailure)
      throw observation.backgroundTransportFailure.cause;
  }
}
