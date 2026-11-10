/**
 * `snapshot-delta-2`: named collections diff by key, so inserting a table,
 * column or enum value mid-array is one change instead of a rewrite of every
 * element after it (Pyxel's one-table migration stored 795 changes, 68 KB).
 * The reader stays positional; only the encoder knows about names.
 */

import { canonicalizeJson } from "@src/migrations/canonical-json";
import { domainHash, HASH_DOMAIN } from "@src/migrations/identity";
import {
  encodeSnapshotArtifact,
  type ResolvedSnapshotArtifact,
  resolveSnapshotArtifacts,
} from "@src/migrations/snapshot-artifacts";
import { MemoryEstateStorage } from "@src/migrations/storage/memory";
import type { SchemaSnapshot } from "@src/migrations/types";
import { encodeSnapshot } from "@src/migrations/v1-parse";
import {
  columnsOf,
  heterogeneousSchema as schema,
  TYPES,
  heterogeneousTable as table,
} from "@tests/fixtures/heterogeneous-snapshot";
import { describe, expect, test } from "vitest";

const NAMES = Array.from(
  { length: 30 },
  (_, index) => `entity_${String(index).padStart(2, "0")}`
);

function decode(bytes: Uint8Array): Record<string, unknown> {
  return JSON.parse(new TextDecoder().decode(bytes));
}

async function encodeOver(base: SchemaSnapshot, desired: SchemaSnapshot) {
  const storage = new MemoryEstateStorage();
  const root = encodeSnapshot(base);
  await storage.publishSnapshot(root.snapshotHash, root.bytes);
  const artifacts = await resolveSnapshotArtifacts(storage, [
    root.snapshotHash,
  ]);
  const encoded = encodeSnapshotArtifact(desired, artifacts, [
    root.snapshotHash,
  ]);
  await storage.publishSnapshot(encoded.artifactHash, encoded.bytes!);
  const cold = await resolveSnapshotArtifacts(storage, [encoded.artifactHash]);
  return {
    delta: decode(encoded.bytes!),
    rebuilt: cold.get(encoded.artifactHash)?.snapshot,
  };
}

describe("keyed snapshot deltas", () => {
  test("a table inserted mid-array is one insert", async () => {
    const desired = schema([
      ...NAMES.slice(0, 12),
      "document_component",
      ...NAMES.slice(12),
    ]);
    const { delta, rebuilt } = await encodeOver(schema(NAMES), desired);
    expect(delta.format).toBe("snapshot-delta-2");
    expect(rebuilt).toEqual(desired);
    expect(delta.changes).toEqual([
      { op: "insert", path: ["tables", 12], value: desired.tables[12] },
    ]);
  });

  test("a column inserted mid-table is one insert", async () => {
    const desired = schema(NAMES);
    const columns = desired.tables[7]!.columns;
    const added = { name: "inserted", type: "TEXT", nullable: true };
    columns.splice(3, 0, added);
    const { delta, rebuilt } = await encodeOver(schema(NAMES), desired);
    expect(delta.format).toBe("snapshot-delta-2");
    expect(rebuilt).toEqual(desired);
    expect(delta.changes).toEqual([
      { op: "insert", path: ["tables", 7, "columns", 3], value: added },
    ]);
  });

  test("an enum value inserted mid-list is one insert", async () => {
    const desired = schema(NAMES);
    desired.enums![0]!.values.splice(1, 0, "suggest");
    const { delta, rebuilt } = await encodeOver(schema(NAMES), desired);
    expect(delta.format).toBe("snapshot-delta-2");
    expect(rebuilt).toEqual(desired);
    expect(delta.changes).toEqual([
      { op: "insert", path: ["enums", 0, "values", 1], value: "suggest" },
    ]);
  });

  test("dropping the first table is one removal", async () => {
    const desired = schema(NAMES.slice(1));
    const { delta, rebuilt } = await encodeOver(schema(NAMES), desired);
    expect(delta.format).toBe("snapshot-delta-2");
    expect(rebuilt).toEqual(desired);
    expect(delta.changes).toEqual([{ op: "remove", path: ["tables", 0] }]);
  });

  test("a moved table is removed and inserted where it lands", async () => {
    const moved = [...NAMES.slice(1, 20), NAMES[0]!, ...NAMES.slice(20)];
    const desired = schema(moved);
    const { delta, rebuilt } = await encodeOver(schema(NAMES), desired);
    expect(delta.format).toBe("snapshot-delta-2");
    expect(rebuilt).toEqual(desired);
    expect(delta.changes).toEqual([
      { op: "remove", path: ["tables", 0] },
      { op: "insert", path: ["tables", 19], value: desired.tables[19] },
    ]);
  });

  test("a column renamed in place keeps the smaller positional edit", async () => {
    const desired = schema(NAMES);
    desired.tables[4]!.columns[2]!.name = "renamed";
    const { delta, rebuilt } = await encodeOver(schema(NAMES), desired);
    expect(delta.format).toBe("snapshot-delta-2");
    expect(rebuilt).toEqual(desired);
    expect(delta.changes).toEqual([
      {
        op: "set",
        path: ["tables", 4, "columns", 2, "name"],
        value: "renamed",
      },
    ]);
  });
});

