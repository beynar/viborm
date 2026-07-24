import { createClient } from "@client/client";
import type { AnyDriver } from "@drivers";
import { push } from "@migrations";
import { createOperationExecutionContext } from "@query-engine/execution-context";
import { createModelRegistry, QueryEngine } from "@query-engine/query-engine";
import { s } from "@schema";
import type { Model } from "@schema/model";
import { createSchemaRegistry } from "@validation";
import { describe, expect, test } from "vitest";
import { BulkCountOperation } from "../../src/query-engine-v2/BulkCountOperation";
import { ManyAndReturnOperation } from "../../src/query-engine-v2/ManyAndReturnOperation";
import { OperationExecutor } from "../../src/query-engine-v2/OperationExecutor";

/**
 * The P4 write stragglers across the driver matrix: root `updateMany`/`deleteMany`
 * returning `{ count }` (BulkCountOperation) and `createManyAndReturn`/
 * `updateManyAndReturn` returning the affected rows (ManyAndReturnOperation).
 * The AndReturn schema carries a string-PK model and an increment-PK model so the
 * non-returning refetch (MySQL) exercises both the provided-identity and
 * `lastInsertId()` paths of the mutation-identity technique.
 */
export const bulkWriteSchema = (() => {
  const gadget = s
    .model({
      id: s.string().id(),
      code: s.string().unique(),
      name: s.string(),
      qty: s.int().default(0),
    })
    .map("bulk_v2_gadgets");

  const ticket = s
    .model({
      id: s.int().id().increment(),
      label: s.string(),
    })
    .map("bulk_v2_tickets");

  return { gadget, ticket };
})();

type BulkModel = keyof typeof bulkWriteSchema;

function runners(driver: AnyDriver) {
  const schemas = createSchemaRegistry(bulkWriteSchema);
  const engine = new QueryEngine(
    driver,
    createModelRegistry(bulkWriteSchema, schemas)
  );
  const executor = new OperationExecutor(engine);
  const bulkCount = (
    modelName: BulkModel,
    kind: "updateMany" | "deleteMany",
    args: Record<string, unknown>
  ) =>
    executor.execute(
      new BulkCountOperation(
        engine,
        bulkWriteSchema[modelName] as Model<any>,
        kind,
        args
      ),
      createOperationExecutionContext(modelName, kind, engine.instrumentation)
    );
  const andReturn = (
    modelName: BulkModel,
    kind: "createManyAndReturn" | "updateManyAndReturn",
    args: Record<string, unknown>
  ) =>
    executor.execute(
      new ManyAndReturnOperation(
        engine,
        bulkWriteSchema[modelName] as Model<any>,
        kind,
        args
      ),
      createOperationExecutionContext(modelName, kind, engine.instrumentation)
    );
  return { bulkCount, andReturn };
}

