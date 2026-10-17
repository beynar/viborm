/**
 * The `rows` capability at every set scope (extension capabilities plan v3.1
 * §2.2, Appendix lookup purposes), on in-memory SQLite: the interactive route,
 * the batch-only substrate, and a driver without RETURNING (MySQL's shape).
 * PGlite runs the same behaviour in
 * `tests/providers/local/pglite-row-scopes.test.ts`.
 *
 * The unique-key witnesses that need a write to land INSIDE one operation run
 * here only: SQLite executes a statement on the operation's own connection
 * between two of the operation's statements, which is the interleaving a
 * concurrent writer produces (DC10, DC11).
 */

import { readFileSync } from "node:fs";
import { SQLiteAdapter } from "@adapters/databases/sqlite/sqlite-adapter";
import { createClient } from "@client/client";
import { ASSERTION_MARKER } from "@drivers/error-mapping";
import { SQLite3Driver } from "@drivers/sqlite3";
import type { BatchQuery, QueryResult } from "@drivers/types";
import { NotFoundError, UniqueConstraintError } from "@errors";
import { defineExtension } from "@extensions/definition";
import { PreparedDomain, Queries } from "@query-engine/raptor3/shared/query";
import { EngineSchema } from "@query-engine/raptor3/shared/schema";
import { s } from "@schema";
import { v } from "@src/validation";
import {
  type BoundRowsFixture,
  openBoundRowsFixture,
  runBoundRowsBehavior,
} from "@tests/contracts/engine/query/bound-rows-behavior";
import {
  domainPredicateSchema,
  runDomainPredicateBehavior,
} from "@tests/contracts/engine/query/domain-predicate-behavior";
import {
  ids,
  openRowScopeFixture,
  type RowScopeFixture,
  rowScopeSchema,
  runRowScopeBehavior,
} from "@tests/contracts/engine/query/row-scope-behavior";
import { createInMemorySQLite3Driver } from "@tests/fixtures/drivers/sqlite3";
import { failure } from "@tests/fixtures/failure";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import {
  createBatchOnlySQLite3Driver,
  createNonReturningSQLite3Driver,
} from "@tests/providers/local/sqlite3-fixtures";
import type Database from "better-sqlite3";
import { afterEach, describe, expect, test, vi } from "vitest";

describe("the rows capability's set scopes", () => {
  runRowScopeBehavior({
    name: "SQLite3",
    createDriver: createInMemorySQLite3Driver,
  });
  runRowScopeBehavior({
    name: "SQLite3 batch-only",
    createDriver: createBatchOnlySQLite3Driver,
  });
  runRowScopeBehavior({
    name: "SQLite3 without RETURNING",
    createDriver: createNonReturningSQLite3Driver,
  });
});

describe("domain predicates: admitted, layered, parameterized", () => {
  runDomainPredicateBehavior({
    name: "SQLite3",
    createDriver: createInMemorySQLite3Driver,
  });
  runDomainPredicateBehavior({
    name: "SQLite3 batch-only",
    createDriver: createBatchOnlySQLite3Driver,
  });
  runDomainPredicateBehavior({
    name: "SQLite3 without RETURNING",
    createDriver: createNonReturningSQLite3Driver,
  });
});

describe("rows bound to the call", () => {
  runBoundRowsBehavior({
    name: "SQLite3",
    createDriver: createInMemorySQLite3Driver,
  });
  runBoundRowsBehavior({
    name: "SQLite3 batch-only",
    createDriver: createBatchOnlySQLite3Driver,
  });
  runBoundRowsBehavior({
    name: "SQLite3 without RETURNING",
    createDriver: createNonReturningSQLite3Driver,
  });
});

const TOMBSTONE = `UPDATE "post" SET "deletedAt" = '2026-03-03T00:00:00.000Z' WHERE "id" = ?`;
const MOVE_TO_GLOBEX = `UPDATE "post" SET "tenantId" = 'globex' WHERE "id" = ?`;
const ON_CONFLICT = /ON CONFLICT/i;
const POST_UPDATE = /^\s*UPDATE\s+"post"/i;
const ON_POST = /"post"/;
const EXISTS = /EXISTS/;
const EXISTS_GLOBAL = /EXISTS/g;

/**
 * SQLite that records every statement it runs and, once, runs a write of its
 * own on the same connection right before the `skip`-th later statement
 * matching `match`: a concurrent writer landing between two statements of
 * one operation.
 */
