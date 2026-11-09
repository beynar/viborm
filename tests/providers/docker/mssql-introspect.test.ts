/**
 * SQL Server introspection round trip: a schema pushed by the test-only T-SQL
 * fixture (`tests/fixtures/mssql-schema.ts`) introspects back to the snapshot
 * the serializer produces for SQL Server. Set MSSQL_TEST_CONNECTION_STRING to
 * run the live cells.
 */

import { createClient } from "@client/client";
import type { Schema } from "@client/types";
import { MssqlDriver } from "@drivers/mssql";
import { getMigrationDriver } from "@migrations/drivers";
import { mssqlMigrationDriver } from "@migrations/drivers/mssql";
import { serializeModels } from "@migrations/serializer";
import type { SchemaSnapshot } from "@migrations/types";
import { s } from "@schema";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from "vitest";
import {
  createMssqlDriver,
  dropEveryLiveTable,
  TEST_CONNECTION_STRING,
} from "./mssql-fixtures";

const describeIf = TEST_CONNECTION_STRING ? describe : describe.skip;

const account = s
  .model({
    id: s.string().id().ulid(),
    email: s.string().unique(),
    name: s.string().default("it's (anonymous)"),
    age: s.int().nullable(),
    score: s.number().default(1.5),
    balance: s.decimal({ precision: 12, scale: 2 }).default("10.5"),
    active: s.boolean().default(true),
    joinedAt: s.dateTime().default(new Date("2024-01-02T03:04:05.678Z")),
    birthday: s.date().nullable(),
    wakeAt: s.time().nullable(),
    visits: s.bigInt().default(9_007_199_254_740_993n),
    settings: s.json().nullable(),
    avatar: s.blob().nullable(),
    role: s.enum(["admin", "member"]).default("member"),
    tags: s.string().array(),
    lucky: s.int().array(),
    weights: s.decimal({ precision: 6, scale: 3 }).array(),
    roles: s.enum(["admin", "member"]).array(),
    tenant: s.string(),
    handle: s.string(),
    posts: s.toMany(() => post),
    groups: s.toMany(() => group),
  })
  .unique(["tenant", "handle"])
  .index(["name", "age"])
  .map("intro_accounts");

const post = s
  .model({
    id: s.int().id().increment(),
    title: s.string(),
    authorId: s.string(),
    author: s
      .toOne(() => account)
      .fields("authorId")
      .references("id")
      .onDelete("cascade"),
  })
  .index(["title"], { name: "intro_posts_title", unique: true })
  .map("intro_posts");

const group = s
  .model({
    id: s.bigInt().id().increment(),
    name: s.string(),
    members: s.toMany(() => account),
  })
  .map("intro_groups");

const line = s
  .model({
    orderId: s.string(),
    position: s.int(),
    note: s.string().nullable(),
  })
  .id(["orderId", "position"])
  .map("intro_lines");

// A nullable reference defaults to SET NULL, which SQL Server refuses on a
// self-reference ("cycles or multiple cascade paths"): the fixture falls back
// to NO ACTION.
const node = s
  .model({
    id: s.string().id(),
    parentId: s.string().nullable(),
    parent: s
      .toOne(() => node)
      .fields("parentId")
      .references("id"),
    children: s.toMany(() => node),
  })
  .map("intro_nodes");

const schema = { account, post, group, line };

/**
 * One order for both sides, and the spellings the differ already treats as
 * equal (`differ.ts`: an undeclared index type is a B-tree, an undeclared
 * `unique` is false, an undeclared action is NO ACTION).
 */
function normalize(snapshot: SchemaSnapshot): unknown {
  const byName = <T extends { name: string }>(items: readonly T[]) =>
    [...items].sort((a, b) => a.name.localeCompare(b.name));
  return byName(snapshot.tables).map((table) => ({
    ...table,
    // A generated junction declares no key name; the DDL gives it this one.
    primaryKey: table.primaryKey && {
      ...table.primaryKey,
      name: mssqlMigrationDriver.generatedPrimaryKeyName(
        table.name,
        table.primaryKey.name
      ),
    },
    columns: table.columns.map((column) =>
      JSON.parse(
        JSON.stringify({
          ...column,
          autoIncrement: column.autoIncrement ?? false,
        })
      )
    ),
    indexes: byName(table.indexes).map((index) => ({
      ...index,
      unique: index.unique ?? false,
      type: index.type ?? "btree",
      where: index.where ?? undefined,
    })),
    uniqueConstraints: byName(table.uniqueConstraints),
    foreignKeys: byName(table.foreignKeys).map((key) => ({
      ...key,
      onDelete: key.onDelete ?? "noAction",
      onUpdate: key.onUpdate ?? "noAction",
    })),
  }));
}

