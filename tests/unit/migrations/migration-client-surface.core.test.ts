import {
  createMigrationClient,
  type MigrationStorageReader,
} from "@migrations";
import { s } from "@schema";
import { describe, expect, it } from "vitest";
import { MemoryStorage, pgEstateDriver, type RecordingDriver } from "./_estate";

const schema = {
  user: s.model({
    id: s.string().id(),
    email: s.string().unique(),
  }),
};

function clientFor(driver: RecordingDriver) {
  return { $driver: driver, $schema: schema };
}

function readerFrom(storage: MemoryStorage): MigrationStorageReader {
  return {
    readEstate: () => storage.readEstate(),
    listStates: () => storage.listStates(),
    listSnapshots: () => storage.listSnapshots(),
    listSql: () => storage.listSql(),
    readState: (id) => storage.readState(id),
    readSnapshot: (hash) => storage.readSnapshot(hash),
    readSql: (hash) => storage.readSql(hash),
  };
}

describe("createMigrationClient capability surface", () => {
  it("installs exactly the operations supported by its storage capability", () => {
    const client = clientFor(pgEstateDriver("alpha"));
    const storage = new MemoryStorage();
    const live = createMigrationClient(client);
    const readable = createMigrationClient(client, {
      storage: readerFrom(storage),
    });
    const writable = createMigrationClient(client, { storage });

    expect(Object.keys(live).sort()).toEqual(["log", "push"]);
    expect(Object.keys(readable).sort()).toEqual([
      "apply",
      "baseline",
      "check",
      "down",
      "graph",
      "list",
      "log",
      "push",
      "resolve",
      "show",
      "status",
      "verify",
    ]);
    expect(Object.keys(writable).sort()).toEqual([
      "apply",
      "baseline",
      "check",
      "down",
      "generate",
      "graph",
      "list",
      "log",
      "push",
      "reset",
      "resolve",
      "show",
      "status",
      "verify",
    ]);
    expect(Object.isFrozen(live)).toBe(true);
    expect(Object.isFrozen(readable)).toBe(true);
    expect(Object.isFrozen(writable)).toBe(true);
  });

  it("reads options once and translates hostile inspection failures", () => {
    const client = clientFor(pgEstateDriver("alpha"));
    const getterFailure = new Error("storage getter failed");
    let reads = 0;
    const getterOptions = Object.defineProperty({}, "storage", {
      enumerable: true,
      get() {
        reads += 1;
        throw getterFailure;
      },
    });

    expect(() =>
      Reflect.apply(createMigrationClient, undefined, [client, getterOptions])
    ).toThrowError(
      expect.objectContaining({
        code: "V4002",
        originalCause: expect.objectContaining({ name: getterFailure.name }),
      })
    );
    expect(reads).toBe(1);

    const methodFailure = new Error("storage method trap failed");
    const hostileStorage = new Proxy(
      {},
      {
        get() {
          throw methodFailure;
        },
      }
    );
    expect(() =>
      Reflect.apply(createMigrationClient, undefined, [
        client,
        { storage: hostileStorage },
      ])
    ).toThrowError(
      expect.objectContaining({
        code: "V4002",
        originalCause: expect.objectContaining({ name: methodFailure.name }),
      })
    );
  });

  it("refuses a supplied options object without a storage capability", () => {
    expect(() =>
      Reflect.apply(createMigrationClient, undefined, [
        clientFor(pgEstateDriver("alpha")),
        {},
      ])
    ).toThrowError(
      expect.objectContaining({
        code: "V4002",
        message: "migration client options must include storage when supplied",
      })
    );
  });
});
