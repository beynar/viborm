/** Live generated forward-reference migration application on PGlite. */

import { createClient } from "@client/client";
import { applyV1 as apply } from "@migrations/apply-v1";
import { generateV1 as generate } from "@migrations/generate-v1";
import { s } from "@schema";
import { createInMemoryPGliteDriver } from "@tests/fixtures/drivers/pglite";
import { MemoryStorage } from "@tests/unit/migrations/_estate";
import { describe, expect, it } from "vitest";

const ALTER_ADD_FK_RE = /ALTER TABLE .* FOREIGN KEY/i;

// The generated-migration-file path shares the differ with push(); it must
// order the same way. This exercises generate() end to end (SQL + apply) on a
// forward-ref schema.
describe("generate() migration file — forward-ref ordering", () => {
  const forwardRefSchema = (() => {
    const post = s.model({
      id: s.string().id(),
      title: s.string(),
      authorId: s.string(),
      author: s
        .toOne(() => user)
        .fields("authorId")
        .references("id"),
    });
    const user = s.model({
      id: s.string().id(),
      name: s.string(),
      posts: s.toMany(() => post),
    });
    return { post, user };
  })();

  it("emits every CREATE TABLE before any ADD ... FOREIGN KEY, and applies", async () => {
    const storage = new MemoryStorage();
    const client = createClient({
      schema: forwardRefSchema as never,
      driver: createInMemoryPGliteDriver(),
    });

    const gen = await generate(client as never, storage, { name: "init" });

    expect(gen.outcome).toBe("published");
    expect(gen.stateId).not.toBeNull();
    const lastCreate = gen.sql.lastIndexOf("CREATE TABLE");
    const firstAlterFk = gen.sql.search(ALTER_ADD_FK_RE);
    expect(lastCreate).toBeGreaterThanOrEqual(0);
    expect(firstAlterFk).toBeGreaterThanOrEqual(0);
    expect(lastCreate).toBeLessThan(firstAlterFk);

    // The generated migration applies cleanly and round-trips.
    const applied = await apply(client as never, storage);
    expect(applied.outcome).toBe("applied");
    expect(applied.path).toHaveLength(1);

    const c = client as never as Record<string, any>;
    await c.user.create({ data: { id: "u1", name: "Ann" } });
    await c.post.create({ data: { id: "p1", title: "T", authorId: "u1" } });
    const posts = await c.post.findMany({ include: { author: true } });
    expect(posts).toHaveLength(1);
    expect(posts[0]?.author?.id).toBe("u1");

    await (
      client as never as { $disconnect: () => Promise<void> }
    ).$disconnect();
  });
});

