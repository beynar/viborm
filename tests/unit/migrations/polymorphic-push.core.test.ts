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
      subject: s.polymorphic(
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
      featuredComment: s.oneToOne(() => comment).name("subject"),
    })
    .map("poly_push_posts");
  const video = s
    .model({
      id: s.string().id(),
      title: s.string(),
      featuredComment: s.oneToOne(() => comment).name("subject"),
    })
    .map("poly_push_videos");
  const comment = s
    .model({
      id: s.string().id(),
      subject: s
        .polymorphic(
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
