import { VibORMErrorCode } from "@src/errors";
import { canonicalizeJson } from "@src/migrations/canonical-json";
import { domainHash, HASH_DOMAIN } from "@src/migrations/identity";
import {
  encodeDispatchIdentity,
  encodePathHash,
  eventIdFor,
  parseDispatch,
  parseLedgerEvent,
  parseMarkerRow,
  parseMigrationTarget,
  parseSnapshotDocument,
} from "@src/migrations/v1-parse";
import type {
  LedgerEventV1,
  MigrationParameterV1,
} from "@src/migrations/v1-types";
import { describe, expect, test } from "vitest";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

function dispatchWith(parameters: readonly MigrationParameterV1[]) {
  return {
    dispatchId: encodeDispatchIdentity(HASH_A, 0, 0, parameters),
    sqlHash: HASH_A,
    offset: 0,
    length: 0,
    parameters,
  };
}

function ledgerEvent(overrides: Partial<Omit<LedgerEventV1, "eventId">> = {}) {
  const body = {
    format: "1" as const,
    attemptId: HASH_A,
    kind: "started" as const,
    estateHash: HASH_A,
    snapshotHash: HASH_B,
    sqlHash: null,
    fromState: null,
    toState: null,
    transitionHash: null,
    direction: "forward" as const,
    operationId: null,
    dispatchId: null,
    effectState: "none" as const,
    startedAt: "2026-08-31T00:00:00.000Z",
    finishedAt: null,
    toolVersion: "v1",
    failure: null,
    ...overrides,
  };
  return { ...body, eventId: eventIdFor(body) };
}

