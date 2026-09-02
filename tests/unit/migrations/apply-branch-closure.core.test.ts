import { VibORMErrorCode } from "@src/errors";
import { applyV1 } from "@src/migrations/apply-v1";
import { canonicalizeJsonText } from "@src/migrations/canonical-json";
import { markerFromPath } from "@src/migrations/control";
import { emptyManagedSnapshot } from "@src/migrations/empty-snapshot";
import { composeSqlBlob } from "@src/migrations/sql-blob";
import { MemoryEstateStorage } from "@src/migrations/storage/memory";
import {
  encodeDispatchIdentity,
  encodeEstateDescriptor,
  encodeSnapshot,
  encodeStateManifest,
  encodeTransitionHash,
} from "@src/migrations/v1-parse";
import type {
  LedgerEventV1,
  MigrationDispatchV1,
  MigrationMarkerV1,
  MigrationParentTransitionV1,
} from "@src/migrations/v1-types";
import { describe, expect, test } from "vitest";
import {
  controlCatalogAnswer,
  type RecordingDriver,
  sqliteControlDefinitionAnswer,
  sqliteEstateDriver,
} from "./_estate";

/**
 * `apply()` closure for the two live facts a forward transition proves for
 * itself: its stored destination checks, and the marker it started from.
 *
 * Both are answers a database gives, not bytes an estate carries, so the
 * estate here is real authenticated storage and everything that can vary is a
 * row the recording driver returns. The state carries one forward dispatch and
 * one destination check, so a refusal can always say whether the dispatch had
 * already run.
 */

const EMPTY_SNAPSHOT = encodeSnapshot(emptyManagedSnapshot());
const FORWARD_SQL = "SELECT 'apply-forward'";
const DESTINATION_CHECK_SQL = "SELECT 'apply-destination'";
/** A check row whose one column is false. */
const FALSE_ROW = [{ matches: 0 }];
const OK_ROW = [{ ok: 1 }];

function clientFor(driver: RecordingDriver) {
  return { $driver: driver, $schema: {} };
}

function dispatchAt(
  blob: ReturnType<typeof composeSqlBlob>,
  index: number
): MigrationDispatchV1 {
  const range = blob.ranges[index]!;
  return {
    dispatchId: encodeDispatchIdentity(
      blob.sqlHash,
      range.offset,
      range.length,
      []
    ),
    sqlHash: blob.sqlHash,
    offset: range.offset,
    length: range.length,
    parameters: [],
  };
}

/**
 * One authenticated root state: one generated forward dispatch, one stored
 * destination check, and the empty managed snapshot on both sides, so a
 * recording driver that reports no managed table is exactly what the estate
 * expects to find.
 */
async function publishGuardedRoot() {
  const storage = new MemoryEstateStorage();
  const estate = encodeEstateDescriptor({ dialect: "sqlite" });
  const blob = composeSqlBlob([FORWARD_SQL, DESTINATION_CHECK_SQL]);
  await storage.publishEstate(estate.bytes);
  await storage.publishSnapshot(
    EMPTY_SNAPSHOT.snapshotHash,
    EMPTY_SNAPSHOT.bytes
  );
  await storage.publishSql(blob.sqlHash, blob.bytes);
  const parentBody: Omit<MigrationParentTransitionV1, "transitionHash"> = {
    fromState: null,
    originChecks: [],
    requestedForwardBoundary: null,
    operations: [
      {
        id: "guarded:forward:0",
        label: "guarded forward",
        origin: "generated",
        risk: "safe",
        steps: [{ retry: "opaque", execute: dispatchAt(blob, 0) }],
      },
    ],
    rollback: { kind: "irreversible", reason: "apply fixture" },
  };
  const transitionHash = encodeTransitionHash(parentBody);
  const encoded = encodeStateManifest({
    format: "1",
    estateHash: estate.estateHash,
    name: "guarded",
    snapshotHash: EMPTY_SNAPSHOT.snapshotHash,
    sqlHash: blob.sqlHash,
    destinationChecks: [
      {
        kind: "trusted-read",
        id: "guarded:destination",
        query: dispatchAt(blob, 1),
        equals: true,
      },
    ],
    parents: [{ ...parentBody, transitionHash }],
  });
  await storage.publishState(encoded.stateId, encoded.bytes);
  return {
    storage,
    estateHash: estate.estateHash,
    stateId: encoded.stateId,
    transitionHash,
  };
}

