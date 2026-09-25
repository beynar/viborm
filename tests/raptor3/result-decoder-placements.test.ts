// biome-ignore-all lint/suspicious/noMisplacedAssertion: the comparison helper is invoked only from registered tests.
/**
 * The one result decoder, qualified at EVERY placement it serves
 * (`docs/architecture/raptor3-compiled-decoder-plan.md`, CD-03).
 *
 * `result-decoder.test.ts` pins each shared rule at the placement that owns
 * it. This file executes the SECOND and later placements of the same rules on
 * a real SQLite database through the public client, so none of them is
 * asserted from code inspection:
 *
 *  - every scalar codec SQLite stores (string, int, float, exact decimal,
 *    wide bigint, boolean, DateTime, date, time, json with prototype-hostile
 *    keys, a TRANSFORMING json output schema, blob, enum, point, vector, and
 *    string/decimal/DateTime lists), required, nullable-and-null and
 *    nullable-and-set, read as a PHYSICAL row (root read, create/update
 *    RETURNING, selected createMany/updateMany/deleteMany series, packaged
 *    array member, borrowed interactive transaction, cached miss and hit,
 *    another driver's execution of the same prepared operation) and as a
 *    CARRIED document (to-one, reversed to-many, variant arm, recursive node
 *    row, aggregate carrier);
 *  - the provider `parseField` chain is asked for a physical cell and never
 *    for a carried one, and the chain that runs is the EXECUTION's, also when
 *    two clients with different driver parsers over the same model
 *    definitions decode concurrently;
 *  - the own-key and document rules at the variant arm and the recursive
 *    node row, and a to-one relation document that is no document.
 *
 * Every expected value is the value the test WROTE (the public round-trip
 * contract) or the baseline's published sentence; the parser's mark is what
 * separates a physical answer from a carried one. Operations are invoked
 * untyped (`Reflect.apply`): the cells vary placements, not the static
 * surface, and the full client type of this schema is not instantiated.
 */

import assert from "node:assert/strict";
import { MemoryCache } from "@cache/drivers/memory";
import { cache } from "@cache/extension";
import { createClient } from "@client/client";
import type { Dialect, DriverResultParser } from "@drivers";
import { Driver } from "@drivers";
import { SQLite3Driver } from "@drivers/sqlite3";
import { QueryEngineError } from "@errors";
import { s } from "@schema";
import { DbNull, Decimal, JsonNull } from "@src/index";
import type { JsonValue } from "@src/validation";
import { isRecord } from "@src/validation/value-guards";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import { readTestTransactionOperation } from "@tests/fixtures/transaction-operation";
import { canonicalizeDecimal } from "@validation/primitives/decimal-codec";
import { describe, it } from "vitest";

const MONEY = { precision: 12, scale: 6 } as const;

/** A TRANSFORMING, idempotent output schema: `{ n }` reads as `{ n, seen }`. */
const seen: StandardSchemaV1<JsonValue, { n: number; seen: true }> = {
  "~standard": {
    version: 1,
    vendor: "cd03",
    validate(value) {
      if (!isRecord(value) || typeof value.n !== "number")
        return { issues: [{ message: "cd03: not { n }" }] };
      return { value: { n: value.n, seen: true } };
    },
  },
};

const full = s
  .model({
    id: s.string().id(),
    text: s.string(),
    note: s.string().nullable(),
    count: s.int(),
    ratio: s.number(),
    price: s.decimal(MONEY),
    views: s.bigInt(),
    active: s.boolean(),
    happenedAt: s.dateTime(),
    bornOn: s.date(),
    wakeAt: s.time(),
    meta: s.json(),
    checked: s.json().schema(seen),
    payload: s.blob(),
    kind: s.enum(["alpha", "beta"]),
    place: s.point(),
    embedding: s.vector().dimension(3).nullable(),
    tags: s.string().array(),
    prices: s.decimal(MONEY).array(),
    moments: s.dateTime().array(),
    maybePrice: s.decimal(MONEY).nullable(),
    maybeViews: s.bigInt().nullable(),
    maybeAt: s.dateTime().nullable(),
    maybeMeta: s.json().nullable(),
    maybePayload: s.blob().nullable(),
    maybePlace: s.point().nullable(),
    maybeTags: s.string().array().nullable(),
    parentId: s.string().nullable(),
    parent: s
      .toOne(() => full)
      .fields("parentId")
      .references("id")
      .name("cd03Tree"),
    kids: s.toMany(() => full).name("cd03Tree"),
  })
  .map("cd03_full");
