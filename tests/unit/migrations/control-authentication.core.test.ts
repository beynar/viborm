/**
 * Control-plane authentication and bootstrap boundaries.
 *
 * Two tables carry every durable migration fact, so nothing here trusts them
 * on sight: an unreadable catalog, an ambiguous attachment probe, an
 * unprovable emptiness read, and a pair that changes shape between the
 * presence check and the bootstrap all have to refuse rather than repair.
 */

import type { AnyDriver } from "@drivers/driver";
import { VibORMErrorCode } from "@src/errors";
import {
  assertControlTablesAuthentic,
  casMarker,
  createControlTableSQL,
  DEFAULT_CONTROL_BASE,
  ensureControlTables,
  inspectControlPresence,
  markerFromPath,
  qualifyControl,
} from "@src/migrations/control";
import { getMigrationDriver } from "@src/migrations/drivers";
import { describe, expect, test } from "vitest";
import {
  controlCatalogAnswer,
  mysqlEstateDriver,
  pgEstateDriver,
  type RecordingDriver,
  sqliteControlDefinitionAnswer,
  sqliteEstateDriver,
} from "./_estate";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const CREATE_TABLE = /^CREATE TABLE/;

type Presence = { readonly state: boolean; readonly log: boolean };

/**
 * The answers a healthy SQLite control estate gives: catalog presence, the
 * `sqlite_master` definitions introspection reads, and the state definition the
 * singleton-check proof reads.
 */
function controlEstate(presence: Presence) {
  return (sql: string, params: unknown[]): unknown[] | undefined =>
    controlCatalogAnswer(sql, params, presence) ??
    sqliteControlDefinitionAnswer(sql, presence);
}

function sqliteControl(presence: Presence): RecordingDriver {
  const driver = sqliteEstateDriver();
  const answer = controlEstate(presence);
  driver.respond = (sql, params) => answer(sql, params) ?? [];
  return driver;
}

/** A producer that answers ONE statement itself and delegates the rest. */
function producerAnswering(
  driver: RecordingDriver,
  match: (sql: string) => boolean,
  rows: unknown[]
): AnyDriver {
  const producer: AnyDriver = Object.create(driver);
  Object.defineProperty(producer, "_executeRaw", {
    value: (sql: string, params?: unknown[]) =>
      match(sql)
        ? Promise.resolve({ rows, rowCount: rows.length })
        : driver._executeRaw(sql, params),
  });
  return producer;
}

describe("control table qualification", () => {
  test("a MySQL estate with no bound database qualifies nothing", () => {
    const unbound = mysqlEstateDriver({});
    const bound = mysqlEstateDriver({ namespace: "tenant" });

    expect(
      qualifyControl(getMigrationDriver(unbound), "_viborm_migration_state")
    ).toBe("`_viborm_migration_state`");
    expect(
      qualifyControl(getMigrationDriver(bound), "_viborm_migration_state")
    ).toBe("`tenant`.`_viborm_migration_state`");
    expect(
      createControlTableSQL(getMigrationDriver(unbound), DEFAULT_CONTROL_BASE)
        .log
    ).toContain("`_viborm_migration_log`");
  });

  test("PostgreSQL qualifies by schema and SQLite by bare name", () => {
    const postgres = pgEstateDriver("tenant");
    const sqlite = sqliteEstateDriver();

    expect(
      qualifyControl(getMigrationDriver(postgres), "_viborm_migration_log")
    ).toBe('"tenant"."_viborm_migration_log"');
    expect(
      qualifyControl(getMigrationDriver(sqlite), "_viborm_migration_log")
    ).toBe('"_viborm_migration_log"');
  });
});