class InterleavingSQLite3Driver extends SQLite3Driver {
  readonly statements: string[] = [];
  #pending:
    | { match: RegExp; skip: number; sql: string; params: unknown[] }
    | undefined;

  constructor() {
    super({ dataDir: ":memory:" });
  }
  before(match: RegExp, sql: string, params: unknown[], skip = 0): void {
    this.#pending = { match, skip, sql, params };
  }
  protected override async execute<T>(
    client: Database.Database,
    sql: string,
    params: unknown[]
  ): Promise<QueryResult<T>> {
    this.statements.push(sql);
    const pending = this.#pending;
    if (
      !sql.includes(ASSERTION_MARKER) &&
      pending?.match.test(sql) &&
      pending.skip-- === 0
    ) {
      this.#pending = undefined;
      await super.executeRaw(client, pending.sql, pending.params);
    }
    return super.execute<T>(client, sql, params);
  }
}

/** The same, on the batch-only substrate: each batch one atomic unit. */
class BatchOnlyInterleavingSQLite3Driver extends InterleavingSQLite3Driver {
  override readonly supportsTransactions = false;
  override readonly supportsBatch = true;

  protected override async executeBatch<T>(
    client: Database.Database,
    queries: BatchQuery[]
  ): Promise<QueryResult<T>[]> {
    return this.transaction(client, async (tx) => {
      const results: QueryResult<T>[] = [];
      for (const query of queries)
        results.push(await this.execute<T>(tx, query.sql, query.params ?? []));
      return results;
    });
  }
}

describe("unique keys under a domain (SQLite3)", () => {
  let context: RowScopeFixture | undefined;
  afterEach(async () => {
    await context?.base.$disconnect();
    context = undefined;
  });
  async function open(batchOnly: boolean) {
    const driver = batchOnly
      ? new BatchOnlyInterleavingSQLite3Driver()
      : new InterleavingSQLite3Driver();
    context = await openRowScopeFixture(driver);
    driver.statements.length = 0;
    return { ...context, driver };
  }
  const upsert = (id: number, title: string) =>
    ({
      where: { id },
      create: { id, title, slug: `s${id}`, authorId: 1 },
      update: { title },
    }) as const;

  test("a soft delete landing after the unlocked probe is not overwritten: the upsert is not found", async () => {
    const { base, db, driver } = await open(false);
    // Right after the probe: before the next statement on post.
    driver.before(ON_POST, TOMBSTONE, [10], 1);
    const outcome = await failure(db.post.upsert(upsert(10, "raced")));
    expect(outcome).toBeInstanceOf(NotFoundError);
    // The injected write ran inside the operation's own transaction and rolls
    // back with it; what matters is that the upsert never wrote over it.
    expect(
      (await base.post.findUniqueOrThrow({ where: { id: 10 } })).title
    ).toBe("a");
  });

  test("the targeted ON CONFLICT fold declines under a domain: a hidden conflict is refused, never folded", async () => {
    const { base, db, driver } = await open(true);
    await base.$transaction([base.post.upsert(upsert(13, "base-fold"))]);
    expect(driver.statements.some((sql) => ON_CONFLICT.test(sql))).toBe(true);
    driver.statements.length = 0;
    const outcome = await failure(
      db.$transaction([db.post.upsert(upsert(11, "folded"))])
    );
    expect(outcome).toBeInstanceOf(UniqueConstraintError);
    expect(driver.statements.some((sql) => ON_CONFLICT.test(sql))).toBe(false);
    expect(
      (await base.post.findUniqueOrThrow({ where: { id: 11 } })).title
    ).toBe("b");
    // A visible key still upserts, through the probe-first path.
    const [live] = await db.$transaction([
      db.post.upsert({ ...upsert(14, "live"), select: { title: true } }),
    ]);
    expect(live).toEqual({ title: "live" });
  });

  test("an array upsert's found update keeps the domain: a soft delete landing before the batch is not overwritten", async () => {
    const { base, db, driver } = await open(true);
    driver.before(POST_UPDATE, TOMBSTONE, [14]);
    const outcome = await failure(
      db.$transaction([db.post.upsert(upsert(14, "raced"))])
    );
    expect(outcome).toBeInstanceOf(NotFoundError);
    expect(
      (await base.post.findUniqueOrThrow({ where: { id: 14 } })).title
    ).toBe("d");
  });
});

