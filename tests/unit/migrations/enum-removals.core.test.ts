import { VibORMErrorCode } from "@src/errors";
import { postgresMigrationDriver } from "@src/migrations/drivers/postgres";
import {
  applyForceEnumResolutions,
  applyResolvedEnumMappings,
  detectEnumValueRemovals,
  type EnumColumnMappings,
  resolveEnumValueRemovalMappings,
} from "@src/migrations/push/enum-removals";
import type {
  DiffOperation,
  ResolveCallback,
  SchemaSnapshot,
} from "@src/migrations/types";
import { sortOperations } from "@src/migrations/utils";
import { describe, expect, test } from "vitest";
import { ddlContext } from "./_estate";

const currentSchema: SchemaSnapshot = {
  tables: [
    {
      name: "users",
      columns: [
        { name: "id", type: "text", nullable: false },
        { name: "role", type: "Role", nullable: true },
      ],
      indexes: [],
      foreignKeys: [],
      uniqueConstraints: [],
    },
    {
      name: "sessions",
      columns: [{ name: "role", type: "Role", nullable: false }],
      indexes: [],
      foreignKeys: [],
      uniqueConstraints: [],
    },
  ],
};

function permutations<T>(items: readonly T[]): T[][] {
  return items.length === 0
    ? [[]]
    : items.flatMap((item, index) =>
        permutations([...items.slice(0, index), ...items.slice(index + 1)]).map(
          (tail) => [item, ...tail]
        )
      );
}

