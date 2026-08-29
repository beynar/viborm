/**
 * Filesystem estate writer.
 *
 * Publication is write-temp → fsync → rehash → hard-link no-replace →
 * verify EEXIST bytes → unlink temp → fsync directory. Check-then-rename
 * is forbidden.
 */

import {
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { MigrationError, VibORMErrorCode } from "../../errors";
import { isSha256, type Sha256, sha256Hex } from "../identity";
import type { MigrationStorageWriter, PublishResult } from "./contract";

const ESTATE_NAME = "estate.json";

export class FsEstateStorage implements MigrationStorageWriter {
  readonly baseDir: string;

  constructor(baseDir: string) {
    this.baseDir = resolve(baseDir);
  }

  async readEstate(): Promise<Uint8Array | null> {
    return readOptional(join(this.baseDir, ESTATE_NAME));
  }

  async listStates(): Promise<readonly Sha256[]> {
    return listHexFiles(join(this.baseDir, "states"), ".json");
  }

  async listSnapshots(): Promise<readonly Sha256[]> {
    return listHexFiles(join(this.baseDir, "snapshots"), ".json");
  }

  async listSql(): Promise<readonly Sha256[]> {
    return listHexFiles(join(this.baseDir, "sql"), ".sql");
  }

  async readState(id: Sha256): Promise<Uint8Array | null> {
    return readOptional(join(this.baseDir, "states", `${id}.json`));
  }

  async readSnapshot(hash: Sha256): Promise<Uint8Array | null> {
    return readOptional(join(this.baseDir, "snapshots", `${hash}.json`));
  }

  async readSql(hash: Sha256): Promise<Uint8Array | null> {
    return readOptional(join(this.baseDir, "sql", `${hash}.sql`));
  }

  async publishEstate(bytes: Uint8Array): Promise<PublishResult> {
    return publishNoReplace(
      this.baseDir,
      join(this.baseDir, ESTATE_NAME),
      bytes
    );
  }

  async publishSnapshot(
    hash: Sha256,
    bytes: Uint8Array
  ): Promise<PublishResult> {
    return publishNoReplace(
      this.baseDir,
      join(this.baseDir, "snapshots", `${hash}.json`),
      bytes
    );
  }

  async publishSql(hash: Sha256, bytes: Uint8Array): Promise<PublishResult> {
    return publishNoReplace(
      this.baseDir,
      join(this.baseDir, "sql", `${hash}.sql`),
      bytes
    );
  }

  async publishState(id: Sha256, bytes: Uint8Array): Promise<PublishResult> {
    return publishNoReplace(
      this.baseDir,
      join(this.baseDir, "states", `${id}.json`),
      bytes
    );
  }
}

export function createFsStorageWriter(baseDir: string): FsEstateStorage {
  return new FsEstateStorage(baseDir);
}

function readOptional(path: string): Uint8Array | null {
  if (!existsSync(path)) return null;
  refuseSymlink(path);
  return new Uint8Array(readFileSync(path));
}

function listHexFiles(directory: string, suffix: string): Sha256[] {
  if (!existsSync(directory)) return [];
  refuseSymlink(directory);
  const names = readdirSync(directory);
  const hashes: Sha256[] = [];
  for (const name of names) {
    if (name.startsWith(".") || name.endsWith(".tmp")) continue;
    if (!name.endsWith(suffix)) continue;
    const hex = name.slice(0, -suffix.length);
    if (!isSha256(hex)) continue;
    hashes.push(hex);
  }
  return hashes.sort();
}

function publishNoReplace(
  baseDir: string,
  finalPath: string,
  bytes: Uint8Array
): PublishResult {
  assertInsideBase(baseDir, finalPath);
  const directory = dirname(finalPath);
  mkdirSync(directory, { recursive: true });
  refuseSymlink(directory);
  if (existsSync(finalPath)) {
    refuseSymlink(finalPath);
    return compareExisting(finalPath, bytes);
  }

  const tempPath = join(directory, `.${randomSuffix()}.tmp`);
  const fd = openSync(
    tempPath,
    // biome-ignore lint/suspicious/noBitwiseOperators: POSIX open flags are one mask
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
    0o644
  );
  try {
    writeSync(fd, bytes);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }

  const reread = readFileSync(tempPath);
  if (sha256Hex(reread) !== sha256Hex(bytes)) {
    unlinkSync(tempPath);
    throw new MigrationError(
      "Temporary estate write did not round-trip",
      VibORMErrorCode.MIGRATION_CORRUPTION
    );
  }

  try {
    linkSync(tempPath, finalPath);
  } catch (error) {
    unlinkQuiet(tempPath);
    if (isErrno(error, "EEXIST")) {
      return compareExisting(finalPath, bytes);
    }
    if (
      isErrno(error, "EXDEV") ||
      isErrno(error, "ENOSYS") ||
      isErrno(error, "EPERM")
    ) {
      throw new MigrationError(
        "Filesystem cannot atomically publish with a no-replace hard link",
        VibORMErrorCode.MIGRATION_STORAGE_REQUIRED,
        { cause: error instanceof Error ? error : undefined }
      );
    }
    throw error;
  }

  unlinkQuiet(tempPath);
  fsyncDirectory(directory);
  return { outcome: "created" };
}

function compareExisting(path: string, bytes: Uint8Array): PublishResult {
  const existing = readFileSync(path);
  if (sha256Hex(existing) !== sha256Hex(bytes)) {
    throw new MigrationError(
      `Content-addressed path ${path} already holds different bytes`,
      VibORMErrorCode.MIGRATION_CORRUPTION
    );
  }
  fsyncDirectory(dirname(path));
  return { outcome: "identical" };
}

function refuseSymlink(path: string): void {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) {
    throw new MigrationError(
      "Estate storage refuses to follow symlinks",
      VibORMErrorCode.MIGRATION_INVALID_ESTATE
    );
  }
}

function fsyncDirectory(directory: string): void {
  const fd = openSync(
    directory,
    // biome-ignore lint/suspicious/noBitwiseOperators: POSIX open flags are one mask
    constants.O_RDONLY | constants.O_DIRECTORY
  );
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function unlinkQuiet(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // temp cleanup is best-effort after the final name is visible
  }
}

function isErrno(error: unknown, code: string): boolean {
  return Boolean(
    error && typeof error === "object" && "code" in error && error.code === code
  );
}

function randomSuffix(): string {
  return `${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}`;
}

function assertInsideBase(baseDir: string, path: string): void {
  const resolved = resolve(path);
  const root = baseDir.endsWith("/") ? baseDir : `${baseDir}/`;
  if (resolved !== resolve(baseDir) && !resolved.startsWith(root)) {
    throw new MigrationError(
      "Estate path escapes the storage root",
      VibORMErrorCode.MIGRATION_INVALID_ESTATE
    );
  }
}
