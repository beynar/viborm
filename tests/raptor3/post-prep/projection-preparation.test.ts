import assert from "node:assert/strict";
import { SQLiteAdapter } from "@adapters/databases/sqlite/sqlite-adapter";
import type { BatchQuery, QueryResult } from "@drivers";
import { SQLite3Driver } from "@drivers/sqlite3";
import { OperationContext } from "@query-engine/raptor3/shared/operation-context";
import { Queries } from "@query-engine/raptor3/shared/query";
import { EngineSchema } from "@query-engine/raptor3/shared/schema";
import { s } from "@schema";
import { Sql } from "@sql";
import { Decimal } from "@src/index";
import Database from "better-sqlite3";
import { describe, it, vi } from "vitest";

const LEFT_SOURCE = /"left_source"/;
const RIGHT_SOURCE = /"right_source"/;
const INVALID_PROVIDER_DECIMAL = /Invalid provider decimal/;
const INSERT_STATEMENT = /^INSERT\b/;
const SELECT_ANYWHERE = /SELECT\b/;
const LEADING_WORD = /^\w+/;

const selectAssembly = vi.hoisted(() => ({ calls: 0 }));

vi.mock("@adapters/adapter-internals", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("@adapters/adapter-internals")>();
  return {
    ...original,
    assembleAdapterSelect(
      adapter: Parameters<typeof original.assembleAdapterSelect>[0],
      parts: Parameters<typeof original.assembleAdapterSelect>[1]
    ) {
      selectAssembly.calls++;
      return original.assembleAdapterSelect(adapter, parts);
    },
  };
});

function projectionSchema() {
  const author = s
    .model({
      id: s.int().id(),
      displayName: s.string().map("display_name"),
      comments: s.toMany(() => comment).name("authorComments"),
    })
    .map("post_g3_projection_authors");
  const post = s
    .model({
      id: s.int().id(),
      headline: s.string().map("post_headline"),
      comments: s.toMany(() => comment).name("subject"),
    })
    .map("post_g3_projection_posts");
  const video = s
    .model({
      id: s.int().id(),
      caption: s.string().map("video_caption"),
    })
    .map("post_g3_projection_videos");
  const comment = s
    .model({
      id: s.int().id().map("comment_id"),
      amount: s.decimal({ precision: 6, scale: 2 }).map("amount_coefficient"),
      authorId: s.int().map("author_id"),
      author: s
        .toOne(() => author)
        .fields("authorId")
        .references("id")
        .name("authorComments"),
      subject: s
        .toOne(
          { post: () => post, video: () => video },
          {
            values: {
              post: "content.post.v1",
              video: "content.video.v1",
            },
          }
        )
        .name("subject")
        .optional(),
    })
    .map("post_g3_projection_comments");
  return { author, post, video, comment };
}

function assertContainsNoSql(
  value: unknown,
  seen = new WeakSet<object>()
): void {
  assert(!(value instanceof Sql), "prepared projection retained lowered SQL");
  if (value === null || typeof value !== "object" || seen.has(value)) return;
  seen.add(value);
  for (const key of Reflect.ownKeys(value))
    assertContainsNoSql(Reflect.get(value, key), seen);
}

function renderedColumns(columns: readonly Sql[]): string {
  return columns.map((column) => column.toStatement("?")).join(", ");
}

function generatedOutputSchema() {
  const output = s
    .model({
      id: s.int().id().increment(),
      stamp: s.int(),
      score: s.int(),
    })
    .map("post_g3_projection_outputs");
  return { output };
}

class ProjectionRecordingSQLiteDriver extends SQLite3Driver {
  readonly statements: string[] = [];

  protected override async execute<T>(
    client: Database.Database,
    statement: string,
    parameters: unknown[]
  ): Promise<QueryResult<T>> {
    this.statements.push(statement);
    return super.execute<T>(client, statement, parameters);
  }
}

class ProjectionBatchSQLiteDriver extends ProjectionRecordingSQLiteDriver {
  override readonly supportsTransactions = false;
  override readonly supportsBatch = true;
  readonly batches: string[][] = [];

  protected override async executeBatch<T>(
    client: Database.Database,
    queries: BatchQuery[]
  ): Promise<QueryResult<T>[]> {
    this.batches.push(queries.map((query) => query.sql));
    return this.transaction(client, (transaction) =>
      super.executeBatch<T>(transaction, queries)
    );
  }
}

