/** Live SQLite convergence after table-recreation replay. */

import { createClient } from "@client/client";
import { s } from "@schema";
import { createInMemorySQLite3Driver } from "@tests/fixtures/drivers/sqlite3";
import { describe, expect, it } from "vitest";
import { syncLiveSchema } from "../../fixtures/sync-schema";

const recreationUser = s
  .model({
    id: s.string().id(),
    posts: s.toMany(() => recreationPost),
  })
  .map("recreation_users");

const recreationPost = s
  .model({
    id: s.string().id(),
    authorId: s.string(),
    author: s
      .toOne(() => recreationUser)
      .fields("authorId")
      .references("id"),
  })
  .map("recreation_posts");

describe("SQLite foreign keys across repeated pushes", () => {
  it("holds exactly one foreign key however many times the schema is pushed", async () => {
    const driver = createInMemorySQLite3Driver();
    const client = createClient({
      schema: { recreationUser, recreationPost } as never,
      driver,
    }) as never;

    const counts: number[] = [];
    for (let round = 0; round < 3; round++) {
      await syncLiveSchema(client);
      const read = (await driver._executeRaw(
        "PRAGMA foreign_key_list(recreation_posts)"
      )) as unknown as { rows?: unknown[] };
      counts.push((read.rows ?? (read as unknown as unknown[])).length);
    }

    // [1, 2, 3] before the replay: every push added another copy.
    expect(counts).toEqual([1, 1, 1]);
    await (
      client as never as { $disconnect: () => Promise<void> }
    ).$disconnect();
  });
});
