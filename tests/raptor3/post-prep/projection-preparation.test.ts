import assert from "node:assert/strict";
import { isDeepStrictEqual } from "node:util";
import { SQLiteAdapter } from "@adapters/databases/sqlite/sqlite-adapter";
import { createClient } from "@client/client";
import type { QueryResult } from "@drivers";
import { SQLite3Driver } from "@drivers/sqlite3";
import { ValidationError } from "@errors";
import { Queries } from "@query-engine/raptor3/shared/query";
import { EngineSchema } from "@query-engine/raptor3/shared/schema";
import { SqlQueries } from "@query-engine/raptor3/shared/sql-queries";
import { s } from "@schema";
import { Sql } from "@sql";
import { Decimal } from "@src/index";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import { createTestCommandEngine } from "@tests/raptor3/harness/command-engine";
import Database from "better-sqlite3";
import { afterEach, describe, it, vi } from "vitest";

const LEFT_SOURCE = /"left_source"/;
const RIGHT_SOURCE = /"right_source"/;
const INVALID_PROVIDER_DECIMAL = /Invalid provider decimal/;
const LEADING_WORD = /^\w+/;
const EMPTY_SELECT =
  "select needs at least one truthy value; leave it out to return the default row.";

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

describe("post-G3 projection preparation", () => {
  it("prepares shape without SQL and binds aliases only while lowering", () => {
    const schema = projectionSchema();
    const queries = new SqlQueries(
      new EngineSchema(schema),
      new SQLiteAdapter()
    );
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
    const leftSql = renderedColumns(left);
    assert.match(leftSql, LEFT_SOURCE);
    assert.doesNotMatch(leftSql, RIGHT_SOURCE);

    const right = queries.lowerProjection(prepared, "right_source");
    assert.equal(selectAssembly.calls - firstAssemblyCount, firstAssemblyCount);
    const rightSql = renderedColumns(right);
    assert.match(rightSql, RIGHT_SOURCE);
    assert.doesNotMatch(rightSql, LEFT_SOURCE);
    assert.notEqual(left, right);
    const names = ["id", "amount", "author", "subject"];
    for (const columns of [left, right]) {
      assert.equal(columns.length, names.length);
      for (const [index, column] of columns.entries())
        assert(column.toStatement("?").endsWith(` AS "${names[index]}"`));
    }
  });

  it("decodes one prepared mapped decimal, nested, and variant shape freshly", () => {
    const schema = projectionSchema();
    const queries = new SqlQueries(
      new EngineSchema(schema),
      new SQLiteAdapter()
    );
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
});

function bulkRelationSchema() {
  const parent = s
    .model({
      id: s.int().id(),
      label: s.string(),
      children: s.toMany(() => child),
    })
    .map("post_g3_projection_bulk_parents");
  const child = s
    .model({
      id: s.int().id().increment(),
      label: s.string(),
      parentId: s.int(),
      parent: s
        .toOne(() => parent)
        .fields("parentId")
        .references("id"),
    })
    .map("post_g3_projection_bulk_children");
  return { parent, child };
}

/**
 * A relation-bearing bulk verb against a real SQLite database, with every
 * projection preparation stamped by the number of statements the driver had
 * executed when it ran — the timing the verb's refusals inherit.
 */
async function bulkRelationWorld() {
  const schema = bulkRelationSchema();
  const database = new Database(":memory:");
  const driver = new ProjectionRecordingSQLiteDriver({ client: database });
  const client = createClient({ schema, driver });
  const migration = await syncLiveSchema(client);
  if (!migration.applied)
    throw new Error("the bulk relation schema was not applied");
  database.exec(
    "INSERT INTO post_g3_projection_bulk_parents(id, label) VALUES (1, 'one'), (2, 'two')"
  );
  driver.statements.length = 0;
  const prepare = Queries.prototype.prepareProjection;
  const preparations: { readonly select: unknown; readonly after: number }[] =
    [];
  vi.spyOn(Queries.prototype, "prepareProjection").mockImplementation(function (
    this: Queries,
    model,
    args
  ) {
    if (model === schema.parent)
      preparations.push({
        select: args.select,
        after: driver.statements.length,
      });
    return prepare.call(this, model, args);
  });
  /** When the caller's own selection was prepared, in executed statements. */
  const prepared = (select: unknown) =>
    preparations
      .filter((preparation) => isDeepStrictEqual(preparation.select, select))
      .map((preparation) => preparation.after);
  const engine = createTestCommandEngine({ schema, driver });
  const writes = () =>
    driver.statements
      .map((statement) => statement.match(LEADING_WORD)?.[0])
      .filter((word) => word === "INSERT" || word === "UPDATE");
  const parents = () =>
    database
      .prepare("SELECT id, label FROM post_g3_projection_bulk_parents")
      .all();
  const children = () =>
    database
      .prepare("SELECT label, parentId FROM post_g3_projection_bulk_children")
      .all();
  return {
    children,
    client,
    database,
    engine,
    parents,
    prepared,
    writes,
  };
}

describe("relation-bearing bulk projection preparation", () => {
  let world: Awaited<ReturnType<typeof bulkRelationWorld>> | undefined;

  afterEach(async () => {
    vi.restoreAllMocks();
    await world?.client.$disconnect();
    world?.database.close();
    world = undefined;
  });

  it("answers updateMany's requested output for every member", async () => {
    world = await bulkRelationWorld();
    // Not a selection the engine prepares for itself (the stored row is
    // `{ id, label }`, the identity `{ id }`).
    const select = { label: true };
    const updated = await world.engine.execute("parent", "updateMany", {
      where: {},
      data: { label: "updated", children: { create: { label: "created" } } },
      select,
    });

    assert.deepEqual(updated, [{ label: "updated" }, { label: "updated" }]);
    assert.deepEqual(world.children(), [
      { label: "created", parentId: 1 },
      { label: "created", parentId: 2 },
    ]);
  });

  // A written selection that names nothing is the caller's mistake, refused at
  // its own path before the verb prepares or writes anything (engine-14).
  const isEmptySelectRefusal = (error: unknown) =>
    error instanceof ValidationError &&
    error.code === "V4001" &&
    error.issues[0]?.path === "select" &&
    error.issues[0]?.message === EMPTY_SELECT;

  it("refuses updateMany's empty selection at admission, before any write", async () => {
    world = await bulkRelationWorld();
    await assert.rejects(
      world.engine.execute("parent", "updateMany", {
        where: {},
        data: { label: "updated", children: { create: { label: "created" } } },
        select: { id: false },
      }),
      isEmptySelectRefusal
    );
    assert.deepEqual(world.writes(), []);
    assert.deepEqual(world.prepared({ id: false }), []);
  });

  it("refuses createMany's empty selection at admission, before its writes", async () => {
    world = await bulkRelationWorld();
    await assert.rejects(
      world.engine.execute("parent", "createMany", {
        data: [
          { id: 3, label: "three", children: { create: { label: "created" } } },
        ],
        select: { id: false },
      }),
      isEmptySelectRefusal
    );
    // The members are no longer written and rolled back: nothing ran.
    assert.deepEqual(world.writes(), []);
    assert.deepEqual(world.prepared({ id: false }), []);
    assert.deepEqual(world.parents(), [
      { id: 1, label: "one" },
      { id: 2, label: "two" },
    ]);
    assert.deepEqual(world.children(), []);
  });

  it("answers nothing for a createMany whose every member was skipped", async () => {
    world = await bulkRelationWorld();
    const created = await world.engine.execute("parent", "createMany", {
      data: [
        { id: 1, label: "again", children: { create: { label: "created" } } },
      ],
      skipDuplicates: true,
      select: { label: true },
    });

    assert.deepEqual(created, []);
    assert.deepEqual(world.children(), []);
  });
});