const other = s
  .model({ id: s.string().id(), title: s.string() })
  .map("cd03_other");
const pin = s
  .model({
    id: s.int().id(),
    subject: s.toOne({ full: () => full, other: () => other }).optional(),
  })
  .map("cd03_pins");
const schema = { full, other, pin };

/** Every scalar of `full`, selected. */
const SCALARS = Object.fromEntries(
  [
    "id",
    "text",
    "note",
    "count",
    "ratio",
    "price",
    "views",
    "active",
    "happenedAt",
    "bornOn",
    "wakeAt",
    "meta",
    "checked",
    "payload",
    "kind",
    "place",
    "embedding",
    "tags",
    "prices",
    "moments",
    "maybePrice",
    "maybeViews",
    "maybeAt",
    "maybeMeta",
    "maybePayload",
    "maybePlace",
    "maybeTags",
    "parentId",
  ].map((field) => [field, true])
);

/**
 * A json document whose OWN keys are `Object.prototype` names. Built by
 * `JSON.parse`, because an object literal's `__proto__` sets the prototype.
 */
const hostile = (n: number): JsonValue =>
  JSON.parse(
    `{"__proto__":{"polluted":${n}},"constructor":"c","toString":"s","nested":{"a":${n},"nothing":null},"list":[1,"two",true,null]}`
  );

/** One row's written values; odd rows set every nullable, even rows null it. */
function written(
  id: string,
  n: number,
  parentId: string | null,
  embedding: number[] | null = null
) {
  const set = n % 2 === 1;
  return {
    id,
    text: "plain",
    note: set ? `note ${n}` : null,
    count: n * 7 - 3,
    ratio: n + 0.5,
    price: `${123_456 + n}.000001`,
    views: 9_007_199_254_740_993n + BigInt(n),
    active: n % 2 === 0,
    happenedAt: new Date(Date.UTC(2024, 0, 15 + n, 10, 30, 0, 123)),
    bornOn: new Date(Date.UTC(2024, 2, 7 + n)),
    wakeAt: "13:45:30",
    meta: hostile(n),
    checked: { n },
    payload: new Uint8Array([0, n, 128, 255]),
    kind: set ? "alpha" : "beta",
    place: { longitude: n - 0.125, latitude: 51.5 },
    embedding,
    tags: ["a", `b,${n}`, '"q"'],
    prices: ["1.5", "-0.000001"],
    moments: [new Date(Date.UTC(2023, 11, 31, 23, 59, 59, 999))],
    maybePrice: set ? `${n}.25` : null,
    maybeViews: set ? BigInt(n) * 10_000_000_000_000_000n : null,
    maybeAt: set ? new Date(Date.UTC(2020, 1, 29, n)) : null,
    maybeMeta: set ? { m: n } : null,
    // SQLite carries a blob as `lower(hex(…))`, and `hex(NULL)` is `''`, so a
    // NULL blob inside a JSON document reads back as an EMPTY blob — on the
    // baseline too (`sqlite-adapter.ts` `blobToHex`, out of this decoder's
    // scope). Only the root row `r`, never carried here, holds that NULL.
    maybePayload: set
      ? new Uint8Array([n])
      : id === "r"
        ? null
        : new Uint8Array(0),
    maybePlace: set ? { longitude: 2.35, latitude: 48.85 + n } : null,
    maybeTags: set ? ["x", ""] : null,
    parentId,
  };
}

