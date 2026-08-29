/**
 * Shared migration-estate test helpers.
 *
 * Not a suite: `_`-prefixed support module for the migration suites.
 */

import type { DatabaseAdapter } from "@adapters/database-adapter";
import { MySQLAdapter } from "@adapters/databases/mysql/mysql-adapter";
import { PostgresAdapter } from "@adapters/databases/postgres/postgres-adapter";
import { SQLiteAdapter } from "@adapters/databases/sqlite/sqlite-adapter";
import { Driver } from "@drivers/driver";
import type { PinnedSessionReservation } from "@drivers/shared";
import type { Dialect, QueryResult } from "@drivers/types";
import type { DDLContext } from "@migrations/drivers";
import type { Sha256 } from "@migrations/identity";
import type { PublishResult } from "@migrations/storage/contract";
import { MemoryEstateStorage } from "@migrations/storage/memory";
import type { SchemaSnapshot } from "@migrations/types";

const EXISTS_PROBE = /EXISTS/i;

/**
 * The ONE way suites build a `DDLContext`.
 *
 * `destination` is required on the type, so every renderer call has to state
 * where its statement is going. Funnelling that through one helper is what
 * keeps ~160 call sites from each inventing their own answer, and it means a
 * suite that wants to pin artifact-versus-live rendering flips one argument.
 */
export function ddlContext(
  destination: "artifact" | "live",
  rest: Omit<DDLContext, "destination"> = {}
): DDLContext {
  return { destination, ...rest };
}

/** A DDL context carrying a current schema, for table-recreation renderers. */
export function ddlContextFor(
  destination: "artifact" | "live",
  currentSchema: SchemaSnapshot
): DDLContext {
  return { destination, currentSchema };
}

/**
 * A stock adapter viewed as one bound to `namespace`.
 *
 * Driver options own this fact in shipped code, and the fact is installed
 * non-writably, so a suite cannot rebind a constructed adapter — it builds
 * another one. Delegating to a stock instance and OWNING the namespace is
 * exactly what a custom adapter does, and it is the only construction that
 * expresses "this adapter declares this namespace" (or, with `undefined`,
 * "declares none") independently of how the stock adapter is constructed.
 */
function adapterBoundTo(
  adapter: DatabaseAdapter,
  namespace: string | undefined
): DatabaseAdapter {
  const bound: DatabaseAdapter = Object.create(adapter);
  Object.defineProperty(bound, "namespace", {
    value: namespace,
    enumerable: true,
  });
  return bound;
}

/**
 * A driver that records every statement it is asked to run and answers from a
 * caller-supplied table.
 *
 * The point of most estate falsifiers is what a command does NOT do — connect,
 * lock, create a tracking table — so the recording is the assertion surface.
 */
export class RecordingDriver extends Driver<{ tag: "client" }, { tag: "tx" }> {
  readonly adapter: DatabaseAdapter;
  readonly statements: string[] = [];
  readonly parameters: unknown[][] = [];
  /**
   * The producer object each statement actually ran on, in order.
   *
   * A pinned migration session's whole claim is that the lock, the
   * authoritative reads, the DDL and the unlock share ONE physical producer, so
   * a suite has to be able to see which one each statement used.
   */
  readonly producers: unknown[] = [];
  /** Every pinned-session reservation and how it ended. */
  readonly sessions: string[] = [];
  /** Answers a statement with rows, or throws the returned Error. */
  respond: (sql: string, params: unknown[]) => unknown[] | Error = () => [];
  /**
   * Simulated provider answers for the two lock statements.
   *
   * A recording driver stands in for a provider that supports session locks, so
   * it answers them itself — otherwise every locked command would fail its
   * acquisition proof. Overriding one arm is how a suite exercises the refusals:
   * a timeout, a `NULL`, a malformed row, or an unproven release.
   */
  lockAnswers: { acquire?: unknown[] | Error; release?: unknown[] | Error } =
    {};

  constructor(
    dialect: Dialect,
    driverName: string,
    adapter: DatabaseAdapter,
    // The base constructor owns the attestation and installs it immutably, so
    // a test driver carries it the only way a shipped custom driver can: by
    // handing the literal to `super`, never by redefining the installed fact.
    attestation?: "non-redirecting"
  ) {
    super(dialect, driverName, {}, attestation);
    this.adapter = adapter;
  }

  protected initClient(): Promise<{ tag: "client" }> {
    this.statements.push("<connect>");
    this.parameters.push([]);
    return Promise.resolve({ tag: "client" });
  }

  protected closeClient(): Promise<void> {
    return Promise.resolve();
  }

  protected execute<T>(
    client: unknown,
    sql: string,
    params: unknown[]
  ): Promise<QueryResult<T>> {
    return this.run<T>(client, sql, params);
  }

