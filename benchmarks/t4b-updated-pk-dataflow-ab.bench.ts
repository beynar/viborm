/**
 * T4b CLASS III A/B — batch updated-PK dataflow (ATOM §8.1 T4b).
 *
 * Before T4b, a top-level `update` that TRANSITIONS its primary key while a nested
 * `create` references that PK routed to V1 (the fresh INSERT could not be ordered
 * after the transition). T4b absorbed it onto V2: the post-transition PK is
 * compile-derived (V1's `getUpdatedPrimaryKeyValue`) into a literal child FK, and
 * the INSERT is ordered after the root UPDATE (`afterRootCreateParts`). This
 * benchmarks the absorbed shape head-to-head: `user.update({ where: { id }, data: {
 * id: { increment }, name, posts: { create } } })`. The `queryEngine` escape hatch
 * runs the identical workload through the frozen V1 batch runtime and the native V2
 * engine on two seeded in-memory SQLite databases (transaction substrate).
 *
 * A NO-ACTION child FK cannot cascade, so a transitioned parent must have no child
 * yet — each iteration therefore consumes a FRESH pre-seeded parent (id `n`,
 * transitioned to `n + POOL`); iterations are bounded below the pool size.
 * Ratio = V2 hz / V1 hz (higher = V2 faster). Numbers, not adjectives.
 *
 * Run: pnpm bench -- benchmarks/t4b-updated-pk-dataflow-ab.bench.ts
 */
import { createClient } from "@client/client";
import { SQLite3Driver } from "@drivers/sqlite3";
import { push } from "@migrations";
import { s } from "@schema";
import { bench, describe } from "vitest";

const POOL = 6000;
const ITERATIONS = 2000;
const WARMUP = 100;

const schema = (() => {
  const user = s
    .model({
      id: s.int().id(),
      name: s.string(),
      posts: s.oneToMany(() => post),
    })
    .map("t4b_users");
  const post = s
    .model({
      id: s.int().id().increment(),
      title: s.string(),
      userId: s.int(),
      author: s
        .manyToOne(() => user)
        .fields("userId")
        .references("id"),
    })
    .map("t4b_posts");
  return { user, post };
})();

const makeClient = async (engine: "v1" | "v2") => {
  const driver = new SQLite3Driver({ dataDir: ":memory:" });
  const client = createClient({ schema, driver, queryEngine: engine });
  await push(client, { force: true });
  // A pool of childless parents; each iteration consumes one (transition needs a
  // parent whose old id no child yet references — a NO-ACTION FK cannot cascade).
  for (let i = 0; i < POOL; i += 1) {
    await (client as any).user.create({ data: { id: i, name: `u${i}` } });
  }
  return client;
};

const v1 = await makeClient("v1");
const v2 = await makeClient("v2");
let nv1 = 0;
let nv2 = 0;

const op = (id: number) => ({
  where: { id },
  data: {
    id: { increment: POOL },
    name: `u${id}-x`,
    posts: { create: { title: "c" } },
  },
});

describe("CLASS III A/B: update transition PK + nested create", () => {
  bench(
    "v1 user.update > id increment + posts.create",
    async () => {
      await (v1 as any).user.update(op(nv1++));
    },
    { iterations: ITERATIONS, warmupIterations: WARMUP, time: 0, warmupTime: 0 }
  );
  bench(
    "v2 user.update > id increment + posts.create",
    async () => {
      await (v2 as any).user.update(op(nv2++));
    },
    { iterations: ITERATIONS, warmupIterations: WARMUP, time: 0, warmupTime: 0 }
  );
});