/**
 * A row as it is WRITTEN: a nullable json field's null is spelled as the
 * database NULL, except on the root row, which stores the JSON `null`
 * document. Both publish `null`.
 */
function stored(row: ReturnType<typeof written>) {
  const { embedding: _seededRaw, ...admitted } = row;
  return {
    ...admitted,
    maybeMeta: row.maybeMeta ?? (row.id === "r" ? JsonNull : DbNull),
  };
}

/** The tree every cell reads: r → k1 → g, r → k2. `o` is the other arm. */
const ROWS = [
  written("r", 0, null, [1, 0.5, 0]),
  written("k1", 1, "r", [1, 0.5, -1]),
  written("k2", 2, "r", [1, 0.5, -2]),
  written("g", 3, "k1", [1, 0.5, -3]),
];
const byId = (id: string) => {
  const row = ROWS.find((candidate) => candidate.id === id);
  if (!row) throw new Error(`no row ${id}`);
  return row;
};

/**
 * What a published row SAYS, independent of container identity: every leaf
 * tagged by its public type, every object as its prototype plus its OWN
 * entries in key order (so an own `__proto__` key survives the comparison).
 */
function canonical(value: unknown): unknown {
  if (value instanceof Decimal)
    return ["decimal", canonicalizeDecimal(value) ?? "?"];
  if (value instanceof Date) return ["date", value.toISOString()];
  if (value instanceof Uint8Array)
    return [
      "bytes",
      value.constructor.name,
      Buffer.from(value).toString("hex"),
    ];
  if (typeof value === "bigint") return ["bigint", String(value)];
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object") {
    const prototype = Object.getPrototypeOf(value);
    return [
      prototype === Object.prototype ? "object" : "foreign-object",
      Object.keys(value)
        .sort()
        .map((key) => [key, canonical(Reflect.get(value, key))]),
    ];
  }
  return value;
}

/** A decimal as the decoder publishes it: a fresh public `Decimal`. */
const decimal = (text: string | null) =>
  text === null ? null : new Decimal(text);

/**
 * The public answer for one written row. A PHYSICAL row's strings crossed the
 * driver parser, whose mark (`tag`) they carry; a CARRIED row's never did.
 */
function published(
  row: ReturnType<typeof written>,
  tag: string | undefined
): Record<string, unknown> {
  const mark = (text: string) => (tag === undefined ? text : `${text}${tag}`);
  return {
    ...row,
    text: mark(row.text),
    price: decimal(row.price),
    prices: row.prices.map(decimal),
    maybePrice: decimal(row.maybePrice),
    checked: { n: row.checked.n, seen: true },
  };
}

/** `actual` says exactly what `expected` says. */
function same(actual: unknown, expected: unknown, label: string): void {
  assert.deepStrictEqual(canonical(actual), canonical(expected), label);
}

/**
 * The transport's own parser, wrapped: every ask is recorded, a `string`
 * cell is marked with `tag`, and the stock leg (which owns the transport's
 * spellings, JSON text among them) still answers.
 */
function marking(
  tag: string,
  asks: string[],
  stock: DriverResultParser | undefined
): DriverResultParser {
  return {
    parseField: (value, type, next) => {
      asks.push(type);
      // Only the `text` value is marked: a parser that rewrote a KEY would
      // also rewrite the identity the engine captures for its own writes.
      const marked =
        type === "string" && value === "plain" ? `${value}${tag}` : value;
      return stock?.parseField
        ? stock.parseField(marked, type, next)
        : next(marked, type);
    },
  };
}

function installParser(driver: object, parser: DriverResultParser): void {
  Object.defineProperty(driver, "result", {
    configurable: true,
    value: parser,
  });
}

/** The same transport on the route that PACKAGES an array of operations. */
class BatchOnlySQLite3Driver extends SQLite3Driver {
  override readonly supportsTransactions = false;
  override readonly supportsBatch = true;
}

