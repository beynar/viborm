/**
 * PLAN P5 item 4 — the default-flip A/B benchmark.
 *
 * The escape hatch (`queryEngine: "v1" | "v2"`) lets one process run identical
 * workloads through the frozen V1 runtime and the flipped V2 engine on separate
 * in-memory SQLite databases seeded identically. Ratios are V2 hz / V1 hz
 * (higher = V2 faster). Read the numbers, name the regressions — PERF.md
 * precedent is numbers, not adjectives.
 *
 * Run: pnpm bench -- benchmarks/p5-flip-ab.bench.ts
 */
import { createClient } from "@client/client";
import { SQLite3Driver } from "@drivers/sqlite3";
import { push } from "@migrations";
import { bench, describe } from "vitest";
import { sqliteUserPostSchema } from "../tests/fixtures/user-post-schema";

const makeClient = async (engine: "v1" | "v2") => {
  const driver = new SQLite3Driver({ dataDir: ":memory:" });
  const client = createClient({
    schema: sqliteUserPostSchema,
    driver,
    queryEngine: engine,
  });
  await push(client, { force: true });
  for (let i = 0; i < 200; i++) {
    await driver._executeRaw(
      'INSERT INTO "users" ("id", "name", "email", "age") VALUES (?, ?, ?, ?)',
      [`u_${i}`, `User ${i}`, `u${i}@example.com`, 30]
    );
  }
  // Posts for the T2 update-root to-one A/B (parent-held connectOrCreate under
  // update): each post p_i starts owned by u_i.
  for (let i = 0; i < 200; i++) {
    await driver._executeRaw(
      'INSERT INTO "posts" ("id", "title", "content", "published", "views", "authorId") VALUES (?, ?, ?, ?, ?, ?)',
      [`p_${i}`, `Post ${i}`, null, 0, 0, `u_${i}`]
    );
  }
  return client;
};

const v1 = await makeClient("v1");
const v2 = await makeClient("v2");
let n = 0;

describe("flip A/B: findMany", () => {
  bench("v1 findMany", async () => {
    await v1.user.findMany({ take: 50 });
  });
  bench("v2 findMany", async () => {
    await v2.user.findMany({ take: 50 });
  });
});

describe("flip A/B: findUnique", () => {
  bench("v1 findUnique", async () => {
    await v1.user.findUnique({ where: { id: `u_${n++ % 200}` } });
  });
  bench("v2 findUnique", async () => {
    await v2.user.findUnique({ where: { id: `u_${n++ % 200}` } });
  });
});

describe("flip A/B: scalar update", () => {
  bench("v1 update", async () => {
    await v1.user.update({
      where: { id: `u_${n++ % 200}` },
      data: { age: (n % 40) + 18 },
    });
  });
  bench("v2 update", async () => {
    await v2.user.update({
      where: { id: `u_${n++ % 200}` },
      data: { age: (n % 40) + 18 },
    });
  });
});

describe("flip A/B: updateMany", () => {
  bench("v1 updateMany", async () => {
    await v1.user.updateMany({
      where: { age: { gte: 0 } },
      data: { age: (n++ % 40) + 18 },
    });
  });
  bench("v2 updateMany", async () => {
    await v2.user.updateMany({
      where: { age: { gte: 0 } },
      data: { age: (n++ % 40) + 18 },
    });
  });
});

describe("flip A/B: upsert (update branch)", () => {
  bench("v1 upsert", async () => {
    await v1.user.upsert({
      where: { id: `u_${n++ % 200}` },
      create: { id: "unused", name: "x", email: "x@x.com", age: 1 },
      update: { age: (n % 40) + 18 },
    });
  });
  bench("v2 upsert", async () => {
    await v2.user.upsert({
      where: { id: `u_${n++ % 200}` },
      create: { id: "unused", name: "x", email: "x@x.com", age: 1 },
      update: { age: (n % 40) + 18 },
    });
  });
});

