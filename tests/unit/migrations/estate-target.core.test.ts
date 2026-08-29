/**
 * Estate target, journal v3, and live-capability admission.
 *
 * These are the falsifiers for the one claim the namespace program makes about
 * migrations: a client bound to one estate cannot consume, change, or apply
 * another's history, and it cannot reach live state without the facts that
 * prove where "live" is.
 */

import type { DatabaseAdapter } from "@adapters/database-adapter";
import { MySQLAdapter } from "@adapters/databases/mysql/mysql-adapter";
import { PostgresAdapter } from "@adapters/databases/postgres/postgres-adapter";
import {
  apply,
  createMigrationClient,
  down,
  generate,
  introspect,
  pending,
  push,
  reset,
  squash,
  status,
} from "@migrations";
import { MigrationContext } from "@migrations/context";
import { getMigrationDriver } from "@migrations/drivers";
import { libsqlMigrationDriver } from "@migrations/drivers/libsql";
import { mysqlMigrationDriver } from "@migrations/drivers/mysql";
import { postgresMigrationDriver } from "@migrations/drivers/postgres";
import { sqlite3MigrationDriver } from "@migrations/drivers/sqlite";
import type { MigrationClient } from "@migrations/push";
import {
  formatMigrationTarget,
  resolveMigrationEstate,
} from "@migrations/target";
import type {
  MigrationEntry,
  MigrationJournal,
  MigrationTarget,
  SchemaSnapshot,
} from "@migrations/types";
import { s } from "@schema";
import { describe, expect, it } from "vitest";
import {
  MemoryStorage,
  mysqlEstateDriver,
  pgEstateDriver,
  pgUnprovenDriver,
  RecordingDriver,
  sqliteEstateDriver,
} from "./_estate";

// =============================================================================
// FIXTURES
// =============================================================================