function member(target: unknown, name: string): unknown {
  return (typeof target === "object" && target !== null) ||
    typeof target === "function"
    ? Reflect.get(target, name)
    : undefined;
}
function invoke(target: unknown, method: string, ...args: unknown[]): unknown {
  const fn = member(target, method);
  if (typeof fn !== "function") throw new Error(`no '${method}' here`);
  return Reflect.apply(fn, target, args);
}
/** One public model call, as its pending operation. */
const call = (
  client: unknown,
  model: string,
  operation: string,
  args: Record<string, unknown> = {}
): Promise<unknown> =>
  invoke(member(client, model), operation, args) as Promise<unknown>;

/** A seeded database behind `driver`, read through a client on it. */
async function world(
  tag: string,
  transport: new (options: { dataDir: string }) => SQLite3Driver = SQLite3Driver
) {
  const asks: string[] = [];
  const driver = new transport({ dataDir: ":memory:" });
  const client = createClient({ schema, driver });
  await syncLiveSchema(client);
  for (const row of ROWS) {
    await call(client, "full", "create", { data: stored(row) });
    // SQLite declares no vector tier, and the engine's vector WRITE does not
    // bind there (`read-codecs.test.ts`, SC-13); the stored vector is read.
    await driver._executeRaw(
      'UPDATE "cd03_full" SET "embedding" = ? WHERE "id" = ?',
      [JSON.stringify(row.embedding), row.id]
    );
  }
  await call(client, "other", "create", { data: { id: "o", title: "Other" } });
  await call(client, "pin", "create", {
    data: {
      id: 1,
      subject: { connect: { type: "full", where: { id: "k1" } } },
    },
  });
  await call(client, "pin", "create", {
    data: {
      id: 2,
      subject: { connect: { type: "other", where: { id: "o" } } },
    },
  });
  await call(client, "pin", "create", { data: { id: 3 } });
  installParser(driver, marking(tag, asks, driver.result));
  return {
    asks,
    client,
    driver,
    /** What the parser was asked while `operation` ran. */
    async asked(operation: () => unknown): Promise<[unknown, string[]]> {
      asks.length = 0;
      const value = await operation();
      return [value, [...asks]];
    },
  };
}

/** The non-null physical cells of one fully selected row, by parser type. */
function physicalAsks(row: Record<string, unknown>): number {
  return Object.values(row).filter((value) => value !== null).length;
}

async function rejection(operation: PromiseLike<unknown>): Promise<unknown> {
  try {
    await operation;
  } catch (error) {
    return error;
  }
  throw new Error("the operation was expected to reject");
}

