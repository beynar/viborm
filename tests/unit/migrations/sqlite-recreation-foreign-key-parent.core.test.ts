/** Deterministic SQLite foreign-key pragma lifting contracts. */

import type { AnyDriver } from "@src/drivers/driver";
import { liftForeignKeyPragmas } from "@src/migrations/foreign-keys";
import { describe, expect, it } from "vitest";

describe("which batches get lifted", () => {
  const transactional = { supportsBatch: false } as unknown as AnyDriver;
  const batchOnly = { supportsBatch: true } as unknown as AnyDriver;
  const recreation = [
    "PRAGMA foreign_keys=OFF",
    'CREATE TABLE "__new_t" ("id" TEXT)',
    'DROP TABLE "t"',
    "PRAGMA foreign_keys=ON",
  ];

  it("takes both pragmas out of a batch that will run in a transaction", () => {
    expect(liftForeignKeyPragmas(transactional, recreation)).toEqual({
      bracket: {
        disable: "PRAGMA foreign_keys=OFF",
        enable: "PRAGMA foreign_keys=ON",
      },
      statements: ['CREATE TABLE "__new_t" ("id" TEXT)', 'DROP TABLE "t"'],
    });
  });

  it("leaves a native batch alone — one round trip has no outside to lift to", () => {
    expect(liftForeignKeyPragmas(batchOnly, recreation)).toEqual({
      bracket: null,
      statements: recreation,
    });
  });

  it("refuses half a bracket rather than leave enforcement off past the batch", () => {
    const halved = recreation.slice(0, 3);
    expect(liftForeignKeyPragmas(transactional, halved)).toEqual({
      bracket: null,
      statements: halved,
    });
  });

  it("leaves a batch that never asked for the pragma untouched", () => {
    const plain = ['ALTER TABLE "t" ADD COLUMN "c" TEXT'];
    expect(liftForeignKeyPragmas(transactional, plain)).toEqual({
      bracket: null,
      statements: plain,
    });
  });
});
