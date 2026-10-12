import { VibORMErrorCode } from "@errors";
import {
  type DiffOptions,
  diff,
  isDestructiveOperation,
} from "@migrations/differ";
import { invertOperations } from "@migrations/invert";
import {
  alwaysAddDropResolver,
  alwaysRenameResolver,
  resolveAmbiguousChanges,
} from "@migrations/resolver";
import type {
  DiffOperation,
  Resolver,
  SchemaSnapshot,
  TableDef,
} from "@migrations/types";
import { sortOperations } from "@migrations/utils";
import { expect, it } from "vitest";

const decimal = (precision: number, scale: number) => ({ precision, scale });

function table(
  name: string,
  columns: TableDef["columns"],
  rest: Partial<TableDef> = {}
): TableDef {
  return {
    name,
    columns,
    indexes: [],
    foreignKeys: [],
    uniqueConstraints: [],
    ...rest,
  };
}

it("re-diffs outer and inner renames through native PK/index/UQ/FK effects", async () => {
  const stableColumns = [
    "id",
    "code",
    "label",
    "state",
    "owner",
    "created",
  ].map((name) => ({ name, type: "TEXT", nullable: false }));
  const current: SchemaSnapshot = {
    tables: [
      table(
        "ledger_before",
        [
          ...stableColumns,
          {
            name: "amount",
            type: "INTEGER",
            nullable: false,
            decimal: decimal(12, 2),
          },
        ],
        {
          primaryKey: { columns: ["amount"] },
          indexes: [
            {
              name: "amount_lookup",
              columns: ["amount"],
              unique: false,
              where: String.raw`"amount" > 0 AND amount > 0 AND amount(note) IS NOT NULL AND amount::amount > 0 AND CAST(amount AS amount) > 0 AND note <> 'amount' AND note <> E'amount\' amount' AND note <> $$amount$$ /* "amount" is a column only outside this comment */`,
            },
          ],
          foreignKeys: [
            {
              name: "ledger_before_fk_0",
              columns: ["amount"],
              referencedTable: "ledger_before",
              referencedColumns: ["amount"],
            },
          ],
          uniqueConstraints: [
            { name: "sqlite_autoindex_ledger_before_1", columns: ["amount"] },
          ],
        }
      ),
      table(
        "entries",
        [{ name: "ledger_amount", type: "INTEGER", nullable: false }],
        {
          foreignKeys: [
            {
              name: "entries_fk_0",
              columns: ["ledger_amount"],
              referencedTable: "ledger_before",
              referencedColumns: ["amount"],
            },
          ],
        }
      ),
    ],
  };
  const desired: SchemaSnapshot = {
    tables: [
      table(
        "ledger_after",
        [
          ...stableColumns,
          {
            name: "total",
            type: "INTEGER",
            nullable: false,
            decimal: decimal(10, 2),
          },
        ],
        {
          primaryKey: { columns: ["total"] },
          indexes: [
            {
              name: "amount_lookup",
              columns: ["total"],
              unique: false,
              where: String.raw`"total" > 0 AND total > 0 AND amount(note) IS NOT NULL AND total::amount > 0 AND CAST(total AS amount) > 0 AND note <> 'amount' AND note <> E'amount\' amount' AND note <> $$amount$$ /* "amount" is a column only outside this comment */`,
            },
          ],
          foreignKeys: [
            {
              name: "ledger_total_fkey",
              columns: ["total"],
              referencedTable: "ledger_after",
              referencedColumns: ["total"],
            },
          ],
          uniqueConstraints: [{ name: "ledger_total_key", columns: ["total"] }],
        }
      ),
      table(
        "entries",
        [{ name: "ledger_amount", type: "INTEGER", nullable: false }],
        {
          foreignKeys: [
            {
              name: "entries_ledger_amount_fkey",
              columns: ["ledger_amount"],
              referencedTable: "ledger_after",
              referencedColumns: ["total"],
            },
          ],
        }
      ),
    ],
  };
  const batches: string[][] = [];
  const resolver: Resolver = async (changes) => {
    batches.push(changes.map((change) => change.type));
    return alwaysRenameResolver(changes);
  };
  const options: DiffOptions = { matchConstraintsByShape: true };

  const operations = await resolveAmbiguousChanges(
    await diff(current, desired, options),
    current,
    desired,
    resolver,
    options
  );

  expect(batches).toEqual([["ambiguousTable"], ["ambiguousColumn"]]);
  expect(operations.map((operation) => operation.type)).toEqual([
    "renameTable",
    "renameColumn",
    "alterColumn",
  ]);
  expect(
    operations.filter((operation) =>
      [
        "dropPrimaryKey",
        "addPrimaryKey",
        "dropIndex",
        "createIndex",
        "dropUniqueConstraint",
        "addUniqueConstraint",
        "dropForeignKey",
        "addForeignKey",
      ].includes(operation.type)
    )
  ).toEqual([]);
});

it("canonicalizes a renamed PostgreSQL table against its live old name", async () => {
  const current: SchemaSnapshot = {
    tables: [
      table(
        "ledger_before",
        [
          { name: "id", type: "TEXT", nullable: false },
          { name: "active", type: "BOOLEAN", nullable: false },
        ],
        {
          indexes: [
            {
              name: "active_ledger",
              columns: ["id"],
              unique: false,
              where: "(active = true)",
            },
          ],
        }
      ),
    ],
  };
  const desired: SchemaSnapshot = {
    tables: [
      table("ledger_after", current.tables[0]!.columns, {
        indexes: [
          {
            name: "active_ledger",
            columns: ["id"],
            unique: false,
            where: "active = true",
          },
        ],
      }),
    ],
  };
  const canonicalizedTables: string[] = [];
  const options: DiffOptions = {
    canonicalizeIndexPredicate: (tableName, predicates) => {
      canonicalizedTables.push(tableName);
      return Promise.resolve(predicates.map(() => "active = true"));
    },
  };

  expect(
    await resolveAmbiguousChanges(
      await diff(current, desired, options),
      current,
      desired,
      alwaysRenameResolver,
      options
    )
  ).toEqual([
    { type: "renameTable", from: "ledger_before", to: "ledger_after" },
  ]);
  expect(canonicalizedTables).toEqual(["ledger_before"]);
});

