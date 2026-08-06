/**
 * T3c item 6 — the family-D A/B benchmark for a top-level upsert
 * nested-relation arm.
 *
 * An EXISTING-row top-level `upsert` whose relation-bearing UPDATE arm folds a nested
 * to-many `update` (`user.upsert({ where, create, update: { name, posts: { update } }
 * })`), which the engine delegates to an UpdateOperation sub-op. Single-armed since
 * P6 deleted V1 and the `queryEngine` escape hatch it used to A/B against; the
 * recorded V2/V1 ratio stays in `docs/architecture/engine-unification/PERF.md`.
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

const makeClient = async () => {
  const driver = new SQLite3Driver({ dataDir: ":memory:" });
  const client = createClient({ schema, driver });
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

const client = await makeClient();
let n = 0;

const op = (i: number) => ({
  where: { id: i },
  create: { id: i, name: "unused" },
  update: {
    name: `u${i}-x`,
    posts: { update: { where: { id: i }, data: { title: "updated" } } },
  },
});

describe("family-D: top-level upsert update arm folds a nested to-many update", () => {
  bench("user.upsert > update: posts.update", async () => {
    await (client as any).user.upsert(op(n++ % 200));
  });
});
