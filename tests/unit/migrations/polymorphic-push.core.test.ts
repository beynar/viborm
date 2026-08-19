import { createClient } from "@client/client";
import { push } from "@migrations";
import { s } from "@schema";
import { createInMemoryLibSQLDriver } from "@tests/fixtures/drivers/libsql";
import { createInMemorySQLite3Driver } from "@tests/fixtures/drivers/sqlite3";
import { describe, expect, it } from "vitest";

function polymorphicSchema() {
  const post = s
    .model({ id: s.string().id(), title: s.string() })
    .map("poly_push_posts");
  const video = s
    .model({ id: s.string().id(), title: s.string() })
    .map("poly_push_videos");
  const comment = s
    .model({
      id: s.string().id(),
      subject: s.polymorphicToOne(
        { post: () => post, video: () => video },
        {
          values: {
            post: "content.post.v1",
            video: "content.video.v1",
          },
        }
      ),
    })
    .map("poly_push_comments");

  return { post, video, comment };
}

function polymorphicOneToOneSchema() {
  const post = s
    .model({
      id: s.string().id(),
      title: s.string(),
      featuredComment: s
        .oneToOne(() => comment)
        .name("subject")
        .optional(),
    })
    .map("poly_push_posts");
  const video = s
    .model({
      id: s.string().id(),
      title: s.string(),
      featuredComment: s
        .oneToOne(() => comment)
        .name("subject")
        .optional(),
    })
    .map("poly_push_videos");
  const comment = s
    .model({
      id: s.string().id(),
      subject: s
        .polymorphicToOne(
          { post: () => post, video: () => video },
          {
            values: {
              post: "content.post.v1",
              video: "content.video.v1",
            },
          }
        )
        .name("subject"),
    })
    .map("poly_push_comments");

  return { post, video, comment };
}

describe("polymorphic migration push convergence", () => {
  it.each([
    ["SQLite", createInMemorySQLite3Driver],
    ["libSQL", createInMemoryLibSQLDriver],
  ] as const)("%s creates once and then plans no operations", async (_, createDriver) => {
    const driver = createDriver();
    try {
      const client = createClient({ schema: polymorphicSchema(), driver });
      const first = await push(client, { force: true });
      const second = await push(client, { force: true });

      expect(
        new Set(
          first.operations
            .filter((operation) => operation.type === "createTable")
            .map((operation) => operation.table.name)
        )
      ).toEqual(
        new Set(["poly_push_posts", "poly_push_videos", "poly_push_comments"])
      );
      expect(second.operations).toEqual([]);
    } finally {
      await driver.disconnect();
    }
  });

  it.each([
    ["SQLite", createInMemorySQLite3Driver],
    ["libSQL", createInMemoryLibSQLDriver],
  ] as const)("%s recreates the same storage index when inverse cardinality changes", async (_, createDriver) => {
    const driver = createDriver();
    try {
      const many = createClient({ schema: polymorphicSchema(), driver });
      await push(many, { force: true });

      const one = createClient({
        schema: polymorphicOneToOneSchema(),
        driver,
      });
      const toOne = await push(one, { force: true });
      const toMany = await push(many, { force: true });

      expect(toOne.operations.map((operation) => operation.type)).toEqual([
        "dropIndex",
        "createIndex",
      ]);
      expect(toMany.operations.map((operation) => operation.type)).toEqual([
        "dropIndex",
        "createIndex",
      ]);
    } finally {
      await driver.disconnect();
    }
  });

  it.each([
    ["SQLite", createInMemorySQLite3Driver],
    ["libSQL", createInMemoryLibSQLDriver],
  ] as const)("%s fails the singular migration when existing memberships are duplicated", async (_, createDriver) => {
    const driver = createDriver();
    try {
      const many = createClient({ schema: polymorphicSchema(), driver });
      await push(many, { force: true });
      await many.$executeRawUnsafe(
        'INSERT INTO "poly_push_posts" ("id", "title") VALUES (?, ?)',
        "post-1",
        "Post"
      );
      await many.$executeRawUnsafe(
        'INSERT INTO "poly_push_comments" ("id", "subject_type", "subject_id") VALUES (?, ?, ?), (?, ?, ?)',
        "comment-1",
        "content.post.v1",
        "post-1",
        "comment-2",
        "content.post.v1",
        "post-1"
      );

      const one = createClient({
        schema: polymorphicOneToOneSchema(),
        driver,
      });
      await expect(push(one, { force: true })).rejects.toThrow();

      expect((await push(many, { force: true })).operations).toEqual([]);
    } finally {
      await driver.disconnect();
    }
  });
});

// =============================================================================
// B3 COLLECTION CONVERGENCE — the member junction tables reach a real database
// and STAY converged. Migrations are not coverage-gated, so this is the
// evidence that stands in for it: a second forced push planning ZERO operations
// is the strongest statement that what the serializer emits and what the
// database reports are the same shape.
// =============================================================================

