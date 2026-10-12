import { VibORMErrorCode } from "@src/errors";
import {
  advanceMarker,
  attemptIdFor,
  ledgerEvent,
  markerFromPath,
  sameMarker,
} from "@src/migrations/control";
import { getMigrationDriver } from "@src/migrations/drivers";
import { eventIdFor } from "@src/migrations/v1-parse";
import { describe, expect, test, vi } from "vitest";
import { sqliteEstateDriver } from "./_estate";

const ESTATE = "a".repeat(64);
const SNAPSHOT = "b".repeat(64);
const SQL = "c".repeat(64);
const TO = "d".repeat(64);
const TRANSITION = "e".repeat(64);
const ATTEMPT = "f".repeat(64);

const edge = (stateId: string) => ({
  stateId,
  transitionHash: TRANSITION,
  baselineBoundary: false,
});

const fields = {
  attemptId: ATTEMPT,
  kind: "step-confirmed" as const,
  estateHash: ESTATE,
  snapshotHash: SNAPSHOT,
  sqlHash: SQL,
  fromState: null,
  toState: TO,
  transitionHash: TRANSITION,
  direction: "forward" as const,
  operationId: "op-1",
  dispatchId: null,
  effectState: "committed" as const,
};

describe("ledger event builder", () => {
  test("seals the fields an inline literal sets, with the event id of its content", () => {
    const event = ledgerEvent(fields);
    const { eventId, ...content } = event;
    expect(content).toEqual({
      ...fields,
      format: "1",
      startedAt: expect.any(String),
      finishedAt: event.startedAt,
      toolVersion: "v1",
      failure: null,
    });
    expect(eventId).toBe(eventIdFor(content));
    expect("resetPlan" in event).toBe(false);
  });

  test("leaves an opening event unfinished and carries a failure", () => {
    const opened = ledgerEvent({ ...fields, kind: "started", open: true });
    expect(opened.finishedAt).toBeNull();
    expect("open" in opened).toBe(false);
    const failed = ledgerEvent({
      ...fields,
      kind: "failed",
      failure: "V11000: boom",
    });
    expect(failed.failure).toBe("V11000: boom");
    expect(failed.finishedAt).not.toBeNull();
  });

  test("an attempt id is the id of its zero-attempt started event", () => {
    vi.useFakeTimers({ now: new Date("2026-10-12T08:00:00.000Z") });
    try {
      const seed = {
        estateHash: ESTATE,
        snapshotHash: SNAPSHOT,
        sqlHash: SQL,
        fromState: null,
        toState: TO,
        transitionHash: TRANSITION,
        direction: "rollback" as const,
      };
      // The inline shape apply and rollback hash today.
      expect(attemptIdFor(seed)).toBe(
        eventIdFor({
          format: "1",
          attemptId: "0".repeat(64),
          kind: "started",
          ...seed,
          operationId: null,
          dispatchId: null,
          effectState: "none",
          startedAt: "2026-10-12T08:00:00.000Z",
          finishedAt: null,
          toolVersion: "v1",
          failure: null,
        })
      );
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("marker identity", () => {
  const marker = markerFromPath(ESTATE, SNAPSHOT, [edge(TO)], 3);

  test("compares revision and path hash, and two absent markers are the same", () => {
    expect(sameMarker(null, null)).toBe(true);
    expect(sameMarker(marker, null)).toBe(false);
    expect(sameMarker(null, marker)).toBe(false);
    expect(sameMarker(marker, { revision: 3, pathHash: marker.pathHash })).toBe(
      true
    );
    expect(sameMarker(marker, { revision: 4, pathHash: marker.pathHash })).toBe(
      false
    );
    expect(sameMarker(marker, { revision: 3, pathHash: SQL })).toBe(false);
  });
});

describe("marker advance", () => {
  test("inserts the first marker at revision one", async () => {
    const driver = sqliteEstateDriver();
    driver.respond = () => [{}];
    const next = await advanceMarker(
      driver,
      getMigrationDriver(driver),
      ESTATE,
      null,
      [edge(TO)],
      SNAPSHOT
    );
    expect(next).toMatchObject({
      estateHash: ESTATE,
      snapshotHash: SNAPSHOT,
      stateId: TO,
      revision: 1,
    });
    expect(driver.statements.at(-1)?.startsWith("INSERT")).toBe(true);
  });

  test("swaps from the current marker by the revision step, and refuses a moved one", async () => {
    const current = markerFromPath(ESTATE, SNAPSHOT, [], 4);
    const driver = sqliteEstateDriver();
    driver.respond = () => [{}];
    const command = getMigrationDriver(driver);
    const next = await advanceMarker(
      driver,
      command,
      ESTATE,
      current,
      [edge(TO)],
      SNAPSHOT,
      2
    );
    expect(next.revision).toBe(6);
    expect(driver.parameters.at(-1)).toEqual(
      expect.arrayContaining([current.revision, current.pathHash])
    );

    const moved = sqliteEstateDriver();
    await expect(
      advanceMarker(
        moved,
        getMigrationDriver(moved),
        ESTATE,
        current,
        [edge(TO)],
        SNAPSHOT
      )
    ).rejects.toMatchObject({
      code: VibORMErrorCode.MIGRATION_MARKER_CONFLICT,
    });
  });
});