describe("enum removal through accepted native renames", () => {
  test("all input permutations retain rename prerequisites without reprioritizing unrelated enum work", () => {
    const tableRename: DiffOperation = {
      type: "renameTable",
      from: "before",
      to: "after",
    };
    const columnRename: DiffOperation = {
      type: "renameColumn",
      tableName: "after",
      from: "old_state",
      to: "state",
    };
    const dependent: DiffOperation = {
      type: "alterEnum",
      enumName: "closure_state",
      removeValues: ["retired"],
      newValues: ["active"],
      dependentColumns: [{ tableName: "after", columnName: "state" }],
    };
    const unrelated: DiffOperation = {
      type: "alterEnum",
      enumName: "other_state",
      addValues: ["new"],
    };
    const intermediate: DiffOperation = {
      type: "dropIndex",
      tableName: "unrelated",
      indexName: "obsolete",
    };
    const added: DiffOperation = {
      type: "addColumn",
      tableName: "after",
      column: {
        name: "extra",
        type: "closure_state",
        nullable: false,
        default: "'active'::closure_state",
      },
    };
    const operations = [
      tableRename,
      columnRename,
      dependent,
      unrelated,
      intermediate,
      added,
    ];
    for (const input of permutations(operations)) {
      const before = [...input];
      const sorted = sortOperations(input);
      expect(sorted).toHaveLength(operations.length);
      expect(new Set(sorted)).toEqual(new Set(operations));
      expect(sorted.indexOf(tableRename)).toBeLessThan(
        sorted.indexOf(columnRename)
      );
      expect(sorted.indexOf(columnRename)).toBeLessThan(
        sorted.indexOf(dependent)
      );
      expect(sorted.indexOf(dependent)).toBeLessThan(sorted.indexOf(added));
      expect(sorted.indexOf(unrelated)).toBeLessThan(
        sorted.indexOf(intermediate)
      );
      expect(input).toEqual(before);
    }
    // Equal operation objects are separate program positions, not deduplicated work.
    expect(
      sortOperations([...operations, intermediate]).filter(
        (op) => op === intermediate
      )
    ).toHaveLength(2);
  });

  test("a repeated table name preserves sequential renames and a prior column rename", () => {
    const priorColumn: DiffOperation = {
      type: "renameColumn",
      tableName: "before",
      from: "original",
      to: "old_state",
    };
    const first: DiffOperation = {
      type: "renameTable",
      from: "before",
      to: "middle",
    };
    const back: DiffOperation = {
      type: "renameTable",
      from: "middle",
      to: "before",
    };
    const last: DiffOperation = {
      type: "renameTable",
      from: "before",
      to: "after",
    };
    const finalColumn: DiffOperation = {
      type: "renameColumn",
      tableName: "after",
      from: "old_state",
      to: "state",
    };
    const dependent: DiffOperation = {
      type: "alterEnum",
      enumName: "closure_state",
      removeValues: ["retired"],
      newValues: ["active"],
      dependentColumns: [{ tableName: "after", columnName: "state" }],
    };
    const input = [dependent, priorColumn, first, back, last, finalColumn];
    expect(sortOperations(input)).toEqual([
      priorColumn,
      first,
      back,
      last,
      finalColumn,
      dependent,
    ]);
    expect(input).toEqual([
      dependent,
      priorColumn,
      first,
      back,
      last,
      finalColumn,
    ]);
  });

  test("a chained column rename reaches the enum consumer through the final column identity", () => {
    const tableRename: DiffOperation = {
      type: "renameTable",
      from: "before",
      to: "after",
    };
    const first: DiffOperation = {
      type: "renameColumn",
      tableName: "after",
      from: "original",
      to: "middle",
    };
    const last: DiffOperation = {
      type: "renameColumn",
      tableName: "after",
      from: "middle",
      to: "state",
    };
    const dependent: DiffOperation = {
      type: "alterEnum",
      enumName: "closure_state",
      removeValues: ["retired"],
      newValues: ["active"],
      dependentColumns: [{ tableName: "after", columnName: "state" }],
    };
    const input = [dependent, first, tableRename, last];
    expect(sortOperations(input)).toEqual([
      tableRename,
      first,
      last,
      dependent,
    ]);
    expect(input).toEqual([dependent, first, tableRename, last]);
  });

  test("an unresolved cyclic native rename program is refused instead of claiming an order", () => {
    expect(() =>
      sortOperations([
        { type: "renameColumn", tableName: "same", from: "old", to: "new" },
        { type: "renameTable", from: "same", to: "same" },
      ])
    ).toThrowError(
      expect.objectContaining({ code: VibORMErrorCode.MIGRATION_INVALID_STATE })
    );
  });

  test("PG enum compilation preserves renamed scalar/array defaults and array replacement order", () => {
    const current: SchemaSnapshot = {
      enums: [{ name: "closure_state", values: ["active", "retired"] }],
      tables: [
        {
          name: "before",
          columns: [
            {
              name: "old_state",
              type: "closure_state",
              nullable: true,
              default: "'active'::closure_state",
            },
            {
              name: "old_tags",
              type: "closure_state[]",
              nullable: true,
              default: "ARRAY['active'::closure_state]",
            },
          ],
          indexes: [],
          foreignKeys: [],
          uniqueConstraints: [],
        },
      ],
    };
    const before = structuredClone(current);
    const operation: DiffOperation = {
      type: "alterEnum",
      enumName: "closure_state",
      removeValues: ["retired"],
      newValues: ["active"],
      valueReplacements: { retired: "active" },
      dependentColumns: [
        { tableName: "after", columnName: "state" },
        { tableName: "after", columnName: "tags" },
      ],
    };
    const statements = postgresMigrationDriver.compileStatements(
      operation,
      ddlContext("artifact", {
        currentSchema: current,
        precedingOperations: [
          { type: "renameTable", from: "before", to: "after" },
          {
            type: "renameColumn",
            tableName: "after",
            from: "old_state",
            to: "state",
          },
          {
            type: "renameColumn",
            tableName: "after",
            from: "old_tags",
            to: "tags",
          },
        ],
      })
    );
    expect(statements).toContain(
      'ALTER TABLE "after" ALTER COLUMN "state" DROP DEFAULT'
    );
    expect(statements).toContain(
      'ALTER TABLE "after" ALTER COLUMN "tags" DROP DEFAULT'
    );
    expect(statements).toContain(
      'ALTER TABLE "after" ALTER COLUMN "state" TYPE text USING "state"::text'
    );
    expect(statements).toContain(
      'ALTER TABLE "after" ALTER COLUMN "tags" TYPE text[] USING "tags"::text[]'
    );
    expect(statements).toContain(
      'ALTER TABLE "after" ALTER COLUMN "state" SET DEFAULT \'active\'::closure_state'
    );
    expect(statements).toContain(
      'ALTER TABLE "after" ALTER COLUMN "tags" SET DEFAULT ARRAY[\'active\'::closure_state]'
    );
    expect(statements).toContain(
      'ALTER TABLE "after" ALTER COLUMN "tags" TYPE "closure_state"[] USING "tags"::"closure_state"[]'
    );
    expect(statements.join("\n")).toContain('unnest("tags") WITH ORDINALITY');
    expect(statements.join("\n")).not.toContain('"before"');
    expect(current).toEqual(before);
  });
});

function roleRemoval(): DiffOperation {
  return {
    type: "alterEnum",
    enumName: "Role",
    removeValues: ["GUEST", "LEGACY"],
    newValues: ["USER", "ADMIN"],
    valueReplacements: { GUEST: "USER" },
    dependentColumns: [
      { tableName: "users", columnName: "role" },
      { tableName: "sessions", columnName: "role" },
    ],
  };
}

