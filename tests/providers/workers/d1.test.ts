import { env } from "cloudflare:test";
import type { D1Database } from "@cloudflare/workers-types";
import { MemoryCache } from "@src/cache/drivers/memory";
import { cache as cacheExtension } from "@src/cache/extension";
import { createClient, D1Driver } from "@src/drivers/d1";
import {
  CacheConfigurationError,
  TransactionError,
  UniqueConstraintError,
  UnsupportedOperationError,
  VibORMError,
} from "@src/errors";
import { s } from "@src/schema";
import { string } from "@src/schema/scalars/string/scalar";
import { parse } from "@src/validation";
import { getScalarSchemas } from "@src/validation/scalars";
import {
  type GeoPointBehaviorClient,
  geoPointBatchContract,
  geoPointContract,
  setupGeoPointBehaviorSQLite,
} from "@tests/contracts/drivers/behaviors/geopoint-behavior";
import Decimal from "decimal.js";

declare module "cloudflare:test" {
  interface ProvidedEnv {
    DB: D1Database;
  }
}

const TABLE = "viborm_d1_driver_core";
const DECIMAL_TABLE = "viborm_d1_decimal_evidence";
const DECIMAL_DOMAIN = { precision: 16, scale: 2 };
const PAST_DOUBLE = "99999999999999.99";
const PAST_DOUBLE_NEIGHBOUR = "99999999999999.98";
const PAST_DOUBLE_COEFFICIENT = "9999999999999999";
const CUID_PATTERN = /^[a-z][0-9a-z]{23}$/;

const GEOPOINT_TABLES = [
  "geopoint_behavior_markers",
  "geopoint_behavior_stops",
  "geopoint_behavior_articles",
  "geopoint_behavior_videos",
  "geopoint_behavior_routes",
  "geopoint_behavior_places",
] as const;

async function setupD1GeoPoint(client: GeoPointBehaviorClient): Promise<void> {
  for (const table of GEOPOINT_TABLES) {
    await client.$executeRawUnsafe(`DROP TABLE IF EXISTS "${table}"`);
  }
  await setupGeoPointBehaviorSQLite(client);
}

geoPointContract.register({
  driverName: "D1",
  createDriver: () => new D1Driver({ database: env.DB }),
  tier: "storage",
  rawSelectSql:
    "SELECT location FROM geopoint_behavior_places WHERE id = 'raw'",
  setup: setupD1GeoPoint,
  callbackTransactions: false,
});

geoPointBatchContract.register({
  driverName: "D1",
  createDriver: () => new D1Driver({ database: env.DB }),
  setup: setupD1GeoPoint,
});

const decimalEvidence = s
  .model({
    id: s.string().id(),
    amount: s.decimal(DECIMAL_DOMAIN),
    amounts: s.decimal(DECIMAL_DOMAIN).array(),
  })
  .map(DECIMAL_TABLE);
const decimalEvidenceSchema = { decimalEvidence };

class ProgressiveInvalidationCache extends MemoryCache {
  clearCalls = 0;
  private readonly clearFailure: Error | undefined;

  constructor(clearFailure?: Error) {
    super();
    this.clearFailure = clearFailure;
  }

  protected override async clear(prefix: string): Promise<void> {
    this.clearCalls += 1;
    if (this.clearFailure) throw this.clearFailure;
    return super.clear(prefix);
  }
}

const progressiveAuthor = s
  .model({
    id: s.string().id(),
    name: s.string().unique(),
    posts: s.toMany(() => progressivePost),
  })
  .map("viborm_d1_progressive_authors");
const progressiveCategory = s
  .model({
    id: s.string().id(),
    name: s.string().unique(),
    posts: s.toMany(() => progressivePost),
  })
  .map("viborm_d1_progressive_categories");
const progressivePost = s
  .model({
    id: s.string().id(),
    title: s.string(),
    authorId: s.string(),
    author: s
      .toOne(() => progressiveAuthor)
      .fields("authorId")
      .references("id"),
    categoryId: s.string().nullable(),
    category: s
      .toOne(() => progressiveCategory)
      .fields("categoryId")
      .references("id"),
  })
  .map("viborm_d1_progressive_posts");
const progressiveSchema = {
  author: progressiveAuthor,
  category: progressiveCategory,
  post: progressivePost,
};
const generatedAuthor = s
  .model({
    id: s.int().id().increment(),
    name: s.string().unique(),
    posts: s.toMany(() => generatedPost),
  })
  .map("viborm_d1_generated_authors");
const generatedCategory = s
  .model({
    id: s.string().id(),
    name: s.string().unique(),
    posts: s.toMany(() => generatedPost),
  })
  .map("viborm_d1_generated_categories");
