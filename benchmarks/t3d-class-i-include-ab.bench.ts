/**
 * T3d CLASS I A/B — `update` with `include` result-shaping (ATOM §8.1 T3d).
 *
 * Before T3d, `update`/`upsert` rejected `include` and `delete` required a
 * `select`, so any `*-with-include` (and every plain no-select delete) routed to
 * V1. T3d absorbed the whole result-shaping surface onto V2. This benchmarks the
 * absorbed shape head-to-head: an existing-row `update` that sets a scalar and
 * refetches an included to-many relation (`user.update({ where, data: { name },
 * include: { posts } })`). The `queryEngine` escape hatch runs the identical
 * workload through the frozen V1 runtime and the native V2 engine on two seeded
 * in-memory SQLite databases. Ratio = V2 hz / V1 hz (higher = V2 faster).
 * Numbers, not adjectives.
 *
 * Run: pnpm bench -- benchmarks/t3d-class-i-include-ab.bench.ts
 */
import { createClient } from "@client/client";
import { SQLite3Driver } from "@drivers/sqlite3";
import { push } from "@migrations";
import { s } from "@schema";
import { bench, describe } from "vitest";

const schema = (() => {
  const user = s
    .model({
      id: s.int().id(),
      name: s.string(),
      posts: s.oneToMany(() => post),
    })
    .map("t3d_users");
  const post = s
    .model({
      id: s.int().id(),
      title: s.string(),
      userId: s.int().nullable(),
      author: s
        .manyToOne(() => user)
        .fields("userId")
        .references("id")
        .optional(),
    })
    .map("t3d_posts");
  return { user, post };
})();

const makeClient = async (engine: "v1" | "v2") => {
  const driver = new SQLite3Driver({ dataDir: ":memory:" });
  const client = createClient({ schema, driver, queryEngine: engine });
  await push(client, { force: true });
  // 200 users, each owning two posts — the update refetches the included to-many.
  for (let i = 0; i < 200; i += 1) {
    await (client as any).user.create({
      data: {
        id: i,
        name: `u${i}`,
        posts: {
          create: [
            { id: i * 2, title: "a" },
            { id: i * 2 + 1, title: "b" },
          ],
        },
      },
    });
  }
  return client;
};

const v1 = await makeClient("v1");
const v2 = await makeClient("v2");
let n = 0;

const op = (i: number) => ({
  where: { id: i },
  data: { name: `u${i}-x` },
  include: { posts: true },
});

describe("CLASS I A/B: update with include (refetch a to-many)", () => {
  bench("v1 user.update > include: posts", async () => {
    await (v1 as any).user.update(op(n++ % 200));
  });
  bench("v2 user.update > include: posts", async () => {
    await (v2 as any).user.update(op(n++ % 200));
  });
});
