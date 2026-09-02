import { checkEstate } from "@src/migrations/check";
import { unfinishedAttempts } from "@src/migrations/control";
import { loadMigrationGraph, selectRoute } from "@src/migrations/graph";
import { composeSqlBlob } from "@src/migrations/sql-blob";
import { MemoryEstateStorage } from "@src/migrations/storage/memory";
import {
  encodeDispatchIdentity,
  encodeEstateDescriptor,
  encodeSnapshot,
  encodeStateManifest,
  encodeTransitionHash,
} from "@src/migrations/v1-parse";
import type { LedgerEventV1 } from "@src/migrations/v1-types";
import { describe, expect, test } from "vitest";

describe("migration v1 scale gates", () => {
  test("100,000 ledger events classify unfinished attempts in one pass", () => {
    const events: LedgerEventV1[] = [];
    for (let i = 0; i < 100_000; i++) {
      const attemptId = i.toString(16).padStart(64, "0");
      events.push({
        format: "1",
        eventId: (i + 1).toString(16).padStart(64, "0"),
        attemptId,
        kind: i === 99_999 ? "started" : "applied",
        estateHash: "0".repeat(64),
        snapshotHash: "0".repeat(64),
        sqlHash: null,
        fromState: null,
        toState: "0".repeat(64),
        transitionHash: null,
        direction: "forward",
        operationId: null,
        dispatchId: null,
        effectState: "committed",
        startedAt: "2026-01-01T00:00:00.000Z",
        finishedAt: i === 99_999 ? null : "2026-01-01T00:00:00.000Z",
        toolVersion: "v1",
        failure: null,
      });
    }
    const open = unfinishedAttempts(events);
    expect(open).toHaveLength(1);
    expect(open[0]!.kind).toBe("started");
  });

  test("a 20-leaf merge requires via rather than picking a route", async () => {
    const storage = new MemoryEstateStorage();
    const estate = encodeEstateDescriptor({ dialect: "sqlite" });
    await storage.publishEstate(estate.bytes);
    const snapshot = encodeSnapshot({ tables: [], enums: [] });
    await storage.publishSnapshot(snapshot.snapshotHash, snapshot.bytes);
    const blob = composeSqlBlob(["SELECT 1"]);
    await storage.publishSql(blob.sqlHash, blob.bytes);
    const execute = {
      dispatchId: encodeDispatchIdentity(
        blob.sqlHash,
        0,
        blob.ranges[0]!.length,
        []
      ),
      sqlHash: blob.sqlHash,
      offset: 0,
      length: blob.ranges[0]!.length,
      parameters: [],
    };
    const parentBody = {
      fromState: null,
      originChecks: [],
      requestedForwardBoundary: null,
      operations: [
        {
          id: "leaf",
          label: "leaf",
          origin: "generated" as const,
          risk: "safe" as const,
          steps: [{ retry: "opaque" as const, execute }],
        },
      ],
      rollback: { kind: "irreversible" as const, reason: "scale" },
    };
    const leaves: string[] = [];
    for (let i = 0; i < 20; i++) {
      const encoded = encodeStateManifest({
        format: "1",
        estateHash: estate.estateHash,
        name: `leaf-${i}`,
        snapshotHash: snapshot.snapshotHash,
        sqlHash: blob.sqlHash,
        destinationChecks: [],
        parents: [
          { ...parentBody, transitionHash: encodeTransitionHash(parentBody) },
        ],
      });
      await storage.publishState(encoded.stateId, encoded.bytes);
      leaves.push(encoded.stateId);
    }
    const graph = await loadMigrationGraph(storage);
    expect(graph.leaves).toHaveLength(20);
    expect(selectRoute(graph, null, leaves[0]!)).toEqual([leaves[0]]);
    await expect(checkEstate(storage)).resolves.toMatchObject({
      ok: false,
      findings: [expect.objectContaining({ code: "unresolved-branch" })],
    });
  });

  test("10,000 linear states load without quadratic refusal", async () => {
    const storage = new MemoryEstateStorage();
    const estate = encodeEstateDescriptor({ dialect: "sqlite" });
    await storage.publishEstate(estate.bytes);
    const snapshot = encodeSnapshot({ tables: [], enums: [] });
    await storage.publishSnapshot(snapshot.snapshotHash, snapshot.bytes);
    const blob = composeSqlBlob(["SELECT 1"]);
    await storage.publishSql(blob.sqlHash, blob.bytes);
    const execute = {
      dispatchId: encodeDispatchIdentity(
        blob.sqlHash,
        0,
        blob.ranges[0]!.length,
        []
      ),
      sqlHash: blob.sqlHash,
      offset: 0,
      length: blob.ranges[0]!.length,
      parameters: [],
    };
    let parent: string | null = null;
    let last = "";
    for (let i = 0; i < 10_000; i++) {
      const parentBody = {
        fromState: parent,
        originChecks: [],
        requestedForwardBoundary: null,
        operations: [
          {
            id: `step-${i}`,
            label: "step",
            origin: "generated" as const,
            risk: "safe" as const,
            steps: [{ retry: "opaque" as const, execute }],
          },
        ],
        rollback: { kind: "irreversible" as const, reason: "scale" },
      };
      const encoded = encodeStateManifest({
        format: "1",
        estateHash: estate.estateHash,
        name: `s-${i}`,
        snapshotHash: snapshot.snapshotHash,
        sqlHash: blob.sqlHash,
        destinationChecks: [],
        parents: [
          { ...parentBody, transitionHash: encodeTransitionHash(parentBody) },
        ],
      });
      await storage.publishState(encoded.stateId, encoded.bytes);
      parent = encoded.stateId;
      last = encoded.stateId;
    }
    const graph = await loadMigrationGraph(storage);
    expect(graph.states.size).toBe(10_000);
    expect(selectRoute(graph, null, last).length).toBe(10_000);
  });

  test("1,000 snapshots load linearly and orphans cannot become history", async () => {
    const storage = new MemoryEstateStorage();
    const estate = encodeEstateDescriptor({ dialect: "sqlite" });
    await storage.publishEstate(estate.bytes);
    const referenced = encodeSnapshot({ tables: [], enums: [] });
    await storage.publishSnapshot(referenced.snapshotHash, referenced.bytes);
    const blob = composeSqlBlob([]);
    await storage.publishSql(blob.sqlHash, blob.bytes);
    const parentBody = {
      fromState: null,
      originChecks: [],
      requestedForwardBoundary: null,
      operations: [] as const,
      rollback: { kind: "irreversible" as const, reason: "scale" },
    };
    const encoded = encodeStateManifest({
      format: "1",
      estateHash: estate.estateHash,
      name: "root",
      snapshotHash: referenced.snapshotHash,
      sqlHash: blob.sqlHash,
      destinationChecks: [],
      parents: [
        { ...parentBody, transitionHash: encodeTransitionHash(parentBody) },
      ],
    });
    await storage.publishState(encoded.stateId, encoded.bytes);

    const orphanHashes: string[] = [];
    for (let i = 0; i < 1000; i++) {
      const orphan = encodeSnapshot({
        tables: [
          {
            name: `t${i}`,
            columns: [{ name: "id", type: "text", nullable: false }],
            indexes: [],
            foreignKeys: [],
            uniqueConstraints: [],
          },
        ],
        enums: [],
      });
      await storage.publishSnapshot(orphan.snapshotHash, orphan.bytes);
      orphanHashes.push(orphan.snapshotHash);
    }
    const orphanSql = composeSqlBlob(["SELECT 'orphan'"]);
    await storage.publishSql(orphanSql.sqlHash, orphanSql.bytes);
    const corruptSqlHash = "f".repeat(64);
    await storage.publishSql(
      corruptSqlHash,
      new TextEncoder().encode("SELECT 2")
    );

    const checked = await checkEstate(storage);
    const orphans = checked.findings.filter(
      (finding) => finding.code === "orphan-snapshot"
    );
    expect(orphans).toHaveLength(1000);
    expect(checked.ok).toBe(false);
    expect(checked.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "orphan-sql",
          message: expect.stringContaining(orphanSql.sqlHash),
        }),
        expect.objectContaining({
          code: "corrupt-sql",
          message: expect.stringContaining(corruptSqlHash),
        }),
      ])
    );
    expect(
      checked.findings.some((finding) => finding.code === "invalid-estate")
    ).toBe(false);

    const graph = await loadMigrationGraph(storage);
    expect(graph.states.size).toBe(1);
    expect(
      graph.snapshots.has(referenced.snapshotHash) ||
        graph.emptySnapshotHash === referenced.snapshotHash
    ).toBe(true);
    for (const hash of orphanHashes) {
      expect(graph.snapshots.has(hash)).toBe(false);
    }
    expect(await storage.listSnapshots()).toHaveLength(1001);
  });
});
