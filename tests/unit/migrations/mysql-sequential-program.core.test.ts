/**
 * MySQL's ONE commit model, on every command that changes live state (§3.5,
 * §6.2).
 *
 * MySQL commits DDL as each statement runs. Two consequences, both falsified
 * here:
 *
 * 1. No transaction is opened around it. `BEGIN` → `CREATE TABLE` (which
 *    commits, and the `BEGIN` with it) → the tracking write, now in autocommit
 *    → a `COMMIT` with nothing left to commit is not atomicity; it is the
 *    APPEARANCE of atomicity, and push, force-reset and down all manufactured
 *    it. PostgreSQL keeps its real transaction, which is the control.
 * 2. A failure part-way through cannot be undone, so the error names the last
 *    statement that COMPLETED, states that nothing was rolled back, and makes
 *    no claim about the statement that failed. One owner answers for every
 *    MySQL sequential program: apply, ordinary push, the force-reset rebuild,
 *    down, and the reset replay (whose falsifier lives beside the other
 *    mid-reset ones in `pinned-migration-session.core.test.ts`).
 *
 * The faults are injected at the unit level because that is the only place a
 * specific statement can be made to fail on demand: a live MySQL container
 * offers no seam for "fail the SECOND drop and nothing else".
 */

import type { QueryResult } from "@drivers/types";
import { QueryError, VibORMErrorCode } from "@errors";
import { apply, down, push, reset } from "@migrations";
import { getMigrationDriver } from "@migrations/drivers";
import { planLiveNamespaceReset } from "@migrations/live-reset";
import type { MigrationClient } from "@migrations/push";
import type { MigrationEntry, MigrationJournal } from "@migrations/types";
import { s } from "@schema";
import { describe, expect, it } from "vitest";
import {
  MemoryStorage,
  mysqlEstateDriver,
  pgEstateDriver,
  RecordingDriver,
} from "./_estate";

// =============================================================================
// FIXTURES
// =============================================================================

/** Two models, so a push program has a statement BEFORE the one that fails. */
const schema = {
  org: s.model({ id: s.string().id() }).map("ns_orgs"),
  post: s.model({ id: s.string().id() }).map("ns_posts"),
};

function clientFor(driver: RecordingDriver): MigrationClient {
  return { $driver: driver, $schema: schema };
}

function entry(idx: number, name: string): MigrationEntry {
  return {
    idx,
    version: "20240101000000",
    name,
    when: 1,
    checksum: `checksum-${name}`,
    mode: "generated",
    rollback: { kind: "automatic" },
  };
}

const INIT = entry(0, "init");

function journalFor(dialect: "mysql" | "postgresql"): MigrationJournal {
  return {
    version: "3",
    target:
      dialect === "mysql"
        ? { dialect: "mysql" }
        : { dialect: "postgresql", namespace: "alpha" },
    entries: [INIT],
  };
}

interface ServerOptions {
  /** Migration names the tracking table already holds. */
  readonly applied?: readonly MigrationEntry[];
  /** Table names the reset inventory reports. */
  readonly tables?: readonly string[];
  /**
   * Catalog foreign-key rows the containment preflight reads (§5.2).
   *
   * The same rows answer both endpoints of `FOREIGN_KEYS_QUERY`, which is what
   * makes an inbound tracking reference and a cross-database reference
   * expressible against a recording driver at all.
   */
  readonly foreignKeys?: readonly Record<string, unknown>[];
  /** The one statement that fails. */
  readonly fails?: (sql: string) => boolean;
}

/**
 * A server that answers the catalog, remembers tracking writes, and fails
 * exactly one statement.
 *
 * The `SCHEMATA` arm only ever fires on MySQL; the PostgreSQL controls reach
 * this for its tracking ledger and answer their own `pg_namespace` proof first.
 * The introspection reads answer empty, so the reset drop order equals the
 * inventory order and "statement N" is a fixed, nameable position.
 */
function estateServer(
  options: ServerOptions = {}
): (sql: string, params: unknown[]) => unknown[] | Error {
  const applied = (options.applied ?? []).map((e) => ({
    name: e.name,
    checksum: e.checksum,
    applied_at: 1,
  }));
  return (sql: string, params: unknown[]): unknown[] | Error => {
    if (sql.includes("SCHEMATA")) {
      return [{ SCHEMA_NAME: "alpha" }];
    }
    if (options.fails?.(sql)) {
      return new Error("lost connection to the server during query");
    }
    if (sql.includes("TABLE_NAME AS name")) {
      return (options.tables ?? []).map((name) => ({ name }));
    }
    if (sql.includes("= 'FOREIGN KEY'")) {
      return [...(options.foreignKeys ?? [])];
    }
    // The snapshot's own table list. It answers the SAME names as the
    // inventory, because a foreign key can only reach the snapshot through a
    // table the introspection saw.
    if (sql.includes("information_schema.TABLES")) {
      return (options.tables ?? []).map((TABLE_NAME) => ({ TABLE_NAME }));
    }
    if (sql.includes("SELECT name, checksum, applied_at")) {
      return [...applied];
    }
    if (sql.startsWith("INSERT INTO")) {
      applied.push({
        name: String(params[0]),
        checksum: String(params[1]),
        applied_at: 1,
      });
      return [];
    }
    if (sql.startsWith("DELETE FROM")) {
      const index = applied.findIndex((row) => row.name === String(params[0]));
      if (index >= 0) {
        applied.splice(index, 1);
      }
      return [];
    }
    return [];
  };
}

function mysqlEstate(options: ServerOptions = {}): RecordingDriver {
  const driver = mysqlEstateDriver({ namespace: "alpha", attested: true });
  driver.respond = estateServer(options);
  return driver;
}