describe("post-G3 projection preparation", () => {
  it("prepares shape without SQL and binds aliases only while lowering", () => {
    const schema = projectionSchema();
    const queries = new Queries(new EngineSchema(schema), new SQLiteAdapter());
    const selection = {
      select: {
        id: true,
        amount: true,
        author: { select: { displayName: true } },
        subject: true,
      },
    };

    assert.equal(queries.alias(), "q0");
    selectAssembly.calls = 0;
    const prepared = queries.prepareProjection(schema.comment, selection);

    assert.equal(selectAssembly.calls, 0);
    assert.equal(queries.alias(), "q1");
    assertContainsNoSql(prepared);

    const left = queries.lowerProjection(prepared, "left_source");
    const firstAssemblyCount = selectAssembly.calls;
    assert(
      firstAssemblyCount > 0,
      "nested lowering must exercise SELECT assembly"
    );
    const leftSql = renderedColumns(left.columns);
    assert.match(leftSql, LEFT_SOURCE);
    assert.doesNotMatch(leftSql, RIGHT_SOURCE);

    const right = queries.lowerProjection(prepared, "right_source");
    assert.equal(selectAssembly.calls - firstAssemblyCount, firstAssemblyCount);
    const rightSql = renderedColumns(right.columns);
    assert.match(rightSql, RIGHT_SOURCE);
    assert.doesNotMatch(rightSql, LEFT_SOURCE);
    assert.notEqual(left.columns, right.columns);
    assert.notEqual(left.entries, right.entries);
    assert.deepEqual(
      left.entries.map(([field]) => field),
      ["id", "amount", "author", "subject"]
    );
    assert.deepEqual(
      right.entries.map(([field]) => field),
      ["id", "amount", "author", "subject"]
    );
  });

  it("decodes one prepared mapped decimal, nested, and variant shape freshly", () => {
    const schema = projectionSchema();
    const queries = new Queries(new EngineSchema(schema), new SQLiteAdapter());
    const prepared = queries.prepareProjection(schema.comment, {
      select: {
        id: true,
        amount: true,
        author: { select: { displayName: true } },
        subject: true,
      },
    });
    const providerRow = {
      id: 1,
      amount: "1234",
      author: JSON.stringify({ displayName: "Ada" }),
      subject: JSON.stringify({
        post: { id: 7, headline: "Prepared once" },
        video: null,
      }),
    };

    const first = queries.decodeProjection(prepared.shape, [providerRow]);
    const second = queries.decodeProjection(prepared.shape, [providerRow]);
    const firstRow = first[0];
    const secondRow = second[0];
    assert(firstRow);
    assert(secondRow);
    assert(firstRow.amount instanceof Decimal);
    assert(secondRow.amount instanceof Decimal);
    assert(firstRow.amount.eq("12.34"));
    assert(secondRow.amount.eq("12.34"));
    assert.deepEqual(firstRow.author, { displayName: "Ada" });
    assert.deepEqual(firstRow.subject, {
      type: "post",
      data: { id: 7, headline: "Prepared once" },
    });
    assert.notEqual(first, second);
    assert.notEqual(firstRow, secondRow);
    assert.notEqual(firstRow.amount, secondRow.amount);
    assert.notEqual(firstRow.author, secondRow.author);
    assert.notEqual(firstRow.subject, secondRow.subject);
    const firstSubject = firstRow.subject;
    const secondSubject = secondRow.subject;
    assert(firstSubject !== null && typeof firstSubject === "object");
    assert(secondSubject !== null && typeof secondSubject === "object");
    assert.notEqual(
      Reflect.get(firstSubject, "data"),
      Reflect.get(secondSubject, "data")
    );

    assert.throws(
      () =>
        queries.decodeProjection(prepared.shape, [
          { ...providerRow, amount: "not-a-coefficient" },
        ]),
      INVALID_PROVIDER_DECIMAL
    );
  });

  it("reuses one projection for segmented generated output and its continuation read", async () => {
    const schema = generatedOutputSchema();
    const engineSchema = new EngineSchema(schema);
    const database = new Database(":memory:");
    database.exec(`
      CREATE TABLE post_g3_projection_outputs(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        stamp INTEGER NOT NULL DEFAULT 51,
        score INTEGER NOT NULL
      );
    `);
    const driver = new ProjectionBatchSQLiteDriver({ client: database });
    const context = new OperationContext(
      engineSchema,
      driver,
      "output",
      "create"
    );
    const preparation = vi.spyOn(context.queries, "prepareProjection");
    const lowering = vi.spyOn(context.queries, "lowerProjection");
    const decoding = vi.spyOn(context.queries, "decodeProjection");
    const selection = vi.spyOn(context.queries, "select");

    try {
      const created = await context.run(async () => {
        const first = await context.insert(
          schema.output,
          { score: 7 },
          new Set(["id", "stamp"]),
          {}
        );
        await context.insert(
          schema.output,
          { id: 9, stamp: 52, score: 8 },
          new Set(),
          {}
        );
        await context.finish();
        return first;
      });

      assert.deepEqual(created, { score: 7, id: 1, stamp: 51 });
      assert.equal(preparation.mock.calls.length, 1);
      assert.equal(lowering.mock.calls.length, 2);
      assert.equal(decoding.mock.calls.length, 1);
      assert.equal(selection.mock.calls.length, 1);
      const preparedResult = preparation.mock.results[0];
      assert(preparedResult);
      if (preparedResult.type !== "return")
        assert.fail("projection preparation did not return normally");
      const prepared = preparedResult.value;
      assert.equal(lowering.mock.calls[0]?.[0], prepared);
      assert.equal(lowering.mock.calls[1]?.[0], prepared);
      assert.equal(decoding.mock.calls[0]?.[0], prepared.shape);
      const controls = selection.mock.calls[0]?.[3];
      assert(controls?.projection);
      assert.equal(controls.projection, prepared);

      assert.equal(driver.batches.length, 2);
      const firstBatch = driver.batches[0];
      const continuationBatch = driver.batches[1];
      assert(firstBatch);
      assert(continuationBatch);
      assert.equal(firstBatch.length, 1);
      assert.match(firstBatch[0] ?? "", INSERT_STATEMENT);
      assert.equal(continuationBatch.length, 2);
      assert.match(continuationBatch[0] ?? "", SELECT_ANYWHERE);
      assert.match(continuationBatch[1] ?? "", INSERT_STATEMENT);
    } finally {
      await driver.disconnect();
      database.close();
    }
  });

  it("reuses one projection for a non-returning update and its stored-row read", async () => {
    const schema = generatedOutputSchema();
    const engineSchema = new EngineSchema(schema);
    const database = new Database(":memory:");
    database.exec(`
      CREATE TABLE post_g3_projection_outputs(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        stamp INTEGER NOT NULL,
        score INTEGER NOT NULL
      );
      INSERT INTO post_g3_projection_outputs(id, stamp, score)
      VALUES (1, 51, 7);
    `);
    const driver = new ProjectionRecordingSQLiteDriver({ client: database });
    driver.adapter.capabilities.supportsReturning = false;
    const context = new OperationContext(
      engineSchema,
      driver,
      "output",
      "update"
    );
    const preparation = vi.spyOn(context.queries, "prepareProjection");
    const selection = vi.spyOn(context.queries, "select");

    try {
      const updated = await context.run(() =>
        // FC-02A merged the address and the stale capture into ONE current
        // row: the same values, one parameter. The expectations below are
        // unchanged — this call's spelling is.
        context.update(
          schema.output,
          { id: 1, stamp: 51, score: 7 },
          { score: 11 },
          {},
          "update",
          new Set(["score"])
        )
      );

      assert.deepEqual(updated, { score: 11 });
      assert.equal(preparation.mock.calls.length, 1);
      assert.equal(selection.mock.calls.length, 1);
      const preparedResult = preparation.mock.results[0];
      assert(preparedResult);
      if (preparedResult.type !== "return")
        assert.fail("projection preparation did not return normally");
      const controls = selection.mock.calls[0]?.[3];
      assert(controls?.projection);
      assert.equal(controls.projection, preparedResult.value);
      assert.deepEqual(
        driver.statements.map(
          (statement) => statement.match(LEADING_WORD)?.[0]
        ),
        ["UPDATE", "SELECT"]
      );
      assert.deepEqual(
        database
          .prepare("SELECT id, stamp, score FROM post_g3_projection_outputs")
          .get(),
        { id: 1, stamp: 51, score: 11 }
      );
    } finally {
      await driver.disconnect();
      database.close();
    }
  });
});
