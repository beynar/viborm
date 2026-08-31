import { VibORMErrorCode } from "@src/errors";
import { canonicalizeJsonText } from "@src/migrations/canonical-json";
import {
  casMarker,
  DEFAULT_CONTROL_BASE,
  markerFromPath,
  readControlState,
} from "@src/migrations/control";
import { getMigrationDriver } from "@src/migrations/drivers";
import { eventIdFor } from "@src/migrations/v1-parse";
import type {
  LedgerEventV1,
  MigrationMarkerV1,
} from "@src/migrations/v1-types";
import { describe, expect, test } from "vitest";
import {
  controlCatalogAnswer,
  sqliteControlDefinitionAnswer,
  sqliteEstateDriver,
} from "./_estate";

const ESTATE_HASH = "a".repeat(64);
const SNAPSHOT_HASH = "b".repeat(64);

function marker(): MigrationMarkerV1 {
  return markerFromPath(ESTATE_HASH, SNAPSHOT_HASH, [], 1);
}

function startedEvent(attemptId: string, startedAt: string): LedgerEventV1 {
  const event = {
    format: "1" as const,
    attemptId,
    kind: "started" as const,
    estateHash: ESTATE_HASH,
    snapshotHash: SNAPSHOT_HASH,
    sqlHash: null,
    fromState: null,
    toState: "c".repeat(64),
    transitionHash: null,
    direction: "forward" as const,
    operationId: null,
    dispatchId: null,
    effectState: "none" as const,
    startedAt,
    finishedAt: null,
    toolVersion: "v1",
    failure: null,
  };
  return { ...event, eventId: eventIdFor(event) };
}

describe("migration marker compare-and-swap", () => {
  test("requires a singleton insert and preserves provider failure context", async () => {
    const missing = sqliteEstateDriver();
    await expect(
      casMarker(
        missing,
        getMigrationDriver(missing),
        DEFAULT_CONTROL_BASE,
        null,
        marker()
      )
    ).rejects.toMatchObject({
      code: VibORMErrorCode.MIGRATION_MARKER_CONFLICT,
      message: expect.stringContaining("singleton row"),
    });

    const providerFailure = new Error("write unavailable");
    const failed = sqliteEstateDriver();
    failed.respond = () => providerFailure;
    await expect(
      casMarker(
        failed,
        getMigrationDriver(failed),
        DEFAULT_CONTROL_BASE,
        null,
        marker()
      )
    ).rejects.toMatchObject({
      code: VibORMErrorCode.MIGRATION_MARKER_CONFLICT,
      message: expect.stringContaining("compare-and-swap failed"),
      originalCause: expect.any(Error),
    });
  });

  test("requires the expected revision and path hash to match one row", async () => {
    const driver = sqliteEstateDriver();
    const current = marker();
    await expect(
      casMarker(
        driver,
        getMigrationDriver(driver),
        DEFAULT_CONTROL_BASE,
        { revision: current.revision, pathHash: current.pathHash },
        markerFromPath(ESTATE_HASH, SNAPSHOT_HASH, [], 2)
      )
    ).rejects.toMatchObject({
      code: VibORMErrorCode.MIGRATION_MARKER_CONFLICT,
    });
    expect(driver.statements.at(-1)).toContain("revision");
    expect(driver.statements.at(-1)).toContain("pathHash");
  });
});

describe("migration ledger read ordering", () => {
  test("orders events by timestamp and then event identity", async () => {
    const later = startedEvent("d".repeat(64), "2026-08-31T00:00:01.000Z");
    const tiedA = startedEvent("e".repeat(64), "2026-08-31T00:00:00.000Z");
    const tiedB = startedEvent("f".repeat(64), "2026-08-31T00:00:00.000Z");
    const driver = sqliteEstateDriver();
    driver.respond = (statement, parameters) => {
      const catalog = controlCatalogAnswer(statement, parameters, {
        state: true,
        log: true,
      });
      if (catalog) return catalog;
      const definition = sqliteControlDefinitionAnswer(statement, {
        state: true,
        log: true,
      });
      if (definition) return definition;
      if (
        statement.includes("SELECT payload FROM") &&
        statement.includes("_viborm_migration_state")
      ) {
        return [{ payload: canonicalizeJsonText(marker()) }];
      }
      if (
        statement.includes("SELECT payload FROM") &&
        statement.includes("_viborm_migration_log")
      ) {
        return [later, tiedB, tiedA].map((event) => ({
          payload: canonicalizeJsonText(event),
        }));
      }
      return [];
    };

    const control = await readControlState(
      driver,
      getMigrationDriver(driver),
      DEFAULT_CONTROL_BASE
    );
    expect(control.ledger.map((event) => event.eventId)).toEqual([
      ...[tiedA.eventId, tiedB.eventId].sort(),
      later.eventId,
    ]);
  });
});
