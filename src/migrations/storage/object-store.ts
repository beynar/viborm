/**
 * Strong object-store publication contract.
 * A writable driver that cannot do conditional create is not a V1 estate owner.
 * Workers KV is refused here: it has no compare-and-swap publication.
 */

import { MigrationError, VibORMErrorCode } from "../../errors";
import { bytesEqual } from "../canonical-json";
import { isSha256, type Sha256 } from "../identity";
import type { MigrationStorageWriter, PublishResult } from "./contract";

export function refuseWorkersKvWritable(): never {
  throw new MigrationError(
    "Workers KV cannot be a V1 estate writer: listing is eventually consistent and puts are not conditional",
    VibORMErrorCode.MIGRATION_UNSUPPORTED_PROVIDER
  );
}

export interface ObjectStoreConditionalPut {
  putIfAbsent(key: string, bytes: Uint8Array): Promise<"created" | "exists">;
  get(key: string): Promise<Uint8Array | null>;
  list(prefix: string): Promise<readonly string[]>;
}

/**
 * Estate writer over a strongly consistent object store with if-none-match
 * publication. Manifests become visible only after referenced bytes exist.
 */
export class ObjectStoreEstateStorage implements MigrationStorageWriter {
  private readonly store: ObjectStoreConditionalPut;

  constructor(store: ObjectStoreConditionalPut) {
    this.store = store;
  }

  async readEstate(): Promise<Uint8Array | null> {
    return this.store.get("estate.json");
  }

  async listStates(): Promise<readonly Sha256[]> {
    return this.listHex("states/", ".json");
  }

  async listSnapshots(): Promise<readonly Sha256[]> {
    return this.listHex("snapshots/", ".json");
  }

  async listSql(): Promise<readonly Sha256[]> {
    return this.listHex("sql/", ".sql");
  }

  async readState(id: Sha256): Promise<Uint8Array | null> {
    return this.store.get(`states/${id}.json`);
  }

  async readSnapshot(hash: Sha256): Promise<Uint8Array | null> {
    return this.store.get(`snapshots/${hash}.json`);
  }

  async readSql(hash: Sha256): Promise<Uint8Array | null> {
    return this.store.get(`sql/${hash}.sql`);
  }

  async publishEstate(bytes: Uint8Array): Promise<PublishResult> {
    return this.publish("estate.json", bytes);
  }

  async publishSnapshot(
    hash: Sha256,
    bytes: Uint8Array
  ): Promise<PublishResult> {
    return this.publish(`snapshots/${hash}.json`, bytes);
  }

  async publishSql(hash: Sha256, bytes: Uint8Array): Promise<PublishResult> {
    return this.publish(`sql/${hash}.sql`, bytes);
  }

  async publishState(id: Sha256, bytes: Uint8Array): Promise<PublishResult> {
    if (!isSha256(id)) {
      throw new MigrationError(
        "State id is not a SHA-256 digest",
        VibORMErrorCode.MIGRATION_INVALID_ESTATE
      );
    }
    return this.publish(`states/${id}.json`, bytes);
  }

  private async publish(
    key: string,
    bytes: Uint8Array
  ): Promise<PublishResult> {
    const result = await this.store.putIfAbsent(key, bytes);
    if (result === "created") return { outcome: "created" };
    const existing = await this.store.get(key);
    if (!(existing && bytesEqual(existing, bytes))) {
      throw new MigrationError(
        `Object-store key ${key} already holds different bytes`,
        VibORMErrorCode.MIGRATION_CORRUPTION
      );
    }
    return { outcome: "identical" };
  }

  private async listHex(prefix: string, suffix: string): Promise<Sha256[]> {
    const keys = await this.store.list(prefix);
    const hashes: Sha256[] = [];
    for (const key of keys) {
      const name = key.slice(prefix.length);
      if (!name.endsWith(suffix)) continue;
      const hex = name.slice(0, -suffix.length);
      if (isSha256(hex)) hashes.push(hex);
    }
    return hashes.sort();
  }
}

/** In-memory strong object store for the conformance fixture. */
export class MemoryConditionalObjectStore implements ObjectStoreConditionalPut {
  private readonly objects = new Map<string, Uint8Array>();

  async putIfAbsent(
    key: string,
    bytes: Uint8Array
  ): Promise<"created" | "exists"> {
    if (this.objects.has(key)) return "exists";
    this.objects.set(key, bytes.slice());
    return "created";
  }

  async get(key: string): Promise<Uint8Array | null> {
    const bytes = this.objects.get(key);
    return bytes ? bytes.slice() : null;
  }

  async list(prefix: string): Promise<readonly string[]> {
    return [...this.objects.keys()]
      .filter((key) => key.startsWith(prefix))
      .sort();
  }
}