interface ControlOptions {
  readonly marker?: MigrationMarkerV1;
  readonly ledger?: readonly LedgerEventV1[];
  /** Exact answers that must win over the shared control fixtures. */
  readonly answer?: (sql: string) => unknown[] | undefined;
}

function controlRespond(options: ControlOptions = {}) {
  const ledger = options.ledger ?? [];
  return (sql: string, params: unknown[]): unknown[] | Error => {
    const custom = options.answer?.(sql);
    if (custom !== undefined) return custom;
    const catalog = controlCatalogAnswer(sql, params, {
      state: true,
      log: true,
    });
    if (catalog) return catalog;
    const definition = sqliteControlDefinitionAnswer(sql, {
      state: true,
      log: true,
    });
    if (definition) return definition;
    if (
      sql.includes("SELECT payload FROM") &&
      sql.includes("_viborm_migration_state")
    ) {
      return options.marker
        ? [{ payload: canonicalizeJsonText(options.marker) }]
        : [];
    }
    if (
      sql.includes("SELECT payload FROM") &&
      sql.includes("_viborm_migration_log")
    ) {
      return ledger.map((event) => ({ payload: canonicalizeJsonText(event) }));
    }
    if (
      sql.startsWith("INSERT INTO") ||
      sql.startsWith("UPDATE") ||
      sql.startsWith("CREATE TABLE")
    ) {
      return OK_ROW;
    }
    return [];
  };
}

function wroteMarker(driver: RecordingDriver): boolean {
  return driver.statements.some(
    (statement) =>
      statement.startsWith("UPDATE") ||
      (statement.startsWith("INSERT INTO") &&
        statement.includes("_viborm_migration_state"))
  );
}

describe("apply destination proof", () => {
  test("refuses to advance the marker when a destination check is false", async () => {
    const published = await publishGuardedRoot();
    const driver = sqliteEstateDriver();
    driver.respond = controlRespond({
      answer: (sql) => (sql === DESTINATION_CHECK_SQL ? FALSE_ROW : undefined),
    });

    await expect(
      applyV1(clientFor(driver), published.storage)
    ).rejects.toMatchObject({
      code: VibORMErrorCode.MIGRATION_DRIFT,
      message: "Destination checks failed before the marker could advance",
    });
    // The dispatch ran: this is the failure of a transition that executed, not
    // a preflight refusal, and the marker still must not move.
    expect(driver.statements).toContain(FORWARD_SQL);
    expect(wroteMarker(driver)).toBe(false);
  });
});

describe("apply drift proof from an empty-state marker", () => {
  test("accepts a marker whose path is empty and proves the empty snapshot", async () => {
    const published = await publishGuardedRoot();
    const driver = sqliteEstateDriver();
    driver.respond = controlRespond({
      // A database that was rolled all the way back keeps a marker naming no
      // state at all. Its authenticated snapshot is the empty managed one, so
      // apply must prove the live target against THAT and then move forward.
      marker: markerFromPath(
        published.estateHash,
        EMPTY_SNAPSHOT.snapshotHash,
        [],
        4
      ),
      answer: (sql) => (sql === DESTINATION_CHECK_SQL ? FALSE_ROW : undefined),
    });

    await expect(
      applyV1(clientFor(driver), published.storage)
    ).rejects.toMatchObject({
      // Reaching the destination check is the evidence: an empty-state marker
      // that failed its drift proof would have refused before any dispatch.
      code: VibORMErrorCode.MIGRATION_DRIFT,
      message: "Destination checks failed before the marker could advance",
    });
    expect(driver.statements).toContain(FORWARD_SQL);
    expect(wroteMarker(driver)).toBe(false);
  });
});
