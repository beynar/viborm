/**
 * The complete decimal-LIST surface (plan 6.3), run on both physical
 * representations and asserted identical.
 *
 * PGlite stores `NUMERIC(16,2)[]` — a native array whose members are exact
 * decimal text. SQLite3 stores TEXT holding a JSON array of unscaled
 * COEFFICIENT strings. Every spelling below has to answer the same thing on
 * both, and where the answer is the point it is written down, because two
 * providers can be identically wrong.
 *
 * The fixtures are chosen to discriminate:
 *
 *  - `1.2` and `120` are the SAME digits in the two vocabularies at scale 2, so
 *    a read or a filter that confuses them answers the other row;
 *  - `90071992547409.93` has a 16-digit coefficient one past 2^53, so any path
 *    that lets a member become a JavaScript number or a JSON numeric token
 *    collapses it onto its neighbour; and
 *  - one row holds `1.2` twice, so multiplicity is observable.
 *
 * `precision: 16, scale: 2` keeps `precision + scale <= 18`, SQLite's declared
 * field limit.
 */

import { createClient } from "@client/client";
import { PGliteDriver } from "@drivers/pglite";
import { SQLite3Driver } from "@drivers/sqlite3";
import { PGlite } from "@electric-sql/pglite";
import { s } from "@schema";
import { syncLiveSchema as push } from "@tests/fixtures/sync-schema";
import { canonicalizeDecimal } from "@validation/primitives/decimal-codec";
import Decimal from "decimal.js";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

const MONEY = { precision: 16, scale: 2 } as const;

/** A coefficient one past 2^53: 9007199254740993 at scale 2. */
const PAST_DOUBLE = "90071992547409.93";
/** Its neighbour, which shares a double with it. */
const PAST_DOUBLE_DOWN = "90071992547409.92";

const vault = s
  .model({
    id: s.string().id(),
    baskets: s.toMany(() => basket),
  })
  .map("decimal_list_vaults");

const basket = s
  .model({
    id: s.string().id(),
    amounts: s.decimal(MONEY).array(),
    optionalAmounts: s.decimal(MONEY).array().nullable(),
    vaultId: s.string(),
    vault: s
      .toOne(() => vault)
      .fields("vaultId")
      .references("id"),
  })
  .map("decimal_list_baskets");

const schema = { vault, basket };

type ListClient = ReturnType<typeof createPGliteClient>;

const createPGliteClient = () =>
  createClient({ schema, driver: new PGliteDriver({ client: new PGlite() }) });

const createSQLiteClient = () =>
  createClient({ schema, driver: new SQLite3Driver({ dataDir: ":memory:" }) });

const ROWS: Array<{
  id: string;
  amounts: string[];
  optionalAmounts: string[] | null;
  vaultId: string;
}> = [
  {
    id: "b1",
    amounts: ["1.2", "-0.03", PAST_DOUBLE],
    optionalAmounts: ["1.2"],
    vaultId: "v1",
  },
  { id: "b2", amounts: ["120", "1.2"], optionalAmounts: null, vaultId: "v1" },
  { id: "b3", amounts: [], optionalAmounts: [], vaultId: "v2" },
  {
    id: "b4",
    amounts: ["1.2", "1.2"],
    optionalAmounts: null,
    vaultId: "v2",
  },
];

const seed = async (client: ListClient): Promise<void> => {
  await client.vault.create({ data: { id: "v1" } });
  await client.vault.create({ data: { id: "v2" } });
  for (const row of ROWS) {
    await client.basket.create({ data: row });
  }
};

/**
 * Reduce a result to a comparable shape: a Decimal becomes its canonical text
 * through the one codec, so the two providers agree when they name the same
 * number. A physical coefficient string canonicalizes to ITSELF, so a missing
 * decode shows up as a difference rather than as an equality.
 */
const normalize = (value: unknown): unknown => {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map(normalize);
  if (typeof value === "object") {
    const decimal = canonicalizeDecimal(value);
    if (decimal !== undefined) return decimal;
    const entries = Object.entries(value).map(([key, member]) => [
      key,
      normalize(member),
    ]);
    entries.sort((left, right) =>
      String(left[0]).localeCompare(String(right[0]))
    );
    return Object.fromEntries(entries);
  }
  if (typeof value === "number") return canonicalizeDecimal(value);
  return value;
};

