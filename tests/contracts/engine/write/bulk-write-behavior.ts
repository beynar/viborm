import type { AnyDriver } from "@drivers";
import { createOperationExecutionContext } from "@query-engine/execution-context";
import { createModelRegistry, QueryEngine } from "@query-engine/query-engine";
import { s } from "@schema";
import type { Model } from "@schema/model";
import { OperationExecutor } from "@src/query-engine/write-engine/OperationExecutor";
import { constructRoutedOperation } from "@src/query-engine/write-engine/routing";
import {
  type BehaviorDatabaseSource,
  useBehaviorDatabase,
} from "@tests/fixtures/drivers/pglite";
import { createSchemaRegistry } from "@validation";
import { describe, expect, test } from "vitest";

/**
 * The P4 write stragglers across the driver matrix, exercised through the SAME
 * routing seam the client uses (`constructRoutedOperation`) so the implicit
 * discriminant is under test too, not just the machinery behind it:
 *
 *  - `updateMany` / `deleteMany` WITHOUT `select` -> `{ count }`;
 *  - `createMany` / `updateMany` WITH `select` -> the affected rows
 *    (`createManyAndReturn` / `updateManyAndReturn` are gone from the public
 *    surface — maintainer decision D-1).
 *
 * The schema carries a string-PK model and an increment-PK model so the
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
  /** Route exactly as the client does: one operation name, `select` decides. */
  const routed = (
    modelName: BulkModel,
    operation: "createMany" | "updateMany" | "deleteMany",
    args: Record<string, unknown>
  ) => {
    const operationInstance = constructRoutedOperation(
      engine,
      bulkWriteSchema[modelName] as Model<any>,
      operation,
      args
    );
    if (!operationInstance) {
      throw new Error(`bulk-write-behavior: '${operation}' did not route`);
    }
    return executor.execute(
      operationInstance,
      createOperationExecutionContext(
        modelName,
        operation,
        engine.instrumentation
      )
    );
  };
  /** `{ count }` arm — no `select` in the payload. */
  const bulkCount = (
    modelName: BulkModel,
    kind: "updateMany" | "deleteMany",
    args: Record<string, unknown>
  ) => routed(modelName, kind, args);
  /** Row-returning arm — the payload MUST carry a `select`. */
  const bulkRows = (
    modelName: BulkModel,
    kind: "createMany" | "updateMany" | "deleteMany",
    args: Record<string, unknown> & { select: Record<string, unknown> }
  ) => routed(modelName, kind, args);
  return { bulkCount, bulkRows, routed };
}

export function runBulkWriteBehavior(
  options: { readonly name: string } & BehaviorDatabaseSource
): void {
  describe(`${options.name} bulk-write stragglers`, () => {
    const openDatabase = useBehaviorDatabase(bulkWriteSchema, options);
    const setup = async () => {
      const { driver, client, dispose } = await openDatabase();
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
      "deleteMany with select returns the deleted rows and removes them",
      { timeout: 30_000 },
      async () => {
        const { client, dispose, bulkRows } = await setup();
        try {
          await seedGadgets(client);
          const rows = (await bulkRows("gadget", "deleteMany", {
            where: { qty: { lt: 5 } },
            select: { id: true, name: true },
          })) as Record<string, unknown>[];
          expect(rows.map((r) => r.id).sort()).toEqual(["g1", "g2"]);
          for (const row of rows) {
            expect(Object.keys(row).sort()).toEqual(["id", "name"]);
          }
          // The projection is the PRE-delete state and the delete really ran.
          const survivors = await client.gadget.findMany();
          expect(survivors.map((r) => r.id)).toEqual(["g3"]);
        } finally {
          await dispose();
        }
      }
    );

    test(
      "deleteMany with select matching nothing returns [] and deletes nothing",
      { timeout: 30_000 },
      async () => {
        const { client, dispose, bulkRows } = await setup();
        try {
          await seedGadgets(client);
          const rows = await bulkRows("gadget", "deleteMany", {
            where: { name: "Nope" },
            select: { id: true },
          });
          expect(rows).toEqual([]);
          expect(await client.gadget.findMany()).toHaveLength(3);
        } finally {
          await dispose();
        }
      }
    );

    test(
      "createMany with select returns the created rows",
      { timeout: 30_000 },
      async () => {
        const { client, dispose, bulkRows } = await setup();
        try {
          const rows = (await bulkRows("gadget", "createMany", {
            data: [
              { id: "g1", code: "c1", name: "Alpha" },
              { id: "g2", code: "c2", name: "Beta", qty: 5 },
            ],
            select: { id: true, code: true, name: true, qty: true },
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
      "createMany with a narrow select projects fields",
      { timeout: 30_000 },
      async () => {
        const { dispose, bulkRows } = await setup();
        try {
          const rows = (await bulkRows("gadget", "createMany", {
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
      "createMany with select assigns and returns increment ids in input order",
      { timeout: 30_000 },
      async () => {
        const { dispose, bulkRows } = await setup();
        try {
          const rows = (await bulkRows("ticket", "createMany", {
            data: [{ label: "one" }, { label: "two" }, { label: "three" }],
            select: { id: true, label: true },
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
      "createMany empty data returns [] with select and { count: 0 } without",
      { timeout: 30_000 },
      async () => {
        const { dispose, bulkRows, routed } = await setup();
        try {
          const rows = await bulkRows("gadget", "createMany", {
            data: [],
            select: { id: true },
          });
          expect(rows).toEqual([]);
          expect(await routed("gadget", "createMany", { data: [] })).toEqual({
            count: 0,
          });
        } finally {
          await dispose();
        }
      }
    );

    test(
      "updateMany with select returns the updated rows",
      { timeout: 30_000 },
      async () => {
        const { dispose, bulkRows, routed } = await setup();
        try {
          await routed("gadget", "createMany", {
            data: [
              { id: "g1", code: "c1", name: "Alpha", qty: 1 },
              { id: "g2", code: "c2", name: "Beta", qty: 2 },
              { id: "g3", code: "c3", name: "Gamma", qty: 10 },
            ],
          });
          const rows = (await bulkRows("gadget", "updateMany", {
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
      "updateMany with select and a PK-mutating increment returns post-update ids",
      { timeout: 30_000 },
      async () => {
        const { client, dispose, bulkRows, routed } = await setup();
        try {
          await routed("ticket", "createMany", {
            data: [{ label: "one" }, { label: "two" }, { label: "three" }],
          });
          // Fresh table: increment ids are 1, 2, 3. The non-returning refetch
          // must locate rows by their POST-update PKs (the DerivedValue
          // arithmetic, getUpdatedPrimaryKeyValues) — a before-image WHERE
          // would return [].
          const rows = (await bulkRows("ticket", "updateMany", {
            where: { id: { gt: 1 } },
            data: { id: { increment: 100 } },
            select: { id: true, label: true },
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
      "updateMany with select matching nothing returns []",
      { timeout: 30_000 },
      async () => {
        const { dispose, bulkRows, routed } = await setup();
        try {
          await routed("gadget", "createMany", {
            data: [{ id: "g1", code: "c1", name: "Alpha" }],
          });
          const rows = await bulkRows("gadget", "updateMany", {
            where: { name: "Nope" },
            data: { qty: 99 },
            select: { id: true },
          });
          expect(rows).toEqual([]);
        } finally {
          await dispose();
        }
      }
    );
  });
}