const schema = {
  user: s.model({
    id: s.string().id(),
    email: s.string().unique(),
  }),
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

function journalFor(
  target: MigrationTarget,
  entries: MigrationEntry[] = []
): MigrationJournal {
  return { version: "3", target, entries };
}

async function seedJournal(
  storage: MemoryStorage,
  journal: MigrationJournal
): Promise<void> {
  await storage.writeJournal(journal);
  storage.writes.length = 0;
  storage.reads.length = 0;
}

const EMPTY_SNAPSHOT: SchemaSnapshot = { tables: [], enums: [] };

const ALPHA: MigrationTarget = { dialect: "postgresql", namespace: "alpha" };
const BETA: MigrationTarget = { dialect: "postgresql", namespace: "beta" };
const MYSQL: MigrationTarget = { dialect: "mysql" };
const SQLITE: MigrationTarget = { dialect: "sqlite" };

const NO_ADAPTER_NAMESPACE = /exposes no adapter namespace/;
const NO_SNAPSHOT_BASELINE = /no schema snapshot/;

// =============================================================================
// TARGET RESOLUTION
// =============================================================================

describe("resolveMigrationEstate", () => {
  it("copies the adapter's schema into a frozen PostgreSQL target", () => {
    const { target } = resolveMigrationEstate(pgEstateDriver("billing"));
    expect(target).toEqual({ dialect: "postgresql", namespace: "billing" });
    expect(Object.isFrozen(target)).toBe(true);
  });

  it("refuses a PostgreSQL adapter that proves no schema, never defaulting to public", () => {
    // Every stock PostgreSQL adapter is constructed with its schema; an adapter
    // that declares none is a custom one, and generated PostgreSQL SQL cannot
    // be written for an estate nothing named.
    expect(() => resolveMigrationEstate(pgUnprovenDriver())).toThrow(
      NO_ADAPTER_NAMESPACE
    );
  });

  it("keeps MySQL and SQLite targets dialect-only", () => {
    expect(
      resolveMigrationEstate(mysqlEstateDriver({ namespace: "app" })).target
    ).toEqual(MYSQL);
    expect(resolveMigrationEstate(sqliteEstateDriver()).target).toEqual(SQLITE);
  });

  it('treats a declared namespace of "" as absent, on both families', () => {
    // §1.3's letter: an empty candidate "is not passed to identifier validation
    // as an empty candidate". No shipped constructor can produce one —
    // `normalizeNamespace` rejects "" against the identifier grammar — so this
    // is the custom-adapter seam this reader deliberately admits, and an empty
    // string has to mean exactly what a missing property means. Reading it as a
    // proven name instead would qualify every live statement with an EMPTY
    // quoted segment (`""."users"`, `` ``.`users` ``): not a wrong estate, a
    // syntax error, and one produced from a fact nothing established.
    expect(() => resolveMigrationEstate(pgEstateDriver(""))).toThrow(
      NO_ADAPTER_NAMESPACE
    );

    const mysql = resolveMigrationEstate(mysqlEstateDriver({ namespace: "" }));
    expect(mysql.target).toEqual(MYSQL);
    expect(mysql.namespace).toBeUndefined();
    // …and the bound view renders the unqualified form, not an empty qualifier.
    expect(
      getMigrationDriver(
        mysqlEstateDriver({ namespace: "" })
      ).generateDropTableSQL("users")
    ).toBe("DROP TABLE IF EXISTS `users`");
  });
});

describe("an estate description names what a command touches", () => {
  it("names the MySQL DATABASE, which its target cannot carry", () => {
    // DECISIONS N6: the destructive confirmation "must name the target
    // namespace". MySQL's estate target is namespace-free BY DESIGN, so the
    // live database has to be passed beside it — without that, the CLI's
    // `--force-reset` prompt read "This will DROP ALL TABLES in mysql", which
    // identifies nothing on the one dialect the guardrail exists for.
    const bound = getMigrationDriver(
      mysqlEstateDriver({ namespace: "app_prod", attested: true })
    );
    expect(formatMigrationTarget(bound.target, bound.namespace)).toBe(
      'mysql database "app_prod"'
    );
    // A journal target carries no database name and must not appear to.
    expect(formatMigrationTarget(MYSQL)).toBe("mysql");
    // PostgreSQL names its schema from the target itself, as it always has.
    expect(
      formatMigrationTarget({ dialect: "postgresql", namespace: "alpha" })
    ).toBe('postgresql schema "alpha"');
  });
});

// =============================================================================
// REGISTRY BINDING
// =============================================================================

describe("registry binding", () => {
  it("binds the target immutably without mutating the registered singleton", () => {
    const alpha = getMigrationDriver(pgEstateDriver("alpha"));
    const beta = getMigrationDriver(pgEstateDriver("beta"));

    expect(alpha.target).toEqual(ALPHA);
    expect(beta.target).toEqual(BETA);
    expect(Object.isFrozen(alpha)).toBe(true);
    // One implementation, two estates.
    expect(Object.getPrototypeOf(alpha)).toBe(postgresMigrationDriver);
    expect(Object.getPrototypeOf(beta)).toBe(postgresMigrationDriver);
  });

  it("leaves every registered singleton without the bound facts AT ALL", () => {
    // Not "present and undefined" — ABSENT. An ordinary optional class field
    // would install a writable, enumerable own property valued `undefined` on
    // the singleton under `useDefineForClassFields`, which `Reflect.set` could
    // then fill in: module-level state holding an active namespace, which §3.1
    // forbids. `in` is the only test that distinguishes the two shapes, and it
    // is why the three fields are `declare`.
    for (const singleton of [
      postgresMigrationDriver,
      mysqlMigrationDriver,
      sqlite3MigrationDriver,
      libsqlMigrationDriver,
    ]) {
      expect("target" in singleton).toBe(false);
      expect("executionDriver" in singleton).toBe(false);
      expect("namespace" in singleton).toBe(false);
    }
  });

  it("reads the adapter's namespace EXACTLY ONCE per bind", () => {
    // A custom adapter may expose `namespace` as an accessor. Two reads could
    // answer two different strings, and the durable target would then name one
    // estate while live DDL rendered another — the exact disagreement the
    // single read at bind exists to prevent (plan §14).
    let reads = 0;
    const drifting: DatabaseAdapter = Object.create(new PostgresAdapter());
    Object.defineProperty(drifting, "namespace", {
      get() {
        reads += 1;
        return reads === 1 ? "alpha" : "drifted";
      },
      enumerable: true,
    });

    const bound = getMigrationDriver(
      new RecordingDriver("postgresql", "pg", drifting)
    );
    expect(reads).toBe(1);
    expect(bound.target).toEqual(ALPHA);
    expect(bound.namespace).toBe("alpha");
  });

  it("reads it exactly once on the MySQL arm too, where the target carries none", () => {
    // MySQL publishes the live namespace BESIDE a namespace-free target, so it
    // is the arm where a second read is easiest to reintroduce.
    let reads = 0;
    const drifting: DatabaseAdapter = Object.create(new MySQLAdapter());
    Object.defineProperty(drifting, "namespace", {
      get() {
        reads += 1;
        return reads === 1 ? "app_prod" : "drifted";
      },
      enumerable: true,
    });

    const bound = getMigrationDriver(
      new RecordingDriver("mysql", "mysql2", drifting)
    );
    expect(reads).toBe(1);
    expect(bound.target).toEqual(MYSQL);
    expect(bound.namespace).toBe("app_prod");
  });

  it("retains the exact execution driver and its live namespace", () => {
    const driver = mysqlEstateDriver({ namespace: "app_prod" });
    const bound = getMigrationDriver(driver);
    expect(bound.executionDriver).toBe(driver);
    expect(bound.namespace).toBe("app_prod");
    expect(getMigrationDriver(mysqlEstateDriver({})).namespace).toBeUndefined();
  });

  it("binds SQLite through the same lookup", () => {
    const bound = getMigrationDriver(sqliteEstateDriver());
    expect(bound.target).toEqual(SQLITE);
    expect(Object.getPrototypeOf(bound)).toBe(sqlite3MigrationDriver);
  });
});

// =============================================================================
// THE ESTATE GATE
// =============================================================================

describe("estate gate", () => {
  function contextFor(
    driver: RecordingDriver,
    storage: MemoryStorage
  ): MigrationContext {
    return new MigrationContext(clientFor(driver), {
      storageDriver: storage,
    });
  }

  it("returns null for an absent journal without touching the provider", async () => {
    const driver = pgEstateDriver("alpha");
    const storage = new MemoryStorage();
    expect(await contextFor(driver, storage).readEstateJournal()).toBeNull();
    expect(driver.statements).toEqual([]);
  });

  it("refuses another dialect's estate with MIGRATION_DIALECT_MISMATCH", async () => {
    const storage = new MemoryStorage();
    await seedJournal(storage, journalFor(SQLITE));

    await expect(
      contextFor(pgEstateDriver("alpha"), storage).readEstateJournal()
    ).rejects.toMatchObject({ code: "V11004" });
  });

  it("refuses another PostgreSQL schema's estate with MIGRATION_INVALID_STATE", async () => {
    const storage = new MemoryStorage();
    await seedJournal(storage, journalFor(ALPHA));

    await expect(
      contextFor(pgEstateDriver("beta"), storage).readEstateJournal()
    ).rejects.toMatchObject({ code: "V11009" });
  });

  it("lets one MySQL estate deploy to two database names", async () => {
    const storage = new MemoryStorage();
    await seedJournal(storage, journalFor(MYSQL, [entry(0, "init")]));

    for (const namespace of ["app_dev", "app_prod"]) {
      const ctx = contextFor(
        mysqlEstateDriver({ namespace, attested: true }),
        storage
      );
      const journal = await ctx.readEstateJournal();
      expect(journal?.entries).toHaveLength(1);
    }
  });
});

// =============================================================================
// JOURNAL / SNAPSHOT STATE TABLE
// =============================================================================

describe("journal/snapshot consistency table", () => {
  function contextFor(storage: MemoryStorage): MigrationContext {
    return new MigrationContext(clientFor(pgEstateDriver("alpha")), {
      storageDriver: storage,
    });
  }

  it("absent + absent is a fresh estate holding no stored baseline", async () => {
    const baseline = await contextFor(new MemoryStorage()).readEstateBaseline();
    expect(baseline.journal).toBeNull();
    // `null`, not an empty snapshot: the gate reports what storage HOLDS, and
    // the empty diff input is generation's own substitution.
    expect(baseline.snapshot).toBeNull();
  });

  it("absent journal + present snapshot refuses: nothing proves the target", async () => {
    const storage = new MemoryStorage();
    await storage.writeSnapshot(EMPTY_SNAPSHOT);

    await expect(
      contextFor(storage).readEstateBaseline()
    ).rejects.toMatchObject({ code: "V11009" });
  });

  it("matching empty journal without snapshot is a valid empty estate", async () => {
    const storage = new MemoryStorage();
    await seedJournal(storage, journalFor(ALPHA));

    const baseline = await contextFor(storage).readEstateBaseline();
    expect(baseline.journal?.entries).toEqual([]);
    expect(baseline.snapshot).toBeNull();
  });

  it("matching journal with snapshot is valid", async () => {
    const storage = new MemoryStorage();
    await seedJournal(storage, journalFor(ALPHA, [entry(0, "init")]));
    await storage.writeSnapshot(EMPTY_SNAPSHOT);

    const baseline = await contextFor(storage).readEstateBaseline();
    expect(baseline.journal?.entries).toHaveLength(1);
  });

  it("matching non-empty journal without snapshot refuses: the baseline is gone", async () => {
    const storage = new MemoryStorage();
    await seedJournal(storage, journalFor(ALPHA, [entry(0, "init")]));

    await expect(contextFor(storage).readEstateBaseline()).rejects.toThrow(
      NO_SNAPSHOT_BASELINE
    );
  });

  it("a mismatched estate refuses before the snapshot is deserialized", async () => {
    const storage = new MemoryStorage();
    await seedJournal(storage, journalFor(BETA));
    storage.files.set("meta/_snapshot.json", "{ this is not json");

    await expect(
      contextFor(storage).readEstateBaseline()
    ).rejects.toMatchObject({ code: "V11009" });
    expect(storage.reads).not.toContain("meta/_snapshot.json");
  });
});

// =============================================================================
// ABSENT-JOURNAL ARMS: EXACT RESULTS, ZERO PROVIDER WORK
// =============================================================================

describe("absent-journal arms", () => {
  function estate(): {
    driver: RecordingDriver;
    storage: MemoryStorage;
    client: MigrationClient;
  } {
    const driver = pgEstateDriver("alpha");
    const storage = new MemoryStorage();
    return { driver, storage, client: clientFor(driver) };
  }

  it("apply returns empty and connects to nothing", async () => {
    const { driver, storage, client } = estate();
    expect(await apply(client, { storageDriver: storage })).toEqual({
      applied: [],
      pending: [],
    });
    expect(driver.statements).toEqual([]);
    expect(storage.writes).toEqual([]);
  });

  it("apply dry-run returns empty and connects to nothing", async () => {
    const { driver, storage, client } = estate();
    expect(
      await apply(client, { storageDriver: storage, dryRun: true })
    ).toEqual({ applied: [], pending: [] });
    expect(driver.statements).toEqual([]);
  });

  it("down returns empty WITHOUT acquiring the lock", async () => {
    const { driver, storage, client } = estate();
    expect(await down(client, { storageDriver: storage })).toEqual({
      rolledBack: [],
    });
    expect(driver.statements).toEqual([]);
  });

  it("reset returns empty and connects to nothing", async () => {
    const { driver, storage, client } = estate();
    expect(await reset(client, { storageDriver: storage })).toEqual({
      dropped: [],
      applied: [],
    });
    expect(driver.statements).toEqual([]);
  });

  it("status and pending return empty with no provider call", async () => {
    const { driver, storage, client } = estate();
    expect(await status(client, { storageDriver: storage })).toEqual([]);
    expect(await pending(client, { storageDriver: storage })).toEqual([]);
    expect(driver.statements).toEqual([]);
  });

  it("squash refuses MIGRATION_NOT_FOUND WITHOUT acquiring the lock", async () => {
    const { driver, storage, client } = estate();
    await expect(
      squash(client, { storageDriver: storage })
    ).rejects.toMatchObject({ code: "V11002" });
    expect(driver.statements).toEqual([]);
  });

  it("apply() on a MISMATCHED estate stops before the tracking write", async () => {
    // §10 PostgreSQL: a journal schema mismatch fails before snapshot,
    // tracking, artifacts or DDL. The gate is the FIRST thing `apply()` does
    // and `ensureTrackingTable()` is behind it; running the two in the other
    // order would create `beta`'s tracking table while refusing `alpha`'s
    // history, which is a durable effect on a database the caller was told
    // nothing happened to.
    const driver = pgEstateDriver("beta");
    const storage = new MemoryStorage();
    await seedJournal(storage, journalFor(ALPHA, [entry(0, "init")]));

    await expect(
      apply(clientFor(driver), { storageDriver: storage })
    ).rejects.toMatchObject({ code: "V11009" });
    expect(driver.statements).toEqual([]);
    expect(storage.writes).toEqual([]);
    expect(storage.reads).toEqual(["meta/_journal.json"]);
  });
});

// =============================================================================
// THE AUTHORITATIVE JOURNAL — apply()'s first effect follows its first proof
// =============================================================================

/**
 * Storage whose journal changes the instant it has been read.
 *
 * This is the race `apply()` has to survive: the pre-admission probe reads a
 * journal, the command then WAITS for the migration lock — for as long as
 * another migration holds it — and by the time it holds that lock the estate on
 * disk may be gone or may be another estate's. The probe is advisory; the
 * authoritative journal is the one reread under the lock, and NOTHING durable
 * may precede that reread.
 */
class RacingJournalStorage extends MemoryStorage {
  readonly onJournalRead: () => void;

  constructor(onJournalRead: () => void) {
    super();
    this.onJournalRead = onJournalRead;
  }

  override get(path: string): Promise<string | null> {
    const answer = super.get(path);
    if (path === "meta/_journal.json") {
      this.onJournalRead();
    }
    return answer;
  }
}

describe("apply() rereads the journal before its first effect", () => {
  it("creates NO tracking table when the journal vanished while it waited", async () => {
    const driver = pgEstateDriver("alpha");
    driver.respond = (sql) =>
      sql.includes("pg_namespace") ? [{ present: 1 }] : [];
    const storage = new RacingJournalStorage(() => {
      storage.files.delete("meta/_journal.json");
    });
    await seedJournal(storage, journalFor(ALPHA, [entry(0, "init")]));

    expect(await apply(clientFor(driver), { storageDriver: storage })).toEqual({
      applied: [],
      pending: [],
    });

    // The tracking table is DDL, and it used to be the FIRST statement inside
    // the lock — so a journal that disappeared while apply waited left a table
    // behind on an estate the caller was told nothing happened to.
    expect(driver.statements.some((sql) => sql.includes("CREATE TABLE"))).toBe(
      false
    );
    expect(storage.writes).toEqual([]);
    // The lock was taken and given back cleanly: a reread is a read.
    expect(driver.sessions).toEqual(["reserve", "release"]);
  });

  it("refuses another estate's journal without creating that estate's tracking", async () => {
    const driver = pgEstateDriver("alpha");
    driver.respond = (sql) =>
      sql.includes("pg_namespace") ? [{ present: 1 }] : [];
    // The document another estate's journal serializes to, written by the real
    // storage owner so the swap cannot invent a shape the reader would refuse
    // for a different reason.
    const beta = new MemoryStorage();
    await beta.writeJournal(journalFor(BETA, [entry(0, "init")]));
    const betaDocument = beta.files.get("meta/_journal.json") ?? "";
    const storage = new RacingJournalStorage(() => {
      storage.files.set("meta/_journal.json", betaDocument);
    });
    await seedJournal(storage, journalFor(ALPHA, [entry(0, "init")]));

    await expect(
      apply(clientFor(driver), { storageDriver: storage })
    ).rejects.toMatchObject({ code: "V11009" });

    expect(driver.statements.some((sql) => sql.includes("CREATE TABLE"))).toBe(
      false
    );
    expect(driver.sessions).toEqual(["reserve", "destroy"]);
  });

  it("still rereads the journal AFTER each commit", async () => {
    // The other half of the same discipline: the authoritative journal is read
    // before the first selection AND again after every commit, because the next
    // entry is chosen from the journal as it is now. The entry below lands in
    // storage while the first one is being applied, and only a command that
    // rereads can see it.
    const driver = pgEstateDriver("alpha");
    const applied: Array<{ name: string; checksum: string }> = [];
    driver.respond = (sql, params) => {
      if (sql.includes("pg_namespace")) {
        return [{ present: 1 }];
      }
      if (sql.startsWith("INSERT INTO")) {
        applied.push({ name: String(params[0]), checksum: String(params[1]) });
        return [];
      }
      return sql.includes("SELECT name, checksum, applied_at")
        ? [...applied]
        : [];
    };

    const first = entry(0, "init");
    const second = entry(1, "add-name");
    const grown = new MemoryStorage();
    await grown.writeJournal(journalFor(ALPHA, [first, second]));
    const grownDocument = grown.files.get("meta/_journal.json") ?? "";

    // Read 1 is the pre-admission probe and read 2 the authoritative one under
    // the lock; both answer the one-entry journal. The second entry appears
    // between read 2 and the reread that follows the first commit.
    let reads = 0;
    const storage = new RacingJournalStorage(() => {
      reads += 1;
      if (reads === 2) {
        storage.files.set("meta/_journal.json", grownDocument);
      }
    });
    await seedJournal(storage, journalFor(ALPHA, [first]));
    await storage.writeMigration(first, 'CREATE TABLE "alpha"."a" (id INT)');
    await storage.writeMigration(second, 'CREATE TABLE "alpha"."b" (id INT)');
    storage.writes.length = 0;

    const result = await apply(clientFor(driver), { storageDriver: storage });

    expect(result.applied.map((e) => e.name)).toEqual(["init", "add-name"]);
    expect(driver.sessions).toEqual(["reserve", "release"]);
  });
});

// =============================================================================
// LIVE-CAPABILITY ADMISSION (MySQL precedence matrix)
// =============================================================================

describe("MySQL admission precedence", () => {
  /**
   * Every admitted live MySQL command proves its configured database exists
   * before it reads applied state (§5.2), so a recording driver standing in for
   * a server has to answer that one `information_schema.SCHEMATA` probe.
   * Everything else still answers empty.
   */
  const respondWithDatabase =
    (namespace: string) =>
    (sql: string): unknown[] => {
      // A MySQL pinned migration session PROVES its `sql_mode` before any DDL
      // (plan 3.3 / `migrations/pinned-session.ts`).
      if (sql.includes("@@SESSION.sql_mode")) {
        return [
          {
            sql_mode: "STRICT_TRANS_TABLES,NO_ENGINE_SUBSTITUTION",
            server_version: "8.4.0",
          },
        ];
      }
      return sql.includes("information_schema.SCHEMATA")
        ? [{ SCHEMA_NAME: namespace }]
        : [];
    };

  async function applyWith(driver: RecordingDriver): Promise<unknown> {
    const storage = new MemoryStorage();
    await seedJournal(storage, journalFor(MYSQL, [entry(0, "init")]));
    return apply(clientFor(driver), { storageDriver: storage });
  }

  it("refuses DRIVER_NOT_SUPPORTED when neither fact is present", async () => {
    const driver = mysqlEstateDriver({});
    await expect(applyWith(driver)).rejects.toMatchObject({ code: "V8002" });
    expect(driver.statements).toEqual([]);
  });

  it("refuses DRIVER_NOT_SUPPORTED when the namespace is present but unattested", async () => {
    const driver = mysqlEstateDriver({ namespace: "app_prod" });
    await expect(applyWith(driver)).rejects.toMatchObject({ code: "V8002" });
    expect(driver.statements).toEqual([]);
  });

  it("refuses MIGRATION_INVALID_STATE when attested but unbound", async () => {
    const driver = mysqlEstateDriver({ attested: true });
    await expect(applyWith(driver)).rejects.toMatchObject({ code: "V11009" });
    expect(driver.statements).toEqual([]);
  });

  it("admits an attested, bound driver", async () => {
    const driver = mysqlEstateDriver({ namespace: "app_prod", attested: true });
    driver.respond = respondWithDatabase("app_prod");
    const storage = new MemoryStorage();
    await seedJournal(storage, journalFor(MYSQL));
    await apply(clientFor(driver), { storageDriver: storage });
    // The tracking table is created only on the admitted effectful path.
    expect(driver.statements.join("\n")).toContain("CREATE TABLE");
  });

  it("admits a read-only live command on a bound, unattested driver", async () => {
    const driver = mysqlEstateDriver({ namespace: "app_prod" });
    driver.respond = respondWithDatabase("app_prod");
    const storage = new MemoryStorage();
    await seedJournal(storage, journalFor(MYSQL, [entry(0, "init")]));

    const statuses = await status(clientFor(driver), {
      storageDriver: storage,
    });
    expect(statuses).toHaveLength(1);
    expect(driver.statements.join("\n")).not.toContain("CREATE TABLE");
  });

  it("refuses a read-only live command on an unbound driver", async () => {
    const driver = mysqlEstateDriver({});
    const storage = new MemoryStorage();
    await seedJournal(storage, journalFor(MYSQL, [entry(0, "init")]));

    await expect(
      status(clientFor(driver), { storageDriver: storage })
    ).rejects.toMatchObject({ code: "V11009" });
    expect(driver.statements).toEqual([]);
  });

  it("gates direct push immediately — it has no journal to probe", async () => {
    const driver = mysqlEstateDriver({ namespace: "app_prod" });
    await expect(
      push(clientFor(driver), { force: true })
    ).rejects.toMatchObject({ code: "V8002" });
    expect(driver.statements).toEqual([]);
  });

  it("keeps offline generation outside the gate entirely", async () => {
    const driver = mysqlEstateDriver({});
    const storage = new MemoryStorage();
    const result = await generate(clientFor(driver), {
      storageDriver: storage,
      name: "init",
    });
    expect(result.entry).not.toBeNull();
    expect(driver.statements).toEqual([]);
  });

  // ===========================================================================
  // EVERY EFFECTFUL VERB REACHES THE OWNER (one falsifier per call site)
  // ===========================================================================

  /**
   * `down`, `reset` and `squash` each admit `effectful` at their own call site,
   * before the lock. Deleting any ONE of those three lines must turn its two
   * cases below red — that is the whole point of listing them separately
   * instead of trusting `apply()`'s matrix to speak for all five verbs.
   *
   * A present journal is what establishes that live work follows, so each verb
   * gets one; an unattested driver is the shortest refusal that proves the
   * owner ran, because nothing else in the tree raises `DRIVER_NOT_SUPPORTED`
   * for a MySQL migration.
   */
  async function estateWithHistory(): Promise<MemoryStorage> {
    const storage = new MemoryStorage();
    await seedJournal(storage, journalFor(MYSQL, [entry(0, "init")]));
    return storage;
  }

  const effectfulVerbs: ReadonlyArray<{
    readonly command: string;
    readonly run: (
      client: MigrationClient,
      storage: MemoryStorage,
      dryRun: boolean
    ) => Promise<unknown>;
  }> = [
    {
      command: "down()",
      run: (client, storageDriver, dryRun) =>
        down(client, { storageDriver, dryRun }),
    },
    {
      command: "reset()",
      run: (client, storageDriver, dryRun) =>
        reset(client, { storageDriver, dryRun }),
    },
    {
      command: "squash()",
      run: (client, storageDriver, dryRun) =>
        squash(client, { storageDriver, dryRun, name: "squashed" }),
    },
  ];

  for (const { command, run } of effectfulVerbs) {
    it(`refuses ${command} at the owner, before the lock`, async () => {
      const driver = mysqlEstateDriver({ namespace: "app_prod" });
      const storage = await estateWithHistory();

      await expect(
        run(clientFor(driver), storage, false)
      ).rejects.toMatchObject({ code: "V8002", meta: { command } });
      // Nothing ran: not the lock statement, not the namespace proof.
      expect(driver.statements).toEqual([]);
      expect(storage.writes).toEqual([]);
    });

    it(`refuses a DRY ${command} on the same gate — it reports live state`, async () => {
      const driver = mysqlEstateDriver({ namespace: "app_prod" });
      const storage = await estateWithHistory();

      await expect(run(clientFor(driver), storage, true)).rejects.toMatchObject(
        { code: "V8002", meta: { command } }
      );
      expect(driver.statements).toEqual([]);
    });
  }

  it("refuses introspect() at the shared owner, before any dialect work", async () => {
    // `introspect(client)` reads the live catalog, so it is a live migration
    // command like any other. Without the owner an unbound MySQL client would
    // publish an inventory of whatever database its connection defaulted to —
    // §3.3's ambient default, accepted as an implicit migration target.
    const driver = mysqlEstateDriver({});

    await expect(introspect(clientFor(driver))).rejects.toMatchObject({
      code: "V11009",
      meta: { command: "introspect()", driver: "mysql2", target: "mysql" },
    });
    expect(driver.statements).toEqual([]);
  });

  it("lets an admitted introspect() through to the catalog", async () => {
    const driver = mysqlEstateDriver({ namespace: "app_prod" });
    driver.respond = respondWithDatabase("app_prod");

    // MySQL has no enum objects of its own, so a contained empty database
    // publishes tables only.
    expect(await introspect(clientFor(driver))).toMatchObject({ tables: [] });
    expect(driver.statements.join("\n")).toContain(
      "information_schema.SCHEMATA"
    );
  });
});

// =============================================================================
// SAFE METADATA ON EVERY ESTATE REFUSAL
// =============================================================================

/**
 * Every estate fact these refusals attach used to be dropped by the shared
 * error-metadata allowlist (`src/errors/diagnostics.ts`), which admitted none
 * of `namespace`, `target`, `command`, `journalTarget` or `clientTarget`. The
 * refusals READ as if they satisfied §3.3's "with the normalized namespace in
 * safe metadata" while `error.meta` came back `{}` or `{driver}`.
 */
describe("estate refusals carry their estate in safe metadata", () => {
  async function metaOf(run: () => Promise<unknown>): Promise<unknown> {
    return await run().then(
      () => undefined,
      (error: unknown) =>
        typeof error === "object" && error !== null
          ? Reflect.get(error, "meta")
          : undefined
    );
  }

  it("names both estates on a dialect mismatch", async () => {
    const storage = new MemoryStorage();
    await seedJournal(storage, journalFor(SQLITE));
    const ctx = new MigrationContext(clientFor(pgEstateDriver("alpha")), {
      storageDriver: storage,
    });

    expect(await metaOf(() => ctx.readEstateJournal())).toEqual({
      journalTarget: "sqlite",
      clientTarget: 'postgresql schema "alpha"',
    });
  });

  it("names both estates on a PostgreSQL schema mismatch", async () => {
    const storage = new MemoryStorage();
    await seedJournal(storage, journalFor(ALPHA));
    const ctx = new MigrationContext(clientFor(pgEstateDriver("beta")), {
      storageDriver: storage,
    });

    expect(await metaOf(() => ctx.readEstateJournal())).toEqual({
      journalTarget: 'postgresql schema "alpha"',
      clientTarget: 'postgresql schema "beta"',
    });
  });

  it("names the client estate when a snapshot has no journal", async () => {
    const storage = new MemoryStorage();
    await storage.writeSnapshot(EMPTY_SNAPSHOT);
    const ctx = new MigrationContext(clientFor(pgEstateDriver("alpha")), {
      storageDriver: storage,
    });

    expect(await metaOf(() => ctx.readEstateBaseline())).toEqual({
      clientTarget: 'postgresql schema "alpha"',
    });
  });

  it("names the driver, command and target on an unattested refusal", async () => {
    const storage = new MemoryStorage();
    await seedJournal(storage, journalFor(MYSQL, [entry(0, "init")]));
    const driver = mysqlEstateDriver({ namespace: "app_prod" });

    // The refusal names the database it was refused for: this driver IS bound,
    // and only its routing was unprovable.
    expect(
      await metaOf(() => apply(clientFor(driver), { storageDriver: storage }))
    ).toEqual({
      driver: "mysql2",
      command: "apply()",
      target: 'mysql database "app_prod"',
    });
  });

  it("names the invoked verb, not its delegate, on an unbound refusal", async () => {
    const storage = new MemoryStorage();
    await seedJournal(storage, journalFor(MYSQL, [entry(0, "init")]));

    // `pending()` used to delegate to `status()` and report a verb the caller
    // never called — in the message and in `meta.command` alike.
    expect(
      await metaOf(() =>
        pending(clientFor(mysqlEstateDriver({})), { storageDriver: storage })
      )
    ).toEqual({ driver: "mysql2", command: "pending()", target: "mysql" });
    expect(
      await metaOf(() =>
        status(clientFor(mysqlEstateDriver({})), { storageDriver: storage })
      )
    ).toEqual({ driver: "mysql2", command: "status()", target: "mysql" });
  });
});

// =============================================================================
// MIGRATION-CLIENT ACCESSORS
// =============================================================================

describe("read(entry) is estate-bound", () => {
  it("refuses an entry that is not a member of the matching journal", async () => {
    const storage = new MemoryStorage();
    await seedJournal(storage, journalFor(ALPHA, [entry(0, "init")]));
    const migrations = createMigrationClient(
      clientFor(pgEstateDriver("alpha")),
      {
        storageDriver: storage,
      }
    );

    await expect(migrations.read(entry(7, "fabricated"))).rejects.toMatchObject(
      {
        code: "V11002",
      }
    );
  });

  it("refuses every named accessor against another estate, but not raw storage", async () => {
    const storage = new MemoryStorage();
    await seedJournal(storage, journalFor(BETA, [entry(0, "init")]));
    const migrations = createMigrationClient(
      clientFor(pgEstateDriver("alpha")),
      {
        storageDriver: storage,
      }
    );

    await expect(migrations.list()).rejects.toMatchObject({ code: "V11009" });
    await expect(migrations.journal()).rejects.toMatchObject({
      code: "V11009",
    });
    await expect(migrations.snapshot()).rejects.toMatchObject({
      code: "V11009",
    });
    await expect(migrations.read(entry(0, "init"))).rejects.toMatchObject({
      code: "V11009",
    });

    // The documented low-level escape stays unbound.
    const raw = await migrations.storage.readJournal();
    expect(raw?.target).toEqual(BETA);
  });

  it("reports null when this estate holds no snapshot document", async () => {
    // The accessor documents "Returns null if no snapshot exists yet". It used
    // to hand back a fabricated `{tables:[],enums:[]}` — indistinguishable from
    // a real empty estate, and a "successful no-op" answer for a document that
    // is not there.
    const storage = new MemoryStorage();
    await seedJournal(storage, journalFor(ALPHA));
    const migrations = createMigrationClient(
      clientFor(pgEstateDriver("alpha")),
      { storageDriver: storage }
    );

    expect(await migrations.snapshot()).toBeNull();

    await storage.writeSnapshot(EMPTY_SNAPSHOT);
    expect(await migrations.snapshot()).toEqual(EMPTY_SNAPSHOT);
  });
});

// =============================================================================
// PUBLIC SURFACE
// =============================================================================

describe("public migration surface", () => {
  it("no longer exports the migration context or its options type", async () => {
    // Read through a dynamic import so the assertion is about the module's
    // OWN surface rather than about names this suite happened to import.
    const surface = await import("@migrations");
    expect("MigrationContext" in surface).toBe(false);
    expect(Object.keys(surface)).not.toContain("MigrationContext");
  });
});