async function storageWith(
  journal: MigrationJournal,
  artifacts: { up?: string; down?: string } = {}
): Promise<MemoryStorage> {
  const storage = new MemoryStorage();
  await storage.writeJournal(journal);
  if (artifacts.up !== undefined) {
    await storage.writeMigration(INIT, artifacts.up);
  }
  if (artifacts.down !== undefined) {
    await storage.writeDownMigration(INIT, artifacts.down);
  }
  storage.writes.length = 0;
  storage.reads.length = 0;
  return storage;
}

/** Two statements in one artifact, so the first can complete and the second fail. */
const TWO_UP =
  "CREATE TABLE `a` (id INT);\n--> statement-breakpoint\nCREATE TABLE `b` (id INT);";
const TWO_DOWN = "DROP TABLE `b`;\n--> statement-breakpoint\nDROP TABLE `a`;";
/** The same shape in PostgreSQL's own spelling, for the control cases. */
const TWO_DOWN_PG =
  'DROP TABLE "b";\n--> statement-breakpoint\nDROP TABLE "a";';

/**
 * Every shape a transaction takes on the fixtures these commands run on.
 *
 * `<begin>` is the pooled provider transaction the generic batch dispatch would
 * open; `BEGIN`/`COMMIT` are the literal statements a PINNED session's
 * transaction issues on its reserved producer.
 */
const TRANSACTION_MARKERS = new Set(["<begin>", "BEGIN", "COMMIT"]);

function transactionMarkersIn(driver: RecordingDriver): string[] {
  return driver.statements.filter((sql) => TRANSACTION_MARKERS.has(sql));
}

/** The boundary a push program names is DDL, never the plan's catalog reads. */
const CREATE_TABLE = /^CREATE TABLE/;
/** The boundary an apply program names when the TRACKING write completed last. */
const TRACKING_INSERT = /^INSERT INTO/;

const NO_ROLLBACK = "NOTHING was rolled back";
const NO_CLAIM =
  "makes no claim about whether the statement that failed took effect";

function messageOf(failure: unknown): string {
  return failure instanceof Error ? failure.message : String(failure);
}

/** The sentence that only a program which reached a durable effect may say. */
const PARTIAL_COMMIT = "failed partway through";

/**
 * Every statement that CHANGES the estate.
 *
 * The refusals below are decided from catalog reads alone, so the assertion
 * that matters is that none of these ran: a refusal reported as a partial
 * commit is a lie only because the estate is in fact untouched.
 */
const MUTATION =
  /^\s*(?:CREATE|DROP|ALTER|DELETE|INSERT|UPDATE|TRUNCATE|RENAME)\b/i;

function mutationsIn(driver: RecordingDriver): string[] {
  return driver.statements.filter((sql) => MUTATION.test(sql));
}

/**
 * One catalog foreign-key row, in the shape `FOREIGN_KEYS_QUERY` projects.
 *
 * Both schemas default to the estate's own, so a test names only the endpoint
 * it is falsifying.
 */
function foreignKeyRow(fk: {
  table: string;
  constraint: string;
  referencedTable: string;
  referencedSchema?: string;
}): Record<string, unknown> {
  return {
    TABLE_SCHEMA: "alpha",
    TABLE_NAME: fk.table,
    CONSTRAINT_NAME: fk.constraint,
    COLUMN_NAME: "ref_id",
    REFERENCED_TABLE_SCHEMA: fk.referencedSchema ?? "alpha",
    REFERENCED_TABLE_NAME: fk.referencedTable,
    REFERENCED_COLUMN_NAME: "id",
    DELETE_RULE: "NO ACTION",
    UPDATE_RULE: "NO ACTION",
    ORDINAL_POSITION: 1,
  };
}

// =============================================================================
// NO MANUFACTURED ATOMICITY
// =============================================================================

describe("MySQL live DDL runs in no transaction at all", () => {
  it("ordinary push executes sequentially on the pinned producer", async () => {
    const driver = mysqlEstate();

    const result = await push(clientFor(driver), { force: true });

    expect(result.applied).toBe(true);
    expect(transactionMarkersIn(driver)).toEqual([]);
    expect(
      driver.statements.filter((sql) => sql.startsWith("CREATE TABLE"))
    ).toHaveLength(2);
  });

  it("force-reset clears and rebuilds sequentially", async () => {
    const driver = mysqlEstate({ tables: ["ns_orgs"] });

    const result = await push(clientFor(driver), {
      force: true,
      forceReset: true,
    });

    expect(result.applied).toBe(true);
    expect(transactionMarkersIn(driver)).toEqual([]);
    expect(driver.statements).toContain(
      "DROP TABLE IF EXISTS `alpha`.`ns_orgs`"
    );
  });

  it("down executes its group sequentially", async () => {
    const driver = mysqlEstate({ applied: [INIT] });
    const storage = await storageWith(journalFor("mysql"), {
      down: TWO_DOWN,
    });

    const result = await down(clientFor(driver), {
      storageDriver: storage,
      steps: 1,
    });

    expect(result.rolledBack.map((e) => e.name)).toEqual(["init"]);
    expect(transactionMarkersIn(driver)).toEqual([]);
    // The tracking row is still removed only AFTER the artifact completed.
    const dropped = driver.statements.indexOf("DROP TABLE `a`;");
    const untracked = driver.statements.findIndex((sql) =>
      sql.startsWith("DELETE FROM")
    );
    expect(dropped).toBeGreaterThanOrEqual(0);
    expect(untracked).toBeGreaterThan(dropped);
  });

  it("keeps the PostgreSQL transaction, which is real there", async () => {
    // The control. PostgreSQL DDL is transactional, so `down` still rolls its
    // whole group and its tracking deletes back as one unit.
    const driver = pgEstateDriver("alpha");
    driver.respond = (sql: string, params: unknown[]) =>
      sql.includes("pg_namespace")
        ? [{ present: 1 }]
        : estateServer({ applied: [INIT] })(sql, params);
    const storage = await storageWith(journalFor("postgresql"), {
      down: TWO_DOWN_PG,
    });

    await down(clientFor(driver), { storageDriver: storage, steps: 1 });

    expect(driver.statements).toContain("BEGIN");
    expect(driver.statements).toContain("COMMIT");
  });
});

