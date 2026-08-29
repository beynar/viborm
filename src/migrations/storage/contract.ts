/**
 * Semantic migration storage. Path-level get/put/delete is gone.
 *
 * Readers return raw bytes. Parsers, not drivers, turn those bytes into
 * trusted domain values. Writers promise strongly consistent listing and
 * conditional create.
 */

import type { Sha256 } from "../identity";

export interface PublishResult {
  readonly outcome: "created" | "identical";
}

export interface MigrationStorageReader {
  readEstate(): Promise<Uint8Array | null>;
  listStates(): Promise<readonly Sha256[]>;
  listSnapshots(): Promise<readonly Sha256[]>;
  listSql(): Promise<readonly Sha256[]>;
  readState(id: Sha256): Promise<Uint8Array | null>;
  readSnapshot(hash: Sha256): Promise<Uint8Array | null>;
  readSql(hash: Sha256): Promise<Uint8Array | null>;
}

export interface MigrationStorageWriter extends MigrationStorageReader {
  publishEstate(bytes: Uint8Array): Promise<PublishResult>;
  publishSnapshot(hash: Sha256, bytes: Uint8Array): Promise<PublishResult>;
  publishSql(hash: Sha256, bytes: Uint8Array): Promise<PublishResult>;
  publishState(id: Sha256, bytes: Uint8Array): Promise<PublishResult>;
}

const READER_METHODS = [
  "readEstate",
  "listStates",
  "listSnapshots",
  "listSql",
  "readState",
  "readSnapshot",
  "readSql",
] as const;

const WRITER_METHODS = [
  "publishEstate",
  "publishSnapshot",
  "publishSql",
  "publishState",
] as const;

export function isMigrationStorageReader(
  value: unknown
): value is MigrationStorageReader {
  return hasStorageMethods(value, READER_METHODS);
}

export function isMigrationStorageWriter(
  value: MigrationStorageReader
): value is MigrationStorageWriter {
  return hasStorageMethods(value, WRITER_METHODS);
}

function hasStorageMethods(
  value: unknown,
  methods: readonly string[]
): boolean {
  if (
    value === null ||
    (typeof value !== "object" && typeof value !== "function")
  ) {
    return false;
  }
  return methods.every(
    (method) => typeof Reflect.get(value, method) === "function"
  );
}