it("normalizes a restored self-FK only while the forward rename is active", () => {
  const previous: SchemaSnapshot = {
    tables: [
      table("node", [{ name: "id", type: "TEXT", nullable: false }], {
        primaryKey: { columns: ["id"] },
        foreignKeys: [
          {
            name: "node_parent_fkey",
            columns: ["id"],
            referencedTable: "node",
            referencedColumns: ["id"],
          },
        ],
      }),
    ],
  };
  const replacement = {
    name: "item_parent_fkey",
    columns: ["uid"],
    referencedTable: "item",
    referencedColumns: ["uid"],
  };
  const renameTable = {
    type: "renameTable",
    from: "node",
    to: "item",
  } as const;
  const renameColumn = {
    type: "renameColumn",
    tableName: "item",
    from: "id",
    to: "uid",
  } as const;
  const drop = {
    type: "dropForeignKey",
    tableName: "item",
    fkName: "node_parent_fkey",
  } as const;
  const add = {
    type: "addForeignKey",
    tableName: "item",
    fk: replacement,
  } as const;
  // The sorter runs a key drop after its table's column renames, since a
  // derived key name follows its column (PostgreSQL)...
  expect(
    sortOperations([renameTable, renameColumn, drop, add]).map(
      (operation) => operation.type
    )
  ).toEqual(["renameTable", "renameColumn", "dropForeignKey", "addForeignKey"]);
  // ...and the inverse still restores a key dropped between two renames at
  // the identity of that exact prefix.
  const up: DiffOperation[] = [renameTable, drop, renameColumn, add];
  const down = invertOperations(up, previous).operations;
  const restored = down.find(
    (operation) =>
      operation.type === "addForeignKey" &&
      operation.fk.name === "node_parent_fkey"
  );
  expect(restored).toEqual({
    type: "addForeignKey",
    tableName: "item",
    fk: {
      name: "node_parent_fkey",
      columns: ["id"],
      referencedTable: "item",
      referencedColumns: ["id"],
    },
  });
  expect(down.map((operation) => operation.type)).toEqual([
    "dropForeignKey",
    "renameColumn",
    "addForeignKey",
    "renameTable",
  ]);
});

it("keeps an old FK target when its drop preceded the forward rename", () => {
  const previous: SchemaSnapshot = {
    tables: [
      table("parent", [{ name: "id", type: "TEXT", nullable: false }]),
      table("child", [{ name: "parent_id", type: "TEXT", nullable: false }], {
        foreignKeys: [
          {
            name: "child_parent_fkey",
            columns: ["parent_id"],
            referencedTable: "parent",
            referencedColumns: ["id"],
          },
        ],
      }),
    ],
  };
  const up = sortOperations([
    {
      type: "dropForeignKey",
      tableName: "child",
      fkName: "child_parent_fkey",
    },
    { type: "renameTable", from: "parent", to: "account" },
  ]);
  const restored = invertOperations(up, previous).operations.find(
    (operation) => operation.type === "addForeignKey"
  );

  expect(restored).toMatchObject({
    type: "addForeignKey",
    fk: { referencedTable: "parent" },
  });
});

it("treats PostgreSQL int4 and integer as one non-destructive type", () => {
  expect(
    isDestructiveOperation({
      type: "alterColumn",
      tableName: "ledger",
      columnName: "sequence",
      from: { name: "sequence", type: "int4", nullable: false },
      to: { name: "sequence", type: "integer", nullable: false },
    })
  ).toBe(false);
});

it("an add-and-drop answer re-diffs only its own table: the others stay as they were", async () => {
  const text = (name: string) => ({ name, type: "text", nullable: false });
  const current: SchemaSnapshot = {
    tables: [
      table("accounts", [text("id"), text("handle")]),
      table("teams", [text("id"), text("label")]),
    ],
  };
  const desired: SchemaSnapshot = {
    tables: [
      table("accounts", [text("id"), text("username")]),
      table("teams", [text("id"), text("label")]),
    ],
  };

  const operations = await resolveAmbiguousChanges(
    await diff(current, desired),
    current,
    desired,
    alwaysAddDropResolver
  );

  expect(operations).toEqual([
    { type: "dropColumn", tableName: "accounts", columnName: "handle" },
    { type: "addColumn", tableName: "accounts", column: text("username") },
  ]);
});

it("a resolver that leaves an ambiguous change unanswered is refused, naming it", async () => {
  const current: SchemaSnapshot = {
    tables: [
      table("accounts", [{ name: "handle", type: "text", nullable: false }]),
    ],
  };
  const desired: SchemaSnapshot = {
    tables: [
      table("accounts", [{ name: "username", type: "text", nullable: false }]),
    ],
  };
  const silent: Resolver = () => Promise.resolve(new Map());

  await expect(
    resolveAmbiguousChanges(
      await diff(current, desired),
      current,
      desired,
      silent
    )
  ).rejects.toMatchObject({
    code: VibORMErrorCode.MIGRATION_DESTRUCTIVE_REJECTED,
    message: expect.stringContaining("Missing resolution for"),
  });
});