const ids = (rows: unknown): unknown =>
  Array.isArray(rows)
    ? rows.map((row) =>
        row && typeof row === "object" && "id" in row ? row.id : row
      )
    : rows;

type Spelling = {
  name: string;
  run: (client: ListClient) => PromiseLike<unknown>;
  expected?: unknown;
};

const SPELLINGS: Spelling[] = [
  // --- results ---
  {
    name: "findMany reads every member as an exact decimal",
    run: async (c) =>
      (
        await c.basket.findMany({
          select: { id: true, amounts: true, optionalAmounts: true },
          orderBy: { id: "asc" },
        })
      ).map((row) => [row.id, row.amounts, row.optionalAmounts]),
    expected: [
      ["b1", ["1.2", "-0.03", PAST_DOUBLE], ["1.2"]],
      ["b2", ["120", "1.2"], null],
      ["b3", [], []],
      ["b4", ["1.2", "1.2"], null],
    ],
  },
  {
    name: "a relation carrier rescales every member",
    run: async (c) =>
      (
        await c.vault.findMany({
          where: { id: "v1" },
          include: { baskets: { orderBy: { id: "asc" } } },
        })
      ).map((row) => row.baskets.map((b) => [b.id, b.amounts])),
    expected: [
      [
        ["b1", ["1.2", "-0.03", PAST_DOUBLE]],
        ["b2", ["120", "1.2"]],
      ],
    ],
  },
  {
    name: "a create RETURNS its own members",
    run: async (c) => {
      const created = await c.basket.create({
        data: {
          id: "returning-1",
          amounts: [PAST_DOUBLE, "-0.03"],
          optionalAmounts: null,
          vaultId: "v1",
        },
      });
      await c.basket.delete({ where: { id: "returning-1" } });
      return [created.amounts, created.optionalAmounts];
    },
    expected: [[PAST_DOUBLE, "-0.03"], null],
  },
  {
    name: "a bulk create round-trips every row's members",
    run: async (c) => {
      await c.basket.createMany({
        data: [
          { id: "bulk-1", amounts: ["1.2"], vaultId: "v1" },
          { id: "bulk-2", amounts: [PAST_DOUBLE, "1.2"], vaultId: "v1" },
        ],
      });
      const rows = await c.basket.findMany({
        where: { id: { in: ["bulk-1", "bulk-2"] } },
        orderBy: { id: "asc" },
        select: { amounts: true },
      });
      await c.basket.deleteMany({
        where: { id: { in: ["bulk-1", "bulk-2"] } },
      });
      return rows.map((row) => row.amounts);
    },
    expected: [["1.2"], [PAST_DOUBLE, "1.2"]],
  },

  // --- equality: order and multiplicity ---
  {
    name: "equals preserves order",
    run: async (c) =>
      ids(
        await c.basket.findMany({
          where: { amounts: { equals: ["1.2", "-0.03", PAST_DOUBLE] } },
        })
      ),
    expected: ["b1"],
  },
  {
    name: "equals is not containment: a reordered list matches nothing",
    run: async (c) =>
      ids(
        await c.basket.findMany({
          where: { amounts: { equals: [PAST_DOUBLE, "1.2", "-0.03"] } },
        })
      ),
    expected: [],
  },
  {
    name: "equals preserves multiplicity",
    run: async (c) =>
      ids(await c.basket.findMany({ where: { amounts: { equals: ["1.2"] } } })),
    expected: [],
  },
  {
    name: "the whole-list shorthand equals",
    run: async (c) =>
      ids(await c.basket.findMany({ where: { amounts: ["1.2", "1.2"] } })),
    expected: ["b4"],
  },
  {
    name: "equals an empty list",
    run: async (c) =>
      ids(await c.basket.findMany({ where: { amounts: { equals: [] } } })),
    expected: ["b3"],
  },
  {
    name: "nested not on a whole list",
    run: async (c) =>
      ids(
        await c.basket.findMany({
          where: { amounts: { not: { equals: ["1.2", "1.2"] } } },
          orderBy: { id: "asc" },
        })
      ),
    expected: ["b1", "b2", "b3"],
  },
  {
    name: "shorthand not on a whole list",
    run: async (c) =>
      ids(
        await c.basket.findMany({
          where: { amounts: { not: ["1.2", "1.2"] } },
          orderBy: { id: "asc" },
        })
      ),
    expected: ["b1", "b2", "b3"],
  },

  // --- containment: the two vocabularies must not be confused ---
  {
    name: "has the logical value 1.2",
    run: async (c) =>
      ids(
        await c.basket.findMany({
          where: { amounts: { has: "1.2" } },
          orderBy: { id: "asc" },
        })
      ),
    expected: ["b1", "b2", "b4"],
  },
  {
    name: "has the logical value 120 — the SAME digits as 1.2's coefficient",
    run: async (c) =>
      ids(await c.basket.findMany({ where: { amounts: { has: "120" } } })),
    expected: ["b2"],
  },
  {
    name: "has a member past 2^53",
    run: async (c) =>
      ids(
        await c.basket.findMany({ where: { amounts: { has: PAST_DOUBLE } } })
      ),
    expected: ["b1"],
  },
  {
    name: "has the neighbour that shares a double with it",
    run: async (c) =>
      ids(
        await c.basket.findMany({
          where: { amounts: { has: PAST_DOUBLE_DOWN } },
        })
      ),
    expected: [],
  },
  {
    name: "has a value spelled with insignificant zeros",
    run: async (c) =>
      ids(
        await c.basket.findMany({
          where: { amounts: { has: "1.20" } },
          orderBy: { id: "asc" },
        })
      ),
    expected: ["b1", "b2", "b4"],
  },
  {
    name: "has a Decimal instance",
    run: async (c) =>
      ids(
        await c.basket.findMany({
          where: { amounts: { has: new Decimal("-0.03") } },
        })
      ),
    expected: ["b1"],
  },
  {
    name: "hasEvery",
    run: async (c) =>
      ids(
        await c.basket.findMany({
          where: { amounts: { hasEvery: ["1.2", "-0.03"] } },
        })
      ),
    expected: ["b1"],
  },
  {
    name: "hasEvery an empty candidate list matches every row",
    run: async (c) =>
      ids(
        await c.basket.findMany({
          where: { amounts: { hasEvery: [] } },
          orderBy: { id: "asc" },
        })
      ),
    expected: ["b1", "b2", "b3", "b4"],
  },
  {
    name: "hasSome",
    run: async (c) =>
      ids(
        await c.basket.findMany({
          where: { amounts: { hasSome: ["-0.03", "120"] } },
          orderBy: { id: "asc" },
        })
      ),
    expected: ["b1", "b2"],
  },
  {
    name: "hasSome an empty candidate list matches nothing",
    run: async (c) =>
      ids(await c.basket.findMany({ where: { amounts: { hasSome: [] } } })),
    expected: [],
  },
  {
    name: "isEmpty",
    run: async (c) =>
      ids(await c.basket.findMany({ where: { amounts: { isEmpty: true } } })),
    expected: ["b3"],
  },
  {
    name: "isEmpty false",
    run: async (c) =>
      ids(
        await c.basket.findMany({
          where: { amounts: { isEmpty: false } },
          orderBy: { id: "asc" },
        })
      ),
    expected: ["b1", "b2", "b4"],
  },

  // --- nullable whole-list behavior ---
  {
    name: "a null list is not an empty list",
    run: async (c) =>
      ids(
        await c.basket.findMany({
          where: { optionalAmounts: { equals: null } },
          orderBy: { id: "asc" },
        })
      ),
    expected: ["b2", "b4"],
  },
  {
    name: "isEmpty on a nullable column counts the null column too",
    run: async (c) =>
      ids(
        await c.basket.findMany({
          where: { optionalAmounts: { isEmpty: true } },
          orderBy: { id: "asc" },
        })
      ),
    expected: ["b2", "b3", "b4"],
  },
  {
    name: "has never matches a null column",
    run: async (c) =>
      ids(
        await c.basket.findMany({ where: { optionalAmounts: { has: "1.2" } } })
      ),
    expected: ["b1"],
  },
  {
    name: "hasEvery an empty candidate matches every present list",
    run: async (c) =>
      ids(
        await c.basket.findMany({
          where: { optionalAmounts: { hasEvery: [] } },
          orderBy: { id: "asc" },
        })
      ),
    expected: ["b1", "b3"],
  },
  {
    name: "hasSome an empty candidate never matches a nullable column",
    run: async (c) =>
      ids(
        await c.basket.findMany({
          where: { optionalAmounts: { hasSome: [] } },
        })
      ),
    expected: [],
  },

  // --- updates ---
  {
    name: "set replaces the whole list",
    run: async (c) => {
      await c.basket.create({
        data: { id: "u-set", amounts: ["1.2"], vaultId: "v1" },
      });
      const updated = await c.basket.update({
        where: { id: "u-set" },
        data: { amounts: { set: [PAST_DOUBLE, "-0.03"] } },
      });
      await c.basket.delete({ where: { id: "u-set" } });
      return updated.amounts;
    },
    expected: [PAST_DOUBLE, "-0.03"],
  },
  {
    name: "the whole-list update shorthand",
    run: async (c) => {
      await c.basket.create({
        data: { id: "u-short", amounts: ["1.2"], vaultId: "v1" },
      });
      const updated = await c.basket.update({
        where: { id: "u-short" },
        data: { amounts: ["120"] },
      });
      await c.basket.delete({ where: { id: "u-short" } });
      return updated.amounts;
    },
    expected: ["120"],
  },
  {
    name: "push one",
    run: async (c) => {
      await c.basket.create({
        data: { id: "u-push1", amounts: ["1.2"], vaultId: "v1" },
      });
      const updated = await c.basket.update({
        where: { id: "u-push1" },
        data: { amounts: { push: PAST_DOUBLE } },
      });
      await c.basket.delete({ where: { id: "u-push1" } });
      return updated.amounts;
    },
    expected: ["1.2", PAST_DOUBLE],
  },
  {
    name: "push many",
    run: async (c) => {
      await c.basket.create({
        data: { id: "u-pushn", amounts: ["1.2"], vaultId: "v1" },
      });
      const updated = await c.basket.update({
        where: { id: "u-pushn" },
        data: { amounts: { push: ["-0.03", "120"] } },
      });
      await c.basket.delete({ where: { id: "u-pushn" } });
      return updated.amounts;
    },
    expected: ["1.2", "-0.03", "120"],
  },
  {
    name: "push zero",
    run: async (c) => {
      await c.basket.create({
        data: { id: "u-push0", amounts: ["1.2"], vaultId: "v1" },
      });
      const updated = await c.basket.update({
        where: { id: "u-push0" },
        data: { amounts: { push: [] } },
      });
      await c.basket.delete({ where: { id: "u-push0" } });
      return updated.amounts;
    },
    expected: ["1.2"],
  },
  {
    name: "push onto a null column",
    run: async (c) => {
      await c.basket.create({
        data: {
          id: "u-pushnull",
          amounts: ["1.2"],
          optionalAmounts: null,
          vaultId: "v1",
        },
      });
      const updated = await c.basket.update({
        where: { id: "u-pushnull" },
        data: { optionalAmounts: { push: "-0.03" } },
      });
      await c.basket.delete({ where: { id: "u-pushnull" } });
      return updated.optionalAmounts;
    },
    expected: ["-0.03"],
  },
  {
    name: "unshift one",
    run: async (c) => {
      await c.basket.create({
        data: { id: "u-un1", amounts: ["1.2"], vaultId: "v1" },
      });
      const updated = await c.basket.update({
        where: { id: "u-un1" },
        data: { amounts: { unshift: PAST_DOUBLE } },
      });
      await c.basket.delete({ where: { id: "u-un1" } });
      return updated.amounts;
    },
    expected: [PAST_DOUBLE, "1.2"],
  },
  {
    name: "unshift many",
    run: async (c) => {
      await c.basket.create({
        data: { id: "u-unn", amounts: ["1.2"], vaultId: "v1" },
      });
      const updated = await c.basket.update({
        where: { id: "u-unn" },
        data: { amounts: { unshift: ["-0.03", "120"] } },
      });
      await c.basket.delete({ where: { id: "u-unn" } });
      return updated.amounts;
    },
    expected: ["-0.03", "120", "1.2"],
  },
  {
    name: "unshift zero",
    run: async (c) => {
      await c.basket.create({
        data: { id: "u-un0", amounts: ["1.2"], vaultId: "v1" },
      });
      const updated = await c.basket.update({
        where: { id: "u-un0" },
        data: { amounts: { unshift: [] } },
      });
      await c.basket.delete({ where: { id: "u-un0" } });
      return updated.amounts;
    },
    expected: ["1.2"],
  },
  {
    name: "a whole list can be set to null and back",
    run: async (c) => {
      await c.basket.create({
        data: {
          id: "u-null",
          amounts: ["1.2"],
          optionalAmounts: ["1.2"],
          vaultId: "v1",
        },
      });
      const cleared = await c.basket.update({
        where: { id: "u-null" },
        data: { optionalAmounts: { set: null } },
      });
      const restored = await c.basket.update({
        where: { id: "u-null" },
        data: { optionalAmounts: ["-0.03"] },
      });
      await c.basket.delete({ where: { id: "u-null" } });
      return [cleared.optionalAmounts, restored.optionalAmounts];
    },
    expected: [null, ["-0.03"]],
  },
];