export function runBulkWriteBehavior(options: {
  readonly name: string;
  readonly createDriver: () => AnyDriver;
  readonly createStateDriver?: () => AnyDriver;
}): void {
  describe(`${options.name} bulk-write stragglers`, () => {
    const setup = async () => {
      const driver = options.createDriver();
      const stateDriver = options.createStateDriver?.() ?? driver;
      const client = createClient({
        schema: bulkWriteSchema,
        driver: stateDriver,
      });
      await push(client, { force: true });
      const dispose = async () => {
        await client.$disconnect();
        if (driver !== stateDriver) await driver.disconnect();
      };
      return { client, dispose, ...runners(driver) };
    };

    const seedGadgets = async (
      client: Awaited<ReturnType<typeof setup>>["client"]
    ) => {
      await client.gadget.createMany({
        data: [
          { id: "g1", code: "c1", name: "Alpha", qty: 1 },
          { id: "g2", code: "c2", name: "Beta", qty: 2 },
          { id: "g3", code: "c3", name: "Gamma", qty: 10 },
        ],
      });
    };

    test(
      "updateMany returns the affected count",
      { timeout: 30_000 },
      async () => {
        const { client, dispose, bulkCount } = await setup();
        try {
          await seedGadgets(client);
          const result = await bulkCount("gadget", "updateMany", {
            where: { qty: { lt: 5 } },
            data: { name: "Updated" },
          });
          expect(result).toEqual({ count: 2 });
          const rows = await client.gadget.findMany({ orderBy: { id: "asc" } });
          expect(rows.map((r) => r.name)).toEqual([
            "Updated",
            "Updated",
            "Gamma",
          ]);
        } finally {
          await dispose();
        }
      }
    );

    test(
      "updateMany with an atomic increment",
      { timeout: 30_000 },
      async () => {
        const { client, dispose, bulkCount } = await setup();
        try {
          await seedGadgets(client);
          const result = await bulkCount("gadget", "updateMany", {
            data: { qty: { increment: 5 } },
          });
          expect(result).toEqual({ count: 3 });
          const rows = await client.gadget.findMany({ orderBy: { id: "asc" } });
          expect(rows.map((r) => r.qty)).toEqual([6, 7, 15]);
        } finally {
          await dispose();
        }
      }
    );

    test(
      "updateMany matching nothing returns count 0",
      { timeout: 30_000 },
      async () => {
        const { client, dispose, bulkCount } = await setup();
        try {
          await seedGadgets(client);
          const result = await bulkCount("gadget", "updateMany", {
            where: { name: "Nope" },
            data: { name: "x" },
          });
          expect(result).toEqual({ count: 0 });
        } finally {
          await dispose();
        }
      }
    );

    test(
      "deleteMany returns the affected count",
      { timeout: 30_000 },
      async () => {
        const { client, dispose, bulkCount } = await setup();
        try {
          await seedGadgets(client);
          const result = await bulkCount("gadget", "deleteMany", {
            where: { qty: { lt: 5 } },
          });
          expect(result).toEqual({ count: 2 });
          expect(await client.gadget.findMany()).toHaveLength(1);
        } finally {
          await dispose();
        }
      }
    );

    test(
      "deleteMany all returns the total count",
      { timeout: 30_000 },
      async () => {
        const { client, dispose, bulkCount } = await setup();
        try {
          await seedGadgets(client);
          const result = await bulkCount("gadget", "deleteMany", {});
          expect(result).toEqual({ count: 3 });
          expect(await client.gadget.findMany()).toEqual([]);
        } finally {
          await dispose();
        }
      }
    );

    test(
      "createManyAndReturn returns the created rows",
      { timeout: 30_000 },
      async () => {
        const { client, dispose, andReturn } = await setup();
        try {
          const rows = (await andReturn("gadget", "createManyAndReturn", {
            data: [
              { id: "g1", code: "c1", name: "Alpha" },
              { id: "g2", code: "c2", name: "Beta", qty: 5 },
            ],
          })) as Record<string, unknown>[];
          expect(rows).toHaveLength(2);
          const byId = new Map(rows.map((r) => [r.id, r]));
          expect(byId.get("g1")).toMatchObject({
            id: "g1",
            name: "Alpha",
            qty: 0,
          });
          expect(byId.get("g2")).toMatchObject({ id: "g2", qty: 5 });
          expect(await client.gadget.findMany()).toHaveLength(2);
        } finally {
          await dispose();
        }
      }
    );

    test(
      "createManyAndReturn with select projects fields",
      { timeout: 30_000 },
      async () => {
        const { dispose, andReturn } = await setup();
        try {
          const rows = (await andReturn("gadget", "createManyAndReturn", {
            data: [
              { id: "g1", code: "c1", name: "Alpha" },
              { id: "g2", code: "c2", name: "Beta" },
            ],
            select: { name: true },
          })) as Record<string, unknown>[];
          expect(rows).toHaveLength(2);
          for (const row of rows) {
            expect(Object.keys(row)).toEqual(["name"]);
          }
          expect(rows.map((r) => r.name).sort()).toEqual(["Alpha", "Beta"]);
        } finally {
          await dispose();
        }
      }
    );

    test(
      "createManyAndReturn assigns and returns increment ids in input order",
      { timeout: 30_000 },
      async () => {
        const { dispose, andReturn } = await setup();
        try {
          const rows = (await andReturn("ticket", "createManyAndReturn", {
            data: [{ label: "one" }, { label: "two" }, { label: "three" }],
          })) as Record<string, unknown>[];
          expect(rows.map((r) => r.label)).toEqual(["one", "two", "three"]);
          expect(new Set(rows.map((r) => r.id)).size).toBe(3);
          for (const row of rows) {
            expect(typeof row.id).toBe("number");
          }
        } finally {
          await dispose();
        }
      }
    );

    test(
      "createManyAndReturn empty data returns []",
      { timeout: 30_000 },
      async () => {
        const { dispose, andReturn } = await setup();
        try {
          const rows = await andReturn("gadget", "createManyAndReturn", {
            data: [],
          });
          expect(rows).toEqual([]);
        } finally {
          await dispose();
        }
      }
    );

    test(
      "updateManyAndReturn returns the updated rows",
      { timeout: 30_000 },
      async () => {
        const { dispose, andReturn } = await setup();
        try {
          await andReturn("gadget", "createManyAndReturn", {
            data: [
              { id: "g1", code: "c1", name: "Alpha", qty: 1 },
              { id: "g2", code: "c2", name: "Beta", qty: 2 },
              { id: "g3", code: "c3", name: "Gamma", qty: 10 },
            ],
          });
          const rows = (await andReturn("gadget", "updateManyAndReturn", {
            where: { qty: { lt: 5 } },
            data: { qty: { increment: 100 } },
            select: { id: true, qty: true },
          })) as Record<string, unknown>[];
          expect(rows).toHaveLength(2);
          const byId = new Map(rows.map((r) => [r.id, r.qty]));
          expect(byId.get("g1")).toBe(101);
          expect(byId.get("g2")).toBe(102);
          for (const row of rows) {
            expect(Object.keys(row).sort()).toEqual(["id", "qty"]);
          }
        } finally {
          await dispose();
        }
      }
    );

    test(
      "updateManyAndReturn with a PK-mutating increment returns post-update ids",
      { timeout: 30_000 },
      async () => {
        const { client, dispose, andReturn } = await setup();
        try {
          await andReturn("ticket", "createManyAndReturn", {
            data: [{ label: "one" }, { label: "two" }, { label: "three" }],
          });
          // Fresh table: increment ids are 1, 2, 3. The non-returning refetch
          // must locate rows by their POST-update PKs (the DerivedValue
          // arithmetic, getUpdatedPrimaryKeyValues) — a before-image WHERE
          // would return [].
          const rows = (await andReturn("ticket", "updateManyAndReturn", {
            where: { id: { gt: 1 } },
            data: { id: { increment: 100 } },
          })) as Record<string, unknown>[];
          expect(
            rows
              .map((r) => [r.id, r.label])
              .sort((a, b) => (a[0] as number) - (b[0] as number))
          ).toEqual([
            [102, "two"],
            [103, "three"],
          ]);
          const finals = await client.ticket.findMany({
            orderBy: { id: "asc" },
          });
          expect(finals.map((r) => r.id)).toEqual([1, 102, 103]);
        } finally {
          await dispose();
        }
      }
    );

    test(
      "updateManyAndReturn matching nothing returns []",
      { timeout: 30_000 },
      async () => {
        const { dispose, andReturn } = await setup();
        try {
          await andReturn("gadget", "createManyAndReturn", {
            data: [{ id: "g1", code: "c1", name: "Alpha" }],
          });
          const rows = await andReturn("gadget", "updateManyAndReturn", {
            where: { name: "Nope" },
            data: { qty: 99 },
          });
          expect(rows).toEqual([]);
        } finally {
          await dispose();
        }
      }
    );
  });
}
