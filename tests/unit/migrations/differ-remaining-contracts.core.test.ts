import {
  diff,
  getDestructiveOperationDescriptions,
} from "@src/migrations/differ";
import type {
  ColumnDef,
  DiffOperation,
  SchemaSnapshot,
  TableDef,
} from "@src/migrations/types";
import { describe, expect, test } from "vitest";

const id: ColumnDef = { name: "id", type: "integer", nullable: false };
const tenantId: ColumnDef = {
  name: "tenant_id",
  type: "integer",
  nullable: false,
};

function table(overrides: Partial<TableDef> = {}): TableDef {
  return {
    name: "users",
    columns: [id, tenantId],
    indexes: [],
    foreignKeys: [],
    uniqueConstraints: [],
    ...overrides,
  };
}

function snapshot(
  users: TableDef,
  enums?: SchemaSnapshot["enums"]
): SchemaSnapshot {
  return { tables: [users], enums };
}

describe("remaining differ contracts", () => {
  test("replaces a named unique constraint whose columns changed", async () => {
    const current = snapshot(
      table({
        uniqueConstraints: [{ name: "users_identity_key", columns: ["id"] }],
      })
    );
    const desired = snapshot(
      table({
        uniqueConstraints: [
          { name: "users_identity_key", columns: ["tenant_id", "id"] },
        ],
      })
    );

    expect((await diff(current, desired)).operations).toEqual([
      {
        type: "dropUniqueConstraint",
        tableName: "users",
        constraintName: "users_identity_key",
      },
      {
        type: "addUniqueConstraint",
        tableName: "users",
        constraint: {
          name: "users_identity_key",
          columns: ["tenant_id", "id"],
        },
      },
    ]);
  });

  test("plans one-sided primary-key removal and addition", async () => {
    const withoutPrimaryKey = snapshot(table());
    const withPrimaryKey = snapshot(
      table({ primaryKey: { name: "users_identity_pkey", columns: ["id"] } })
    );

    expect((await diff(withPrimaryKey, withoutPrimaryKey)).operations).toEqual([
      {
        type: "dropPrimaryKey",
        tableName: "users",
        constraintName: "users_identity_pkey",
      },
    ]);
    expect((await diff(withoutPrimaryKey, withPrimaryKey)).operations).toEqual([
      {
        type: "addPrimaryKey",
        tableName: "users",
        primaryKey: { name: "users_identity_pkey", columns: ["id"] },
      },
    ]);
  });

  test("carries every dependent column when an enum is dropped", async () => {
    const current: SchemaSnapshot = {
      tables: [
        table({
          columns: [
            id,
            { name: "status", type: "user_status", nullable: false },
          ],
        }),
        {
          ...table({
            columns: [
              id,
              { name: "status", type: "user_status", nullable: true },
            ],
          }),
          name: "invitations",
        },
      ],
      enums: [{ name: "user_status", values: ["active", "disabled"] }],
    };

    expect((await diff(current, { tables: [] })).operations).toContainEqual({
      type: "dropEnum",
      enumName: "user_status",
      dependentColumns: [
        { tableName: "users", columnName: "status" },
        { tableName: "invitations", columnName: "status" },
      ],
    });
  });

  test("describes destructive table and column removal at the public boundary", () => {
    const operations: DiffOperation[] = [
      { type: "dropTable", tableName: "sessions" },
      { type: "dropColumn", tableName: "users", columnName: "legacy_token" },
    ];

    expect(getDestructiveOperationDescriptions(operations)).toEqual([
      'Drop table "sessions" (all data will be lost)',
      'Drop column "legacy_token" from table "users" (data will be lost)',
    ]);
  });
});

describe("coverage low value", () => {
  test("retains duplicate desired constraint identities as a multiset", async () => {
    const duplicate = { name: "users_id_key", columns: ["id"] };

    expect(
      (
        await diff(
          snapshot(table({ uniqueConstraints: [duplicate] })),
          snapshot(table({ uniqueConstraints: [duplicate, duplicate] }))
        )
      ).operations
    ).toEqual([
      {
        type: "addUniqueConstraint",
        tableName: "users",
        constraint: duplicate,
      },
    ]);
  });
});
