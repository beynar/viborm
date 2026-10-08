import assert from "node:assert/strict";
import { MySQLAdapter } from "@adapters/databases/mysql/mysql-adapter";
import { PostgresAdapter } from "@adapters/databases/postgres/postgres-adapter";
import { SQLiteAdapter } from "@adapters/databases/sqlite/sqlite-adapter";
import { MemoryCache } from "@cache/drivers/memory";
import { cache } from "@cache/extension";
import { createClient } from "@client/client";
import { SQLite3Driver } from "@drivers/sqlite3";
import { UnsupportedOperationError } from "@errors";
import { compileBindBudgetChunks } from "@query-engine/bind-budget";
import { createCommandEngine } from "@query-engine/raptor3/commands";
import { Queries } from "@query-engine/raptor3/shared/query";
import { EngineSchema } from "@query-engine/raptor3/shared/schema";
import { s } from "@schema";
import { sql } from "@sql";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import { createTestCommandEngine } from "@tests/raptor3/harness/command-engine";
import type { JsonValue } from "@validation/primitives/json";
import { isRecord } from "@validation/value-guards";
import Database from "better-sqlite3";
import { describe, it } from "vitest";

const IN_PATTERN = / IN /;
const INSERT_UPDATE_DELETE_PATTERN = /\b(?:INSERT|UPDATE|DELETE)\b/i;
const MUST_SPELL_CLEARING_VERB_PATTERN = /must spell clearing verb/;
const REQUIRED_AGGREGATE_RESULT_ROW_PATTERN = /required aggregate result row/;
const EXISTS_PATTERN = /EXISTS/i;
const REQUIRED_EXISTENCE_RESULT_ROW_PATTERN = /required existence result row/;

const parent = s
  .model({ id: s.int().id(), children: s.toMany(() => child) })
  .map("v1_parent");
const child = s
  .model({
    id: s.int().id(),
    rank: s.number().nullable(),
    parentId: s.int().nullable(),
    parent: s
      .toOne(() => parent)
      .fields("parentId")
      .references("id"),
  })
  .map("v1_child");
const tag = s
  .model({
    id: s.string().ulid().id(),
    name: s.string().unique(),
    parents: s.toMany(() => owner),
  })
  .map("v1_tag");
const owner = s
  .model({ id: s.int().id(), tags: s.toMany(() => tag).through("v1_links") })
  .map("v1_owner");
const book = s.model({ id: s.int().id(), title: s.string() }).map("v1_book");
const video = s.model({ id: s.int().id(), title: s.string() }).map("v1_video");
const shelf = s
  .model({
    id: s.int().id(),
    items: s.toMany({ book: () => book, video: () => video }).through({
      book: { table: "v1_books", source: "A", target: "B" },
      video: { table: "v1_videos", source: "A", target: "B" },
    }),
  })
  .map("v1_shelf");

