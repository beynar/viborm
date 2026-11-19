/**
 * Relations between database views and tables in the snapshot and the
 * program (`docs/architecture/schema-views-plan.md` §2.5): an edge with a
 * view at either end holds no foreign key and no action, and its columns keep
 * their index; a relation declared on a view is not the view's identity; a
 * view that crosses a relation of the view it reads lists that view and the
 * relation's target in what it reads, holds the relation in its identity,
 * and is replaced around the view it reads. A key's identifier conversion
 * checks the table columns that hold its values, under a view or through one.
 */

import { s } from "@schema";
import type { AnyModel, Model } from "@schema/model";
import type { AnyRelation } from "@schema/relation/types";
import { diff } from "@src/migrations/differ";
import type { MigrationDriver } from "@src/migrations/drivers/base";
import { mysqlMigrationDriver } from "@src/migrations/drivers/mysql";
import { postgresMigrationDriver } from "@src/migrations/drivers/postgres";
import { snowflakeMigrationDriver } from "@src/migrations/drivers/snowflake";
import { sqlite3MigrationDriver } from "@src/migrations/drivers/sqlite";
import { identifierConversionChecks } from "@src/migrations/identifier-conversion";
import { serializeModels } from "@src/migrations/serializer";
import type { SchemaSnapshot } from "@src/migrations/types";
import { prepareSchemaProgram } from "@src/migrations/utils";
import { describe, expect, it } from "vitest";

// These pin snapshots of schemas built with and without a relation, so the
// builders are taken untyped: a model's type is not what is tested.
type Fields = Record<string, unknown>;
const model = s.model as unknown as (shape: Fields) => Model<any>;
const view = s.view as unknown as (
  source: () => AnyModel,
  query: object
) => AnyModel;

const CHILD_TABLE = /FROM "(\w+)" AS c /;

const DRIVERS = [
  ["PostgreSQL", postgresMigrationDriver],
  ["MySQL", mysqlMigrationDriver],
  ["SQLite", sqlite3MigrationDriver],
] as const;

const FEED_QUERY = {
  where: { published: true },
  select: { id: true, title: true, authorId: true, editorId: true },
};

interface Shape {
  /** The name of the relation the feed declares to its author, or none. */
  readonly feedAuthor?: string;
  /** The feed's relation reads `editorId` instead of `authorId`. */
  readonly traded?: boolean;
  /** `note.postId` references the feed's key, many notes per row. */
  readonly notes?: boolean;
  /** `meta.postId` references the feed's key, one meta per row. */
  readonly metas?: boolean;
  /** A view over the feed whose filter and documents cross its relation. */
  readonly over?: boolean;
  /** A view over the notes that includes the feed row each one references. */
  readonly noted?: boolean;
  /** The feed's query. */
  readonly feedQuery?: object;
}

/** A fresh schema each time: a model object binds one schema key for good. */
function schemaOf(shape: Shape): Record<string, AnyModel> {
  const author = shape.feedAuthor;
  const user: AnyModel = model({
    id: s.string().id(),
    name: s.string(),
    posts: s.toMany(() => post),
    // The to-many back to the feed: both ends declare their slot.
    ...(author ? { feeds: s.toMany(() => feed) } : {}),
  }).map("users");
  const post: AnyModel = model({
    id: s.string().id(),
    title: s.string(),
    published: s.boolean(),
    authorId: s.string(),
    editorId: s.string(),
    author: s
      .toOne(() => user)
      .fields("authorId")
      .references("id"),
  }).map("posts");
  const feedRelations: Record<string, AnyRelation> = {};
  if (author)
    feedRelations[author] = s
      .toOne(() => user)
      .fields(shape.traded ? "editorId" : "authorId")
      .references("id");
  if (shape.notes) feedRelations.notes = s.toMany(() => note);
  if (shape.metas) feedRelations.meta = s.toOne(() => meta);
  const declared = view(() => post, shape.feedQuery ?? FEED_QUERY);
  const feed: AnyModel = (
    Object.keys(feedRelations).length > 0
      ? declared.extends(feedRelations)
      : declared
  ).map("feed");
  const note: AnyModel = model({
    id: s.string().id(),
    body: s.string(),
    postId: s.string(),
    ...(shape.notes
      ? {
          post: s
            .toOne(() => feed)
            .fields("postId")
            .references("id"),
        }
      : {}),
  }).map("notes");
  const meta: AnyModel = model({
    id: s.string().id(),
    postId: s.string(),
    post: s
      .toOne(() => feed)
      .fields("postId")
      .references("id"),
  }).map("metas");
  const schema: Record<string, AnyModel> = { user, post, feed, note };
  if (shape.metas) schema.meta = meta;
  if (shape.over && author)
    schema.over = view(() => feed, {
      where: { [author]: { name: "Ann" } },
      select: { id: true, [author]: { select: { name: true } } },
    }).map("over");
  if (shape.noted && shape.notes)
    schema.noted = view(() => note, {
      select: { id: true, post: { select: { title: true } } },
    }).map("noted");
  return schema;
}

