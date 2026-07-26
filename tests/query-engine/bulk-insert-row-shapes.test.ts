import { createClient } from "@client/client";
import { PGliteDriver } from "@drivers/pglite";
import type { BatchQuery, QueryResult } from "@drivers/types";
import type { PGlite, Transaction } from "@electric-sql/pglite";
import { push } from "@migrations";
import { s } from "@schema";
import { afterEach, describe, expect, test } from "vitest";

const parent = s
  .model({
    id: s.int().id().increment(),
    name: s.string(),
    children: s.oneToMany(() => child),
  })
  .map("bulk_shape_parents");

const child = s
  .model({
    id: s.int().id().increment(),
    code: s.string().unique(),
    label: s.string(),
    parentId: s.int(),
    parent: s
      .manyToOne(() => parent)
      .fields("parentId")
      .references("id"),
  })
  .map("bulk_shape_children");

const defaultChild = s
  .model({
    id: s.int().id().increment(),
    parents: s.oneToMany(() => defaultParent),
  })
  .map("bulk_shape_default_children");

const defaultParent = s
  .model({
    id: s.string().id(),
    childId: s.int(),
    child: s
      .manyToOne(() => defaultChild)
      .fields("childId")
      .references("id"),
  })
  .map("bulk_shape_default_parents");

const batchRow = s
  .model({
    id: s.int().id().increment(),
    code: s.string().unique(),
    label: s.string(),
  })
  .map("bulk_shape_batch_rows");

let defaultFactoryCalls = 0;

const factoryRow = s
  .model({
    id: s.string().id(),
    value: s.string().default(() => `value-${++defaultFactoryCalls}`),
  })
  .map("bulk_shape_factory_rows");

const schema = {
  parent,
  child,
  defaultChild,
  defaultParent,
  batchRow,
  factoryRow,
};

class BatchOnlyPGliteDriver extends PGliteDriver {
  override readonly supportsTransactions = false;
  override readonly supportsBatch = true;
  readonly batchSizes: number[] = [];

  protected override async executeBatch<T>(
    client: PGlite | Transaction,
    queries: BatchQuery[]
  ): Promise<QueryResult<T>[]> {
    this.batchSizes.push(queries.length);
    return this.transaction(client, async (tx) => {
      const results: QueryResult<T>[] = [];
      for (const query of queries) {
        results.push(await this.executeRaw<T>(tx, query.sql, query.params));
      }
      return results;
    });
  }
}

class NoAtomicPGliteDriver extends PGliteDriver {
  override supportsTransactions = true;
  override supportsBatch = false;

  disableAtomicExecution(): void {
    this.supportsTransactions = false;
  }
}

const clients: Array<{ $disconnect(): Promise<void> }> = [];

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.$disconnect()));
});

