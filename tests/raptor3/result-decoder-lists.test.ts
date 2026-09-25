/**
 * The LIST leaf of the one result decoder, pinned before its element
 * descriptor moves to the decoded-batch compilation boundary
 * (`docs/architecture/raptor3-compiled-list-decoder-plan.md`, work unit 1).
 *
 * `result-decoder.test.ts` and `result-decoder-placements.test.ts` already
 * carry string, decimal and DateTime lists through every placement, and
 * `g4/read-codecs.test.ts` round-trips every list kind, empty ones included,
 * through a physical SQLite root. This file adds what neither states about a
 * list: the container's null, absent, empty, malformed and sparse answers; a
 * member's refusal, a null member included; the enum list's two declared
 * spellings; the decimal list's separate whole-list codec; an
 * identifier-format list; the chain asked once per physical LIST and never for
 * a member or a carried list; fresh public containers; and int, enum and
 * identifier-format lists at the root, carried, variant, RETURNING,
 * borrowed-transaction and result-middleware placements of a real database.
 *
 * Every expected value is the value the test wrote or the baseline's own
 * published sentence (`544ab9465`). Two answers are BASELINE PARITY rather
 * than a stated contract, and are named so where they are pinned:
 *
 *  - a SPARSE provider list keeps its holes. The list reader (`decodeList`
 *    at `544ab9465`, `compileList`'s reader since) checks each index
 *    with `Object.hasOwn` inside `items.map`, and `map` never visits a hole,
 *    so that check cannot fire. The plan records the policy question
 *    separately; this is a parity pin, not proof that sparse lists are
 *    refused;
 *  - list text that is not JSON escapes as the parser's own `SyntaxError`,
 *    exactly as a malformed relation text does (`result-decoder.test.ts`,
 *    "compatibility choices").
 */

import type { DatabaseAdapter } from "@adapters";
import { MySQLAdapter } from "@adapters/databases/mysql/mysql-adapter";
import { PostgresAdapter } from "@adapters/databases/postgres/postgres-adapter";
import { SQLiteAdapter } from "@adapters/databases/sqlite/sqlite-adapter";
import { createClient } from "@client/client";
import type { Dialect, DriverResultParser } from "@drivers";
import { Driver } from "@drivers";
import { SQLite3Driver } from "@drivers/sqlite3";
import { QueryEngineError } from "@errors";
import { Queries } from "@query-engine/raptor3/shared/query";
import { EngineSchema } from "@query-engine/raptor3/shared/schema";
import { s } from "@schema";
import { Decimal } from "@src/index";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import { canonicalizeDecimal } from "@validation/primitives/decimal-codec";
import { describe, expect, it } from "vitest";

const MONEY = { precision: 12, scale: 2 } as const;
const LEVELS = ["LOW", "HIGH"] as const;
/** A UUID the caller wrote in UPPER case; a list keeps what was written. */
const KEY = "0190C3A0-0000-7000-8000-000000000001";

const crate = s
  .model({
    id: s.int().id(),
    label: s.string(),
    boxes: s.toMany(() => box),
  })
  .map("list_crates");
const box = s
  .model({
    id: s.int().id(),
    tags: s.string().array(),
    counts: s.int().array(),
    levels: s.enum([...LEVELS]).array(),
    amounts: s.decimal(MONEY).array(),
    keys: s.string().uuid().array(),
    maybeTags: s.string().array().nullable(),
    crateId: s.int().nullable(),
    crate: s
      .toOne(() => crate)
      .fields("crateId")
      .references("id"),
  })
  .map("list_boxes");
const other = s
  .model({ id: s.int().id(), title: s.string() })
  .map("list_others");
const pin = s
  .model({
    id: s.int().id(),
    subject: s.toOne({ box: () => box, other: () => other }).optional(),
  })
  .map("list_pins");
const schema = { crate, box, other, pin };

/** Every list of `box`, selected, beside its key. */
const LISTS = {
  id: true,
  tags: true,
  counts: true,
  levels: true,
  amounts: true,
  keys: true,
  maybeTags: true,
} as const;

/** A decimal as the test wrote it, compared by its canonical text. */
function decimals(value: unknown): unknown {
  return Array.isArray(value)
    ? value.map((member) =>
        member instanceof Decimal ? canonicalizeDecimal(member) : member
      )
    : value;
}