describe("every codec, physical and carried, through the public client", () => {
  it("publishes a physical root row through the chain, once per non-null cell", async () => {
    const { client, driver, asked } = await world("@A");
    try {
      for (const id of ["k1", "k2"]) {
        const [row, asks] = await asked(() =>
          call(client, "full", "findUnique", { where: { id }, select: SCALARS })
        );
        same(row, published(byId(id), "@A"), `root ${id}`);
        assert.equal(asks.length, physicalAsks(byId(id)), `root asks ${id}`);
      }
      // The default projection is the same shape at the same placement.
      const [rows] = await asked(() =>
        call(client, "full", "findMany", {
          where: { id: { in: ["k1", "k2"] } },
          orderBy: { id: "asc" },
          omit: { parentId: false },
        })
      );
      same(
        rows,
        ["k1", "k2"].map((id) => published(byId(id), "@A")),
        "default projection"
      );
    } finally {
      await driver.disconnect();
    }
  });

  it("publishes a carried to-one, reversed to-many, variant arm and recursive node without the chain", async () => {
    const { client, driver, asked } = await world("@A");
    try {
      // To-one relation document.
      const [toOne, toOneAsks] = await asked(() =>
        call(client, "full", "findUnique", {
          where: { id: "g" },
          select: { id: true, parent: { select: SCALARS } },
        })
      );
      same(
        toOne,
        { id: "g", parent: published(byId("k1"), undefined) },
        "to-one"
      );
      assert.deepEqual(toOneAsks, ["string"]);

      // A to-many collection whose window is REVERSED (negative take).
      const [toMany, toManyAsks] = await asked(() =>
        call(client, "full", "findUnique", {
          where: { id: "r" },
          select: {
            id: true,
            kids: { select: SCALARS, orderBy: { id: "asc" }, take: -2 },
            parent: { select: { id: true } },
          },
        })
      );
      same(
        toMany,
        {
          id: "r",
          kids: ["k1", "k2"].map((id) => published(byId(id), undefined)),
          parent: null,
        },
        "reversed to-many and null to-one"
      );
      assert.deepEqual(toManyAsks, ["string"]);

      // A carried collection inside a carried collection.
      const [nested] = await asked(() =>
        call(client, "full", "findUnique", {
          where: { id: "r" },
          select: {
            kids: {
              orderBy: { id: "desc" },
              select: {
                id: true,
                kids: { select: SCALARS, take: -1, orderBy: { id: "asc" } },
              },
            },
          },
        })
      );
      same(
        nested,
        {
          kids: [
            { id: "k2", kids: [] },
            { id: "k1", kids: [published(byId("g"), undefined)] },
          ],
        },
        "depth-two collection"
      );

      // The variant arm: the full arm, the other arm, and no member.
      const [pins, pinAsks] = await asked(() =>
        call(client, "pin", "findMany", {
          orderBy: { id: "asc" },
          select: { id: true, subject: true },
        })
      );
      const k1 = published(byId("k1"), undefined);
      same(
        pins,
        [
          { id: 1, subject: { type: "full", data: k1 } },
          {
            id: 2,
            subject: { type: "other", data: { id: "o", title: "Other" } },
          },
          { id: 3, subject: null },
        ],
        "variant arms"
      );
      assert.deepEqual(pinAsks, ["int", "int", "int"]);

      // The recursive node rows, every codec at every depth.
      const [tree, treeAsks] = await asked(() =>
        call(client, "full", "findUnique", {
          where: { id: "r" },
          select: {
            id: true,
            kids: { recurse: { depth: 2 }, select: SCALARS },
          },
        })
      );
      const node = (id: string, kids: unknown[]) => ({
        ...published(byId(id), undefined),
        kids,
      });
      const kids = member(tree, "kids");
      assert.ok(Array.isArray(kids));
      same(
        {
          id: member(tree, "id"),
          kids: [...kids].sort((a, b) =>
            String(member(a, "id")).localeCompare(String(member(b, "id")))
          ),
        },
        {
          id: "r",
          // A node AT the depth bound is not expanded, so it has no member.
          kids: [node("k1", [published(byId("g"), undefined)]), node("k2", [])],
        },
        "recursive node rows"
      );
      assert.deepEqual(treeAsks, ["string"]);
    } finally {
      await driver.disconnect();
    }
  });

  it("publishes aggregate and grouped carriers without the chain", async () => {
    const { client, driver, asked } = await world("@A");
    try {
      const [aggregate, aggregateAsks] = await asked(() =>
        call(client, "full", "aggregate", {
          _count: true,
          _min: { price: true, views: true, happenedAt: true, text: true },
          _max: { maybeViews: true, maybeAt: true, maybePrice: true },
        })
      );
      same(
        aggregate,
        {
          _count: 4,
          _min: {
            price: new Decimal("123456.000001"),
            views: 9_007_199_254_740_993n,
            happenedAt: byId("r").happenedAt,
            text: "plain",
          },
          _max: {
            maybeViews: 30_000_000_000_000_000n,
            maybeAt: byId("g").maybeAt,
            maybePrice: new Decimal("3.25"),
          },
        },
        "aggregate carriers"
      );
      assert.deepEqual(aggregateAsks, ["int"]);

      const [groups, groupAsks] = await asked(() =>
        call(client, "full", "groupBy", {
          by: ["parentId"],
          orderBy: { parentId: "asc" },
          _max: { views: true, maybePrice: true },
          _count: { _all: true },
        })
      );
      same(
        groups,
        [
          {
            parentId: null,
            _max: { views: 9_007_199_254_740_993n, maybePrice: null },
            _count: { _all: 1 },
          },
          {
            parentId: "k1",
            _max: {
              views: 9_007_199_254_740_996n,
              maybePrice: new Decimal("3.25"),
            },
            _count: { _all: 1 },
          },
          {
            parentId: "r",
            _max: {
              views: 9_007_199_254_740_995n,
              maybePrice: new Decimal("1.25"),
            },
            _count: { _all: 2 },
          },
        ],
        "grouped carriers"
      );
      assert.deepEqual(groupAsks, ["string", "string"]);
    } finally {
      await driver.disconnect();
    }
  });

  it("publishes RETURNING rows and selected series as physical rows", async () => {
    const { client, driver, asked } = await world("@A");
    try {
      const created = written("c1", 5, "r");
      const [row, createAsks] = await asked(() =>
        call(client, "full", "create", {
          data: stored(created),
          select: SCALARS,
        })
      );
      same(row, published(created, "@A"), "create RETURNING");
      assert.equal(createAsks.length, physicalAsks(created));

      // RETURNING, then a carried relation read in the same operation.
      const [updated] = await asked(() =>
        call(client, "full", "update", {
          where: { id: "c1" },
          data: { count: 99 },
          select: { ...SCALARS, parent: { select: { id: true, text: true } } },
        })
      );
      same(
        updated,
        {
          ...published({ ...created, count: 99 }, "@A"),
          parent: { id: "r", text: "plain" },
        },
        "update RETURNING with a carried relation"
      );

      const series = [written("s1", 6, "k2"), written("s2", 7, "k2")];
      const [many] = await asked(() =>
        call(client, "full", "createMany", {
          data: series.map(stored),
          select: SCALARS,
        })
      );
      same(
        many,
        series.map((one) => published(one, "@A")),
        "createMany series"
      );
      const [changed] = await asked(() =>
        call(client, "full", "updateMany", {
          where: { id: { in: ["s1", "s2"] } },
          data: { active: true },
          select: { id: true, active: true, maybeViews: true, text: true },
        })
      );
      same(
        Array.isArray(changed)
          ? [...changed].sort((a, b) =>
              String(member(a, "id")).localeCompare(String(member(b, "id")))
            )
          : changed,
        [
          { id: "s1", active: true, maybeViews: null, text: "plain@A" },
          {
            id: "s2",
            active: true,
            maybeViews: 70_000_000_000_000_000n,
            text: "plain@A",
          },
        ],
        "updateMany series"
      );
      const [removed] = await asked(() =>
        call(client, "full", "deleteMany", {
          where: { id: "s2" },
          select: { id: true, embedding: true, maybePlace: true },
        })
      );
      same(
        removed,
        [
          {
            id: "s2",
            embedding: series[1]?.embedding,
            maybePlace: series[1]?.maybePlace,
          },
        ],
        "deleteMany series"
      );
    } finally {
      await driver.disconnect();
    }
  });
});

