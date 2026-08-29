/**
 * Schema Differ Tests
 */

import {
  diff,
  getDestructiveOperationDescriptions,
  hasDestructiveOperations,
} from "@src/migrations/differ";
import {
  alwaysRenameResolver,
  resolveAmbiguousChanges,
} from "@src/migrations/resolver";
import type {
  ColumnDef,
  SchemaSnapshot,
  TableDef,
} from "@src/migrations/types";
import { describe, expect, it } from "vitest";

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
    it("should detect new tables", async () => {
      const current = makeSnapshot([]);
      const desired = makeSnapshot([
        makeTable("users", [
          makeColumn("id", "integer"),
          makeColumn("name", "text"),
        ]),
      ]);

      const result = await diff(current, desired);

      expect(result.operations).toHaveLength(1);
      expect(result.operations[0]).toMatchObject({
        type: "createTable",
        table: { name: "users" },
      });
      expect(result.ambiguousChanges).toHaveLength(0);
    });

    it("should detect dropped tables", async () => {
      const current = makeSnapshot([
        makeTable("users", [makeColumn("id", "integer")]),
      ]);
      const desired = makeSnapshot([]);

      const result = await diff(current, desired);

      expect(result.operations).toHaveLength(1);
      expect(result.operations[0]).toMatchObject({
        type: "dropTable",
        tableName: "users",
      });
    });

    it("should detect potential table renames as ambiguous", async () => {
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

      const result = await diff(current, desired);

      // Should detect as ambiguous since tables have same structure
      expect(result.ambiguousChanges).toHaveLength(1);
      expect(result.ambiguousChanges[0]).toMatchObject({
        type: "ambiguousTable",
        droppedTable: "users",
        addedTable: "accounts",
        droppedTableDef: current.tables[0],
        addedTableDef: desired.tables[0],
      });
    });

    it("retains in-table changes when a table rename is accepted", async () => {
      const current = makeSnapshot([
        makeTable("ledger", [
          makeColumn("id", "INTEGER"),
          makeColumn("amount", "INTEGER", {
            decimal: { precision: 10, scale: 2 },
          }),
          makeColumn("label", "TEXT"),
          makeColumn("code", "TEXT"),
          makeColumn("state", "TEXT"),
          makeColumn("legacy", "TEXT"),
        ]),
      ]);
      const desired = makeSnapshot([
        makeTable("account", [
          makeColumn("id", "INTEGER"),
          makeColumn("amount", "INTEGER", {
            decimal: { precision: 10, scale: 4 },
          }),
          makeColumn("label", "TEXT"),
          makeColumn("code", "TEXT"),
          makeColumn("state", "TEXT"),
          makeColumn("note", "BOOLEAN"),
        ]),
      ]);
      const result = await diff(current, desired);

      expect(
        await resolveAmbiguousChanges(
          result,
          current,
          desired,
          alwaysRenameResolver
        )
      ).toEqual([
        { type: "renameTable", from: "ledger", to: "account" },
        {
          type: "dropColumn",
          tableName: "account",
          columnName: "legacy",
        },
        {
          type: "addColumn",
          tableName: "account",
          column: makeColumn("note", "BOOLEAN"),
        },
        {
          type: "alterColumn",
          tableName: "account",
          columnName: "amount",
          from: makeColumn("amount", "INTEGER", {
            decimal: { precision: 10, scale: 2 },
          }),
          to: makeColumn("amount", "INTEGER", {
            decimal: { precision: 10, scale: 4 },
          }),
        },
      ]);
    });
  });

  describe("column operations", () => {
    it.each([
      [
        "PostgreSQL scalar",
        "NUMERIC(12,2)",
        "NUMERIC(10,2)",
        { precision: 12, scale: 2 },
        { precision: 10, scale: 2 },
      ],
      [
        "PostgreSQL array",
        "NUMERIC(12,4)[]",
        "NUMERIC(10,2)[]",
        { precision: 12, scale: 4 },
        { precision: 10, scale: 2 },
      ],
      [
        "MySQL scalar",
        "DECIMAL(12,2)",
        "DECIMAL(10,2)",
        { precision: 12, scale: 2 },
        { precision: 10, scale: 2 },
      ],
    ])("keeps a %s rename ambiguous when its descriptor changes", async (_label, fromType, toType, fromDecimal, toDecimal) => {
      const current = makeSnapshot([
        makeTable("ledger", [
          makeColumn("amount", fromType, { decimal: fromDecimal }),
        ]),
      ]);
      const desired = makeSnapshot([
        makeTable("ledger", [
          makeColumn("total", toType, { decimal: toDecimal }),
        ]),
      ]);
      const diffResult = await diff(current, desired);

      expect(diffResult.operations).toEqual([]);
      expect(diffResult.ambiguousChanges).toHaveLength(1);
      expect(
        (
          await resolveAmbiguousChanges(
            diffResult,
            current,
            desired,
            alwaysRenameResolver
          )
        ).map((operation) => operation.type)
      ).toEqual(["renameColumn", "alterColumn"]);
    });

    it("should detect new columns", async () => {
      const current = makeSnapshot([
        makeTable("users", [makeColumn("id", "integer")]),
      ]);
      const desired = makeSnapshot([
        makeTable("users", [
          makeColumn("id", "integer"),
          makeColumn("email", "text"),
        ]),
      ]);

      const result = await diff(current, desired);

      expect(result.operations).toContainEqual({
        type: "addColumn",
        tableName: "users",
        column: { name: "email", type: "text", nullable: false },
      });
    });

    it("should detect dropped columns", async () => {
      const current = makeSnapshot([
        makeTable("users", [
          makeColumn("id", "integer"),
          makeColumn("email", "text"),
        ]),
      ]);
      const desired = makeSnapshot([
        makeTable("users", [makeColumn("id", "integer")]),
      ]);

      const result = await diff(current, desired);

      expect(result.operations).toContainEqual({
        type: "dropColumn",
        tableName: "users",
        columnName: "email",
      });
    });

    it("should detect potential column renames as ambiguous", async () => {
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

      const result = await diff(current, desired);

      expect(result.ambiguousChanges).toHaveLength(1);
      expect(result.ambiguousChanges[0]).toMatchObject({
        type: "ambiguousColumn",
        tableName: "users",
        droppedColumn: { name: "username", type: "text" },
        addedColumn: { name: "name", type: "text" },
      });
    });

    it("should detect column type changes", async () => {
      const current = makeSnapshot([
        makeTable("users", [makeColumn("age", "integer")]),
      ]);
      const desired = makeSnapshot([
        makeTable("users", [makeColumn("age", "text")]),
      ]);

      const result = await diff(current, desired);

      expect(result.operations).toContainEqual(
        expect.objectContaining({
          type: "alterColumn",
          tableName: "users",
          columnName: "age",
        })
      );
    });

    it("should detect nullable changes", async () => {
      const current = makeSnapshot([
        makeTable("users", [makeColumn("email", "text", { nullable: false })]),
      ]);
      const desired = makeSnapshot([
        makeTable("users", [makeColumn("email", "text", { nullable: true })]),
      ]);

      const result = await diff(current, desired);

      expect(result.operations).toContainEqual(
        expect.objectContaining({
          type: "alterColumn",
          tableName: "users",
          columnName: "email",
        })
      );
    });

    it("should detect default value changes", async () => {
      const current = makeSnapshot([
        makeTable("users", [makeColumn("status", "text")]),
      ]);
      const desired = makeSnapshot([
        makeTable("users", [
          makeColumn("status", "text", { default: "'active'" }),
        ]),
      ]);

      const result = await diff(current, desired);

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
    it("should detect new indexes", async () => {
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

      const result = await diff(current, desired);

      expect(result.operations).toContainEqual({
        type: "createIndex",
        tableName: "users",
        index: { name: "idx_users_email", columns: ["email"], unique: false },
      });
    });

    it("should detect dropped indexes", async () => {
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

      const result = await diff(current, desired);

      expect(result.operations).toContainEqual({
        type: "dropIndex",
        tableName: "users",
        indexName: "idx_users_email",
      });
    });

    it("recreates an index when its uniqueness changes", async () => {
      const table = (unique: boolean) =>
        makeTable(
          "comments",
          [
            makeColumn("commentable_type", "text"),
            makeColumn("commentable_id", "text"),
          ],
          {
            indexes: [
              {
                name: "comments_commentable_poly_idx",
                columns: ["commentable_type", "commentable_id"],
                unique,
              },
            ],
          }
        );

      const toOne = await diff(
        makeSnapshot([table(false)]),
        makeSnapshot([table(true)])
      );
      const toMany = await diff(
        makeSnapshot([table(true)]),
        makeSnapshot([table(false)])
      );

      expect(toOne.operations.map((operation) => operation.type)).toEqual([
        "dropIndex",
        "createIndex",
      ]);
      expect(toMany.operations.map((operation) => operation.type)).toEqual([
        "dropIndex",
        "createIndex",
      ]);
    });

    // The introspected snapshot reads "btree" back from the Postgres/MySQL
    // catalog while the serialized one leaves an undeclared type undefined.
    // They describe the same index, so a push must not drop and recreate it.
    it("treats an undeclared index type as btree", async () => {
      const current = makeSnapshot([
        makeTable("users", [makeColumn("email", "text")], {
          indexes: [
            {
              name: "idx_users_email",
              columns: ["email"],
              unique: false,
              type: "btree",
            },
          ],
        }),
      ]);
      const desired = makeSnapshot([
        makeTable("users", [makeColumn("email", "text")], {
          indexes: [
            { name: "idx_users_email", columns: ["email"], unique: false },
          ],
        }),
      ]);

      expect((await diff(current, desired)).operations).toEqual([]);
      expect((await diff(desired, current)).operations).toEqual([]);
    });

    it("still detects a real index type change", async () => {
      const current = makeSnapshot([
        makeTable("users", [makeColumn("email", "text")], {
          indexes: [
            {
              name: "idx_users_email",
              columns: ["email"],
              unique: false,
              type: "btree",
            },
          ],
        }),
      ]);
      const desired = makeSnapshot([
        makeTable("users", [makeColumn("email", "text")], {
          indexes: [
            {
              name: "idx_users_email",
              columns: ["email"],
              unique: false,
              type: "gin",
            },
          ],
        }),
      ]);

      const result = await diff(current, desired);

      expect(result.operations.map((op) => op.type)).toEqual([
        "dropIndex",
        "createIndex",
      ]);
    });

    // `type`'s and `unique`'s twin, for the partial index. The emitter writes
    // ` WHERE ${where}`, so a declared predicate carrying padding reaches the
    // catalog with that padding attached to the clause boundary — and SQLite
    // stores the statement verbatim. Reading it back past `WHERE\s+` returns
    // the predicate without its leading run, so the two snapshots describe the
    // same index in two spellings. Left raw, every push re-plans drop+create.
    it("ignores the padding around a partial index predicate", async () => {
      const current = makeSnapshot([
        makeTable("users", [makeColumn("email", "text")], {
          indexes: [
            {
              name: "idx_users_email",
              columns: ["email"],
              unique: false,
              where: "active = 1",
            },
          ],
        }),
      ]);
      const desired = makeSnapshot([
        makeTable("users", [makeColumn("email", "text")], {
          indexes: [
            {
              name: "idx_users_email",
              columns: ["email"],
              unique: false,
              where: "  active = 1 ",
            },
          ],
        }),
      ]);

      expect((await diff(current, desired)).operations).toEqual([]);
      expect((await diff(desired, current)).operations).toEqual([]);
    });

    it("still detects a real partial index predicate change", async () => {
      const current = makeSnapshot([
        makeTable("users", [makeColumn("email", "text")], {
          indexes: [
            {
              name: "idx_users_email",
              columns: ["email"],
              unique: false,
              where: "active = 1",
            },
          ],
        }),
      ]);
      const desired = makeSnapshot([
        makeTable("users", [makeColumn("email", "text")], {
          indexes: [
            {
              name: "idx_users_email",
              columns: ["email"],
              unique: false,
              where: "active = 0",
            },
          ],
        }),
      ]);

      expect(
        (await diff(current, desired)).operations.map((op) => op.type)
      ).toEqual(["dropIndex", "createIndex"]);
    });

    // A predicate that appears and one that goes away are both real changes.
    it("still detects a partial index becoming total", async () => {
      const current = makeSnapshot([
        makeTable("users", [makeColumn("email", "text")], {
          indexes: [
            {
              name: "idx_users_email",
              columns: ["email"],
              unique: false,
              where: "active = 1",
            },
          ],
        }),
      ]);
      const desired = makeSnapshot([
        makeTable("users", [makeColumn("email", "text")], {
          indexes: [
            { name: "idx_users_email", columns: ["email"], unique: false },
          ],
        }),
      ]);

      expect(
        (await diff(current, desired)).operations.map((op) => op.type)
      ).toEqual(["dropIndex", "createIndex"]);
    });
  });

  // Decision 7.4. PostgreSQL deparses an index predicate rather than storing
  // the statement, so the declaration and the catalog read differently and the
  // differ planned drop+create forever. It closes that by asking the database
  // for its own spelling of both texts — and must not close anything else.
  describe("partial index predicate canonicalization", () => {
    function partialIndexSnapshots(currentWhere: string, desiredWhere: string) {
      const table = (where: string) =>
        makeSnapshot([
          makeTable("users", [makeColumn("email", "text")], {
            indexes: [
              {
                name: "idx_users_email",
                columns: ["email"],
                unique: false,
                where,
              },
            ],
          }),
        ]);
      return [table(currentWhere), table(desiredWhere)] as const;
    }

    it("two spellings the database calls one predicate are not a change", async () => {
      const [current, desired] = partialIndexSnapshots(
        "(active = true)",
        "active = true"
      );

      const result = await diff(current, desired, {
        canonicalizeIndexPredicate: (_table, predicates) =>
          Promise.resolve(predicates.map(() => "active = true")),
      });

      expect(result.operations).toEqual([]);
    });

    it("two spellings the database calls two predicates are a change", async () => {
      const [current, desired] = partialIndexSnapshots(
        "(active = true)",
        "active = false"
      );

      const result = await diff(current, desired, {
        canonicalizeIndexPredicate: (_table, predicates) =>
          Promise.resolve(predicates.map((predicate) => predicate.trim())),
      });

      expect(result.operations.map((op) => op.type)).toEqual([
        "dropIndex",
        "createIndex",
      ]);
    });

    // Fail closed. A database that cannot answer must leave the drop+create
    // standing — the pre-7.4 reading — and never be read as agreement.
    it("a predicate the database will not spell stays a change", async () => {
      const [current, desired] = partialIndexSnapshots(
        "(active = true)",
        "active = true"
      );

      const result = await diff(current, desired, {
        canonicalizeIndexPredicate: (_table, predicates) =>
          Promise.resolve(predicates.map(() => undefined)),
      });

      expect(result.operations.map((op) => op.type)).toEqual([
        "dropIndex",
        "createIndex",
      ]);
    });

    // Half an answer is no answer: one canonical spelling cannot equal a text
    // the database never deparsed.
    it("one side spelled and the other not stays a change", async () => {
      const [current, desired] = partialIndexSnapshots(
        "(active = true)",
        "active = true"
      );

      const result = await diff(current, desired, {
        canonicalizeIndexPredicate: (_table, predicates) =>
          Promise.resolve(
            predicates.map((predicate) =>
              predicate === "active = true" ? "active = true" : undefined
            )
          ),
      });

      expect(result.operations.map((op) => op.type)).toEqual([
        "dropIndex",
        "createIndex",
      ]);
    });

    // The round trip is not spent where the answer is already known.
    it("does not ask about predicates that already read alike", async () => {
      const [current, desired] = partialIndexSnapshots(
        "active = true",
        "active = true"
      );
      const asked: string[][] = [];

      const result = await diff(current, desired, {
        canonicalizeIndexPredicate: (_table, predicates) => {
          asked.push([...predicates]);
          return Promise.resolve(predicates.map(() => "same"));
        },
      });

      expect(result.operations).toEqual([]);
      expect(asked).toEqual([]);
    });

    // A predicate that appears or goes away is a real change on every dialect,
    // and no spelling of it can equal a total index.
    it("does not ask when one side has no predicate", async () => {
      const current = makeSnapshot([
        makeTable("users", [makeColumn("email", "text")], {
          indexes: [
            { name: "idx_users_email", columns: ["email"], unique: false },
          ],
        }),
      ]);
      const [, desired] = partialIndexSnapshots("x", "active = true");
      const asked: string[][] = [];

      const result = await diff(current, desired, {
        canonicalizeIndexPredicate: (_table, predicates) => {
          asked.push([...predicates]);
          return Promise.resolve(predicates.map(() => "same"));
        },
      });

      expect(result.operations.map((op) => op.type)).toEqual([
        "dropIndex",
        "createIndex",
      ]);
      expect(asked).toEqual([]);
    });

    // The canonical spelling settles the predicate and nothing else: an index
    // whose columns changed is a change however the database spells its
    // predicate.
    it("does not make a column change equal", async () => {
      const current = makeSnapshot([
        makeTable("users", [makeColumn("email", "text")], {
          indexes: [
            {
              name: "idx_users_email",
              columns: ["email"],
              unique: false,
              where: "(active = true)",
            },
          ],
        }),
      ]);
      const desired = makeSnapshot([
        makeTable("users", [makeColumn("email", "text")], {
          indexes: [
            {
              name: "idx_users_email",
              columns: ["email", "name"],
              unique: false,
              where: "active = true",
            },
          ],
        }),
      ]);

      const result = await diff(current, desired, {
        canonicalizeIndexPredicate: (_table, predicates) =>
          Promise.resolve(predicates.map(() => "active = true")),
      });

      expect(result.operations.map((op) => op.type)).toEqual([
        "dropIndex",
        "createIndex",
      ]);
    });
  });

  describe("foreign key operations", () => {
    it("should detect new foreign keys", async () => {
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

      const result = await diff(current, desired);

      expect(result.operations).toContainEqual(
        expect.objectContaining({
          type: "addForeignKey",
          tableName: "posts",
        })
      );
    });

    it("should detect dropped foreign keys", async () => {
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

      const result = await diff(current, desired);

      expect(result.operations).toContainEqual({
        type: "dropForeignKey",
        tableName: "posts",
        fkName: "fk_posts_user",
      });
    });
  });

  describe("unique constraint operations", () => {
    it("should detect new unique constraints", async () => {
      const current = makeSnapshot([
        makeTable("users", [makeColumn("email", "text")]),
      ]);
      const desired = makeSnapshot([
        makeTable("users", [makeColumn("email", "text")], {
          uniqueConstraints: [{ name: "uq_users_email", columns: ["email"] }],
        }),
      ]);

      const result = await diff(current, desired);

      expect(result.operations).toContainEqual({
        type: "addUniqueConstraint",
        tableName: "users",
        constraint: { name: "uq_users_email", columns: ["email"] },
      });
    });
  });

  describe("primary key operations", () => {
    it("should detect primary key changes", async () => {
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

      const result = await diff(current, desired);

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
    it("should detect new enums", async () => {
      const current: SchemaSnapshot = { tables: [] };
      const desired: SchemaSnapshot = {
        tables: [],
        enums: [{ name: "status", values: ["active", "inactive"] }],
      };

      const result = await diff(current, desired);

      expect(result.operations).toContainEqual({
        type: "createEnum",
        enumDef: { name: "status", values: ["active", "inactive"] },
      });
    });

    it("should detect dropped enums", async () => {
      const current: SchemaSnapshot = {
        tables: [],
        enums: [{ name: "status", values: ["active", "inactive"] }],
      };
      const desired: SchemaSnapshot = { tables: [] };

      const result = await diff(current, desired);

      expect(result.operations).toContainEqual({
        type: "dropEnum",
        enumName: "status",
      });
    });

    it("should detect enum value changes", async () => {
      const current: SchemaSnapshot = {
        tables: [],
        enums: [{ name: "status", values: ["active", "inactive"] }],
      };
      const desired: SchemaSnapshot = {
        tables: [],
        enums: [{ name: "status", values: ["active", "inactive", "pending"] }],
      };

      const result = await diff(current, desired);

      expect(result.operations).toContainEqual(
        expect.objectContaining({
          type: "alterEnum",
          enumName: "status",
          addValues: ["pending"],
        })
      );
    });

    it("should detect enum value removal with dependent columns", async () => {
      const current: SchemaSnapshot = {
        tables: [
          makeTable("users", [
            makeColumn("id", "integer"),
            makeColumn("status", "user_status_enum"),
          ]),
          makeTable("orders", [
            makeColumn("id", "integer"),
            makeColumn("order_status", "user_status_enum"),
          ]),
        ],
        enums: [
          {
            name: "user_status_enum",
            values: ["active", "inactive", "pending"],
          },
        ],
      };
      const desired: SchemaSnapshot = {
        tables: [
          makeTable("users", [
            makeColumn("id", "integer"),
            makeColumn("status", "user_status_enum"),
          ]),
          makeTable("orders", [
            makeColumn("id", "integer"),
            makeColumn("order_status", "user_status_enum"),
          ]),
        ],
        enums: [{ name: "user_status_enum", values: ["active", "inactive"] }],
      };

      const result = await diff(current, desired);

      const alterEnumOp = result.operations.find(
        (op) => op.type === "alterEnum"
      );

      expect(alterEnumOp).toBeDefined();
      expect(alterEnumOp).toMatchObject({
        type: "alterEnum",
        enumName: "user_status_enum",
        removeValues: ["pending"],
        newValues: ["active", "inactive"],
      });

      // Should include dependent columns
      if (alterEnumOp?.type === "alterEnum") {
        expect(alterEnumOp.dependentColumns).toEqual([
          { tableName: "users", columnName: "status" },
          { tableName: "orders", columnName: "order_status" },
        ]);
      }
    });

    it("should not include newValues or dependentColumns when only adding values", async () => {
      const current: SchemaSnapshot = {
        tables: [makeTable("users", [makeColumn("status", "status_enum")])],
        enums: [{ name: "status_enum", values: ["active"] }],
      };
      const desired: SchemaSnapshot = {
        tables: [makeTable("users", [makeColumn("status", "status_enum")])],
        enums: [{ name: "status_enum", values: ["active", "inactive"] }],
      };

      const result = await diff(current, desired);

      const alterEnumOp = result.operations.find(
        (op) => op.type === "alterEnum"
      );

      expect(alterEnumOp).toMatchObject({
        type: "alterEnum",
        enumName: "status_enum",
        addValues: ["inactive"],
      });

      // Should NOT have newValues or dependentColumns when only adding
      if (alterEnumOp?.type === "alterEnum") {
        expect(alterEnumOp.newValues).toBeUndefined();
        expect(alterEnumOp.dependentColumns).toBeUndefined();
      }
    });
  });

  describe("operation ordering", () => {
    it("should order operations correctly", async () => {
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

      const result = await diff(current, desired);

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
  it("should return true for dropTable", async () => {
    const ops = [{ type: "dropTable" as const, tableName: "users" }];
    expect(hasDestructiveOperations(ops)).toBe(true);
  });

  it("should return true for dropColumn", async () => {
    const ops = [
      { type: "dropColumn" as const, tableName: "users", columnName: "email" },
    ];
    expect(hasDestructiveOperations(ops)).toBe(true);
  });

  it("should return true for type changes", async () => {
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

  it("should return false for non-destructive operations", async () => {
    const ops = [
      {
        type: "addColumn" as const,
        tableName: "users",
        column: { name: "email", type: "text", nullable: true },
      },
    ];
    expect(hasDestructiveOperations(ops)).toBe(false);
  });

  it("classifies a narrowing decimal domain even when the type never moves", () => {
    // On SQLite both sides read `INTEGER` at every precision and scale, so a
    // predicate that only compares types sees nothing — and the resolver never
    // gets to ask about a conversion that refuses rows.
    const narrow = (
      from: { precision: number; scale: number },
      to: { precision: number; scale: number }
    ) => [
      {
        type: "alterColumn" as const,
        tableName: "ledger",
        columnName: "amount",
        from: {
          name: "amount",
          type: "INTEGER",
          nullable: false,
          decimal: from,
        },
        to: { name: "amount", type: "INTEGER", nullable: false, decimal: to },
      },
    ];

    // Fewer integer digits.
    expect(
      hasDestructiveOperations(
        narrow({ precision: 12, scale: 2 }, { precision: 10, scale: 2 })
      )
    ).toBe(true);
    // Fewer fractional digits.
    expect(
      hasDestructiveOperations(
        narrow({ precision: 10, scale: 4 }, { precision: 10, scale: 2 })
      )
    ).toBe(true);
    // More fractional digits at the same precision costs an integer digit:
    // NUMERIC(10,2) holds 99999999.99 and NUMERIC(10,5) does not.
    expect(
      hasDestructiveOperations(
        narrow({ precision: 10, scale: 2 }, { precision: 10, scale: 5 })
      )
    ).toBe(true);
    // Both limits rise: every existing value fits, so nothing is at risk.
    expect(
      hasDestructiveOperations(
        narrow({ precision: 10, scale: 2 }, { precision: 12, scale: 4 })
      )
    ).toBe(false);
  });

  it("describes the narrowing with both domains in the sentence", () => {
    // `precision` and `scale` are not error-metadata keys, so a refusal that
    // put them in `meta` would drop them silently.
    const [description] = getDestructiveOperationDescriptions([
      {
        type: "alterColumn",
        tableName: "ledger",
        columnName: "amount",
        from: {
          name: "amount",
          type: "INTEGER",
          nullable: false,
          decimal: { precision: 10, scale: 4 },
        },
        to: {
          name: "amount",
          type: "INTEGER",
          nullable: false,
          decimal: { precision: 10, scale: 2 },
        },
      },
    ]);
    expect(description).toContain("precision 10, scale 4");
    expect(description).toContain("precision 10, scale 2");
    expect(description).toContain("rather than rounding it");
  });
});

describe("the differ compares the declared decimal domain", () => {
  const ledger = (precision: number, scale: number, type = "INTEGER") =>
    makeSnapshot([
      makeTable("ledger", [
        makeColumn("amount", type, { decimal: { precision, scale } }),
      ]),
    ]);

  it("plans an alterColumn when only the domain moved", async () => {
    // The physical class is byte-identical on both sides. Without the
    // descriptor comparison NOTHING is planned, and the column silently keeps
    // storing coefficients at the old scale.
    const result = await diff(ledger(10, 2), ledger(10, 4));
    expect(result.operations).toEqual([
      {
        type: "alterColumn",
        tableName: "ledger",
        columnName: "amount",
        from: expect.objectContaining({ decimal: { precision: 10, scale: 2 } }),
        to: expect.objectContaining({ decimal: { precision: 10, scale: 4 } }),
      },
    ]);
  });

  it("plans nothing when the domain is unchanged", async () => {
    expect((await diff(ledger(10, 2), ledger(10, 2))).operations).toEqual([]);
    // The JSON-backed list is the same claim on a different storage class.
    expect(
      (await diff(ledger(10, 2, "JSON"), ledger(10, 2, "JSON"))).operations
    ).toEqual([]);
  });

  it("plans an alterColumn when one side carries no domain at all", async () => {
    // A snapshot whose introspection could not recover the descriptor is not
    // "the same column": left equal, the desired side would declare a domain
    // the estate does not have, forever.
    const undeclared = makeSnapshot([
      makeTable("ledger", [makeColumn("amount", "INTEGER")]),
    ]);
    expect((await diff(undeclared, ledger(10, 2))).operations).toHaveLength(1);
  });
});