describe("control table authentication refuses what it cannot read", () => {
  test("an unreadable catalog is a refusal, not an absent pair", async () => {
    const driver = sqliteControl({ state: true, log: true });
    const answer = controlEstate({ state: true, log: true });
    driver.respond = (sql, params) => {
      if (
        sql.includes("SELECT name, sql") &&
        sql.includes("FROM sqlite_master") &&
        sql.includes("type = 'table'")
      ) {
        return new Error("catalog unavailable");
      }
      return answer(sql, params) ?? [];
    };

    await expect(
      assertControlTablesAuthentic(
        driver,
        getMigrationDriver(driver),
        DEFAULT_CONTROL_BASE
      )
    ).rejects.toMatchObject({
      code: VibORMErrorCode.MIGRATION_INVALID_STATE,
      message: expect.stringContaining("cannot be authenticated"),
      originalCause: expect.any(Error),
    });
  });

  test("an attachment probe that answers with more than one row is refused", async () => {
    const driver = sqliteControl({ state: true, log: true });
    const producer = producerAnswering(
      driver,
      (sql) => sql.includes("AS attached"),
      [{ attached: 0 }, { attached: 0 }]
    );

    await expect(
      assertControlTablesAuthentic(
        producer,
        getMigrationDriver(driver),
        DEFAULT_CONTROL_BASE
      )
    ).rejects.toMatchObject({
      code: VibORMErrorCode.MIGRATION_INVALID_STATE,
      message: expect.stringContaining("exactly one row"),
    });
  });
});

describe("partial control state authentication", () => {
  test("an unreadable catalog beside a missing log is a refusal", async () => {
    const driver = sqliteControl({ state: true, log: false });
    const answer = controlEstate({ state: true, log: false });
    driver.respond = (sql, params) => {
      if (
        sql.includes("SELECT name, sql") &&
        sql.includes("FROM sqlite_master") &&
        sql.includes("type = 'table'")
      ) {
        return new Error("catalog unavailable");
      }
      return answer(sql, params) ?? [];
    };

    await expect(
      inspectControlPresence(
        driver,
        getMigrationDriver(driver),
        DEFAULT_CONTROL_BASE
      )
    ).rejects.toMatchObject({
      code: VibORMErrorCode.MIGRATION_INVALID_STATE,
      message: expect.stringContaining(
        "A partial migration control state table cannot be authenticated"
      ),
    });
  });

  test("an unreadable state definition beside a missing log is a refusal", async () => {
    const driver = sqliteControl({ state: true, log: false });
    const answer = controlEstate({ state: true, log: false });
    driver.respond = (sql, params) => {
      if (sql.startsWith("SELECT sql FROM sqlite_master")) {
        return new Error("definition unavailable");
      }
      return answer(sql, params) ?? [];
    };

    await expect(
      inspectControlPresence(
        driver,
        getMigrationDriver(driver),
        DEFAULT_CONTROL_BASE
      )
    ).rejects.toMatchObject({
      code: VibORMErrorCode.MIGRATION_INVALID_STATE,
      message: expect.stringContaining(
        "A partial migration control state table cannot be authenticated"
      ),
    });
  });

  test("an unreadable attachment probe beside a missing log is a refusal", async () => {
    const driver = sqliteControl({ state: true, log: false });
    const answer = controlEstate({ state: true, log: false });
    driver.respond = (sql, params) => {
      if (sql.includes("AS attached")) {
        return new Error("trigger catalog unavailable");
      }
      return answer(sql, params) ?? [];
    };

    await expect(
      inspectControlPresence(
        driver,
        getMigrationDriver(driver),
        DEFAULT_CONTROL_BASE
      )
    ).rejects.toMatchObject({
      code: VibORMErrorCode.MIGRATION_INVALID_STATE,
      message: expect.stringContaining(
        "A partial migration control state table cannot be authenticated"
      ),
    });
  });

  test("a state table that cannot be proven empty is a refusal", async () => {
    const driver = sqliteControl({ state: true, log: false });
    const answer = controlEstate({ state: true, log: false });
    driver.respond = (sql, params) => {
      if (
        sql.includes("SELECT payload FROM") &&
        sql.includes("_viborm_migration_state")
      ) {
        return new Error("permission denied");
      }
      return answer(sql, params) ?? [];
    };

    await expect(
      inspectControlPresence(
        driver,
        getMigrationDriver(driver),
        DEFAULT_CONTROL_BASE
      )
    ).rejects.toMatchObject({
      code: VibORMErrorCode.MIGRATION_INVALID_STATE,
      message: expect.stringContaining("cannot be proven empty"),
    });
  });
});

