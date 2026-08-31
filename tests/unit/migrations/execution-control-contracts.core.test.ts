import { VibORMErrorCode } from "@src/errors";
import {
  appendLedger,
  casMarker,
  controlTableNames,
  DEFAULT_CONTROL_BASE,
  markerFromPath,
  qualifyControl,
  refuseIncompatibleHistory,
  refusePartialControl,
} from "@src/migrations/control";
import { getMigrationDriver } from "@src/migrations/drivers";
import { executeLiveNamespaceReset } from "@src/migrations/live-reset";
import {
  mayWrapTransaction,
  resolveCommandDriver,
  runSequentialProgram,
  selectMigrationTarget,
  withLockedMigrationProducer,
} from "@src/migrations/pinned-session";
import { eventIdFor } from "@src/migrations/v1-parse";
import type { LedgerEventV1 } from "@src/migrations/v1-types";
import { describe, expect, test } from "vitest";
import {
  mysqlEstateDriver,
  pgEstateDriver,
  sqliteEstateDriver,
} from "./_estate";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

function ledgerEvent(kind: LedgerEventV1["kind"]): LedgerEventV1 {
  const event = {
    format: "1" as const,
    attemptId: HASH_A,
    kind,
    estateHash: HASH_A,
    snapshotHash: HASH_B,
    sqlHash: null,
    fromState: null,
    toState: HASH_B,
    transitionHash: null,
    direction: "forward" as const,
    operationId: null,
    dispatchId: null,
    effectState:
      kind === "started" ? ("none" as const) : ("committed" as const),
    startedAt: "2026-08-31T00:00:00.000Z",
    finishedAt: kind === "started" ? null : "2026-08-31T00:00:01.000Z",
    toolVersion: "v1",
    failure: null,
  };
  return { ...event, eventId: eventIdFor(event) };
}