describe("enum value removal planning", () => {
  test("detects only unresolved values for every dependent column", () => {
    const operations: DiffOperation[] = [
      { type: "dropTable", tableName: "obsolete" },
      roleRemoval(),
      {
        type: "alterEnum",
        enumName: "Status",
        removeValues: ["DRAFT"],
        defaultReplacement: "ACTIVE",
        dependentColumns: [{ tableName: "users", columnName: "role" }],
      },
      { type: "alterEnum", enumName: "Mood", addValues: ["HAPPY"] },
    ];

    expect(detectEnumValueRemovals(operations, currentSchema)).toEqual([
      {
        enumName: "Role",
        tableName: "users",
        columnName: "role",
        isNullable: true,
        removedValues: ["LEGACY"],
        availableValues: ["USER", "ADMIN"],
      },
      {
        enumName: "Role",
        tableName: "sessions",
        columnName: "role",
        isNullable: false,
        removedValues: ["LEGACY"],
        availableValues: ["USER", "ADMIN"],
      },
    ]);
  });

  test("force mode adds null mappings without erasing existing column mappings", () => {
    const operation = roleRemoval();
    if (operation.type !== "alterEnum") throw new Error("expected alterEnum");
    operation.columnValueReplacements = {
      "users.role": { GUEST: "USER" },
    };
    const unchanged: DiffOperation = {
      type: "dropColumn",
      tableName: "users",
      columnName: "legacy",
    };
    const removals = detectEnumValueRemovals([operation], currentSchema);

    const resolved = applyForceEnumResolutions(
      [unchanged, operation],
      removals
    );

    expect(resolved[0]).toBe(unchanged);
    expect(resolved[1]).toMatchObject({
      type: "alterEnum",
      columnValueReplacements: {
        "users.role": { GUEST: "USER", LEGACY: null },
        "sessions.role": { LEGACY: null },
      },
    });
    expect(operation.columnValueReplacements).toEqual({
      "users.role": { GUEST: "USER" },
    });
    expect(applyForceEnumResolutions([operation], [])).toEqual([operation]);
  });

  test("records independent resolver mappings for each dependent column", async () => {
    const removals = detectEnumValueRemovals([roleRemoval()], currentSchema);
    const resolve: ResolveCallback = (change) => {
      if (change.type !== "enumValueRemoval") return change.reject();
      return change.tableName === "users"
        ? change.mapValues({ LEGACY: "USER" })
        : change.useNull();
    };

    const mappings = await resolveEnumValueRemovalMappings(
      removals,
      resolve,
      false
    );

    expect([...mappings]).toEqual([
      [
        "Role",
        new Map([
          ["users.role", { LEGACY: "USER" }],
          ["sessions.role", { LEGACY: null }],
        ]),
      ],
    ]);
  });

  test("force supplies null mappings only when the resolver abstains", async () => {
    const removals = detectEnumValueRemovals([roleRemoval()], currentSchema);
    const abstain: ResolveCallback = () => undefined;

    await expect(
      resolveEnumValueRemovalMappings(removals, abstain, false)
    ).rejects.toMatchObject({
      code: VibORMErrorCode.MIGRATION_DESTRUCTIVE_REJECTED,
      message: expect.stringContaining("Unresolved enum value removal"),
    });

    const forced = await resolveEnumValueRemovalMappings(
      removals,
      abstain,
      true
    );
    expect(forced.get("Role")).toEqual(
      new Map([
        ["users.role", { LEGACY: null }],
        ["sessions.role", { LEGACY: null }],
      ])
    );
  });

  test("propagates an explicit rejection", async () => {
    const removals = detectEnumValueRemovals([roleRemoval()], currentSchema);
    const reject: ResolveCallback = (change) => change.reject();

    await expect(
      resolveEnumValueRemovalMappings(removals, reject, true)
    ).rejects.toMatchObject({
      code: VibORMErrorCode.MIGRATION_DESTRUCTIVE_REJECTED,
      message: expect.stringContaining("Change rejected"),
    });
  });

  test("merges resolved mappings without inventing a null fallback", () => {
    const mapped = roleRemoval();
    const unmapped: DiffOperation = {
      type: "alterEnum",
      enumName: "Status",
      removeValues: ["DRAFT"],
    };
    const preservedDefault: DiffOperation = {
      type: "alterEnum",
      enumName: "Mood",
      removeValues: ["SAD"],
      defaultReplacement: "HAPPY",
    };
    const mappings: EnumColumnMappings = new Map([
      [
        "Role",
        new Map([
          ["users.role", { LEGACY: "ADMIN" }],
          ["sessions.role", { LEGACY: null }],
        ]),
      ],
    ]);

    expect(
      applyResolvedEnumMappings(
        [
          { type: "dropTable", tableName: "obsolete" },
          mapped,
          unmapped,
          preservedDefault,
        ],
        mappings
      )
    ).toEqual([
      expect.objectContaining({
        type: "alterEnum",
        enumName: "Role",
        columnValueReplacements: {
          "users.role": { LEGACY: "ADMIN" },
          "sessions.role": { LEGACY: null },
        },
      }),
      unmapped,
      preservedDefault,
    ]);
  });
});

describe("coverage low value", () => {
  test.each([
    [{ tableName: "missing", columnName: "role" }, 'Table "missing"'],
    [{ tableName: "users", columnName: "missing" }, 'Column "missing"'],
  ])("refuses an impossible dependent-column reference", (dependent, message) => {
    const operation: DiffOperation = {
      type: "alterEnum",
      enumName: "Role",
      removeValues: ["LEGACY"],
      newValues: ["USER"],
      dependentColumns: [dependent],
    };

    expect(() =>
      detectEnumValueRemovals([operation], currentSchema)
    ).toThrowError(
      expect.objectContaining({
        code: VibORMErrorCode.INTERNAL_ERROR,
        message: expect.stringContaining(message),
      })
    );
  });
});
