/**
 * Resolver Tests
 */

import { diff } from "@src/migrations/differ";
import {
  addDropResolver,
  alwaysAddDropResolver,
  alwaysRenameResolver,
  ambiguousToResolveChange,
  applyResolutions,
  callbackAsResolver,
  createPredefinedResolver,
  createResolver,
  // Unified resolvers
  lenientResolver,
  rejectAllResolver,
  resolveAmbiguousChanges,
  strictResolver,
} from "@src/migrations/resolver";
import type { AmbiguousChange, ChangeResolution } from "@src/migrations/types";
import {
  createAmbiguousChange,
  createDestructiveChange,
  createEnumValueRemovalChange,
  readEnumResolutionDecision,
} from "@src/migrations/types";
import { describe, expect, it } from "vitest";

const MISSING_RESOLUTION_PATTERN = /Missing resolution/;

const AMBIGUOUS_CHANGES_DETECTED = /Ambiguous changes detected/;

// =============================================================================
// HELPERS
// =============================================================================

function makeColumnChange(
  tableName: string,
  droppedName: string,
  addedName: string,
  type = "text"
): AmbiguousChange {
  return {
    type: "ambiguousColumn",
    tableName,
    droppedColumn: { name: droppedName, type, nullable: false },
    addedColumn: { name: addedName, type, nullable: false },
  };
}

function makeTableChange(
  droppedTable: string,
  addedTable: string
): AmbiguousChange {
  const table = (name: string) => ({
    name,
    columns: [],
    indexes: [],
    foreignKeys: [],
    uniqueConstraints: [],
  });
  return {
    type: "ambiguousTable",
    droppedTable,
    addedTable,
    droppedTableDef: table(droppedTable),
    addedTableDef: table(addedTable),
  };
}

// =============================================================================
// TESTS
// =============================================================================

describe("applyResolutions", () => {
  describe("column changes", () => {
    it("should convert rename resolution to renameColumn operation", () => {
      const change = makeColumnChange("users", "username", "name");
      const resolutions = new Map<AmbiguousChange, ChangeResolution>([
        [change, { type: "rename" }],
      ]);

      const ops = applyResolutions([change], resolutions);

      expect(ops).toContainEqual({
        type: "renameColumn",
        tableName: "users",
        from: "username",
        to: "name",
      });
    });

    it("should convert addAndDrop resolution to drop + add operations", () => {
      const change = makeColumnChange("users", "username", "name");
      const resolutions = new Map<AmbiguousChange, ChangeResolution>([
        [change, { type: "addAndDrop" }],
      ]);

      const ops = applyResolutions([change], resolutions);

      expect(ops).toContainEqual({
        type: "dropColumn",
        tableName: "users",
        columnName: "username",
      });
      expect(ops).toContainEqual({
        type: "addColumn",
        tableName: "users",
        column: { name: "name", type: "text", nullable: false },
      });
    });

    it("re-diffs a renamed column before planning its descriptor alteration", async () => {
      const current = {
        tables: [
          {
            name: "ledger",
            columns: [
              {
                name: "amount",
                type: "INTEGER",
                nullable: false,
                decimal: { precision: 10, scale: 2 },
              },
            ],
            indexes: [],
            foreignKeys: [],
            uniqueConstraints: [],
          },
        ],
      };
      const desired = {
        tables: [
          {
            name: "ledger",
            columns: [
              {
                name: "total",
                type: "INTEGER",
                nullable: false,
                decimal: { precision: 10, scale: 4 },
              },
            ],
            indexes: [],
            foreignKeys: [],
            uniqueConstraints: [],
          },
        ],
      };

      expect(
        (
          await resolveAmbiguousChanges(
            await diff(current, desired),
            current,
            desired,
            alwaysRenameResolver
          )
        ).map((operation) => operation.type)
      ).toEqual(["renameColumn", "alterColumn"]);
    });
  });

  describe("table changes", () => {
    it("should convert rename resolution to renameTable operation", () => {
      const change = makeTableChange("users", "accounts");
      const resolutions = new Map<AmbiguousChange, ChangeResolution>([
        [change, { type: "rename" }],
      ]);

      const ops = applyResolutions([change], resolutions);

      expect(ops).toContainEqual({
        type: "renameTable",
        from: "users",
        to: "accounts",
      });
    });

    it("should convert addAndDrop resolution to dropTable operation", () => {
      const change = makeTableChange("users", "accounts");
      const resolutions = new Map<AmbiguousChange, ChangeResolution>([
        [change, { type: "addAndDrop" }],
      ]);

      const ops = applyResolutions([change], resolutions);

      expect(ops).toContainEqual({
        type: "dropTable",
        tableName: "users",
      });
    });
  });

  it("refuses when no resolution is provided", () => {
    const change = makeColumnChange("users", "username", "name");
    const resolutions = new Map<AmbiguousChange, ChangeResolution>();
    expect(() => applyResolutions([change], resolutions)).toThrow(
      MISSING_RESOLUTION_PATTERN
    );
  });
});

