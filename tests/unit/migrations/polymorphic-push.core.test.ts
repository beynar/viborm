import { createClient } from "@client/client";
import { push } from "@migrations";
import { s } from "@schema";
import { describe, expect, it } from "vitest";
import { createInMemoryLibSQLDriver } from "@tests/fixtures/drivers/libsql";
import { createInMemorySQLite3Driver } from "@tests/fixtures/drivers/sqlite3";

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

describe("polymorphic migration push convergence", () => {
  it.each([
    ["SQLite", createInMemorySQLite3Driver],
    ["libSQL", createInMemoryLibSQLDriver],
  ] as const)(
    "%s creates once and then plans no operations",
    async (_, createDriver) => {
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
          new Set([
            "poly_push_posts",
            "poly_push_videos",
            "poly_push_comments",
          ])
        );
        expect(second.operations).toEqual([]);
      } finally {
        await driver.disconnect();
      }
    }
  );
});
