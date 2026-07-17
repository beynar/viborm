import {
  createClient,
  type VibORMClient,
  type VibORMConfig,
} from "@client/client";
import type { AnyDriver } from "@drivers";
import { ForeignKeyError } from "@errors";
import { push } from "@migrations";
import { s } from "@schema";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import z from "zod/v4";

const gadget = s
  .model({
    id: s.string().id(),
    code: s.string().unique(),
    name: s.string(),
    qty: s.int().default(0),
  })
  .map("many_return_gadgets");

const ticket = s
  .model({
    id: s.int().id().increment(),
    label: s.string(),
  })
  .map("many_return_tickets");

const bigTicket = s
  .model({
    id: s.bigInt().id().increment(),
    label: s.string(),
  })
  .map("many_return_big_tickets");

const defaultTicket = s
  .model({
    id: s.int().id().increment(),
    label: s.string().default("application-default"),
  })
  .map("many_return_default_tickets");

const defaultOnlyTicket = s
  .model({
    id: s.int().id().increment(),
  })
  .map("many_return_default_only_tickets");

const orderedConflict = s
  .model({
    id: s.int().id().increment(),
    code: s.string().unique(),
    label: s.string(),
  })
  .map("many_return_ordered_conflicts");

const warehouse = s
  .model({
    id: s.string().id(),
    inventory: s.oneToMany(() => inventory),
  })
  .map("many_return_warehouses");

const inventory = s
  .model({
    id: s.string().id(),
    warehouseId: s.string(),
    warehouse: s
      .manyToOne(() => warehouse)
      .fields("warehouseId")
      .references("id"),
  })
  .map("many_return_inventory");

const constrainedInput = s
  .model({
    id: s.string().id(),
    requiredText: s.string(),
    shortText: s.string().schema(z.string().max(4)),
    quantity: s.int(),
  })
  .map("many_return_constrained_inputs");

const schema = {
  gadget,
  ticket,
  bigTicket,
  defaultTicket,
  defaultOnlyTicket,
  orderedConflict,
  warehouse,
  inventory,
  constrainedInput,
};

type ManyAndReturnClientConfig = VibORMConfig & {
  schema: typeof schema;
  driver: AnyDriver;
};

type ManyAndReturnClient = VibORMClient<ManyAndReturnClientConfig>;

export interface ManyAndReturnBehaviorOptions {
  driverName: string;
  createDriver: () => AnyDriver;
}

