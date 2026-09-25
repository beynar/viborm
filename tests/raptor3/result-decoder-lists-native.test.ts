/**
 * The LIST leaf of the one result decoder on a NATIVE provider
 * (`docs/architecture/raptor3-compiled-list-decoder-plan.md`, work unit 3).
 *
 * `result-decoder-lists.test.ts` pins the list reader over SQLite and scripted
 * transports. SQLite hands every list as JSON text, so it cannot qualify what
 * a native provider hands the reader, and `g4/native/read-envelope-native.test.ts`
 * carries no scalar list. The columns here are the ones the product's own
 * migration creates, and the representations they reach the reader in were
 * observed on PostgreSQL 16 and MySQL 8 (`pg` 8, `mysql2` 3):
 *
 *  - PostgreSQL: `text[]`, `boolean[]`, `integer[]`, `double precision[]`,
 *    `bigint[]`, `timestamptz[]` and `timetz[]` arrive as driver-parsed
 *    arrays; the enum array as its own array TEXT (`{HIGH,LOW}`); the
 *    `NUMERIC(p,s)[]` list through its `TEXT[]` projection. A to-many row or a
 *    variant arm carries every list as a JSON array inside the document.
 *  - MySQL: every list is a `JSON` column the driver parses into an array,
 *    except the decimal list, which the projection hands as JSON TEXT of
 *    scale-`s` coefficients, at the root and inside a carried document alike.
 *
 * Covered: every list kind below, empty and populated, at the physical root,
 * in RETURNING answers (create, update with `push`, delete) and a borrowed
 * transaction; the same lists carried in a to-many relation's rows and a
 * variant arm's document; malformed native members, physical and carried; and
 * two clients bound to distinct result parsers reading concurrently, each
 * through its own binding, into fresh containers.
 *
 * NOT covered, and why: a `date` list, which the one shared fixture cannot
 * carry on PostgreSQL (the `pg` driver's `utcSafeTypes` keeps DATE as text but
 * not DATE[], so the members arrive as process-local Dates and the date codec
 * refuses them outside a UTC process); a malformed CONTAINER, which no native
 * list column can hold on PostgreSQL (the SQLite pins own it);
 * and a `bigint` list member beyond 2^53 CARRIED on PostgreSQL (the relation
 * document holds `bigint[]` members as JSON numbers, so such a member is
 * refused as not canonical). Both answer identically at `544ab9465` and belong
 * to the driver and the relation projection, not to the list reader: the
 * carried `bigint` list here stays inside the safe range, and the wide member
 * is read at physical placements only, on `tally`. An identifier-generator
 * list (`s.string().uuid().array()`) cannot be created on PostgreSQL
 * (`text[] DEFAULT gen_random_uuid()`); its SQLite pins stay in
 * `result-decoder-lists.test.ts`.
 *
 * Every expected value is the value the test wrote, or the baseline's
 * published sentence (`544ab9465`). The provider decides only the physical
 * spelling of setup SQL, never which expectation is checked. Each run owns a
 * fresh PostgreSQL schema or MySQL database and drops it afterwards.
 *
 * Registered in `RESULT_DECODER_NATIVE_COUNTS`, which both native
 * read-envelope modes run; skipped unless `VIBORM_RAPTOR3_PROVIDER` names
 * `pg` or `mysql` and `VIBORM_RAPTOR3_PROVIDER_PORT` its loopback port.
 */

import { randomUUID } from "node:crypto";
import { createClient } from "@client/client";
import type { AnyDriver, DriverResultParser } from "@drivers";
import { MySQL2Driver } from "@drivers/mysql2";
import { PgDriver } from "@drivers/pg";
import { QueryEngineError } from "@errors";
import { s } from "@schema";
import { Decimal } from "@src/index";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import { canonicalizeDecimal } from "@validation/primitives/decimal-codec";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const provider = process.env.VIBORM_RAPTOR3_PROVIDER;
const port = Number(process.env.VIBORM_RAPTOR3_PROVIDER_PORT ?? "0");
const live = (provider === "pg" || provider === "mysql") && port > 0;