describe("unique keys under a bound domain (SQLite3)", () => {
  let base: BoundRowsFixture["base"] | undefined;
  afterEach(async () => {
    await base?.$disconnect();
    base = undefined;
  });
  async function open(batchOnly: boolean) {
    const driver = batchOnly
      ? new BatchOnlyInterleavingSQLite3Driver()
      : new InterleavingSQLite3Driver();
    const fixture = await openBoundRowsFixture(driver);
    base = fixture.base;
    driver.statements.length = 0;
    return { ...fixture, driver };
  }
  const upsert = (id: number, tenant: string) =>
    ({
      where: { id },
      create: { id, title: "new" },
      update: { title: "upserted" },
      tenant,
    }) as const;

  test("a row moved to another tenant after the unlocked probe is not overwritten: the upsert is not found", async () => {
    const { base, db, driver } = await open(false);
    driver.before(ON_POST, MOVE_TO_GLOBEX, [1], 1);
    expect(await failure(db.post.upsert(upsert(1, "acme")))).toBeInstanceOf(
      NotFoundError
    );
    expect(
      (await base.post.findUniqueOrThrow({ where: { id: 1 } })).title
    ).toBe("a");
  });

  test("the targeted ON CONFLICT fold declines under a bound domain: another tenant's key is refused, never folded", async () => {
    const { base, db, driver } = await open(true);
    const outcome = await failure(
      db.$transaction([db.post.upsert(upsert(3, "acme"))])
    );
    expect(outcome).toBeInstanceOf(UniqueConstraintError);
    expect(driver.statements.some((sql) => ON_CONFLICT.test(sql))).toBe(false);
    expect(
      (await base.post.findUniqueOrThrow({ where: { id: 3 } })).title
    ).toBe("c");
    const [own] = await db.$transaction([
      db.post.upsert({ ...upsert(1, "acme"), select: { title: true } }),
    ]);
    expect(own).toEqual({ title: "upserted" });
  });
});

describe("a claimed polymorphic arm under a domain (SQLite3)", () => {
  test("tests its row's physical existence only where a related domain applies: every other statement is the plain client's", async () => {
    const driver = new InterleavingSQLite3Driver();
    const { base, db } = await openRowScopeFixture(driver);
    try {
      const statementOf = async (call: () => PromiseLike<unknown>) => {
        driver.statements.length = 0;
        await call();
        return driver.statements
          .filter((statement) => !statement.includes(ASSERTION_MARKER))
          .join("\n");
      };
      const pins = { include: { subject: true } } as const;
      const plain = await statementOf(() => base.pin.findMany(pins));
      expect(plain).not.toMatch(EXISTS);
      // `with` declares no related predicate: no domain, the plain bytes.
      expect(
        await statementOf(() => db.pin.findMany({ ...pins, deleted: "with" }))
      ).toBe(plain);
      // The default mode hides posts and authors: one test per claimed arm.
      const scoped = await statementOf(() => db.pin.findMany(pins));
      expect(scoped.match(EXISTS_GLOBAL)).toHaveLength(2);
    } finally {
      await base.$disconnect();
    }
  });
});

describe("the key-preserving conjunction", () => {
  const schema = rowScopeSchema();
  const engine = new EngineSchema(schema);
  const adapter = new SQLiteAdapter();
  const plain = new Queries(engine, adapter);
  const domain = new PreparedDomain(
    {
      root: new Map([["post", [{ deletedAt: null }]]]),
      related: new Map(),
    },
    plain
  );
  const scoped = new Queries(engine, adapter, undefined, domain);

  test("a domain conjunct keeps the selector's unique key and marks it scoped", () => {
    const selector = scoped.prepareSelector(schema.post, { slug: "s10" }, true);
    const candidates = scoped.candidates(selector, "root");
    expect(candidates).not.toBe(selector);
    expect(candidates.uniqueKey).toBe(selector.uniqueKey);
    expect(candidates.uniqueValues).toBe(selector.uniqueValues);
    expect(candidates.scoped).toBe(true);
    expect([...candidates.facts.fields].sort()).toEqual(["deletedAt", "slug"]);
    // The plain conjunction states no key.
    expect(
      scoped.andSelectors(schema.post, [
        selector,
        domain.selector(schema.post, "root")!,
      ]).uniqueKey
    ).toBeUndefined();
  });

  test("where the domain states nothing, the selector itself: nothing is allocated", () => {
    const selector = scoped.prepareSelector(schema.post, { slug: "s10" }, true);
    expect(scoped.candidates(selector, "related")).toBe(selector);
    expect(plain.candidates(selector, "root")).toBe(selector);
    const author = scoped.prepareSelector(schema.author, { id: 1 }, true);
    expect(scoped.candidates(author, "root")).toBe(author);
  });

  test("a domain is prepared once per model and purpose", () => {
    expect(domain.selector(schema.post, "root")).toBe(
      domain.selector(schema.post, "root")
    );
    expect(domain.selector(schema.post, "related")).toBeUndefined();
  });
});

