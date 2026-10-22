import assert from "node:assert/strict";
import {
  encodeSnapshotArtifact,
  type ResolvedSnapshotArtifact,
  resolveSnapshotArtifacts,
} from "@src/migrations/snapshot-artifacts";
import { MemoryEstateStorage } from "@src/migrations/storage/memory";
import { encodeSnapshot } from "@src/migrations/v1-parse-snapshot";
import { test } from "vitest";

test("measure complete incremental snapshot history, including full checkpoints", async () => {
  function schema(version: number) {
    return {
      enums: [],
      tables: Array.from({ length: 100 }, (_, table) => ({
        name: `entity_${table}`,
        columns: Array.from({ length: 20 }, (_, column) => ({
          name: `column_${column}`,
          type: "TEXT",
          nullable: false,
          default: `'${table === 0 && column === 0 ? version : 0}'`,
        })),
        primaryKey: { columns: ["column_0"] },
        indexes: [],
        foreignKeys: [],
        uniqueConstraints: [],
      })),
    };
  }

  const storage = new MemoryEstateStorage();
  let artifacts = new Map<string, ResolvedSnapshotArtifact>();
  let previous: string | undefined;
  let fullSnapshotBytes = 0;
  let incrementalBytes = 0;
  let fullCount = 0;
  let deltaCount = 0;
  const snapshots = 100;
  const physicalHashes: string[] = [];
  for (let version = 0; version < snapshots; version++) {
    const snapshot = schema(version);
    const full = encodeSnapshot(snapshot);
    fullSnapshotBytes += full.bytes.length;
    const encoded = encodeSnapshotArtifact(
      snapshot,
      artifacts,
      previous ? [previous] : []
    );
    assert.ok(encoded.bytes);
    await storage.publishSnapshot(encoded.artifactHash, encoded.bytes);
    incrementalBytes += encoded.bytes.length;
    if (encoded.artifactHash === encoded.snapshotHash) fullCount++;
    else deltaCount++;
    artifacts = await resolveSnapshotArtifacts(
      storage,
      [encoded.artifactHash],
      artifacts
    );
    assert.deepEqual(artifacts.get(encoded.artifactHash)!.snapshot, snapshot);
    assert.equal(
      artifacts.get(encoded.artifactHash)!.snapshotHash,
      full.snapshotHash
    );
    physicalHashes.push(encoded.artifactHash);
    previous = encoded.artifactHash;
  }
  // Reconstruct from durable bytes without relying on the generator's warm cache.
  const cold = await resolveSnapshotArtifacts(
    storage,
    [...physicalHashes].reverse()
  );
  assert.equal(cold.size, snapshots);
  let storedBytes = 0;
  for (const hash of await storage.listSnapshots())
    storedBytes += (await storage.readSnapshot(hash))!.length;
  assert.equal(storedBytes, incrementalBytes);

  const tiny = { tables: [] };
  const small = encodeSnapshotArtifact(tiny, artifacts, [previous!]);
  assert.equal(small.artifactHash, small.snapshotHash);
  assert.deepEqual(small.bytes, encodeSnapshot(tiny).bytes);

  assert.ok(incrementalBytes < fullSnapshotBytes / 20);
  process.stdout.write(
    `${JSON.stringify(
      {
        scenario:
          "100 tables × 20 columns; initial schema plus 99 one-default changes",
        snapshots,
        fullCount,
        deltaCount,
        fullSnapshotBytes,
        incrementalBytes,
        savedBytes: fullSnapshotBytes - incrementalBytes,
        reductionPercent: Number(
          ((1 - incrementalBytes / fullSnapshotBytes) * 100).toFixed(2)
        ),
        maximumDeltaDepth: Math.max(
          ...[...cold.values()].map((artifact) => artifact.depth)
        ),
        tinyDestinationBytes: small.bytes!.length,
        checks:
          "Every schema and logical hash round-tripped; cold reverse-order reconstruction; exact stored-byte count; tiny full fallback",
        exclusions:
          "SQL and state manifests are not included in these snapshot-only byte totals. No database, latency or memory improvement is measured.",
      },
      null,
      2
    )}\n`
  );
});
