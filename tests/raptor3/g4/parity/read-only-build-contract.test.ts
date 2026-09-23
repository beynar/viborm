/**
 * R4 — D-64's read-only build contract, registered in the normal inventory.
 *
 * Ruling D-64 keeps the accepted capability restriction:
 * `PendingOperation.buildStatement()` and the `QueryEngine.build()` that backs
 * it answer the ONE statement a READ compiles to, and every WRITE answers the
 * `does not compile to one SQL statement` refusal — the folded single-statement
 * write the previous engine could build is not restored. FC-04 measured that
 * the only pin standing behind that ruling,
 * `tests/raptor3/g4/review/cutover/d14-publication.review.test.ts`, executes in
 * NO vitest project: the walk in `credential-free-test-manifest.mjs` skips
 * `tests/raptor3/g4/review/` and no manifest list names it. An excluded review
 * file is not gate coverage, so the regression witness lives here.
 *
 * The three cells below state the contract and nothing else:
 *
 *   1. EVERY READ BUILDS. Each read name in the vocabulary answers one SELECT,
 *      and asking twice answers the SAME `Sql` object — a second lowering would
 *      answer an equal but distinct one.
 *   2. EVERY WRITE REFUSES. Each write name answers `undefined` from
 *      `buildStatement()` and the registered sentence from `build()`, nested
 *      relation payloads included.
 *   3. THE FOLDABLE WRITE STAYS REFUSED. On a RETURNING dialect — the case the
 *      CHANGELOG names, a scalar `delete` the previous engine could fold into
 *      one statement — the refusal is the same.
 *
 * The vocabulary is not hand-listed here: it is read from
 * `@query-engine/routed-operations`, the one owner the client, the cache and
 * the extension surface also consume, and cell 1 asserts this file's payload
 * table is exactly that set. A verb added to the engine that neither builds nor
 * refuses therefore fails here rather than at a caller.
 *
 * NO PROVIDER WORK. The driver under all three cells throws from every
 * execution, transaction and connection entry point, so a build path that
 * reached a database would fail loudly instead of passing quietly. That is also
 * why this file needs no credentials and no live database.
 */

import assert from "node:assert/strict";
import type { DatabaseAdapter } from "@adapters/database-adapter";
import { PostgresAdapter } from "@adapters/databases/postgres/postgres-adapter";
import { SQLiteAdapter } from "@adapters/databases/sqlite/sqlite-adapter";
import { type Dialect, Driver } from "@drivers";
import type { QueryResult } from "@drivers/types";
import { createModelRegistry, QueryEngine } from "@query-engine/query-engine";
import {
  isReadOperation,
  ROUTED_OPERATIONS,
} from "@query-engine/routed-operations";
import { hydrateSchemaNames, s } from "@schema";
import { createSchemaRegistry } from "@validation";
import { describe, it } from "vitest";

const author = s
  .model({
    id: s.int().id().increment(),
    email: s.string().unique(),
    name: s.string(),
    age: s.int().nullable(),
    posts: s.toMany(() => post),
  })
  .map("r4_build_authors");
const post = s
  .model({
    id: s.int().id().increment(),
    authorId: s.int(),
    title: s.string(),
    author: s
      .toOne(() => author)
      .fields("authorId")
      .references("id"),
  })
  .map("r4_build_posts");

const schema = { author, post };
hydrateSchemaNames(schema);

/**
 * A driver that owns no provider and refuses to pretend otherwise. Reaching any
 * of these members from a build path is the failure this file is looking for.
 */
class NoProviderDriver extends Driver<null, null> {
  readonly adapter: DatabaseAdapter;

  constructor(
    adapter: DatabaseAdapter = new SQLiteAdapter(),
    dialect: Dialect = "sqlite"
  ) {
    super(dialect, "r4-no-provider");
    this.adapter = adapter;
  }
  protected async initClient(): Promise<null> {
    throw new Error("a build path connected to a provider");
  }
  protected async closeClient(): Promise<void> {
    throw new Error("a build path closed a provider");
  }
  protected async execute<T>(): Promise<QueryResult<T>> {
    throw new Error("a build path executed a statement");
  }
  protected async executeRaw<T>(): Promise<QueryResult<T>> {
    throw new Error("a build path executed a raw statement");
  }
  protected async transaction<T>(): Promise<T> {
    throw new Error("a build path opened a transaction");
  }
}

