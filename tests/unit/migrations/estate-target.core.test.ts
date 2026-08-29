/**
 * Estate target, registry binding, and live-capability admission.
 *
 * A client bound to one estate cannot generate into another's descriptor, and
 * it cannot reach live state without the facts that prove where "live" is.
 */

import type { DatabaseAdapter } from "@adapters/database-adapter";
import { MySQLAdapter } from "@adapters/databases/mysql/mysql-adapter";
import { PostgresAdapter } from "@adapters/databases/postgres/postgres-adapter";
import { createMigrationClient } from "@migrations";
import { applyV1 as apply } from "@migrations/apply-v1";
import { getMigrationDriver } from "@migrations/drivers";
import { libsqlMigrationDriver } from "@migrations/drivers/libsql";
import { mysqlMigrationDriver } from "@migrations/drivers/mysql";
import { postgresMigrationDriver } from "@migrations/drivers/postgres";
import { sqlite3MigrationDriver } from "@migrations/drivers/sqlite";
import { generateV1 as generate } from "@migrations/generate-v1";
import { statusV1 as status } from "@migrations/operators";
import { introspect } from "@migrations/push";
import type { MigrationClient } from "@migrations/push/planner";
import { pushV1 as applyPush } from "@migrations/push-v1";
import { resetV1 as reset } from "@migrations/reset-v1";
import {
  formatMigrationTarget,
  resolveMigrationEstate,
} from "@migrations/target";
import type { MigrationTarget } from "@migrations/types";
import { s } from "@schema";
import { sql } from "@sql";
import { describe, expect, it } from "vitest";
import {
  MemoryStorage,
  mysqlEstateDriver,
  pgEstateDriver,
  pgUnprovenDriver,
  RecordingDriver,
  sqliteEstateDriver,
} from "./_estate";

const schema = {
  user: s.model({
    id: s.string().id(),
    email: s.string().unique(),
  }),
};

function clientFor(driver: RecordingDriver): MigrationClient {
  return { $driver: driver, $schema: schema };
}

const ALPHA: MigrationTarget = { dialect: "postgresql", namespace: "alpha" };
const BETA: MigrationTarget = { dialect: "postgresql", namespace: "beta" };
const MYSQL: MigrationTarget = { dialect: "mysql" };
const SQLITE: MigrationTarget = { dialect: "sqlite" };

const NO_ADAPTER_NAMESPACE = /exposes no adapter namespace/;

describe("resolveMigrationEstate", () => {
  it("copies the adapter's schema into a frozen PostgreSQL target", () => {
    const { target } = resolveMigrationEstate(pgEstateDriver("billing"));
    expect(target).toEqual({ dialect: "postgresql", namespace: "billing" });
    expect(Object.isFrozen(target)).toBe(true);
  });

  it("refuses a PostgreSQL adapter that proves no schema, never defaulting to public", () => {
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
    expect(() => resolveMigrationEstate(pgEstateDriver(""))).toThrow(
      NO_ADAPTER_NAMESPACE
    );

    const mysql = resolveMigrationEstate(mysqlEstateDriver({ namespace: "" }));
    expect(mysql.target).toEqual(MYSQL);
    expect(mysql.namespace).toBeUndefined();
    expect(
      getMigrationDriver(
        mysqlEstateDriver({ namespace: "" })
      ).generateDropTableSQL("users")
    ).toBe("DROP TABLE IF EXISTS `users`");
  });
});

describe("an estate description names what a command touches", () => {
  it("names the MySQL DATABASE, which its target cannot carry", () => {
    const bound = getMigrationDriver(
      mysqlEstateDriver({ namespace: "app_prod", attested: true })
    );
    expect(formatMigrationTarget(bound.target, bound.namespace)).toBe(
      'mysql database "app_prod"'
    );
    expect(formatMigrationTarget(MYSQL)).toBe("mysql");
    expect(
      formatMigrationTarget({ dialect: "postgresql", namespace: "alpha" })
    ).toBe('postgresql schema "alpha"');
  });
});

