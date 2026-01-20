/**
 * Resolver Tests
 */

import { describe, expect, it } from "vitest";
import {
  alwaysAddDropResolver,
  alwaysRenameResolver,
  applyResolutions,
  createPredefinedResolver,
  createResolver,
  strictResolver,
  // Unified resolvers
  lenientResolver,
  addDropResolver,
  rejectAllResolver,
} from "../../src/migrations/resolver";
import {
  createDestructiveChange,
  createAmbiguousChange,
  createEnumValueRemovalChange,
} from "../../src/migrations/types";
import type {
  AmbiguousChange,
  ChangeResolution,
} from "../../src/migrations/types";

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
  return {
    type: "ambiguousTable",
    droppedTable,
    addedTable,
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

  it("should default to addAndDrop when no resolution provided", () => {
    const change = makeColumnChange("users", "username", "name");
    const resolutions = new Map<AmbiguousChange, ChangeResolution>();

    const ops = applyResolutions([change], resolutions);

    expect(ops).toContainEqual({
      type: "dropColumn",
      tableName: "users",
      columnName: "username",
    });
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
      /Ambiguous changes detected/
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
  it("should match column changes by name", async () => {
    const resolver = createPredefinedResolver([
      {
        type: "column",
        from: "username",
        to: "name",
        tableName: "users",
        resolution: "rename",
      },
    ]);

    const changes = [makeColumnChange("users", "username", "name")];
    const resolutions = await resolver(changes);

    expect(resolutions.get(changes[0]!)).toEqual({ type: "rename" });
  });

  it("should match table changes by name", async () => {
    const resolver = createPredefinedResolver([
      {
        type: "table",
        from: "posts",
        to: "articles",
        resolution: "rename",
      },
    ]);

    const changes = [makeTableChange("posts", "articles")];
    const resolutions = await resolver(changes);

    expect(resolutions.get(changes[0]!)).toEqual({ type: "rename" });
  });

  it("should not set resolution for unmatched changes", async () => {
    const resolver = createPredefinedResolver([
      {
        type: "column",
        from: "foo",
        to: "bar",
        resolution: "rename",
      },
    ]);

    const changes = [makeColumnChange("users", "username", "name")];
    const resolutions = await resolver(changes);

    expect(resolutions.has(changes[0]!)).toBe(false);
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

  it("should rename ambiguous changes", async () => {
    const change = createAmbiguousChange({
      operation: "renameTable",
      table: "accounts",
      oldName: "users",
      newName: "accounts",
      description: "Table rename",
    });

    const result = await lenientResolver(change);
    expect(result).toBe("rename");
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
    expect(change._useNullDefault).toBe(true);
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
    expect(change._useNullDefault).toBe(true);
  });
});

describe("EnumValueRemovalChange methods", () => {
  it("mapValues should store mappings", async () => {
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
    expect(change._mappings).toEqual({
      PENDING: "INACTIVE",
      DRAFT: null,
    });
  });

  it("useNull should set _useNullDefault flag", async () => {
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
    expect(change._useNullDefault).toBe(true);
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