test("every DDL generator refuses through the one SQL Server statement", () => {
  expect(() => mssqlMigrationDriver.generateCreateTable()).toThrow(
    "VibORM queries SQL Server and introspects its schema, but generates and applies no DDL for it."
  );
  expect(() => mssqlMigrationDriver.generateAcquireLock()).toThrow(
    "generates and applies no DDL"
  );
});

describeIf("SQL Server introspection", () => {
  const open: MssqlDriver[] = [];
  beforeEach(dropEveryLiveTable);
  afterEach(async () => {
    for (const driver of open.splice(0)) await driver.disconnect();
  });
  afterAll(dropEveryLiveTable);

  async function introspected(models: Schema) {
    const driver = createMssqlDriver();
    open.push(driver);
    const client = createClient({ schema: models, driver });
    const pushed = await syncLiveSchema(client);
    const migrationDriver = getMigrationDriver(driver);
    const live = await migrationDriver.introspect((sql, params) =>
      driver._executeRaw(sql, params)
    );
    const desired = serializeModels(client.$schema, { migrationDriver });
    return { client, pushed, live, desired };
  }

  test("introspects back the serializer's snapshot", async () => {
    const { live, desired } = await introspected(schema);

    // The one fact the catalog cannot hold: a decimal LIST is JSON text, so
    // its declared precision and scale exist only on the desired side.
    const weights = (snapshot: SchemaSnapshot) =>
      snapshot.tables
        .find((table) => table.name === "intro_accounts")
        ?.columns.find((column) => column.name === "weights");
    expect(weights(desired)?.decimal).toEqual({ precision: 6, scale: 3 });
    expect(weights(live)?.decimal).toBeUndefined();
    const withoutListDescriptor: SchemaSnapshot = {
      ...desired,
      tables: desired.tables.map((table) => ({
        ...table,
        columns: table.columns.map((column) =>
          column.name === "weights" ? { ...column, decimal: undefined } : column
        ),
      })),
    };

    expect(normalize(live)).toEqual(normalize(withoutListDescriptor));

    const accounts = live.tables.find((t) => t.name === "intro_accounts");
    const columns = new Map(accounts?.columns.map((c) => [c.name, c]));
    expect(columns.get("id")?.type).toBe("NVARCHAR(450)");
    // `name` leads an index, so it is keyed; `tags` is not.
    expect(columns.get("name")).toMatchObject({
      type: "NVARCHAR(450)",
      default: "N'it''s (anonymous)'",
    });
    expect(columns.get("tags")?.type).toBe("NVARCHAR(MAX)");
    expect(columns.get("visits")?.default).toBe("9007199254740993");
    expect(
      live.tables.find((t) => t.name === "intro_posts")?.columns[0]
    ).toMatchObject({ name: "id", type: "INT", autoIncrement: true });
  });

  test("a refused cascade path keeps its key, with NO ACTION", async () => {
    const { live } = await introspected({ node });
    const [key] = live.tables[0]?.foreignKeys ?? [];
    expect(key).toMatchObject({
      name: "intro_nodes_parentId_fkey",
      onDelete: "noAction",
      onUpdate: "noAction",
    });
  });

  test("a second push of the same schema changes nothing", async () => {
    const { client, pushed } = await introspected({ ...schema, node });
    expect(pushed.applied).toBe(true);
    const second = await syncLiveSchema(client);
    expect(second.operations).toEqual([]);
    expect(second.sql).toEqual([]);
  });

  test("an absent schema is refused, never read as an empty one", async () => {
    const driver = new MssqlDriver({
      databaseUrl: TEST_CONNECTION_STRING,
      namespace: "viborm_absent_schema",
    });
    open.push(driver);
    await expect(
      getMigrationDriver(driver).introspect((sql, params) =>
        driver._executeRaw(sql, params)
      )
    ).rejects.toThrow(
      'SQL Server schema "viborm_absent_schema" does not exist'
    );
  });
});