const snapshotOf = (
  shape: Shape,
  migrationDriver: MigrationDriver = sqlite3MigrationDriver
) => serializeModels(schemaOf(shape), { migrationDriver });

const tableOf = (snapshot: SchemaSnapshot, name: string) =>
  snapshot.tables.find((table) => table.name === name)!;
const viewOf = (snapshot: SchemaSnapshot, name: string) =>
  snapshot.views!.find((stored) => stored.name === name)!;

/** The program a push plans from one snapshot to the other. */
async function program(
  from: SchemaSnapshot,
  to: SchemaSnapshot,
  migrationDriver: MigrationDriver = sqlite3MigrationDriver
): Promise<string[]> {
  const { operations } = await diff(from, to);
  return prepareSchemaProgram(operations, from, to, migrationDriver).map(
    (operation) =>
      operation.type === "createView"
        ? `createView ${operation.view.name}`
        : operation.type === "dropView"
          ? `dropView ${operation.viewName}`
          : operation.type
  );
}

describe("an edge with a view at an end holds no foreign key", () => {
  it.each(
    DRIVERS
  )("%s: a table's reference to a view's key keeps its index and holds no constraint", (_, migrationDriver) => {
    const notes = tableOf(
      snapshotOf({ feedAuthor: "author", notes: true }, migrationDriver),
      "notes"
    );
    expect(notes.foreignKeys).toEqual([]);
    expect(notes.indexes).toEqual([
      { name: "notes_postId_idx", columns: ["postId"], unique: false },
    ]);
  });

  it("a unique reference to a view keeps its unique constraint, the table's own", () => {
    const metas = tableOf(snapshotOf({ metas: true }), "metas");
    expect(metas.foreignKeys).toEqual([]);
    expect(metas.uniqueConstraints).toEqual([
      { name: "metas_postId_key", columns: ["postId"] },
    ]);
  });

  it("a view's reference to a table and the table's to-many back change no table", () => {
    const plain = snapshotOf({});
    const related = snapshotOf({ feedAuthor: "author" });
    expect(related.tables).toEqual(plain.tables);
  });

  it("a schema whose table references a view is refused where VibORM creates no view", () => {
    const shape: Shape = { feedAuthor: "author", notes: true };
    expect(() => snapshotOf(shape, snowflakeMigrationDriver)).toThrow(
      "VibORM creates no view on"
    );
  });

  it("the tables keep their foreign keys between them", () => {
    const posts = tableOf(snapshotOf({ notes: true }), "posts");
    expect(
      posts.foreignKeys.map(({ referencedTable }) => referencedTable)
    ).toEqual(["users"]);
  });
});

describe("a view's identity and the relations it holds", () => {
  it("a relation declared on a view, added, renamed or removed, changes neither its hash nor its body", async () => {
    const shapes: Shape[] = [
      {},
      { feedAuthor: "author" },
      { feedAuthor: "writer" },
      { feedAuthor: "author", notes: true },
    ];
    const snapshots = shapes.map((shape) => snapshotOf(shape));
    const feeds = snapshots.map((snapshot) => viewOf(snapshot, "feed"));
    expect(new Set(feeds.map(({ hash }) => hash)).size).toBe(1);
    expect(new Set(feeds.map(({ sql }) => sql)).size).toBe(1);
    // Nothing to replace: the declared relation is no part of the body.
    expect(await program(snapshots[0]!, snapshots[1]!)).toEqual([]);
    expect(await program(snapshots[1]!, snapshots[2]!)).toEqual([]);
    expect(await program(snapshots[2]!, snapshots[0]!)).toEqual([]);
  });

  it("a table's reference to a view adds its index and nothing else", async () => {
    const before = snapshotOf({ feedAuthor: "author" });
    const after = snapshotOf({ feedAuthor: "author", notes: true });
    expect(await program(before, after)).toEqual(["createIndex"]);
    expect(await program(after, before)).toEqual(["dropIndex"]);
  });
});

describe("a view over a view that crosses the relation its source declares", () => {
  it("lists the view and the relation's target it reads, and compiles on every dialect", () => {
    for (const [, migrationDriver] of DRIVERS) {
      const snapshot = snapshotOf(
        { feedAuthor: "author", over: true },
        migrationDriver
      );
      const over = viewOf(snapshot, "over");
      expect(over.dependsOn).toEqual(["feed", "users"]);
      expect(over.sql).toContain("users");
    }
  });

  it("holds the relation in its identity: moved to another column, the reader is replaced and the feed is not", async () => {
    const before = snapshotOf({ feedAuthor: "author", over: true });
    const after = snapshotOf({
      feedAuthor: "author",
      over: true,
      traded: true,
    });
    expect(viewOf(after, "feed").hash).toBe(viewOf(before, "feed").hash);
    expect(viewOf(after, "over").hash).not.toBe(viewOf(before, "over").hash);
    expect(await program(before, after)).toEqual([
      "dropView over",
      "createView over",
    ]);
  });

  it("is replaced around the view it reads, and so is a table's view that reads it", async () => {
    const shape: Shape = {
      feedAuthor: "author",
      notes: true,
      over: true,
      noted: true,
    };
    const before = snapshotOf(shape);
    expect(viewOf(before, "noted").dependsOn).toEqual(["feed", "notes"]);
    const after = snapshotOf({
      ...shape,
      feedQuery: { ...FEED_QUERY, where: { published: false } },
    });
    expect(await program(before, after)).toEqual([
      "dropView noted",
      "dropView over",
      "dropView feed",
      "createView feed",
      "createView over",
      "createView noted",
    ]);
  });
});