describe("alwaysRenameResolver", () => {
  it("should resolve all changes as rename", async () => {
    const changes = [
      makeColumnChange("users", "username", "name"),
      makeTableChange("posts", "articles"),
    ];

    const resolutions = await alwaysRenameResolver(changes);

    expect(resolutions.get(changes[0]!)).toEqual({ type: "rename" });
    expect(resolutions.get(changes[1]!)).toEqual({ type: "rename" });
  });
});

describe("alwaysAddDropResolver", () => {
  it("should resolve all changes as addAndDrop", async () => {
    const changes = [
      makeColumnChange("users", "username", "name"),
      makeTableChange("posts", "articles"),
    ];

    const resolutions = await alwaysAddDropResolver(changes);

    expect(resolutions.get(changes[0]!)).toEqual({ type: "addAndDrop" });
    expect(resolutions.get(changes[1]!)).toEqual({ type: "addAndDrop" });
  });
});

describe("strictResolver", () => {
  it("should throw error when ambiguous changes exist", async () => {
    const changes = [makeColumnChange("users", "username", "name")];

    await expect(strictResolver(changes)).rejects.toThrow(
      AMBIGUOUS_CHANGES_DETECTED
    );
  });

  it("should return empty map when no changes", async () => {
    const resolutions = await strictResolver([]);
    expect(resolutions.size).toBe(0);
  });
});

describe("createResolver", () => {
  it("should create resolver from decision function", async () => {
    const resolver = createResolver((change) => {
      if (change.type === "ambiguousColumn") {
        return "rename";
      }
      return "addAndDrop";
    });

    const changes = [
      makeColumnChange("users", "username", "name"),
      makeTableChange("posts", "articles"),
    ];

    const resolutions = await resolver(changes);

    expect(resolutions.get(changes[0]!)).toEqual({ type: "rename" });
    expect(resolutions.get(changes[1]!)).toEqual({ type: "addAndDrop" });
  });

  it("should support async decision function", async () => {
    const resolver = createResolver(
      async (_change): Promise<"rename" | "addAndDrop"> => {
        await new Promise((resolve) => setTimeout(resolve, 1));
        return "rename";
      }
    );

    const changes = [makeColumnChange("users", "username", "name")];
    const resolutions = await resolver(changes);

    expect(resolutions.get(changes[0]!)).toEqual({ type: "rename" });
  });
});

