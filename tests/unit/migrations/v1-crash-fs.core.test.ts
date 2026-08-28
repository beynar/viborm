import {
  existsSync,
  type Mode,
  mkdtempSync,
  type OpenMode,
  type PathLike,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VibORMErrorCode } from "@src/errors";
import { emptyManagedSnapshot } from "@src/migrations/empty-snapshot";
import { utf8Bytes } from "@src/migrations/identity";
import { createFsStorageWriter } from "@src/migrations/storage/fs-estate";
import {
  encodeEstateDescriptor,
  encodeSnapshot,
  encodeSqlBlob,
} from "@src/migrations/v1-parse";
import { afterEach, describe, expect, test, vi } from "vitest";

const CRASH_AFTER = /crash after/;

type CrashKind = "write" | "flush" | "link" | "dirsync";

interface CrashHook {
  kind: CrashKind | null;
  nth: number;
  writes: number;
  flushes: number;
  links: number;
  dirsyncs: number;
  directoryFds: Set<number>;
}

const crashHook: CrashHook = {
  kind: null,
  nth: 1,
  writes: 0,
  flushes: 0,
  links: 0,
  dirsyncs: 0,
  directoryFds: new Set(),
};

type CrashHost = typeof globalThis & { __vibormEstateCrash?: CrashHook };

function crashHost(): CrashHost {
  return globalThis as CrashHost;
}

function installCrashAfter(kind: CrashKind, nth = 1): void {
  crashHook.kind = kind;
  crashHook.nth = nth;
  crashHook.writes = 0;
  crashHook.flushes = 0;
  crashHook.links = 0;
  crashHook.dirsyncs = 0;
  crashHook.directoryFds = new Set();
  crashHost().__vibormEstateCrash = crashHook;
}

function clearCrash(): void {
  crashHook.kind = null;
  crashHook.nth = 1;
  crashHook.writes = 0;
  crashHook.flushes = 0;
  crashHook.links = 0;
  crashHook.dirsyncs = 0;
  crashHook.directoryFds.clear();
  crashHost().__vibormEstateCrash = crashHook;
}

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const hook = (): CrashHook | undefined =>
    (globalThis as CrashHost).__vibormEstateCrash;
  return {
    ...actual,
    default: actual,
    openSync: ((path: PathLike, flags?: OpenMode, mode?: Mode) => {
      const fd = actual.openSync(path, flags as never, mode);
      const state = hook();
      if (
        state &&
        typeof flags === "number" &&
        // biome-ignore lint/suspicious/noBitwiseOperators: the hook inspects POSIX open flags
        flags & actual.constants.O_DIRECTORY
      ) {
        state.directoryFds.add(fd);
      }
      return fd;
    }) as typeof actual.openSync,
    writeSync: ((
      fd: number,
      buffer: NodeJS.ArrayBufferView | string,
      ...rest: unknown[]
    ) => {
      const written = (actual.writeSync as (...args: unknown[]) => number)(
        fd,
        buffer,
        ...rest
      );
      const state = hook();
      if (state) {
        state.writes += 1;
        if (state.kind === "write" && state.writes === state.nth) {
          throw new Error(`crash after write #${state.nth}`);
        }
      }
      return written;
    }) as typeof actual.writeSync,
    fsyncSync: ((fd: number) => {
      actual.fsyncSync(fd);
      const state = hook();
      if (!state) return;
      if (state.directoryFds.has(fd)) {
        state.dirsyncs += 1;
        if (state.kind === "dirsync" && state.dirsyncs === state.nth) {
          throw new Error(`crash after dirsync #${state.nth}`);
        }
        return;
      }
      state.flushes += 1;
      if (state.kind === "flush" && state.flushes === state.nth) {
        throw new Error(`crash after flush #${state.nth}`);
      }
    }) as typeof actual.fsyncSync,
    linkSync: ((existing: PathLike, next: PathLike) => {
      actual.linkSync(existing, next);
      const state = hook();
      if (state) {
        state.links += 1;
        if (state.kind === "link" && state.links === state.nth) {
          throw new Error(`crash after link #${state.nth}`);
        }
      }
    }) as typeof actual.linkSync,
  };
});

afterEach(() => {
  clearCrash();
});

