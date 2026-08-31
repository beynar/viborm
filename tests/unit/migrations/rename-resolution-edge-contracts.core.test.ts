import { VibORMErrorCode } from "@src/errors";
import { applyNativeRename } from "@src/migrations/native-rename";
import {
  alwaysAddDropResolver,
  applyResolutions,
  callbackAsResolver,
  createPredefinedResolver,
  resolveAmbiguousChanges,
  strictResolver,
  validateResolveResult,
} from "@src/migrations/resolver";
import {
  type AmbiguousChange,
  createAmbiguousChange,
  type SchemaSnapshot,
  type TableDef,
} from "@src/migrations/types";
import { describe, expect, test } from "vitest";

const COLUMN_THEN_TABLE = /Column.*Table/s;

const sourceTable: TableDef = {
  name: "account",
  columns: [
    { name: "old", type: "TEXT", nullable: false },
    { name: "parent", type: "TEXT", nullable: true },
  ],
  primaryKey: { name: "account_pkey", columns: ["old"] },
  indexes: [
    {
      name: "account_old_idx",
      columns: ["old"],
      unique: false,
      where: "old IS NOT NULL",
    },
  ],
  foreignKeys: [
    {
      name: "account_parent_fk",
      columns: ["parent"],
      referencedTable: "account",
      referencedColumns: ["old"],
    },
  ],
  uniqueConstraints: [{ name: "account_old_key", columns: ["old"] }],
};

function columnChange(
  tableName = "account",
  from = "old",
  to = "new"
): AmbiguousChange {
  return {
    type: "ambiguousColumn",
    tableName,
    droppedColumn: { name: from, type: "TEXT", nullable: false },
    addedColumn: { name: to, type: "TEXT", nullable: false },
  };
}

function tableChange(from = "account", to = "profile"): AmbiguousChange {
  return {
    type: "ambiguousTable",
    droppedTable: from,
    addedTable: to,
    droppedTableDef: { ...sourceTable, name: from },
    addedTableDef: { ...sourceTable, name: to },
  };
}

describe("native rename contracts", () => {
  test("column rename updates every schema-owned reference without mutating input", () => {
    const snapshot: SchemaSnapshot = {
      tables: [
        sourceTable,
        {
          ...sourceTable,
          name: "child",
          foreignKeys: [
            {
              name: "child_account_fk",
              columns: ["parent"],
              referencedTable: "account",
              referencedColumns: ["old"],
            },
          ],
        },
      ],
    };

    const renamed = applyNativeRename(snapshot, {
      type: "renameColumn",
      tableName: "account",
      from: "old",
      to: "new",
    });

    expect(renamed.tables[0]).toMatchObject({
      columns: [expect.objectContaining({ name: "new" }), expect.anything()],
      primaryKey: { columns: ["new"] },
      indexes: [expect.objectContaining({ columns: ["new"] })],
      uniqueConstraints: [expect.objectContaining({ columns: ["new"] })],
    });
    expect(renamed.tables[0]?.foreignKeys[0]?.referencedColumns).toEqual([
      "new",
    ]);
    expect(renamed.tables[1]?.foreignKeys[0]?.referencedColumns).toEqual([
      "new",
    ]);
    expect(snapshot.tables[0]?.columns[0]?.name).toBe("old");
  });

  test("table rename updates self and inbound foreign-key targets", () => {
    const snapshot: SchemaSnapshot = {
      tables: [sourceTable, { ...sourceTable, name: "child" }],
    };
    const renamed = applyNativeRename(snapshot, {
      type: "renameTable",
      from: "account",
      to: "profile",
    });

    expect(renamed.tables.map((table) => table.name)).toEqual([
      "profile",
      "child",
    ]);
    expect(
      renamed.tables.flatMap((table) =>
        table.foreignKeys.map((foreignKey) => foreignKey.referencedTable)
      )
    ).toEqual(["profile", "profile"]);
  });

  test("partial-index rewriting changes identifiers but preserves SQL data and names", () => {
    const where = [
      "old = 1",
      '"old" = 2',
      "`old` = 3",
      "[old] = 4",
      "'old' = 'old''old'",
      "E'old\\'old' = U&'old'",
      "$tag$old$tag$ = $$old$$",
      "-- old\nold = 5",
      "/* outer /* old */ old */ old = 6",
      "old(1) = schema.old",
      "old::old COLLATE old",
      "old AS old",
      "old => 1",
    ].join(" AND ");
    const snapshot: SchemaSnapshot = {
      tables: [
        {
          ...sourceTable,
          indexes: [
            { ...sourceTable.indexes[0]!, where },
            {
              ...sourceTable.indexes[0]!,
              name: "without_where",
              where: undefined,
            },
          ],
        },
      ],
    };

    const renamed = applyNativeRename(snapshot, {
      type: "renameColumn",
      tableName: "account",
      from: "old",
      to: "new]name",
    });
    const rewritten = renamed.tables[0]?.indexes[0]?.where;

    expect(rewritten).toContain('"new]name" = 1');
    expect(rewritten).toContain('"new]name" = 2');
    expect(rewritten).toContain("`new]name` = 3");
    expect(rewritten).toContain("[new]]name] = 4");
    expect(rewritten).toContain("'old' = 'old''old'");
    expect(rewritten).toContain("$tag$old$tag$ = $$old$$");
    expect(rewritten).toContain("old(1) = schema.old");
    expect(rewritten).toContain('"new]name"::old COLLATE old');
    expect(rewritten).toContain('"new]name" AS old');
    expect(rewritten).toContain("old => 1");
    expect(renamed.tables[0]?.indexes[1]).toMatchObject({
      name: "without_where",
      columns: ["new]name"],
    });
    expect(renamed.tables[0]?.indexes[1]).not.toBe(
      snapshot.tables[0]?.indexes[1]
    );
  });
});