describe("bulk insert row shapes", () => {
  test("nested createMany preserves generated values and conflict input order", async () => {
    const client = createClient({ schema, driver: new PGliteDriver() });
    clients.push(client);
    await push(client, { force: true });

    const createdParent = await client.parent.create({
      data: {
        name: "parent",
        children: {
          createMany: {
            data: [
              { code: "unrelated", label: "generated-first" },
              { id: 50, code: "winner", label: "input-first" },
              { code: "winner", label: "must-skip" },
            ],
            skipDuplicates: true,
          },
        },
      },
    });

    const children = await client.child.findMany({
      where: { parentId: createdParent.id },
      orderBy: { id: "asc" },
    });
    expect(children).toHaveLength(2);
    expect(children.find((row) => row.code === "winner")).toMatchObject({
      id: 50,
      label: "input-first",
    });
    expect(children.every((row) => row.id !== 0)).toBe(true);
  });

  test("nested grouped insert failure rolls back the parent and every group", async () => {
    const client = createClient({ schema, driver: new PGliteDriver() });
    clients.push(client);
    await push(client, { force: true });

    await expect(
      client.parent.create({
        data: {
          name: "rollback",
          children: {
            createMany: {
              data: [
                { id: 10, code: "first", label: "first" },
                { code: "generated", label: "generated" },
                { id: 10, code: "duplicate-id", label: "failure" },
              ],
            },
          },
        },
      })
    ).rejects.toThrow();

    expect(await client.parent.count()).toBe(0);
    expect(await client.child.count()).toBe(0);
  });

  test("nested default-only create uses the adapter default-row primitive", async () => {
    const client = createClient({ schema, driver: new PGliteDriver() });
    clients.push(client);
    await push(client, { force: true });

    await client.defaultParent.create({
      data: { id: "parent", child: { create: {} } },
    });

    const created = await client.defaultChild.findMany();
    const createdParent = await client.defaultParent.findUnique({
      where: { id: "parent" },
    });
    expect(created).toHaveLength(1);
    expect(created[0]?.id).toBeGreaterThan(0);
    expect(createdParent?.childId).toBe(created[0]?.id);
  });

  test("nested explicit zero rejects before the parent is written", async () => {
    const client = createClient({ schema, driver: new PGliteDriver() });
    clients.push(client);
    await push(client, { force: true });

    await expect(
      client.parent.create({
        data: {
          name: "must-not-write",
          children: {
            createMany: {
              data: [{ id: 0, code: "zero", label: "zero" }],
            },
          },
        },
      })
    ).rejects.toThrow("Explicit zero");
    expect(await client.parent.count()).toBe(0);
  });

  test("batch-only transaction arrays execute every shape and parse one logical result", async () => {
    const driver = new BatchOnlyPGliteDriver();
    const client = createClient({ schema, driver });
    clients.push(client);
    await push(client, { force: true });
    driver.batchSizes.length = 0;

    const [created] = await client.$transaction([
      client.batchRow.createMany({
        data: [
          { code: "generated-1", label: "first" },
          { id: 50, code: "explicit", label: "second" },
          { code: "generated-2", label: "third" },
        ],
        select: { id: true, code: true, label: true },
      }),
    ]);

    expect(created.map((row) => row.label)).toEqual([
      "first",
      "second",
      "third",
    ]);
    expect(created[1]?.id).toBe(50);
    expect(driver.batchSizes).toEqual([3]);
  });

  test("batch-only preparation evaluates application defaults once per row", async () => {
    const driver = new BatchOnlyPGliteDriver();
    const client = createClient({ schema, driver });
    clients.push(client);
    await push(client, { force: true });
    defaultFactoryCalls = 0;

    const [result] = await client.$transaction([
      client.factoryRow.createMany({
        data: [{ id: "first" }, { id: "second" }],
      }),
    ]);

    expect(result.count).toBe(2);
    expect(defaultFactoryCalls).toBe(2);
    const rows = await client.factoryRow.findMany({ orderBy: { id: "asc" } });
    expect(rows.map((row) => row.value)).toEqual(["value-1", "value-2"]);
  });

  test("empty top-level createMany rejects consistently in batch preparation", async () => {
    const driver = new BatchOnlyPGliteDriver();
    const client = createClient({ schema, driver });
    clients.push(client);
    await push(client, { force: true });

    await expect(
      client.$transaction([client.batchRow.createMany({ data: [] })])
    ).rejects.toThrow("No data to insert");
    expect(await client.batchRow.count()).toBe(0);
  });

  test("batch-only grouped failure is atomic", async () => {
    const driver = new BatchOnlyPGliteDriver();
    const client = createClient({ schema, driver });
    clients.push(client);
    await push(client, { force: true });

    await expect(
      client.$transaction([
        client.batchRow.createMany({
          data: [
            { code: "duplicate", label: "first" },
            { id: 50, code: "middle", label: "middle" },
            { code: "duplicate", label: "failure" },
          ],
        }),
      ])
    ).rejects.toThrow();
    expect(await client.batchRow.count()).toBe(0);
  });

  test("a driver without an atomic substrate rejects all groups before mutation", async () => {
    const driver = new NoAtomicPGliteDriver();
    const client = createClient({ schema, driver });
    clients.push(client);
    await push(client, { force: true });
    driver.disableAtomicExecution();

    await expect(
      client.batchRow.createMany({
        data: [
          { code: "generated", label: "first" },
          { id: 50, code: "explicit", label: "second" },
        ],
      })
    ).rejects.toThrow("neither transactions nor atomic batch execution");
    expect(await client.batchRow.count()).toBe(0);
  });

  test("a returning driver without atomic execution rejects multi-row returns before mutation", async () => {
    const driver = new NoAtomicPGliteDriver();
    const client = createClient({ schema, driver });
    clients.push(client);
    await push(client, { force: true });
    driver.disableAtomicExecution();

    await expect(
      client.batchRow.createMany({
        data: [
          { code: "first", label: "first" },
          { code: "second", label: "second" },
        ],
        select: { id: true },
      })
    ).rejects.toThrow("neither transactions nor atomic batch execution");
    expect(await client.batchRow.count()).toBe(0);
  });
});
