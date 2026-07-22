/**
 * T3c item 6 — the family-D A/B benchmark (top-level upsert nested-relation arm,
 * TO-ONE.md §7.8).
 *
 * An EXISTING-row top-level `upsert` whose relation-bearing UPDATE arm folds a nested
 * to-many `update` (`user.upsert({ where, create, update: { name, posts: { update } }
 * })`). The `queryEngine` escape hatch runs the identical workload through the frozen
 * V1 runtime and the native V2 engine (which delegates the update arm to an
 * UpdateOperation sub-op) on two seeded in-memory SQLite databases. Ratio = V2 hz /
 * V1 hz (higher = V2 faster). Numbers, not adjectives.
 *
 * Run: pnpm bench -- benchmarks/t3c-upsert-nested-arm-ab.bench.ts
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
    .map("t3c_users");
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
    .map("t3c_posts");
  return { user, post };
})();

const makeClient = async (engine: "v1" | "v2") => {
  const driver = new SQLite3Driver({ dataDir: ":memory:" });
  const client = createClient({ schema, driver, queryEngine: engine });
  await push(client, { force: true });
  // 200 users, each owning one post — the upsert's row EXISTS, so the relation-bearing
  // update arm is taken and folds the nested post update.
  for (let i = 0; i < 200; i += 1) {
    await (client as any).user.create({
      data: { id: i, name: `u${i}`, posts: { create: { id: i, title: "t" } } },
    });
  }
  return client;
};

const v1 = await makeClient("v1");
const v2 = await makeClient("v2");
let n = 0;

const op = (i: number) => ({
  where: { id: i },
  create: { id: i, name: "unused" },
  update: {
    name: `u${i}-x`,
    posts: { update: { where: { id: i }, data: { title: "updated" } } },
  },
});

describe("family-D A/B: top-level upsert update arm folds a nested to-many update", () => {
  bench("v1 user.upsert > update: posts.update", async () => {
    await (v1 as any).user.upsert(op(n++ % 200));
  });
  bench("v2 user.upsert > update: posts.update", async () => {
    await (v2 as any).user.upsert(op(n++ % 200));
  });
});