describe("one engine view", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("prepares each row domain a call selects once, and reads it through one scoped Queries", async () => {
    const { base, db } = await openRowScopeFixture(
      createInMemorySQLite3Driver()
    );
    try {
      const prepare = vi.spyOn(Queries.prototype, "prepareSelector");
      const read = vi.spyOn(Queries.prototype, "read");
      const preparedIn = async (call: () => PromiseLike<unknown>) => {
        prepare.mockClear();
        await call();
        return new Set(prepare.mock.calls.map(([, where]) => where));
      };
      const readers = async (call: () => PromiseLike<unknown>) => {
        read.mockClear();
        await call();
        return read.mock.contexts;
      };
      // Each call hands the engine fresh arguments: a `where` prepared by
      // both calls is one the engine view holds, the domain's predicate.
      const first = await preparedIn(async () =>
        expect(ids(await db.post.findMany({ where: { authorId: 1 } }))).toEqual(
          [10, 14]
        )
      );
      // As admission left it: the shorthand `{ deletedAt: null }` is `equals`.
      expect([...first]).toContainEqual({ deletedAt: { equals: null } });
      const second = await preparedIn(async () =>
        expect(await db.post.count({ where: { authorId: 2 } })).toBe(1)
      );
      expect([...second].filter((where) => first.has(where))).toEqual([]);

      const [plain] = await readers(() => base.post.findMany({}));
      const [scoped] = await readers(() => db.post.findMany({}));
      const [again] = await readers(() =>
        db.post.findMany({ where: { title: "a" } })
      );
      const [only] = await readers(() => db.post.findMany({ deleted: "only" }));
      // Compared by identity alone: a `Queries` holds the client's schema,
      // which no assertion should print.
      expect({
        reused: scoped === again,
        plain: scoped === plain,
        perMode: only === scoped,
      }).toEqual({ reused: true, plain: false, perMode: false });
    } finally {
      await base.$disconnect();
    }
  });
});

describe("one prepared predicate for every call value (W-K2a)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("10,000 actors: the domain's predicate is prepared once, by identity, and every call emits one statement text", async () => {
    const driver = new InterleavingSQLite3Driver();
    const base = createClient({ schema: domainPredicateSchema(), driver });
    try {
      await syncLiveSchema(base);
      await base.account.createMany({
        data: [{ id: "u1" }, { id: "u2" }],
      });
      await base.doc.createMany({
        data: [
          { id: "d1", ownerId: "u1", parentId: null, expiresAt: null },
          { id: "d2", ownerId: "u2", parentId: "d1", expiresAt: null },
        ],
      });
      const db = base.$extends(
        defineExtension({
          name: "actor",
          controls: {
            actor: {
              schema: v.object({ userId: v.string() }),
              required: true,
            },
          },
          rows: {
            control: "actorMode",
            default: "on",
            models: {
              doc: {
                on: {
                  root: {
                    OR: [
                      { ownerId: { control: "actor", path: "userId" } },
                      {
                        parent: {
                          is: { ownerId: { control: "actor", path: "userId" } },
                        },
                      },
                    ],
                  },
                },
              },
            },
          },
        })
      );
      const prepare = vi.spyOn(Queries.prototype, "prepareSelector");
      expect(
        await db.doc.findMany({ actor: { userId: "u1" }, select: { id: true } })
      ).toEqual([{ id: "d1" }, { id: "d2" }]);
      const domain = prepare.mock.calls.map(([, where]) => where);
      expect(domain).toHaveLength(1);
      prepare.mockClear();
      driver.statements.length = 0;
      for (let index = 0; index < 10_000; index++) {
        const userId = index === 9999 ? "u2" : `actor-${index}`;
        const found = await db.doc.findMany({
          actor: { userId },
          select: { id: true },
        });
        expect(found).toEqual(index === 9999 ? [{ id: "d2" }] : []);
      }
      expect(prepare).not.toHaveBeenCalled();
      expect(new Set(driver.statements).size).toBe(1);
    } finally {
      await base.$disconnect();
    }
  }, 120_000);
});