describe("createPredefinedResolver", () => {
  it("should match column changes by table and name", async () => {
    const resolver = callbackAsResolver(
      createPredefinedResolver([
        {
          type: "column",
          from: "username",
          to: "name",
          tableName: "users",
          resolution: "rename",
        },
      ])
    );

    const changes = [makeColumnChange("users", "username", "name")];
    const resolutions = await resolver(changes);

    expect(resolutions.get(changes[0]!)).toEqual({ type: "rename" });
  });

  it("should match table changes by name", async () => {
    const resolver = callbackAsResolver(
      createPredefinedResolver([
        {
          type: "table",
          from: "posts",
          to: "articles",
          resolution: "addAndDrop",
        },
      ])
    );

    const changes = [makeTableChange("posts", "articles")];
    const resolutions = await resolver(changes);

    expect(resolutions.get(changes[0]!)).toEqual({ type: "addAndDrop" });
  });

  it("should leave a change no decision names unanswered", async () => {
    const resolve = createPredefinedResolver([
      {
        type: "column",
        from: "username",
        to: "name",
        tableName: "accounts",
        resolution: "rename",
      },
      { type: "table", from: "users", to: "name", resolution: "rename" },
      {
        type: "destructive",
        operation: "dropColumn",
        table: "users",
        column: "email",
      },
      {
        type: "enumValueRemoval",
        tableName: "users",
        columnName: "status",
        mapValues: { old: null },
      },
    ]);

    const column = ambiguousToResolveChange(
      makeColumnChange("users", "username", "name")
    );
    const drop = createDestructiveChange({
      operation: "dropTable",
      table: "users",
      description: "Drop table users",
    });
    const removal = createEnumValueRemovalChange({
      enumName: "status",
      tableName: "users",
      columnName: "role",
      isNullable: true,
      removedValues: ["old"],
      availableValues: ["new"],
      description: "remove old",
    });
    for (const change of [column, drop, removal]) {
      expect(await resolve(change)).toBeUndefined();
    }
  });

  it("should answer destructive and enum value removal changes it names", async () => {
    const resolve = createPredefinedResolver([
      {
        type: "destructive",
        operation: "dropTable",
        table: "logs",
        column: null,
      },
      {
        type: "enumValueRemoval",
        tableName: "users",
        columnName: "status",
        mapValues: { archived: "inactive", deleted: null },
      },
    ]);
    expect(
      await resolve(
        createDestructiveChange({
          operation: "dropTable",
          table: "logs",
          description: "Drop table logs",
        })
      )
    ).toBe("proceed");
    const removal = createEnumValueRemovalChange({
      enumName: "status",
      tableName: "users",
      columnName: "status",
      isNullable: true,
      removedValues: ["archived", "deleted"],
      availableValues: ["active", "inactive"],
      description: "remove archived and deleted",
    });
    expect(await resolve(removal)).toBe("enumMapped");
    expect(readEnumResolutionDecision(removal)).toEqual({
      kind: "mapValues",
      mappings: { archived: "inactive", deleted: null },
    });
  });

  it.each([
    ["a list", { type: "column" }, "must be an array"],
    [
      "an unknown type",
      [{ type: "bogus", from: "a", to: "b" }],
      "type must be one of",
    ],
    [
      "a missing key",
      [{ type: "column", from: "a", to: "b", resolution: "rename" }],
      "decisions[0].tableName must be a string",
    ],
    [
      "an unknown key",
      [
        {
          type: "table",
          from: "a",
          to: "b",
          resolution: "rename",
          tableName: "x",
        },
      ],
      "decisions[0] contains unknown key tableName",
    ],
    [
      "a non-string name",
      [{ type: "table", from: 1, to: "b", resolution: "rename" }],
      "from must be a string",
    ],
    [
      "an unknown resolution",
      [{ type: "table", from: "a", to: "b", resolution: "renam" }],
      "resolution must be rename or addAndDrop",
    ],
    [
      "an unknown operation",
      [
        {
          type: "destructive",
          operation: "truncate",
          table: "a",
          column: null,
        },
      ],
      "is not a destructive operation",
    ],
    [
      "a mapping that is not an object",
      [
        {
          type: "enumValueRemoval",
          tableName: "a",
          columnName: "b",
          mapValues: "x",
        },
      ],
      "mapValues must be an object",
    ],
    [
      "a mapping to a non-string",
      [
        {
          type: "enumValueRemoval",
          tableName: "a",
          columnName: "b",
          mapValues: { x: 1 },
        },
      ],
      "mapValues.x must be a string or null",
    ],
  ])("refuses %s with V4002", (_label, decisions, message) => {
    expect(() =>
      createPredefinedResolver(JSON.parse(JSON.stringify(decisions)))
    ).toThrow(
      expect.objectContaining({
        code: "V4002",
        message: expect.stringContaining(message),
      })
    );
  });
});

// =============================================================================
// UNIFIED RESOLVE CALLBACK TESTS
// =============================================================================

describe("rejectAllResolver", () => {
  it("should reject destructive changes", async () => {
    const change = createDestructiveChange({
      operation: "dropTable",
      table: "users",
      description: "Drop table users",
    });

    const result = await rejectAllResolver(change);
    expect(result).toBe("reject");
  });

  it("should reject ambiguous changes", async () => {
    const change = createAmbiguousChange({
      operation: "renameColumn",
      table: "users",
      oldName: "username",
      newName: "name",
      description: "Column rename",
    });

    const result = await rejectAllResolver(change);
    expect(result).toBe("reject");
  });

  it("should reject enum value removal changes", async () => {
    const change = createEnumValueRemovalChange({
      enumName: "Status",
      tableName: "users",
      columnName: "status",
      isNullable: true,
      removedValues: ["PENDING"],
      availableValues: ["ACTIVE", "INACTIVE"],
      description: "Removing PENDING from Status enum",
    });

    const result = await rejectAllResolver(change);
    expect(result).toBe("reject");
  });
});

