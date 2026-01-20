import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { SchemaSnapshot } from "../types";
import { ensureMigrationsDirs, getMetaDir } from "./journal";

const SNAPSHOT_FILENAME = "_snapshot.json";

/**
 * Get the path to the snapshot file
 */
export function getSnapshotPath(migrationsDir: string): string {
  return join(getMetaDir(migrationsDir), SNAPSHOT_FILENAME);
}

/**
 * Read the schema snapshot from disk
 * Returns null if the snapshot doesn't exist (first migration)
 */
export function readSnapshot(migrationsDir: string): SchemaSnapshot | null {
  const snapshotPath = getSnapshotPath(migrationsDir);

  if (!existsSync(snapshotPath)) {
    return null;
  }

  const content = readFileSync(snapshotPath, "utf-8");
  return JSON.parse(content) as SchemaSnapshot;
}

/**
 * Write the schema snapshot to disk
 */
export function writeSnapshot(
  migrationsDir: string,
  snapshot: SchemaSnapshot
): void {
  ensureMigrationsDirs(migrationsDir);
  const snapshotPath = getSnapshotPath(migrationsDir);
  writeFileSync(snapshotPath, JSON.stringify(snapshot, null, 2), "utf-8");
}

/**
 * Create an empty schema snapshot
 */
export function createEmptySnapshot(): SchemaSnapshot {
  return {
    tables: [],
    enums: [],
  };
}

/**
 * Get the snapshot or return an empty one if it doesn't exist
 */
export function getSnapshotOrEmpty(migrationsDir: string): SchemaSnapshot {
  return readSnapshot(migrationsDir) ?? createEmptySnapshot();
}