function engineOn(adapter?: DatabaseAdapter, dialect?: Dialect): QueryEngine {
  const registry = createModelRegistry(schema, createSchemaRegistry(schema));
  return new QueryEngine(
    new NoProviderDriver(adapter, dialect) as never,
    registry
  );
}

/** One admissible payload per name in the engine's own vocabulary. */
const PAYLOADS: Readonly<Record<string, Record<string, unknown>>> = {
  findMany: { where: { name: "Ada" }, select: { id: true } },
  findFirst: { orderBy: { id: "asc" } },
  findUnique: { where: { email: "present@example.test" } },
  findUniqueOrThrow: { where: { email: "present@example.test" } },
  findFirstOrThrow: { orderBy: { id: "asc" } },
  count: {},
  exist: {},
  aggregate: { _count: true, _avg: { age: true } },
  groupBy: { by: ["name"], _count: true },
  create: {
    data: {
      email: "a@b.test",
      name: "A",
      posts: { create: { title: "nested" } },
    },
  },
  update: { where: { id: 1 }, data: { name: "B" } },
  delete: { where: { id: 1 } },
  upsert: {
    where: { id: 1 },
    create: { email: "a@b.test", name: "A" },
    update: { name: "B" },
  },
  createMany: { data: [{ email: "a@b.test", name: "A" }] },
  updateMany: { where: {}, data: { name: "B" } },
  deleteMany: { where: {} },
};

const SELECT = /^SELECT /;
const PLACEHOLDER = /\$1/;

const refusal = (operation: string) =>
  `Operation '${operation}' does not compile to one SQL statement. Execute the operation instead.`;

describe("R4 — the read-only build contract (D-64)", () => {
  it("every read name in the engine's vocabulary builds one statement, once", () => {
    // The payload table is the vocabulary, not a hand copy of part of it.
    assert.deepEqual(
      Object.keys(PAYLOADS).sort(),
      [...ROUTED_OPERATIONS].sort(),
      "the engine's operation vocabulary changed; this contract has no answer for the new name"
    );
    const engine = engineOn();
    const reads = [...ROUTED_OPERATIONS].filter((name) =>
      isReadOperation(name)
    );
    assert.equal(reads.length, 9, reads.join(", "));
    for (const operation of reads) {
      const pending = engine.prepare(
        author,
        operation as never,
        PAYLOADS[operation] as Record<string, unknown>
      );
      const published = pending.buildStatement();
      assert.ok(published, `${operation}: a read must publish one statement`);
      assert.match(published.toStatement("?"), SELECT, operation);
      // Identity, not equality: a second lowering would answer a distinct Sql.
      assert.equal(pending.buildStatement(), published, operation);
      // And the public accessor answers the same text.
      assert.equal(
        engine
          .build(
            author,
            operation as never,
            PAYLOADS[operation] as Record<string, unknown>
          )
          .toStatement("?"),
        published.toStatement("?"),
        operation
      );
    }
  });

  it("every write name refuses through both accessors, nested payloads included", () => {
    const engine = engineOn();
    const writes = [...ROUTED_OPERATIONS].filter(
      (name) => !isReadOperation(name)
    );
    assert.equal(writes.length, 7, writes.join(", "));
    for (const operation of writes) {
      const args = PAYLOADS[operation] as Record<string, unknown>;
      assert.equal(
        engine.prepare(author, operation as never, args).buildStatement(),
        undefined,
        operation
      );
      assert.throws(
        () => engine.build(author, operation as never, args),
        (error: Error) => error.message === refusal(operation),
        operation
      );
    }
  });

  it("the write the previous engine could fold into one statement stays refused on a RETURNING dialect", () => {
    const engine = engineOn(new PostgresAdapter(), "postgresql");
    // The CHANGELOG names this exact case: a scalar `delete` on a driver with
    // RETURNING. D-64 does not restore it.
    for (const operation of ["delete", "create", "update"]) {
      const args = PAYLOADS[operation] as Record<string, unknown>;
      assert.equal(
        engine.prepare(author, operation as never, args).buildStatement(),
        undefined,
        operation
      );
      assert.throws(
        () => engine.build(author, operation as never, args),
        (error: Error) => error.message === refusal(operation),
        operation
      );
    }
    // The same engine still builds a read, so the refusals above are the
    // write contract rather than a dialect that cannot build at all — and the
    // numbered placeholder proves this really is the PostgreSQL route.
    const read = engine
      .build(author, "findMany", {
        where: { name: "Ada" },
        select: { id: true },
      })
      .toStatement("$n");
    assert.match(read, SELECT);
    assert.match(read, PLACEHOLDER, read);
  });
});