  protected executeRaw<T>(
    client: unknown,
    sql: string,
    params?: unknown[]
  ): Promise<QueryResult<T>> {
    return this.run<T>(client, sql, params ?? []);
  }

  protected transaction<T>(
    _client: unknown,
    fn: (tx: { tag: "tx" }) => Promise<T>
  ): Promise<T> {
    this.statements.push("<begin>");
    this.parameters.push([]);
    return fn({ tag: "tx" });
  }

  /**
   * One reserved producer, as a shipped driver reserves one connection.
   *
   * The reserved object is fresh per reservation, so `producers` distinguishes
   * "the pinned session" from "whatever the pool handed out".
   */
  protected override pinnedSession(): Promise<
    PinnedSessionReservation<{ tag: "client" } | { tag: "tx" }>
  > {
    const session: { tag: "tx" } = { tag: "tx" };
    this.sessions.push("reserve");
    return Promise.resolve({
      session,
      release: (discard) => {
        this.sessions.push(discard ? "destroy" : "release");
        return Promise.resolve();
      },
    });
  }

  private run<T>(
    client: unknown,
    sql: string,
    params: unknown[]
  ): Promise<QueryResult<T>> {
    this.statements.push(sql);
    this.parameters.push([...params]);
    this.producers.push(client);
    const simulated = this.simulateLockAnswer(sql);
    let answer =
      simulated === undefined ? this.respond(sql, params) : simulated;
    if (
      !(answer instanceof Error) &&
      sql.includes("AS attached") &&
      !(
        answer.length === 1 &&
        typeof answer[0] === "object" &&
        answer[0] !== null &&
        Object.hasOwn(answer[0], "attached")
      )
    ) {
      answer = [{ attached: 0 }];
    }
    if (!(answer instanceof Error) && answer.length === 0) {
      const catalog = controlCatalogAnswer(sql, params, {
        state: false,
        log: false,
      });
      if (catalog) answer = catalog;
    }
    if (answer instanceof Error) {
      return Promise.reject(answer);
    }
    const rows: T[] = [];
    for (const row of answer) {
      rows.push(readRow<T>(row));
    }
    return Promise.resolve({ rows, rowCount: rows.length });
  }

  /** The provider answer for a lock statement, or undefined for anything else. */
  private simulateLockAnswer(sql: string): unknown[] | Error | undefined {
    if (sql.includes("pg_advisory_lock") || sql.includes("GET_LOCK")) {
      return (
        this.lockAnswers.acquire ??
        (this.dialect === "mysql" ? [{ acquired: 1 }] : [{ acquired: "" }])
      );
    }
    if (sql.includes("pg_advisory_unlock") || sql.includes("RELEASE_LOCK")) {
      return (
        this.lockAnswers.release ??
        (this.dialect === "mysql" ? [{ released: 1 }] : [{ released: true }])
      );
    }
    return undefined;
  }
}

/** Provider rows are untyped fixture data by construction. */
function readRow<T>(row: unknown): T {
  const typed: T = Object.assign(Object.create(null), row);
  return typed;
}

/** A PostgreSQL recording driver bound to one schema. */
export function pgEstateDriver(namespace: string): RecordingDriver {
  return new RecordingDriver(
    "postgresql",
    "pg",
    adapterBoundTo(new PostgresAdapter(), namespace)
  );
}

/**
 * A PostgreSQL recording driver whose adapter declares NO namespace — the
 * custom-adapter case the estate resolver refuses.
 */
export function pgUnprovenDriver(): RecordingDriver {
  return new RecordingDriver(
    "postgresql",
    "pg",
    adapterBoundTo(new PostgresAdapter(), undefined)
  );
}

/** A MySQL recording driver, optionally bound and optionally attested. */
export function mysqlEstateDriver(options: {
  namespace?: string;
  attested?: boolean;
}): RecordingDriver {
  return new RecordingDriver(
    "mysql",
    "mysql2",
    adapterBoundTo(new MySQLAdapter(), options.namespace),
    options.attested ? "non-redirecting" : undefined
  );
}

/**
 * Answer a control-table catalog EXISTS probe.
 * Table names are parameters, not SQL text.
 */
export function controlCatalogAnswer(
  sql: string,
  params: unknown[],
  presence: { readonly state: boolean; readonly log: boolean }
): unknown[] | undefined {
  if (!EXISTS_PROBE.test(sql)) return undefined;
  if (
    !(
      sql.includes("pg_class") ||
      sql.includes("information_schema.tables") ||
      sql.includes("sqlite_master")
    )
  ) {
    return undefined;
  }
  const name = String(params.at(-1) ?? "");
  if (name.endsWith("_state")) return [{ exists: presence.state ? 1 : 0 }];
  if (name.endsWith("_log")) return [{ exists: presence.log ? 1 : 0 }];
  return [{ exists: 0 }];
}

