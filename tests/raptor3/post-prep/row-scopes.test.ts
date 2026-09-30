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

import { SQLiteAdapter } from "@adapters/databases/sqlite/sqlite-adapter";
import { SQLite3Driver } from "@drivers/sqlite3";
import type { BatchQuery, QueryResult } from "@drivers/types";
import { NotFoundError, UniqueConstraintError } from "@errors";
import { PreparedDomain, Queries } from "@query-engine/raptor3/shared/query";
import { EngineSchema } from "@query-engine/raptor3/shared/schema";
import {
  type BoundRowsFixture,
  openBoundRowsFixture,
  runBoundRowsBehavior,
} from "@tests/contracts/engine/query/bound-rows-behavior";
import {
  ids,
  openRowScopeFixture,
  type RowScopeFixture,
  rowScopeSchema,
  runRowScopeBehavior,
} from "@tests/contracts/engine/query/row-scope-behavior";
import { createInMemorySQLite3Driver } from "@tests/fixtures/drivers/sqlite3";
import { failure } from "@tests/fixtures/failure";
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
    if (pending?.match.test(sql) && pending.skip-- === 0) {
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
      create: { id, tenantId: tenant, title: "new" },
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
        return driver.statements.join("\n");
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
      expect([...first]).toContainEqual({ deletedAt: null });
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
