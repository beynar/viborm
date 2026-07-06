import {
  createClient,
  type VibORMClient,
  type VibORMConfig,
} from "@client/client";
import type { AnyDriver } from "@drivers";
import { push } from "@migrations";
import { s } from "@schema";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

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

const schema = { gadget, ticket };

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
    let supportsReturning = true;

    beforeEach(async () => {
      const driver = createDriver();
      supportsReturning = driver.adapter.capabilities.supportsReturning;
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

    test("createManyAndReturn composes with skipDuplicates", async () => {
      await client!.gadget.create({
        data: { id: "g1", code: "c1", name: "Existing" },
      });

      const pending = client!.gadget.createManyAndReturn({
        data: [
          { id: "g1", code: "c1", name: "Duplicate" },
          { id: "g3", code: "c3", name: "Fresh" },
        ],
        skipDuplicates: true,
      });

      if (supportsReturning) {
        const rows = await pending;
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ id: "g3", name: "Fresh" });
      } else {
        // MySQL: INSERT IGNORE cannot identify which rows were inserted
        await expect(pending).rejects.toThrow(/skipDuplicates/);
      }
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