describe("registry binding", () => {
  it("binds the target immutably without mutating the registered singleton", () => {
    const alpha = getMigrationDriver(pgEstateDriver("alpha"));
    const beta = getMigrationDriver(pgEstateDriver("beta"));

    expect(alpha.target).toEqual(ALPHA);
    expect(beta.target).toEqual(BETA);
    expect(Object.isFrozen(alpha)).toBe(true);
    expect(Object.getPrototypeOf(alpha)).toBe(postgresMigrationDriver);
    expect(Object.getPrototypeOf(beta)).toBe(postgresMigrationDriver);
  });

  it("leaves every registered singleton without the bound facts AT ALL", () => {
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

describe("estate gate", () => {
  it("generate refuses another dialect's estate with MIGRATION_DIALECT_MISMATCH", async () => {
    const storage = new MemoryStorage();
    await generate(clientFor(sqliteEstateDriver()), storage, { name: "init" });

    await expect(
      generate(clientFor(pgEstateDriver("alpha")), storage, { name: "other" })
    ).rejects.toMatchObject({ code: "V11004" });
    expect(
      storage.writes.filter((path) => path.startsWith("states/"))
    ).toHaveLength(1);
  });

  it("generate refuses another PostgreSQL namespace", async () => {
    const storage = new MemoryStorage();
    await generate(clientFor(pgEstateDriver("alpha")), storage, {
      name: "init",
    });

    await expect(
      generate(clientFor(pgEstateDriver("beta")), storage, { name: "other" })
    ).rejects.toMatchObject({
      code: "V11004",
      message: expect.stringContaining("namespace"),
    });
    expect(
      storage.writes.filter((path) => path.startsWith("states/"))
    ).toHaveLength(1);
  });

  it("apply and status refuse another PostgreSQL namespace before live work", async () => {
    const storage = new MemoryStorage();
    await generate(clientFor(pgEstateDriver("alpha")), storage, {
      name: "init",
    });
    const beta = pgEstateDriver("beta");

    await expect(apply(clientFor(beta), storage)).rejects.toMatchObject({
      code: "V11004",
      message: expect.stringContaining("namespace"),
    });
    await expect(status(clientFor(beta), storage)).rejects.toMatchObject({
      code: "V11004",
      message: expect.stringContaining("namespace"),
    });
    expect(beta.statements).toEqual([]);
  });

  it("lets one MySQL estate deploy to two database names", async () => {
    const storage = new MemoryStorage();
    await generate(
      clientFor(mysqlEstateDriver({ namespace: "app_dev", attested: true })),
      storage,
      { name: "init" }
    );

    for (const namespace of ["app_dev", "app_prod"]) {
      const migrations = createMigrationClient(
        clientFor(mysqlEstateDriver({ namespace, attested: true })),
        { storage }
      );
      expect(await migrations.list()).toHaveLength(1);
    }
  });
});

describe("absent-estate arms", () => {
  it("apply, down, reset and status refuse a missing estate without connecting", async () => {
    const driver = pgEstateDriver("alpha");
    const storage = new MemoryStorage();
    const client = clientFor(driver);

    await expect(apply(client, storage)).rejects.toMatchObject({
      code: "V11012",
    });
    await expect(reset(client, storage)).rejects.toMatchObject({
      code: "V11012",
    });
    await expect(status(client, storage)).rejects.toMatchObject({
      code: "V11012",
    });
    expect(driver.statements).toEqual([]);
    expect(storage.writes).toEqual([]);
  });
});

describe("MySQL admission precedence", () => {
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
    await generate(
      clientFor(mysqlEstateDriver({ namespace: "app_prod", attested: true })),
      storage,
      { name: "init" }
    );
    return apply(clientFor(driver), storage);
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

  it("admits an attested, bound driver past the gate", async () => {
    const driver = mysqlEstateDriver({ namespace: "app_prod", attested: true });
    driver.respond = respondWithDatabase("app_prod");
    const storage = new MemoryStorage();
    await generate(clientFor(driver), storage, { name: "init" });
    await apply(clientFor(driver), storage).catch(() => undefined);
    expect(driver.statements.some((sql) => sql.includes("GET_LOCK"))).toBe(
      true
    );
  });

  it("admits a read-only live command on a bound, unattested driver", async () => {
    const driver = mysqlEstateDriver({ namespace: "app_prod" });
    driver.respond = (sql: string) => {
      if (sql.includes("information_schema.SCHEMATA")) {
        return [{ SCHEMA_NAME: "app_prod" }];
      }
      if (sql.includes("EXISTS") && sql.includes("information_schema.tables")) {
        return [{ exists: 0 }];
      }
      return [];
    };
    const storage = new MemoryStorage();
    await generate(
      clientFor(mysqlEstateDriver({ namespace: "app_prod", attested: true })),
      storage,
      { name: "init" }
    );

    const report = await status(clientFor(driver), storage);
    expect(report.control).toBe("absent");
    expect(report.pending).toHaveLength(1);
    expect(driver.statements.join("\n")).not.toContain("CREATE TABLE");
  });

  it("refuses a read-only live command on an unbound driver", async () => {
    const driver = mysqlEstateDriver({});
    const storage = new MemoryStorage();
    await generate(
      clientFor(mysqlEstateDriver({ namespace: "app_prod", attested: true })),
      storage,
      { name: "init" }
    );

    await expect(status(clientFor(driver), storage)).rejects.toMatchObject({
      code: "V11009",
    });
    expect(driver.statements).toEqual([]);
  });

  it("gates direct push immediately — it has no estate to probe", async () => {
    const driver = mysqlEstateDriver({ namespace: "app_prod" });
    await expect(applyPush(clientFor(driver))).rejects.toMatchObject({
      code: "V8002",
    });
    expect(driver.statements).toEqual([]);
  });

  it("keeps offline generation outside the gate entirely", async () => {
    const driver = mysqlEstateDriver({});
    const storage = new MemoryStorage();
    const result = await generate(clientFor(driver), storage, { name: "init" });
    expect(result.outcome).toBe("published");
    expect(result.stateId).not.toBeNull();
    expect(driver.statements).toEqual([]);
  });

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
      run: (client, storage, dryRun) =>
        createMigrationClient(client, { storage }).down({ dryRun }),
    },
    {
      command: "reset()",
      run: (client, storage, dryRun) =>
        createMigrationClient(client, { storage }).reset({ dryRun }),
    },
  ];

  for (const { command, run } of effectfulVerbs) {
    it(`refuses ${command} at the owner, before the lock`, async () => {
      const driver = mysqlEstateDriver({ namespace: "app_prod" });
      const storage = new MemoryStorage();
      await generate(
        clientFor(mysqlEstateDriver({ namespace: "app_prod", attested: true })),
        storage,
        { name: "init" }
      );

      await expect(
        run(clientFor(driver), storage, false)
      ).rejects.toMatchObject({ code: "V8002", meta: { command } });
      expect(driver.statements).toEqual([]);
      expect(storage.writes.filter((path) => path === "estate")).toHaveLength(
        1
      );
    });
  }

  it("refuses a DRY down() as read-only — it does not use the attestation gate", async () => {
    const driver = mysqlEstateDriver({ namespace: "app_prod" });
    driver.respond = (sql: string) =>
      sql.includes("EXISTS") && sql.includes("information_schema.tables")
        ? [{ exists: 0 }]
        : sql.includes("SCHEMATA")
          ? [{ SCHEMA_NAME: "app_prod" }]
          : [];
    const storage = new MemoryStorage();
    await generate(
      clientFor(mysqlEstateDriver({ namespace: "app_prod", attested: true })),
      storage,
      { name: "init" }
    );

    await expect(
      createMigrationClient(clientFor(driver), { storage }).down({
        dryRun: true,
      })
    ).rejects.not.toMatchObject({ code: "V8002" });
  });

  it("refuses introspect() at the shared owner, before any dialect work", async () => {
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

    expect(await introspect(clientFor(driver))).toMatchObject({ tables: [] });
    expect(driver.statements.join("\n")).toContain(
      "information_schema.SCHEMATA"
    );
  });
});

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

  it("names the driver, command and target on an unattested refusal", async () => {
    const storage = new MemoryStorage();
    await generate(
      clientFor(mysqlEstateDriver({ namespace: "app_prod", attested: true })),
      storage,
      { name: "init" }
    );
    const driver = mysqlEstateDriver({ namespace: "app_prod" });

    expect(await metaOf(() => apply(clientFor(driver), storage))).toEqual({
      driver: "mysql2",
      command: "apply()",
      target: 'mysql database "app_prod"',
    });
  });

  it("names the invoked verb on an unbound read-only refusal", async () => {
    const storage = new MemoryStorage();
    await generate(
      clientFor(mysqlEstateDriver({ namespace: "app_prod", attested: true })),
      storage,
      { name: "init" }
    );

    expect(
      await metaOf(() => status(clientFor(mysqlEstateDriver({})), storage))
    ).toEqual({ driver: "mysql2", command: "status()", target: "mysql" });
  });
});

