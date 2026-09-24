/**
 * The Raptor 3 result decoder, pinned at the public client before the decoder
 * is compiled per execution (`docs/architecture/raptor3-compiled-decoder-plan.md`,
 * CD-00).
 *
 * Every expected answer here is the established contract or the baseline
 * engine's own behaviour (`e836bbd15`): the provider `parseField` chain runs
 * driver first, adapter second, once per PHYSICAL non-null cell, and never for
 * a value a JSON window already decoded (Arnaud's D-17); a parser's library
 * error reaches the caller intact while a foreign throw is a malformed scalar;
 * SQL NULL and absence are answered before the chain; provider documents are
 * read by own key; and the chain that runs is the one of the EXECUTION's
 * driver, on the live, borrowed-transaction and packaged routes alike.
 *
 * The last group pins four baseline answers that are compatibility choices
 * rather than stated contracts. They are preserved, not endorsed: changing any
 * of them is an observable contract change that needs a ruling, not a side
 * effect of a faster decoder.
 */

import { SQLiteAdapter } from "@adapters/databases/sqlite/sqlite-adapter";
import { createClient } from "@client/client";
import type { Dialect, DriverResultParser } from "@drivers";
import { Driver } from "@drivers";
import { SQLite3Driver } from "@drivers/sqlite3";
import { QueryEngineError } from "@errors";
import {
  InvalidScalarResult,
  Queries,
} from "@query-engine/raptor3/shared/query";
import { EngineSchema } from "@query-engine/raptor3/shared/schema";
import { s } from "@schema";
import { describe, expect, it } from "vitest";

const user = s
  .model({
    id: s.string().id(),
    name: s.string(),
    posts: s.toMany(() => post),
  })
  .map("users");
const post = s
  .model({
    id: s.string().id(),
    title: s.string(),
    content: s.string().nullable(),
    published: s.boolean(),
    views: s.int(),
    authorId: s.string(),
    author: s
      .toOne(() => user)
      .fields("authorId")
      .references("id"),
  })
  .map("posts");
const schema = { user, post };

/** One recorded `parseField` ask: which leg, the scalar type, the value. */
type Ask = readonly [leg: "driver" | "adapter", type: string, value: unknown];

/** The same transport on the route that PACKAGES an array of operations. */
class BatchOnlySQLite3Driver extends SQLite3Driver {
  override readonly supportsTransactions = false;
  override readonly supportsBatch = true;
}

/** Install a driver-level parser on one driver instance, as a caller would. */
function installDriverParser(driver: object, parser: DriverResultParser) {
  Object.defineProperty(driver, "result", {
    configurable: true,
    value: parser,
  });
}