describe("bootstrap is idempotent and refuses a moving estate", () => {
  test("an authenticated pair is left exactly as it is", async () => {
    const driver = sqliteControl({ state: true, log: true });

    await ensureControlTables(
      driver,
      getMigrationDriver(driver),
      DEFAULT_CONTROL_BASE
    );

    expect(driver.statements.some((sql) => CREATE_TABLE.test(sql))).toBe(false);
  });

  test("refuses a state table that appears after the absent-pair verdict", async () => {
    const driver = sqliteEstateDriver();
    let stateVisible = false;
    driver.respond = (sql, params) => {
      const catalog = controlCatalogAnswer(sql, params, {
        state: stateVisible,
        log: false,
      });
      if (catalog) {
        if (String(params.at(-1) ?? "").endsWith("_state")) stateVisible = true;
        return catalog;
      }
      return (
        sqliteControlDefinitionAnswer(sql, { state: true, log: false }) ?? []
      );
    };

    await expect(
      ensureControlTables(
        driver,
        getMigrationDriver(driver),
        DEFAULT_CONTROL_BASE
      )
    ).rejects.toMatchObject({
      code: VibORMErrorCode.MIGRATION_INVALID_STATE,
      message: expect.stringContaining("changed during bootstrap"),
    });
    expect(driver.statements.some((sql) => CREATE_TABLE.test(sql))).toBe(false);
  });

  test("refuses a log table that appears after the absent-pair verdict", async () => {
    const driver = sqliteEstateDriver();
    let logVisible = false;
    driver.respond = (sql, params) => {
      const catalog = controlCatalogAnswer(sql, params, {
        state: false,
        log: logVisible,
      });
      if (catalog) {
        if (String(params.at(-1) ?? "").endsWith("_log")) logVisible = true;
        return catalog;
      }
      return [];
    };

    await expect(
      ensureControlTables(
        driver,
        getMigrationDriver(driver),
        DEFAULT_CONTROL_BASE
      )
    ).rejects.toMatchObject({
      code: VibORMErrorCode.MIGRATION_INVALID_STATE,
      message: expect.stringContaining("changed during bootstrap"),
    });
    expect(driver.statements.some((sql) => CREATE_TABLE.test(sql))).toBe(false);
  });

  test("refuses to drop a recovered state table that acquired a marker", async () => {
    const driver = sqliteControl({ state: true, log: false });
    const answer = controlEstate({ state: true, log: false });
    let markerWritten = false;
    driver.respond = (sql, params) => {
      if (
        sql.includes("SELECT payload FROM") &&
        sql.includes("_viborm_migration_state")
      ) {
        if (markerWritten) return [{ payload: "{}" }];
        markerWritten = true;
        return [];
      }
      return answer(sql, params) ?? [];
    };

    await expect(
      ensureControlTables(
        driver,
        getMigrationDriver(driver),
        DEFAULT_CONTROL_BASE
      )
    ).rejects.toMatchObject({
      code: VibORMErrorCode.MIGRATION_INVALID_STATE,
      message: expect.stringContaining(
        "Migration control tables are inconsistent: log is missing"
      ),
    });
    expect(driver.statements.some((sql) => sql.startsWith("DROP TABLE"))).toBe(
      false
    );
  });
});

describe("coverage low value", () => {
  test("a provider that rejects with a non-Error still reports a marker conflict", async () => {
    const driver = sqliteEstateDriver();
    const producer: AnyDriver = Object.create(driver);
    Object.defineProperty(producer, "_executeRaw", {
      value: () => Promise.reject("provider closed the connection"),
    });

    await expect(
      casMarker(
        producer,
        getMigrationDriver(driver),
        DEFAULT_CONTROL_BASE,
        null,
        markerFromPath(HASH_A, HASH_B, [], 1)
      )
    ).rejects.toMatchObject({
      code: VibORMErrorCode.MIGRATION_MARKER_CONFLICT,
      message: expect.stringContaining("compare-and-swap failed"),
      originalCause: undefined,
    });
  });
});