describe("createMigrationClient accessors are estate-bound", () => {
  it("lists and shows published states, and refuses an unknown name", async () => {
    const storage = new MemoryStorage();
    const migrations = createMigrationClient(
      clientFor(pgEstateDriver("alpha")),
      { storage }
    );
    const published = await migrations.generate({ name: "init" });

    expect(await migrations.list()).toEqual([
      { stateId: published.stateId, name: "init" },
    ]);
    const shown = await migrations.show({ name: "init" });
    expect(shown).toMatchObject({
      stateId: published.stateId,
      name: "init",
      snapshotHash: published.snapshotHash,
      sqlHash: published.sqlHash,
      root: true,
      leaf: true,
    });
    expect(shown.incoming).toHaveLength(1);
    expect(shown.outgoing).toEqual([]);
    for (const incoming of shown.incoming) {
      expect(incoming).toMatchObject({
        fromState: null,
        toState: published.stateId,
        operationCount: expect.any(Number),
        stepCount: expect.any(Number),
        rollback: { kind: "schema" },
      });
      expect("operations" in incoming).toBe(false);
      expect(Object.isFrozen(incoming)).toBe(true);
      expect(Object.isFrozen(incoming.rollback)).toBe(true);
    }
    expect(Object.isFrozen(shown)).toBe(true);
    expect(Object.isFrozen(shown.incoming)).toBe(true);
    expect(Object.isFrozen(shown.outgoing)).toBe(true);

    const graph = await migrations.graph();
    expect(graph).toMatchObject({
      estateHash: published.estateHash,
      target: { dialect: "postgresql", namespace: "alpha" },
      roots: [published.stateId],
      leaves: [published.stateId],
      states: [
        {
          stateId: published.stateId,
          name: "init",
          snapshotHash: published.snapshotHash,
          sqlHash: published.sqlHash,
          root: true,
          leaf: true,
        },
      ],
      edges: shown.incoming,
    });
    expect(Object.isFrozen(graph)).toBe(true);
    expect(Object.isFrozen(graph.target)).toBe(true);
    expect(Object.isFrozen(graph.states)).toBe(true);
    expect(Object.isFrozen(graph.edges)).toBe(true);
    await expect(migrations.show({ name: "fabricated" })).rejects.toMatchObject(
      {
        code: "V11002",
      }
    );
  });

  it("shows the reason an incoming edge is irreversible", async () => {
    const storage = new MemoryStorage();
    const migrations = createMigrationClient(
      clientFor(pgEstateDriver("alpha")),
      { storage }
    );
    const initial = await migrations.generate({ name: "init" });
    if (initial.stateId === null) throw new Error("init was not published");
    const manual = await migrations.generate({
      name: "backfill",
      from: initial.stateId,
      manualMigration: {
        transitions: [
          {
            from: initial.stateId,
            execution: "transactional",
            up: [sql`UPDATE "user" SET "email" = "email"`],
            rollback: {
              kind: "irreversible",
              reason: "the original values were not retained",
            },
          },
        ],
      },
    });

    const shown = await migrations.show({ name: "backfill" });
    expect(shown.stateId).toBe(manual.stateId);
    expect(shown.incoming).toHaveLength(1);
    expect(shown.incoming[0]?.rollback).toEqual({
      kind: "irreversible",
      reason: "the original values were not retained",
      operationCount: 0,
      stepCount: 0,
    });
  });
});

describe("public migration surface", () => {
  it("no longer exports the migration context or its options type", async () => {
    const surface = await import("@migrations");
    expect("MigrationContext" in surface).toBe(false);
    expect(Object.keys(surface)).not.toContain("MigrationContext");
    expect("squash" in surface).toBe(false);
    expect("pending" in surface).toBe(false);
    expect(typeof surface.createMigrationClient).toBe("function");
    expect("previewPush" in surface).toBe(false);
    expect("push" in surface).toBe(false);
  });
});
