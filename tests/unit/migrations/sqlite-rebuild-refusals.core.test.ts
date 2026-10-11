/**
 * SQLite table recreations refuse instead of losing things (plan S11).
 *
 * A recreation copies the table into `__new_<t>`, drops the original and
 * renames the copy back. SQLite drops the original's triggers with it, and a
 * view or another table's trigger that reads it breaks the swap; a type change
 * that SQLite cannot convert exactly keeps the old value under the new type.
 * Each case runs against a populated table, because the losses only show with
 * data and a real program.
 */

import { createClient } from "@client/client";
import { VibORMErrorCode } from "@errors";
import { isMigrationError, lenientResolver } from "@migrations";
import { createMigrationClient } from "@migrations/client";
import { SQLite3MigrationDriver } from "@migrations/drivers/sqlite";
import { MemoryEstateStorage } from "@migrations/storage/memory";
import { s } from "@schema";
import { createInMemorySQLite3Driver } from "@tests/fixtures/drivers/sqlite3";
import { describe, expect, test } from "vitest";

const ROWS = 10_000;
const NAMES_ITEM_AUDIT = /"item_audit"/;
const NAMES_RENAMED_VIEW = /table "item", which view "item_labels" depends on/;
const ITEM_AUDIT = `CREATE TRIGGER "item_audit" AFTER UPDATE ON "item" BEGIN INSERT INTO "audit" ("id", "message") VALUES (NEW."id" || '-' || random(), 'updated'); END`;

type Change =
  | "nullable"
  | "int"
  | "float-to-int"
  | "int-to-string"
  | "number-to-string";

const weight = (change?: Change) => {
  if (change === "float-to-int") return s.int();
  if (change === "number-to-string") return s.string();
  return s.number();
};

const item = (change?: Change, table = "item") =>
  s
    .model({
      id: s.string().id(),
      sku: s.string().unique(),
      label: change === "nullable" ? s.string().nullable() : s.string(),
      qty: change === "int" ? s.int() : s.string(),
      status: s.enum(["draft", "active", "archived"]),
      price: change === "int-to-string" ? s.string() : s.int(),
      stock: s.int().default(0),
      attributes: s.json().nullable(),
      weight: weight(change),
      note: s.string().nullable(),
      createdAt: s.dateTime().now(),
      updatedAt: s.dateTime().updatedAt(),
    })
    .map(table);

const audit = s
  .model({ id: s.string().id(), message: s.string() })
  .map("audit");

const schema = (change?: Change, table?: string) => ({
  item: item(change, table),
  audit,
});

/**
 * A database at v1 holding ROWS items in `table` (`override` rewrites fields
 * of row `index`), the user's own `objects`, and v2 generated with `change`.
 */
async function populated(
  change: Change,
  {
    objects = [],
    override = () => ({}),
    table = "item",
  }: {
    objects?: string[];
    override?: (index: number) => object;
    table?: string;
  } = {}
) {
  const driver = createInMemorySQLite3Driver();
  const storage = new MemoryEstateStorage();
  const v1 = createClient({ schema: schema(undefined, table), driver });
  await createMigrationClient(v1, { storage }).generate({ name: "v1" });
  await createMigrationClient(v1, { storage }).apply();
  for (let start = 0; start < ROWS; start += 1000) {
    await v1.item.createMany({
      data: Array.from({ length: 1000 }, (_, offset) => {
        const index = start + offset;
        return {
          id: `item-${index}`,
          sku: `SKU-${index}`,
          label: `Item ${index}`,
          qty: String(index % 500),
          status: "active" as const,
          price: 100 + (index % 50),
          attributes: { color: "red" },
          weight: index % 7,
          ...override(index),
        };
      }),
    });
  }
  for (const statement of objects) await driver._executeRaw(statement);
  const v2 = createClient({ schema: schema(change, table), driver });
  const migrations = createMigrationClient(v2, { storage });
  await migrations.generate({ name: "v2", resolve: lenientResolver });
  const catalog = async () =>
    (
      await driver._executeRaw<{ object: string }>(
        `SELECT type || ':' || name AS object FROM sqlite_master WHERE type IN ('table', 'trigger', 'view') ORDER BY 1`
      )
    ).rows.map((row) => row.object);
  const storageClasses = async (column: string) =>
    (
      await driver._executeRaw<{ storage: string; count: number }>(
        `SELECT typeof("${column}") AS storage, count(*) AS count FROM "${table}" GROUP BY 1 ORDER BY 1`
      )
    ).rows;
  const labelRequired = async () =>
    (
      await driver._executeRaw<{ notnull: number }>(
        `SELECT "notnull" FROM pragma_table_info('${table}') WHERE name = 'label'`
      )
    ).rows[0]?.notnull === 1;
  return { driver, migrations, catalog, storageClasses, labelRequired };
}