// =============================================================================
// THE COMMITTED BOUNDARY
// =============================================================================

describe("a failed MySQL program reports the boundary it reached", () => {
  it("apply names the last completed artifact statement", async () => {
    const driver = mysqlEstate({ fails: (sql) => sql.includes("`b`") });
    const storage = await storageWith(journalFor("mysql"), { up: TWO_UP });

    const failure = await apply(clientFor(driver), {
      storageDriver: storage,
    }).catch((error: unknown) => error);

    expect(failure).toMatchObject({
      code: VibORMErrorCode.MIGRATION_FAILED,
      meta: { migrationName: "init" },
    });
    const message = messageOf(failure);
    expect(message).toContain(
      "The last statement that completed was: CREATE TABLE `a` (id INT);"
    );
    expect(message).toContain(NO_ROLLBACK);
    expect(message).toContain(NO_CLAIM);
    // The first statement committed and cannot be taken back, so no tracking
    // row claims the entry applied and the portable estate is byte-identical.
    expect(driver.statements.filter((sql) => sql.startsWith("INSERT"))).toEqual(
      []
    );
    expect(storage.writes).toEqual([]);
  });

  it("apply names the artifact when the TRACKING write is what failed", async () => {
    // The other half of the same truth: the artifact committed, and the row
    // that records it did not. Nothing rolled back, and the caller was
    // previously told only that an INSERT failed.
    const driver = mysqlEstate({
      fails: (sql) => sql.startsWith("INSERT INTO"),
    });
    const storage = await storageWith(journalFor("mysql"), {
      up: "CREATE TABLE `a` (id INT);",
    });

    const failure = await apply(clientFor(driver), {
      storageDriver: storage,
    }).catch((error: unknown) => error);

    expect(messageOf(failure)).toContain(
      "The last statement that completed was: CREATE TABLE `a` (id INT);"
    );
    expect(messageOf(failure)).toContain(NO_ROLLBACK);
  });

  it("ordinary push names the last completed DDL statement", async () => {
    const driver = mysqlEstate({ fails: (sql) => sql.includes("ns_posts") });

    const failure = await push(clientFor(driver), { force: true }).catch(
      (error: unknown) => error
    );

    const failedIndex = driver.statements.findIndex((sql) =>
      sql.includes("ns_posts")
    );
    const boundary = driver.statements[failedIndex - 1];
    expect(boundary).toMatch(CREATE_TABLE);
    const message = messageOf(failure);
    expect(message).toContain(
      `The last statement that completed was: ${boundary}`
    );
    expect(message).toContain(NO_ROLLBACK);
    expect(failure).toMatchObject({ code: VibORMErrorCode.MIGRATION_FAILED });
  });

  it("force-reset names the last completed drop", async () => {
    const driver = mysqlEstate({
      tables: ["_viborm_migrations", "ns_orgs", "ns_posts"],
      fails: (sql) => sql.includes("ns_posts`"),
    });

    const failure = await push(clientFor(driver), {
      force: true,
      forceReset: true,
    }).catch((error: unknown) => error);

    const message = messageOf(failure);
    expect(message).toContain(
      "The last statement that completed was: DROP TABLE IF EXISTS `alpha`.`ns_orgs`"
    );
    expect(message).toContain(NO_ROLLBACK);
    expect(message).toContain(NO_CLAIM);
  });

  it("force-reset names the last completed REBUILD statement too", async () => {
    // The clear already reported its own boundary; the rebuild after it did
    // not, so a force-reset that emptied the database and then failed to
    // rebuild it said only that a `CREATE TABLE` failed. One program, one
    // report — which is why the scope is the whole thing and not either half.
    const driver = mysqlEstate({
      tables: ["ns_orgs"],
      fails: (sql) =>
        sql.startsWith("CREATE TABLE") && sql.includes("ns_posts"),
    });

    const failure = await push(clientFor(driver), {
      force: true,
      forceReset: true,
    }).catch((error: unknown) => error);

    const failedIndex = driver.statements.findIndex(
      (sql) => sql.startsWith("CREATE TABLE") && sql.includes("ns_posts")
    );
    const boundary = driver.statements[failedIndex - 1];
    expect(boundary).toMatch(CREATE_TABLE);
    const message = messageOf(failure);
    expect(message).toContain(
      `The last statement that completed was: ${boundary}`
    );
    expect(message).toContain(NO_ROLLBACK);
    // The estate it just dropped is gone and stays gone: no rollback claim.
    expect(driver.statements).toContain(
      "DROP TABLE IF EXISTS `alpha`.`ns_orgs`"
    );
  });

  it("down names the last completed down statement", async () => {
    const driver = mysqlEstate({
      applied: [INIT],
      fails: (sql) => sql.includes("`a`"),
    });
    const storage = await storageWith(journalFor("mysql"), {
      down: TWO_DOWN,
    });

    const failure = await down(clientFor(driver), {
      storageDriver: storage,
      steps: 1,
    }).catch((error: unknown) => error);

    const message = messageOf(failure);
    expect(message).toContain(
      "The last statement that completed was: DROP TABLE `b`;"
    );
    expect(message).toContain(NO_ROLLBACK);
    // The tracking row survives: it is removed only after its artifact, and
    // this artifact never finished.
    expect(driver.statements.filter((sql) => sql.startsWith("DELETE"))).toEqual(
      []
    );
    expect(storage.writes).toEqual([]);
  });

  it("preserves the provider's own failure under the report", async () => {
    const driver = mysqlEstate({ fails: (sql) => sql.includes("ns_posts") });

    const failure = await push(clientFor(driver), { force: true }).catch(
      (error: unknown) => error
    );

    // The report ADDS the boundary; it does not replace the cause.
    expect(failure).toMatchObject({
      originalCause: expect.objectContaining({
        code: VibORMErrorCode.QUERY_FAILED,
      }),
    });
  });

  it("leaves a PostgreSQL failure unwrapped — its transaction is the answer", async () => {
    // Disjointness: the boundary report belongs to the dialect that cannot roll
    // back. PostgreSQL's transaction restores the estate, so a report about
    // "what was committed" would describe state the database no longer holds.
    const driver = pgEstateDriver("alpha");
    driver.respond = (sql: string, params: unknown[]) => {
      if (sql.includes("pg_namespace")) {
        return [{ present: 1 }];
      }
      if (sql.includes('DROP TABLE "a"')) {
        return new Error("lost connection to the server during query");
      }
      return estateServer({ applied: [INIT] })(sql, params);
    };
    const storage = await storageWith(journalFor("postgresql"), {
      down: TWO_DOWN_PG,
    });

    const failure = await down(clientFor(driver), {
      storageDriver: storage,
      steps: 1,
    }).catch((error: unknown) => error);

    expect(failure).toMatchObject({ code: VibORMErrorCode.QUERY_FAILED });
    expect(messageOf(failure)).not.toContain(NO_ROLLBACK);
  });
});

