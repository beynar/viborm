import { createClient } from "@client/client";
import { s } from "@schema";
import { VibORMErrorCode } from "@src/errors";
import { checkEstate } from "@src/migrations/check";
import { type GenerateV1Result, generateV1 } from "@src/migrations/generate-v1";
import { loadMigrationGraph } from "@src/migrations/graph";
import { isSha256 } from "@src/migrations/identity";
import { MemoryEstateStorage } from "@src/migrations/storage/memory";
import { createInMemorySQLite3Driver } from "@tests/fixtures/drivers/sqlite3";
import { describe, expect, expectTypeOf, test } from "vitest";

const user = s.model({
  id: s.string().id(),
  email: s.string().unique(),
});

function clientWith(schema: Record<string, typeof user>) {
  return createClient({
    schema,
    driver: createInMemorySQLite3Driver(),
  });
}

describe("migration v1 generate", () => {
  test("dry-run on a missing estate publishes nothing", async () => {
    const storage = new MemoryEstateStorage();
    const client = clientWith({ user });
    const preview = await generateV1(client, storage, {
      dryRun: true,
      name: "init",
    });
    expect(preview.outcome).toBe("preview");
    expect(await storage.readEstate()).toBeNull();
    expect(await storage.listStates()).toEqual([]);
    await client.$disconnect();
  });

  test("identical inputs publish the same state id", async () => {
    const left = new MemoryEstateStorage();
    const right = new MemoryEstateStorage();
    const client = clientWith({ user });
    const first = await generateV1(client, left, { name: "init" });
    const second = await generateV1(client, right, { name: "init" });
    expect(first.outcome).toBe("published");
    expect(first.stateId).toBe(second.stateId);
    expect(first.snapshotHash).toBe(second.snapshotHash);
    expect(isSha256(first.stateId)).toBe(true);
    expectTypeOf(first).toMatchTypeOf<GenerateV1Result>();
    await client.$disconnect();
  });

  test("a second virtual-root transition is refused after any published state", async () => {
    const storage = new MemoryEstateStorage();
    const client = clientWith({ user });
    await generateV1(client, storage, { name: "init" });
    await expect(
      generateV1(client, storage, { from: null, name: "second-root" })
    ).rejects.toMatchObject({
      code: VibORMErrorCode.MIGRATION_INVALID_ESTATE,
      message: expect.stringContaining("virtual-root"),
    });
    expect(await storage.listStates()).toHaveLength(1);
    await client.$disconnect();
  });

  test("dry-run after a schema change previews a child and publishes nothing", async () => {
    const storage = new MemoryEstateStorage();
    const client = clientWith({ user });
    const published = await generateV1(client, storage, { name: "init" });
    const states = await storage.listStates();
    const snapshots = await storage.listSnapshots();
    const sql = await storage.listSql();
    const nextUser = s.model({
      id: s.string().id(),
      email: s.string().unique(),
      name: s.string(),
    });
    const next = createClient({
      schema: { user: nextUser },
      driver: createInMemorySQLite3Driver(),
    });
    const preview = await generateV1(next, storage, {
      dryRun: true,
      name: "add-name",
    });
    expect(preview.outcome).toBe("preview");
    expect(preview.stateId).not.toBe(published.stateId);
    expect(await storage.listStates()).toEqual(states);
    expect(await storage.listSnapshots()).toEqual(snapshots);
    expect(await storage.listSql()).toEqual(sql);
    await next.$disconnect();
    await client.$disconnect();
  });

  test("a changed name produces a distinct child state", async () => {
    const storage = new MemoryEstateStorage();
    const client = clientWith({ user });
    const first = await generateV1(client, storage, { name: "init" });
    const renamed = await generateV1(client, new MemoryEstateStorage(), {
      name: "other",
    });
    expect(first.stateId).not.toBe(renamed.stateId);
    await client.$disconnect();
  });

  test("noop when the unique leaf already matches the schema", async () => {
    const storage = new MemoryEstateStorage();
    const client = clientWith({ user });
    await generateV1(client, storage, { name: "init" });
    const again = await generateV1(client, storage, { name: "again" });
    expect(again.outcome).toBe("noop");
    expect(await storage.listStates()).toHaveLength(1);
    await client.$disconnect();
  });

  test("check reports a valid published estate", async () => {
    const storage = new MemoryEstateStorage();
    const client = clientWith({ user });
    await generateV1(client, storage, { name: "init" });
    const checked = await checkEstate(storage);
    expect(checked.ok).toBe(true);
    const graph = await loadMigrationGraph(storage);
    expect(graph.leaves).toHaveLength(1);
    await client.$disconnect();
  });
});
