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

export function isMigrationStorageWriter(
  value: MigrationStorageReader
): value is MigrationStorageWriter {
  return (
    "publishEstate" in value &&
    "publishSnapshot" in value &&
    "publishSql" in value &&
    "publishState" in value
  );
}