describe("decimal lists have one answer on both physical representations", () => {
  let exact: ListClient;
  let coefficients: ListClient;

  beforeAll(async () => {
    exact = createPGliteClient();
    coefficients = createSQLiteClient();
    for (const client of [exact, coefficients]) {
      await push(client, { force: true });
      await seed(client);
    }
  }, 120_000);

  afterAll(async () => {
    await exact?.$disconnect();
    await coefficients?.$disconnect();
  });

  for (const { name, run, expected } of SPELLINGS) {
    test(`${name} — the same exact answer on both`, async () => {
      const fromExact = normalize(await run(exact));
      const fromCoefficients = normalize(await run(coefficients));

      expect(fromCoefficients).toEqual(fromExact);
      if (expected !== undefined) {
        expect(fromExact).toEqual(normalize(expected));
      }
    });
  }

  test("every typed member is a fresh Decimal, never the stored container", async () => {
    for (const client of [exact, coefficients]) {
      const first = await client.basket.findUnique({ where: { id: "b1" } });
      const second = await client.basket.findUnique({ where: { id: "b1" } });
      const members = first?.amounts ?? [];

      expect(members).toHaveLength(3);
      for (const member of members) {
        expect(member).toBeInstanceOf(Decimal);
      }
      expect(members[0]).not.toBe(second?.amounts[0]);
      expect(members[2]?.toFixed()).toBe(PAST_DOUBLE);
    }
  });

  test("the SQLite column holds coefficient STRINGS and no numeric token", async () => {
    const driver = new SQLite3Driver({ dataDir: ":memory:" });
    const client = createClient({ schema, driver });
    await push(client, { force: true });
    await seed(client);

    const stored = await driver._executeRaw<{ amounts: string }>(
      `SELECT "amounts" FROM "decimal_list_baskets" WHERE "id" = 'b1'`
    );

    expect(stored.rows[0]?.amounts).toBe('["120","-3","9007199254740993"]');
    await client.$disconnect();
  });

  test("the PostgreSQL column is a native numeric array, read element-wise", async () => {
    const database = new PGlite();
    const driver = new PGliteDriver({ client: database });
    const client = createClient({ schema, driver });
    await push(client, { force: true });
    await seed(client);

    const type = await driver._executeRaw<{ format_type: string }>(
      `SELECT format_type(a.atttypid, a.atttypmod) FROM pg_attribute a
         JOIN pg_class c ON c.oid = a.attrelid
        WHERE c.relname = 'decimal_list_baskets' AND a.attname = 'amounts'`
    );
    expect(type.rows[0]?.format_type).toBe("numeric(16,2)[]");

    // The carrier must not put a member through a JSON NUMBER: the value past
    // 2^53 is the one that proves it.
    const carrier = await driver._executeRaw<{ j: unknown }>(
      `SELECT json_build_object('amounts', CAST("amounts" AS TEXT[])) AS j
         FROM "decimal_list_baskets" WHERE "id" = 'b1'`
    );
    expect(JSON.stringify(carrier.rows[0]?.j)).toContain('"90071992547409.93"');

    await client.$disconnect();
  });
});
