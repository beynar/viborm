import {
  createClient,
  type VibORMClient,
  type VibORMConfig,
} from "@client/client";
import type { AnyDriver } from "@drivers";
import { ForeignKeyError } from "@errors";
import { s } from "@schema";
import { defineContract } from "@tests/contracts/contract";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
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
    inventory: s.toMany(() => inventory),
  })
  .map("many_return_warehouses");

const inventory = s
  .model({
    id: s.string().id(),
    warehouseId: s.string(),
    warehouse: s
      .toOne(() => warehouse)
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

type ImplicitReturningClientConfig = VibORMConfig<typeof schema>;

type ImplicitReturningClient = VibORMClient<ImplicitReturningClientConfig>;

export interface ImplicitReturningBehaviorOptions {
  driverName: string;
  createDriver: () => AnyDriver;
}

/**
 * IMPLICIT RETURNING on the bulk writes, per driver. There is no
 * `createManyAndReturn` / `updateManyAndReturn` any more (maintainer decision
 * D-1): `createMany` / `updateMany` / `deleteMany` return `{ count }` unless the
 * call carries a `select`, in which case they return the affected rows. Because
 * `select` is the only way to ask for rows, a "return everything" assertion must
 * name every column — which is exactly what the surface promises.
 *
 * `deleteMany` with `select` has no Prisma counterpart at all, and it is the case
 * where the driver split actually matters: a returning driver deletes and returns
 * in one statement, a non-returning one must READ the rows before removing them.
 * The MySQL leg is what proves that ordering behaviorally.
 */
export function runImplicitReturningBehavior({
  driverName,
  createDriver,
}: ImplicitReturningBehaviorOptions) {
  describe(`${driverName} bulk-write implicit returning`, () => {
    let client: ImplicitReturningClient | undefined;
    beforeEach(async () => {
      const driver = createDriver();
      client = createClient({ schema, driver });
      await syncLiveSchema(client);
    });

    afterEach(async () => {
      if (client) {
        await client.$disconnect();
        client = undefined;
      }
    });

    test("createMany without select returns { count }, with select returns rows", async () => {
      // The whole point of the implicit form: same operation, same payload plus
      // one key, two different result shapes.
      const counted = await client!.gadget.createMany({
        data: [{ id: "g0", code: "c0", name: "Counted" }],
      });
      expect(counted).toEqual({ count: 1 });

      const rows = await client!.gadget.createMany({
        data: [
          { id: "g1", code: "c1", name: "Alpha" },
          { id: "g2", code: "c2", name: "Beta", qty: 5 },
        ],
        select: { id: true, code: true, name: true, qty: true },
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

    test("createMany with a narrow select returns only selected fields", async () => {
      const rows = await client!.gadget.createMany({
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

    /**
     * A bulk write's `select` is SCALAR-ONLY, on every driver, and both
     * spellings of "give me a relation too" are refused at the parse boundary
     * BEFORE anything is written.
     *
     * This is the fail-closed replacement for a projection that used to be
     * accepted and answered with wrong data: a relation embedded in a
     * `RETURNING` list has no alias to correlate against, so a to-many always
     * came back `[]` and a self-referencing to-one came back `null`, while the
     * same projection through `findMany` returned the real rows. The refusal is
     * a ValidationError, so the write does not happen either.
     */
    test("a relation in a bulk write's select is refused, not silently emptied", async () => {
      await client!.warehouse.create({ data: { id: "w1" } });

      // Spelled through the untyped seam: nested excess-property checking does
      // not fire through the client's generic signature when a valid sibling key
      // is present (the same pre-existing TS limitation noted in
      // tests/client/operations.test.ts). The type-level exclusion is asserted
      // directly in tests/client/implicit-returning-types.test.ts; this test is
      // about the RUNTIME parse boundary, which is the enforced one.
      const untyped = client as unknown as Record<
        string,
        Record<string, (args: Record<string, unknown>) => Promise<unknown>>
      >;
      const refusals: (() => Promise<unknown>)[] = [
        () =>
          untyped.inventory!.createMany!({
            data: [{ id: "i1", warehouseId: "w1" }],
            select: { id: true, warehouse: { select: { id: true } } },
          }),
        () =>
          untyped.inventory!.updateMany!({
            where: {},
            data: { warehouseId: "w1" },
            select: { id: true, warehouse: true },
          }),
        () =>
          untyped.warehouse!.deleteMany!({
            where: {},
            select: { id: true, inventory: { select: { id: true } } },
          }),
        () =>
          untyped.warehouse!.updateMany!({
            where: {},
            data: { id: "w1" },
            select: { id: true, _count: true },
          }),
      ];

      for (const call of refusals) {
        let thrown: unknown;
        try {
          await call();
        } catch (error) {
          thrown = error;
        }
        const message = (thrown as Error | undefined)?.message ?? "";
        expect(message).toContain("is not supported on");
        expect(message).toContain("Read the relation in a separate query.");
      }

      // Nothing was written, and the warehouse is still there: each refusal
      // happened at the parse boundary.
      expect(await client!.inventory.count()).toBe(0);
      expect(await client!.warehouse.count()).toBe(1);

      // The scalar projection of the same operations still works.
      expect(
        await client!.inventory.createMany({
          data: [{ id: "i1", warehouseId: "w1" }],
          select: { id: true, warehouseId: true },
        })
      ).toEqual([{ id: "i1", warehouseId: "w1" }]);
    });

    /**
     * The `include` spelling, refused with a message that names the alternative.
     * The message must NOT be the one the W3 wave shipped ("relations cannot be
     * joined in" was offered as a property of the write statement, which was not
     * the real reason and read as a capability claim); it points at a separate
     * query, which is what the surface actually requires.
     */
    test("include is refused with a message that names the alternative", async () => {
      const untyped = client as unknown as Record<
        string,
        Record<string, (args: Record<string, unknown>) => Promise<unknown>>
      >;
      for (const call of [
        () =>
          untyped.gadget!.createMany!({
            data: [{ id: "g1", code: "c1", name: "A" }],
            include: { nothing: true },
          }),
        () =>
          untyped.gadget!.updateMany!({
            where: {},
            data: { name: "A" },
            include: { nothing: true },
          }),
        () =>
          untyped.gadget!.deleteMany!({
            where: {},
            include: { nothing: true },
          }),
      ]) {
        let thrown: unknown;
        try {
          await call();
        } catch (error) {
          thrown = error;
        }
        const message = (thrown as Error | undefined)?.message ?? "";
        expect(message).toContain("'include' is not supported on");
        expect(message).toContain("read relations in a separate query");
      }
    });

    test("createMany with select assigns auto-increment ids", async () => {
      const rows = await client!.ticket.createMany({
        data: [{ label: "one" }, { label: "two" }, { label: "three" }],
        select: { id: true, label: true },
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

    test("createMany with select restores input order across increment row shapes", async () => {
      const rows = await client!.ticket.createMany({
        data: [
          { id: 100, label: "explicit-first" },
          { label: "generated-first" },
          { id: 200, label: "explicit-second" },
          { label: "generated-second" },
        ],
        select: { id: true, label: true },
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

    test("createMany with select preserves bigint generation and order", async () => {
      const rows = await client!.bigTicket.createMany({
        data: [
          { id: 100n, label: "explicit" },
          { label: "generated" },
          { id: 200n, label: "explicit-later" },
        ],
        select: { id: true, label: true },
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
      const rows = await client!.defaultTicket.createMany({
        data: [
          {},
          { id: 50, label: "explicit" },
          { label: "application-default" },
        ],
        select: { id: true, label: true },
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
      const created = await client!.defaultOnlyTicket.createMany({
        data: [{}, {}],
        select: { id: true },
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

    test("createMany with select skips only duplicate rows and returns inserted rows", async () => {
      await client!.gadget.create({
        data: { id: "g1", code: "c1", name: "Existing" },
      });

      const call = () =>
        client!.gadget.createMany({
          data: [
            { id: "g1", code: "c1", name: "Duplicate" },
            { id: "g3", code: "c3", name: "Fresh" },
          ],
          skipDuplicates: true,
          select: { id: true, name: true },
        });

      // U-E6.9 (maintainer-authorized) made this ONE assertion for both driver classes.
      // It used to fork: a non-returning driver saw the deliberate refusal, because no
      // single statement can report which rows a skip inserted. It still cannot — but the
      // operation can, by observing each row's own write behind the savepoint effect and
      // refetching by the ids it captured. The two mechanisms now answer identically, and
      // saying so with ONE assertion is the point: the driver class is no longer part of
      // this shape's semantics. (The mechanism-specific claims — the capture's structure,
      // the stale-id decoy, the atomic-batch refusal — are in
      // `tests/contracts/engine/write/skip-select-capture-*.ts`.)
      const rows = await call();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ id: "g3", name: "Fresh" });
      // The row already there is untouched, and the skipped input did not become one.
      await expect(
        client!.gadget.findUnique({ where: { id: "g1" } })
      ).resolves.toMatchObject({ name: "Existing" });
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

    test("updateMany without select returns { count }, with select returns rows", async () => {
      await client!.gadget.createMany({
        data: [
          { id: "g1", code: "c1", name: "Alpha", qty: 1 },
          { id: "g2", code: "c2", name: "Beta", qty: 2 },
          { id: "g3", code: "c3", name: "Gamma", qty: 10 },
        ],
      });

      const counted = await client!.gadget.updateMany({
        where: { qty: { lt: 5 } },
        data: { qty: { increment: 0 } },
      });
      expect(counted).toEqual({ count: 2 });

      const rows = await client!.gadget.updateMany({
        where: { qty: { lt: 5 } },
        data: { name: "Updated" },
        select: { id: true, name: true },
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

    test("updateMany with select applies atomic operations", async () => {
      await client!.gadget.createMany({
        data: [
          { id: "g1", code: "c1", name: "Alpha", qty: 1 },
          { id: "g2", code: "c2", name: "Beta", qty: 2 },
        ],
      });

      const rows = await client!.gadget.updateMany({
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

    test("updateMany with select applies atomic decrement and multiply", async () => {
      await client!.gadget.createMany({
        data: [
          { id: "g1", code: "c1", name: "Alpha", qty: 10 },
          { id: "g2", code: "c2", name: "Beta", qty: 4 },
        ],
      });

      const decremented = await client!.gadget.updateMany({
        data: { qty: { decrement: 3 } },
        select: { id: true, qty: true },
      });
      expect(decremented).toHaveLength(2);
      const decrementedById = new Map(decremented.map((r) => [r.id, r.qty]));
      expect(decrementedById.get("g1")).toBe(7);
      expect(decrementedById.get("g2")).toBe(1);

      const multiplied = await client!.gadget.updateMany({
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

    test("updateMany with select applies atomic divide (exact quotient)", async () => {
      await client!.gadget.create({
        data: { id: "g1", code: "c1", name: "Exact", qty: 8 },
      });

      const rows = await client!.gadget.updateMany({
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

      const rows = await client!.gadget.updateMany({
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

    test("updateMany with select returns empty array when nothing matches", async () => {
      await client!.gadget.create({
        data: { id: "g1", code: "c1", name: "Alpha" },
      });

      const rows = await client!.gadget.updateMany({
        where: { name: "Nope" },
        data: { qty: 99 },
        select: { id: true },
      });

      expect(rows).toEqual([]);
      // The same no-match payload without `select` is `{ count: 0 }`.
      await expect(
        client!.gadget.updateMany({
          where: { name: "Nope" },
          data: { qty: 99 },
        })
      ).resolves.toEqual({ count: 0 });
    });

    test("deleteMany without select returns { count }, with select returns the deleted rows", async () => {
      await client!.gadget.createMany({
        data: [
          { id: "g1", code: "c1", name: "Alpha", qty: 1 },
          { id: "g2", code: "c2", name: "Beta", qty: 2 },
          { id: "g3", code: "c3", name: "Gamma", qty: 10 },
        ],
      });

      const rows = await client!.gadget.deleteMany({
        where: { qty: { lt: 5 } },
        select: { id: true, name: true, qty: true },
      });

      expect(rows).toHaveLength(2);
      expect(rows.map((r) => r.id).sort()).toEqual(["g1", "g2"]);
      for (const row of rows) {
        expect(Object.keys(row).sort()).toEqual(["id", "name", "qty"]);
      }
      // The returned rows are the rows that are GONE — the projection is read
      // from the pre-delete state, and the delete really happened.
      expect(await client!.gadget.findMany()).toHaveLength(1);
      expect(
        (await client!.gadget.findUnique({ where: { id: "g3" } }))?.name
      ).toBe("Gamma");

      const counted = await client!.gadget.deleteMany({ where: { qty: 10 } });
      expect(counted).toEqual({ count: 1 });
      expect(await client!.gadget.count()).toBe(0);
    });

    test("deleteMany with select returns [] when nothing matches and deletes nothing", async () => {
      await client!.gadget.create({
        data: { id: "g1", code: "c1", name: "Alpha" },
      });

      const rows = await client!.gadget.deleteMany({
        where: { name: "Nope" },
        select: { id: true },
      });

      expect(rows).toEqual([]);
      expect(await client!.gadget.count()).toBe(1);
    });

    test("deleteMany with select over every row returns them all", async () => {
      // No `where`: the captured set (non-returning path) and the RETURNING set
      // must both cover the whole table.
      await client!.ticket.createMany({
        data: [{ label: "one" }, { label: "two" }, { label: "three" }],
      });

      const rows = await client!.ticket.deleteMany({
        select: { id: true, label: true },
      });

      expect(rows.map((r) => r.label).sort()).toEqual(["one", "three", "two"]);
      expect(new Set(rows.map((r) => r.id)).size).toBe(3);
      expect(await client!.ticket.count()).toBe(0);
    });
  });
}

export const implicitReturningContract = defineContract({
  id: "drivers.implicit-returning",
  owningLayer: "drivers",
  tier: "extended",
  requiredCapabilities: ["sql-execution"],
  register: runImplicitReturningBehavior,
});
