/**
 * Byte-level boundaries of the three text owners a migration cannot reparse
 * later: the predicate rewriter, the SQL blob admission, and the SQLite
 * foreign-key bracket.
 *
 * Each one is asked here about the input it is NOT supposed to touch — an
 * identifier that is not the renamed one, a comment that runs to the end, a
 * blob that opens with a BOM, a pragma that already carries its terminator, and
 * a violation row that names no parent. Copying those through unchanged is the
 * behavior; rewriting or double-terminating them is the defect.
 */

import { VibORMErrorCode } from "@src/errors";
import {
  assertForeignKeysIntact,
  liftForeignKeyPragmas,
  withForeignKeysLifted,
} from "@src/migrations/foreign-keys";
import { applyNativeRename } from "@src/migrations/native-rename";
import { SqlAssembly } from "@src/migrations/sql-assembly";
import { validateSqlRanges } from "@src/migrations/sql-blob";
import type { SchemaSnapshot } from "@src/migrations/types";
import { describe, expect, test } from "vitest";
import { sqliteEstateDriver } from "./_estate";

/** One table whose partial indexes each carry a different predicate shape. */
function snapshotWithPredicates(predicates: readonly string[]): SchemaSnapshot {
  return {
    tables: [
      {
        name: "account",
        columns: [
          { name: "old", type: "INTEGER", nullable: false },
          { name: "other", type: "INTEGER", nullable: true },
          { name: "u", type: "INTEGER", nullable: true },
        ],
        indexes: predicates.map((where, index) => ({
          name: `account_partial_${index}`,
          columns: ["old"],
          unique: false,
          where,
        })),
        foreignKeys: [],
        uniqueConstraints: [],
      },
    ],
  };
}

function renamedPredicates(predicates: readonly string[]): string[] {
  const renamed = applyNativeRename(snapshotWithPredicates(predicates), {
    type: "renameColumn",
    tableName: "account",
    from: "old",
    to: "new",
  });
  return (renamed.tables[0]?.indexes ?? []).map((index) => index.where ?? "");
}

describe("a column rename rewrites its own references and nothing else", () => {
  test("a quoted or bracketed identifier that is not the renamed column is copied", () => {
    expect(
      renamedPredicates([
        '"other" IS NOT NULL AND "old" > 0',
        "[other] IS NOT NULL AND [old] > 0",
      ])
    ).toEqual([
      '"other" IS NOT NULL AND "new" > 0',
      "[other] IS NOT NULL AND [new] > 0",
    ]);
  });

  test("a line comment is copied whether or not a newline closes it", () => {
    expect(
      renamedPredicates([
        '"old" > 0 -- an unterminated trailing note about old',
        '"old" > 0 -- a note about old\n  AND "old" < 10',
      ])
    ).toEqual([
      '"new" > 0 -- an unterminated trailing note about old',
      '"new" > 0 -- a note about old\n  AND "new" < 10',
    ]);
  });

  test("a column named `u` beside a bitwise `&` is not read as a unicode literal", () => {
    // `U&'…'` is PostgreSQL's unicode escape string: the identifier, the `&`
    // and the quote are one literal, and the rewriter skips its contents. Two
    // of those three characters here are a column and an operator, so the
    // predicate is ordinary SQL and its rename must still happen.
    expect(renamedPredicates(['u&1 = 0 AND "old" > 0'])).toEqual([
      'u&1 = 0 AND "new" > 0',
    ]);
  });
});

describe("SQL blob admission reads the first bytes before anything else", () => {
  test("a UTF-8 BOM refuses a blob whose ranges are otherwise exact", () => {
    const assembly = new SqlAssembly();
    assembly.add("SELECT 1");
    const sealed = assembly.seal();
    const withBom = new Uint8Array([0xef, 0xbb, 0xbf, ...sealed.bytes]);

    expect(() =>
      validateSqlRanges(sealed.bytes, sealed.dispatches)
    ).not.toThrow();
    expect(() => validateSqlRanges(withBom, sealed.dispatches)).toThrowError(
      expect.objectContaining({
        code: VibORMErrorCode.MIGRATION_INVALID_ESTATE,
        message: "SQL blobs must be UTF-8 without a BOM",
      })
    );
  });
});

describe("the SQLite foreign-key bracket runs each pragma exactly once", () => {
  test("a pragma that already carries its terminator is not terminated twice", async () => {
    const driver = sqliteEstateDriver();
    const lifted = liftForeignKeyPragmas(driver, [
      "PRAGMA foreign_keys = OFF;",
      'DROP TABLE "account"',
      "PRAGMA foreign_keys = ON;",
    ]);

    const result = await withForeignKeysLifted(driver, lifted.bracket, () =>
      Promise.resolve("done")
    );

    expect(result).toBe("done");
    expect(lifted.statements).toEqual(['DROP TABLE "account"']);
    expect(driver.statements).toEqual([
      "<connect>",
      "PRAGMA foreign_keys = OFF;",
      "PRAGMA foreign_keys = ON;",
    ]);
  });

  test("a violation row that names no parent is still reported", async () => {
    const driver = sqliteEstateDriver();
    driver.respond = (sql) =>
      sql.startsWith("PRAGMA foreign_key_check") ? [{ table: "child" }] : [];

    await expect(
      assertForeignKeysIntact(driver, {
        disable: "PRAGMA foreign_keys=OFF",
        enable: "PRAGMA foreign_keys=ON",
      })
    ).rejects.toMatchObject({
      code: VibORMErrorCode.MIGRATION_FAILED,
      message: expect.stringContaining("child -> ?"),
    });
  });
});
