/**
 * In-memory estate writer for tests and conformance.
 * Conditional create: same hash + same bytes is identical; different bytes is corruption.
 */

import { MigrationError, VibORMErrorCode } from "../../errors";
import { bytesEqual } from "../canonical-json";
import { isSha256, type Sha256 } from "../identity";
import type { MigrationStorageWriter, PublishResult } from "./contract";

export class MemoryEstateStorage implements MigrationStorageWriter {
  private estate: Uint8Array | null = null;
  private readonly states = new Map<Sha256, Uint8Array>();
  private readonly snapshots = new Map<Sha256, Uint8Array>();
  private readonly sql = new Map<Sha256, Uint8Array>();

  async readEstate(): Promise<Uint8Array | null> {
    return this.estate ? this.estate.slice() : null;
  }

  async listStates(): Promise<readonly Sha256[]> {
    return [...this.states.keys()].sort();
  }

  async listSnapshots(): Promise<readonly Sha256[]> {
    return [...this.snapshots.keys()].sort();
  }

  async listSql(): Promise<readonly Sha256[]> {
    return [...this.sql.keys()].sort();
  }

  async readState(id: Sha256): Promise<Uint8Array | null> {
    const bytes = this.states.get(id);
    return bytes ? bytes.slice() : null;
  }

  async readSnapshot(hash: Sha256): Promise<Uint8Array | null> {
    const bytes = this.snapshots.get(hash);
    return bytes ? bytes.slice() : null;
  }

  async readSql(hash: Sha256): Promise<Uint8Array | null> {
    const bytes = this.sql.get(hash);
    return bytes ? bytes.slice() : null;
  }

  async publishEstate(bytes: Uint8Array): Promise<PublishResult> {
    if (this.estate && !bytesEqual(this.estate, bytes)) {
      throw new MigrationError(
        "estate.json already exists with different bytes",
        VibORMErrorCode.MIGRATION_CORRUPTION
      );
    }
    if (this.estate) return { outcome: "identical" };
    this.estate = bytes.slice();
    return { outcome: "created" };
  }

  async publishSnapshot(
    hash: Sha256,
    bytes: Uint8Array
  ): Promise<PublishResult> {
    return publishMap(this.snapshots, hash, bytes, "snapshot");
  }

  async publishSql(hash: Sha256, bytes: Uint8Array): Promise<PublishResult> {
    return publishMap(this.sql, hash, bytes, "sql");
  }

  async publishState(id: Sha256, bytes: Uint8Array): Promise<PublishResult> {
    if (!isSha256(id)) {
      throw new MigrationError(
        "State id is not a SHA-256 digest",
        VibORMErrorCode.MIGRATION_INVALID_ESTATE
      );
    }
    return publishMap(this.states, id, bytes, "state");
  }
}

function publishMap(
  store: Map<Sha256, Uint8Array>,
  key: Sha256,
  bytes: Uint8Array,
  label: string
): PublishResult {
  const existing = store.get(key);
  if (existing) {
    if (!bytesEqual(existing, bytes)) {
      throw new MigrationError(
        `${label} ${key} already holds different bytes`,
        VibORMErrorCode.MIGRATION_CORRUPTION
      );
    }
    return { outcome: "identical" };
  }
  store.set(key, bytes.slice());
  return { outcome: "created" };
}