/** Answers SQLite introspection for the exact reserved control-table shapes. */
export function sqliteControlDefinitionAnswer(
  sql: string,
  presence: { readonly state: boolean; readonly log: boolean }
): unknown[] | undefined {
  const definitions = [
    ...(presence.state
      ? [
          {
            name: "_viborm_migration_state",
            sql: "CREATE TABLE _viborm_migration_state (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), payload TEXT NOT NULL)",
          },
        ]
      : []),
    ...(presence.log
      ? [
          {
            name: "_viborm_migration_log",
            sql: "CREATE TABLE _viborm_migration_log (event_id TEXT PRIMARY KEY, attempt_id TEXT NOT NULL, kind TEXT NOT NULL, payload TEXT NOT NULL)",
          },
        ]
      : []),
  ];
  if (
    sql.includes("SELECT name, sql") &&
    sql.includes("FROM sqlite_master") &&
    sql.includes("type = 'table'")
  ) {
    return definitions;
  }
  if (
    sql.includes("SELECT sql FROM sqlite_master") &&
    sql.includes("type = 'table'")
  ) {
    return definitions
      .filter((definition) => definition.name.endsWith("_state"))
      .map(({ sql: definition }) => ({ sql: definition }));
  }
  const table = sql.includes("_viborm_migration_state")
    ? "state"
    : sql.includes("_viborm_migration_log")
      ? "log"
      : undefined;
  if (sql.startsWith("PRAGMA table_info") && table === "state") {
    return [
      {
        cid: 0,
        name: "singleton",
        type: "INTEGER",
        notnull: 0,
        dflt_value: null,
        pk: 1,
      },
      {
        cid: 1,
        name: "payload",
        type: "TEXT",
        notnull: 1,
        dflt_value: null,
        pk: 0,
      },
    ];
  }
  if (sql.startsWith("PRAGMA table_info") && table === "log") {
    return ["event_id", "attempt_id", "kind", "payload"].map((name, index) => ({
      cid: index,
      name,
      type: "TEXT",
      notnull: index === 0 ? 0 : 1,
      dflt_value: null,
      pk: index === 0 ? 1 : 0,
    }));
  }
  if (
    sql.startsWith("PRAGMA index_list") ||
    sql.startsWith("PRAGMA foreign_key_list") ||
    (sql.includes("FROM sqlite_master") && sql.includes("type = 'index'"))
  ) {
    return [];
  }
  return undefined;
}

/** A SQLite recording driver. SQLite estates have no namespace at all. */
export function sqliteEstateDriver(): RecordingDriver {
  return new RecordingDriver(
    "sqlite",
    "sqlite3",
    adapterBoundTo(new SQLiteAdapter(), undefined)
  );
}

/**
 * The D1 substrate: a SQLite driver with no transaction that executes a
 * migration as ONE native batch.
 *
 * The pair matters, not either half. A batch is one round trip, so
 * `PRAGMA foreign_keys=OFF` has to travel inside it — where SQLite documents it
 * as a no-op — and there is no outside to lift it to. That is what makes a
 * relation-bearing table recreation unsafe here, and it is the exact shape
 * `D1Driver` declares (`supportsTransactions = false`, `supportsBatch = true`).
 */
class BatchOnlySqliteDriver extends RecordingDriver {
  override readonly supportsTransactions = false;
  override readonly supportsBatch = true;
}

export function d1EstateDriver(): RecordingDriver {
  return new BatchOnlySqliteDriver(
    "sqlite",
    "d1",
    adapterBoundTo(new SQLiteAdapter(), undefined)
  );
}

/** In-memory estate storage that records every semantic read and write. */
export class MemoryStorage extends MemoryEstateStorage {
  readonly reads: string[] = [];
  readonly writes: string[] = [];

  override async readEstate(): Promise<Uint8Array | null> {
    this.reads.push("estate");
    return super.readEstate();
  }

  override async publishEstate(bytes: Uint8Array): Promise<PublishResult> {
    this.writes.push("estate");
    return super.publishEstate(bytes);
  }

  override async publishSnapshot(
    hash: Sha256,
    bytes: Uint8Array
  ): Promise<PublishResult> {
    this.writes.push(`snapshots/${hash}`);
    return super.publishSnapshot(hash, bytes);
  }

  override async publishSql(
    hash: Sha256,
    bytes: Uint8Array
  ): Promise<PublishResult> {
    this.writes.push(`sql/${hash}`);
    return super.publishSql(hash, bytes);
  }

  override async publishState(
    id: Sha256,
    bytes: Uint8Array
  ): Promise<PublishResult> {
    this.writes.push(`states/${id}`);
    return super.publishState(id, bytes);
  }
}
