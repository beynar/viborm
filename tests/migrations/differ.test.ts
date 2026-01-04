/**
 * Schema Differ Tests
 */

import { describe, expect, it } from "vitest";
import { diff, hasDestructiveOperations } from "../../src/migrations/differ";
import type {
  ColumnDef,
  SchemaSnapshot,
  TableDef,
} from "../../src/migrations/types";

// =============================================================================
// HELPERS
// =============================================================================

function makeTable(
  name: string,
  columns: ColumnDef[],
  overrides?: Partial<TableDef>
): TableDef {
  return {
    name,
    columns,
    indexes: [],
    foreignKeys: [],
    uniqueConstraints: [],
    ...overrides,
  };
}

function makeColumn(
  name: string,
  type: string,
  overrides?: Partial<ColumnDef>
): ColumnDef {
  return {
    name,
    type,
    nullable: false,
    ...overrides,
  };
}

function makeSnapshot(tables: TableDef[]): SchemaSnapshot {
  return { tables };
}

// =============================================================================
// TESTS
// =============================================================================

describe("diff", () => {
  describe("table operations", () => {
    it("should detect new tables", () => {
      const current = makeSnapshot([]);
      const desired = makeSnapshot([
        makeTable("users", [
          makeColumn("id", "integer"),
          makeColumn("name", "text"),
        ]),
      ]);

      const result = diff(current, desired);

      expect(result.operations).toHaveLength(1);
      expect(result.operations[0]).toMatchObject({
        type: "createTable",
        table: { name: "users" },
      });
      expect(result.ambiguousChanges).toHaveLength(0);
    });

    it("should detect dropped tables", () => {
      const current = makeSnapshot([
        makeTable("users", [makeColumn("id", "integer")]),
      ]);
      const desired = makeSnapshot([]);

      const result = diff(current, desired);

      expect(result.operations).toHaveLength(1);
      expect(result.operations[0]).toMatchObject({
        type: "dropTable",
        tableName: "users",
      });
    });

    it("should detect potential table renames as ambiguous", () => {
      const current = makeSnapshot([
        makeTable("users", [
          makeColumn("id", "integer"),
          makeColumn("name", "text"),
          makeColumn("email", "text"),
        ]),
      ]);
      const desired = makeSnapshot([
        makeTable("accounts", [
          makeColumn("id", "integer"),
          makeColumn("name", "text"),
          makeColumn("email", "text"),
        ]),
      ]);

      const result = diff(current, desired);

      // Should detect as ambiguous since tables have same structure
      expect(result.ambiguousChanges).toHaveLength(1);
      expect(result.ambiguousChanges[0]).toMatchObject({
        type: "ambiguousTable",
        droppedTable: "users",
        addedTable: "accounts",
      });
    });
  });

  describe("column operations", () => {
    it("should detect new columns", () => {
      const current = makeSnapshot([
        makeTable("users", [makeColumn("id", "integer")]),
      ]);
      const desired = makeSnapshot([
        makeTable("users", [
          makeColumn("id", "integer"),
          makeColumn("email", "text"),
        ]),
      ]);

      const result = diff(current, desired);

      expect(result.operations).toContainEqual({
        type: "addColumn",
        tableName: "users",
        column: { name: "email", type: "text", nullable: false },
      });
    });

    it("should detect dropped columns", () => {
      const current = makeSnapshot([
        makeTable("users", [
          makeColumn("id", "integer"),
          makeColumn("email", "text"),
        ]),
      ]);
      const desired = makeSnapshot([
        makeTable("users", [makeColumn("id", "integer")]),
      ]);

      const result = diff(current, desired);

      expect(result.operations).toContainEqual({
        type: "dropColumn",
        tableName: "users",
        columnName: "email",
      });
    });

    it("should detect potential column renames as ambiguous", () => {
      const current = makeSnapshot([
        makeTable("users", [
          makeColumn("id", "integer"),
          makeColumn("username", "text"),
        ]),
      ]);
      const desired = makeSnapshot([
        makeTable("users", [
          makeColumn("id", "integer"),
          makeColumn("name", "text"),
        ]),
      ]);

      const result = diff(current, desired);

      expect(result.ambiguousChanges).toHaveLength(1);
      expect(result.ambiguousChanges[0]).toMatchObject({
        type: "ambiguousColumn",
        tableName: "users",
        droppedColumn: { name: "username", type: "text" },
        addedColumn: { name: "name", type: "text" },
      });
    });

    it("should detect column type changes", () => {
      const current = makeSnapshot([
        makeTable("users", [makeColumn("age", "integer")]),
      ]);
      const desired = makeSnapshot([
        makeTable("users", [makeColumn("age", "text")]),
      ]);

      const result = diff(current, desired);

      expect(result.operations).toContainEqual(
        expect.objectContaining({
          type: "alterColumn",
          tableName: "users",
          columnName: "age",
        })
      );
    });

    it("should detect nullable changes", () => {
      const current = makeSnapshot([
        makeTable("users", [makeColumn("email", "text", { nullable: false })]),
      ]);
      const desired = makeSnapshot([
        makeTable("users", [makeColumn("email", "text", { nullable: true })]),
      ]);

      const result = diff(current, desired);

      expect(result.operations).toContainEqual(
        expect.objectContaining({
          type: "alterColumn",
          tableName: "users",
          columnName: "email",
        })
      );
    });

    it("should detect default value changes", () => {
      const current = makeSnapshot([
        makeTable("users", [makeColumn("status", "text")]),
      ]);
      const desired = makeSnapshot([
        makeTable("users", [
          makeColumn("status", "text", { default: "'active'" }),
        ]),
      ]);

      const result = diff(current, desired);

      expect(result.operations).toContainEqual(
        expect.objectContaining({
          type: "alterColumn",
          tableName: "users",
          columnName: "status",
        })
      );
    });
  });

  describe("index operations", () => {
    it("should detect new indexes", () => {
      const current = makeSnapshot([
        makeTable("users", [makeColumn("email", "text")]),
      ]);
      const desired = makeSnapshot([
        makeTable("users", [makeColumn("email", "text")], {
          indexes: [
            { name: "idx_users_email", columns: ["email"], unique: false },
          ],
        }),
      ]);

      const result = diff(current, desired);

      expect(result.operations).toContainEqual({
        type: "createIndex",
        tableName: "users",
        index: { name: "idx_users_email", columns: ["email"], unique: false },
      });
    });

    it("should detect dropped indexes", () => {
      const current = makeSnapshot([
        makeTable("users", [makeColumn("email", "text")], {
          indexes: [
            { name: "idx_users_email", columns: ["email"], unique: false },
          ],
        }),
      ]);
      const desired = makeSnapshot([
        makeTable("users", [makeColumn("email", "text")]),
      ]);

      const result = diff(current, desired);

      expect(result.operations).toContainEqual({
        type: "dropIndex",
        indexName: "idx_users_email",
      });
    });
  });

  describe("foreign key operations", () => {
    it("should detect new foreign keys", () => {
      const current = makeSnapshot([
        makeTable("posts", [
          makeColumn("id", "integer"),
          makeColumn("user_id", "integer"),
        ]),
      ]);
      const desired = makeSnapshot([
        makeTable(
          "posts",
          [makeColumn("id", "integer"), makeColumn("user_id", "integer")],
          {
            foreignKeys: [
              {
                name: "fk_posts_user",
                columns: ["user_id"],
                referencedTable: "users",
                referencedColumns: ["id"],
                onDelete: "cascade",
              },
            ],
          }
        ),
      ]);

      const result = diff(current, desired);

      expect(result.operations).toContainEqual(
        expect.objectContaining({
          type: "addForeignKey",
          tableName: "posts",
        })
      );
    });

    it("should detect dropped foreign keys", () => {
      const current = makeSnapshot([
        makeTable(
          "posts",
          [makeColumn("id", "integer"), makeColumn("user_id", "integer")],
          {
            foreignKeys: [
              {
                name: "fk_posts_user",
                columns: ["user_id"],
                referencedTable: "users",
                referencedColumns: ["id"],
              },
            ],
          }
        ),
      ]);
      const desired = makeSnapshot([
        makeTable("posts", [
          makeColumn("id", "integer"),
          makeColumn("user_id", "integer"),
        ]),
      ]);

      const result = diff(current, desired);

      expect(result.operations).toContainEqual({
        type: "dropForeignKey",
        tableName: "posts",
        fkName: "fk_posts_user",
      });
    });
  });

  describe("unique constraint operations", () => {
    it("should detect new unique constraints", () => {
      const current = makeSnapshot([
        makeTable("users", [makeColumn("email", "text")]),
      ]);
      const desired = makeSnapshot([
        makeTable("users", [makeColumn("email", "text")], {
          uniqueConstraints: [{ name: "uq_users_email", columns: ["email"] }],
        }),
      ]);

      const result = diff(current, desired);

      expect(result.operations).toContainEqual({
        type: "addUniqueConstraint",
        tableName: "users",
        constraint: { name: "uq_users_email", columns: ["email"] },
      });
    });
  });

  describe("primary key operations", () => {
    it("should detect primary key changes", () => {
      const current = makeSnapshot([
        makeTable("users", [makeColumn("id", "integer")], {
          primaryKey: { columns: ["id"], name: "users_pkey" },
        }),
      ]);
      const desired = makeSnapshot([
        makeTable(
          "users",
          [makeColumn("id", "integer"), makeColumn("tenant_id", "integer")],
          {
            primaryKey: { columns: ["id", "tenant_id"], name: "users_pkey" },
          }
        ),
      ]);

      const result = diff(current, desired);

      // Should drop old PK and add new one
      expect(result.operations).toContainEqual(
        expect.objectContaining({ type: "dropPrimaryKey" })
      );
      expect(result.operations).toContainEqual(
        expect.objectContaining({ type: "addPrimaryKey" })
      );
    });
  });

  describe("enum operations", () => {
    it("should detect new enums", () => {
      const current: SchemaSnapshot = { tables: [] };
      const desired: SchemaSnapshot = {
        tables: [],
        enums: [{ name: "status", values: ["active", "inactive"] }],
      };

      const result = diff(current, desired);

      expect(result.operations).toContainEqual({
        type: "createEnum",
        enumDef: { name: "status", values: ["active", "inactive"] },
      });
    });

    it("should detect dropped enums", () => {
      const current: SchemaSnapshot = {
        tables: [],
        enums: [{ name: "status", values: ["active", "inactive"] }],
      };
      const desired: SchemaSnapshot = { tables: [] };

      const result = diff(current, desired);

      expect(result.operations).toContainEqual({
        type: "dropEnum",
        enumName: "status",
      });
    });

    it("should detect enum value changes", () => {
      const current: SchemaSnapshot = {
        tables: [],
        enums: [{ name: "status", values: ["active", "inactive"] }],
      };
      const desired: SchemaSnapshot = {
        tables: [],
        enums: [{ name: "status", values: ["active", "inactive", "pending"] }],
      };

      const result = diff(current, desired);

      expect(result.operations).toContainEqual(
        expect.objectContaining({
          type: "alterEnum",
          enumName: "status",
          addValues: ["pending"],
        })
      );
    });
  });

  describe("operation ordering", () => {
    it("should order operations correctly", () => {
      const current = makeSnapshot([
        makeTable("users", [makeColumn("id", "integer")], {
          foreignKeys: [
            {
              name: "fk_users_org",
              columns: ["org_id"],
              referencedTable: "orgs",
              referencedColumns: ["id"],
            },
          ],
        }),
      ]);
      const desired = makeSnapshot([]);

      const result = diff(current, desired);

      // FK should be dropped before table
      const fkDropIndex = result.operations.findIndex(
        (op) => op.type === "dropForeignKey"
      );
      const tableDropIndex = result.operations.findIndex(
        (op) => op.type === "dropTable"
      );

      expect(fkDropIndex).toBeLessThan(tableDropIndex);
    });
  });
});

describe("hasDestructiveOperations", () => {
  it("should return true for dropTable", () => {
    const ops = [{ type: "dropTable" as const, tableName: "users" }];
    expect(hasDestructiveOperations(ops)).toBe(true);
  });

  it("should return true for dropColumn", () => {
    const ops = [
      { type: "dropColumn" as const, tableName: "users", columnName: "email" },
    ];
    expect(hasDestructiveOperations(ops)).toBe(true);
  });

  it("should return true for type changes", () => {
    const ops = [
      {
        type: "alterColumn" as const,
        tableName: "users",
        columnName: "age",
        from: { name: "age", type: "text", nullable: false },
        to: { name: "age", type: "integer", nullable: false },
      },
    ];
    expect(hasDestructiveOperations(ops)).toBe(true);
  });

  it("should return false for non-destructive operations", () => {
    const ops = [
      {
        type: "addColumn" as const,
        tableName: "users",
        column: { name: "email", type: "text", nullable: true },
      },
    ];
    expect(hasDestructiveOperations(ops)).toBe(false);
  });
});
