import { VibORMErrorCode } from "@src/errors";
import { utf8Bytes } from "@src/migrations/identity";
import { createStorageConformanceSuite } from "@src/migrations/storage/conformance";
import {
  MemoryConditionalObjectStore,
  ObjectStoreEstateStorage,
  refuseWorkersKvWritable,
} from "@src/migrations/storage/object-store";
import { encodeSqlBlob } from "@src/migrations/v1-parse";
import { describe, expect, test } from "vitest";

describe("migration v1 object-store publication", () => {
  test("conditional object store passes the conformance kit", async () => {
    for (const testCase of createStorageConformanceSuite(
      () => new ObjectStoreEstateStorage(new MemoryConditionalObjectStore())
    )) {
      await testCase.run();
    }
  });

  test("published and read object-store bytes are detached from the caller", async () => {
    const backing = new MemoryConditionalObjectStore();
    const storage = new ObjectStoreEstateStorage(backing);
    const bytes = utf8Bytes("alpha");
    const hash = encodeSqlBlob(bytes);
    await storage.publishSql(hash, bytes);
    bytes[0] = 0;
    const first = await storage.readSql(hash);
    expect(first).not.toBeNull();
    expect(encodeSqlBlob(first!)).toBe(hash);
    first![0] = 0;
    const second = await storage.readSql(hash);
    expect(second).not.toBeNull();
    expect(encodeSqlBlob(second!)).toBe(hash);
  });

  test("same hash with different bytes is a CAS conflict", async () => {
    const storage = new ObjectStoreEstateStorage(
      new MemoryConditionalObjectStore()
    );
    const bytes = utf8Bytes("alpha");
    const hash = encodeSqlBlob(bytes);
    await storage.publishSql(hash, bytes);
    await expect(
      storage.publishSql(hash, utf8Bytes("beta"))
    ).rejects.toMatchObject({
      code: VibORMErrorCode.MIGRATION_CORRUPTION,
    });
  });

  test("Workers KV writable drivers are refused", () => {
    expect(() => refuseWorkersKvWritable()).toThrow();
    try {
      refuseWorkersKvWritable();
    } catch (error) {
      expect(error).toMatchObject({
        code: VibORMErrorCode.MIGRATION_UNSUPPORTED_PROVIDER,
      });
    }
  });
});
