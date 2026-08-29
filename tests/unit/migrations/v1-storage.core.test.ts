import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VibORMErrorCode } from "@src/errors";
import { utf8Bytes } from "@src/migrations/identity";
import { createStorageConformanceSuite } from "@src/migrations/storage/conformance";
import { createFsStorageWriter } from "@src/migrations/storage/fs-estate";
import { MemoryEstateStorage } from "@src/migrations/storage/memory";
import { encodeSqlBlob } from "@src/migrations/v1-parse";
import { describe, expect, test } from "vitest";

describe("migration v1 storage", () => {
  test("memory writer passes the conformance kit", async () => {
    for (const testCase of createStorageConformanceSuite(
      () => new MemoryEstateStorage()
    )) {
      await testCase.run();
    }
  });

  test("filesystem writer publishes with no-replace semantics", async () => {
    const directory = mkdtempSync(join(tmpdir(), "viborm-estate-"));
    try {
      const storage = createFsStorageWriter(directory);
      for (const testCase of createStorageConformanceSuite(() => storage)) {
        await testCase.run();
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("published and read memory bytes are detached from the caller", async () => {
    const memory = new MemoryEstateStorage();
    const bytes = utf8Bytes("alpha");
    const hash = encodeSqlBlob(bytes);
    await memory.publishSql(hash, bytes);
    bytes[0] = 0;
    const first = await memory.readSql(hash);
    expect(first).not.toBeNull();
    expect(encodeSqlBlob(first!)).toBe(hash);
    first![0] = 0;
    const second = await memory.readSql(hash);
    expect(second).not.toBeNull();
    expect(encodeSqlBlob(second!)).toBe(hash);
  });

  test("different bytes at one hash are corruption on both writers", async () => {
    const memory = new MemoryEstateStorage();
    const bytes = utf8Bytes("alpha");
    const hash = encodeSqlBlob(bytes);
    await memory.publishSql(hash, bytes);
    await expect(
      memory.publishSql(hash, utf8Bytes("beta"))
    ).rejects.toMatchObject({
      code: VibORMErrorCode.MIGRATION_CORRUPTION,
    });
  });
});
