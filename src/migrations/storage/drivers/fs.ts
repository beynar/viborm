/**
 * Filesystem Storage Driver
 *
 * Migration storage driver using the local filesystem.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { MigrationStorageDriver } from "../driver";

/**
 * Filesystem-based migration storage driver.
 * Stores migrations in a local directory.
 */
export class FsStorageDriver extends MigrationStorageDriver {
  readonly baseDir: string;

  constructor(baseDir: string) {
    super("fs");
    this.baseDir = baseDir;
  }

  async get(path: string): Promise<string | null> {
    const fullPath = join(this.baseDir, path);
    if (!existsSync(fullPath)) {
      return null;
    }
    return readFileSync(fullPath, "utf-8");
  }

  async put(path: string, content: string): Promise<void> {
    const fullPath = join(this.baseDir, path);
    const dir = dirname(fullPath);

    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    writeFileSync(fullPath, content, "utf-8");
  }

  async delete(path: string): Promise<void> {
    const fullPath = join(this.baseDir, path);
    if (existsSync(fullPath)) {
      unlinkSync(fullPath);
    }
  }
}

/**
 * Creates a filesystem storage driver for the given directory.
 */
export function createFsStorageDriver(baseDir: string): FsStorageDriver {
  return new FsStorageDriver(baseDir);
}