describe("the chain that runs is the execution's, at every route", () => {
  it("decodes a borrowed transaction's reads and a packaged array member through the same chain", async () => {
    const live = await world("@A");
    const packaged = await world("@P", BatchOnlySQLite3Driver);
    try {
      const borrowed = await invoke(
        live.client,
        "$transaction",
        async (tx: unknown) => [
          await call(tx, "full", "findUnique", {
            where: { id: "k1" },
            select: SCALARS,
          }),
          await call(tx, "full", "findUnique", {
            where: { id: "g" },
            select: { id: true, parent: { select: SCALARS } },
          }),
        ]
      );
      same(
        borrowed,
        [
          published(byId("k1"), "@A"),
          { id: "g", parent: published(byId("k1"), undefined) },
        ],
        "borrowed transaction"
      );

      for (const target of [live, packaged]) {
        const tag = target === live ? "@A" : "@P";
        const [answers, asks] = await target.asked(() =>
          invoke(target.client, "$transaction", [
            call(target.client, "full", "findUnique", {
              where: { id: "k2" },
              select: SCALARS,
            }),
            call(target.client, "full", "findUnique", {
              where: { id: "r" },
              select: {
                id: true,
                kids: { select: SCALARS, orderBy: { id: "asc" }, take: -1 },
              },
            }),
            call(target.client, "full", "create", {
              data: stored(written("c2", 9, null)),
              select: SCALARS,
            }),
          ])
        );
        same(
          answers,
          [
            published(byId("k2"), tag),
            { id: "r", kids: [published(byId("k2"), undefined)] },
            published(written("c2", 9, null), tag),
          ],
          `array transaction ${tag}`
        );
        assert.equal(
          asks.length,
          physicalAsks(byId("k2")) + 1 + physicalAsks(written("c2", 9, null)),
          `array transaction asks ${tag}`
        );
      }
    } finally {
      await live.driver.disconnect();
      await packaged.driver.disconnect();
    }
  });

  it("serves a cached read decoded once, and never asks the chain on a hit", async () => {
    const { client, driver, asked } = await world("@A");
    try {
      const cached = invoke(
        invoke(
          client,
          "$extends",
          cache({ driver: new MemoryCache(), version: "cd03" })
        ),
        "$withCache"
      );
      const read = () =>
        call(cached, "full", "findUnique", {
          where: { id: "g" },
          select: { ...SCALARS, parent: { select: SCALARS } },
        });
      const expected = {
        ...published(byId("g"), "@A"),
        parent: published(byId("k1"), undefined),
      };
      const [miss, missAsks] = await asked(read);
      same(miss, expected, "cache miss");
      assert.equal(missAsks.length, physicalAsks(byId("g")));
      const [hit, hitAsks] = await asked(read);
      same(hit, expected, "cache hit");
      assert.deepEqual(hitAsks, []);
      assert.notEqual(hit, miss);
    } finally {
      await driver.disconnect();
    }
  });

  it("keeps two clients' parsers apart while they decode concurrently", async () => {
    const a = await world("@A");
    const b = await world("@B");
    try {
      // The DEFAULT projection is prepared once per (adapter, model) and
      // shared by every operation of a client; a selected one is not.
      const reads = (target: typeof a) => [
        call(target.client, "full", "findUnique", { where: { id: "k1" } }),
        call(target.client, "full", "findMany", {
          where: { id: "g" },
          select: { ...SCALARS, parent: { select: SCALARS } },
        }),
        call(target.client, "full", "groupBy", {
          by: ["parentId"],
          where: { id: "k2" },
          _max: { text: true },
        }),
      ];
      const expected = (tag: string) => [
        published(byId("k1"), tag),
        [
          {
            ...published(byId("g"), tag),
            parent: published(byId("k1"), undefined),
          },
        ],
        [{ parentId: "r", _max: { text: "plain" } }],
      ];
      const rounds = await Promise.all(
        Array.from({ length: 8 }, (_, round) =>
          Promise.all(reads(round % 2 === 0 ? a : b))
        )
      );
      for (const [round, answers] of rounds.entries())
        same(
          answers,
          expected(round % 2 === 0 ? "@A" : "@B"),
          `round ${round}`
        );

      // ONE prepared operation of client A, executed on B's driver while A's
      // own default execution of the same shared default projection runs: the
      // reader follows the executing driver, never the engine that prepared
      // the shape or an execution that decoded it first.
      const args = { where: { id: "k1" } };
      const onB = readTestTransactionOperation(
        call(a.client, "full", "findUnique", args)
      );
      assert.ok(onB, "a model call is a transaction operation");
      const [fromA, fromB] = await Promise.all([
        call(a.client, "full", "findUnique", args),
        onB.executeWith(b.driver),
      ]);
      same(fromA, published(byId("k1"), "@A"), "default execution");
      same(fromB, published(byId("k1"), "@B"), "execution on another driver");
    } finally {
      await a.driver.disconnect();
      await b.driver.disconnect();
    }
  });
});

