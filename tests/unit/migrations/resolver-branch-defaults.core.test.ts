/**
 * Resolver arms that describe what happens when a resolution is ABSENT or is
 * not one of the words the change object hands out.
 *
 * Both are public contracts: `createPredefinedResolver` leaves unmatched changes
 * unresolved (destructive guessing is refused), and `validateResolveResult` is the
 * boundary that refuses whatever a caller's own callback returned.
 */

import { VibORMErrorCode } from "@src/errors";
import { diff } from "@src/migrations/differ";
import {
  createPredefinedResolver,
  resolveAmbiguousChanges,
  validateResolveResult,
} from "@src/migrations/resolver";
import type {
  ColumnDef,
  SchemaSnapshot,
  TableDef,
} from "@src/migrations/types";
import { createAmbiguousChange } from "@src/migrations/types";
import { describe, expect, test } from "vitest";

function column(name: string): ColumnDef {
  return { name, type: "text", nullable: false };
}

function table(name: string, columns: ColumnDef[]): TableDef {
  return {
    name,
    columns,
    indexes: [],
    foreignKeys: [],
    uniqueConstraints: [],
  };
}

const ambiguousChange = createAmbiguousChange({
  operation: "renameColumn",
  table: "users",
  column: "name",
  oldName: "username",
  newName: "name",
  description: 'Column "username" → "name" in table "users"',
});

describe("invalid resolution results", () => {
  test("names a null result by the word null", () => {
    expect(() =>
      validateResolveResult("ambiguous", ambiguousChange, null)
    ).toThrowError(
      expect.objectContaining({
        code: VibORMErrorCode.MIGRATION_INVALID_STATE,
        message: expect.stringContaining(
          "invalid resolution result null for a ambiguous change"
        ),
      })
    );
  });

  test("names a non-string result by its type", () => {
    // `typeof` is the report for everything that is neither a string nor
    // null, so a caller who returned a promise, a number, or an object gets
    // told what they returned rather than a bare "invalid".
    expect(() =>
      validateResolveResult("ambiguous", ambiguousChange, 42)
    ).toThrowError(
      expect.objectContaining({
        code: VibORMErrorCode.MIGRATION_INVALID_STATE,
        message: expect.stringContaining(
          "invalid resolution result number for a ambiguous change"
        ),
      })
    );
  });
});

describe("unanswered ambiguities", () => {
  test("refuses an unmatched change without deciding that the old data is expendable", async () => {
    const logs = table("logs", [column("id")]);
    const current: SchemaSnapshot = {
      tables: [table("users", [column("id"), column("username")]), logs],
    };
    const desired: SchemaSnapshot = {
      tables: [table("users", [column("id"), column("name")]), logs],
    };
    const initial = await diff(current, desired);
    expect(initial.ambiguousChanges).toHaveLength(1);
    await expect(
      resolveAmbiguousChanges(
        initial,
        current,
        desired,
        createPredefinedResolver([])
      )
    ).rejects.toMatchObject({
      code: VibORMErrorCode.MIGRATION_DESTRUCTIVE_REJECTED,
    });
    expect(current.tables[1]).toBe(logs);
    expect(current.tables[0]?.columns.map((column) => column.name)).toEqual([
      "id",
      "username",
    ]);
  });
});