const MONEY = { precision: 12, scale: 2 } as const;
const LEVELS = ["LOW", "HIGH"] as const;

const crate = s
  .model({
    id: s.int().id(),
    label: s.string(),
    boxes: s.toMany(() => box),
  })
  .map("native_list_crates");
const box = s
  .model({
    id: s.int().id(),
    tags: s.string().array(),
    flags: s.boolean().array(),
    counts: s.int().array(),
    ratios: s.number().array(),
    bigs: s.bigInt().array(),
    amounts: s.decimal(MONEY).array(),
    moments: s.dateTime().array(),
    clocks: s.time().array(),
    levels: s.enum([...LEVELS]).array(),
    maybeTags: s.string().array().nullable(),
    document: s.json(),
    crateId: s.int().nullable(),
    crate: s
      .toOne(() => crate)
      .fields("crateId")
      .references("id"),
  })
  .map("native_list_boxes");
/** A `bigint` list with a member beyond 2^53, read at physical placements. */
const tally = s
  .model({ id: s.int().id(), bigs: s.bigInt().array() })
  .map("native_list_tallies");
const other = s
  .model({ id: s.int().id(), title: s.string() })
  .map("native_list_others");
const pin = s
  .model({
    id: s.int().id(),
    subject: s.toOne({ box: () => box, other: () => other }).optional(),
  })
  .map("native_list_pins");
const schema = { crate, box, tally, other, pin };

/** Every list of `box`, selected, beside its key and a JSON array document. */
const LISTS = {
  id: true,
  tags: true,
  flags: true,
  counts: true,
  ratios: true,
  bigs: true,
  amounts: true,
  moments: true,
  clocks: true,
  levels: true,
  maybeTags: true,
  document: true,
} as const;

/** Two boxes as WRITTEN, every list kind: one populated, one empty. */
const FULL_BOX = {
  id: 1,
  // Members that are array-text syntax on PostgreSQL stay plain text.
  tags: ["alpha", "b,c", '"q"', "", "NULL", "{x}"],
  flags: [true, false],
  counts: [7, -8, 0],
  ratios: [1.5, -0.25],
  bigs: [42n, -1n, 0n],
  amounts: ["1.5", "-0.01", "0"],
  moments: [
    new Date("2026-03-05T06:07:08.123Z"),
    new Date("1969-12-31T23:59:59.999Z"),
  ],
  clocks: ["06:07:08.123", "23:59:59"],
  levels: ["HIGH", "LOW", "HIGH"] as ("LOW" | "HIGH")[],
  maybeTags: ["x"],
  // A JSON field whose document is an array is a document, not a list.
  document: ["not", "a", "list", 1],
  crateId: 10,
};
const EMPTY_BOX = {
  id: 2,
  tags: [],
  flags: [],
  counts: [],
  ratios: [],
  bigs: [],
  amounts: [],
  moments: [],
  clocks: [],
  levels: [],
  maybeTags: null,
  document: [],
  crateId: 10,
};
const TALLIES = [
  { id: 1, bigs: [9_007_199_254_740_993n, -1n, 0n] },
  { id: 2, bigs: [] },
];
type WrittenBox = typeof FULL_BOX | typeof EMPTY_BOX;

/** A written box as the public read answers it. */
function answered(row: WrittenBox) {
  const { crateId: _crate, ...lists } = row;
  return lists;
}

/** A published box with its decimal members spelled as canonical text. */
function spelled(row: unknown): unknown {
  if (row === null || typeof row !== "object") return row;
  const amounts = Reflect.get(row, "amounts");
  return {
    ...row,
    amounts: Array.isArray(amounts)
      ? amounts.map((member) =>
          member instanceof Decimal ? canonicalizeDecimal(member) : member
        )
      : amounts,
  };
}