/** The forward program `apply` would run, read without effects. */
async function program(
  migrations: Awaited<ReturnType<typeof populated>>["migrations"]
) {
  const { statements } = await migrations.apply({ dryRun: true });
  if (!statements.some((sql) => sql.includes('"__new_item"')))
    throw new Error("v2 was expected to rebuild the item table");
  return statements;
}

describe("SQLite recreation preflight", () => {
  test.each([
    {
      dependent: "item_audit",
      kind: "a trigger on the rebuilt table",
      sql: ITEM_AUDIT,
    },
    {
      dependent: "item_labels",
      kind: "a view over the rebuilt table",
      sql: `CREATE VIEW "item_labels" AS SELECT "id", "label" FROM "item"`,
    },
    {
      dependent: "audit_touches_item",
      kind: "another table's trigger that writes the rebuilt table",
      sql: `CREATE TRIGGER "audit_touches_item" AFTER INSERT ON "audit" BEGIN UPDATE "item" SET "stock" = "stock" + 1 WHERE "id" = NEW."message"; END`,
    },
  ])("apply refuses $kind by name before effects", async ({
    dependent,
    sql,
  }) => {
    const { migrations, catalog, labelRequired } = await populated("nullable", {
      objects: [sql],
    });
    const before = await catalog();

    const refusal = migrations.apply();

    await expect(refusal).rejects.toSatisfy(isMigrationError);
    await expect(refusal).rejects.toMatchObject({
      code: VibORMErrorCode.MIGRATION_INVALID_STATE,
      message: expect.stringMatching(
        new RegExp(
          `table "item", which (trigger|view) "${dependent}" depends on`
        )
      ),
    });
    expect(await catalog()).toEqual(before);
    expect(await labelRequired()).toBe(true);
  });

  test("admits a rebuild whose program drops its dependents, in any spelling, and objects that only quote the name", async () => {
    const { driver, migrations } = await populated("nullable", {
      objects: [
        `CREATE TRIGGER "audit_stamp" AFTER INSERT ON "audit" BEGIN UPDATE "audit" SET "message" = 'item' WHERE "id" = NEW."id"; END`,
        `CREATE VIEW "audit_messages" AS SELECT "message" AS "label" FROM "audit" -- not "item"`,
        `CREATE TRIGGER "item_audit" AFTER UPDATE ON "item" BEGIN SELECT 1; END`,
      ],
    });
    const statements = await program(migrations);
    const preflight = (sql: readonly string[]) =>
      new SQLite3MigrationDriver().preflightSchemaRequirements(
        [],
        (text, params) => driver._executeRaw(text, params),
        sql
      );

    await expect(preflight(statements)).rejects.toThrow(NAMES_ITEM_AUDIT);
    for (const drop of [
      'DROP TRIGGER IF EXISTS "item_audit"',
      '-- released for v2\nDROP TRIGGER main."item_audit"',
      "/* v2 */ DROP TRIGGER [main] . item_audit",
    ]) {
      await expect(preflight([drop, ...statements])).resolves.toBeUndefined();
    }
  });

  test("reads a bare reserved word as a keyword, not as the table spelled like it", async () => {
    const unrelated = await populated("nullable", {
      table: "order",
      objects: [
        `CREATE VIEW "recent_audit" AS SELECT "id" FROM "audit" ORDER BY "id" DESC LIMIT 10`,
        `CREATE VIEW "messages" AS SELECT "message", count(*) AS "n" FROM "audit" GROUP BY "message"`,
      ],
    });
    await expect(unrelated.migrations.apply()).resolves.toMatchObject({
      outcome: "applied",
    });
    expect(await unrelated.labelRequired()).toBe(false);
    expect(await unrelated.catalog()).toContain("view:recent_audit");

    const reading = await populated("nullable", {
      table: "order",
      objects: [
        `CREATE VIEW "order_labels" AS SELECT "label" FROM "order" ORDER BY "label"`,
      ],
    });
    await expect(reading.migrations.apply()).rejects.toThrow(
      'table "order", which view "order_labels" depends on'
    );
    expect(await reading.labelRequired()).toBe(true);
  });

  test("walks the program in order: a dependent created earlier is lost, even behind a comment, and one dropped later is not released", async () => {
    const { driver, migrations } = await populated("nullable");
    const statements = await program(migrations);
    const preflight = (sql: readonly string[]) =>
      new SQLite3MigrationDriver().preflightSchemaRequirements(
        [],
        (text, params) => driver._executeRaw(text, params),
        sql
      );

    await expect(preflight([ITEM_AUDIT, ...statements])).rejects.toThrow(
      NAMES_ITEM_AUDIT
    );
    await expect(
      preflight([`-- audit every edit\n/* v3 */ ${ITEM_AUDIT}`, ...statements])
    ).rejects.toThrow(NAMES_ITEM_AUDIT);
    await driver._executeRaw(ITEM_AUDIT);
    await expect(
      preflight([...statements, 'DROP TRIGGER IF EXISTS "item_audit"'])
    ).rejects.toThrow(NAMES_ITEM_AUDIT);
  });

  test("follows a native rename to the live table a later rebuild drops", async () => {
    const { driver } = await populated("nullable", {
      objects: [`CREATE VIEW "item_labels" AS SELECT "label" FROM "item"`],
    });
    const refusal = new SQLite3MigrationDriver().preflightSchemaRequirements(
      [],
      (text, params) => driver._executeRaw(text, params),
      [
        'ALTER TABLE "item" RENAME TO "Product"',
        "PRAGMA foreign_keys=OFF",
        'CREATE TABLE "__new_product" ("id" TEXT PRIMARY KEY)',
        'INSERT INTO "__new_product" ("id") SELECT "id" FROM "product"',
        'DROP TABLE "product"',
        'ALTER TABLE "__new_product" RENAME TO "product"',
        "PRAGMA foreign_keys=ON",
      ]
    );
    await expect(refusal).rejects.toThrow(NAMES_RENAMED_VIEW);
  });
});