/** A published box with its decimal members spelled as text. */
function spelled(row: unknown): unknown {
  if (row === null || typeof row !== "object") return row;
  return { ...row, amounts: decimals(Reflect.get(row, "amounts")) };
}

/** A driver that answers exactly the rows a cell hands it. */
class ScriptedDriver extends Driver<null, null> {
  readonly adapter;
  readonly result: DriverResultParser | undefined;
  private readonly rows: unknown[];
  constructor(rows: unknown[], result?: DriverResultParser) {
    super("sqlite" satisfies Dialect, "scripted");
    this.rows = rows;
    this.result = result;
    this.adapter = new SQLite3Driver().adapter;
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

function scripted(rows: unknown[], result?: DriverResultParser) {
  return createClient({ schema, driver: new ScriptedDriver(rows, result) });
}

/** A parser that records each ask's type and value, then continues. */
function recording(asks: [string, unknown][]): DriverResultParser {
  return {
    parseField: (value, type, next) => {
      asks.push([type, value]);
      return next(value, type);
    },
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

/** The public malformed-result sentence for one scalar type and reason. */
const malformed = (type: string, reason: string) =>
  `Driver "scripted" returned a malformed ${type} scalar for operation "findMany": ${reason}.`;

/** One root box row, every required list set, `overrides` replacing cells. */
function boxRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    tags: "[]",
    counts: "[]",
    levels: "[]",
    amounts: "[]",
    keys: "[]",
    maybeTags: null,
    ...overrides,
  };
}

/** The decoder of one execution over `adapter`, built directly. */
function decoderOver(
  adapter: DatabaseAdapter,
  select: Record<string, unknown>,
  parser?: DriverResultParser
) {
  const queries = new Queries(new EngineSchema(schema), adapter, parser);
  const { shape } = queries.prepareProjection(box, { select });
  return (rows: Record<string, unknown>[]) =>
    queries.decodeProjection(shape, rows);
}

/** What a decode throws; returning is itself a failure. */
function thrown(decode: () => unknown): unknown {
  try {
    decode();
  } catch (error) {
    return error;
  }
  throw new Error("the decode was expected to throw");
}

describe("the list container at a physical root cell", () => {
  it("publishes empty and populated string, int, enum, decimal and identifier-format lists, from text and from a provider array", async () => {
    const client = scripted([
      boxRow({ counts: [], levels: [] }),
      boxRow({
        id: 2,
        tags: '["a","b,c","\\"q\\"",""]',
        counts: [1, -2],
        levels: '["HIGH","LOW","HIGH"]',
        // SQLite's decimal list is the JSON list of scale-2 coefficients.
        amounts: '["150","-1"]',
        keys: JSON.stringify([KEY]),
        maybeTags: '["x"]',
      }),
    ]);
    const rows = await client.box.findMany({ select: LISTS });
    expect(rows.map(spelled)).toEqual([
      {
        id: 1,
        tags: [],
        counts: [],
        levels: [],
        amounts: [],
        keys: [],
        maybeTags: null,
      },
      {
        id: 2,
        tags: ["a", "b,c", '"q"', ""],
        counts: [1, -2],
        levels: ["HIGH", "LOW", "HIGH"],
        amounts: ["1.5", "-0.01"],
        // A list has no identifier domain (`idDomainOfState` answers none
        // for an array), so its members publish the stored spelling.
        keys: [KEY],
        maybeTags: ["x"],
      },
    ]);
    await client.$disconnect();
  });

  it("answers a null list by the column's nullability and an absent one as absent, before the chain", async () => {
    const asks: [string, unknown][] = [];
    const nullable = scripted([boxRow({ maybeTags: null })], recording(asks));
    expect(
      await nullable.box.findMany({ select: { id: true, maybeTags: true } })
    ).toEqual([{ id: 1, maybeTags: null }]);
    expect(asks).toEqual([["int", 1]]);
    await nullable.$disconnect();

    const cases: [Record<string, unknown>, string, string][] = [
      [{ tags: null }, "tags", "a required list is null"],
      [{ tags: undefined }, "tags", "the value is absent"],
      [{ maybeTags: undefined }, "maybeTags", "the value is absent"],
      [{ levels: null }, "levels", "a required list is null"],
      [{ amounts: null }, "amounts", "a required list is null"],
    ];
    for (const [cells, field, reason] of cases) {
      asks.length = 0;
      const row: Record<string, unknown> = boxRow(cells);
      if (cells[field] === undefined) delete row[field];
      const client = scripted([row], recording(asks));
      const failure = await rejection(
        client.box.findMany({ select: { id: true, [field]: true } })
      );
      expect(failure).toBeInstanceOf(QueryEngineError);
      const type =
        field === "levels"
          ? "enum"
          : field === "amounts"
            ? "decimal"
            : "string";
      expect(failure.message).toBe(malformed(type, reason));
      // The SQL NULL and the absent column never reach the provider chain.
      expect(asks).toEqual([["int", 1]]);
      await client.$disconnect();
    }
  });

  it("refuses a container that is no array, and lets list text that is not JSON escape as the parser's own SyntaxError", async () => {
    for (const container of ['{"a":1}', { a: 1 }, 5, "5", '"text"', true]) {
      const client = scripted([boxRow({ tags: container })]);
      const failure = await rejection(
        client.box.findMany({ select: { id: true, tags: true } })
      );
      expect(failure).toBeInstanceOf(QueryEngineError);
      expect(failure.message).toBe(
        malformed("string", "a list scalar did not return an array")
      );
      await client.$disconnect();
    }
    // Baseline parity, not a stated contract: the list's `JSON.parse` sits
    // outside the provider continuation's error translation.
    for (const text of ["[1,", "{LOW}", ""]) {
      const client = scripted([boxRow({ levels: text })]);
      const failure = await rejection(
        client.box.findMany({ select: { id: true, levels: true } })
      );
      expect(failure).toBeInstanceOf(SyntaxError);
      expect(failure).not.toBeInstanceOf(QueryEngineError);
      await client.$disconnect();
    }
  });

  it("refuses a member outside the element's domain, and a null member even in a nullable list", async () => {
    const cases: [Record<string, unknown>, string, string][] = [
      [{ tags: '["ok",42]' }, "string", "the value is not a string"],
      [{ tags: "[null]" }, "string", "a required scalar is null"],
      [{ maybeTags: '["x",null]' }, "string", "a required scalar is null"],
      [{ counts: '[1,"x"]' }, "int", "the value is not a canonical integer"],
      [{ counts: "[1,1.5]" }, "int", "the integer is outside the safe range"],
      [
        { counts: [9_007_199_254_740_993n] },
        "int",
        "the integer is outside the safe range",
      ],
      [
        { levels: '["LOW","MID"]' },
        "enum",
        "the value is not a declared enum member",
      ],
    ];
    for (const [cells, type, reason] of cases) {
      const client = scripted([boxRow(cells)]);
      const failure = await rejection(client.box.findMany({ select: LISTS }));
      expect(failure).toBeInstanceOf(QueryEngineError);
      expect(failure.message).toBe(malformed(type, reason));
      await client.$disconnect();
    }
  });

  it("keeps a sparse provider list's holes, physical and carried (baseline parity, not a refusal)", async () => {
    // A driver parser is the one way a sparse array reaches a physical cell:
    // SQLite hands text, and JSON text has no holes.
    const sparse = (): string[] => {
      const holes = new Array<string>(3);
      holes[1] = "b";
      return holes;
    };
    const physical = scripted([boxRow({ tags: "[]" })], {
      parseField: (value, type, next) =>
        next(type === "string" ? sparse() : value, type),
    });
    const [root] = await physical.box.findMany({
      select: { id: true, tags: true },
    });
    expect(root?.tags).toHaveLength(3);
    expect(Object.hasOwn(root?.tags ?? [], 0)).toBe(false);
    expect(Object.hasOwn(root?.tags ?? [], 2)).toBe(false);
    expect(root?.tags[1]).toBe("b");
    await physical.$disconnect();

    const nested = scripted([{ id: 1, boxes: [{ id: 2, tags: sparse() }] }]);
    const [parent] = await nested.crate.findMany({
      select: { id: true, boxes: { select: { id: true, tags: true } } },
    });
    const tags = parent?.boxes[0]?.tags ?? [];
    expect(tags).toHaveLength(3);
    expect(Object.hasOwn(tags, 0)).toBe(false);
    expect(tags[1]).toBe("b");
    await nested.$disconnect();

    // A PRESENT member is still read by its codec: the holes are skipped,
    // not the members beside them.
    const wrong = new Array<unknown>(2);
    wrong[1] = 42;
    const refused = scripted([boxRow()], {
      parseField: (value, type, next) =>
        next(type === "string" ? wrong : value, type),
    });
    const failure = await rejection(
      refused.box.findMany({ select: { id: true, tags: true } })
    );
    expect(failure.message).toBe(
      malformed("string", "the value is not a string")
    );
    await refused.$disconnect();
  });
});

describe("the own-index guard's one reachable input", () => {
  it("refuses a list whose member is inherited, not own — the sparse-array guard fires there, on both trees (baseline parity)", async () => {
    // `map` skips a plain hole, so a hole never reaches the callback. An index
    // that is present on the PROTOTYPE is visited (`HasProperty` walks the
    // chain) but is not own, and that is the input the own-index guard
    // refuses. Only a driver parser can hand such an array to a cell.
    const inherited = (): string[] => {
      const list = new Array<string>(3);
      list[0] = "a";
      list[1] = "b";
      Object.setPrototypeOf(
        list,
        Object.create(Array.prototype, {
          2: { value: "ghost", enumerable: false, configurable: true },
        })
      );
      return list;
    };
    const client = scripted([boxRow({ tags: "[]" })], {
      parseField: (value, type, next) =>
        next(type === "string" ? inherited() : value, type),
    });
    const failure = await rejection(
      client.box.findMany({ select: { id: true, tags: true } })
    );
    expect(failure.message).toBe(
      malformed("string", "a list scalar returned a sparse array")
    );
    await client.$disconnect();
  });
});

describe("the list representations an adapter declares", () => {
  it("reads a PostgreSQL enum list from the array's own text, and a JSON-container enum list from JSON", () => {
    const postgres = decoderOver(new PostgresAdapter(), { levels: true });
    const read = (levels: unknown) => postgres([{ levels }])[0]?.levels;
    expect(read("{LOW,HIGH}")).toEqual(["LOW", "HIGH"]);
    expect(read("{}")).toEqual([]);
    expect(read('{"HIGH",LOW}')).toEqual(["HIGH", "LOW"]);
    // A provider that already parsed the array hands it over unchanged.
    expect(read(["LOW"])).toEqual(["LOW"]);
    expect(thrown(() => read('["LOW"]'))).toMatchObject({
      scalarType: "enum",
      reason: "a list scalar did not return an array",
    });
    expect(thrown(() => read("{LOW,NULL}"))).toMatchObject({
      scalarType: "enum",
      reason: "a required scalar is null",
    });
    expect(thrown(() => read("{LOW,MID}"))).toMatchObject({
      scalarType: "enum",
      reason: "the value is not a declared enum member",
    });

    // Every OTHER PostgreSQL list is a driver-parsed array; its text is read
    // as JSON, never as array text.
    const tags = decoderOver(new PostgresAdapter(), { tags: true });
    expect(tags([{ tags: ["a", "b"] }])[0]?.tags).toEqual(["a", "b"]);
    expect(tags([{ tags: '["a"]' }])[0]?.tags).toEqual(["a"]);
    expect(thrown(() => tags([{ tags: "{a}" }]))).toBeInstanceOf(SyntaxError);

    for (const adapter of [new MySQLAdapter(), new SQLiteAdapter()]) {
      const json = decoderOver(adapter, { levels: true });
      expect(json([{ levels: '["LOW","HIGH"]' }])[0]?.levels).toEqual([
        "LOW",
        "HIGH",
      ]);
      expect(json([{ levels: ["HIGH"] }])[0]?.levels).toEqual(["HIGH"]);
      expect(json([{ levels: "[]" }])[0]?.levels).toEqual([]);
      expect(thrown(() => json([{ levels: "{LOW}" }]))).toBeInstanceOf(
        SyntaxError
      );
    }
  });

  it("reads a decimal list through its whole-list codec, never member by member", () => {
    const refusal = {
      scalarType: "decimal",
      reason:
        "the value is not an exact decimal list in this column's declared domain",
    };
    // SQLite and MySQL: a JSON TEXT of scale-2 coefficients, and nothing else.
    for (const adapter of [new SQLiteAdapter(), new MySQLAdapter()]) {
      const read = (amounts: unknown) =>
        decoderOver(adapter, { amounts: true })([{ amounts }])[0]?.amounts;
      expect(decimals(read('["150","-1"]'))).toEqual(["1.5", "-0.01"]);
      expect(read("[]")).toEqual([]);
      for (const malformedList of [
        ["150"],
        '["1.5"]',
        "[null]",
        '"150"',
        "[1,",
      ])
        expect(thrown(() => read(malformedList))).toMatchObject(refusal);
    }
    // PostgreSQL: the TEXT[] projection's array of decimal texts. A null or a
    // hole is the same whole-list refusal, never the element sentences an
    // ordinary list raises — and the hole is refused here, unlike above.
    const postgres = (amounts: unknown) =>
      decoderOver(new PostgresAdapter(), { amounts: true })([{ amounts }])[0]
        ?.amounts;
    expect(decimals(postgres(["1.50", "-0.01"]))).toEqual(["1.5", "-0.01"]);
    expect(postgres([])).toEqual([]);
    const hole = new Array<string>(2);
    hole[1] = "1.00";
    for (const malformedList of [[null], ["1.234"], hole, "{1.00}", "[]"])
      expect(thrown(() => postgres(malformedList))).toMatchObject(refusal);

    // One provider ask per list, under the element type, never per member;
    // and every read publishes fresh `Decimal`s.
    const asks: [string, unknown][] = [];
    const counted = decoderOver(
      new SQLiteAdapter(),
      { id: true, amounts: true },
      recording(asks)
    );
    const [first] = counted([{ id: 1, amounts: '["150","-1"]' }]);
    const [second] = counted([{ id: 1, amounts: '["150","-1"]' }]);
    expect(asks).toEqual([
      ["int", 1],
      ["decimal", '["150","-1"]'],
      ["int", 1],
      ["decimal", '["150","-1"]'],
    ]);
    expect(first?.amounts).not.toBe(second?.amounts);
    expect(Reflect.get(first?.amounts ?? [], 0)).not.toBe(
      Reflect.get(second?.amounts ?? [], 0)
    );
  });
});

describe("a physical list crosses the chain once; a carried list never does", () => {
  it("asks once per physical list with the element type and the whole container, and publishes carried lists without asking", async () => {
    const asks: [string, unknown][] = [];
    const root = scripted(
      [boxRow({ tags: '["a","b"]', counts: "[1,2]", levels: '["LOW"]' })],
      recording(asks)
    );
    expect(
      await root.box.findMany({
        select: { id: true, tags: true, counts: true, levels: true },
      })
    ).toEqual([{ id: 1, tags: ["a", "b"], counts: [1, 2], levels: ["LOW"] }]);
    expect(asks).toEqual([
      ["int", 1],
      ["string", '["a","b"]'],
      ["int", "[1,2]"],
      ["enum", '["LOW"]'],
    ]);
    await root.$disconnect();

    // Carried: a to-many row, a to-one document and a variant arm. A carried
    // list the document holds as TEXT is parsed by the list reader itself
    // (baseline parity), still without the chain.
    asks.length = 0;
    const nested = scripted(
      [
        {
          id: 1,
          boxes: [
            { id: 2, counts: [3, 4], levels: '["HIGH"]', maybeTags: null },
          ],
        },
      ],
      recording(asks)
    );
    expect(
      await nested.crate.findMany({
        select: {
          id: true,
          boxes: {
            select: { id: true, counts: true, levels: true, maybeTags: true },
          },
        },
      })
    ).toEqual([
      {
        id: 1,
        boxes: [{ id: 2, counts: [3, 4], levels: ["HIGH"], maybeTags: null }],
      },
    ]);
    expect(asks).toEqual([["int", 1]]);
    await nested.$disconnect();

    asks.length = 0;
    const variant = scripted(
      [
        {
          id: 9,
          subject: {
            box: {
              ...boxRow({ id: 2, tags: ["v"], counts: "[5]" }),
              crateId: null,
            },
            other: null,
          },
        },
      ],
      recording(asks)
    );
    expect(
      await variant.pin.findMany({
        select: { id: true, subject: true },
      })
    ).toEqual([
      {
        id: 9,
        subject: {
          type: "box",
          data: {
            ...boxRow({ id: 2, tags: ["v"], counts: [5] }),
            levels: [],
            amounts: [],
            keys: [],
            crateId: null,
          },
        },
      },
    ]);
    expect(asks).toEqual([["int", 9]]);
    await variant.$disconnect();
  });

  it("publishes a fresh list container, never the provider's own array", async () => {
    const shared = Object.freeze(["a", "b"]);
    const client = scripted([boxRow({ id: 1 }), boxRow({ id: 2 })], {
      parseField: (value, type, next) =>
        next(type === "string" ? shared : value, type),
    });
    const first = await client.box.findMany({
      select: { id: true, tags: true },
    });
    const second = await client.box.findMany({
      select: { id: true, tags: true },
    });
    const published = [...first, ...second].map((row) => row.tags);
    for (const tags of published) {
      expect(tags).toEqual(["a", "b"]);
      expect(tags).not.toBe(shared);
      expect(Object.isFrozen(tags)).toBe(false);
    }
    expect(new Set(published).size).toBe(published.length);
    await client.$disconnect();

    // A carried list handed over as one frozen array is published fresh too.
    const carriedTags = Object.freeze(["c"]);
    const nested = scripted([
      {
        id: 1,
        boxes: [
          { id: 2, tags: carriedTags },
          { id: 3, tags: carriedTags },
        ],
      },
    ]);
    const [parent] = await nested.crate.findMany({
      select: { id: true, boxes: { select: { id: true, tags: true } } },
    });
    const [left, right] = parent?.boxes ?? [];
    expect(left?.tags).toEqual(["c"]);
    expect(left?.tags).not.toBe(carriedTags);
    expect(left?.tags).not.toBe(right?.tags);
    await nested.$disconnect();
  });
});

/** Two boxes as WRITTEN, every list kind: one populated, one empty. */
const FULL_BOX = {
  id: 1,
  tags: ["alpha", "b,c", ""],
  counts: [7, -8, 0],
  levels: ["HIGH", "LOW"] as ("LOW" | "HIGH")[],
  amounts: ["1.5", "-0.01"],
  keys: [KEY],
  maybeTags: ["x"],
  crateId: 10,
};
const EMPTY_BOX = {
  id: 2,
  tags: [],
  counts: [],
  levels: [],
  amounts: [],
  keys: [],
  maybeTags: null,
  crateId: 10,
};
const WRITTEN = [FULL_BOX, EMPTY_BOX];
/** A written box as the public read answers it (decimals as text). */
function answered(row: typeof FULL_BOX | typeof EMPTY_BOX) {
  const { crateId: _crate, ...lists } = row;
  return lists;
}

async function seededWorld() {
  const driver = new SQLite3Driver({ dataDir: ":memory:" });
  const client = createClient({ schema, driver });
  await syncLiveSchema(client);
  await client.crate.create({ data: { id: 10, label: "crate" } });
  await client.other.create({ data: { id: 20, title: "other" } });
  for (const row of WRITTEN) await client.box.create({ data: row });
  await client.pin.create({
    data: { id: 30, subject: { connect: { type: "box", where: { id: 1 } } } },
  });
  return { driver, client };
}

describe("every placement of a real SQLite database", () => {
  it("publishes int, enum, decimal and identifier-format lists as written at every placement", async () => {
    const { driver, client } = await seededWorld();
    try {
      const expected = WRITTEN.map(answered);
      // Physical root.
      expect(
        (
          await client.box.findMany({ select: LISTS, orderBy: { id: "asc" } })
        ).map(spelled)
      ).toEqual(expected);
      // Carried: a to-many relation's rows and a variant arm's document.
      const [carrier] = await client.crate.findMany({
        select: {
          id: true,
          boxes: { select: LISTS, orderBy: { id: "asc" } },
        },
      });
      expect(carrier?.boxes.map(spelled)).toEqual(expected);
      const [pinned] = await client.pin.findMany({
        select: { id: true, subject: true },
      });
      expect(pinned?.subject?.type).toBe("box");
      expect(spelled(pinned?.subject?.data)).toMatchObject(answered(FULL_BOX));

      // RETURNING.
      const created = await client.box.create({
        data: { ...FULL_BOX, id: 3 },
        select: LISTS,
      });
      expect(spelled(created)).toEqual({ ...answered(FULL_BOX), id: 3 });
      const updated = await client.box.update({
        where: { id: 3 },
        data: { counts: { push: [9] } },
        select: LISTS,
      });
      expect(spelled(updated)).toEqual({
        ...answered(FULL_BOX),
        id: 3,
        counts: [7, -8, 0, 9],
      });

      // A borrowed interactive transaction's execution.
      const borrowed = await client.$transaction(async (tx) =>
        tx.box.findMany({ select: LISTS, orderBy: { id: "asc" } })
      );
      expect(borrowed.map(spelled)).toEqual([
        ...expected,
        { ...answered(FULL_BOX), id: 3, counts: [7, -8, 0, 9] },
      ]);
    } finally {
      await driver.disconnect();
    }
  });

  it("decodes what the result middleware hands to next, lists included", async () => {
    const { driver, client } = await seededWorld();
    try {
      // The driver's `parseResult` middleware may reshape the operation's rows
      // before the decoder reads them (D-28): a provider ARRAY in place of the
      // stored text is read like any other container.
      const middleware: DriverResultParser = {
        parseResult: (raw, operation, next) =>
          next(
            Array.isArray(raw)
              ? raw.map((row) => ({ ...row, counts: [1, 2], levels: ["LOW"] }))
              : raw,
            operation
          ),
      };
      Object.defineProperty(driver, "result", {
        configurable: true,
        value: middleware,
      });
      const rows = await client.box.findMany({
        select: { id: true, counts: true, levels: true },
        orderBy: { id: "asc" },
      });
      expect(rows).toEqual([
        { id: 1, counts: [1, 2], levels: ["LOW"] },
        { id: 2, counts: [1, 2], levels: ["LOW"] },
      ]);
      expect(rows[0]?.counts).not.toBe(rows[1]?.counts);
    } finally {
      await driver.disconnect();
    }
  });
});

describe("placements and bindings the list reader is compiled for", () => {
  it("reads a physical and a carried placement of the same list leaves in one decoded batch, each by its own reader", async () => {
    const { driver, client } = await seededWorld();
    try {
      const asks: [string, unknown][] = [];
      Object.defineProperty(driver, "result", {
        configurable: true,
        value: recording(asks),
      });
      const select = { id: true, tags: true, counts: true } as const;
      const [row] = await client.box.findMany({
        where: { id: 1 },
        select: {
          ...select,
          crate: {
            select: { boxes: { select, orderBy: { id: "asc" } } },
          },
        },
      });
      const lists = ({
        id,
        tags,
        counts,
      }: typeof FULL_BOX | typeof EMPTY_BOX) => ({
        id,
        tags,
        counts,
      });
      expect(row).toEqual({
        ...lists(FULL_BOX),
        crate: { boxes: [lists(FULL_BOX), lists(EMPTY_BOX)] },
      });
      // The physical row asks once per cell, each list as its whole stored
      // text; the carried document's lists never reach the chain.
      expect(asks.map(([type]) => type)).toEqual(["int", "string", "int"]);
      expect(
        asks.slice(1).every(([, value]) => typeof value === "string")
      ).toBe(true);
      expect(row?.tags).not.toBe(row?.crate?.boxes[0]?.tags);
    } finally {
      await driver.disconnect();
    }
  });

  it("decodes two clients' concurrent reads through each one's own result parser, into fresh containers", async () => {
    const asks: Record<"plain" | "marked", string[]> = {
      plain: [],
      marked: [],
    };
    /** Records each ask; `marked` hands its own array for every string list. */
    const parser = (name: "plain" | "marked"): DriverResultParser => ({
      parseField: (value, type, next) => {
        asks[name].push(type);
        return next(
          name === "marked" && type === "string" ? ["marked"] : value,
          type
        );
      },
    });
    const rows = [
      boxRow({ id: 1, tags: '["a","b"]', counts: "[1,2]" }),
      boxRow({ id: 2 }),
    ];
    const plain = scripted(rows, parser("plain"));
    const marked = scripted(rows, parser("marked"));
    const select = { id: true, tags: true, counts: true } as const;
    const reads = await Promise.all(
      [plain, marked, plain, marked, plain, marked].map((reader) =>
        reader.box.findMany({ select })
      )
    );
    for (const [index, read] of reads.entries())
      expect(read).toEqual(
        index % 2 === 0
          ? [
              { id: 1, tags: ["a", "b"], counts: [1, 2] },
              { id: 2, tags: [], counts: [] },
            ]
          : [
              { id: 1, tags: ["marked"], counts: [1, 2] },
              { id: 2, tags: ["marked"], counts: [] },
            ]
      );
    const perRead = ["int", "string", "int", "int", "string", "int"];
    expect(asks.plain).toEqual([...perRead, ...perRead, ...perRead]);
    expect(asks.marked).toEqual([...perRead, ...perRead, ...perRead]);
    const published = reads.flatMap((read) => read.map((row) => row.tags));
    expect(new Set(published).size).toBe(published.length);
    await plain.$disconnect();
    await marked.$disconnect();
  });
});
