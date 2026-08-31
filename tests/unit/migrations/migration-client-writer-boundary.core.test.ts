import {
  createMigrationClient,
  type MigrationStorageReader,
} from "@migrations";
import { s } from "@schema";
import { describe, expect, test } from "vitest";
import { MemoryStorage, pgEstateDriver } from "./_estate";

const schema = { user: s.model({ id: s.string().id() }) };

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

describe("migration client writer capability boundary", () => {
  test("translates a writer-only inspection failure after reader admission", () => {
    const providerFailure = new Error("publish capability trap failed");
    const reader = readerFrom(new MemoryStorage());
    const storage = new Proxy(reader, {
      get(target, property, receiver) {
        if (property === "publishEstate") throw providerFailure;
        return Reflect.get(target, property, receiver);
      },
    });

    expect(() =>
      Reflect.apply(createMigrationClient, undefined, [
        { $driver: pgEstateDriver("alpha"), $schema: schema },
        { storage },
      ])
    ).toThrowError(
      expect.objectContaining({
        code: "V4002",
        message: "migration client storage could not be inspected",
        originalCause: expect.objectContaining({ name: providerFailure.name }),
      })
    );
  });
});
