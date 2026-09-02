import { MigrationError } from "@src/errors";
import {
  assertCanonicalBytes,
  bytesEqual,
  canonicalizeJson,
  canonicalizeJsonText,
  parseJsonBytes,
} from "@src/migrations/canonical-json";
import { invertOperations } from "@src/migrations/invert";
import {
  ambiguousToResolveChange,
  callbackAsResolver,
  createPredefinedResolver,
  createUnifiedResolver,
  formatAmbiguousChanges,
  validateResolveResult,
} from "@src/migrations/resolver";
import type {
  AmbiguousChange,
  DiffOperation,
  SchemaSnapshot,
  TableDef,
} from "@src/migrations/types";
import { describe, expect, test } from "vitest";

const NOT_CANONICAL = /not canonical/;
const WITHOUT_BOM = /without a BOM/;
const INVALID_UTF8_JSON = /valid UTF-8 JSON/;
const INVALID_RESOLUTION = /invalid resolution result/;
const INVALID_NULL_RESOLUTION = /invalid resolution result null/;
const REQUIRED_AMBIGUITY_DECISION = /requires rename or addAndDrop/;

const userTable: TableDef = {
  name: "user",
  columns: [{ name: "id", type: "TEXT", nullable: false }],
  indexes: [{ name: "user_id_idx", columns: ["id"], unique: false }],
  foreignKeys: [
    {
      name: "user_parent_fk",
      columns: ["id"],
      referencedTable: "user",
      referencedColumns: ["id"],
    },
  ],
  uniqueConstraints: [{ name: "user_id_key", columns: ["id"] }],
  primaryKey: { name: "user_pkey", columns: ["id"] },
};

const previousSnapshot: SchemaSnapshot = {
  tables: [userTable],
  enums: [{ name: "role", values: ["user", "admin"] }],
};

const columnAmbiguity: AmbiguousChange = {
  type: "ambiguousColumn",
  tableName: "user",
  droppedColumn: { name: "name", type: "TEXT", nullable: false },
  addedColumn: { name: "display_name", type: "TEXT", nullable: false },
};

const tableAmbiguity: AmbiguousChange = {
  type: "ambiguousTable",
  droppedTable: "user",
  addedTable: "account",
  droppedTableDef: userTable,
  addedTableDef: { ...userTable, name: "account" },
};