describe("the identifier conversion of a key a view's relations reference", () => {
  const user = s
    .model({
      id: s.string().id().ulid(),
      posts: s.toMany(() => post),
      feeds: s.toMany(() => feed),
    })
    .map("users");
  const post = s
    .model({
      id: s.string().id().ulid(),
      published: s.boolean(),
      authorId: s.string(),
      author: s
        .toOne(() => user)
        .fields("authorId")
        .references("id"),
    })
    .map("posts");
  const feed = s
    .view(() => post, {
      where: { published: true },
      select: { id: true, authorId: true },
    })
    .extends({
      author: s
        .toOne(() => user)
        .fields("authorId")
        .references("id"),
      notes: s.toMany(() => note),
    })
    .map("feed");
  const note = s
    .model({
      id: s.string().id(),
      postId: s.string(),
      post: s
        .toOne(() => feed)
        .fields("postId")
        .references("id"),
    })
    .map("notes");
  const schema = { user, post, feed, note };
  /** The table each check reads its referencing rows from. */
  const children = (model: AnyModel) =>
    identifierConversionChecks({
      schema,
      model,
      field: "id",
      dialect: "sqlite",
    }).flatMap(({ query }) => {
      const read = CHILD_TABLE.exec(query.toStatement("?"));
      return read ? [read[1]] : [];
    });

  it("a view's reference is its source's column, checked once", () => {
    // The format and the parent for `posts.authorId`; never the view.
    expect(children(user)).toEqual(["posts", "posts"]);
  });

  it("a reference to a view's key holds its source's key, and is checked with it", () => {
    expect(children(post)).toEqual(["notes", "notes"]);
  });
});

describe("views whose queries read each other", () => {
  /**
   * Users and who manages them, and `digest`, a view of users related to the
   * manager of each: a manager's `digests` are the view's rows of the users
   * they manage, so a query of the view that crosses `digests` reads the view.
   */
  const serialized = (query: object) => {
    const user: AnyModel = model({
      id: s.string().id(),
      name: s.string(),
      managerId: s.string().nullable(),
      manager: s
        .toOne(() => user)
        .fields("managerId")
        .references("id"),
      reports: s.toMany(() => user),
      digests: s.toMany(() => digest),
    }).map("users");
    const digest: AnyModel = view(() => user, query)
      .extends({
        manager: s
          .toOne(() => user)
          .fields("managerId")
          .references("id"),
      })
      .map("digest");
    const schema: Record<string, AnyModel> = { user, digest };
    return () =>
      serializeModels(schema, { migrationDriver: sqlite3MigrationDriver });
  };
  const KEPT = { id: true, managerId: true };

  it("refuses a view whose count, selection or filter crosses a relation back to itself", () => {
    // `_count: true` counts every to-many of the source: its own rows too.
    for (const query of [
      { select: { ...KEPT, _count: true } },
      { select: { ...KEPT, digests: true } },
      { where: { digests: { some: {} } }, select: KEPT },
    ])
      expect(serialized(query)).toThrow(
        "View 'digest' reads 'digest', whose query reads that view back"
      );
  });

  it("a relation its query names switched off is neither read nor in its identity", () => {
    const plain = serialized({ select: KEPT })().views![0]!;
    const off = serialized({ select: { ...KEPT, digests: false } })()
      .views![0]!;
    expect(off.sql).toBe(plain.sql);
    expect(off.dependsOn).toEqual(plain.dependsOn);
  });

  it("admits the same view when its query leaves that relation out", () => {
    const snapshot = serialized({
      select: { ...KEPT, _count: { select: { reports: true } } },
    })();
    expect(snapshot.views?.map(({ name }) => name)).toEqual(["digest"]);
  });

  it("refuses two views that read each other through their relations", () => {
    const user: AnyModel = model({
      id: s.string().id(),
      managerId: s.string().nullable(),
      manager: s
        .toOne(() => user)
        .fields("managerId")
        .references("id"),
      reports: s.toMany(() => user),
      firsts: s.toMany(() => first),
      seconds: s.toMany(() => second),
    }).map("users");
    const managed = () =>
      s
        .toOne(() => user)
        .fields("managerId")
        .references("id");
    const first: AnyModel = view(() => user, {
      select: { id: true, managerId: true, seconds: true },
    })
      .extends({ manager: managed() })
      .map("first");
    const second: AnyModel = view(() => user, {
      select: { id: true, managerId: true, firsts: true },
    })
      .extends({ manager: managed() })
      .map("second");
    const schema: Record<string, AnyModel> = { user, first, second };
    expect(() =>
      serializeModels(schema, { migrationDriver: sqlite3MigrationDriver })
    ).toThrow("whose query reads that view back");
  });
});