describe("lenientResolver", () => {
  it("should proceed with destructive changes", async () => {
    const change = createDestructiveChange({
      operation: "dropColumn",
      table: "users",
      column: "email",
      description: "Drop column email",
    });

    const result = await lenientResolver(change);
    expect(result).toBe("proceed");
  });

  it("renames an ambiguous column but leaves a table pair undecided", async () => {
    const column = createAmbiguousChange({
      operation: "renameColumn",
      table: "users",
      column: "email",
      oldName: "mail",
      newName: "email",
      description: "Column rename",
    });
    const table = createAmbiguousChange({
      operation: "renameTable",
      table: "accounts",
      oldName: "users",
      newName: "accounts",
      description: "Table rename",
    });

    expect(await lenientResolver(column)).toBe("rename");
    expect(await lenientResolver(table)).toBeUndefined();
  });

  it("should use null for enum value removal changes", async () => {
    const change = createEnumValueRemovalChange({
      enumName: "Priority",
      tableName: "tasks",
      columnName: "priority",
      isNullable: true,
      removedValues: ["LOW", "MEDIUM"],
      availableValues: ["HIGH", "CRITICAL"],
      description: "Removing LOW and MEDIUM from Priority enum",
    });

    const result = await lenientResolver(change);
    expect(result).toBe("enumMapped");
    expect(readEnumResolutionDecision(change)).toEqual({ kind: "useNull" });
  });
});

describe("addDropResolver", () => {
  it("should proceed with destructive changes", async () => {
    const change = createDestructiveChange({
      operation: "alterColumn",
      table: "users",
      column: "age",
      description: "Alter column age",
    });

    const result = await addDropResolver(change);
    expect(result).toBe("proceed");
  });

  it("should use addAndDrop for ambiguous changes", async () => {
    const change = createAmbiguousChange({
      operation: "renameColumn",
      table: "users",
      column: "name",
      oldName: "username",
      newName: "name",
      description: "Column rename",
    });

    const result = await addDropResolver(change);
    expect(result).toBe("addAndDrop");
  });

  it("should use null for enum value removal changes", async () => {
    const change = createEnumValueRemovalChange({
      enumName: "Role",
      tableName: "users",
      columnName: "role",
      isNullable: true,
      removedValues: ["GUEST"],
      availableValues: ["USER", "ADMIN"],
      description: "Removing GUEST from Role enum",
    });

    const result = await addDropResolver(change);
    expect(result).toBe("enumMapped");
    expect(readEnumResolutionDecision(change)).toEqual({ kind: "useNull" });
  });
});

describe("EnumValueRemovalChange methods", () => {
  it("mapValues should record mappings", async () => {
    const change = createEnumValueRemovalChange({
      enumName: "Status",
      tableName: "orders",
      columnName: "status",
      isNullable: true,
      removedValues: ["PENDING", "DRAFT"],
      availableValues: ["ACTIVE", "INACTIVE"],
      description: "Removing values",
    });

    const result = change.mapValues({
      PENDING: "INACTIVE",
      DRAFT: null,
    });

    expect(result).toBe("enumMapped");
    expect(readEnumResolutionDecision(change)).toEqual({
      kind: "mapValues",
      mappings: { PENDING: "INACTIVE", DRAFT: null },
    });
  });

  it("useNull should record its decision", async () => {
    const change = createEnumValueRemovalChange({
      enumName: "Status",
      tableName: "orders",
      columnName: "status",
      isNullable: true,
      removedValues: ["PENDING"],
      availableValues: ["ACTIVE"],
      description: "Removing values",
    });

    const result = change.useNull();

    expect(result).toBe("enumMapped");
    expect(readEnumResolutionDecision(change)).toEqual({ kind: "useNull" });
  });

  it("reject should return reject", async () => {
    const change = createEnumValueRemovalChange({
      enumName: "Status",
      tableName: "orders",
      columnName: "status",
      isNullable: false,
      removedValues: ["PENDING"],
      availableValues: ["ACTIVE"],
      description: "Removing values",
    });

    const result = change.reject();
    expect(result).toBe("reject");
  });

  it("should include per-column properties", () => {
    const change = createEnumValueRemovalChange({
      enumName: "Status",
      tableName: "orders",
      columnName: "order_status",
      isNullable: false,
      removedValues: ["PENDING"],
      availableValues: ["ACTIVE"],
      description: "Removing values",
    });

    expect(change.tableName).toBe("orders");
    expect(change.columnName).toBe("order_status");
    expect(change.isNullable).toBe(false);
  });
});