export function runManyAndReturnBehavior({
  driverName,
  createDriver,
}: ManyAndReturnBehaviorOptions) {
  describe(`${driverName} createManyAndReturn / updateManyAndReturn`, () => {
    let client: ManyAndReturnClient | undefined;

    beforeEach(async () => {
      const driver = createDriver();
      client = createClient({ schema, driver });
      await push(client, { force: true });
    });

    afterEach(async () => {
      if (client) {
        await client.$disconnect();
        client = undefined;
      }
    });

    test("createManyAndReturn returns the created rows", async () => {
      const rows = await client!.gadget.createManyAndReturn({
        data: [
          { id: "g1", code: "c1", name: "Alpha" },
          { id: "g2", code: "c2", name: "Beta", qty: 5 },
        ],
      });

      expect(rows).toHaveLength(2);
      const byId = new Map(rows.map((r) => [r.id, r]));
      expect(byId.get("g1")).toMatchObject({
        id: "g1",
        code: "c1",
        name: "Alpha",
        qty: 0,
      });
      expect(byId.get("g2")).toMatchObject({ id: "g2", qty: 5 });
    });

    test("createManyAndReturn with select returns only selected fields", async () => {
      const rows = await client!.gadget.createManyAndReturn({
        data: [
          { id: "g1", code: "c1", name: "Alpha" },
          { id: "g2", code: "c2", name: "Beta" },
        ],
        select: { name: true },
      });

      expect(rows).toHaveLength(2);
      for (const row of rows) {
        expect(Object.keys(row)).toEqual(["name"]);
      }
      expect(rows.map((r) => r.name).sort()).toEqual(["Alpha", "Beta"]);
    });

    test("createManyAndReturn assigns auto-increment ids", async () => {
      const rows = await client!.ticket.createManyAndReturn({
        data: [{ label: "one" }, { label: "two" }, { label: "three" }],
      });

      expect(rows).toHaveLength(3);
      const ids = rows.map((r) => r.id);
      expect(new Set(ids).size).toBe(3);
      for (const id of ids) {
        expect(typeof id).toBe("number");
      }
      expect(rows.map((r) => r.label).sort()).toEqual(["one", "three", "two"]);
    });

    test("createMany preserves generation when another row supplies an increment id", async () => {
      const result = await client!.ticket.createMany({
        data: [
          { id: 10, label: "explicit" },
          { label: "generated" },
          { id: 20, label: "explicit-later" },
        ],
      });

      expect(result.count).toBe(3);
      const rows = await client!.ticket.findMany();
      const idsByLabel = new Map(rows.map((row) => [row.label, row.id]));

      expect(idsByLabel.get("explicit")).toBe(10);
      expect(idsByLabel.get("explicit-later")).toBe(20);
      expect(idsByLabel.get("generated")).not.toBe(0);
      expect(idsByLabel.get("generated")).not.toBe(10);
      expect(idsByLabel.get("generated")).not.toBe(20);
    });

    test("createManyAndReturn restores input order across increment row shapes", async () => {
      const rows = await client!.ticket.createManyAndReturn({
        data: [
          { id: 100, label: "explicit-first" },
          { label: "generated-first" },
          { id: 200, label: "explicit-second" },
          { label: "generated-second" },
        ],
      });

      expect(rows.map((row) => row.label)).toEqual([
        "explicit-first",
        "generated-first",
        "explicit-second",
        "generated-second",
      ]);
      expect(rows[0]?.id).toBe(100);
      expect(rows[2]?.id).toBe(200);
      expect(new Set(rows.map((row) => row.id)).size).toBe(4);
    });

    test("createManyAndReturn preserves bigint generation and order", async () => {
      const rows = await client!.bigTicket.createManyAndReturn({
        data: [
          { id: 100n, label: "explicit" },
          { label: "generated" },
          { id: 200n, label: "explicit-later" },
        ],
      });

      expect(rows.map((row) => row.label)).toEqual([
        "explicit",
        "generated",
        "explicit-later",
      ]);
      expect(rows[0]?.id).toBe(100n);
      expect(rows[2]?.id).toBe(200n);
      expect(typeof rows[1]?.id).toBe("bigint");
      expect(rows[1]?.id).not.toBe(0n);
    });

    test("application defaults remain values while increment defaults stay database-owned", async () => {
      const rows = await client!.defaultTicket.createManyAndReturn({
        data: [
          {},
          { id: 50, label: "explicit" },
          { label: "application-default" },
        ],
      });

      expect(rows.map((row) => row.label)).toEqual([
        "application-default",
        "explicit",
        "application-default",
      ]);
      expect(rows[1]?.id).toBe(50);
      expect(rows[0]?.id).not.toBe(0);
      expect(rows[2]?.id).not.toBe(0);
    });

    test("default-only createMany rows use database generation", async () => {
      const created = await client!.defaultOnlyTicket.createManyAndReturn({
        data: [{}, {}],
      });

      expect(created).toHaveLength(2);
      expect(new Set(created.map((row) => row.id)).size).toBe(2);
      expect(created.every((row) => row.id > 0)).toBe(true);
    });

    test("default-only create uses database generation", async () => {
      const created = await client!.defaultOnlyTicket.create({ data: {} });

      expect(created.id).toBeGreaterThan(0);
    });

    test("createMany preserves conflict winner input order across row shapes", async () => {
      const result = await client!.orderedConflict.createMany({
        data: [
          { code: "unrelated", label: "generated-first" },
          { id: 50, code: "winner", label: "input-first" },
          { code: "winner", label: "must-skip" },
        ],
        skipDuplicates: true,
      });

      expect(result.count).toBe(2);
      const winner = await client!.orderedConflict.findUnique({
        where: { code: "winner" },
      });
      expect(winner?.label).toBe("input-first");
      expect(winner?.id).toBe(50);
    });

    test("singleton createMany duplicate recovery returns count zero", async () => {
      await client!.orderedConflict.create({
        data: { id: 60, code: "singleton", label: "existing" },
      });

      const result = await client!.orderedConflict.createMany({
        data: [{ id: 61, code: "singleton", label: "duplicate" }],
        skipDuplicates: true,
      });

      expect(result).toEqual({ count: 0 });
      await expect(
        client!.orderedConflict.findUnique({ where: { code: "singleton" } })
      ).resolves.toMatchObject({ id: 60, label: "existing" });
    });

    test("skipDuplicates keeps case, accent, and trailing-space unique values distinct", async () => {
      const result = await client!.orderedConflict.createMany({
        data: [
          { code: "Case", label: "case-lower" },
          { code: "CASE", label: "case-upper" },
          { code: "résumé", label: "accented" },
          { code: "resume", label: "plain" },
          { code: "trail", label: "plain-trailing" },
          { code: "trail ", label: "spaced-trailing" },
        ],
        skipDuplicates: true,
      });

      expect(result.count).toBe(6);
      const rows = await client!.orderedConflict.findMany();
      expect(new Set(rows.map((row) => row.code))).toEqual(
        new Set(["Case", "CASE", "résumé", "resume", "trail", "trail "])
      );
    });

    test("explicit zero increment ids reject uniformly before mutation", async () => {
      await expect(
        client!.ticket.create({ data: { id: 0, label: "zero" } })
      ).rejects.toThrow("Explicit zero");
      await expect(
        client!.bigTicket.createMany({
          data: [{ id: 0n, label: "zero" }, { label: "would-write" }],
        })
      ).rejects.toThrow("Explicit zero");

      expect(await client!.ticket.count()).toBe(0);
      expect(await client!.bigTicket.count()).toBe(0);
    });

    test("createManyAndReturn skips only duplicate rows and returns inserted rows", async () => {
      await client!.gadget.create({
        data: { id: "g1", code: "c1", name: "Existing" },
      });

      const rows = await client!.gadget.createManyAndReturn({
        data: [
          { id: "g1", code: "c1", name: "Duplicate" },
          { id: "g3", code: "c3", name: "Fresh" },
        ],
        skipDuplicates: true,
      });

      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ id: "g3", name: "Fresh" });
    });

    test("skipDuplicates still surfaces unrelated foreign-key failures", async () => {
      await client!.warehouse.create({ data: { id: "warehouse-1" } });
      await expect(
        client!.inventory.createMany({
          data: [
            { id: "inventory-valid", warehouseId: "warehouse-1" },
            { id: "inventory-invalid", warehouseId: "missing" },
          ],
          skipDuplicates: true,
        })
      ).rejects.toBeInstanceOf(ForeignKeyError);
      expect(await client!.inventory.count()).toBe(0);
    });

    test("skipDuplicates does not suppress required, length, or conversion errors", async () => {
      const valid = {
        id: "valid",
        requiredText: "yes",
        shortText: "four",
        quantity: 1,
      };

      await expect(
        client!.constrainedInput.createMany({
          data: [
            valid,
            {
              id: "null",
              requiredText: null as never,
              shortText: "four",
              quantity: 1,
            },
          ],
          skipDuplicates: true,
        })
      ).rejects.toThrow();
      await expect(
        client!.constrainedInput.createMany({
          data: [valid, { ...valid, id: "long", shortText: "too long" }],
          skipDuplicates: true,
        })
      ).rejects.toThrow();
      await expect(
        client!.constrainedInput.createMany({
          data: [
            valid,
            { ...valid, id: "conversion", quantity: "not-an-int" as never },
          ],
          skipDuplicates: true,
        })
      ).rejects.toThrow();

      expect(await client!.constrainedInput.count()).toBe(0);
    });

    test("updateManyAndReturn returns the updated rows", async () => {
      await client!.gadget.createMany({
        data: [
          { id: "g1", code: "c1", name: "Alpha", qty: 1 },
          { id: "g2", code: "c2", name: "Beta", qty: 2 },
          { id: "g3", code: "c3", name: "Gamma", qty: 10 },
        ],
      });

      const rows = await client!.gadget.updateManyAndReturn({
        where: { qty: { lt: 5 } },
        data: { name: "Updated" },
      });

      expect(rows).toHaveLength(2);
      expect(rows.map((r) => r.id).sort()).toEqual(["g1", "g2"]);
      for (const row of rows) {
        expect(row.name).toBe("Updated");
      }

      const untouched = await client!.gadget.findUnique({
        where: { id: "g3" },
      });
      expect(untouched?.name).toBe("Gamma");
    });

    test("updateManyAndReturn applies atomic operations and select", async () => {
      await client!.gadget.createMany({
        data: [
          { id: "g1", code: "c1", name: "Alpha", qty: 1 },
          { id: "g2", code: "c2", name: "Beta", qty: 2 },
        ],
      });

      const rows = await client!.gadget.updateManyAndReturn({
        data: { qty: { increment: 10 } },
        select: { id: true, qty: true },
      });

      expect(rows).toHaveLength(2);
      const byId = new Map(rows.map((r) => [r.id, r]));
      expect(byId.get("g1")?.qty).toBe(11);
      expect(byId.get("g2")?.qty).toBe(12);
      for (const row of rows) {
        expect(Object.keys(row).sort()).toEqual(["id", "qty"]);
      }
    });

    test("updateManyAndReturn applies atomic decrement and multiply", async () => {
      await client!.gadget.createMany({
        data: [
          { id: "g1", code: "c1", name: "Alpha", qty: 10 },
          { id: "g2", code: "c2", name: "Beta", qty: 4 },
        ],
      });

      const decremented = await client!.gadget.updateManyAndReturn({
        data: { qty: { decrement: 3 } },
        select: { id: true, qty: true },
      });
      expect(decremented).toHaveLength(2);
      const decrementedById = new Map(decremented.map((r) => [r.id, r.qty]));
      expect(decrementedById.get("g1")).toBe(7);
      expect(decrementedById.get("g2")).toBe(1);

      const multiplied = await client!.gadget.updateManyAndReturn({
        data: { qty: { multiply: 5 } },
        select: { id: true, qty: true },
      });
      expect(multiplied).toHaveLength(2);
      const multipliedById = new Map(multiplied.map((r) => [r.id, r.qty]));
      expect(multipliedById.get("g1")).toBe(35);
      expect(multipliedById.get("g2")).toBe(5);

      const persisted = await client!.gadget.findMany({
        orderBy: { id: "asc" },
      });
      expect(persisted.map((r) => r.qty)).toEqual([35, 5]);
    });

    test("updateManyAndReturn applies atomic divide (exact quotient)", async () => {
      await client!.gadget.create({
        data: { id: "g1", code: "c1", name: "Exact", qty: 8 },
      });

      const rows = await client!.gadget.updateManyAndReturn({
        data: { qty: { divide: 2 } },
        select: { id: true, qty: true },
      });

      // 8 / 2 divides exactly, so every dialect agrees on 4.
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ id: "g1", qty: 4 });

      const persisted = await client!.gadget.findUnique({
        where: { id: "g1" },
      });
      expect(persisted?.qty).toBe(4);
    });

    test("atomic divide pins integer-division semantics on inexact quotients", async () => {
      // SQLite drivers bind the JS number 2 as a REAL, so a naive `qty = qty / ?`
      // runs REAL division and would persist 3.5 into the Int column. The SQLite
      // adapter casts the divisor to INTEGER for integer columns
      // (sqlite-adapter.ts set.divide), giving native INT/INT division (3) that
      // matches what Prisma persists on SQLite.
      await client!.gadget.create({
        data: { id: "g1", code: "c1", name: "Inexact", qty: 7 },
      });

      const rows = await client!.gadget.updateManyAndReturn({
        data: { qty: { divide: 2 } },
        select: { id: true, qty: true },
      });

      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ id: "g1", qty: 3 });

      const persisted = await client!.gadget.findUnique({
        where: { id: "g1" },
      });
      expect(persisted?.qty).toBe(3);
    });

    test("updateManyAndReturn returns empty array when nothing matches", async () => {
      await client!.gadget.create({
        data: { id: "g1", code: "c1", name: "Alpha" },
      });

      const rows = await client!.gadget.updateManyAndReturn({
        where: { name: "Nope" },
        data: { qty: 99 },
      });

      expect(rows).toEqual([]);
    });
  });
}