/** The error an operation rejects with; resolving is itself a failure. */
async function rejection(read: PromiseLike<unknown>): Promise<any> {
  try {
    await read;
  } catch (error) {
    return error;
  }
  throw new Error("the operation was expected to reject");
}

const namespace = `lists_${randomUUID().replaceAll("-", "").slice(0, 20)}`;
const url =
  provider === "pg"
    ? `postgresql://postgres@127.0.0.1:${port}/raptor3_g2`
    : `mysql://root@127.0.0.1:${port}/raptor3_g2`;
const driverName = provider === "pg" ? "pg" : "mysql2";

/** A driver over this run's own namespace. */
function nativeDriver(): AnyDriver {
  return provider === "pg"
    ? new PgDriver({ databaseUrl: url, namespace })
    : new MySQL2Driver({
        databaseUrl: url,
        namespace,
        migrationNamespaceAttestation: "non-redirecting",
      });
}

/** A driver over the database's default namespace, for setup only. */
function setupDriver(): AnyDriver {
  return provider === "pg"
    ? new PgDriver({ databaseUrl: url })
    : new MySQL2Driver({ databaseUrl: url });
}

/** The provider's quoted spelling of one identifier. */
function quote(identifier: string): string {
  return provider === "pg" ? `"${identifier}"` : `\`${identifier}\``;
}

/** The provider's spelling of one list VALUE in raw SQL. */
function listLiteral(pg: string, mysql: unknown[]): string {
  return provider === "pg" ? pg : `'${JSON.stringify(mysql)}'`;
}

/** The public malformed-result sentence for one scalar type and reason. */
const malformed = (type: string, reason: string) =>
  `Driver "${driverName}" returned a malformed ${type} scalar for operation "findMany": ${reason}.`;

/**
 * Malformed list values a native column can hold, each with its column, its
 * scalar type and the reason the list reader owes. The provider spells the
 * SQL; the expectation is one.
 */
const MALFORMED: readonly {
  column: "counts" | "tags" | "maybeTags" | "amounts";
  value: string;
  type: string;
  reason: string;
}[] = [
  {
    column: "counts",
    value: listLiteral("ARRAY[1,NULL]::integer[]", [1, null]),
    type: "int",
    reason: "a required scalar is null",
  },
  {
    column: "counts",
    value: listLiteral("ARRAY[[1,2],[3,4]]::integer[]", [
      [1, 2],
      [3, 4],
    ]),
    type: "int",
    reason: "the value is not a canonical integer",
  },
  {
    column: "tags",
    value: listLiteral("ARRAY['a',NULL]::text[]", ["a", null]),
    type: "string",
    reason: "a required scalar is null",
  },
  {
    column: "maybeTags",
    value: listLiteral("ARRAY[NULL]::text[]", [null]),
    type: "string",
    reason: "a required scalar is null",
  },
  {
    column: "amounts",
    value: listLiteral("ARRAY[1.5,NULL]::numeric(12,2)[]", ["150", null]),
    type: "decimal",
    reason:
      "the value is not an exact decimal list in this column's declared domain",
  },
];