describe("migration planning boundaries", () => {
  test("canonical JSON owns every admitted terminal and collection shape", () => {
    expect(
      canonicalizeJsonText({ z: [null, true, false, "x", -0, 1.5], a: {} })
    ).toBe('{"a":{},"z":[null,true,false,"x",0,1.5]}');
    expect(canonicalizeJsonText({ "\uffff": 1, "\ud83d\ude00": 2 })).toBe(
      '{"😀":2,"￿":1}'
    );

    for (const refused of [
      undefined,
      1n,
      Symbol("x"),
      () => null,
      Number.NaN,
    ]) {
      expect(() => canonicalizeJson(refused)).toThrow(MigrationError);
    }
  });

  test("canonical byte verification rejects length and content drift", () => {
    const canonical = canonicalizeJson({ a: 1 });
    expect(() =>
      assertCanonicalBytes(canonical, { a: 1 }, "state")
    ).not.toThrow();
    expect(() =>
      assertCanonicalBytes(canonical.slice(0, -1), { a: 1 }, "state")
    ).toThrow(NOT_CANONICAL);
    const changed = canonical.slice();
    changed[2] = 0x62;
    expect(() => assertCanonicalBytes(changed, { a: 1 }, "state")).toThrow(
      NOT_CANONICAL
    );
  });

  test("JSON byte parsing enforces UTF-8 and BOM-free input", () => {
    expect(parseJsonBytes(canonicalizeJson({ ok: true }), "state")).toEqual({
      ok: true,
    });
    expect(() =>
      parseJsonBytes(Uint8Array.of(0xef, 0xbb, 0xbf, 0x7b), "state")
    ).toThrow(WITHOUT_BOM);
    expect(() => parseJsonBytes(Uint8Array.of(0xff), "state")).toThrow(
      INVALID_UTF8_JSON
    );
    expect(() =>
      parseJsonBytes(new TextEncoder().encode("{"), "state")
    ).toThrow(INVALID_UTF8_JSON);
  });

  test("byte equality distinguishes length and content", () => {
    expect(bytesEqual(Uint8Array.of(1, 2), Uint8Array.of(1, 2))).toBe(true);
    expect(bytesEqual(Uint8Array.of(1), Uint8Array.of(1, 2))).toBe(false);
    expect(bytesEqual(Uint8Array.of(1, 3), Uint8Array.of(1, 2))).toBe(false);
  });

  test("inverts every structural add, rename, and alteration", () => {
    const operations = [
      { type: "renameTable", from: "user", to: "account" },
      {
        type: "addColumn",
        tableName: "account",
        column: { name: "name", type: "TEXT", nullable: false },
      },
      {
        type: "renameColumn",
        tableName: "account",
        from: "id",
        to: "account_id",
      },
      {
        type: "alterColumn",
        tableName: "account",
        columnName: "account_id",
        from: { name: "id", type: "TEXT", nullable: false },
        to: { name: "account_id", type: "INTEGER", nullable: false },
      },
      {
        type: "createIndex",
        tableName: "account",
        index: { name: "account_name_idx", columns: ["name"], unique: false },
      },
      {
        type: "addForeignKey",
        tableName: "account",
        fk: userTable.foreignKeys[0]!,
      },
      {
        type: "addUniqueConstraint",
        tableName: "account",
        constraint: userTable.uniqueConstraints[0]!,
      },
      {
        type: "addPrimaryKey",
        tableName: "account",
        primaryKey: { columns: ["account_id"] },
      },
      { type: "createEnum", enumDef: { name: "state", values: ["open"] } },
    ] satisfies DiffOperation[];

    expect(
      invertOperations(operations, previousSnapshot).operations.map(
        (operation) => operation.type
      )
    ).toEqual([
      "dropEnum",
      "dropPrimaryKey",
      "dropUniqueConstraint",
      "dropForeignKey",
      "dropIndex",
      "alterColumn",
      "renameColumn",
      "dropColumn",
      "renameTable",
    ]);
  });

  test("restores every dropped definition from the previous snapshot", () => {
    const operations = [
      { type: "dropTable", tableName: "user" },
      { type: "dropColumn", tableName: "user", columnName: "id" },
      { type: "dropIndex", tableName: "user", indexName: "user_id_idx" },
      { type: "dropForeignKey", tableName: "user", fkName: "user_parent_fk" },
      {
        type: "dropUniqueConstraint",
        tableName: "user",
        constraintName: "user_id_key",
      },
      {
        type: "dropPrimaryKey",
        tableName: "user",
        constraintName: "user_pkey",
      },
      { type: "dropEnum", enumName: "role" },
      {
        type: "alterEnum",
        enumName: "role",
        addValues: ["owner"],
        removeValues: ["admin"],
        newValues: ["user", "owner"],
      },
    ] satisfies DiffOperation[];
    const inverted = invertOperations(operations, previousSnapshot);

    expect(inverted.operations.map((operation) => operation.type)).toEqual([
      "alterEnum",
      "createEnum",
      "addPrimaryKey",
      "addUniqueConstraint",
      "addForeignKey",
      "createIndex",
      "addColumn",
      "createTable",
    ]);
    expect(inverted.warnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining("rollback removes values"),
        expect.stringContaining("restores the values"),
        expect.stringContaining("was lossy"),
      ])
    );
  });

  test("reports dropped definitions absent from the previous snapshot", () => {
    const operations = [
      { type: "dropTable", tableName: "missing" },
      { type: "dropColumn", tableName: "user", columnName: "missing" },
      { type: "dropIndex", tableName: "user", indexName: "missing" },
      { type: "dropForeignKey", tableName: "user", fkName: "missing" },
      {
        type: "dropUniqueConstraint",
        tableName: "user",
        constraintName: "missing",
      },
      {
        type: "dropPrimaryKey",
        tableName: "missing",
        constraintName: "missing",
      },
      { type: "dropEnum", enumName: "missing" },
      { type: "alterEnum", enumName: "missing", newValues: [] },
    ] satisfies DiffOperation[];
    const inverted = invertOperations(operations, previousSnapshot);

    expect(inverted.operations).toEqual([]);
    expect(inverted.warnings).toHaveLength(operations.length);
    expect(
      inverted.warnings.every((warning) => warning.startsWith("Cannot invert"))
    ).toBe(true);
  });

  test("adapts public callbacks for both ambiguity kinds", async () => {
    const seen: string[] = [];
    const resolver = callbackAsResolver(async (change) => {
      // ambiguousToResolveChange is declared as the broad ResolveChange union
      // even though it only ever builds ambiguous changes. Narrow on the
      // discriminant, which also pins that this callback sees exactly those.
      if (change.type !== "ambiguous") {
        throw new Error("expected an ambiguous change");
      }
      seen.push(change.operation);
      return change.operation === "renameColumn"
        ? change.rename()
        : change.addAndDrop();
    });
    const resolutions = await resolver([columnAmbiguity, tableAmbiguity]);

    expect(seen).toEqual(["renameColumn", "renameTable"]);
    expect(resolutions.get(columnAmbiguity)).toEqual({ type: "rename" });
    expect(resolutions.get(tableAmbiguity)).toEqual({ type: "addAndDrop" });
    await expect(
      callbackAsResolver(async (change) => change.reject())([columnAmbiguity])
    ).rejects.toThrow(REQUIRED_AMBIGUITY_DECISION);
  });

  test("formats and predefines column and table ambiguity decisions", async () => {
    expect(formatAmbiguousChanges([])).toBe("No ambiguous changes detected.");
    expect(formatAmbiguousChanges([columnAmbiguity, tableAmbiguity])).toContain(
      "Column rename detected"
    );
    expect(ambiguousToResolveChange(tableAmbiguity)).toMatchObject({
      operation: "renameTable",
      oldName: "user",
      newName: "account",
    });
    const resolver = createPredefinedResolver([
      {
        type: "column",
        from: "name",
        to: "display_name",
        tableName: "user",
        resolution: "rename",
      },
      {
        type: "table",
        from: "user",
        to: "account",
        resolution: "addAndDrop",
      },
    ]);
    const resolutions = await resolver([columnAmbiguity, tableAmbiguity]);
    expect(resolutions.get(columnAmbiguity)).toEqual({ type: "rename" });
    expect(resolutions.get(tableAmbiguity)).toEqual({ type: "addAndDrop" });
  });

  test("validates results against the exact supplied change kind", async () => {
    const change = ambiguousToResolveChange(columnAmbiguity);
    if (change.type !== "ambiguous") {
      throw new Error("expected an ambiguous change");
    }
    expect(
      validateResolveResult("ambiguous", change, undefined)
    ).toBeUndefined();
    expect(validateResolveResult("ambiguous", change, "reject")).toBe("reject");
    expect(validateResolveResult("ambiguous", change, "rename")).toBe("rename");
    expect(() => validateResolveResult("ambiguous", change, "proceed")).toThrow(
      INVALID_RESOLUTION
    );
    expect(() => validateResolveResult("ambiguous", change, null)).toThrow(
      INVALID_NULL_RESOLUTION
    );
    expect(await createUnifiedResolver(async () => "addAndDrop")(change)).toBe(
      "addAndDrop"
    );
  });
});