/** An ISO instant among a statement's values: the call's clock, not a pin. */
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/** SQLite that records every statement it runs, with its values. */
class RecordingSQLite3Driver extends SQLite3Driver {
  readonly log: { sql: string; params: unknown[] }[] = [];
  constructor() {
    super({ dataDir: ":memory:" });
  }
  protected override async execute<T>(
    client: Database.Database,
    sql: string,
    params: unknown[]
  ): Promise<QueryResult<T>> {
    this.log.push({
      sql,
      params: params.map((value) =>
        value instanceof Date ||
        (typeof value === "string" && INSTANT.test(value))
          ? "<instant>"
          : value
      ),
    });
    return super.execute<T>(client, sql, params);
  }
}

describe("tenancy, soft delete and an optional control: SQL unchanged (W-K1e)", () => {
  // The golden was recorded before K1/K2 (layers, parameters, admission):
  // a chain whose predicates read only columns, and values that are the
  // call's, lowers to the text and values it did when values were
  // substituted into a copy of the predicate.
  const author = s.model({
    id: s.int().id(),
    tenantId: s.string(),
    name: s.string(),
    deletedAt: s.dateTime().nullable(),
    version: s.int().default(0),
    posts: s.toMany(() => post),
  });
  const post = s.model({
    id: s.int().id(),
    tenantId: s.string(),
    title: s.string(),
    authorId: s.int(),
    author: s
      .toOne(() => author)
      .fields("authorId")
      .references("id"),
    deletedAt: s.dateTime().nullable(),
    version: s.int().default(0),
    comments: s.toMany(() => comment),
  });
  const comment = s.model({
    id: s.int().id(),
    tenantId: s.string(),
    body: s.string(),
    postId: s.int(),
    post: s
      .toOne(() => post)
      .fields("postId")
      .references("id"),
    deletedAt: s.dateTime().nullable(),
    version: s.int().default(0),
  });
  const MODELS = ["author", "post", "comment"] as const;
  const each = <T>(build: () => T) =>
    Object.fromEntries(MODELS.map((model) => [model, build()])) as Record<
      (typeof MODELS)[number],
      T
    >;
  const tenancy = defineExtension({
    name: "tenancy",
    controls: { tenant: { schema: v.string(), required: true } },
    rows: {
      control: "scope",
      default: "tenant",
      models: each(() => ({
        tenant: {
          root: { tenantId: { control: "tenant" } },
          related: { tenantId: { control: "tenant" } },
        },
        all: {},
      })),
    },
    data: {
      models: each(() => ({ create: { tenantId: { control: "tenant" } } })),
    },
  });
  const soft = defineExtension({
    name: "soft",
    controls: { mode: { oneOf: ["soft", "hard"] } },
    rows: {
      control: "deleted",
      default: "without",
      models: each(() => ({
        without: { root: { deletedAt: null }, related: { deletedAt: null } },
        with: {},
        only: {
          root: { deletedAt: { not: null } },
          related: { deletedAt: null },
        },
      })),
    },
    deletion: {
      removeWhen: { mode: "hard" },
      models: each(() => ({ at: "deletedAt", assign: {} })),
    },
  });
  const lock = defineExtension({
    name: "lock",
    controls: {
      expectedVersion: { schema: v.number(), on: ["update", "delete"] },
    },
    rows: {
      control: "versionCheck",
      default: "checked",
      models: each(() => ({
        checked: { root: { version: { control: "expectedVersion" } } },
        unchecked: {},
      })),
    },
  });

  test("every statement of 27 calls matches the golden recorded before K1/K2", async () => {
    const driver = new RecordingSQLite3Driver();
    const base = createClient({ schema: { author, post, comment }, driver });
    try {
      await syncLiveSchema(base);
      const db = base.$extends(tenancy).$extends(soft).$extends(lock);
      const transcript: Record<string, unknown> = {};
      const at = async (name: string, run: () => Promise<unknown>) => {
        driver.log.length = 0;
        try {
          await run();
          transcript[name] = [...driver.log];
        } catch (error) {
          transcript[name] =
            `ERROR ${(error as Error).constructor.name}: ${(error as Error).message}`;
        }
      };
      const T = { tenant: "acme" } as const;
      await at("create author", () =>
        db.author.create({ ...T, data: { id: 1, name: "a" } })
      );
      await at("create post nested comments", () =>
        db.post.create({
          ...T,
          data: {
            id: 10,
            title: "t",
            authorId: 1,
            comments: { create: [{ id: 100, body: "b", tenantId: "acme" }] },
          },
        })
      );
      await at("createMany posts", () =>
        db.post.createMany({
          ...T,
          data: [
            { id: 11, title: "u", authorId: 1 },
            { id: 12, title: "v", authorId: 1 },
          ],
        })
      );
      await at("findMany", () => db.post.findMany(T));
      await at("findMany where", () =>
        db.post.findMany({ ...T, where: { title: "t" } })
      );
      await at("findMany all", () => db.post.findMany({ ...T, scope: "all" }));
      await at("findMany with", () =>
        db.post.findMany({ ...T, deleted: "with" })
      );
      await at("findMany only", () =>
        db.post.findMany({ ...T, deleted: "only" })
      );
      await at("findMany include", () =>
        db.author.findMany({
          ...T,
          include: { posts: { include: { comments: true } } },
        })
      );
      await at("findMany include to-one", () =>
        db.post.findMany({ ...T, include: { author: true } })
      );
      await at("relation filters", () =>
        db.author.findMany({
          ...T,
          where: {
            posts: {
              some: { title: "t" },
              none: { title: "x" },
              every: { authorId: 1 },
            },
          },
        })
      );
      await at("is filter", () =>
        db.post.findMany({ ...T, where: { author: { is: { name: "a" } } } })
      );
      await at("count", () => db.post.count(T));
      await at("aggregate", () =>
        db.post.aggregate({ ...T, _count: { _all: true } })
      );
      await at("groupBy", () =>
        db.post.groupBy({ ...T, by: ["authorId"], _count: { _all: true } })
      );
      await at("cursor", () =>
        db.post.findMany({ ...T, cursor: { id: 10 }, take: 2 })
      );
      await at("findUnique", () =>
        db.post.findUnique({ ...T, where: { id: 10 } })
      );
      await at("relation count order", () =>
        db.author.findMany({
          ...T,
          orderBy: { posts: { _count: "desc" } },
          select: { id: true, _count: { select: { posts: true } } },
        })
      );
      await at("update", () =>
        db.post.update({ ...T, where: { id: 10 }, data: { title: "t2" } })
      );
      await at("update locked", () =>
        db.post.update({
          ...T,
          expectedVersion: 0,
          where: { id: 10 },
          data: { title: "t3" },
        })
      );
      await at("updateMany", () =>
        db.post.updateMany({
          ...T,
          where: { title: "u" },
          data: { title: "u2" },
        })
      );
      await at("upsert", () =>
        db.post.upsert({
          ...T,
          where: { id: 13 },
          create: { id: 13, title: "w", authorId: 1 },
          update: { title: "w2" },
        })
      );
      await at("nested update", () =>
        db.author.update({
          ...T,
          where: { id: 1 },
          data: {
            posts: {
              update: { where: { id: 10 }, data: { title: "n" } },
              delete: { id: 13 },
            },
          },
        })
      );
      await at("delete tombstone", () =>
        db.post.delete({ ...T, where: { id: 12 } })
      );
      await at("deleteMany", () =>
        db.comment.deleteMany({ ...T, where: { body: "zz" } })
      );
      await at("delete hard", () =>
        db.post.delete({ ...T, mode: "hard", where: { id: 11 } })
      );
      await at("no tenant", () =>
        (db.post.findMany as (args: object) => Promise<unknown>)({})
      );
      expect(transcript).toEqual(
        JSON.parse(
          readFileSync(
            new URL("./__golden__/composed-rows-sql.json", import.meta.url),
            "utf8"
          )
        )
      );
    } finally {
      await base.$disconnect();
    }
  });
});