describe.runIf(live)(`native ${provider} list decoding`, () => {
  const setup = live ? setupDriver() : undefined;
  const driver = live ? nativeDriver() : undefined;
  const client = driver ? createClient({ schema, driver }) : undefined;
  const boxes = `${quote(namespace)}.${quote("native_list_boxes")}`;

  beforeAll(async () => {
    if (!(setup && client)) return;
    await setup._executeRaw(
      provider === "pg"
        ? `CREATE SCHEMA ${quote(namespace)}`
        : `CREATE DATABASE ${quote(namespace)}`
    );
    await syncLiveSchema(client);
    await client.crate.create({ data: { id: 10, label: "listed" } });
    await client.crate.create({ data: { id: 11, label: "malformed" } });
    await client.other.create({ data: { id: 20, title: "other" } });
    for (const row of [FULL_BOX, EMPTY_BOX])
      await client.box.create({ data: row });
    for (const row of TALLIES) await client.tally.create({ data: row });
    await client.pin.create({
      data: {
        id: 30,
        subject: { connect: { type: "box", where: { id: 1 } } },
      },
    });
  });

  afterAll(async () => {
    await client?.$disconnect();
    await setup?._executeRaw(
      provider === "pg"
        ? `DROP SCHEMA IF EXISTS ${quote(namespace)} CASCADE`
        : `DROP DATABASE IF EXISTS ${quote(namespace)}`
    );
    await setup?.disconnect();
  });

  it("publishes every list kind as written at the physical root, in RETURNING answers and in a borrowed transaction", async () => {
    if (!client) throw new Error("no live client");
    const expected = [FULL_BOX, EMPTY_BOX].map(answered);
    const root = await client.box.findMany({
      select: LISTS,
      orderBy: { id: "asc" },
    });
    expect(root.map(spelled)).toEqual(expected);
    expect(
      await client.tally.findMany({ orderBy: { id: "asc" } })
    ).toStrictEqual(TALLIES);

    const created = await client.box.create({
      data: { ...FULL_BOX, id: 3, crateId: null },
      select: LISTS,
    });
    expect(spelled(created)).toEqual({ ...answered(FULL_BOX), id: 3 });
    const updated = await client.box.update({
      where: { id: 3 },
      data: { counts: { push: [9] }, levels: { push: ["LOW"] } },
      select: LISTS,
    });
    const pushed = {
      ...answered(FULL_BOX),
      id: 3,
      counts: [7, -8, 0, 9],
      levels: ["HIGH", "LOW", "HIGH", "LOW"],
    };
    expect(spelled(updated)).toEqual(pushed);
    expect(
      await client.tally.create({ data: { id: 3, bigs: [-2n] } })
    ).toStrictEqual({ id: 3, bigs: [-2n] });

    const borrowed = await client.$transaction(async (tx) => ({
      boxes: await tx.box.findMany({ select: LISTS, orderBy: { id: "asc" } }),
      tallies: await tx.tally.findMany({ orderBy: { id: "asc" } }),
    }));
    expect(borrowed.boxes.map(spelled)).toEqual([...expected, pushed]);
    expect(borrowed.tallies).toStrictEqual([
      ...TALLIES,
      { id: 3, bigs: [-2n] },
    ]);

    const deleted = await client.box.delete({
      where: { id: 3 },
      select: LISTS,
    });
    expect(spelled(deleted)).toEqual(pushed);
    expect(await client.tally.delete({ where: { id: 3 } })).toStrictEqual({
      id: 3,
      bigs: [-2n],
    });
  });

  it("publishes carried lists as written in a to-many relation's rows and a variant arm's document", async () => {
    if (!client) throw new Error("no live client");
    const expected = [FULL_BOX, EMPTY_BOX].map(answered);
    const [carrier] = await client.crate.findMany({
      where: { id: 10 },
      select: { id: true, boxes: { select: LISTS, orderBy: { id: "asc" } } },
    });
    expect(carrier?.boxes.map(spelled)).toEqual(expected);
    const [pinned] = await client.pin.findMany({
      select: { id: true, subject: true },
    });
    expect(pinned?.subject?.type).toBe("box");
    expect(spelled(pinned?.subject?.data)).toEqual({
      ...answered(FULL_BOX),
      crateId: 10,
    });
    // One statement holds a physical and a carried placement of the same list
    // leaves; each placement is read by its own reader.
    const [both] = await client.box.findMany({
      where: { id: 1 },
      select: {
        ...LISTS,
        crate: {
          select: { boxes: { select: LISTS, orderBy: { id: "asc" } } },
        },
      },
    });
    const { crate: carried, ...physical } = both ?? {};
    expect(spelled(physical)).toEqual(answered(FULL_BOX));
    expect(carried?.boxes.map(spelled)).toEqual(expected);
  });

  it("refuses a malformed native list member at the physical root and carried, with the baseline's sentence", async () => {
    if (!(client && setup)) throw new Error("no live client");
    await client.box.create({ data: { ...EMPTY_BOX, id: 4, crateId: 11 } });
    const restore = `UPDATE ${boxes} SET ${quote("counts")} = ${listLiteral("'{}'", [])}, ${quote("tags")} = ${listLiteral("'{}'", [])}, ${quote("maybeTags")} = NULL, ${quote("amounts")} = ${listLiteral("'{}'", [])} WHERE id = 4`;
    try {
      for (const { column, value, type, reason } of MALFORMED) {
        await setup._executeRaw(
          `UPDATE ${boxes} SET ${quote(column)} = ${value} WHERE id = 4`
        );
        const physical = await rejection(
          client.box.findMany({
            where: { id: 4 },
            select: { id: true, [column]: true },
          })
        );
        expect(physical).toBeInstanceOf(QueryEngineError);
        expect(physical.message).toBe(malformed(type, reason));
        const carried = await rejection(
          client.crate.findMany({
            where: { id: 11 },
            select: {
              id: true,
              boxes: { select: { id: true, [column]: true } },
            },
          })
        );
        expect(carried).toBeInstanceOf(QueryEngineError);
        expect(carried.message).toBe(malformed(type, reason));
        await setup._executeRaw(restore);
      }
    } finally {
      await setup._executeRaw(restore);
      await client.box.delete({ where: { id: 4 } });
    }
  });

  it("reads concurrently through two clients' distinct result parsers, each into fresh containers", async () => {
    const asks: Record<"plain" | "marked", string[]> = {
      plain: [],
      marked: [],
    };
    /** A parser that records each ask; `marked` also suffixes string lists. */
    const parser = (name: "plain" | "marked"): DriverResultParser => ({
      parseField: (value, type, next) => {
        asks[name].push(type);
        const parsed = next(value, type);
        return name === "marked" && type === "string" && Array.isArray(parsed)
          ? parsed.map((member) => `${member}!`)
          : parsed;
      },
    });
    const bound = (name: "plain" | "marked") => {
      const own = nativeDriver();
      Object.defineProperty(own, "result", {
        configurable: true,
        value: parser(name),
      });
      return createClient({ schema, driver: own });
    };
    const plain = bound("plain");
    const marked = bound("marked");
    const select = {
      id: true,
      tags: true,
      counts: true,
      maybeTags: true,
    } as const;
    try {
      const reads = await Promise.all(
        [plain, marked, plain, marked, plain, marked].map((reader) =>
          reader.box.findMany({ select, orderBy: { id: "asc" } })
        )
      );
      for (const [index, rows] of reads.entries())
        expect(rows).toEqual(
          index % 2 === 0
            ? [
                {
                  id: 1,
                  tags: FULL_BOX.tags,
                  counts: [7, -8, 0],
                  maybeTags: ["x"],
                },
                { id: 2, tags: [], counts: [], maybeTags: null },
              ]
            : [
                {
                  id: 1,
                  tags: FULL_BOX.tags.map((tag) => `${tag}!`),
                  counts: [7, -8, 0],
                  maybeTags: ["x!"],
                },
                { id: 2, tags: [], counts: [], maybeTags: null },
              ]
        );
      // Per read: each row's key and one ask per PHYSICAL list; row 2's null
      // `maybeTags` never reaches the chain.
      const perRead = [
        "int",
        "string",
        "int",
        "string",
        "int",
        "string",
        "int",
      ];
      for (const name of ["plain", "marked"] as const)
        expect([...asks[name]].sort()).toEqual(
          [...perRead, ...perRead, ...perRead].sort()
        );
      const published = reads.flatMap((rows) => rows.map((row) => row.tags));
      expect(new Set(published).size).toBe(published.length);
    } finally {
      await plain.$disconnect();
      await marked.$disconnect();
    }
  });
});