async function publishDelta(
  storage: MemoryEstateStorage,
  base: SchemaSnapshot,
  desired: SchemaSnapshot,
  changes: unknown[],
  format: string
) {
  const root = encodeSnapshot(base);
  await storage.publishSnapshot(root.snapshotHash, root.bytes);
  const bytes = canonicalizeJson({
    format,
    baseArtifactHash: root.snapshotHash,
    snapshotHash: encodeSnapshot(desired).snapshotHash,
    changes,
  });
  const hash = domainHash(HASH_DOMAIN.snapshotDelta, bytes);
  await storage.publishSnapshot(hash, bytes);
  return { root: root.snapshotHash, hash };
}

describe("snapshot-delta-2 admission", () => {
  const base = schema(["alpha", "beta", "gamma"]);

  test.each([
    ["inserts mid-array", ["alpha", "delta", "beta", "gamma"], 1],
    ["inserts at the array's length", ["alpha", "beta", "gamma", "delta"], 3],
  ])("%s", async (_label, names, index) => {
    const storage = new MemoryEstateStorage();
    const desired = schema(names);
    const { hash } = await publishDelta(
      storage,
      base,
      desired,
      [
        {
          op: "insert",
          path: ["tables", index],
          value: table("delta", columnsOf("delta")),
        },
      ],
      "snapshot-delta-2"
    );
    const resolved = await resolveSnapshotArtifacts(storage, [hash]);
    expect(resolved.get(hash)?.snapshot).toEqual(desired);
  });

  test("removes any array index", async () => {
    const storage = new MemoryEstateStorage();
    const desired = schema(["beta", "gamma"]);
    const { hash } = await publishDelta(
      storage,
      base,
      desired,
      [{ op: "remove", path: ["tables", 0] }],
      "snapshot-delta-2"
    );
    const resolved = await resolveSnapshotArtifacts(storage, [hash]);
    expect(resolved.get(hash)?.snapshot).toEqual(desired);
  });

  test.each([
    [
      "an insert in a delta-1 document",
      "snapshot-delta-1",
      { op: "insert", path: ["tables", 1], value: {} },
      "set or remove",
    ],
    [
      "a delta-1 removal before the final element",
      "snapshot-delta-1",
      { op: "remove", path: ["tables", 0] },
      "final element",
    ],
    [
      "an insert on an object key",
      "snapshot-delta-2",
      { op: "insert", path: ["tables", 0, "name"], value: "x" },
      "array index",
    ],
    [
      "an insert past the array's length",
      "snapshot-delta-2",
      { op: "insert", path: ["tables", 4], value: {} },
      "append at length",
    ],
    [
      "a removal past the final element",
      "snapshot-delta-2",
      { op: "remove", path: ["tables", 3] },
      "append at length",
    ],
    [
      "an insert without a value",
      "snapshot-delta-2",
      { op: "insert", path: ["tables", 0] },
      "missing value",
    ],
    [
      "an unknown format",
      "snapshot-delta-3",
      { op: "remove", path: ["tables", 2] },
      "a newer VibORM may have written it",
    ],
  ])("refuses %s without touching its base", async (_label, format, change, message) => {
    const storage = new MemoryEstateStorage();
    const { root, hash } = await publishDelta(
      storage,
      base,
      schema(["alpha", "beta"]),
      [change],
      format
    );
    const artifacts = await resolveSnapshotArtifacts(storage, [root]);
    await expect(
      resolveSnapshotArtifacts(storage, [hash], artifacts)
    ).rejects.toThrow(message);
    expect(artifacts.get(root)?.snapshot).toEqual(base);
  });
});

