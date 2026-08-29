/**
 * Nested-write benchmarks.
 *
 * Measures the nested-write execution path end-to-end on in-memory SQLite —
 * the path rebuilt by the engine unification (interpreter + modes at HEAD,
 * dual engines before). Identical file is injected into the pre-unification
 * baseline worktree so pnpm bench:compare quantifies the interpreter's cost.
 *
 * IDs are counter-suffixed: tables grow across iterations identically in
 * both trees, so growth noise cancels in the comparison.
 *
 * Run: pnpm bench
 */
import { createClient } from "@client/client";
import { SQLite3Driver } from "@drivers/sqlite3";
import { pushV1 as push } from "@migrations/push-v1";
import { bench, describe } from "vitest";
import { sqliteUserPostSchema } from "../tests/fixtures/user-post-schema";

const driver = new SQLite3Driver({ dataDir: ":memory:" });
const client = createClient({ schema: sqliteUserPostSchema, driver });
await push(client);

// A stable pool of users/posts for connect/set/update targets.
for (let i = 0; i < 50; i++) {
  await driver._executeRaw(
    'INSERT INTO "users" ("id", "name", "email", "age") VALUES (?, ?, ?, ?)',
    [`seed_user_${i}`, `User ${i}`, `seed${i}@example.com`, 30]
  );
  await driver._executeRaw(
    'INSERT INTO "posts" ("id", "title", "content", "published", "views", "authorId") VALUES (?, ?, ?, ?, ?, ?)',
    [`seed_post_${i}`, `Post ${i}`, null, 0, 0, `seed_user_${i}`]
  );
}

let n = 0;

describe("nested: create with 2 nested child creates", () => {
  bench("viborm create + posts.create[2]", async () => {
    const i = n++;
    await client.user.create({
      data: {
        id: `nw_u_${i}`,
        name: `U${i}`,
        email: `nw${i}@example.com`,
        age: 30,
        posts: {
          create: [
            { id: `nw_p_${i}_a`, title: "a", published: false, views: 0 },
            { id: `nw_p_${i}_b`, title: "b", published: false, views: 0 },
          ],
        },
      },
    });
  });
});

describe("nested: create with connect to existing child", () => {
  bench("viborm create + posts.connect", async () => {
    const i = n++;
    await driver._executeRaw(
      'INSERT INTO "posts" ("id", "title", "content", "published", "views", "authorId") VALUES (?, ?, ?, ?, ?, ?)',
      [`cn_p_${i}`, "t", null, 0, 0, "seed_user_0"]
    );
    await client.user.create({
      data: {
        id: `cn_u_${i}`,
        name: `C${i}`,
        email: `cn${i}@example.com`,
        age: 30,
        posts: { connect: { id: `cn_p_${i}` } },
      },
    });
  });
});

describe("nested: update with nested child create", () => {
  bench("viborm update + posts.create", async () => {
    const i = n++;
    await client.user.update({
      where: { id: "seed_user_1" },
      data: {
        age: { increment: 1 },
        posts: {
          create: { id: `up_p_${i}`, title: "u", published: false, views: 0 },
        },
      },
    });
  });
});

describe("nested: update with set (replace membership)", () => {
  bench("viborm update + posts.set[1]", async () => {
    await client.user.update({
      where: { id: "seed_user_2" },
      data: { posts: { set: [{ id: "seed_post_2" }] } },
    });
  });
});

describe("nested: nested to-many upsert", () => {
  bench("viborm update + posts.upsert (update branch)", async () => {
    await client.user.update({
      where: { id: "seed_user_3" },
      data: {
        posts: {
          upsert: {
            where: { id: "seed_post_3" },
            create: {
              id: "seed_post_3",
              title: "x",
              published: false,
              views: 0,
            },
            update: { views: { increment: 1 } },
          },
        },
      },
    });
  });
});

describe("nested: connectOrCreate (existing branch)", () => {
  bench("viborm update + posts.connectOrCreate", async () => {
    await client.user.update({
      where: { id: "seed_user_4" },
      data: {
        posts: {
          connectOrCreate: {
            where: { id: "seed_post_4" },
            create: {
              id: "seed_post_4",
              title: "y",
              published: false,
              views: 0,
            },
          },
        },
      },
    });
  });
});
