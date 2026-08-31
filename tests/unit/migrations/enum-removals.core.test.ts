import { VibORMErrorCode } from "@src/errors";
import {
  applyForceEnumResolutions,
  applyResolvedEnumMappings,
  detectEnumValueRemovals,
  resolveEnumValueRemovalMappings,
  type EnumColumnMappings,
} from "@src/migrations/push/enum-removals";
import type {
  DiffOperation,
  ResolveCallback,
  SchemaSnapshot,
} from "@src/migrations/types";
import { describe, expect, test } from "vitest";

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

  test("merges resolved mappings and supplies an explicit null fallback", () => {
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
      { ...unmapped, defaultReplacement: null },
      preservedDefault,
    ]);
  });
});

describe("coverage low value", () => {
  test.each([
    [{ tableName: "missing", columnName: "role" }, "Table \"missing\""],
    [{ tableName: "users", columnName: "missing" }, "Column \"missing\""],
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
