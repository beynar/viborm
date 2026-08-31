/** Live SQLite convergence for shape-identified constraints. */

import { createClient } from "@client/client";
import { s } from "@schema";
import { createInMemorySQLite3Driver } from "@tests/fixtures/drivers/sqlite3";
import { describe, expect, it } from "vitest";
import { syncLiveSchema } from "../../fixtures/sync-schema";

const quietUser = s
  .model({
    id: s.string().id(),
    posts: s.toMany(() => quietPost),
  })
  .map("quiet_users");

const quietPost = s
  .model({
    id: s.string().id(),
    authorId: s.string(),
    slug: s.string(),
    tenant: s.string(),
    author: s
      .toOne(() => quietUser)
      .fields("authorId")
      .references("id"),
  })
  .unique(["slug", "tenant"])
  .map("quiet_posts");

describe("SQLite push of an unchanged schema", () => {
  it("plans nothing from the second push on", async () => {
    const driver = createInMemorySQLite3Driver();
    const client = createClient({
      schema: { quietUser, quietPost } as never,
      driver,
    }) as never;

    // Push #1 creates. Pushes #2 and #3 must plan NOTHING: before the fix #2
    // planned dropForeignKey + dropUniqueConstraint + addUniqueConstraint +
    // addForeignKey, and the unique drop aborted the whole push.
    const planned: Array<readonly { readonly label: string }[]> = [];
    for (let round = 0; round < 3; round++) {
      const result = await syncLiveSchema(client);
      planned.push(result.operations);
    }

    expect(planned[1]).toEqual([]);
    expect(planned[2]).toEqual([]);

    // And the table still holds exactly what it was declared with — one FK,
    // one unique, one FK index — rather than having been rebuilt around a
    // synthesised name.
    const read = (await driver._executeRaw(
      "PRAGMA foreign_key_list(quiet_posts)"
    )) as unknown as { rows: unknown[] };
    expect(read.rows).toHaveLength(1);

    const master = (await driver._executeRaw(
      "SELECT sql FROM sqlite_master WHERE name = 'quiet_posts'"
    )) as unknown as { rows: Array<{ sql: string }> };
    expect(master.rows[0]?.sql).toContain(
      'CONSTRAINT "quiet_posts_slug_tenant_key" UNIQUE'
    );
    expect(master.rows[0]?.sql).toContain(
      'CONSTRAINT "quiet_posts_authorId_fkey" FOREIGN KEY'
    );
    await (
      client as never as { $disconnect: () => Promise<void> }
    ).$disconnect();
  });
});