describe("resolution edge contracts", () => {
  test("missing resolutions use the explicit add-and-drop fallback for both ambiguity kinds", () => {
    expect(
      applyResolutions([columnChange(), tableChange()], new Map())
    ).toEqual(
      expect.arrayContaining([
        { type: "dropColumn", tableName: "account", columnName: "old" },
        expect.objectContaining({ type: "addColumn", tableName: "account" }),
        { type: "dropTable", tableName: "account" },
        expect.objectContaining({ type: "createTable" }),
      ])
    );
  });

  test("predefined and callback resolvers preserve only admitted decisions", async () => {
    const column = columnChange();
    const table = tableChange();
    const predefined = createPredefinedResolver([
      {
        type: "column",
        from: "old",
        to: "new",
        tableName: "account",
        resolution: "rename",
      },
    ]);
    const resolutions = await predefined([column, table]);
    expect(resolutions.get(column)).toEqual({ type: "rename" });
    expect(resolutions.has(table)).toBe(false);

    const callback = callbackAsResolver((change) =>
      change.type === "ambiguous" ? change.addAndDrop() : undefined
    );
    expect((await callback([column])).get(column)).toEqual({
      type: "addAndDrop",
    });
  });

  test("working-snapshot resolution applies add-and-drop effects until convergence", async () => {
    const current: SchemaSnapshot = { tables: [sourceTable] };
    const desired: SchemaSnapshot = {
      tables: [{ ...sourceTable, name: "profile" }],
    };
    const initial = {
      operations: [
        { type: "dropTable", tableName: "account" },
        { type: "createTable", table: desired.tables[0]! },
      ],
      ambiguousChanges: [tableChange()],
    } satisfies Parameters<typeof resolveAmbiguousChanges>[0];

    const operations = await resolveAmbiguousChanges(
      initial,
      current,
      desired,
      alwaysAddDropResolver
    );

    expect(operations.map((operation) => operation.type)).toEqual([
      "dropTable",
      "createTable",
    ]);
  });

  test("valid results must belong to the exact supplied change", () => {
    const ambiguous = createAmbiguousChange({
      operation: "renameColumn",
      table: "account",
      column: "new",
      oldName: "old",
      newName: "new",
      description: "rename",
    });
    expect(
      validateResolveResult("ambiguous", ambiguous, undefined)
    ).toBeUndefined();
    expect(validateResolveResult("ambiguous", ambiguous, "reject")).toBe(
      "reject"
    );
    expect(() =>
      validateResolveResult("ambiguous", ambiguous, null)
    ).toThrowError(
      expect.objectContaining({
        code: VibORMErrorCode.MIGRATION_INVALID_STATE,
      })
    );
  });
});

describe("coverage low value", () => {
  test("unterminated SQL regions are copied rather than reinterpreted", () => {
    for (const where of ['"old', "[old", "'old", "/* old", "$tag$old"]) {
      const snapshot: SchemaSnapshot = {
        tables: [
          {
            ...sourceTable,
            indexes: [{ ...sourceTable.indexes[0]!, where }],
          },
        ],
      };
      const renamed = applyNativeRename(snapshot, {
        type: "renameColumn",
        tableName: "account",
        from: "old",
        to: "new",
      });
      expect(renamed.tables[0]?.indexes[0]?.where).toBe(where);
    }
  });

  test("strict and callback resolver refusals include both ambiguity forms", async () => {
    await expect(
      strictResolver([columnChange(), tableChange()])
    ).rejects.toThrow(COLUMN_THEN_TABLE);
    const callback = callbackAsResolver(() => undefined);
    await expect(callback([columnChange()])).rejects.toMatchObject({
      code: VibORMErrorCode.MIGRATION_DESTRUCTIVE_REJECTED,
    });
  });
});