// =============================================================================
// THE SCOPE OF THE REPORT — WHAT THE PROGRAM ACTUALLY IS
// =============================================================================

/**
 * The reporter answers for the EFFECTS, not for the decisions that precede
 * them (§6.2).
 *
 * MySQL `reset()` and `push({ forceReset: true })` used to enter the sequential
 * program and only then read the live inventory and prove containment. Both
 * containment refusals are decided from catalog reads alone and both fire
 * before the first `DELETE`/`DROP`, so the estate they refuse is untouched —
 * but the blanket reporter rewrote them as `MIGRATION_FAILED` "failed partway
 * through / NOTHING was rolled back", dropped the metadata naming the offending
 * constraint, and told the caller to inspect a database nothing had touched.
 */
describe("a containment refusal is not a partial commit", () => {
  /** A table in this estate holding a key INTO the tracking table. */
  const INBOUND_TRACKING_FK = foreignKeyRow({
    table: "ns_orgs",
    constraint: "fk_orgs_tracking",
    referencedTable: "_viborm_migrations",
  });
  /** A key whose other half lives in a database this client does not manage. */
  const CROSS_DATABASE_FK = foreignKeyRow({
    table: "ns_orgs",
    constraint: "fk_orgs_events",
    referencedTable: "ns_events",
    referencedSchema: "analytics",
  });

  it("reset() preserves the inbound tracking-key refusal", async () => {
    const driver = mysqlEstate({
      tables: ["_viborm_migrations", "ns_orgs"],
      foreignKeys: [INBOUND_TRACKING_FK],
    });
    const storage = await storageWith(journalFor("mysql"), {
      up: "CREATE TABLE `a` (id INT);",
    });

    const failure = await reset(clientFor(driver), {
      storageDriver: storage,
    }).catch((error: unknown) => error);

    expect(failure).toMatchObject({
      code: VibORMErrorCode.MIGRATION_INVALID_STATE,
      meta: {
        table: "ns_orgs",
        constraint: "fk_orgs_tracking",
        referencedTable: "_viborm_migrations",
      },
    });
    const message = messageOf(failure);
    expect(message).not.toContain(PARTIAL_COMMIT);
    expect(message).not.toContain(NO_ROLLBACK);
    expect(mutationsIn(driver)).toEqual([]);
  });

  it("reset() preserves the cross-database refusal", async () => {
    const driver = mysqlEstate({
      tables: ["_viborm_migrations", "ns_orgs"],
      foreignKeys: [CROSS_DATABASE_FK],
    });
    const storage = await storageWith(journalFor("mysql"), {
      up: "CREATE TABLE `a` (id INT);",
    });

    const failure = await reset(clientFor(driver), {
      storageDriver: storage,
    }).catch((error: unknown) => error);

    expect(failure).toMatchObject({
      code: VibORMErrorCode.MIGRATION_INVALID_STATE,
      meta: {
        dialect: "mysql",
        type: "cross-database-foreign-key",
        constraint: "fk_orgs_events",
        namespace: "alpha",
        table: "alpha.ns_orgs",
        referencedTable: "analytics.ns_events",
      },
    });
    const message = messageOf(failure);
    expect(message).not.toContain(PARTIAL_COMMIT);
    expect(message).not.toContain(NO_ROLLBACK);
    expect(mutationsIn(driver)).toEqual([]);
  });

  it("force-reset preserves the inbound tracking-key refusal", async () => {
    const driver = mysqlEstate({
      tables: ["_viborm_migrations", "ns_orgs"],
      foreignKeys: [INBOUND_TRACKING_FK],
    });

    const failure = await push(clientFor(driver), {
      force: true,
      forceReset: true,
    }).catch((error: unknown) => error);

    expect(failure).toMatchObject({
      code: VibORMErrorCode.MIGRATION_INVALID_STATE,
      meta: {
        table: "ns_orgs",
        constraint: "fk_orgs_tracking",
        referencedTable: "_viborm_migrations",
      },
    });
    const message = messageOf(failure);
    expect(message).not.toContain(PARTIAL_COMMIT);
    expect(message).not.toContain(NO_ROLLBACK);
    expect(mutationsIn(driver)).toEqual([]);
  });

  it("force-reset preserves the cross-database refusal", async () => {
    const driver = mysqlEstate({
      tables: ["_viborm_migrations", "ns_orgs"],
      foreignKeys: [CROSS_DATABASE_FK],
    });

    const failure = await push(clientFor(driver), {
      force: true,
      forceReset: true,
    }).catch((error: unknown) => error);

    expect(failure).toMatchObject({
      code: VibORMErrorCode.MIGRATION_INVALID_STATE,
      meta: {
        dialect: "mysql",
        type: "cross-database-foreign-key",
        constraint: "fk_orgs_events",
        namespace: "alpha",
        table: "alpha.ns_orgs",
        referencedTable: "analytics.ns_events",
      },
    });
    const message = messageOf(failure);
    expect(message).not.toContain(PARTIAL_COMMIT);
    expect(message).not.toContain(NO_ROLLBACK);
    expect(mutationsIn(driver)).toEqual([]);
  });
});

