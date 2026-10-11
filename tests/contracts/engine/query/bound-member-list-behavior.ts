/**
 * A scalar `in`/`notIn` list bound as ONE parameter (engine-09), and a
 * same-column `OR` chain read as that list (platform-15), against a real
 * database.
 *
 * Before 1.2.0 every member was its own parameter, so 40,000 ids met the
 * driver's bind cap (32,766 on SQLite, 32,767 on PGlite, 100 on D1) and the
 * call was refused with V8003; and an `OR` was one flat chain, which SQLite
 * parses one expression level deep per arm, so 999 arms already failed with an
 * opaque V2001 ("Expression tree is too large"). These are the claims only a
 * live provider settles: the rows each list reaches through every field codec,
 * the NULL semantics of `NOT IN`, the bound-parameter count, and on SQLite the
 * plan, which must still search the index.
 */

import { createClient } from "@client/client";
import type { AnyDriver } from "@drivers";
import { s } from "@schema";
import { SQLITE } from "@schema/scalars/native-types";
import { instrumentation } from "@src/instrumentation/exports";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "vitest";

const order = s
  .model({
    id: s.int().id(),
    reference: s.string().unique(),
    note: s.string().nullable(),
    priority: s.int().default(0),
  })
  .map("bml_orders");

/** One field per codec a list member crosses before it is bound. */
const codec = s
  .model({
    id: s.string().id().uuid(),
    ref: s.string().ulid().unique(),
    big: s.bigInt(),
    amount: s.decimal({ precision: 12, scale: 2 }),
    at: s.dateTime(),
  })
  .map("bml_codecs");

/** SQLite only: an instant stored as epoch milliseconds. */
const epoch = s
  .model({
    id: s.int().id(),
    at: s.dateTime(SQLITE.DATETIME.INTEGER),
  })
  .map("bml_epochs");

/**
 * Every model on every dialect: a SQLite native type declares nothing on
 * PostgreSQL, where `epoch.at` is an ordinary instant the tests leave empty.
 */
const schema = { order, codec, epoch };
const open = (driver: AnyDriver) => createClient({ schema, driver });

export interface BoundMemberListOptions {
  readonly name: string;
  readonly dialect: "sqlite" | "postgresql";
  readonly createDriver: () => AnyDriver;
  /** Rows seeded for the large-list legs; the list itself is always 40,000. */
  readonly rows?: number;
  /**
   * `false` where the driver binds fewer values than a cross-column OR has
   * arms (D1: 100): those arms stay one parameter each, refused there by
   * design.
   */
  readonly crossColumnOr?: false;
  /** The tables' DDL, where the driver cannot `push` (D1). */
  readonly tables?: readonly string[];
}

