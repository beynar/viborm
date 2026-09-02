import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VibORMErrorCode } from "@src/errors";
import { isSha256, type Sha256, utf8Bytes } from "@src/migrations/identity";
import { createStorageConformanceSuite } from "@src/migrations/storage/conformance";
import type { PublishResult } from "@src/migrations/storage/contract";
import { createFsStorageWriter } from "@src/migrations/storage/fs-estate";
import { MemoryEstateStorage } from "@src/migrations/storage/memory";
import { describe, expect, test } from "vitest";

function repeatedHash(character: string): Sha256 {
  const hash = character.repeat(64);
  if (!isSha256(hash)) throw new Error("invalid test digest");
  return hash;
}

const A_HASH = repeatedHash("a");
const B_HASH = repeatedHash("b");

function temporaryEstate(): {
  readonly directory: string;
  readonly dispose: () => void;
} {
  const directory = mkdtempSync(join(tmpdir(), "viborm-fs-coverage-"));
  return {
    directory,
    dispose: () => rmSync(directory, { recursive: true, force: true }),
  };
}

describe("filesystem migration storage", () => {
  test("publishes and reads every content-addressed artifact", async () => {
    const estate = temporaryEstate();
    try {
      const storage = createFsStorageWriter(estate.directory);
      const state = utf8Bytes("state");
      const snapshot = utf8Bytes("snapshot");
      const sql = utf8Bytes("sql");

      await expect(storage.readState(A_HASH)).resolves.toBeNull();
      await expect(storage.readSnapshot(A_HASH)).resolves.toBeNull();
      await storage.publishState(B_HASH, state);
      await storage.publishState(A_HASH, state);
      await storage.publishSnapshot(A_HASH, snapshot);
      await storage.publishSql(A_HASH, sql);

      await expect(storage.readState(A_HASH)).resolves.toEqual(state);
      await expect(storage.readSnapshot(A_HASH)).resolves.toEqual(snapshot);
      await expect(storage.readSql(A_HASH)).resolves.toEqual(sql);
      await expect(storage.listStates()).resolves.toEqual([A_HASH, B_HASH]);
      await expect(storage.listSnapshots()).resolves.toEqual([A_HASH]);
      await expect(storage.listSql()).resolves.toEqual([A_HASH]);
    } finally {
      estate.dispose();
    }
  });

  test("ignores temporary, hidden, malformed, and wrong-suffix state files", async () => {
    const estate = temporaryEstate();
    try {
      const states = join(estate.directory, "states");
      mkdirSync(states, { recursive: true });
      writeFileSync(join(states, `${A_HASH}.json`), "state");
      writeFileSync(join(states, `${B_HASH}.tmp`), "temporary");
      writeFileSync(join(states, ".hidden.json"), "hidden");
      writeFileSync(join(states, "not-a-hash.json"), "invalid");
      writeFileSync(join(states, `${B_HASH}.sql`), "wrong suffix");

      await expect(
        createFsStorageWriter(estate.directory).listStates()
      ).resolves.toEqual([A_HASH]);
    } finally {
      estate.dispose();
    }
  });

  test("refuses to read through an estate symlink", async () => {
    const estate = temporaryEstate();
    const outside = temporaryEstate();
    try {
      const target = join(outside.directory, "estate.json");
      writeFileSync(target, "outside");
      symlinkSync(target, join(estate.directory, "estate.json"));

      await expect(
        createFsStorageWriter(estate.directory).readEstate()
      ).rejects.toMatchObject({
        code: VibORMErrorCode.MIGRATION_INVALID_ESTATE,
      });
    } finally {
      estate.dispose();
      outside.dispose();
    }
  });

  test("refuses different estate bytes in memory", async () => {
    const storage = new MemoryEstateStorage();
    await storage.publishEstate(utf8Bytes("first"));
    await expect(
      storage.publishEstate(utf8Bytes("second"))
    ).rejects.toMatchObject({ code: VibORMErrorCode.MIGRATION_CORRUPTION });
  });
});

async function runConformanceCase(
  name: string,
  storage: MemoryEstateStorage
): Promise<void> {
  const testCase = createStorageConformanceSuite(() => storage).find(
    (candidate) => candidate.name === name
  );
  if (!testCase) throw new Error(`missing conformance case ${name}`);
  await testCase.run();
}

class AlwaysCreatedSqlStorage extends MemoryEstateStorage {
  override async publishSql(): Promise<PublishResult> {
    return { outcome: "created" };
  }
}

class NonEmptyStorage extends MemoryEstateStorage {
  override async listStates(): Promise<readonly Sha256[]> {
    return [A_HASH];
  }
}

class AlwaysCreatedEstateStorage extends MemoryEstateStorage {
  override async publishEstate(): Promise<PublishResult> {
    return { outcome: "created" };
  }
}

describe("coverage low value", () => {
  test("the conformance kit rejects non-idempotent SQL publication", async () => {
    await expect(
      runConformanceCase(
        "identical content-addressed publish is idempotent",
        new AlwaysCreatedSqlStorage()
      )
    ).rejects.toThrow("idempotent publish failed");
  });

  test("the conformance kit rejects a storage that accepts corrupt bytes", async () => {
    await expect(
      runConformanceCase(
        "same hash with different bytes is corruption",
        new AlwaysCreatedSqlStorage()
      )
    ).rejects.toThrow("corrupt publish was accepted");
  });

  test("the conformance kit rejects a non-empty fresh writer", async () => {
    await expect(
      runConformanceCase(
        "listStates returns only committed manifests",
        new NonEmptyStorage()
      )
    ).rejects.toThrow("fresh writer is not empty");
  });

  test("the conformance kit rejects non-idempotent estate publication", async () => {
    await expect(
      runConformanceCase(
        "estate publish is idempotent for identical bytes",
        new AlwaysCreatedEstateStorage()
      )
    ).rejects.toThrow("estate idempotent publish failed");
  });
});