// =============================================================================
// THE INVENTORY IS THE DROP LIST
// =============================================================================

/**
 * A MySQL estate whose table inventory answers with exactly these rows.
 *
 * Everything else — the namespace proof, the introspection, the tracking
 * ledger, and the lock the pinned session takes — is the ordinary estate
 * driver, which is what makes this the fixture the PUBLIC composition roots
 * run on.
 */
function mysqlEstateWithInventoryRows(
  rows: readonly Record<string, unknown>[]
): RecordingDriver {
  const driver = mysqlEstate();
  const server = driver.respond;
  driver.respond = (sql: string, params: unknown[]) =>
    sql.includes("TABLE_NAME AS name") ? [...rows] : server(sql, params);
  return driver;
}

/**
 * A MySQL estate that hands inventory rows to the reader UNTOUCHED.
 *
 * The shared recording driver copies every provider row through
 * `Object.assign`, which invokes an accessor at copy time and flattens a
 * non-object row into an empty one — so a row whose `name` throws when the
 * INVENTORY reads it cannot be expressed through it at all. This driver is the
 * seam for that, and the whole row family below shares it so that one fixture
 * answers for all of them. It simulates no lock statement because
 * `planLiveNamespaceReset` issues none: its caller has already pinned and
 * locked the producer.
 */
class VerbatimInventoryDriver extends RecordingDriver {
  /** The rows the table inventory answers with, exactly as given. */
  rows: readonly unknown[] = [];

  protected override execute<T>(
    client: unknown,
    sql: string,
    params: unknown[]
  ): Promise<QueryResult<T>> {
    return this.answer<T>(client, sql, params);
  }

  protected override executeRaw<T>(
    client: unknown,
    sql: string,
    params?: unknown[]
  ): Promise<QueryResult<T>> {
    return this.answer<T>(client, sql, params ?? []);
  }

  private answer<T>(
    client: unknown,
    sql: string,
    params: unknown[]
  ): Promise<QueryResult<T>> {
    this.statements.push(sql);
    this.producers.push(client);
    const answered = sql.includes("TABLE_NAME AS name")
      ? this.rows
      : this.respond(sql, params);
    if (answered instanceof Error) {
      return Promise.reject(answered);
    }
    const rows: T[] = [];
    for (const row of answered) {
      // The point of this driver: the row reaches the reader as the provider
      // wrote it, whatever shape that is.
      rows.push(row as never);
    }
    return Promise.resolve({ rows, rowCount: rows.length });
  }
}

/**
 * A verbatim-row MySQL estate, bound to the same namespace as the others.
 *
 * It answers the two lock statements itself. The shared recording driver
 * simulates those in the layer this one replaces, and the PUBLIC roots below
 * pin and lock a producer before they plan — so answering them here is what
 * lets one verbatim fixture serve both the plan called directly and the
 * commands that reach it.
 */
function verbatimInventory(
  rows: readonly unknown[],
  options: ServerOptions = {}
): VerbatimInventoryDriver {
  const driver = new VerbatimInventoryDriver(
    "mysql",
    "mysql2",
    mysqlEstateDriver({ namespace: "alpha", attested: true }).adapter,
    "non-redirecting"
  );
  driver.rows = rows;
  const server = estateServer(options);
  driver.respond = (sql: string, params: unknown[]) => {
    if (sql.includes("GET_LOCK")) {
      return [{ acquired: 1 }];
    }
    if (sql.includes("RELEASE_LOCK")) {
      return [{ released: 1 }];
    }
    return server(sql, params);
  };
  return driver;
}

/** What `planLiveNamespaceReset` answers for these rows — a plan, or a refusal. */
function planOutcome(driver: RecordingDriver): Promise<unknown> {
  return planLiveNamespaceReset(driver, getMigrationDriver(driver), {
    trackingTable: "drop",
    trackingTableName: "_viborm_migrations",
  }).catch((error: unknown) => error);
}

/**
 * The reset inventory is the DROP LIST, not a report (§6.2).
 *
 * Every object it names is destroyed and every object it does not name
 * survives, which makes these provider rows the one result the program cannot
 * treat as advisory. A row it silently skipped took a real object off the drop
 * list, so the clear reported success over a namespace it had half-cleared and
 * the rebuild collided with what was left; a repeated name is the same defect
 * written differently — one object planned twice while another was never
 * planned at all.
 *
 * Every refusal below is decided inside the plan, from catalog reads, which is
 * why the assertion beside each one is that the estate is untouched.
 */
