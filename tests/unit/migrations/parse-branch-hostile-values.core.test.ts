/**
 * Hostile VALUE admission at the Migration V1 parse boundary.
 *
 * The sibling suites cover unknown keys, missing keys and identity mismatches.
 * These are the refusals that fire when a key IS present and its value is the
 * wrong JSON shape — the arms a corrupted or hand-edited estate, marker row or
 * ledger row reaches first. Each one names the exact field and the code a
 * caller dispatches on.
 */

import { VibORMErrorCode } from "@src/errors";
import { canonicalizeJson } from "@src/migrations/canonical-json";
import { domainHash, HASH_DOMAIN } from "@src/migrations/identity";
import {
  eventIdFor,
  parseLedgerEvent,
  parseMarkerRow,
  parseSnapshotDocument,
} from "@src/migrations/v1-parse";
import type { LedgerEventV1 } from "@src/migrations/v1-types";
import { describe, expect, test } from "vitest";

const HASH = "a".repeat(64);
const ZERO = "0".repeat(64);

/** One well-formed table, so a refusal below is the only reason to throw. */
const usersTable = {
  name: "users",
  columns: [{ name: "id", type: "text", nullable: false }],
  indexes: [],
  foreignKeys: [],
  uniqueConstraints: [],
};

function admitSnapshot(document: unknown) {
  const bytes = canonicalizeJson(document);
  return () =>
    parseSnapshotDocument(bytes, domainHash(HASH_DOMAIN.snapshot, bytes));
}

interface SnapshotRefusal {
  readonly name: string;
  readonly document: unknown;
  readonly message: string;
}

const snapshotRefusals: readonly SnapshotRefusal[] = [
  {
    name: "a tables key that is not an array",
    document: { tables: "none" },
    message: "snapshot.tables must be an array",
  },
  {
    name: "a table that is not an object",
    document: { tables: ["users"] },
    message: "snapshot.tables[0] must be an object",
  },
  {
    name: "an index whose uniqueness is not a boolean",
    document: {
      tables: [
        {
          ...usersTable,
          indexes: [{ name: "users_id_idx", columns: ["id"], unique: "yes" }],
        },
      ],
    },
    message: "snapshot.tables[0].indexes[0].unique must be boolean",
  },
  {
    name: "a primary key whose columns are not an array",
    document: {
      tables: [{ ...usersTable, primaryKey: { columns: "id" } }],
    },
    message: "snapshot.tables[0].primaryKey.columns must be an array",
  },
  {
    name: "enum values that are not an array",
    document: {
      tables: [usersTable],
      enums: [{ name: "role", values: "admin" }],
    },
    message: "snapshot.enums[0].values must be an array",
  },
  {
    name: "an enum value that is not a string",
    document: {
      tables: [usersTable],
      enums: [{ name: "role", values: [1] }],
    },
    message: "snapshot.enums[0].values[0] must be a string",
  },
  {
    name: "a polymorphic storage entry that is not an object",
    document: { tables: [usersTable], polymorphicStorage: ["subject"] },
    message: "snapshot.polymorphicStorage[0] must be an object",
  },
];

describe("snapshot value admission", () => {
  test.each(snapshotRefusals)("refuses $name", ({ document, message }) => {
    expect(admitSnapshot(document)).toThrowError(
      expect.objectContaining({
        code: VibORMErrorCode.MIGRATION_INVALID_ESTATE,
        message: expect.stringContaining(message),
      })
    );
  });
});

describe("marker value admission", () => {
  test("refuses an arrival path that is not an array", () => {
    // The path is the marker's whole authentication surface; a scalar there is
    // refused before `pathHash` is even compared against it.
    expect(() =>
      parseMarkerRow({
        estateHash: HASH,
        format: "1",
        path: "none",
        pathHash: HASH,
        revision: 1,
        snapshotHash: HASH,
        stateId: HASH,
        updatedAt: "2026-08-31T00:00:00.000Z",
      })
    ).toThrowError(
      expect.objectContaining({
        code: VibORMErrorCode.MIGRATION_INVALID_ESTATE,
        message: expect.stringContaining("marker.path must be an array"),
      })
    );
  });
});

const failedEvent: Omit<LedgerEventV1, "eventId"> = {
  format: "1",
  attemptId: HASH,
  kind: "failed",
  estateHash: HASH,
  snapshotHash: HASH,
  sqlHash: HASH,
  fromState: null,
  toState: HASH,
  transitionHash: HASH,
  direction: "forward",
  operationId: "op",
  dispatchId: HASH,
  effectState: "may-have-committed",
  startedAt: "2026-08-31T00:00:00.000Z",
  finishedAt: "2026-08-31T00:00:01.000Z",
  toolVersion: "v1",
  failure: "the provider refused the dispatch",
};

describe("ledger value admission", () => {
  test("refuses a ledger row that is not an object", () => {
    expect(() => parseLedgerEvent("started")).toThrowError(
      expect.objectContaining({
        code: VibORMErrorCode.MIGRATION_INVALID_ESTATE,
        message: expect.stringContaining("ledger event must be an object"),
      })
    );
  });

  test("admits a recorded failure reason beside its finished timestamp", () => {
    // `failure` and `finishedAt` are both nullable, and a terminal failed
    // event is the shape that carries them: the reason has to survive the
    // round trip verbatim, because it is the only evidence an operator has.
    const admitted = parseLedgerEvent({
      ...failedEvent,
      eventId: eventIdFor(failedEvent),
    });

    expect(admitted.failure).toBe("the provider refused the dispatch");
    expect(admitted.finishedAt).toBe("2026-08-31T00:00:01.000Z");
  });

  test("refuses a reset plan whose replay path is not an array", () => {
    // The plan's three arrays are checked together and before the event
    // identity is recomputed, so the placeholder `eventId` here is never
    // reached — the malformed plan is what throws.
    expect(() =>
      parseLedgerEvent({
        ...failedEvent,
        direction: "reset",
        eventId: ZERO,
        kind: "reset-started",
        resetPlan: {
          clearDispatches: [],
          estateHash: HASH,
          referencedStates: [],
          replayPath: "none",
          resetPlanHash: HASH,
          sourceFingerprint: HASH,
          sourceRevision: 0,
          targetIdentity: "sqlite",
        },
      })
    ).toThrowError(
      expect.objectContaining({
        code: VibORMErrorCode.MIGRATION_INVALID_ESTATE,
        message: expect.stringContaining("reset plan arrays are malformed"),
      })
    );
  });
});
