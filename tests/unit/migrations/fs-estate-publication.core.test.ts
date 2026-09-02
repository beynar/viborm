import { mkdtempSync, type PathLike, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VibORMErrorCode } from "@src/errors";
import { utf8Bytes } from "@src/migrations/identity";
import type { MigrationStorageWriter } from "@src/migrations/storage/contract";
import { createFsStorageWriter } from "@src/migrations/storage/fs-estate";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

/**
 * The three publication failures a real filesystem produces and this writer
 * has to answer for: a torn temporary write, a concurrent writer that already
 * created the content-addressed name, and a mount that cannot hard-link.
 *
 * None of them can be produced by asking a healthy local filesystem nicely, so
 * this file injects them at the `node:fs` syscall boundary. The hook is off by
 * default: every call passes through to the real syscall unless a test arms
 * exactly one failure, and each armed failure fires exactly once.
 */
interface FsFailureHook {
  /** Simulates a short write: the temp file gets fewer bytes than requested. */
  tornWrite: boolean;
  /** Simulates another writer winning the race for the final name. */
  linkFailure: {
    readonly code: string;
    readonly winner: "none" | "identical" | "different";
  } | null;
  /** Simulates a temp file that vanished before best-effort cleanup. */
  vanishedTemp: boolean;
}

type FsFailureHost = typeof globalThis & {
  __vibormFsEstateFailure?: FsFailureHook;
};

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const hook = (): FsFailureHook | undefined =>
    (globalThis as FsFailureHost).__vibormFsEstateFailure;
  const errno = (code: string): NodeJS.ErrnoException => {
    const error = new Error(`simulated ${code}`) as NodeJS.ErrnoException;
    error.code = code;
    return error;
  };
  return {
    ...actual,
    default: actual,
    writeSync: ((
      fd: number,
      buffer: NodeJS.ArrayBufferView | string,
      ...rest: unknown[]
    ) => {
      const state = hook();
      if (state?.tornWrite && buffer instanceof Uint8Array) {
        state.tornWrite = false;
        return actual.writeSync(fd, buffer.subarray(0, buffer.length - 1));
      }
      return (actual.writeSync as (...args: unknown[]) => number)(
        fd,
        buffer,
        ...rest
      );
    }) as typeof actual.writeSync,
    linkSync: ((existing: PathLike, next: PathLike) => {
      const state = hook();
      const failure = state?.linkFailure;
      if (!(state && failure)) {
        actual.linkSync(existing, next);
        return;
      }
      state.linkFailure = null;
      if (failure.winner === "identical") actual.linkSync(existing, next);
      if (failure.winner === "different") {
        actual.writeFileSync(next, "bytes from another writer");
      }
      throw errno(failure.code);
    }) as typeof actual.linkSync,
    unlinkSync: ((path: PathLike) => {
      const state = hook();
      if (state?.vanishedTemp) {
        state.vanishedTemp = false;
        throw errno("ENOENT");
      }
      actual.unlinkSync(path);
    }) as typeof actual.unlinkSync,
  };
});

const PAYLOAD = utf8Bytes("estate payload");
const HASH = "a".repeat(64);

let directory = "";

function arm(failure: Partial<FsFailureHook>): void {
  (globalThis as FsFailureHost).__vibormFsEstateFailure = {
    tornWrite: false,
    linkFailure: null,
    vanishedTemp: false,
    ...failure,
  };
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "viborm-fs-publication-"));
  arm({});
});

afterEach(() => {
  (globalThis as FsFailureHost).__vibormFsEstateFailure = undefined;
  rmSync(directory, { recursive: true, force: true });
});

describe("filesystem estate publication failures", () => {
  test("a torn temporary write is corruption and publishes nothing", async () => {
    arm({ tornWrite: true });
    const storage = createFsStorageWriter(directory);

    await expect(storage.publishSql(HASH, PAYLOAD)).rejects.toMatchObject({
      code: VibORMErrorCode.MIGRATION_CORRUPTION,
      message: expect.stringContaining("round-trip"),
    });
    await expect(storage.listSql()).resolves.toEqual([]);
    await expect(storage.readSql(HASH)).resolves.toBeNull();
  });

  test("losing the no-replace race to identical bytes is idempotent", async () => {
    arm({ linkFailure: { code: "EEXIST", winner: "identical" } });
    const storage = createFsStorageWriter(directory);

    await expect(storage.publishSql(HASH, PAYLOAD)).resolves.toEqual({
      outcome: "identical",
    });
    await expect(storage.readSql(HASH)).resolves.toEqual(PAYLOAD);
    expect(readdirSync(join(directory, "sql"))).toEqual([`${HASH}.sql`]);
  });

  test("losing the no-replace race to different bytes is corruption", async () => {
    arm({ linkFailure: { code: "EEXIST", winner: "different" } });
    const storage = createFsStorageWriter(directory);

    await expect(storage.publishSql(HASH, PAYLOAD)).rejects.toMatchObject({
      code: VibORMErrorCode.MIGRATION_CORRUPTION,
      message: expect.stringContaining("already holds different bytes"),
    });
  });

  test.each([
    "EXDEV",
    "ENOSYS",
    "EPERM",
  ])("a filesystem answering %s to a no-replace hard link is refused as unusable storage", async (code) => {
    arm({ linkFailure: { code, winner: "none" } });
    const storage = createFsStorageWriter(directory);

    await expect(storage.publishSql(HASH, PAYLOAD)).rejects.toMatchObject({
      code: VibORMErrorCode.MIGRATION_STORAGE_REQUIRED,
      message: expect.stringContaining("no-replace hard link"),
    });
    await expect(storage.listSql()).resolves.toEqual([]);
  });

  test("an errno the writer does not classify is rethrown unchanged", async () => {
    arm({ linkFailure: { code: "EIO", winner: "none" } });
    const storage = createFsStorageWriter(directory);

    await expect(storage.publishSql(HASH, PAYLOAD)).rejects.toThrow(
      "simulated EIO"
    );
    await expect(storage.listSql()).resolves.toEqual([]);
  });

  test.each([
    {
      name: "state",
      publish: (storage: MigrationStorageWriter, id: string) =>
        storage.publishState(id, PAYLOAD),
    },
    {
      name: "snapshot",
      publish: (storage: MigrationStorageWriter, id: string) =>
        storage.publishSnapshot(id, PAYLOAD),
    },
    {
      name: "sql",
      publish: (storage: MigrationStorageWriter, id: string) =>
        storage.publishSql(id, PAYLOAD),
    },
  ])("a $name id that escapes the storage root is refused before any write", async ({
    publish,
  }) => {
    const storage = createFsStorageWriter(directory);

    await expect(publish(storage, "../../viborm-escape")).rejects.toMatchObject(
      {
        code: VibORMErrorCode.MIGRATION_INVALID_ESTATE,
        message: expect.stringContaining("escapes the storage root"),
      }
    );
    expect(readdirSync(directory)).toEqual([]);
  });
});

describe("coverage low value", () => {
  test("temp cleanup that fails after the final name is visible is not an error", async () => {
    arm({ vanishedTemp: true });
    const storage = createFsStorageWriter(directory);

    await expect(storage.publishSql(HASH, PAYLOAD)).resolves.toEqual({
      outcome: "created",
    });
    await expect(storage.readSql(HASH)).resolves.toEqual(PAYLOAD);
    await expect(storage.listSql()).resolves.toEqual([HASH]);
  });
});