// The dialect's one-parameter list, in the rendered SQL, and the plan steps.
const SQLITE_LIST = /json_each\(/;
const PG_LIST = /= ANY\(/;
const SQLITE_NOT_IN = /NOT IN \(SELECT/;
const PG_NOT_IN = /<> ALL\(/;
const KEY_SEARCH = /SEARCH .*INTEGER PRIMARY KEY/;
const INDEX_SEARCH = /SEARCH .*USING (COVERING )?INDEX/;
const TABLE_SCAN = /SCAN q0/;
const LIST = 40_000;
const BRANCHES = 2000;

interface Statement {
  readonly sql: string;
  readonly params: readonly unknown[];
}
const SQLITE_PLACEHOLDER = /\?/g;
const PG_PLACEHOLDER = /\$(\d+)/g;
/**
 * The values a statement binds, read from its placeholders: the logged
 * parameter array is a diagnostic, bounded, copy.
 */
function bound(statement: Statement | undefined): number {
  const sql = statement?.sql ?? "";
  const pg = [...sql.matchAll(PG_PLACEHOLDER)].map((match) => Number(match[1]));
  return pg.length > 0
    ? Math.max(...pg)
    : (sql.match(SQLITE_PLACEHOLDER) ?? []).length;
}

const UUIDS = [
  "0b7a3c9e-5f1d-4e2a-9c8b-1d2e3f4a5b6c",
  "1c8b4daf-6a2e-4f3b-8d9c-2e3f4a5b6c7d",
  "2d9c5eb0-7b3f-4a4c-9ead-3f4a5b6c7d8e",
];
const ULIDS = [
  "01J9Z8Y7X6W5V4T3S2R1Q0P9N8",
  "01J9Z8Y7X6W5V4T3S2R1Q0P9N9",
  "01J9Z8Y7X6W5V4T3S2R1Q0P9NA",
];
const BIGS = [9_007_199_254_740_993n, -42n, 9_223_372_036_854_775_807n];
const AMOUNTS = ["12.50", "-0.01", "9999999999.99"];
const INSTANTS = [
  "2026-01-01T00:00:00.000Z",
  "2026-06-15T12:34:56.789Z",
  "1999-12-31T23:59:59.999Z",
];

/** Non-matching padding, so a list is long enough to show its binding. */
function padding<T>(count: number, make: (index: number) => T): T[] {
  return Array.from({ length: count }, (_, index) => make(index));
}

export function runBoundMemberListBehavior(
  options: BoundMemberListOptions
): void {
  const rows = options.rows ?? 12_000;
  const sqlite = options.dialect === "sqlite";
  const statements: Statement[] = [];
  let base: ReturnType<typeof open>;
  let client: ReturnType<typeof extend>;
  const extend = (plain: typeof base) =>
    plain.$extends(
      instrumentation({
        logging: {
          query: (event) => {
            statements.push({
              sql: event.sql ?? "",
              params: event.params ?? [],
            });
          },
          includeSql: true,
          includeParams: true,
        },
      })
    );
  /** The widest statement the call ran, by bound values. */
  const widest = async (run: () => Promise<unknown>) => {
    statements.length = 0;
    await run();
    return statements.reduce<Statement | undefined>(
      (wide, statement) =>
        wide && bound(wide) >= bound(statement) ? wide : statement,
      undefined
    );
  };
  const ids = Array.from({ length: LIST }, (_, index) => index + 1);

  // One database for the file: a PGlite instance is most of its memory.
  beforeAll(async () => {
    base = open(options.createDriver());
    client = extend(base);
    // A shared server database holds other suites' tables: manage only ours.
    if (options.tables === undefined)
      await syncLiveSchema(base, {
        tables: ["bml_orders", "bml_codecs", "bml_epochs"],
      });
    else
      for (const statement of options.tables)
        await base.$executeRawUnsafe(statement);
  });
  afterAll(async () => {
    await base.$disconnect();
  });

  describe(`${options.name}: a scalar list binds as one parameter`, () => {
    beforeEach(async () => {
      await base.order.deleteMany();
      for (let start = 0; start < rows; start += 2000)
        await base.order.createMany({
          data: padding(Math.min(2000, rows - start), (offset) => ({
            id: start + offset + 1,
            reference: `R${start + offset + 1}`,
            note:
              (start + offset) % 3 === 0 ? null : `n${(start + offset) % 3}`,
          })),
        });
    });

    test(`findMany, updateMany and deleteMany take ${LIST.toLocaleString("en")} ids`, async () => {
      const read = await widest(async () => {
        expect(
          await client.order.findMany({
            where: { id: { in: ids } },
            select: { id: true },
          })
        ).toHaveLength(rows);
      });
      expect(bound(read)).toBe(1);
      expect(read?.sql).toMatch(sqlite ? SQLITE_LIST : PG_LIST);

      const text = await widest(async () => {
        expect(
          await client.order.findMany({
            where: { reference: { in: ids.map((id) => `R${id}`) } },
            select: { id: true },
          })
        ).toHaveLength(rows);
      });
      expect(bound(text)).toBe(1);

      const excluded = await widest(async () => {
        expect(
          await client.order.findMany({
            where: { id: { notIn: ids.slice(1) } },
            select: { id: true },
          })
        ).toEqual([{ id: 1 }]);
      });
      expect(excluded?.sql).toMatch(sqlite ? SQLITE_NOT_IN : PG_NOT_IN);

      expect(
        await client.order.updateMany({
          where: { id: { in: ids } },
          data: { priority: 1 },
        })
      ).toEqual({ count: rows });
      expect(await client.order.count({ where: { priority: 1 } })).toBe(rows);
      expect(
        await client.order.deleteMany({ where: { id: { in: ids } } })
      ).toEqual({ count: rows });
      expect(await client.order.count()).toBe(0);
    });

    test("NOT IN keeps rows whose column is NULL out, as it always did", async () => {
      // A third of the rows hold NULL. `note NOT IN (…)` is NULL for them, not
      // TRUE, and so is the negation of `note IN (…)`; both lists are long
      // enough to bind as one parameter.
      const others = padding(500, (index) => `other${index}`);
      const notIn = await client.order.findMany({
        where: { note: { notIn: ["n1", ...others] } },
        select: { id: true },
      });
      expect(notIn).toHaveLength(Math.floor(rows / 3));
      expect(
        await client.order.count({
          where: { NOT: { note: { in: ["n1", ...others] } } },
        })
      ).toBe(notIn.length);
      expect(
        await client.order.count({ where: { note: { in: ["n1", "n2"] } } })
      ).toBe(rows - Math.ceil(rows / 3));
    });

    test(`a ${BRANCHES.toLocaleString("en")}-branch OR on one column reads as that column's list`, async () => {
      const arms = ids.slice(0, BRANCHES).map((id) => ({ id }));
      const statement = await widest(async () => {
        expect(
          await client.order.findMany({
            where: { OR: arms },
            select: { id: true },
          })
        ).toHaveLength(BRANCHES);
      });
      expect(bound(statement)).toBe(1);
      // `{ equals }` arms and a negated chain read the same way.
      expect(
        await client.order.count({
          where: {
            NOT: {
              OR: ids.slice(0, BRANCHES).map((id) => ({ id: { equals: id } })),
            },
          },
        })
      ).toBe(rows - BRANCHES);
    });

    test.skipIf(options.crossColumnOr === false)(
      `a ${BRANCHES.toLocaleString("en")}-branch OR across columns still answers`,
      async () => {
        // Not one column, so not a list: the chain is lowered as a balanced
        // tree, a few levels deep rather than one level per arm.
        const arms = ids
          .slice(0, BRANCHES)
          .map((id) =>
            id % 2 === 0 ? { id } : { reference: `R${id}`, priority: 0 }
          );
        expect(await client.order.count({ where: { OR: arms } })).toBe(
          BRANCHES
        );
      }
    );

    // SQLite's expression depth only: PostgreSQL flattens either tree.
    test.skipIf(!sqlite || options.crossColumnOr === false)(
      `a ${BRANCHES.toLocaleString("en")}-member insensitive list still answers`,
      async () => {
        // Folded comparisons, one per member: a balanced tree as well. The
        // key range keeps the rows each member is folded against few.
        const references = ids.slice(0, BRANCHES).map((id) => `r${id}`);
        const id = { lte: 2 * BRANCHES };
        expect(
          await client.order.count({
            where: { id, reference: { in: references, mode: "insensitive" } },
          })
        ).toBe(BRANCHES);
        expect(
          await client.order.count({
            where: {
              id,
              reference: { notIn: references, mode: "insensitive" },
            },
          })
        ).toBe(Math.min(rows, 2 * BRANCHES) - BRANCHES);
      }
    );

    if (sqlite)
      test("the bound list still searches the index on SQLite", async () => {
        const plans: string[] = [];
        for (const where of [
          { id: { in: [3, 5, 8] } },
          { reference: { in: ["R3", "R5", "R8"] } },
        ]) {
          const statement = await widest(() =>
            client.order.findMany({ where, select: { id: true } })
          );
          expect(statement?.sql).toMatch(SQLITE_LIST);
          const plan = await base.$queryRawUnsafe<{ detail: string }>(
            `EXPLAIN QUERY PLAN ${statement?.sql}`,
            ...(statement?.params ?? [])
          );
          plans.push(plan.map((step) => step.detail).join(" | "));
        }
        expect(plans[0]).toMatch(KEY_SEARCH);
        expect(plans[1]).toMatch(INDEX_SEARCH);
        for (const plan of plans) expect(plan).not.toMatch(TABLE_SCAN);
      });
  });

  describe(`${options.name}: every field codec crosses the one bound list`, () => {
    beforeAll(async () => {
      // A server database outlives the run: start from no rows.
      await base.codec.deleteMany();
      await base.codec.createMany({
        data: UUIDS.map((id, index) => ({
          id,
          ref: ULIDS[index]!,
          big: BIGS[index]!,
          amount: AMOUNTS[index]!,
          at: new Date(INSTANTS[index]!),
        })),
      });
      if (sqlite)
        await base.epoch.createMany({
          data: INSTANTS.map((at, index) => ({
            id: index + 1,
            at: new Date(at),
          })),
        });
    });

    const cases = [
      {
        field: "id",
        members: [UUIDS[0], UUIDS[2]],
        pad: (index: number) =>
          `ffffffff-ffff-4fff-8fff-${index.toString(16).padStart(12, "0")}`,
      },
      {
        field: "ref",
        members: [ULIDS[0], ULIDS[2]],
        pad: (index: number) =>
          `7ZZZZZZZZZZZZZZZZZZZZZ${String(index).padStart(4, "0")}`,
      },
      {
        field: "big",
        members: [BIGS[0], BIGS[2]],
        pad: (index: number) => BigInt(index) * 1_000_003n + 7n,
      },
      {
        field: "amount",
        members: [AMOUNTS[0], AMOUNTS[2]],
        pad: (index: number) => `${index + 100}.07`,
      },
      {
        field: "at",
        members: [new Date(INSTANTS[0]!), new Date(INSTANTS[2]!)],
        pad: (index: number) => new Date(Date.UTC(1980, 0, 1, 0, 0, index)),
      },
    ] as const;

    for (const { field, members, pad } of cases)
      test(`${field}: in and notIn reach the stored rows`, async () => {
        const list = [...members, ...padding<unknown>(300, pad)];
        const matched = await widest(async () => {
          const found = await client.codec.findMany({
            where: { [field]: { in: list } },
            select: { id: true },
            orderBy: { id: "asc" },
          });
          expect(found.map((row) => row.id)).toEqual([UUIDS[0], UUIDS[2]]);
        });
        expect(bound(matched)).toBe(1);
        expect(
          await client.codec.findMany({
            where: { [field]: { notIn: list } },
            select: { id: true },
          })
        ).toEqual([{ id: UUIDS[1] }]);
      });

    if (sqlite)
      test("at stored as epoch milliseconds: the list binds the physical form", async () => {
        const list = [
          new Date(INSTANTS[1]!),
          ...padding(300, (index) => new Date(Date.UTC(1980, 0, 1, 0, index))),
        ];
        const statement = await widest(async () => {
          expect(
            await client.epoch.findMany({
              where: { at: { in: list } },
              select: { id: true },
            })
          ).toEqual([{ id: 2 }]);
        });
        expect(bound(statement)).toBe(1);
      });
  });
}
