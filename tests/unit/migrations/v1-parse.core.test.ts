import { MigrationError, VibORMErrorCode } from "@src/errors";
import { canonicalizeJson } from "@src/migrations/canonical-json";
import { emptyManagedSnapshot } from "@src/migrations/empty-snapshot";
import { domainHash, HASH_DOMAIN } from "@src/migrations/identity";
import { composeSqlBlob } from "@src/migrations/sql-blob";
import {
  encodeDispatchIdentity,
  encodeEstateDescriptor,
  encodePathHash,
  encodeSnapshot,
  encodeStateManifest,
  encodeTransitionHash,
  eventIdFor,
  parseDispatch,
  parseEstateDescriptor,
  parseLedgerEvent,
  parseMarkerRow,
  parseMigrationTarget,
  parseSnapshotDocument,
  parseStateManifest,
} from "@src/migrations/v1-parse";
import { describe, expect, expectTypeOf, test } from "vitest";

const SHA256 = "0".repeat(64);

function parseSnapshot(value: unknown) {
  const bytes = canonicalizeJson(value);
  return parseSnapshotDocument(bytes, domainHash(HASH_DOMAIN.snapshot, bytes));
}

const completeSnapshot = {
  tables: [
    {
      name: "users",
      columns: [
        {
          name: "id",
          type: "text",
          nullable: false,
        },
      ],
      primaryKey: {
        columns: ["id"],
        name: "users_pkey",
      },
      indexes: [
        {
          name: "users_id_idx",
          columns: ["id"],
          unique: true,
        },
      ],
      foreignKeys: [],
      uniqueConstraints: [
        {
          name: "users_id_key",
          columns: ["id"],
        },
      ],
    },
  ],
  enums: [
    {
      name: "role",
      values: ["admin", "member"],
    },
  ],
};

const ledgerEvent = {
  format: "1",
  eventId: SHA256,
  attemptId: SHA256,
  kind: "started",
  estateHash: SHA256,
  snapshotHash: SHA256,
  sqlHash: null,
  fromState: null,
  toState: null,
  transitionHash: null,
  direction: "forward",
  operationId: null,
  dispatchId: null,
  effectState: "none",
  startedAt: "2026-08-28T00:00:00.000Z",
  finishedAt: null,
  toolVersion: "v1",
  failure: null,
};