/** Park–Miller, so a failing history replays from its seed. */
function random(seed: number) {
  let state = seed;
  return (bound: number) => {
    state = (state * 48_271) % 2_147_483_647;
    return Math.floor((state / 2_147_483_647) * bound);
  };
}

function editSchema(
  current: SchemaSnapshot,
  pick: (bound: number) => number,
  step: number
): SchemaSnapshot {
  const next = structuredClone(current);
  const tables = next.tables;
  const values = next.enums![0]!.values;
  const fresh = `t${step}_${pick(1000)}`;
  const target = tables[pick(tables.length)];
  switch (pick(9)) {
    case 0:
      tables.splice(pick(tables.length + 1), 0, table(fresh, columnsOf(fresh)));
      break;
    case 1:
      if (tables.length > 1) tables.splice(pick(tables.length), 1);
      break;
    case 2: {
      const [moved] = tables.splice(pick(tables.length), 1);
      tables.splice(pick(tables.length + 1), 0, moved!);
      break;
    }
    case 3:
      target!.columns.splice(2 + pick(target!.columns.length - 1), 0, {
        name: fresh,
        type: TYPES[pick(TYPES.length)]!,
        nullable: pick(2) === 0,
      });
      break;
    case 4:
      if (target!.columns.length > 2)
        target!.columns.splice(2 + pick(target!.columns.length - 2), 1);
      break;
    case 5: {
      const index = pick(target!.columns.length);
      const { default: _default, ...column } = target!.columns[index]!;
      target!.columns[index] = {
        ...column,
        type: TYPES[pick(TYPES.length)]!,
        ...(pick(2) === 0 ? { default: `'${fresh}'` } : {}),
      };
      break;
    }
    case 6:
      values.splice(pick(values.length + 1), 0, fresh);
      break;
    case 7:
      if (values.length > 1) values.splice(pick(values.length), 1);
      break;
    default:
      target!.columns[pick(target!.columns.length)]!.name = fresh;
  }
  return next;
}

test.each([
  1, 2, 3, 4, 5,
])("random histories rebuild exactly, warm and cold (seed %i)", async (seed) => {
  const pick = random(seed);
  const storage = new MemoryEstateStorage();
  let current = schema(NAMES.slice(0, 10));
  const root = encodeSnapshot(current);
  await storage.publishSnapshot(root.snapshotHash, root.bytes);
  let artifacts = new Map<string, ResolvedSnapshotArtifact>();
  artifacts = await resolveSnapshotArtifacts(storage, [root.snapshotHash]);
  let previous: string = root.snapshotHash;
  const history = new Map<string, SchemaSnapshot>([[previous, current]]);
  for (let step = 0; step < 60; step++) {
    const edits = 1 + pick(3);
    for (let edit = 0; edit < edits; edit++)
      current = editSchema(current, pick, step);
    const encoded = encodeSnapshotArtifact(current, artifacts, [previous]);
    // Generation is a function of the parent's artifact and the schema.
    expect(
      encodeSnapshotArtifact(current, artifacts, [previous]).artifactHash
    ).toBe(encoded.artifactHash);
    if (encoded.bytes) {
      await storage.publishSnapshot(encoded.artifactHash, encoded.bytes);
      artifacts = await resolveSnapshotArtifacts(
        storage,
        [encoded.artifactHash],
        artifacts
      );
    }
    expect(artifacts.get(encoded.artifactHash)?.snapshot).toEqual(current);
    history.set(encoded.artifactHash, current);
    previous = encoded.artifactHash;
  }
  const cold = await resolveSnapshotArtifacts(storage, [...history.keys()]);
  for (const [hash, expected] of history)
    expect(cold.get(hash)?.snapshot).toEqual(expected);
});