describe("SQLite recreation type conversion", () => {
  test.each([
    { change: "int" as const, column: "qty", badRow: { qty: "twelve" } },
    { change: "int" as const, column: "qty", badRow: { qty: "1.5" } },
    {
      change: "float-to-int" as const,
      column: "weight",
      badRow: { weight: 2.5 },
    },
  ])("refuses $column = $badRow inside the rebuild and keeps every row", async ({
    change,
    column,
    badRow,
  }) => {
    const { migrations, storageClasses } = await populated(change, {
      override: (index) => (index === ROWS - 1 ? badRow : {}),
    });
    const before = await storageClasses(column);

    await expect(migrations.apply()).rejects.toMatchObject({
      code: VibORMErrorCode.MIGRATION_FAILED,
      cause: expect.objectContaining({
        code: VibORMErrorCode.QUERY_OUT_OF_RANGE,
      }),
    });

    expect(await storageClasses(column)).toEqual(before);
  });

  test.each([
    {
      change: "int-to-string" as const,
      column: "price",
      value: (index: number) => 100 + (index % 50),
    },
    {
      change: "number-to-string" as const,
      column: "weight",
      value: (index: number) => index / 3 + (0.1 + 0.2),
    },
  ])("converts every $column into exact TEXT ($change)", async ({
    change,
    column,
    value,
  }) => {
    const { driver, migrations, storageClasses } = await populated(change, {
      override: (index) => ({ [column]: value(index) }),
    });

    await expect(migrations.apply()).resolves.toMatchObject({
      outcome: "applied",
    });
    expect(await storageClasses(column)).toEqual([
      { storage: "text", count: ROWS },
    ]);
    const rows = await driver._executeRaw<{ id: string; text: string }>(
      `SELECT "id", "${column}" AS "text" FROM "item"`
    );
    const inexact = rows.rows.filter(
      (row) => Number(row.text) !== value(Number(row.id.slice("item-".length)))
    );
    expect(inexact).toEqual([]);
  });

  test("converts an all-numeric TEXT column into INTEGER storage", async () => {
    const { migrations, storageClasses } = await populated("int");

    await expect(migrations.apply()).resolves.toMatchObject({
      outcome: "applied",
    });
    expect(await storageClasses("qty")).toEqual([
      { storage: "integer", count: ROWS },
    ]);
  });
});