/** A driver that answers exactly the rows a cell hands it. */
class ScriptedDriver extends Driver<null, null> {
  readonly adapter = new SQLite3Driver().adapter;
  private readonly rows: unknown[];
  constructor(rows: unknown[]) {
    super("sqlite" satisfies Dialect, "scripted");
    this.rows = rows;
  }
  protected async initClient() {
    return null;
  }
  protected async closeClient() {
    // Scripted rows own no provider resource.
  }
  protected async execute<T>(): Promise<{ rows: T[]; rowCount: number }> {
    return { rows: this.rows as T[], rowCount: this.rows.length };
  }
  protected async executeRaw<T>(): Promise<{ rows: T[]; rowCount: number }> {
    return { rows: [], rowCount: 0 };
  }
  protected async transaction<T>(
    _client: null,
    fn: (client: null) => Promise<T>
  ): Promise<T> {
    return fn(null);
  }
}

async function scriptedFailure(
  rows: unknown[],
  model: string,
  args: Record<string, unknown>
): Promise<unknown> {
  const client = createClient({ schema, driver: new ScriptedDriver(rows) });
  try {
    return await rejection(call(client, model, "findMany", args));
  } finally {
    await invoke(client, "$disconnect");
  }
}

const ABSENT_TITLE =
  'Driver "scripted" returned a malformed string scalar for operation "findMany": the value is absent.';