describe("an untrusted reset inventory refuses before the first drop", () => {
  it("refuses a row that is not an object at all — one layer down", async () => {
    // The CONTROL, not a falsifier: a non-object row never reaches the
    // inventory reader, because every driver's own result contract already
    // refuses it (`drivers/normalized-result.ts`). What matters is the same
    // thing the refusals below assert — the reset never got a shorter drop list
    // out of it — and this is where that invariant is owned.
    const driver = verbatimInventory([{ name: "ns_orgs" }, 42]);

    expect(await planOutcome(driver)).toMatchObject({
      code: VibORMErrorCode.QUERY_FAILED,
    });
    expect(mutationsIn(driver)).toEqual([]);
  });

  it("refuses a row carrying no name", async () => {
    const driver = verbatimInventory([{ name: "ns_orgs" }, {}]);

    expect(await planOutcome(driver)).toMatchObject({
      code: VibORMErrorCode.MIGRATION_INVALID_STATE,
      meta: { type: "unreadable-reset-inventory", resultIndex: 1 },
    });
    expect(mutationsIn(driver)).toEqual([]);
  });

  it("refuses a row whose name is not a string", async () => {
    const driver = verbatimInventory([{ name: "ns_orgs" }, { name: 7 }]);

    expect(await planOutcome(driver)).toMatchObject({
      code: VibORMErrorCode.MIGRATION_INVALID_STATE,
      meta: { type: "unreadable-reset-inventory", resultIndex: 1 },
    });
    expect(mutationsIn(driver)).toEqual([]);
  });

  it("refuses a row whose name is empty", async () => {
    // An empty name renders as a quoted nothing, so the statement it would
    // produce is not a drop of anything this estate holds.
    const driver = verbatimInventory([{ name: "ns_orgs" }, { name: "" }]);

    expect(await planOutcome(driver)).toMatchObject({
      code: VibORMErrorCode.MIGRATION_INVALID_STATE,
      meta: { type: "unreadable-reset-inventory", resultIndex: 1 },
    });
    expect(mutationsIn(driver)).toEqual([]);
  });

  it("refuses an inventory that names one object twice", async () => {
    const driver = verbatimInventory([
      { name: "ns_orgs" },
      { name: "ns_orgs" },
    ]);

    expect(await planOutcome(driver)).toMatchObject({
      code: VibORMErrorCode.MIGRATION_INVALID_STATE,
      meta: { type: "duplicate-reset-inventory-name", resultIndex: 1 },
    });
    expect(mutationsIn(driver)).toEqual([]);
  });

  it("normalizes a row accessor that throws, keeping its cause", async () => {
    // A provider row is the provider's object, so reading a column off it runs
    // the provider's code. Its failure is still this inventory refusing to be
    // read: the caller is owed the typed refusal it can act on, and the
    // accessor's own failure underneath it.
    const driver = verbatimInventory([
      { name: "ns_orgs" },
      {
        get name(): string {
          throw new QueryError("the provider row refuses to be read");
        },
      },
    ]);

    expect(await planOutcome(driver)).toMatchObject({
      code: VibORMErrorCode.MIGRATION_INVALID_STATE,
      meta: { type: "unreadable-reset-inventory", resultIndex: 1 },
      originalCause: expect.objectContaining({
        code: VibORMErrorCode.QUERY_FAILED,
      }),
    });
    expect(mutationsIn(driver)).toEqual([]);
  });

  it("refuses a row whose name is inherited rather than a column", async () => {
    // The drop list is a list of objects the CATALOG named, and a catalog
    // answers with columns. A `name` reached through the prototype chain is a
    // carrier's property or someone else's pollution — the row itself carries
    // no such column — so honouring it would put an object on the drop list
    // that this namespace's catalog never reported.
    const driver = verbatimInventory([
      { name: "ns_orgs" },
      Object.create({ name: "victim" }),
    ]);

    expect(await planOutcome(driver)).toMatchObject({
      code: VibORMErrorCode.MIGRATION_INVALID_STATE,
      meta: { type: "unreadable-reset-inventory", resultIndex: 1 },
    });
    expect(mutationsIn(driver)).toEqual([]);
  });

  it("refuses a row whose name comes from a polluted Object.prototype", async () => {
    // The same defect with no carrier at all: the row is an ordinary empty
    // object and the name arrives from the base prototype every object shares.
    // The property is installed non-enumerable, which is the harder case — no
    // enumeration of the row reveals it — and removed again immediately.
    const driver = verbatimInventory([{ name: "ns_orgs" }, {}]);
    Object.defineProperty(Object.prototype, "name", {
      value: "victim",
      configurable: true,
    });
    let outcome: unknown;
    try {
      outcome = await planOutcome(driver);
    } finally {
      Reflect.deleteProperty(Object.prototype, "name");
    }

    expect(outcome).toMatchObject({
      code: VibORMErrorCode.MIGRATION_INVALID_STATE,
      meta: { type: "unreadable-reset-inventory", resultIndex: 1 },
    });
    expect(mutationsIn(driver)).toEqual([]);
  });

  it("normalizes a row whose ownership check throws, keeping its cause", async () => {
    // Asking whether the row OWNS a name runs the provider's code too: a proxy
    // answers that question with a trap. Its failure is the same refusal as an
    // accessor's, under the same owner, rather than a raw trap error escaping
    // the migration boundary.
    const driver = verbatimInventory([
      { name: "ns_orgs" },
      new Proxy(
        { name: "victim" },
        {
          getOwnPropertyDescriptor(): PropertyDescriptor {
            throw new QueryError("the provider row refuses to be described");
          },
        }
      ),
    ]);

    expect(await planOutcome(driver)).toMatchObject({
      code: VibORMErrorCode.MIGRATION_INVALID_STATE,
      meta: { type: "unreadable-reset-inventory", resultIndex: 1 },
      originalCause: expect.objectContaining({
        code: VibORMErrorCode.QUERY_FAILED,
      }),
    });
    expect(mutationsIn(driver)).toEqual([]);
  });

  it("keeps a Symbol thrown by a row accessor as its cause", async () => {
    // A provider row throws whatever its author wrote, and only some authors
    // throw an `Error`. The refusal promised the caller the accessor's own
    // failure underneath it, and a value it declined to carry is a promise it
    // did not keep — so a non-`Error` becomes one deterministic `Error` that
    // holds the raw value rather than being dropped.
    const driver = verbatimInventory([
      { name: "ns_orgs" },
      {
        get name(): string {
          throw Symbol("the provider row refuses to be read");
        },
      },
    ]);

    expect(await planOutcome(driver)).toMatchObject({
      code: VibORMErrorCode.MIGRATION_INVALID_STATE,
      meta: { type: "unreadable-reset-inventory", resultIndex: 1 },
      originalCause: expect.any(Error),
    });
    expect(mutationsIn(driver)).toEqual([]);
  });

  it("keeps an unrenderable object thrown by a row accessor as its cause", async () => {
    // A null-prototype object cannot be converted to a string at all, which is
    // exactly why the normalizer never renders what it carries: the message is
    // fixed, and the thrown value travels as a cause.
    const driver = verbatimInventory([
      { name: "ns_orgs" },
      {
        get name(): string {
          throw Object.create(null);
        },
      },
    ]);

    expect(await planOutcome(driver)).toMatchObject({
      code: VibORMErrorCode.MIGRATION_INVALID_STATE,
      meta: { type: "unreadable-reset-inventory", resultIndex: 1 },
      originalCause: expect.any(Error),
    });
    expect(mutationsIn(driver)).toEqual([]);
  });

  it("normalizes a thrown value whose own `instanceof` throws", async () => {
    // The hostile case the raw test cannot survive: asking whether the thrown
    // value is an `Error` walks its prototype chain, and a proxy answers that
    // with a trap. The question itself then throws, and the raw trap failure
    // escaped in place of the typed refusal — with the estate's containment
    // report replaced by a provider error about something else entirely.
    const driver = verbatimInventory([
      { name: "ns_orgs" },
      {
        get name(): string {
          throw new Proxy(
            {},
            {
              getPrototypeOf(): object {
                throw new QueryError("the thrown value refuses to be typed");
              },
            }
          );
        },
      },
    ]);

    expect(await planOutcome(driver)).toMatchObject({
      code: VibORMErrorCode.MIGRATION_INVALID_STATE,
      meta: { type: "unreadable-reset-inventory", resultIndex: 1 },
      originalCause: expect.any(Error),
    });
    expect(mutationsIn(driver)).toEqual([]);
  });

  it("reset() refuses a row whose name is inherited", async () => {
    // The plan's refusals reach the public roots unchanged, on the fixture that
    // hands the rows through untouched — which is the only way an inherited
    // name survives as far as the inventory reader.
    const driver = verbatimInventory(
      [{ name: "ns_orgs" }, Object.create({ name: "victim" })],
      { applied: [INIT] }
    );
    const storage = await storageWith(journalFor("mysql"), {
      up: "CREATE TABLE `a` (id INT);",
    });

    const failure = await reset(clientFor(driver), {
      storageDriver: storage,
    }).catch((error: unknown) => error);

    expect(failure).toMatchObject({
      code: VibORMErrorCode.MIGRATION_INVALID_STATE,
      meta: { type: "unreadable-reset-inventory", resultIndex: 1 },
    });
    expect(messageOf(failure)).not.toContain(PARTIAL_COMMIT);
    expect(mutationsIn(driver)).toEqual([]);
  });

  it("force-reset refuses a row whose name is inherited", async () => {
    const driver = verbatimInventory([
      { name: "ns_orgs" },
      Object.create({ name: "victim" }),
    ]);

    const failure = await push(clientFor(driver), {
      force: true,
      forceReset: true,
    }).catch((error: unknown) => error);

    expect(failure).toMatchObject({
      code: VibORMErrorCode.MIGRATION_INVALID_STATE,
      meta: { type: "unreadable-reset-inventory", resultIndex: 1 },
    });
    expect(messageOf(failure)).not.toContain(PARTIAL_COMMIT);
    expect(mutationsIn(driver)).toEqual([]);
  });

  it("reset() refuses an inventory row it cannot read", async () => {
    const driver = mysqlEstateWithInventoryRows([{ name: "ns_orgs" }, {}]);
    const storage = await storageWith(journalFor("mysql"), {
      up: "CREATE TABLE `a` (id INT);",
    });

    const failure = await reset(clientFor(driver), {
      storageDriver: storage,
    }).catch((error: unknown) => error);

    expect(failure).toMatchObject({
      code: VibORMErrorCode.MIGRATION_INVALID_STATE,
      meta: { type: "unreadable-reset-inventory", resultIndex: 1 },
    });
    const message = messageOf(failure);
    expect(message).not.toContain(PARTIAL_COMMIT);
    expect(message).not.toContain(NO_ROLLBACK);
    expect(mutationsIn(driver)).toEqual([]);
  });

  it("force-reset refuses an inventory that names one object twice", async () => {
    const driver = mysqlEstateWithInventoryRows([
      { name: "ns_orgs" },
      { name: "ns_orgs" },
    ]);

    const failure = await push(clientFor(driver), {
      force: true,
      forceReset: true,
    }).catch((error: unknown) => error);

    expect(failure).toMatchObject({
      code: VibORMErrorCode.MIGRATION_INVALID_STATE,
      meta: { type: "duplicate-reset-inventory-name", resultIndex: 1 },
    });
    const message = messageOf(failure);
    expect(message).not.toContain(PARTIAL_COMMIT);
    expect(message).not.toContain(NO_ROLLBACK);
    expect(mutationsIn(driver)).toEqual([]);
  });
});