// T3a family A — the FK-holder-side (parent-held) to-one `update` under an update
// root: `post.update({ author: { update } })` locates the referenced user through
// the post's own authorId and mutates it. Absorbed on V2 (was a whole-tree route to
// V1); this A/B is the honest V2-vs-V1 cost of the newly-native path.
describe("flip A/B: parent-held to-one update (family A)", () => {
  bench("v1 parent-held to-one update", async () => {
    await v1.post.update({
      where: { id: `p_${n++ % 200}` },
      data: { author: { update: { name: `PH ${n}` } } },
    });
  });
  bench("v2 parent-held to-one update", async () => {
    await v2.post.update({
      where: { id: `p_${n++ % 200}` },
      data: { author: { update: { name: `PH ${n}` } } },
    });
  });
});

// The create family (P6-prerequisite). Unique ids per call per arm (the two arms
// run on separate in-memory DBs) so each INSERT is a fresh row, never a PK
// collision. The nested create exercises the child-held-FK fold.
let cScalarV1 = 0;
let cScalarV2 = 0;
let cNestV1 = 0;
let cNestV2 = 0;

describe("flip A/B: scalar create", () => {
  bench("v1 create", async () => {
    const id = `cs1_${cScalarV1++}`;
    await v1.user.create({
      data: { id, name: "New", email: `${id}@x.com`, age: 20 },
    });
  });
  bench("v2 create", async () => {
    const id = `cs2_${cScalarV2++}`;
    await v2.user.create({
      data: { id, name: "New", email: `${id}@x.com`, age: 20 },
    });
  });
});

describe("flip A/B: nested create (user + one post)", () => {
  bench("v1 create nested", async () => {
    const id = `cn1_${cNestV1++}`;
    await v1.user.create({
      data: {
        id,
        name: "New",
        email: `${id}@x.com`,
        posts: { create: { id: `${id}_p`, title: "T" } },
      },
    });
  });
  bench("v2 create nested", async () => {
    const id = `cn2_${cNestV2++}`;
    await v2.user.create({
      data: {
        id,
        name: "New",
        email: `${id}@x.com`,
        posts: { create: { id: `${id}_p`, title: "T" } },
      },
    });
  });
});

// T1: parent-held to-one create — post carries the FK (authorId), so `author:
// { create }` is a BEFORE-parent write (INSERT author, then INSERT post with
// authorId = author.id). The T1 absorption; A/B vs V1's staged runtime.
let phV1 = 0;
let phV2 = 0;
describe("flip A/B: parent-held to-one create (post + before-parent author)", () => {
  bench("v1 create parent-held", async () => {
    const id = `ph1_${phV1++}`;
    await v1.post.create({
      data: {
        id,
        title: "T",
        author: { create: { id: `${id}_a`, name: "A", email: `${id}@x.com` } },
      },
    });
  });
  bench("v2 create parent-held", async () => {
    const id = `ph2_${phV2++}`;
    await v2.post.create({
      data: {
        id,
        title: "T",
        author: { create: { id: `${id}_a`, name: "A", email: `${id}@x.com` } },
      },
    });
  });
});

// T2 (TO-ONE.md §7): parent-held to-one connectOrCreate under UPDATE — the gated
// residual entry. The probe finds the existing target (FOUND arm), and the root
// parent UPDATE folds authorId = the found user's id. The A/B vs V1's staged
// runtime (decision read + updateParentForeignKey). Two arms, separate DBs.
let cocV1 = 0;
let cocV2 = 0;
describe("flip A/B: parent-held connectOrCreate under update (FOUND, T2)", () => {
  bench("v1 update connectOrCreate", async () => {
    const k = cocV1++ % 200;
    await v1.post.update({
      where: { id: `p_${k}` },
      data: {
        author: {
          connectOrCreate: {
            where: { id: `u_${(k + 1) % 200}` },
            create: { id: `noop1_${k}`, name: "X", email: `noop1_${k}@x.com` },
          },
        },
      },
    });
  });
  bench("v2 update connectOrCreate", async () => {
    const k = cocV2++ % 200;
    await v2.post.update({
      where: { id: `p_${k}` },
      data: {
        author: {
          connectOrCreate: {
            where: { id: `u_${(k + 1) % 200}` },
            create: { id: `noop2_${k}`, name: "X", email: `noop2_${k}@x.com` },
          },
        },
      },
    });
  });
});