const NOT_A_ROW =
  'Driver "scripted" returned a malformed row scalar for operation "findMany": a requested document is not a provider row.';

describe("the document and own-key rules at the later placements", () => {
  it("reads a variant arm by own key and refuses one that is no document", async () => {
    const arm = Object.create({ title: "inherited" });
    arm.id = "o";
    const args = { select: { id: true, subject: true } };
    const inherited = await scriptedFailure(
      [{ id: 1, subject: { full: null, other: arm } }],
      "pin",
      args
    );
    assert.ok(inherited instanceof QueryEngineError);
    assert.equal(inherited.message, ABSENT_TITLE);
    for (const malformed of [5, '"text"', [1]])
      assert.equal(
        member(
          await scriptedFailure(
            [{ id: 1, subject: { full: null, other: malformed } }],
            "pin",
            args
          ),
          "message"
        ),
        NOT_A_ROW
      );
    // An EMPTY carrier at an arm is the claim without the row (D-19), and
    // the empty array is read as that empty document, before the arm.
    assert.equal(
      member(
        await scriptedFailure(
          [{ id: 1, subject: { full: null, other: [] } }],
          "pin",
          args
        ),
        "message"
      ),
      "Polymorphic relation 'subject' references a missing 'other' record."
    );
  });

  it("refuses a to-one relation document that is no document, its text included", async () => {
    for (const malformed of [[], 5, "[]", '"text"'])
      assert.equal(
        member(
          await scriptedFailure([{ id: "g", parent: malformed }], "full", {
            select: { id: true, parent: { select: { id: true } } },
          }),
          "message"
        ),
        NOT_A_ROW
      );
  });

  it("reads a recursive node row by own key", async () => {
    const row = Object.create({ id: "inherited" });
    const failure = await scriptedFailure(
      [
        {
          id: "r",
          kids: {
            __rq_root: ["r"],
            __rq_nodes: [{ __rq_key: ["k"], __rq_row: row }],
            __rq_edges: [
              { __rq_parent: ["r"], __rq_child: ["k"], __rq_depth: 1 },
            ],
          },
        },
      ],
      "full",
      {
        select: {
          id: true,
          kids: { recurse: { depth: 2 }, select: { id: true } },
        },
      }
    );
    assert.ok(failure instanceof QueryEngineError);
    assert.equal(failure.message, ABSENT_TITLE);
  });
});