const collectionDrivers = [
  ["SQLite", createInMemorySQLite3Driver],
  ["libSQL", createInMemoryLibSQLDriver],
] as const;

/** One collection group: singular inverse (book) + plural inverse (video). */
function collectionSchema() {
  const book = s
    .model({
      id: s.string().id(),
      title: s.string(),
      shelf: s.manyToOne(() => shelf).optional(),
    })
    .map("poly_coll_books");
  const video = s
    .model({
      id: s.string().id(),
      title: s.string(),
      shelves: s.manyToMany(() => shelf),
    })
    .map("poly_coll_videos");
  const shelf = s
    .model({
      id: s.string().id(),
      items: s.polymorphicToMany(
        { book: () => book, video: () => video },
        { values: { book: "coll.book.v1", video: "coll.video.v1" } }
      ),
    })
    .map("poly_coll_shelves");

  return { book, video, shelf };
}

/** The same group with a THIRD variant added — the member-addition transition. */
function collectionSchemaWithNote() {
  const book = s
    .model({
      id: s.string().id(),
      title: s.string(),
      shelf: s.manyToOne(() => shelf).optional(),
    })
    .map("poly_coll_books");
  const video = s
    .model({
      id: s.string().id(),
      title: s.string(),
      shelves: s.manyToMany(() => shelf),
    })
    .map("poly_coll_videos");
  const note = s
    .model({ id: s.string().id(), body: s.string() })
    .map("poly_coll_notes");
  const shelf = s
    .model({
      id: s.string().id(),
      items: s.polymorphicToMany(
        { book: () => book, video: () => video, note: () => note },
        {
          values: {
            book: "coll.book.v1",
            video: "coll.video.v1",
            note: "coll.note.v1",
          },
        }
      ),
    })
    .map("poly_coll_shelves");

  return { book, video, note, shelf };
}

describe("polymorphic collection push convergence", () => {
  it.each(
    collectionDrivers
  )("%s creates the member tables once and then plans no operations", async (_, createDriver) => {
    const driver = createDriver();
    try {
      const client = createClient({ schema: collectionSchema(), driver });
      const first = await push(client, { force: true });
      const second = await push(client, { force: true });

      // Model tables PLUS one member junction per variant — and nothing for
      // the bound manyToMany view, whose membership those member tables ARE.
      expect(
        new Set(
          first.operations
            .filter((operation) => operation.type === "createTable")
            .map((operation) => operation.table.name)
        )
      ).toEqual(
        new Set([
          "poly_coll_books",
          "poly_coll_videos",
          "poly_coll_shelves",
          "poly_coll_shelves_items_book",
          "poly_coll_shelves_items_video",
        ])
      );
      // THE CONVERGENCE CLAIM: the unique target side on the singular
      // member, the non-unique reverse index on both, the compound primary
      // key and the dual cascade foreign keys all round-trip through
      // introspection without churn.
      expect(second.operations).toEqual([]);
    } finally {
      await driver.disconnect();
    }
  });

  it.each(
    collectionDrivers
  )("%s adds exactly one table when a variant is added", async (_, createDriver) => {
    const driver = createDriver();
    try {
      const before = createClient({ schema: collectionSchema(), driver });
      await push(before, { force: true });

      const after = createClient({
        schema: collectionSchemaWithNote(),
        driver,
      });
      const added = await push(after, { force: true });

      // A member addition is PURELY structural: the new variant's table and
      // its target model, nothing touched on the existing members.
      expect(
        added.operations
          .filter((operation) => operation.type === "createTable")
          .map((operation) => operation.table.name)
          .sort()
      ).toEqual(["poly_coll_notes", "poly_coll_shelves_items_note"]);
      expect(
        added.operations.filter((operation) => operation.type !== "createTable")
      ).toEqual([]);
      expect((await push(after, { force: true })).operations).toEqual([]);
    } finally {
      await driver.disconnect();
    }
  });

  it.each(
    collectionDrivers
  )("%s converges from an introspected database that carries no metadata", async (_, createDriver) => {
    const driver = createDriver();
    try {
      const client = createClient({ schema: collectionSchema(), driver });
      await push(client, { force: true });

      // Push NEVER reads the snapshot's polymorphic metadata — it plans
      // against what introspection reports, which carries no
      // `polymorphicStorage` and no `relationStorage` registry at all. If
      // either annotation leaked into the structural comparison, this second
      // push would churn forever. A fresh client over the same database is
      // the sharpest form of the check.
      const rebuilt = createClient({ schema: collectionSchema(), driver });
      expect((await push(rebuilt, { force: true })).operations).toEqual([]);
    } finally {
      await driver.disconnect();
    }
  });
});