async function world(
  change?: (driver: SQLite3Driver) => void,
  transport: new () => SQLite3Driver = SQLite3Driver
) {
  const driver = new transport();
  change?.(driver);
  await driver._executeRaw(
    'CREATE TABLE "users" ("id" text primary key, "name" text not null)',
    []
  );
  await driver._executeRaw(
    'CREATE TABLE "posts" ("id" text primary key, "title" text not null, "content" text, "published" integer not null, "views" integer not null, "authorId" text not null)',
    []
  );
  await driver._executeRaw('INSERT INTO "users" ("id","name") VALUES (?,?)', [
    "u0",
    "User 0",
  ]);
  await driver._executeRaw(
    'INSERT INTO "posts" ("id","title","content","published","views","authorId") VALUES (?,?,?,?,?,?)',
    ["p0", "Post 0", null, 1, 7, "u0"]
  );
  return { driver, client: createClient({ schema, driver }) };
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

const FLAT_POST = {
  id: "p0",
  title: "Post 0",
  content: null,
  published: true,
  views: 7,
  authorId: "u0",
};

describe("the public client answers through the one decoder", () => {
  it("publishes the complete flat and nested answers", async () => {
    const { driver, client } = await world();
    try {
      expect(await client.post.findMany()).toEqual([FLAT_POST]);
      expect(
        await client.post.findMany({
          select: { id: true, author: { select: { id: true, name: true } } },
        })
      ).toEqual([{ id: "p0", author: { id: "u0", name: "User 0" } }]);
    } finally {
      await driver.disconnect();
    }
  });

  it("keeps a custom driver parser authoritative, asked once per physical non-null cell", async () => {
    let calls = 0;
    const { driver, client } = await world((driver) =>
      installDriverParser(driver, {
        parseField: (value, type, next) => {
          calls++;
          return next(
            type === "string" && value === "Post 0" ? "Changed" : value,
            type
          );
        },
      })
    );
    try {
      const rows = await client.post.findMany();
      expect(rows[0]?.title).toBe("Changed");
      // Six columns, one SQL NULL: the NULL is decided before the chain.
      expect(calls).toBe(5);
    } finally {
      await driver.disconnect();
    }
  });

  it("refuses what a driver parser hands the strict codec outside the domain", async () => {
    const { driver, client } = await world((driver) =>
      installDriverParser(driver, {
        parseField: (value, type, next) =>
          next(type === "int" ? "not an integer" : value, type),
      })
    );
    try {
      const failure = await rejection(client.post.findMany());
      expect(failure).toBeInstanceOf(QueryEngineError);
      expect(failure.message).toBe(
        'Driver "sqlite3" returned a malformed int scalar for operation "findMany": the value is not a canonical integer.'
      );
      expect(failure.meta).toMatchObject({
        driver: "sqlite3",
        operation: "findMany",
        scalarType: "int",
      });
    } finally {
      await driver.disconnect();
    }
  });

  it("keeps a custom adapter parser authoritative", async () => {
    let calls = 0;
    const { driver, client } = await world((driver) => {
      const original = driver.adapter.result.parseField;
      driver.adapter.result.parseField = (value, type, next) => {
        calls++;
        if (type === "string" && value === "Post 0")
          return next("Adapter change");
        return original(value, type, next);
      };
    });
    try {
      const rows = await client.post.findMany();
      expect(rows[0]?.title).toBe("Adapter change");
      expect(calls).toBe(5);
    } finally {
      await driver.disconnect();
    }
  });
});

describe("the provider parseField chain has one order and one boundary", () => {
  it("runs the driver before the adapter, which reads what the driver handed next", async () => {
    const asks: Ask[] = [];
    let adapterAnswer: "continue" | "transform" | "direct" = "continue";
    const { driver, client } = await world((driver) => {
      installDriverParser(driver, {
        parseField: (value, type, next) => {
          asks.push(["driver", type, value]);
          // The driver's own `next` names a type; the adapter below is still
          // asked about the LEAF's type (baseline: the second argument is not
          // forwarded).
          return next(type === "string" ? `D:${String(value)}` : value, "x");
        },
      });
      driver.adapter.result.parseField = (value, type, next) => {
        asks.push(["adapter", type, value]);
        if (adapterAnswer === "transform") return next(`${String(value)}+A`);
        if (adapterAnswer === "direct") return "direct";
        return next();
      };
    });
    try {
      const read = () =>
        client.post.findUnique({
          where: { id: "p0" },
          select: { title: true },
        });

      // `next()` with no value hands the strict codec the adapter's INPUT,
      // which is the driver's transformed value, not the provider's.
      expect(await read()).toEqual({ title: "D:Post 0" });
      expect(asks).toEqual([
        ["driver", "string", "Post 0"],
        ["adapter", "string", "D:Post 0"],
      ]);

      asks.length = 0;
      adapterAnswer = "transform";
      expect(await read()).toEqual({ title: "D:Post 0+A" });
      expect(asks).toEqual([
        ["driver", "string", "Post 0"],
        ["adapter", "string", "D:Post 0"],
      ]);

      // An adapter may answer without continuing; the codec reads its answer.
      asks.length = 0;
      adapterAnswer = "direct";
      expect(await read()).toEqual({ title: "direct" });
      expect(asks).toHaveLength(2);
    } finally {
      await driver.disconnect();
    }
  });

  it("asks only for physical cells: carried relation, count and aggregate members never reach it", async () => {
    const asks: Ask[] = [];
    const { driver, client } = await world((driver) =>
      installDriverParser(driver, {
        parseField: (value, type, next) => {
          asks.push(["driver", type, value]);
          return next(value, type);
        },
      })
    );
    const types = async (operation: () => PromiseLike<unknown>) => {
      asks.length = 0;
      const value = await operation();
      return { value, types: asks.map(([, type]) => type) };
    };
    try {
      expect(
        await types(() =>
          client.post.findMany({
            select: { id: true, author: { select: { id: true, name: true } } },
          })
        )
      ).toEqual({
        value: [{ id: "p0", author: { id: "u0", name: "User 0" } }],
        types: ["string"],
      });
      expect(
        await types(() =>
          client.user.findMany({
            select: {
              id: true,
              posts: { select: { id: true, views: true } },
              _count: { select: { posts: true } },
            },
          })
        )
      ).toEqual({
        value: [
          { id: "u0", posts: [{ id: "p0", views: 7 }], _count: { posts: 1 } },
        ],
        types: ["string"],
      });
      expect(
        await types(() =>
          client.post.aggregate({ _count: true, _sum: { views: true } })
        )
      ).toEqual({ value: { _count: 1, _sum: { views: 7 } }, types: ["int"] });
      expect(await types(() => client.post.count())).toEqual({
        value: 1,
        types: ["int"],
      });
      expect(
        await types(() =>
          client.post.groupBy({ by: ["authorId"], _sum: { views: true } })
        )
      ).toEqual({
        value: [{ authorId: "u0", _sum: { views: 7 } }],
        types: ["string"],
      });
    } finally {
      await driver.disconnect();
    }
  });

  it("decodes a RETURNING row through the same chain as a SELECT row", async () => {
    const asks: Ask[] = [];
    const { driver, client } = await world((driver) =>
      installDriverParser(driver, {
        parseField: (value, type, next) => {
          asks.push(["driver", type, value]);
          return next(value === "Stored" ? "Read back" : value, type);
        },
      })
    );
    try {
      expect(
        await client.post.create({
          data: {
            id: "p1",
            title: "Stored",
            published: false,
            views: 1,
            authorId: "u0",
          },
          select: { id: true, title: true },
        })
      ).toEqual({ id: "p1", title: "Read back" });
      expect(asks.map(([, type]) => type)).toEqual(["string", "string"]);

      asks.length = 0;
      expect(
        await client.post.update({
          where: { id: "p0" },
          data: { title: "Stored" },
          select: { title: true, views: true },
        })
      ).toEqual({ title: "Read back", views: 7 });
      expect(asks.map(([, type]) => type)).toEqual(["string", "int"]);
    } finally {
      await driver.disconnect();
    }
  });
});

describe("a parser's failure keeps its identity", () => {
  it("passes the library's own error through and reports a foreign throw as a malformed scalar", async () => {
    const own = new QueryEngineError("the parser refused this value");
    let failWith: "library" | "scalar" | "foreign" = "library";
    const { driver, client } = await world((driver) =>
      installDriverParser(driver, {
        parseField: (value, type, next) => {
          if (type !== "string" || value !== "Post 0") return next(value, type);
          if (failWith === "library") throw own;
          if (failWith === "scalar")
            throw new InvalidScalarResult("custom", "the parser's own reason");
          throw new TypeError("foreign");
        },
      })
    );
    const read = () => rejection(client.post.findMany());
    try {
      expect(await read()).toBe(own);

      failWith = "scalar";
      const scalar = await read();
      expect(scalar).toBeInstanceOf(QueryEngineError);
      expect(scalar.message).toBe(
        'Driver "sqlite3" returned a malformed custom scalar for operation "findMany": the parser\'s own reason.'
      );

      failWith = "foreign";
      const foreign = await read();
      expect(foreign).toBeInstanceOf(QueryEngineError);
      expect(foreign.message).toBe(
        'Driver "sqlite3" returned a malformed string scalar for operation "findMany": provider scalar decoding failed.'
      );
      expect(foreign.meta).toMatchObject({ scalarType: "string" });
    } finally {
      await driver.disconnect();
    }
  });
});

describe("the chain that runs is the execution's", () => {
  it("reads the driver's parser per execution, on the live and borrowed routes", async () => {
    const { driver, client } = await world();
    const stock = driver.result;
    const transforming: DriverResultParser = {
      parseField: (value, type, next) =>
        next(value === "Post 0" ? "Changed" : value, type),
    };
    try {
      // The default projection is prepared once per (adapter, model) and
      // shared by every one of these operations.
      expect((await client.post.findMany())[0]?.title).toBe("Post 0");
      installDriverParser(driver, transforming);
      expect((await client.post.findMany())[0]?.title).toBe("Changed");
      expect(
        (await client.$transaction((tx) => tx.post.findMany()))[0]?.title
      ).toBe("Changed");
      installDriverParser(driver, stock);
      expect((await client.post.findMany())[0]?.title).toBe("Post 0");
      expect(
        (await client.$transaction((tx) => tx.post.findMany()))[0]?.title
      ).toBe("Post 0");
    } finally {
      await driver.disconnect();
    }
  });

  it("decodes a packaged array member through the same chain", async () => {
    let calls = 0;
    const { driver, client } = await world(
      (driver) =>
        installDriverParser(driver, {
          parseField: (value, type, next) => {
            calls++;
            return next(value === "Post 0" ? "Changed" : value, type);
          },
        }),
      BatchOnlySQLite3Driver
    );
    try {
      const [many, unique] = await client.$transaction([
        client.post.findMany(),
        client.post.findUnique({ where: { id: "p0" } }),
      ]);
      expect(many).toEqual([{ ...FLAT_POST, title: "Changed" }]);
      expect(unique).toEqual({ ...FLAT_POST, title: "Changed" });
      expect(calls).toBe(10);
    } finally {
      await driver.disconnect();
    }
  });
});

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

const tag = s
  .model({
    id: s.int().id(),
    itemId: s.int(),
    item: s
      .toOne(() => item)
      .fields("itemId")
      .references("id"),
  })
  .map("decoder_tags");
const item = s
  .model({
    id: s.int().id(),
    title: s.string(),
    note: s.string().nullable(),
    document: s.json(),
    rank: s.int(),
    tags: s.toMany(() => tag),
  })
  .map("decoder_items");
const article = s
  .model({ id: s.int().id(), title: s.string() })
  .map("decoder_articles");
const clip = s
  .model({ id: s.int().id(), title: s.string() })
  .map("decoder_clips");
const remark = s
  .model({
    id: s.int().id(),
    subject: s.toOne({ article: () => article, clip: () => clip }).optional(),
  })
  .map("decoder_remarks");
const scriptedSchema = { tag, item, article, clip, remark };

function scripted(rows: unknown[], result?: DriverResultParser) {
  const driver = new ScriptedDriver(rows, result);
  return createClient({ schema: scriptedSchema, driver });
}

describe("SQL NULL, absence and own keys are row facts, answered before the chain", () => {
  it("answers absence and a required NULL before any parser, and lets a NOT NULL json null through it", async () => {
    const asked: string[] = [];
    const parser: DriverResultParser = {
      parseField: (value, type, next) => {
        asked.push(type);
        return next(value, type);
      },
    };

    const absent = scripted([{ id: 1 }], parser);
    const missing = await rejection(
      absent.item.findMany({ select: { id: true, title: true } })
    );
    expect(missing).toBeInstanceOf(QueryEngineError);
    expect(missing.message).toBe(
      'Driver "scripted" returned a malformed string scalar for operation "findMany": the value is absent.'
    );
    expect(asked).toEqual(["int"]);
    await absent.$disconnect();

    asked.length = 0;
    const required = scripted([{ id: 1, title: null }], parser);
    const nullTitle = await rejection(
      required.item.findMany({ select: { id: true, title: true } })
    );
    expect(nullTitle.message).toBe(
      'Driver "scripted" returned a malformed string scalar for operation "findMany": a required scalar is null.'
    );
    expect(asked).toEqual(["int"]);
    await required.$disconnect();

    // A NOT NULL json column cannot hold SQL NULL, so a null there is the
    // stored `null` DOCUMENT: it continues through the chain like any value.
    asked.length = 0;
    const document = scripted([{ id: 1, document: null, note: null }], parser);
    expect(
      await document.item.findMany({
        select: { id: true, document: true, note: true },
      })
    ).toEqual([{ id: 1, document: null, note: null }]);
    expect(asked).toEqual(["int", "json"]);
    await document.$disconnect();
  });

  it("reads own members only, at the root and inside a relation document", async () => {
    const inherited = Object.create({ title: "inherited" });
    inherited.id = 1;
    const root = scripted([inherited]);
    const atRoot = await rejection(
      root.item.findMany({ select: { id: true, title: true } })
    );
    expect(atRoot.message).toBe(
      'Driver "scripted" returned a malformed string scalar for operation "findMany": the value is absent.'
    );
    await root.$disconnect();

    const member = Object.create({ title: "inherited" });
    member.id = 2;
    const nested = scripted([{ id: 1, item: member }]);
    const inDocument = await rejection(
      nested.tag.findMany({
        select: { id: true, item: { select: { id: true, title: true } } },
      })
    );
    expect(inDocument.message).toBe(
      'Driver "scripted" returned a malformed string scalar for operation "findMany": the value is absent.'
    );
    await nested.$disconnect();
  });
});

/**
 * The decoder of one execution, built directly: the continuation it binds is
 * this driver parser over this adapter, whatever the operation that asks.
 */
function executionDecoder(
  select: Record<string, unknown>,
  parser?: DriverResultParser,
  parseField?: SQLiteAdapter["result"]["parseField"]
) {
  const adapter = new SQLiteAdapter();
  if (parseField) adapter.result.parseField = parseField;
  const queries = new Queries(
    new EngineSchema(scriptedSchema),
    adapter,
    parser
  );
  const { shape } = queries.prepareProjection(item, { select });
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

describe("one continuation per physical value, bound to the execution", () => {
  it("asks the driver, then the adapter, exactly once per physical non-null cell", () => {
    const asks: Ask[] = [];
    const decode = executionDecoder(
      { id: true, title: true, note: true, tags: { select: { id: true } } },
      {
        parseField: (value, type, next) => {
          asks.push(["driver", type, value]);
          return next(typeof value === "string" ? `D:${value}` : value, type);
        },
      },
      (value, type, next) => {
        asks.push(["adapter", type, value]);
        return value === "D:a" ? next("A") : next();
      }
    );
    expect(
      decode([
        { id: 1, title: "a", note: null, tags: [{ id: 5 }] },
        { id: 2, title: "b", note: "n", tags: '[{"id":6}]' },
      ])
    ).toEqual([
      { id: 1, title: "A", note: null, tags: [{ id: 5 }] },
      { id: 2, title: "D:b", note: "D:n", tags: [{ id: 6 }] },
    ]);
    // The SQL NULL is answered before the chain, and the carried relation
    // rows are never offered to it.
    expect(asks).toEqual([
      ["driver", "int", 1],
      ["adapter", "int", 1],
      ["driver", "string", "a"],
      ["adapter", "string", "D:a"],
      ["driver", "int", 2],
      ["adapter", "int", 2],
      ["driver", "string", "b"],
      ["adapter", "string", "D:b"],
      ["driver", "string", "n"],
      ["adapter", "string", "D:n"],
    ]);
  });

  it("keeps a thrown error's identity from either leg and names a foreign throw by the leaf", () => {
    const library = new QueryEngineError("the parser said so");
    const scalar = new InvalidScalarResult("custom", "the parser's own reason");
    const foreign = new TypeError("foreign");
    // One spelling for both legs: each forwards the value it was handed.
    const throwing =
      (error: Error) =>
      (
        value: unknown,
        type: string,
        next: (value: unknown, type: string) => unknown
      ) => {
        if (value === "boom") throw error;
        return next(value, type);
      };
    const forwarding: DriverResultParser = {
      parseField: (value, type, next) => next(value, type),
    };
    const legs = {
      driver: (error: Error) =>
        executionDecoder(
          { id: true, title: true },
          { parseField: throwing(error) }
        ),
      "adapter under a driver": (error: Error) =>
        executionDecoder(
          { id: true, title: true },
          forwarding,
          throwing(error)
        ),
      "adapter alone": (error: Error) =>
        executionDecoder({ id: true, title: true }, undefined, throwing(error)),
    };
    for (const decoder of Object.values(legs)) {
      const row = [{ id: 1, title: "boom" }];
      expect(thrown(() => decoder(library)(row))).toBe(library);
      expect(thrown(() => decoder(scalar)(row))).toBe(scalar);
      const translated = thrown(() => decoder(foreign)(row));
      expect(translated).toBeInstanceOf(InvalidScalarResult);
      expect(translated).toMatchObject({
        scalarType: "string",
        reason: "provider scalar decoding failed",
      });
    }
  });
});

describe("one document rule at every object placement", () => {
  it("reads a relation _count carrier: text parsed, null and non-documents refused, own keys only", async () => {
    const read = async (carrier: unknown) => {
      const client = scripted([{ id: 1, _count: carrier }]);
      try {
        return await client.item.findMany({
          select: { id: true, _count: { select: { tags: true } } },
        });
      } finally {
        await client.$disconnect();
      }
    };
    expect(await read('{"tags":2}')).toEqual([{ id: 1, _count: { tags: 2 } }]);
    expect((await rejection(read(null))).message).toBe(
      'Driver "scripted" returned a malformed row scalar for operation "findMany": a document the statement always builds is null.'
    );
    expect((await rejection(read([]))).message).toBe(
      'Driver "scripted" returned a malformed row scalar for operation "findMany": a requested document is not a provider row.'
    );
    expect((await rejection(read(Object.create({ tags: 2 })))).message).toBe(
      'Driver "scripted" returned a malformed int scalar for operation "findMany": the value is absent.'
    );
  });

  it("reads an aggregate carrier by the same rule, its NULL aside", async () => {
    const read = async (carrier: unknown) => {
      const client = scripted([{ _sum: carrier }]);
      try {
        return await client.item.aggregate({ _sum: { rank: true } });
      } finally {
        await client.$disconnect();
      }
    };
    expect(await read('{"rank":3}')).toEqual({ _sum: { rank: 3 } });
    for (const malformed of [5, []])
      expect((await rejection(read(malformed))).message).toBe(
        'Driver "scripted" returned a malformed row scalar for operation "aggregate": a requested document is not a provider row.'
      );
    expect((await rejection(read(Object.create({ rank: 3 })))).message).toBe(
      'Driver "scripted" returned a malformed int scalar for operation "aggregate": the value is absent.'
    );

    const counted = scripted([{ _count: [] }]);
    expect(
      (await rejection(counted.item.aggregate({ _count: { id: true } })))
        .message
    ).toBe(
      'Driver "scripted" returned a malformed row scalar for operation "aggregate": a requested document is not a provider row.'
    );
    await counted.$disconnect();
  });

  it("reads a collection row and a root row by the same rule", async () => {
    const read = async (rows: unknown[]) => {
      const client = scripted([{ id: 1, tags: rows }]);
      try {
        return await client.item.findMany({
          select: { id: true, tags: { select: { id: true } } },
        });
      } finally {
        await client.$disconnect();
      }
    };
    expect((await rejection(read([[]]))).message).toBe(
      'Driver "scripted" returned a malformed row scalar for operation "findMany": a requested document is not a provider row.'
    );
    expect((await rejection(read([Object.create({ id: 5 })]))).message).toBe(
      'Driver "scripted" returned a malformed int scalar for operation "findMany": the value is absent.'
    );

    const arrayRow = scripted([{ id: 1 }], {
      parseResult: (_raw, operation, next) => next([[]], operation),
    });
    expect(
      (await rejection(arrayRow.item.findMany({ select: { id: true } })))
        .message
    ).toBe(
      'Driver "scripted" returned a malformed row scalar for operation "findMany": a requested document is not a provider row.'
    );
    await arrayRow.$disconnect();
  });
});

const branch = (() => {
  const node = s
    .model({
      id: s.string().id(),
      parentId: s.string().nullable(),
      parent: s
        .toOne(() => node)
        .fields("parentId")
        .references("id")
        .name("decoderTree"),
      children: s.toMany(() => node).name("decoderTree"),
    })
    .map("decoder_branches");
  return node;
})();

describe("one document rule for the recursive carrier and its entries", () => {
  const queries = new Queries(
    new EngineSchema({ branch }),
    new SQLiteAdapter()
  );
  const { shape } = queries.prepareProjection(branch, {
    select: {
      children: {
        recurse: { depth: 2, cycles: "reject" },
        select: { id: true },
      },
    },
  });
  const decode = (value: unknown) =>
    queries.decodeProjection(shape, [{ children: value }])[0]?.children;
  const child = { __rq_key: ["child"], __rq_row: { id: "child" } };
  const hop = { __rq_parent: ["root"], __rq_child: ["child"], __rq_depth: 1 };
  const carrier = (nodes: unknown[], edges: unknown[]) => ({
    __rq_root: ["root"],
    __rq_nodes: nodes,
    __rq_edges: edges,
  });

  it("parses the carrier's text and refuses a carrier that is no document", () => {
    expect(decode(JSON.stringify(carrier([child], [hop])))).toEqual([
      { id: "child", children: [] },
    ]);
    for (const value of [null, 5, "null", "[]"])
      expect(() => decode(value)).toThrowError(
        expect.objectContaining({
          scalarType: "recursive carrier",
          reason: "the carrier is not an object",
        })
      );
  });

  it("refuses a node or edge entry that is no document, its own text included", () => {
    for (const entry of [null, [], 5, JSON.stringify(child)])
      expect(() => decode(carrier([entry], [hop]))).toThrowError(
        expect.objectContaining({
          scalarType: "recursive node",
          reason: "a node entry is not an object",
        })
      );
    for (const entry of [null, [], JSON.stringify(hop)])
      expect(() => decode(carrier([child], [entry]))).toThrowError(
        expect.objectContaining({
          scalarType: "recursive edge",
          reason: "an edge entry is not an object",
        })
      );
  });
});

describe("compatibility choices the baseline answers (preserved, not revised)", () => {
  it("publishes a NULL aggregate carrier as null, unlike a relation count carrier", async () => {
    // The `_count` relation carrier is `nullable: false` and refuses a NULL
    // (`parity-decoding.core.test.ts`); an aggregate carrier's shape states no
    // nullability, so the baseline publishes the provider's NULL.
    const client = scripted([{ _sum: null }]);
    expect(await client.item.aggregate({ _sum: { rank: true } })).toEqual({
      _sum: null,
    });
    await client.$disconnect();
  });

  it("publishes a NULL root row as a null element and parses a JSON-text root row", async () => {
    // The driver's normalized result admits only object rows, but a driver's
    // `parseResult` middleware hands the decoder whatever it passes to `next`
    // (D-28). The root row shape states no nullability, and every object
    // placement parses a string before reading it, the root included.
    const replacing = (rows: unknown[]): DriverResultParser => ({
      parseResult: (_raw, operation, next) => next(rows, operation),
    });
    const nullRow = scripted([{ id: 1 }], replacing([null]));
    expect(await nullRow.item.findMany({ select: { id: true } })).toEqual([
      null,
    ]);
    await nullRow.$disconnect();

    const textRow = scripted([{ id: 1 }], replacing(['{"id":2}']));
    expect(await textRow.item.findMany({ select: { id: true } })).toEqual([
      { id: 2 },
    ]);
    await textRow.$disconnect();
  });

  it("lets a malformed relation text escape as the parser's own SyntaxError", async () => {
    const client = scripted([{ id: 1, tags: "{not json" }]);
    const failure = await rejection(
      client.item.findMany({ select: { id: true, tags: true } })
    );
    expect(failure).toBeInstanceOf(SyntaxError);
    expect(failure).not.toBeInstanceOf(QueryEngineError);
    await client.$disconnect();
  });

  it("lets a NULL variant slot escape as a TypeError, not the malformed-row error", async () => {
    // A row-carried variant slot is a document the statement always builds;
    // the baseline reads a NULL one with `Object.hasOwn`, which throws.
    const client = scripted([{ id: 1, subject: null }]);
    const failure = await rejection(
      client.remark.findMany({ select: { id: true, subject: true } })
    );
    expect(failure).toBeInstanceOf(TypeError);
    expect(failure).not.toBeInstanceOf(QueryEngineError);
    await client.$disconnect();
  });
});