class RecordingSQLiteDriver extends SQLite3Driver {
  readonly statements: string[] = [];
  failure?: unknown;
  protected override async execute<T>(
    client: Database.Database,
    statement: string,
    parameters: unknown[]
  ) {
    this.statements.push(statement);
    try {
      return await super.execute<T>(client, statement, parameters);
    } catch (error) {
      this.failure = error;
      throw error;
    }
  }
}
function world() {
  const database = new Database(":memory:");
  database.exec(`CREATE TABLE v1_parent(id INTEGER PRIMARY KEY);
    CREATE TABLE v1_child(id INTEGER PRIMARY KEY, rank REAL, parentId INTEGER);
    INSERT INTO v1_parent VALUES(1); INSERT INTO v1_child VALUES(1, NULL, 1),(2, 1, 1),(3, 1, 1);
    CREATE TABLE v1_tag(id TEXT PRIMARY KEY, name TEXT UNIQUE NOT NULL);
    CREATE TABLE v1_owner(id INTEGER PRIMARY KEY);
    CREATE TABLE v1_links(ownerId INTEGER NOT NULL, tagId BLOB NOT NULL, PRIMARY KEY(ownerId,tagId));
    INSERT INTO v1_owner VALUES(1);
    CREATE TABLE v1_book(id INTEGER PRIMARY KEY,title TEXT); CREATE TABLE v1_video(id INTEGER PRIMARY KEY,title TEXT);
    CREATE TABLE v1_shelf(id INTEGER PRIMARY KEY);
    CREATE TABLE v1_books(A INTEGER NOT NULL,B INTEGER NOT NULL,PRIMARY KEY(A,B));
    CREATE TABLE v1_videos(A INTEGER NOT NULL,B INTEGER NOT NULL,PRIMARY KEY(A,B));
    INSERT INTO v1_shelf VALUES(1),(2),(3),(4);
    INSERT INTO v1_book VALUES(1,'yes'); INSERT INTO v1_video VALUES(1,'video');
    INSERT INTO v1_books VALUES(2,1),(4,1); INSERT INTO v1_videos VALUES(3,1),(4,1);`);
  const driver = new RecordingSQLiteDriver({ client: database });
  return {
    database,
    driver,
    engine: createTestCommandEngine({
      schema: { parent, child, tag, owner, book, video, shelf },
      driver,
    }),
  };
}
async function withWorld(run: (w: ReturnType<typeof world>) => Promise<void>) {
  const w = world();
  try {
    await run(w);
  } finally {
    await w.driver.disconnect();
    w.database.close();
  }
}
describe("adversarial V1 query repairs", () => {
  it("caches null ordinary slots and populated variant collections as fresh graphs", async () => {
    await withWorld(async ({ database, driver }) => {
      database.exec("INSERT INTO v1_child VALUES(4,2,NULL)");
      const storage = new MemoryCache();
      const pending: Promise<unknown>[] = [];
      const client = createClient({
        schema: { parent, child, tag, owner, book, video, shelf },
        driver,
      }).$extends(
        cache({
          driver: storage,
          waitUntil: (promise) => pending.push(promise),
        })
      );
      try {
        const first = await client
          .$withCache({ ttl: 10_000 })
          .child.findMany({ include: { parent: true } });
        await Promise.all(pending.splice(0));
        const before = driver.statements.length;
        const second = await client
          .$withCache({ ttl: 10_000 })
          .child.findMany({ include: { parent: true } });
        assert.deepEqual(second, first);
        assert.notEqual(second, first);
        assert.notEqual(second[0], first[0]);
        assert.equal(driver.statements.length, before);
        assert.equal(second.find((row) => row.id === 4)?.parent, null);
        const variants = await client
          .$withCache({ ttl: 10_000 })
          .shelf.findMany({ include: { items: true } });
        await Promise.all(pending.splice(0));
        const variantBefore = driver.statements.length;
        const replay = await client
          .$withCache({ ttl: 10_000 })
          .shelf.findMany({ include: { items: true } });
        assert.deepEqual(replay, variants);
        assert.equal(driver.statements.length, variantBefore);
        assert.notEqual(replay[3]?.items, variants[3]?.items);
      } finally {
        await client.$disconnect();
        await storage.disconnect();
      }
    });
  });
  it("picks the same distinct representatives before reversing and slicing a page", async () => {
    await withWorld(async ({ engine }) => {
      const args = {
        distinct: ["rank"],
        orderBy: { id: "asc" },
        select: { id: true, rank: true },
      };
      const forward = await engine.execute("child", "findMany", args);
      const backward = await engine.execute("child", "findMany", {
        ...args,
        take: -2,
      });
      assert.deepEqual(backward, forward);
      const tail = await engine.execute("child", "findMany", {
        ...args,
        take: -1,
      });
      assert.deepEqual(tail, [{ id: 2, rank: 1 }]);
      const nested = await engine.execute("parent", "findMany", {
        select: { id: true, children: { ...args, take: -1 } },
      });
      assert.deepEqual(nested, [{ id: 1, children: [{ id: 2, rank: 1 }] }]);
    });
  });
  it("does not transfer an existing singular variant on skipped duplicate", async () => {
    await withWorld(async ({ database, driver }) => {
      const entry = s
        .model({
          id: s.int().id(),
          title: s.string().unique(),
          shelf: s.toOne(() => limitedShelf),
        })
        .map("v1_singular_entry");
      const limitedShelf = s
        .model({
          id: s.int().id(),
          items: s.toMany({ book: () => entry }).through({
            book: { table: "v1_singular_link", source: "A", target: "B" },
          }),
        })
        .map("v1_singular_shelf");
      database.exec(
        "CREATE TABLE v1_singular_entry(id INTEGER PRIMARY KEY,title TEXT UNIQUE NOT NULL); CREATE TABLE v1_singular_shelf(id INTEGER PRIMARY KEY); CREATE TABLE v1_singular_link(A INTEGER NOT NULL,B INTEGER NOT NULL UNIQUE,PRIMARY KEY(A,B)); INSERT INTO v1_singular_shelf VALUES(1),(2); INSERT INTO v1_singular_entry VALUES(1,'red'); INSERT INTO v1_singular_link VALUES(1,1)"
      );
      const engine = createTestCommandEngine({
        schema: { entry, limitedShelf },
        driver,
      });
      await engine.execute("limitedShelf", "update", {
        where: { id: 2 },
        data: {
          items: {
            createMany: [
              {
                type: "book",
                data: [{ id: 1, title: "red" }],
                skipDuplicates: true,
              },
            ],
          },
        },
      });
      assert.deepEqual(
        database.prepare("SELECT A,B FROM v1_singular_link").all(),
        [{ A: 1, B: 1 }]
      );
      assert.deepEqual(
        database.prepare("SELECT id,title FROM v1_singular_entry").all(),
        [{ id: 1, title: "red" }]
      );
    });
  });
  it("publishes exact per-read table footprints without retaining earlier history", async () => {
    await withWorld(async ({ driver }) => {
      const kernel = createCommandEngine({
        schema: { parent, child, tag, owner, book, video, shelf },
        driver,
      });
      const first = kernel.prepare("parent", "findMany", {
        select: { id: true, children: { select: { id: true } } },
      });
      const models = first.read?.models;
      assert.ok(models);
      assert.deepEqual([...models].map((model) => model["~"].names.ts).sort(), [
        "child",
        "parent",
      ]);
      const second = kernel.prepare("tag", "findMany", { select: { id: true } })
        .read?.models;
      assert.ok(second);
      assert.deepEqual(
        [...second].map((model) => model["~"].names.ts),
        ["tag"]
      );
      assert.equal(models.size, 2);
    });
  });
  it("keeps generated scalar and compound identity sets below SQLite expression depth", async () => {
    await withWorld(async ({ database }) => {
      database.exec(
        "CREATE TABLE v1_compound(a INTEGER NOT NULL,b INTEGER NOT NULL,PRIMARY KEY(a,b))"
      );
      const compound = s
        .model({ a: s.int(), b: s.int() })
        .id(["a", "b"])
        .map("v1_compound");
      const put = database.prepare("INSERT INTO v1_compound VALUES(?,?)");
      database.transaction(() => {
        for (let id = 0; id < 1100; id++) put.run(id, id);
      })();
      const queries = new Queries(
        new EngineSchema({ compound, child, parent }),
        new SQLiteAdapter()
      );
      const pairs = queries.lowerSelector(
        queries.includeIdentities(
          compound,
          Array.from({ length: 1100 }, (_, id) => ({ a: id, b: id }))
        )
      );
      assert.ok(pairs);
      assert.equal(
        database
          .prepare<unknown[], { n: number }>(
            `SELECT count(*) AS n FROM v1_compound WHERE ${pairs.toStatement()}`
          )
          .get(...pairs.values)?.n,
        1100
      );
      const ids = queries.lowerSelector(
        queries.includeIdentities(
          child,
          Array.from({ length: 1100 }, (_, id) => ({ id }))
        )
      );
      assert.ok(ids);
      assert.match(ids.toStatement(), IN_PATTERN);
      assert.equal(
        database
          .prepare<unknown[], { n: number }>(
            `SELECT count(*) AS n FROM v1_child WHERE ${ids.toStatement()}`
          )
          .get(...ids.values)?.n,
        3
      );
    });
  });
  it("deduplicates compound connects before a prior connect rewrites their selector", async () => {
    await withWorld(async ({ database, driver }) => {
      const account = s
        .model({ id: s.int().id(), rows: s.toMany(() => entry) })
        .map("v1_accounts");
      const entry = s
        .model({
          accountId: s.int(),
          id: s.int(),
          account: s
            .toOne(() => account)
            .fields("accountId")
            .references("id"),
        })
        .id(["accountId", "id"])
        .map("v1_entries");
      database.exec(
        "CREATE TABLE v1_accounts(id INTEGER PRIMARY KEY); CREATE TABLE v1_entries(accountId INTEGER NOT NULL,id INTEGER NOT NULL,PRIMARY KEY(accountId,id),FOREIGN KEY(accountId) REFERENCES v1_accounts(id)); INSERT INTO v1_accounts VALUES(1),(2); INSERT INTO v1_entries VALUES(2,9)"
      );
      const engine = createTestCommandEngine({
        schema: { account, entry },
        driver,
      });
      await engine.execute("account", "update", {
        where: { id: 1 },
        data: {
          rows: {
            connect: [
              { accountId_id: { accountId: 2, id: 9 } },
              { accountId_id: { accountId: 2, id: 9 } },
            ],
          },
        },
      });
      assert.deepEqual(database.prepare("SELECT * FROM v1_entries").all(), [
        { accountId: 1, id: 9 },
      ]);
    });
  });
  it("stores vectors through the promised JSON fallback", async () => {
    await withWorld(async ({ database, driver }) => {
      const vector = s
        .model({ id: s.int().id(), embedding: s.vector().dimension(2) })
        .map("v1_vector");
      database.exec(
        "CREATE TABLE v1_vector(id INTEGER PRIMARY KEY,embedding TEXT NOT NULL)"
      );
      const engine = createTestCommandEngine({ schema: { vector }, driver });
      assert.deepEqual(
        await engine.execute("vector", "create", {
          data: { id: 1, embedding: [1.25, -2.5] },
        }),
        { id: 1, embedding: [1.25, -2.5] }
      );
      assert.equal(
        database
          .prepare<[], { embedding: string }>("SELECT embedding FROM v1_vector")
          .get()?.embedding,
        "[1.25,-2.5]"
      );
      const mysql = new Queries(
        new EngineSchema({ vector }),
        new MySQLAdapter()
      );
      assert.deepEqual(
        mysql.fieldValue(vector, "embedding", [1.25, -2.5]).values,
        ["[1.25,-2.5]"]
      );
    });
  });
  it("decodes absent vectors and zero-norm cosine distances as null, while L2 remains required", () => {
    const model = s.model({
      id: s.int().id(),
      embedding: s.vector().dimension(2),
      maybe: s.vector().dimension(2).nullable(),
    });
    const adapter = new PostgresAdapter();
    adapter.capabilities.supportsVector = true;
    const queries = new Queries(new EngineSchema({ model }), adapter);
    const cosine = queries.prepareProjection(model, {
      select: { embedding: { _distance: { to: [0, 0], metric: "cosine" } } },
    }).shape;
    assert.deepEqual(queries.decodeProjection(cosine, [{ _distance: null }]), [
      { _distance: null },
    ]);
    const nullable = queries.prepareProjection(model, {
      select: { maybe: { _distance: { to: [1, 1], metric: "l2" } } },
    }).shape;
    assert.deepEqual(
      queries.decodeProjection(nullable, [{ _distance: null }]),
      [{ _distance: null }]
    );
    const l2 = queries.prepareProjection(model, {
      select: { embedding: { _distance: { to: [1, 1], metric: "l2" } } },
    }).shape;
    assert.throws(() => queries.decodeProjection(l2, [{ _distance: null }]));
  });
  it("refuses unsupported nested suppression before any array member or parent writes", async () => {
    await withWorld(async ({ database, driver }) => {
      const client = createClient({ schema: { parent, child }, driver });
      try {
        await assert.rejects(
          client.$transaction([
            client.parent.create({ data: { id: 20 } }),
            client.parent.create({
              data: {
                id: 21,
                children: {
                  createMany: {
                    data: [{ id: 20, rank: 1 }],
                    skipDuplicates: true,
                  },
                },
              },
            }),
          ]),
          UnsupportedOperationError
        );
        assert.equal(
          database
            .prepare<[], { n: number }>(
              "SELECT count(*) AS n FROM v1_parent WHERE id IN (20,21)"
            )
            .get()?.n,
          0
        );
        assert.equal(
          driver.statements.filter((statement) =>
            INSERT_UPDATE_DELETE_PATTERN.test(statement)
          ).length,
          0
        );
      } finally {
        await client.$disconnect();
      }
    });
  });
  it("clears before adopting children, and refuses contradictory spelling before writes", () =>
    withWorld(async (w) => {
      await w.engine.execute("parent", "update", {
        where: { id: 1 },
        data: {
          children: {
            set: [],
            connectOrCreate: [{ where: { id: 2 }, create: { id: 2, rank: 1 } }],
          },
        },
      });
      assert.deepEqual(
        w.database.prepare("SELECT id FROM v1_child WHERE parentId=1").all(),
        [{ id: 2 }]
      );
      await assert.rejects(
        w.engine.execute("parent", "update", {
          where: { id: 1 },
          data: { children: { create: { id: 4, rank: 2 }, deleteMany: {} } },
        }),
        MUST_SPELL_CLEARING_VERB_PATTERN
      );
      assert.equal(
        w.database
          .prepare<[], { n: number }>(
            "SELECT count(*) AS n FROM v1_child WHERE id=4"
          )
          .get()!.n,
        0
      );
    }));
  it("keeps one null policy and tie-break across complete and offset pages", () =>
    withWorld(async (w) => {
      const args = { orderBy: { rank: "asc" }, select: { id: true } };
      const all = await w.engine.execute("child", "findMany", args);
      assert.deepEqual(all, [{ id: 2 }, { id: 3 }, { id: 1 }]);
      const first = await w.engine.execute("child", "findMany", {
        ...args,
        take: 1,
      });
      const rest = await w.engine.execute("child", "findMany", {
        ...args,
        skip: 1,
      });
      assert.ok(Array.isArray(first));
      assert.ok(Array.isArray(rest));
      assert.deepEqual([...first, ...rest], all);
    }));
  it("bare polymorphic every admits empty and matching-only shelves", () =>
    withWorld(async (w) => {
      assert.deepEqual(
        await w.engine.execute("shelf", "findMany", {
          where: { items: { every: { type: "book" } } },
          select: { id: true },
          orderBy: { id: "asc" },
        }),
        [{ id: 1 }, { id: 2 }]
      );
      assert.deepEqual(
        await w.engine.execute("shelf", "findMany", {
          where: { NOT: { items: { every: { type: "book" } } } },
          select: { id: true },
          orderBy: { id: "asc" },
        }),
        [{ id: 3 }, { id: 4 }]
      );
    }));
  it("adopts duplicate generated-key targets through the unique key the caller supplied", () =>
    withWorld(async (w) => {
      await w.engine.execute("tag", "create", { data: { name: "existing" } });
      await w.engine
        .execute("owner", "update", {
          where: { id: 1 },
          data: {
            tags: {
              createMany: {
                data: [{ name: "existing" }],
                skipDuplicates: true,
              },
            },
          },
        })
        .catch(() => {
          throw w.driver.failure;
        });
      assert.equal(
        w.database
          .prepare<[], { n: number }>("SELECT count(*) AS n FROM v1_links")
          .get()!.n,
        1
      );
    }));
  it("decodes PostgreSQL ancient, BC and second-offset timestamps and text arrays", () => {
    const event = s.model({
      id: s.int().id(),
      at: s.dateTime(),
      dates: s.dateTime().array(),
      day: s.date(),
      days: s.date().array(),
    });
    const queries = new Queries(
      new EngineSchema({ event }),
      new PostgresAdapter()
    );
    const shape = queries.prepareProjection(event, {}).shape;
    const cases: readonly (readonly [string, string])[] = [
      ["0001-01-01 00:00:00+00", "0001-01-01T00:00:00.000Z"],
      ["0001-01-01T00:09:21+00:09:21", "0001-01-01T00:00:00.000Z"],
      ["0001-01-01 00:00:00+00 BC", "0000-01-01T00:00:00.000Z"],
    ];
    for (const [physical, expected] of cases) {
      const dateWire = physical.includes(" BC")
        ? "0001-01-01 BC"
        : physical.slice(0, 10);
      const rows = queries.decodeProjection(shape, [
        {
          id: 1,
          at: physical,
          dates: `{"${physical}"}`,
          day: dateWire,
          days: `{"${dateWire}"}`,
        },
      ]);
      const row = rows[0]!;
      assert.ok(row.at instanceof Date);
      assert.ok(row.day instanceof Date);
      assert.ok(Array.isArray(row.dates));
      assert.ok(Array.isArray(row.days));
      assert.ok(row.dates[0] instanceof Date);
      assert.ok(row.days[0] instanceof Date);
      assert.equal(row.at.toISOString(), expected);
      assert.equal(row.dates[0].toISOString(), expected);
      assert.equal(row.day.toISOString(), expected);
      assert.equal(row.days[0].toISOString(), expected);
    }
    const leap = queries.decodeProjection(shape, [
      {
        id: 1,
        at: "0001-02-29 00:00:00 BC",
        dates: "{}",
        day: "0001-02-29 BC",
        days: "{}",
      },
    ]);
    assert.ok(leap[0]!.day instanceof Date);
    assert.equal(leap[0]!.day.toISOString(), "0000-02-29T00:00:00.000Z");
    assert.throws(() =>
      queries.decodeProjection(shape, [
        {
          id: 1,
          at: "0001-01-01 00:00:00",
          dates: "{}",
          day: "0001-02-29",
          days: "{}",
        },
      ])
    );
  });
  it("coalesces plain nested createMany inserts without losing rollback", () =>
    withWorld(async (w) => {
      await w.engine.execute("parent", "update", {
        where: { id: 1 },
        data: {
          children: {
            createMany: {
              data: [
                { id: 4, rank: 2 },
                { id: 5, rank: 3 },
              ],
            },
          },
        },
      });
      assert.equal(
        w.driver.statements.filter(
          (statement) =>
            statement.startsWith("INSERT INTO") &&
            statement.includes("v1_child")
        ).length,
        1
      );
      await assert.rejects(
        w.engine.execute("parent", "update", {
          where: { id: 1 },
          data: {
            children: {
              createMany: {
                data: [
                  { id: 6, rank: 2 },
                  { id: 1, rank: 3 },
                ],
              },
            },
          },
        })
      );
      assert.equal(
        w.database
          .prepare<[], { n: number }>(
            "SELECT count(*) AS n FROM v1_child WHERE id=6"
          )
          .get()!.n,
        0
      );
    }));
  it("preserves generated identity allocation across heterogeneous nested row shapes", () =>
    withWorld(async (w) => {
      const autoOwner = s
        .model({ id: s.int().id(), children: s.toMany(() => autoChild) })
        .map("v1_auto_owner");
      const autoChild = s
        .model({
          id: s.int().id().increment(),
          name: s.string(),
          score: s.number().nullable(),
          ownerId: s.int(),
          owner: s
            .toOne(() => autoOwner)
            .fields("ownerId")
            .references("id"),
        })
        .map("v1_auto_child");
      w.database.exec(
        "CREATE TABLE v1_auto_owner(id INTEGER PRIMARY KEY); CREATE TABLE v1_auto_child(id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT NOT NULL,score REAL,ownerId INTEGER NOT NULL);"
      );
      const engine = createTestCommandEngine({
        schema: { autoOwner, autoChild },
        driver: w.driver,
      });
      await engine.execute("autoOwner", "create", {
        data: {
          id: 1,
          children: {
            createMany: {
              data: [
                { name: "a" },
                { id: 100, name: "b", score: 1 },
                { name: "c" },
              ],
            },
          },
        },
      });
      assert.deepEqual(
        w.database
          .prepare("SELECT id,name FROM v1_auto_child ORDER BY id")
          .all(),
        [
          { id: 1, name: "a" },
          { id: 100, name: "b" },
          { id: 101, name: "c" },
        ]
      );
      assert.equal(
        w.driver.statements.filter(
          (statement) =>
            statement.startsWith("INSERT INTO") &&
            statement.includes("v1_auto_child")
        ).length,
        3
      );
    }));
  it("uses the native eligible live upsert without planning round trips", () =>
    withWorld(async (w) => {
      await w.engine.execute("child", "upsert", {
        where: { id: 2 },
        create: { id: 2, rank: 9 },
        update: { rank: 4 },
      });
      assert.equal(
        w.driver.statements.filter(
          (statement) =>
            statement.startsWith("INSERT INTO") &&
            statement.includes("ON CONFLICT")
        ).length,
        1
      );
      assert.equal(
        w.driver.statements.filter((statement) =>
          statement.startsWith("SELECT")
        ).length,
        0
      );
    }));
  it("publishes a trigger-suppressed row count after a completed bulk write", () =>
    withWorld(async (w) => {
      w.database.exec(
        "CREATE TRIGGER v1_suppress BEFORE INSERT ON v1_child WHEN NEW.rank=99 BEGIN SELECT RAISE(IGNORE); END;"
      );
      assert.deepEqual(
        await w.engine.execute("child", "createMany", {
          data: [
            { id: 4, rank: 1 },
            { id: 5, rank: 99 },
          ],
        }),
        { count: 1 }
      );
      assert.deepEqual(
        w.database.prepare("SELECT id FROM v1_child WHERE id>=4").all(),
        [{ id: 4 }]
      );
    }));
  it("reads stored JSON without repeating input validation or transforms", () => {
    let calls = 0;
    const validator: StandardSchemaV1<JsonValue, { n: number }> = {
      "~standard": {
        vendor: "v1",
        version: 1,
        validate(value) {
          calls++;
          return isRecord(value) && typeof value.n === "number"
            ? { value: { n: value.n * 100 } }
            : { issues: [{ message: "expected n" }] };
        },
      },
    };
    const model = s.model({
      id: s.int().id(),
      document: s.json().schema(validator),
    });
    const queries = new Queries(
      new EngineSchema({ model }),
      new PostgresAdapter()
    );
    const shape = queries.prepareProjection(model, {}).shape;
    assert.deepEqual(
      queries.decodeProjection(shape, [{ id: 1, document: { n: 1250 } }]),
      [{ id: 1, document: { n: 1250 } }]
    );
    assert.deepEqual(
      queries.decodeProjection(shape, [{ id: 2, document: { old: "legacy" } }]),
      [{ id: 2, document: { old: "legacy" } }]
    );
    assert.equal(calls, 0);
  });
  it("decodes native JSON integer carriers with JSON.parse Number semantics", () => {
    const model = s.model({ id: s.int().id(), document: s.json() });
    const queries = new Queries(
      new EngineSchema({ model }),
      new SQLiteAdapter()
    );
    const shape = queries.prepareProjection(model, {}).shape;
    assert.deepEqual(
      queries.decodeProjection(shape, [{ id: 1, document: 9007199254740994n }]),
      [{ id: 1, document: 9_007_199_254_740_994 }]
    );
    assert.deepEqual(
      queries.decodeProjection(shape, [{ id: 2, document: 9007199254740993n }]),
      [{ id: 2, document: JSON.parse("9007199254740993") }]
    );
    assert.throws(() =>
      queries.decodeProjection(shape, [{ id: 3, document: 10n ** 309n }])
    );
  });
  it("requires aggregate rows and short-circuits existence through EXISTS", () => {
    const model = s.model({ id: s.int().id() });
    const queries = new Queries(
      new EngineSchema({ model }),
      new PostgresAdapter()
    );
    const count = queries.read(model, "count", { data: {} });
    assert.throws(
      () => queries.decodeQuery(count.query, []),
      REQUIRED_AGGREGATE_RESULT_ROW_PATTERN
    );
    const exists = queries.read(model, "exist", { data: {} });
    assert.match(exists.query.sql.strings.join(""), EXISTS_PATTERN);
    assert.throws(
      () => queries.decodeQuery(exists.query, []),
      REQUIRED_EXISTENCE_RESULT_ROW_PATTERN
    );
  });
  it("bind chunk compilation visits a bounded amount of semantic input", () => {
    let visited = 0;
    const chunks = compileBindBudgetChunks(80_000, 1000, (start, end) => {
      visited += end - start;
      return sql.join(
        Array.from({ length: end - start }, () => sql`${1}`),
        ","
      );
    });
    assert.equal(chunks.length, 80);
    assert.equal(chunks[0]!.end, 1000);
    assert.equal(chunks.at(-1)!.end, 80_000);
    assert.ok(visited < 1_500_000, `compiled ${visited} values`);
  });
});
