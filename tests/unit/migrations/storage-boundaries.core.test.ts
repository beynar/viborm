import { VibORMErrorCode } from "@src/errors";
import { isSha256, type Sha256, utf8Bytes } from "@src/migrations/identity";
import {
  isMigrationStorageReader,
  isMigrationStorageWriter,
  type MigrationStorageReader,
  type MigrationStorageWriter,
} from "@src/migrations/storage/contract";
import { MemoryEstateStorage } from "@src/migrations/storage/memory";
import {
  MemoryConditionalObjectStore,
  type ObjectStoreConditionalPut,
  ObjectStoreEstateStorage,
} from "@src/migrations/storage/object-store";
import { describe, expect, test } from "vitest";

function repeatedHash(character: string): Sha256 {
  const hash = character.repeat(64);
  if (!isSha256(hash)) throw new Error("the test digest is invalid");
  return hash;
}

const A_HASH = repeatedHash("a");
const B_HASH = repeatedHash("b");

const storageFactories = [
  {
    name: "memory",
    create: (): MigrationStorageWriter => new MemoryEstateStorage(),
  },
  {
    name: "conditional object store",
    create: (): MigrationStorageWriter =>
      new ObjectStoreEstateStorage(new MemoryConditionalObjectStore()),
  },
];

describe("migration storage boundaries", () => {
  test.each(
    storageFactories
  )("$name publishes, lists, and reads each semantic artifact", async ({
    create,
  }) => {
    const storage = create();
    const estate = utf8Bytes("estate");
    const stateA = utf8Bytes("state-a");
    const stateB = utf8Bytes("state-b");
    const snapshot = utf8Bytes("snapshot");
    const sql = utf8Bytes("sql");

    expect(await storage.readEstate()).toBeNull();
    expect(await storage.readState(A_HASH)).toBeNull();
    expect(await storage.readSnapshot(A_HASH)).toBeNull();
    expect(await storage.readSql(A_HASH)).toBeNull();
    expect(await storage.listStates()).toEqual([]);
    expect(await storage.listSnapshots()).toEqual([]);
    expect(await storage.listSql()).toEqual([]);

    await storage.publishEstate(estate);
    await storage.publishState(B_HASH, stateB);
    await storage.publishState(A_HASH, stateA);
    await storage.publishSnapshot(A_HASH, snapshot);
    await storage.publishSql(A_HASH, sql);

    expect(await storage.readEstate()).toEqual(estate);
    expect(await storage.readState(A_HASH)).toEqual(stateA);
    expect(await storage.readState(B_HASH)).toEqual(stateB);
    expect(await storage.readSnapshot(A_HASH)).toEqual(snapshot);
    expect(await storage.readSql(A_HASH)).toEqual(sql);
    expect(await storage.listStates()).toEqual([A_HASH, B_HASH]);
    expect(await storage.listSnapshots()).toEqual([A_HASH]);
    expect(await storage.listSql()).toEqual([A_HASH]);
  });

  test("object-store listing admits only matching content-addressed keys", async () => {
    const backing = new MemoryConditionalObjectStore();
    const storage = new ObjectStoreEstateStorage(backing);
    const bytes = utf8Bytes("x");
    await backing.putIfAbsent(`states/${B_HASH}.json`, bytes);
    await backing.putIfAbsent(`states/${A_HASH}.json`, bytes);
    await backing.putIfAbsent(`states/${A_HASH}.sql`, bytes);
    await backing.putIfAbsent("states/not-a-digest.json", bytes);
    await backing.putIfAbsent(`other/${A_HASH}.json`, bytes);

    expect(await storage.listStates()).toEqual([A_HASH, B_HASH]);
  });

  test.each([
    null,
    0,
    {},
    { readEstate: null },
    { readEstate: () => null },
  ])("refuses an incomplete storage reader", (candidate) => {
    expect(isMigrationStorageReader(candidate)).toBe(false);
  });

  test("recognizes reader and writer capability surfaces", () => {
    const writer = new MemoryEstateStorage();
    expect(isMigrationStorageReader(writer)).toBe(true);
    expect(isMigrationStorageWriter(writer)).toBe(true);

    const reader: MigrationStorageReader = {
      readEstate: async () => null,
      listStates: async () => [],
      listSnapshots: async () => [],
      listSql: async () => [],
      readState: async () => null,
      readSnapshot: async () => null,
      readSql: async () => null,
    };
    expect(isMigrationStorageReader(reader)).toBe(true);
    expect(isMigrationStorageWriter(reader)).toBe(false);

    const callableReader = Object.assign(() => undefined, reader);
    expect(isMigrationStorageReader(callableReader)).toBe(true);
    expect(isMigrationStorageWriter(callableReader)).toBe(false);
  });
});

describe("coverage low value", () => {
  test.each(
    storageFactories
  )("$name refuses a runtime state id that bypassed the Sha256 type", async ({
    create,
  }) => {
    const storage = create();
    await expect(
      // publishState accepts a plain string at the type level; the branded
      // digest is enforced at runtime, which is what this pins.
      storage.publishState("not-a-digest", utf8Bytes("state"))
    ).rejects.toMatchObject({
      code: VibORMErrorCode.MIGRATION_INVALID_ESTATE,
    });
  });

  test("an object-store exists response without readable bytes is corruption", async () => {
    const backing: ObjectStoreConditionalPut = {
      putIfAbsent: async () => "exists",
      get: async () => null,
      list: async () => [],
    };
    const storage = new ObjectStoreEstateStorage(backing);

    await expect(
      storage.publishEstate(utf8Bytes("estate"))
    ).rejects.toMatchObject({ code: VibORMErrorCode.MIGRATION_CORRUPTION });
  });
});