describe("migration V1 parser edge contracts", () => {
  test("dispatch admission covers every primitive tagged parameter", () => {
    const parameters: readonly MigrationParameterV1[] = [
      { kind: "null" },
      { kind: "target-namespace" },
      { kind: "boolean", value: true },
      { kind: "string", value: "text" },
      { kind: "number", value: 1.5 },
      { kind: "bigint", value: "-2" },
      { kind: "bytes", value: "AA==" },
      { kind: "date-time", value: "2026-08-31T00:00:00.000Z" },
      { kind: "decimal", value: "-1.25" },
      { kind: "json", value: { nested: [true, null] } },
    ];

    expect(
      parseDispatch(dispatchWith(parameters), "dispatch").parameters
    ).toEqual(parameters);
  });

  test.each([
    [null, "tagged parameter"],
    [{}, "tagged parameter"],
    [{ kind: "boolean", value: 1 }, "must be boolean"],
    [{ kind: "string", value: 1 }, "must be a string"],
    [{ kind: "number", value: Number.POSITIVE_INFINITY }, "finite number"],
    [{ kind: "bytes", value: 1 }, "canonical text"],
    [{ kind: "unknown" }, "not a V1 parameter tag"],
  ])("refuses malformed dispatch parameters %#", (parameter, message) => {
    expect(() =>
      parseDispatch(
        {
          dispatchId: HASH_A,
          sqlHash: HASH_A,
          offset: 0,
          length: 0,
          parameters: [parameter],
        },
        "dispatch"
      )
    ).toThrow(message);
  });

  test("migration targets require the exact dialect-owned shape", () => {
    expect(
      parseMigrationTarget(
        { dialect: "postgresql", namespace: "tenant" },
        "target"
      )
    ).toEqual({ dialect: "postgresql", namespace: "tenant" });
    expect(parseMigrationTarget({ dialect: "mysql" }, "target")).toEqual({
      dialect: "mysql",
    });
    expect(parseMigrationTarget({ dialect: "sqlite" }, "target")).toEqual({
      dialect: "sqlite",
    });
    expect(() =>
      parseMigrationTarget({ dialect: "postgresql", namespace: "" }, "target")
    ).toThrow("non-empty string");
  });

  test("marker admission authenticates path booleans, identity, and timestamps", () => {
    const path = [
      {
        stateId: HASH_A,
        transitionHash: HASH_B,
        baselineBoundary: false,
      },
    ];
    const marker = {
      format: "1",
      estateHash: HASH_A,
      stateId: HASH_A,
      snapshotHash: HASH_B,
      path,
      pathHash: encodePathHash(path),
      revision: 1,
      updatedAt: "2026-08-31T00:00:00.000Z",
    };
    expect(parseMarkerRow(marker).path).toEqual(path);
    expect(() =>
      parseMarkerRow({
        ...marker,
        path: [{ ...path[0]!, baselineBoundary: "no" }],
      })
    ).toThrow("must be boolean");
    expect(() => parseMarkerRow({ ...marker, pathHash: HASH_A })).toThrowError(
      expect.objectContaining({ code: VibORMErrorCode.MIGRATION_CORRUPTION })
    );
    expect(() => parseMarkerRow({ ...marker, updatedAt: "" })).toThrow(
      "ISO timestamp"
    );
  });

  test("ledger admission accepts closed kinds and verifies its event identity", () => {
    for (const kind of [
      "started",
      "step-confirmed",
      "applied",
      "failed",
      "rolled-back",
      "baselined",
      "resolved",
      "reset-step-confirmed",
      "reset-applied",
    ] satisfies LedgerEventV1["kind"][]) {
      expect(parseLedgerEvent(ledgerEvent({ kind })).kind).toBe(kind);
    }
    expect(() =>
      parseLedgerEvent({ ...ledgerEvent(), eventId: HASH_B })
    ).toThrowError(
      expect.objectContaining({ code: VibORMErrorCode.MIGRATION_CORRUPTION })
    );
  });

  test.each([
    [{ kind: "future" }, "not a V1 kind"],
    [{ effectState: "unknown" }, "effectState is invalid"],
    [{ direction: "sideways" }, "direction is invalid"],
    [{ startedAt: "" }, "startedAt must be a non-empty string"],
  ])("refuses malformed ledger values %#", (overrides, message) => {
    expect(() => parseLedgerEvent({ ...ledgerEvent(), ...overrides })).toThrow(
      message
    );
  });

  test("snapshot admission rejects an authentic document under the wrong filename", () => {
    const snapshot = {
      tables: [
        {
          name: "account",
          columns: [
            {
              name: "amount",
              type: "INTEGER",
              nullable: false,
              decimal: { precision: 1, scale: 0 },
            },
          ],
          indexes: [],
          foreignKeys: [],
          uniqueConstraints: [],
        },
      ],
    };
    const bytes = canonicalizeJson(snapshot);
    const actualHash = domainHash(HASH_DOMAIN.snapshot, bytes);
    expect(parseSnapshotDocument(bytes, actualHash)).toEqual(snapshot);
    expect(() => parseSnapshotDocument(bytes, HASH_A)).toThrowError(
      expect.objectContaining({ code: VibORMErrorCode.MIGRATION_CORRUPTION })
    );
    const invalid = canonicalizeJson({
      ...snapshot,
      tables: [
        {
          ...snapshot.tables[0],
          columns: [
            {
              ...snapshot.tables[0]!.columns[0],
              decimal: { precision: 0, scale: 0 },
            },
          ],
        },
      ],
    });
    expect(() => parseSnapshotDocument(invalid, actualHash)).toThrow(
      "positive safe integer"
    );
  });
});

describe("coverage low value", () => {
  test("dispatch ranges reject negative values before identity verification", () => {
    expect(() =>
      parseDispatch(
        {
          dispatchId: HASH_A,
          sqlHash: HASH_A,
          offset: -1,
          length: 0,
          parameters: [],
        },
        "dispatch"
      )
    ).toThrow("non-negative");
    expect(() =>
      parseDispatch(
        {
          dispatchId: HASH_A,
          sqlHash: HASH_A,
          offset: 0,
          length: 0,
          parameters: "none",
        },
        "dispatch"
      )
    ).toThrow("must be an array");
  });
});
