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
} from "../../src/migrations/resolver";
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

    expect(resolutions.get(changes[0])).toEqual({ type: "rename" });
    expect(resolutions.get(changes[1])).toEqual({ type: "rename" });
  });
});

describe("alwaysAddDropResolver", () => {
  it("should resolve all changes as addAndDrop", async () => {
    const changes = [
      makeColumnChange("users", "username", "name"),
      makeTableChange("posts", "articles"),
    ];

    const resolutions = await alwaysAddDropResolver(changes);

    expect(resolutions.get(changes[0])).toEqual({ type: "addAndDrop" });
    expect(resolutions.get(changes[1])).toEqual({ type: "addAndDrop" });
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

    expect(resolutions.get(changes[0])).toEqual({ type: "rename" });
    expect(resolutions.get(changes[1])).toEqual({ type: "addAndDrop" });
  });

  it("should support async decision function", async () => {
    const resolver = createResolver(async (_change) => {
      await new Promise((resolve) => setTimeout(resolve, 1));
      return "rename";
    });

    const changes = [makeColumnChange("users", "username", "name")];
    const resolutions = await resolver(changes);

    expect(resolutions.get(changes[0])).toEqual({ type: "rename" });
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

    expect(resolutions.get(changes[0])).toEqual({ type: "rename" });
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

    expect(resolutions.get(changes[0])).toEqual({ type: "rename" });
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

    expect(resolutions.has(changes[0])).toBe(false);
  });
});