describe("migration v1 hostile parsers", () => {
  test("admits only canonical persisted parameter spellings", () => {
    const admitted = [
      { kind: "target-namespace" as const },
      { kind: "bigint" as const, value: "-9007199254740993" },
      { kind: "bytes" as const, value: "AAE=" },
      { kind: "date-time" as const, value: "2026-08-29T12:34:56.789Z" },
      { kind: "decimal" as const, value: "-12.34" },
    ];
    const dispatch = {
      sqlHash: SHA256,
      offset: 0,
      length: 0,
      parameters: admitted,
      dispatchId: encodeDispatchIdentity(SHA256, 0, 0, admitted),
    };
    expect(parseDispatch(dispatch, "dispatch").parameters).toEqual(admitted);

    for (const parameter of [
      { kind: "target-namespace", value: "tenant" },
      { kind: "bigint", value: "01" },
      { kind: "bigint", value: "-0" },
      { kind: "bytes", value: "not base64" },
      { kind: "bytes", value: "AAE" },
      { kind: "date-time", value: "2026-08-29" },
      { kind: "date-time", value: "not-a-date" },
      { kind: "decimal", value: "+12.340" },
      { kind: "decimal", value: "1e2" },
    ]) {
      expect(() =>
        parseDispatch(
          {
            dispatchId: SHA256,
            sqlHash: SHA256,
            offset: 0,
            length: 0,
            parameters: [parameter],
          },
          "dispatch"
        )
      ).toThrow(MigrationError);
    }
  });

  test("admits a structurally complete snapshot", () => {
    expect(parseSnapshot(completeSnapshot)).toEqual(completeSnapshot);
  });

  test("admits and validates fixed-decimal column descriptors", () => {
    const decimalSnapshot = {
      ...completeSnapshot,
      tables: [
        {
          ...completeSnapshot.tables[0],
          columns: [
            {
              ...completeSnapshot.tables[0]!.columns[0],
              type: "numeric(10,5)",
              decimal: { precision: 10, scale: 5 },
            },
          ],
        },
      ],
    };
    expect(parseSnapshot(decimalSnapshot)).toEqual(decimalSnapshot);
    expect(() =>
      parseSnapshot({
        ...decimalSnapshot,
        tables: [
          {
            ...decimalSnapshot.tables[0],
            columns: [
              {
                ...decimalSnapshot.tables[0]!.columns[0],
                decimal: { precision: 4, scale: 5 },
              },
            ],
          },
        ],
      })
    ).toThrow(MigrationError);
  });

  test("refuses hostile keys at every snapshot nesting level", () => {
    expect(() =>
      parseSnapshot({
        ...completeSnapshot,
        tables: [
          {
            ...completeSnapshot.tables[0],
            hostile: true,
          },
        ],
      })
    ).toThrow(MigrationError);
    expect(() =>
      parseSnapshot({
        ...completeSnapshot,
        tables: [
          {
            ...completeSnapshot.tables[0],
            columns: [
              {
                ...completeSnapshot.tables[0]!.columns[0],
                hostile: true,
              },
            ],
          },
        ],
      })
    ).toThrow(MigrationError);
    expect(() =>
      parseSnapshot({
        ...completeSnapshot,
        enums: [
          {
            ...completeSnapshot.enums[0],
            hostile: true,
          },
        ],
      })
    ).toThrow(MigrationError);
  });

  test("refuses wrong nested snapshot types", () => {
    expect(() =>
      parseSnapshot({
        ...completeSnapshot,
        tables: [
          {
            ...completeSnapshot.tables[0],
            columns: "id",
          },
        ],
      })
    ).toThrow(MigrationError);
    expect(() =>
      parseSnapshot({
        ...completeSnapshot,
        tables: [
          {
            ...completeSnapshot.tables[0],
            columns: [
              {
                ...completeSnapshot.tables[0]!.columns[0],
                nullable: "false",
              },
            ],
          },
        ],
      })
    ).toThrow(MigrationError);
    expect(() =>
      parseSnapshot({
        ...completeSnapshot,
        enums: {},
      })
    ).toThrow(MigrationError);
  });

  test("refuses unknown ledger and reset-plan keys", () => {
    expect(() => parseLedgerEvent({ ...ledgerEvent, hostile: true })).toThrow(
      MigrationError
    );
    expect(() =>
      parseLedgerEvent({
        ...ledgerEvent,
        kind: "reset-started",
        direction: "reset",
        resetPlan: {
          estateHash: SHA256,
          targetIdentity: "sqlite:test",
          sourceRevision: 0,
          sourceFingerprint: SHA256,
          replayPath: [],
          clearDispatches: [],
          referencedStates: [],
          resetPlanHash: SHA256,
          hostile: true,
        },
      })
    ).toThrow(MigrationError);
  });

  test("resetPlanHash must match the canonical plan even when eventId does", () => {
    const planBody = {
      estateHash: SHA256,
      targetIdentity: "sqlite:",
      sourceRevision: 0,
      sourceFingerprint: SHA256,
      replayPath: [] as const,
      clearDispatches: [] as const,
      referencedStates: [] as const,
    };
    const resetPlanHash = domainHash(
      HASH_DOMAIN.resetPlan,
      canonicalizeJson(planBody)
    );
    const body = {
      format: "1" as const,
      attemptId: SHA256,
      kind: "reset-started" as const,
      estateHash: SHA256,
      snapshotHash: SHA256,
      sqlHash: null,
      fromState: null,
      toState: null,
      transitionHash: null,
      direction: "reset" as const,
      operationId: null,
      dispatchId: null,
      effectState: "none" as const,
      startedAt: "2026-08-28T00:00:00.000Z",
      finishedAt: null,
      toolVersion: "v1",
      resetPlan: { ...planBody, resetPlanHash },
      failure: null,
    };
    expect(
      parseLedgerEvent({ ...body, eventId: eventIdFor(body) }).resetPlan
        ?.resetPlanHash
    ).toBe(resetPlanHash);
    const tampered = {
      ...body,
      resetPlan: { ...planBody, resetPlanHash: "1".repeat(64) },
    };
    expect(() =>
      parseLedgerEvent({ ...tampered, eventId: eventIdFor(tampered) })
    ).toThrow(MigrationError);
    try {
      parseLedgerEvent({ ...tampered, eventId: eventIdFor(tampered) });
    } catch (error) {
      expect(error).toBeInstanceOf(MigrationError);
      expect((error as MigrationError).code).toBe(
        VibORMErrorCode.MIGRATION_CORRUPTION
      );
      expect((error as MigrationError).message).toContain("resetPlanHash");
    }
  });

  test("refuses unknown versions at every JSON boundary", () => {
    expect(() =>
      parseEstateDescriptor(
        canonicalizeJson({
          format: "2",
          hash: "sha256",
          target: { dialect: "sqlite" },
        })
      )
    ).toThrow(MigrationError);
    expect(() =>
      parseEstateDescriptor(
        canonicalizeJson({
          format: 1,
          hash: "sha256",
          target: { dialect: "sqlite" },
        })
      )
    ).toThrow(MigrationError);
    expect(() =>
      parseMigrationTarget({ dialect: "postgres" }, "target")
    ).toThrow(MigrationError);
    expect(() => parseLedgerEvent({ ...ledgerEvent, format: "2" })).toThrow(
      MigrationError
    );
    expect(() =>
      parseLedgerEvent({ ...ledgerEvent, kind: "v2-started" })
    ).toThrow(MigrationError);
    expect(() =>
      parseEstateDescriptor(
        canonicalizeJson({
          format: "1",
          hash: "sha1",
          target: { dialect: "sqlite" },
        })
      )
    ).toThrow(MigrationError);
    expect(() =>
      parseMigrationTarget({ dialect: "postgresql" }, "target")
    ).toThrow(MigrationError);
    expectTypeOf(ledgerEvent.format).toMatchTypeOf<string>();
    expect(() =>
      parseMarkerRow({
        format: "2",
        estateHash: SHA256,
        stateId: null,
        snapshotHash: SHA256,
        path: [],
        pathHash: encodePathHash([]),
        revision: 1,
        updatedAt: "2026-08-28T00:00:00.000Z",
      })
    ).toThrow(MigrationError);
  });

  test("refuses hostile keys on estate, target, marker, dispatch, and state", () => {
    expect(() =>
      parseEstateDescriptor(
        canonicalizeJson({
          format: "1",
          hash: "sha256",
          target: { dialect: "sqlite" },
          hostile: true,
        })
      )
    ).toThrow(MigrationError);
    expect(() =>
      parseMigrationTarget({ dialect: "sqlite", hostile: true }, "target")
    ).toThrow(MigrationError);
    expect(() =>
      parseMigrationTarget(
        { dialect: "postgresql", namespace: "alpha", hostile: true },
        "target"
      )
    ).toThrow(MigrationError);
    const blob = composeSqlBlob(["SELECT 1"]);
    const dispatch = {
      dispatchId: encodeDispatchIdentity(
        blob.sqlHash,
        0,
        blob.bytes.length,
        []
      ),
      sqlHash: blob.sqlHash,
      offset: 0,
      length: blob.bytes.length,
      parameters: [],
    };
    expect(parseDispatch(dispatch, "dispatch")).toEqual(dispatch);
    expect(() =>
      parseDispatch({ ...dispatch, hostile: true }, "dispatch")
    ).toThrow(MigrationError);
    const marker = {
      format: "1" as const,
      estateHash: SHA256,
      stateId: null,
      snapshotHash: SHA256,
      path: [],
      pathHash: encodePathHash([]),
      revision: 1,
      updatedAt: "2026-08-28T00:00:00.000Z",
    };
    expect(parseMarkerRow(marker).format).toBe("1");
    expect(() => parseMarkerRow({ ...marker, hostile: true })).toThrow(
      MigrationError
    );
    expect(() =>
      parseMarkerRow({
        ...marker,
        path: [
          {
            stateId: SHA256,
            transitionHash: SHA256,
            baselineBoundary: false,
            hostile: true,
          },
        ],
        pathHash: encodePathHash([
          { stateId: SHA256, transitionHash: SHA256, baselineBoundary: false },
        ]),
      })
    ).toThrow(MigrationError);

    const estate = encodeEstateDescriptor({ dialect: "sqlite" });
    const snapshot = encodeSnapshot(emptyManagedSnapshot());
    const parent = {
      fromState: null,
      originChecks: [],
      requestedForwardBoundary: null,
      operations: [],
      rollback: { kind: "irreversible" as const, reason: "empty" },
    };
    const encoded = encodeStateManifest({
      format: "1",
      estateHash: estate.estateHash,
      name: "root",
      snapshotHash: snapshot.snapshotHash,
      sqlHash: blob.sqlHash,
      destinationChecks: [],
      parents: [{ ...parent, transitionHash: encodeTransitionHash(parent) }],
    });
    expect(parseStateManifest(encoded.bytes, encoded.stateId).stateId).toBe(
      encoded.stateId
    );
    const parsed = JSON.parse(
      new TextDecoder().decode(encoded.bytes)
    ) as Record<string, unknown>;
    expect(() =>
      parseStateManifest(
        canonicalizeJson({ ...parsed, hostile: true }),
        encoded.stateId
      )
    ).toThrow(MigrationError);
    expect(() =>
      parseStateManifest(
        canonicalizeJson({ ...parsed, format: "2" }),
        encoded.stateId
      )
    ).toThrow(MigrationError);
    try {
      parseEstateDescriptor(
        canonicalizeJson({
          format: "2",
          hash: "sha256",
          target: { dialect: "sqlite" },
        })
      );
    } catch (error) {
      expect(error).toBeInstanceOf(MigrationError);
      expect((error as MigrationError).code).toBe(
        VibORMErrorCode.MIGRATION_INVALID_ESTATE
      );
    }
  });

  test("refuses hostile keys on remaining snapshot nesting levels", () => {
    expect(() =>
      parseSnapshot({
        ...completeSnapshot,
        tables: [
          {
            ...completeSnapshot.tables[0],
            primaryKey: {
              ...completeSnapshot.tables[0]!.primaryKey,
              hostile: true,
            },
          },
        ],
      })
    ).toThrow(MigrationError);
    expect(() =>
      parseSnapshot({
        ...completeSnapshot,
        tables: [
          {
            ...completeSnapshot.tables[0],
            indexes: [
              {
                ...completeSnapshot.tables[0]!.indexes[0],
                hostile: true,
              },
            ],
          },
        ],
      })
    ).toThrow(MigrationError);
    expect(() =>
      parseSnapshot({
        ...completeSnapshot,
        tables: [
          {
            ...completeSnapshot.tables[0],
            uniqueConstraints: [
              {
                ...completeSnapshot.tables[0]!.uniqueConstraints[0],
                hostile: true,
              },
            ],
          },
        ],
      })
    ).toThrow(MigrationError);
    expect(() => parseSnapshot({ ...completeSnapshot, hostile: true })).toThrow(
      MigrationError
    );
  });

  test("refuses generated and manual combinations that cannot exist", () => {
    const estate = encodeEstateDescriptor({ dialect: "sqlite" });
    const snapshot = encodeSnapshot(emptyManagedSnapshot());
    const blob = composeSqlBlob(["SELECT 1"]);
    const execute = {
      dispatchId: encodeDispatchIdentity(
        blob.sqlHash,
        0,
        blob.bytes.length,
        []
      ),
      sqlHash: blob.sqlHash,
      offset: 0,
      length: blob.bytes.length,
      parameters: [],
    };
    const generated = {
      id: "generated",
      label: "generated",
      origin: "generated" as const,
      risk: "safe" as const,
      steps: [{ retry: "opaque" as const, execute }],
    };
    const manual = {
      id: "manual",
      label: "manual",
      origin: "manual" as const,
      risk: "opaque" as const,
      steps: [{ retry: "opaque" as const, execute }],
    };
    const seal = (parent: Parameters<typeof encodeTransitionHash>[0]) => {
      const encoded = encodeStateManifest({
        format: "1",
        estateHash: estate.estateHash,
        name: "mixed",
        snapshotHash: snapshot.snapshotHash,
        sqlHash: blob.sqlHash,
        destinationChecks: [],
        parents: [{ ...parent, transitionHash: encodeTransitionHash(parent) }],
      });
      return () => parseStateManifest(encoded.bytes, encoded.stateId);
    };

    expect(
      seal({
        fromState: null,
        originChecks: [],
        requestedForwardBoundary: null,
        operations: [generated, manual],
        rollback: { kind: "irreversible", reason: "empty" },
      })
    ).toThrow(MigrationError);
    expect(
      seal({
        fromState: null,
        originChecks: [],
        requestedForwardBoundary: "transactional",
        operations: [generated],
        rollback: { kind: "irreversible", reason: "empty" },
      })
    ).toThrow(MigrationError);
    expect(
      seal({
        fromState: null,
        originChecks: [],
        requestedForwardBoundary: null,
        operations: [generated],
        rollback: {
          kind: "manual",
          requestedBoundary: "transactional",
          operations: [manual],
        },
      })
    ).toThrow(MigrationError);
    expect(
      seal({
        fromState: null,
        originChecks: [],
        requestedForwardBoundary: null,
        operations: [generated],
        rollback: { kind: "irreversible", reason: "   " },
      })
    ).toThrow(MigrationError);
  });
});