// =============================================================================
// APPLY'S DURABLE PROGRAM
// =============================================================================

/**
 * `apply()` creates the tracking table DURABLY, so everything from that
 * statement onward belongs to the same sequential program (§6.2).
 *
 * It used to create the table outside the reporter, and then discover the rest
 * of its inputs: the applied-state read, the artifact, its classification. A
 * failure in any of them changed the schema and reported an ordinary error, so
 * the caller was told a `CREATE TABLE` had not happened. The order is now the
 * one the estate can defend — everything answerable WITHOUT an effect is
 * answered first, and the first effect opens the one scope that reports the
 * boundary it reached.
 */
describe("apply's tracking table and the effects after it are one program", () => {
  it("refuses an unreadable applied state BEFORE creating the tracking table", async () => {
    const driver = mysqlEstate({
      fails: (sql) => sql.startsWith("SELECT name, checksum, applied_at"),
    });
    const storage = await storageWith(journalFor("mysql"), {
      up: "CREATE TABLE `a` (id INT);",
    });

    const failure = await apply(clientFor(driver), {
      storageDriver: storage,
    }).catch((error: unknown) => error);

    // A genuine no-effect refusal: it is NOT dressed as a partial commit,
    // because there is no partial anything.
    expect(mutationsIn(driver)).toEqual([]);
    const message = messageOf(failure);
    expect(message).not.toContain(PARTIAL_COMMIT);
    expect(message).not.toContain(NO_ROLLBACK);
    expect(storage.writes).toEqual([]);
  });

  it("refuses a missing artifact BEFORE creating the tracking table", async () => {
    const driver = mysqlEstate();
    const storage = await storageWith(journalFor("mysql"));

    const failure = await apply(clientFor(driver), {
      storageDriver: storage,
    }).catch((error: unknown) => error);

    expect(failure).toMatchObject({
      code: VibORMErrorCode.MIGRATION_FILE_NOT_FOUND,
      meta: { migrationName: "init" },
    });
    expect(mutationsIn(driver)).toEqual([]);
    expect(messageOf(failure)).not.toContain(PARTIAL_COMMIT);
  });

  it("refuses an unsafe artifact BEFORE creating the tracking table", async () => {
    // Classification is a decision about a file, so it owes the estate nothing
    // and must cost it nothing.
    const driver = mysqlEstate();
    const storage = await storageWith(journalFor("mysql"), {
      up: "CREATE TABLE `a` (id INT);\n--> statement-breakpoint\nCOMMIT;",
    });

    const failure = await apply(clientFor(driver), {
      storageDriver: storage,
    }).catch((error: unknown) => error);

    expect(failure).toMatchObject({
      code: VibORMErrorCode.MIGRATION_INVALID_STATE,
      meta: { migrationName: "init" },
    });
    expect(mutationsIn(driver)).toEqual([]);
    expect(messageOf(failure)).not.toContain(PARTIAL_COMMIT);
  });

  it("reports the durable boundary when applied state stops reading mid-program", async () => {
    // The mandated shape: the tracking table is created, an entry commits, and
    // the NEXT authoritative read fails. Nothing rolls back, so the caller is
    // owed the boundary — not a bare provider error about a SELECT.
    let appliedReads = 0;
    const driver = mysqlEstate({
      fails: (sql) => {
        if (!sql.startsWith("SELECT name, checksum, applied_at")) {
          return false;
        }
        appliedReads += 1;
        return appliedReads > 1;
      },
    });
    const storage = await storageWith(journalFor("mysql"), {
      up: "CREATE TABLE `a` (id INT);",
    });

    const failure = await apply(clientFor(driver), {
      storageDriver: storage,
    }).catch((error: unknown) => error);

    // The applied-state read that FAILED is the last one recorded, and the
    // statement before it is the boundary the report has to name.
    const reads = driver.statements
      .map((sql, index) => ({ sql, index }))
      .filter(({ sql }) => sql.startsWith("SELECT name, checksum, applied_at"));
    const failedIndex = reads.at(-1)?.index ?? 0;
    const boundary = driver.statements[failedIndex - 1];
    expect(boundary).toMatch(TRACKING_INSERT);

    expect(failure).toMatchObject({ code: VibORMErrorCode.MIGRATION_FAILED });
    const message = messageOf(failure);
    expect(message).toContain(
      `The last statement that completed was: ${boundary}`
    );
    expect(message).toContain(NO_ROLLBACK);
    expect(message).toContain(NO_CLAIM);
    // ONE reporter: the report is stated exactly once, never wrapped twice.
    expect(message.split(PARTIAL_COMMIT)).toHaveLength(2);
    // The tracking table was created and nothing took it back.
    expect(
      driver.statements.some((sql) =>
        sql.startsWith("CREATE TABLE IF NOT EXISTS")
      )
    ).toBe(true);
    // The provider's own failure is still reachable underneath the report.
    expect(failure).toMatchObject({
      originalCause: expect.objectContaining({
        code: VibORMErrorCode.QUERY_FAILED,
      }),
    });
  });

  it("reports the durable boundary when the tracking CREATE is what failed", async () => {
    // The first durable statement is inside the scope, so its own failure is
    // reported by it rather than escaping as an ordinary DDL error.
    const driver = mysqlEstate({
      fails: (sql) => sql.startsWith("CREATE TABLE IF NOT EXISTS"),
    });
    const storage = await storageWith(journalFor("mysql"), {
      up: "CREATE TABLE `a` (id INT);",
    });

    const failure = await apply(clientFor(driver), {
      storageDriver: storage,
    }).catch((error: unknown) => error);

    expect(failure).toMatchObject({ code: VibORMErrorCode.MIGRATION_FAILED });
    const message = messageOf(failure);
    expect(message).toContain(NO_ROLLBACK);
    // Nothing completed before it, and the report says exactly that.
    expect(message).toContain(
      "(none — the failure came before any statement completed)"
    );
  });

  it("keeps the PostgreSQL per-entry transaction, which is the answer there", async () => {
    // The control. PostgreSQL rolls its entry back, so a boundary report would
    // describe state the database no longer holds.
    const driver = pgEstateDriver("alpha");
    driver.respond = (sql: string, params: unknown[]) => {
      if (sql.includes("pg_namespace")) {
        return [{ present: 1 }];
      }
      return estateServer({
        fails: (candidate) => candidate.includes('"a"'),
      })(sql, params);
    };
    const storage = await storageWith(journalFor("postgresql"), {
      up: 'CREATE TABLE "alpha"."a" (id INT);',
    });

    const failure = await apply(clientFor(driver), {
      storageDriver: storage,
    }).catch((error: unknown) => error);

    expect(failure).toMatchObject({
      code: VibORMErrorCode.MIGRATION_FAILED,
      meta: { migrationName: "init" },
    });
    expect(messageOf(failure)).not.toContain(NO_ROLLBACK);
  });
});