const generatedPost = s
  .model({
    id: s.string().id(),
    title: s.string(),
    authorId: s.int(),
    author: s
      .toOne(() => generatedAuthor)
      .fields("authorId")
      .references("id"),
    categoryId: s.string().nullable(),
    category: s
      .toOne(() => generatedCategory)
      .fields("categoryId")
      .references("id"),
  })
  .map("viborm_d1_generated_posts");
const generatedProgressiveSchema = {
  author: generatedAuthor,
  category: generatedCategory,
  post: generatedPost,
};

type D1Statement = ReturnType<D1Database["prepare"]>;

interface BindObservation {
  readonly query: string;
  readonly values: readonly unknown[];
}

function observeStatementBinds(
  database: D1Database,
  observations: BindObservation[]
): D1Database {
  function wrapStatement(statement: D1Statement, query: string): D1Statement {
    return new Proxy(statement, {
      get(target, property) {
        if (property === "bind") {
          return (...values: unknown[]) => {
            observations.push({ query, values });
            return wrapStatement(target.bind(...values), query);
          };
        }
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  }

  return new Proxy(database, {
    get(target, property) {
      if (property === "prepare") {
        return (query: string) => wrapStatement(target.prepare(query), query);
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

function observeBatchSizes(
  database: D1Database,
  batchSizes: number[]
): D1Database {
  return new Proxy(database, {
    get(target, property) {
      if (property === "batch") {
        return (statements: D1Statement[]) => {
          batchSizes.push(statements.length);
          return target.batch(statements);
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

function movePostAfterNestedMemberLocate(database: D1Database): D1Database {
  let postReadCount = 0;
  let moved = false;
  const statementQueries = new WeakMap<D1Statement, string>();

  async function observePostRead(query: string): Promise<void> {
    if (
      moved ||
      !query.trimStart().startsWith("SELECT") ||
      !query.includes("viborm_d1_progressive_posts")
    ) {
      return;
    }
    // The first read fixes the relation member set. The second locates that
    // member for its record compiler; moving it now places the race immediately
    // before the guard and write that must share the next D1 batch.
    postReadCount += 1;
    if (postReadCount !== 2) return;
    moved = true;
    await database
      .prepare(
        "UPDATE viborm_d1_progressive_posts SET authorId = ? WHERE id = ?"
      )
      .bind("a2", "p1")
      .run();
  }

  function wrapStatement(statement: D1Statement, query: string): D1Statement {
    const wrapped = new Proxy(statement, {
      get(target, property) {
        if (property === "bind") {
          return (...values: unknown[]) =>
            wrapStatement(target.bind(...values), query);
        }
        if (property === "run") {
          return async () => {
            const result = await target.run();
            await observePostRead(query);
            return result;
          };
        }
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    statementQueries.set(wrapped, query);
    return wrapped;
  }

  return new Proxy(database, {
    get(target, property) {
      if (property === "prepare") {
        return (query: string) => wrapStatement(target.prepare(query), query);
      }
      if (property === "batch") {
        return async (statements: D1Statement[]) => {
          const results = await target.batch(statements);
          for (const statement of statements) {
            const query = statementQueries.get(statement);
            if (query) await observePostRead(query);
          }
          return results;
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

beforeAll(async () => {
  await env.DB.exec(
    `CREATE TABLE IF NOT EXISTS ${TABLE} (id TEXT PRIMARY KEY, value TEXT NOT NULL);
     CREATE TABLE IF NOT EXISTS viborm_d1_progressive_authors (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE);
     CREATE TABLE IF NOT EXISTS viborm_d1_progressive_categories (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE);
     CREATE TABLE IF NOT EXISTS viborm_d1_progressive_posts (id TEXT PRIMARY KEY, title TEXT NOT NULL, authorId TEXT NOT NULL REFERENCES viborm_d1_progressive_authors(id), categoryId TEXT REFERENCES viborm_d1_progressive_categories(id));
     CREATE TABLE IF NOT EXISTS viborm_d1_generated_authors (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE);
     CREATE TABLE IF NOT EXISTS viborm_d1_generated_categories (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE);
     CREATE TABLE IF NOT EXISTS viborm_d1_generated_posts (id TEXT PRIMARY KEY, title TEXT NOT NULL, authorId INTEGER NOT NULL REFERENCES viborm_d1_generated_authors(id), categoryId TEXT REFERENCES viborm_d1_generated_categories(id));
     CREATE TABLE IF NOT EXISTS ${DECIMAL_TABLE} (id TEXT PRIMARY KEY, amount INTEGER NOT NULL CONSTRAINT "viborm_decimal_amount_16_2" CHECK (typeof(amount) = 'integer' AND amount BETWEEN -9999999999999999 AND 9999999999999999), amounts TEXT NOT NULL CONSTRAINT "viborm_decimal_amounts_16_2" CHECK (typeof(amounts) = 'text' AND json_valid(amounts) AND json_type(amounts) = 'array'))`
  );
});

describe("D1 fixed-decimal provider evidence", () => {
  beforeEach(async () => {
    await env.DB.prepare(`DELETE FROM ${DECIMAL_TABLE}`).run();
  });

  it("keeps scalar and list coefficients exact beyond IEEE-754", async () => {
    const client = createClient({
      schema: decimalEvidenceSchema,
      database: env.DB,
    });

    try {
      const created = await client.decimalEvidence.create({
        data: {
          id: "exact",
          amount: PAST_DOUBLE,
          amounts: [PAST_DOUBLE, "-0.03"],
        },
      });
      await client.decimalEvidence.create({
        data: {
          id: "neighbour",
          amount: PAST_DOUBLE_NEIGHBOUR,
          amounts: [],
        },
      });

      expect(created.amount).toBeInstanceOf(Decimal);
      expect(created.amounts[0]).toBeInstanceOf(Decimal);
      expect(created.amount.eq(PAST_DOUBLE)).toBe(true);
      expect(created.amounts.map((amount) => amount.toString())).toEqual([
        PAST_DOUBLE,
        "-0.03",
      ]);

      const exactMatches = await client.decimalEvidence.findMany({
        where: { amount: { gt: PAST_DOUBLE_NEIGHBOUR } },
        select: { id: true },
      });
      expect(exactMatches).toEqual([{ id: "exact" }]);

      const ordered = await client.decimalEvidence.findMany({
        orderBy: [{ amount: "asc" }, { id: "asc" }],
        select: { id: true },
      });
      expect(ordered).toEqual([{ id: "neighbour" }, { id: "exact" }]);

      const aggregates = await client.decimalEvidence.aggregate({
        _min: { amount: true },
        _max: { amount: true },
        _sum: { amount: true },
        _avg: { amount: true },
      });
      expect(aggregates._min.amount?.eq(PAST_DOUBLE_NEIGHBOUR)).toBe(true);
      expect(aggregates._max.amount?.eq(PAST_DOUBLE)).toBe(true);
      expect(aggregates._sum.amount?.eq("199999999999999.97")).toBe(true);
      expect(aggregates._avg.amount?.eq(PAST_DOUBLE_NEIGHBOUR)).toBe(true);

      await client.decimalEvidence.create({
        data: { id: "rounding", amount: "0.05", amounts: [] },
      });
      const multiplied = await client.decimalEvidence.update({
        where: { id: "rounding" },
        data: { amount: { multiply: "0.5" } },
      });
      expect(multiplied.amount.eq("0.02")).toBe(true);
      await client.decimalEvidence.update({
        where: { id: "rounding" },
        data: { amount: { set: "1" } },
      });
      const divided = await client.decimalEvidence.update({
        where: { id: "rounding" },
        data: { amount: { divide: "8" } },
      });
      expect(divided.amount.eq("0.12")).toBe(true);

      const updated = await client.decimalEvidence.update({
        where: { id: "exact" },
        data: { amount: { decrement: "0.01" } },
      });
      expect(updated.amount.eq(PAST_DOUBLE_NEIGHBOUR)).toBe(true);

      const selected = await client.decimalEvidence.findUniqueOrThrow({
        where: { id: "exact" },
      });
      expect(selected.amount).toBeInstanceOf(Decimal);
      expect(selected.amounts[0]).toBeInstanceOf(Decimal);
      expect(selected.amount).not.toBe(updated.amount);
      expect(selected.amounts[0]).not.toBe(created.amounts[0]);

      const physical = await client.$queryRaw<{
        amount: string;
        amounts: string;
      }>`
        SELECT CAST(amount AS TEXT) AS amount, amounts
        FROM viborm_d1_decimal_evidence
        WHERE id = ${"exact"}
      `;
      expect(physical).toEqual([
        {
          amount: "9999999999999998",
          amounts: `["${PAST_DOUBLE_COEFFICIENT}","-3"]`,
        },
      ]);
    } finally {
      await client.$disconnect();
    }
  });

  it("refuses unsafe scalar storage and malformed list members", async () => {
    const client = createClient({
      schema: decimalEvidenceSchema,
      database: env.DB,
    });

    try {
      await expect(
        client.$executeRawUnsafe(
          `INSERT INTO ${DECIMAL_TABLE} (id, amount, amounts) VALUES ('unsafe-scalar', 1.5, '[]')`
        )
      ).rejects.toThrow();

      await client.$executeRawUnsafe(
        `INSERT INTO ${DECIMAL_TABLE} (id, amount, amounts) VALUES ('unsafe-list', 120, '["120",1]')`
      );
      await expect(
        client.decimalEvidence.findUniqueOrThrow({
          where: { id: "unsafe-list" },
        })
      ).rejects.toThrow();
    } finally {
      await client.$disconnect();
    }
  });
});

describe("D1 binding provider", () => {
  it("generates CUID defaults inside the worker request context", () => {
    const scalar = string().cuid();
    const parsed = parse(getScalarSchemas(scalar["~"].state).create, undefined);

    if (parsed.issues) throw new Error("Expected CUID generation to succeed");
    expect(parsed.value).toMatch(CUID_PATTERN);
  });

  it("executes bound writes and normalizes rows", async () => {
    const driver = new D1Driver({ database: env.DB });
    const id = crypto.randomUUID();

    await driver._executeRaw(`INSERT INTO ${TABLE} (id, value) VALUES (?, ?)`, [
      id,
      "O'Reilly",
    ]);
    const selected = await driver._executeRaw<{ id: string; value: string }>(
      `SELECT id, value FROM ${TABLE} WHERE id = ?`,
      [id]
    );

    expect(selected).toEqual({
      rows: [{ id, value: "O'Reilly" }],
      rowCount: 1,
    });
  });

  it("keeps a failed native batch atomic", async () => {
    const driver = new D1Driver({ database: env.DB });
    const id = crypto.randomUUID();

    await expect(
      driver._executeBatch([
        {
          sql: `INSERT INTO ${TABLE} (id, value) VALUES (?, ?)`,
          params: [id, "first"],
        },
        {
          sql: `INSERT INTO ${TABLE} (id, value) VALUES (?, ?)`,
          params: [id, "duplicate"],
        },
      ])
    ).rejects.toThrow();

    const selected = await driver._executeRaw<{ count: number }>(
      `SELECT COUNT(*) AS count FROM ${TABLE} WHERE id = ?`,
      [id]
    );
    expect(selected.rows).toEqual([{ count: 0 }]);
  });

  it("executes a native batch in order and publishes its commit to the next batch", async () => {
    const driver = new D1Driver({ database: env.DB });
    expect(driver.supportsOrderedCommittedSegments).toBe(true);
    const id = crypto.randomUUID();

    const first = await driver._executeBatch([
      {
        sql: `INSERT INTO ${TABLE} (id, value) VALUES (?, ?)`,
        params: [id, "first"],
      },
      {
        sql: `UPDATE ${TABLE} SET value = ? WHERE id = ?`,
        params: ["second", id],
      },
      { sql: `SELECT value FROM ${TABLE} WHERE id = ?`, params: [id] },
    ]);
    expect(first[2]?.rows).toEqual([{ value: "second" }]);

    const later = await driver._executeBatch([
      { sql: `SELECT value FROM ${TABLE} WHERE id = ?`, params: [id] },
    ]);
    expect(later[0]?.rows).toEqual([{ value: "second" }]);

    const laterSingle = await driver._executeRaw<{ value: string }>(
      `SELECT value FROM ${TABLE} WHERE id = ?`,
      [id]
    );
    expect(laterSingle.rows).toEqual([{ value: "second" }]);
  });

  it("mixes raw and model operations in one ordered client batch", async () => {
    const batchSizes: number[] = [];
    const client = createClient({
      schema: progressiveSchema,
      database: observeBatchSizes(env.DB, batchSizes),
    });
    await client.post.deleteMany({});
    await client.author.deleteMany({});
    await client.category.deleteMany({});
    await client.author.create({
      data: { id: "raw-order-author", name: "before" },
    });
    batchSizes.length = 0;

    const [affected, modelRow, rawRows] = await client.$transaction([
      client.$executeRaw`
        UPDATE viborm_d1_progressive_authors
        SET name = ${"after"}
        WHERE id = ${"raw-order-author"}
      `,
      client.author.findUniqueOrThrow({
        where: { id: "raw-order-author" },
      }),
      client.$queryRaw<{ id: string; name: string }>`
        SELECT id, name
        FROM viborm_d1_progressive_authors
        WHERE name = ${"after"}
      `,
    ]);

    expect(affected).toBe(1);
    expect(modelRow).toEqual({ id: "raw-order-author", name: "after" });
    expect(rawRows).toEqual([{ id: "raw-order-author", name: "after" }]);
    expect(batchSizes).toEqual([3]);
  });

  it("rolls model and raw writes back when a later raw D1 member fails", async () => {
    const client = createClient({
      schema: progressiveSchema,
      database: env.DB,
    });
    await client.post.deleteMany({});
    await client.author.deleteMany({});
    await client.category.deleteMany({});
    await client.author.createMany({
      data: [
        { id: "raw-rollback-model", name: "model" },
        { id: "raw-rollback-raw", name: "raw" },
      ],
    });

    await expect(
      client.$transaction([
        client.author.update({
          where: { id: "raw-rollback-model" },
          data: { name: "model-written" },
        }),
        client.$executeRaw`
          UPDATE viborm_d1_progressive_authors
          SET name = ${"raw-written"}
          WHERE id = ${"raw-rollback-raw"}
        `,
        client.$queryRawUnsafe(
          "SELECT * FROM viborm_d1_table_that_does_not_exist"
        ),
      ])
    ).rejects.toThrow();

    await expect(
      client.author.findMany({
        orderBy: { id: "asc" },
        select: { id: true, name: true },
      })
    ).resolves.toEqual([
      { id: "raw-rollback-model", name: "model" },
      { id: "raw-rollback-raw", name: "raw" },
    ]);
  });

  it("returns generated scalar upsert output from one explicit D1 array", async () => {
    const batchSizes: number[] = [];
    const client = createClient({
      schema: generatedProgressiveSchema,
      database: observeBatchSizes(env.DB, batchSizes),
    });
    await client.post.deleteMany({});
    await client.author.deleteMany({});
    await client.category.deleteMany({});
    batchSizes.length = 0;

    const [upserted, created] = await client.$transaction([
      client.author.upsert({
        where: { id: 2_000_000_001 },
        create: { name: "generated-upsert" },
        update: { name: "must-not-run" },
        select: { id: true, name: true },
      }),
      client.author.create({
        data: { name: "generated-create" },
        select: { id: true, name: true },
      }),
    ]);

    expect(upserted).toEqual({
      id: expect.any(Number),
      name: "generated-upsert",
    });
    expect(created).toEqual({
      id: expect.any(Number),
      name: "generated-create",
    });
    expect(upserted.id).not.toBe(2_000_000_001);
    expect(upserted.id).not.toBe(created.id);
    // The locate probe runs before the indivisible unit. The final native batch
    // contains only the generated-output INSERT and its array sibling.
    expect(batchSizes).toEqual([2]);
    await expect(
      client.author.findMany({
        orderBy: { id: "asc" },
        select: { id: true, name: true },
      })
    ).resolves.toEqual([upserted, created]);
  });

  it("keeps a relation DAG with generated output outside non-CTE D1 arrays", async () => {
    const client = createClient({
      schema: generatedProgressiveSchema,
      database: env.DB,
    });
    await client.post.deleteMany({});
    await client.author.deleteMany({});
    await client.category.deleteMany({});

    const refusal = await client
      .$transaction([
        client.author.create({
          data: {
            name: "unfoldable-author",
            posts: {
              create: { id: "unfoldable-post", title: "must not run" },
            },
          },
          select: { id: true },
        }),
        client.category.create({
          data: { id: "unfoldable-sibling", name: "must not run" },
        }),
      ])
      .then(
        () => undefined,
        (error: unknown) => error
      );
    expect(refusal).toBeInstanceOf(TransactionError);
    if (!(refusal instanceof TransactionError)) throw refusal;
    expect(refusal.code).toBe("V5001");
    expect(refusal.message).toBe(
      "query-engine-v2 cannot merge an insertId-scratch operation into a shared driver batch."
    );
    await expect(client.author.findMany()).resolves.toEqual([]);
    await expect(client.post.findMany()).resolves.toEqual([]);
    await expect(client.category.findMany()).resolves.toEqual([]);
  });

  it("executes relation-bearing createMany as ordered committed members", async () => {
    const client = createClient({
      schema: progressiveSchema,
      database: env.DB,
    });
    await client.post.deleteMany({});
    await client.author.deleteMany({});
    await client.category.deleteMany({});

    await expect(
      client.post.createMany({
        data: [
          {
            id: "p1",
            title: "one",
            author: { create: { id: "a1", name: "shared" } },
          },
          {
            id: "p2",
            title: "two",
            author: {
              connectOrCreate: {
                where: { name: "shared" },
                create: { id: "unused", name: "shared" },
              },
            },
          },
        ],
      })
    ).resolves.toEqual({ count: 2 });

    await expect(
      client.post.findMany({ orderBy: { id: "asc" } })
    ).resolves.toEqual([
      { id: "p1", title: "one", authorId: "a1", categoryId: null },
      { id: "p2", title: "two", authorId: "a1", categoryId: null },
    ]);
  });

  it("chunks a relation-bearing nested createMany to D1's verified bind budget", async () => {
    const setup = createClient({
      schema: progressiveSchema,
      database: env.DB,
    });
    await setup.post.deleteMany({});
    await setup.author.deleteMany({});
    await setup.category.deleteMany({});

    const observations: BindObservation[] = [];
    const client = createClient({
      schema: progressiveSchema,
      database: observeStatementBinds(env.DB, observations),
    });
    const children = Array.from({ length: 40 }, (_, index) => {
      const ordinal = String(index).padStart(2, "0");
      return {
        id: `bind-post-${ordinal}`,
        title: `row-${ordinal}`,
      };
    });

    await expect(
      client.author.create({
        data: {
          id: "bind-parent",
          name: "bind-parent",
          posts: { createMany: { data: children } },
        },
      })
    ).resolves.toMatchObject({ id: "bind-parent" });

    const childInserts = observations.filter(
      ({ query }) =>
        query.trimStart().startsWith("INSERT") &&
        query.includes("viborm_d1_progressive_posts")
    );
    expect(childInserts.length).toBeGreaterThan(1);
    expect(childInserts.every(({ values }) => values.length <= 100)).toBe(true);
    expect(childInserts.flatMap(({ values }) => values)).toHaveLength(120);
    await expect(
      setup.post.findMany({
        where: { authorId: "bind-parent" },
        orderBy: { title: "asc" },
        select: { title: true, authorId: true },
      })
    ).resolves.toEqual(
      children.map(({ title }) => ({ title, authorId: "bind-parent" }))
    );
  });

  it("rolls every createMany chunk back when a later D1 chunk fails", async () => {
    const client = createClient({
      schema: progressiveSchema,
      database: env.DB,
    });
    await client.post.deleteMany({});
    await client.author.deleteMany({});
    await client.category.deleteMany({});
    const children = Array.from({ length: 40 }, (_, index) => ({
      id: index === 39 ? "rollback-post-0" : `rollback-post-${index}`,
      title: `row-${index}`,
    }));

    await expect(
      client.author.create({
        data: {
          id: "rollback-parent",
          name: "rollback-parent",
          posts: { createMany: { data: children } },
        },
      })
    ).rejects.toBeInstanceOf(UniqueConstraintError);

    await expect(
      client.author.findUnique({ where: { id: "rollback-parent" } })
    ).resolves.toBeNull();
    await expect(
      client.post.findMany({ where: { authorId: "rollback-parent" } })
    ).resolves.toEqual([]);
  });

  it("executes relation-bearing updateMany as ordered committed members", async () => {
    const client = createClient({
      schema: progressiveSchema,
      database: env.DB,
    });
    await client.post.deleteMany({});
    await client.author.deleteMany({});
    await client.category.deleteMany({});
    await client.author.create({ data: { id: "a1", name: "author" } });
    await client.category.create({ data: { id: "c1", name: "category" } });
    await client.post.createMany({
      data: [
        { id: "p1", title: "one", authorId: "a1" },
        { id: "p2", title: "two", authorId: "a1" },
      ],
    });

    await expect(
      client.post.updateMany({
        data: {
          title: "moved",
          category: { connect: { id: "c1" } },
        },
      })
    ).resolves.toEqual({ count: 2 });
    await expect(
      client.post.findMany({
        orderBy: { id: "asc" },
        select: { id: true, title: true, categoryId: true },
      })
    ).resolves.toEqual([
      { id: "p1", title: "moved", categoryId: "c1" },
      { id: "p2", title: "moved", categoryId: "c1" },
    ]);
  });

  it("invalidates mutation cache after every committed member", async () => {
    const cache = new ProgressiveInvalidationCache();
    const client = createClient({
      schema: progressiveSchema,
      database: env.DB,
    }).$extends(cacheExtension({ driver: cache }));
    await client.post.deleteMany({});
    await client.author.deleteMany({});
    await client.category.deleteMany({});

    await client.post.createMany({
      data: [
        {
          id: "p1",
          title: "one",
          author: { create: { id: "a1", name: "one" } },
        },
        {
          id: "p2",
          title: "two",
          author: { create: { id: "a2", name: "two" } },
        },
      ],
      cache: { autoInvalidate: true },
    });

    expect(cache.clearCalls).toBe(2);
  });

  it("owns invalidation failure after the committed member and reports exact progress", async () => {
    const cache = new ProgressiveInvalidationCache(
      new Error("private cache transport failure")
    );
    const client = createClient({
      schema: progressiveSchema,
      database: env.DB,
    }).$extends(cacheExtension({ driver: cache }));
    await env.DB.exec(
      "DELETE FROM viborm_d1_progressive_posts; DELETE FROM viborm_d1_progressive_authors; DELETE FROM viborm_d1_progressive_categories"
    );

    const failure = await client.post
      .createMany({
        data: [
          {
            id: "p1",
            title: "committed",
            author: { create: { id: "a1", name: "one" } },
          },
          {
            id: "p2",
            title: "not attempted",
            author: { create: { id: "a2", name: "two" } },
          },
        ],
        cache: { autoInvalidate: true },
      })
      .catch((error) => error);

    expect(failure).toBeInstanceOf(CacheConfigurationError);
    expect(failure).toMatchObject({
      meta: {
        method: "invalidate",
        model: "post",
        operation: "createMany",
        recordSeriesProgress: {
          atomicity: "segment",
          phase: "invalidation",
          committedSegments: 1,
          completedMembers: 0,
          committedWriteMembers: 1,
          memberPath: [0],
          totalMembers: 2,
        },
      },
    });
    if (!(failure instanceof VibORMError)) throw failure;
    expect(failure.toJSON()).toMatchObject({
      meta: {
        recordSeriesProgress: {
          phase: "invalidation",
          committedSegments: 1,
          completedMembers: 0,
          committedWriteMembers: 1,
        },
      },
    });
    const rows = await env.DB.prepare(
      "SELECT id, authorId FROM viborm_d1_progressive_posts ORDER BY id"
    ).all();
    expect(rows.results).toEqual([{ id: "p1", authorId: "a1" }]);
  });

  it("reports the exact committed prefix when a later member fails", async () => {
    const client = createClient({
      schema: progressiveSchema,
      database: env.DB,
    });
    await client.post.deleteMany({});
    await client.author.deleteMany({});
    await client.category.deleteMany({});
    await client.author.create({
      data: { id: "occupied", name: "occupied" },
    });

    let failure: unknown;
    try {
      await client.post.createMany({
        data: [
          {
            id: "p1",
            title: "kept",
            author: { create: { id: "a1", name: "first" } },
          },
          {
            id: "p2",
            title: "fails",
            author: { create: { id: "a2", name: "occupied" } },
          },
        ],
      });
    } catch (error) {
      failure = error;
    }

    expect(failure).toMatchObject({
      meta: {
        recordSeriesProgress: {
          atomicity: "segment",
          phase: "member",
          committedSegments: 1,
          completedMembers: 1,
          committedWriteMembers: 1,
          memberPath: [1],
          totalMembers: 2,
        },
      },
    });
    if (!(failure instanceof VibORMError)) throw failure;
    expect(failure).toBeInstanceOf(UniqueConstraintError);
    expect(failure.toJSON()).toMatchObject({
      meta: {
        recordSeriesProgress: {
          committedSegments: 1,
          completedMembers: 1,
          committedWriteMembers: 1,
        },
      },
    });
    await expect(client.post.findMany()).resolves.toEqual([
      { id: "p1", title: "kept", authorId: "a1", categoryId: null },
    ]);
  });

  it("classifies a later member's planning failure after its committed prefix", async () => {
    const client = createClient({
      schema: progressiveSchema,
      database: env.DB,
    });
    await client.post.deleteMany({});
    await client.author.deleteMany({});
    await client.category.deleteMany({});

    const failure = await client.post
      .createMany({
        data: [
          {
            id: "p1",
            title: "kept",
            author: { create: { id: "a1", name: "first" } },
          },
          {
            id: "p2",
            title: "missing target",
            author: { connect: { name: "absent" } },
          },
        ],
      })
      .catch((error) => error);

    expect(failure).toMatchObject({
      meta: {
        recordSeriesProgress: {
          atomicity: "segment",
          phase: "planning",
          committedSegments: 1,
          completedMembers: 1,
          committedWriteMembers: 1,
          memberPath: [1],
          totalMembers: 2,
        },
      },
    });
    await expect(client.post.findMany()).resolves.toEqual([
      { id: "p1", title: "kept", authorId: "a1", categoryId: null },
    ]);
  });

  it("refuses progressive subtree skipping before the first member writes", async () => {
    const client = createClient({
      schema: progressiveSchema,
      database: env.DB,
    });
    await client.post.deleteMany({});
    await client.author.deleteMany({});
    await client.category.deleteMany({});

    const refusal = await client.post
      .createMany({
        data: [
          {
            id: "p1",
            title: "one",
            author: { create: { id: "a1", name: "one" } },
          },
        ],
        skipDuplicates: true,
      })
      .catch((error) => error);

    expect(refusal).toBeInstanceOf(UnsupportedOperationError);
    if (!(refusal instanceof UnsupportedOperationError)) throw refusal;
    expect(refusal.code).toBe("V8003");
    expect(refusal.message).toBe(
      "Driver 'd1' cannot execute this record series as committed segments because skipping root 'post.create' would leave prior effect 'author.create' committed."
    );
    await expect(client.post.findMany()).resolves.toEqual([]);
    await expect(client.author.findMany()).resolves.toEqual([]);
  });

  it("executes nested relation-bearing record series at their tree position", async () => {
    const client = createClient({
      schema: progressiveSchema,
      database: env.DB,
    });
    await client.post.deleteMany({});
    await client.author.deleteMany({});
    await client.category.deleteMany({});

    await expect(
      client.author.createMany({
        data: [
          {
            id: "a1",
            name: "root",
            posts: {
              createMany: {
                data: [
                  {
                    id: "p1",
                    title: "nested",
                    category: {
                      create: { id: "c1", name: "nested category" },
                    },
                  },
                ],
              },
            },
          },
        ],
      })
    ).resolves.toEqual({ count: 1 });
    await expect(client.author.findMany()).resolves.toEqual([
      { id: "a1", name: "root" },
    ]);
    await expect(client.post.findMany()).resolves.toEqual([
      {
        id: "p1",
        title: "nested",
        authorId: "a1",
        categoryId: "c1",
      },
    ]);
    await expect(client.category.findMany()).resolves.toEqual([
      { id: "c1", name: "nested category" },
    ]);
  });

  it("publishes a generated parent identity into nested createMany segments", async () => {
    const client = createClient({
      schema: generatedProgressiveSchema,
      database: env.DB,
    });
    await client.post.deleteMany({});
    await client.author.deleteMany({});
    await client.category.deleteMany({});

    const created = await client.author.create({
      data: {
        name: "generated parent",
        posts: {
          createMany: {
            data: [
              {
                id: "generated-post",
                title: "nested",
                category: {
                  create: { id: "generated-category", name: "category" },
                },
              },
            ],
          },
        },
      },
    });

    expect(created.id).toEqual(expect.any(Number));
    await expect(
      client.post.findUnique({ where: { id: "generated-post" } })
    ).resolves.toEqual({
      id: "generated-post",
      title: "nested",
      authorId: created.id,
      categoryId: "generated-category",
    });
  });

  it("executes guarded nested relation-bearing updateMany members", async () => {
    const client = createClient({
      schema: progressiveSchema,
      database: env.DB,
    });
    await client.post.deleteMany({});
    await client.author.deleteMany({});
    await client.category.deleteMany({});
    await client.author.create({ data: { id: "a1", name: "before" } });
    await client.category.create({ data: { id: "c1", name: "category" } });
    await client.post.create({
      data: { id: "p1", title: "before", authorId: "a1" },
    });

    await expect(
      client.author.update({
        where: { id: "a1" },
        data: {
          name: "after",
          posts: {
            updateMany: {
              where: { id: "p1" },
              data: {
                title: "updated",
                category: { connect: { id: "c1" } },
              },
            },
          },
        },
      })
    ).resolves.toEqual({ id: "a1", name: "after" });
    await expect(
      client.post.findUnique({ where: { id: "p1" } })
    ).resolves.toEqual({
      id: "p1",
      title: "updated",
      authorId: "a1",
      categoryId: "c1",
    });
  });

  it("stops a moved nested updateMany member in its guarded batch", async () => {
    const setup = createClient({
      schema: progressiveSchema,
      database: env.DB,
    });
    await setup.post.deleteMany({});
    await setup.author.deleteMany({});
    await setup.category.deleteMany({});
    await setup.author.createMany({
      data: [
        { id: "a1", name: "before" },
        { id: "a2", name: "other" },
      ],
    });
    await setup.category.create({ data: { id: "c1", name: "category" } });
    await setup.post.create({
      data: { id: "p1", title: "before", authorId: "a1" },
    });

    const raced = createClient({
      schema: progressiveSchema,
      database: movePostAfterNestedMemberLocate(env.DB),
    });
    const failure = await raced.author
      .update({
        where: { id: "a1" },
        data: {
          name: "committed prefix",
          posts: {
            updateMany: {
              where: { id: "p1" },
              data: {
                title: "must not commit",
                category: { connect: { id: "c1" } },
              },
            },
          },
        },
      })
      .catch((error) => error);

    expect(failure).toMatchObject({
      meta: {
        recordSeriesProgress: {
          atomicity: "segment",
          phase: "member",
          committedSegments: 1,
          completedMembers: 0,
          committedWriteMembers: 1,
          memberPath: [0],
          totalMembers: 1,
        },
      },
    });
    await expect(
      setup.author.findUnique({ where: { id: "a1" } })
    ).resolves.toEqual({ id: "a1", name: "committed prefix" });
    await expect(
      setup.post.findUnique({ where: { id: "p1" } })
    ).resolves.toEqual({
      id: "p1",
      title: "before",
      authorId: "a2",
      categoryId: null,
    });
  });

  it("refuses a mixed progressive $transaction([...]) before any write", async () => {
    const client = createClient({
      schema: progressiveSchema,
      database: env.DB,
    });
    await client.post.deleteMany({});
    await client.author.deleteMany({});
    await client.category.deleteMany({});

    const ordinary = client.category.create({
      data: { id: "never", name: "not committed" },
    });
    const series = client.post.createMany({
      data: [
        {
          id: "p1",
          title: "one",
          author: { create: { id: "a1", name: "one" } },
        },
      ],
    });
    await expect(client.$transaction([ordinary, series])).rejects.toMatchObject(
      {
        meta: { driver: "d1", method: "$transaction([...])" },
      }
    );
    await expect(client.post.findMany()).resolves.toEqual([]);
    await expect(client.author.findMany()).resolves.toEqual([]);
    await expect(client.category.findMany()).resolves.toEqual([]);
  });
});