describe("migration execution and control contracts", () => {
  test("control names are validated and qualified by the bound dialect", () => {
    expect(controlTableNames("history_1")).toEqual({
      state: "history_1_state",
      log: "history_1_log",
    });
    expect(() => controlTableNames("bad-name")).toThrowError(
      expect.objectContaining({ code: VibORMErrorCode.INVALID_INPUT })
    );
    expect(
      qualifyControl(getMigrationDriver(pgEstateDriver("tenant")), 'a"b')
    ).toBe('"tenant"."a""b"');
    expect(
      qualifyControl(
        getMigrationDriver(
          mysqlEstateDriver({ namespace: "tenant", attested: true })
        ),
        "a`b"
      )
    ).toBe("`tenant`.`a``b`");
    expect(
      qualifyControl(getMigrationDriver(sqliteEstateDriver()), "state")
    ).toBe('"state"');
  });

  test("partial and markerless closed history are refused without hiding recoverable work", () => {
    expect(() =>
      refusePartialControl({ kind: "recoverable-state-only" })
    ).toThrowError(
      expect.objectContaining({ code: VibORMErrorCode.MIGRATION_INVALID_STATE })
    );
    expect(() =>
      refusePartialControl({ kind: "missing-table", table: "state" })
    ).toThrowError(
      expect.objectContaining({ code: VibORMErrorCode.MIGRATION_INVALID_STATE })
    );
    expect(() =>
      refusePartialControl({ kind: "missing-table", table: "both" })
    ).not.toThrow();

    expect(() =>
      refuseIncompatibleHistory(null, [ledgerEvent("applied")])
    ).toThrowError(
      expect.objectContaining({
        code: VibORMErrorCode.MIGRATION_INVALID_STATE,
      })
    );
    expect(() =>
      refuseIncompatibleHistory(null, [ledgerEvent("started")])
    ).not.toThrow();
  });

  test.each([
    ["sqlite", sqliteEstateDriver()],
    ["postgresql", pgEstateDriver("tenant")],
    ["mysql", mysqlEstateDriver({ namespace: "tenant", attested: true })],
  ])("marker CAS and ledger append use %s parameter syntax", async (_dialect, producer) => {
    producer.respond = () => [{ changed: 1 }];
    const command = getMigrationDriver(producer);
    const initial = markerFromPath(HASH_A, HASH_B, [], 1);
    const next = markerFromPath(HASH_A, HASH_B, [], 2);

    await casMarker(producer, command, DEFAULT_CONTROL_BASE, null, initial);
    await casMarker(
      producer,
      command,
      DEFAULT_CONTROL_BASE,
      { revision: initial.revision, pathHash: initial.pathHash },
      next
    );
    await appendLedger(
      producer,
      command,
      DEFAULT_CONTROL_BASE,
      ledgerEvent("applied")
    );

    expect(
      producer.statements.some((statement) => statement.startsWith("INSERT"))
    ).toBe(true);
    expect(
      producer.statements.some((statement) => statement.startsWith("UPDATE"))
    ).toBe(true);
  });

  test("marker CAS reports both provider failure and a zero-row conflict", async () => {
    const failed = sqliteEstateDriver();
    failed.respond = () => new Error("write failed");
    await expect(
      casMarker(
        failed,
        getMigrationDriver(failed),
        DEFAULT_CONTROL_BASE,
        null,
        markerFromPath(HASH_A, HASH_B, [], 1)
      )
    ).rejects.toMatchObject({
      code: VibORMErrorCode.MIGRATION_MARKER_CONFLICT,
      originalCause: expect.any(Error),
    });

    const conflicted = sqliteEstateDriver();
    conflicted.respond = () => [];
    await expect(
      casMarker(
        conflicted,
        getMigrationDriver(conflicted),
        DEFAULT_CONTROL_BASE,
        { revision: 1, pathHash: HASH_A },
        markerFromPath(HASH_A, HASH_B, [], 2)
      )
    ).rejects.toMatchObject({
      code: VibORMErrorCode.MIGRATION_MARKER_CONFLICT,
    });
  });

  test("a planned namespace reset executes its complete mutation order", async () => {
    const driver = sqliteEstateDriver();
    const result = await executeLiveNamespaceReset(driver, {
      tables: ["child", "parent"],
      clearTracking: "DELETE FROM tracking",
      dropForeignKeys: ["ALTER TABLE child DROP CONSTRAINT fk_parent"],
      dropTables: [
        { name: "child", sql: "DROP TABLE child" },
        { name: "parent", sql: "DROP TABLE parent" },
      ],
      dropEnums: ["DROP TYPE status"],
    });

    expect(result).toEqual({ dropped: ["child", "parent"] });
    expect(driver.statements).toEqual([
      "<connect>",
      "DELETE FROM tracking",
      "ALTER TABLE child DROP CONSTRAINT fk_parent",
      "DROP TABLE child",
      "DROP TABLE parent",
      "DROP TYPE status",
    ]);
  });

  test("command resolution preserves the provider spelling and target selection", async () => {
    const mysql = mysqlEstateDriver({ namespace: "tenant", attested: true });
    mysql.respond = (statement) =>
      statement.includes("SCHEMATA") ? [{ SCHEMA_NAME: "Tenant" }] : [];
    const command = await resolveCommandDriver(
      mysql,
      getMigrationDriver(mysql)
    );
    expect(command.namespace).toBe("Tenant");
    await selectMigrationTarget(mysql, command);
    expect(
      mysql.statements.some((statement) => statement === "USE `Tenant`")
    ).toBe(true);

    const sqlite = sqliteEstateDriver();
    await selectMigrationTarget(sqlite, getMigrationDriver(sqlite));
    expect(sqlite.statements).toEqual([]);
  });

  test("transaction wrapping excludes stepwise, MySQL, and transactionless producers", () => {
    expect(
      mayWrapTransaction({ supportsTransactions: true }, "sqlite", true)
    ).toBe(true);
    expect(
      mayWrapTransaction({ supportsTransactions: true }, "mysql", true)
    ).toBe(false);
    expect(
      mayWrapTransaction({ supportsTransactions: false }, "sqlite", true)
    ).toBe(false);
    expect(
      mayWrapTransaction({ supportsTransactions: true }, "sqlite", false)
    ).toBe(false);
  });

  test("sequential execution reports the last completed statement", async () => {
    const driver = sqliteEstateDriver();
    const command = getMigrationDriver(driver);
    const failure = await runSequentialProgram(
      driver,
      command,
      async (recording) => {
        await recording._executeRaw("FIRST");
        throw new Error("second failed");
      }
    ).catch((error: unknown) => error);

    expect(failure).toMatchObject({
      code: VibORMErrorCode.MIGRATION_PARTIAL_EFFECT,
      message: expect.stringContaining("FIRST"),
      originalCause: expect.any(Error),
    });
  });

  test("lock acquisition and release failures preserve the correct boundary", async () => {
    const acquire = pgEstateDriver("public");
    acquire.lockAnswers.acquire = new Error("lock unavailable");
    await expect(
      withLockedMigrationProducer(
        acquire,
        getMigrationDriver(acquire),
        async () => "no"
      )
    ).rejects.toMatchObject({ code: VibORMErrorCode.MIGRATION_LOCK_FAILED });

    const release = pgEstateDriver("public");
    release.respond = (statement) =>
      statement.includes("pg_namespace") ? [{ present: 1 }] : [];
    release.lockAnswers.release = [];
    await expect(
      withLockedMigrationProducer(
        release,
        getMigrationDriver(release),
        async () => "ran"
      )
    ).rejects.toMatchObject({ code: VibORMErrorCode.MIGRATION_LOCK_FAILED });
    expect(release.sessions).toEqual(["reserve", "destroy"]);

    const primary = pgEstateDriver("public");
    primary.respond = release.respond;
    primary.lockAnswers.release = new Error("unlock failed");
    const bodyFailure = new Error("body failed");
    const caught = await withLockedMigrationProducer(
      primary,
      getMigrationDriver(primary),
      async () => {
        throw bodyFailure;
      }
    ).catch((error: unknown) => error);
    expect(caught).toBe(bodyFailure);
    expect(primary.sessions).toEqual(["reserve", "destroy"]);
  });
});

describe("coverage low value", () => {
  test("sequential failure before a completed statement names the empty boundary", async () => {
    const driver = sqliteEstateDriver();
    const failure = await runSequentialProgram(
      driver,
      getMigrationDriver(driver),
      () => Promise.reject("bare failure")
    ).catch((error: unknown) => error);

    expect(failure).toMatchObject({
      code: VibORMErrorCode.MIGRATION_PARTIAL_EFFECT,
      message: expect.stringContaining("none"),
    });
  });
});