function leftoverTemps(directory: string): string[] {
  const found: string[] = [];
  const walk = (current: string): void => {
    if (!existsSync(current)) return;
    for (const name of readdirSync(current)) {
      const path = join(current, name);
      if (name.endsWith(".tmp") || name.startsWith(".")) found.push(path);
      try {
        if (statSync(path).isDirectory()) walk(path);
      } catch {
        // the crash may leave a path the walker cannot stat
      }
    }
  };
  walk(directory);
  return found;
}

describe("migration v1 filesystem crash publication", () => {
  test("interrupted temp files never become listed states", async () => {
    const directory = mkdtempSync(join(tmpdir(), "viborm-estate-crash-"));
    try {
      const storage = createFsStorageWriter(directory);
      const bytes = utf8Bytes("hello");
      const hash = encodeSqlBlob(bytes);
      await storage.publishSql(hash, bytes);
      writeFileSync(join(directory, "sql", ".torn.tmp"), "partial");
      expect(await storage.listSql()).toEqual([hash]);
      expect(await storage.readSql(hash)).toEqual(bytes);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("a crashed second writer cannot replace committed bytes", async () => {
    const directory = mkdtempSync(join(tmpdir(), "viborm-estate-cas-"));
    try {
      const first = createFsStorageWriter(directory);
      const bytes = utf8Bytes("committed");
      const hash = encodeSqlBlob(bytes);
      await first.publishSql(hash, bytes);
      const second = createFsStorageWriter(directory);
      await expect(
        second.publishSql(hash, utf8Bytes("attacker"))
      ).rejects.toMatchObject({
        code: VibORMErrorCode.MIGRATION_CORRUPTION,
      });
      expect(await first.readSql(hash)).toEqual(bytes);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test.each([
    "write",
    "flush",
    "link",
    "dirsync",
  ] as const)("crash after %s never lists a torn SQL blob", async (kind) => {
    const directory = mkdtempSync(join(tmpdir(), `viborm-estate-${kind}-`));
    try {
      installCrashAfter(kind);
      const storage = createFsStorageWriter(directory);
      const bytes = utf8Bytes(`payload-${kind}`);
      const hash = encodeSqlBlob(bytes);
      await expect(storage.publishSql(hash, bytes)).rejects.toThrow(
        CRASH_AFTER
      );
      clearCrash();
      const listed = await storage.listSql();
      if (kind === "write" || kind === "flush") {
        expect(listed).toEqual([]);
        expect(await storage.readSql(hash)).toBeNull();
      } else {
        expect(listed).toEqual([hash]);
        expect(await storage.readSql(hash)).toEqual(bytes);
      }
      for (const temp of leftoverTemps(directory)) {
        expect(temp.endsWith(".tmp") || temp.includes("/.")).toBe(true);
      }
      expect(listed.every((item) => !item.includes("tmp"))).toBe(true);
    } finally {
      clearCrash();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("crash after every publication step leaves estate, snapshot, and state listings authentic", async () => {
    const directory = mkdtempSync(join(tmpdir(), "viborm-estate-steps-"));
    try {
      const estate = encodeEstateDescriptor({ dialect: "sqlite" });
      const snapshot = encodeSnapshot(emptyManagedSnapshot());
      const sqlBytes = utf8Bytes("SELECT 1");
      const sqlHash = encodeSqlBlob(sqlBytes);
      const kinds: CrashKind[] = ["write", "flush", "link", "dirsync"];
      for (const kind of kinds) {
        installCrashAfter(kind);
        const storage = createFsStorageWriter(directory);
        await expect(storage.publishEstate(estate.bytes)).rejects.toThrow(
          CRASH_AFTER
        );
        clearCrash();
        const reader = createFsStorageWriter(directory);
        const listedEstate = await reader.readEstate();
        if (listedEstate) {
          expect(listedEstate).toEqual(estate.bytes);
        }
      }
      const storage = createFsStorageWriter(directory);
      await storage.publishEstate(estate.bytes);
      await storage.publishSnapshot(snapshot.snapshotHash, snapshot.bytes);
      await storage.publishSql(sqlHash, sqlBytes);
      expect(await storage.listSnapshots()).toEqual([snapshot.snapshotHash]);
      expect(await storage.listSql()).toEqual([sqlHash]);
    } finally {
      clearCrash();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
