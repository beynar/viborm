/** Deterministic SQLite foreign-key pragma lifting contracts. */

import type { AnyDriver } from "@src/drivers/driver";
import { VibORMErrorCode } from "@src/errors";
import { liftForeignKeyPragmas } from "@src/migrations/foreign-keys";
import { describe, expect, it } from "vitest";

describe("which batches get lifted", () => {
  const transactional = { supportsTransactions: true } as unknown as AnyDriver;
  const transactionless = {
    supportsTransactions: false,
    driverName: "d1",
  } as unknown as AnyDriver;
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

  it("refuses a recreation where no transaction can prove the lift", () => {
    expect(() => liftForeignKeyPragmas(transactionless, recreation)).toThrow(
      expect.objectContaining({
        code: VibORMErrorCode.MIGRATION_UNSUPPORTED_PROVIDER,
      })
    );
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
    for (const driver of [transactional, transactionless]) {
      expect(liftForeignKeyPragmas(driver, plain)).toEqual({
        bracket: null,
        statements: plain,
      });
    }
  });
});
