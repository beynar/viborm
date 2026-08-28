/**
 * PLAN P5 item 4 — the default-flip benchmark, now single-armed.
 *
 * It was an A/B: the `queryEngine: "v1" | "v2"` escape hatch ran identical
 * workloads through the frozen V1 runtime and the flipped V2 engine. V1 and the
 * hatch were deleted at P6, so the second arm no longer exists — the recorded
 * V2/V1 ratios live in `docs/architecture/engine-unification/PERF.md` and stay
 * there as history. What remains here is a standing cost baseline for the one
 * engine. (The `queryEngine` key outlived the option it named and was silently
 * ignored, so both arms had been measuring V2 against V2; the client config now
 * refuses a key it does not read.)
 *
 * Run: pnpm bench -- benchmarks/p5-flip-ab.bench.ts
 */
import { createClient } from "@client/client";
import { SQLite3Driver } from "@drivers/sqlite3";
import { push } from "@migrations";
import { s } from "@schema";
import { bench, describe } from "vitest";
import { sqliteUserPostSchema } from "../tests/fixtures/user-post-schema";

const makeClient = async () => {
  const driver = new SQLite3Driver({ dataDir: ":memory:" });
  const client = createClient({
    schema: sqliteUserPostSchema,
    driver,
  });
  await push(client);
  for (let i = 0; i < 200; i++) {
    await driver._executeRaw(
      'INSERT INTO "users" ("id", "name", "email", "age") VALUES (?, ?, ?, ?)',
      [`u_${i}`, `User ${i}`, `u${i}@example.com`, 30]
    );
  }
  // Posts for the T2 update-root to-one case (parent-held connectOrCreate
  // under update): each post p_i starts owned by u_i.
  for (let i = 0; i < 200; i++) {
    await driver._executeRaw(
      'INSERT INTO "posts" ("id", "title", "content", "published", "views", "authorId") VALUES (?, ?, ?, ?, ?, ?)',
      [`p_${i}`, `Post ${i}`, null, 0, 0, `u_${i}`]
    );
  }
  return client;
};

const client = await makeClient();
let n = 0;

describe("flip: findMany", () => {
  bench("findMany", async () => {
    await client.user.findMany({ take: 50 });
  });
});

describe("flip: findUnique", () => {
  bench("findUnique", async () => {
    await client.user.findUnique({ where: { id: `u_${n++ % 200}` } });
  });
});

describe("flip: scalar update", () => {
  bench("update", async () => {
    await client.user.update({
      where: { id: `u_${n++ % 200}` },
      data: { age: (n % 40) + 18 },
    });
  });
});

describe("flip: updateMany", () => {
  bench("updateMany", async () => {
    await client.user.updateMany({
      where: { age: { gte: 0 } },
      data: { age: (n++ % 40) + 18 },
    });
  });
});

describe("flip: upsert (update branch)", () => {
  bench("upsert", async () => {
    await client.user.upsert({
      where: { id: `u_${n++ % 200}` },
      create: { id: "unused", name: "x", email: "x@x.com", age: 1 },
      update: { age: (n % 40) + 18 },
    });
  });
});

// T3a family A — the FK-holder-side (parent-held) to-one `update` under an update
// root: `post.update({ author: { update } })` locates the referenced user through
// the post's own authorId and mutates it. Absorbed by T3a (it was a whole-tree
// route to V1); this measures the cost of the newly-native path.
describe("flip: parent-held to-one update (family A)", () => {
  bench("parent-held to-one update", async () => {
    await client.post.update({
      where: { id: `p_${n++ % 200}` },
      data: { author: { update: { name: `PH ${n}` } } },
    });
  });
});

// The create family (P6-prerequisite). A unique id per call so each INSERT is a
// fresh row, never a PK collision. The nested create exercises the
// child-held-FK fold.
let cScalar = 0;
let cNest = 0;

describe("flip: scalar create", () => {
  bench("create", async () => {
    const id = `cs_${cScalar++}`;
    await client.user.create({
      data: { id, name: "New", email: `${id}@x.com`, age: 20 },
    });
  });
});

describe("flip: nested create (user + one post)", () => {
  bench("create nested", async () => {
    const id = `cn_${cNest++}`;
    await client.user.create({
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
// authorId = author.id). The T1 absorption.
let ph = 0;
describe("flip: parent-held to-one create (post + before-parent author)", () => {
  bench("create parent-held", async () => {
    const id = `ph_${ph++}`;
    await client.post.create({
      data: {
        id,
        title: "T",
        author: { create: { id: `${id}_a`, name: "A", email: `${id}@x.com` } },
      },
    });
  });
});

// T2: parent-held to-one connectOrCreate under UPDATE — the gated
// residual entry. The probe finds the existing target (FOUND arm), and the root
// parent UPDATE folds authorId = the found user's id (one decision read plus
// updateParentForeignKey).
let coc = 0;
describe("flip: parent-held connectOrCreate under update (FOUND, T2)", () => {
  bench("update connectOrCreate", async () => {
    const k = coc++ % 200;
    await client.post.update({
      where: { id: `p_${k}` },
      data: {
        author: {
          connectOrCreate: {
            where: { id: `u_${(k + 1) % 200}` },
            create: { id: `noop_${k}`, name: "X", email: `noop_${k}@x.com` },
          },
        },
      },
    });
  });
});

// T3b-1 family B, mechanism 1 — the deep tree. A nested to-many
// `update` whose located target carries its own relation write: the child builds
// its own child Parts (a self-m2m junction update), correlated to its literal PK.
// Idempotent (the friend's label is re-set), so it runs against a fixed seed.
const membershipSchema = (() => {
  const node = s
    .model({
      id: s.int().id(),
      label: s.string(),
      parentId: s.int().nullable(),
      parent: s
        .toOne(() => node)
        .fields("parentId")
        .references("id")
        .name("bParent"),
      children: s.toMany(() => node).name("bParent"),
      friends: s
        .toMany(() => node)
        .name("bFriends")
        .source("bSourceId")
        .target("bTargetId"),
      friendedBy: s.toMany(() => node).name("bFriends"),
    })
    .map("bench_membership_nodes");
  return { node };
})();

const makeMembershipClient = async () => {
  const driver = new SQLite3Driver({ dataDir: ":memory:" });
  const client = createClient({
    schema: membershipSchema,
    driver,
  });
  await push(client);
  // Root 1 → child 2 → friend 3 (child 2 connected to friend 3).
  await client.node.create({ data: { id: 1, label: "root" } });
  await client.node.create({ data: { id: 3, label: "friend" } });
  await client.node.create({ data: { id: 2, label: "child", parentId: 1 } });
  await client.node.update({
    where: { id: 2 },
    data: { friends: { connect: { id: 3 } } },
  });
  return client;
};

const membershipClient = await makeMembershipClient();
let bN = 0;

describe("flip: family-B deep tree (nested to-many update → self-m2m junction update)", () => {
  bench("nested update > junction update", async () => {
    await membershipClient.node.update({
      where: { id: 1 },
      data: {
        children: {
          update: {
            where: { id: 2 },
            data: {
              friends: {
                update: { where: { id: 3 }, data: { label: `f${bN++}` } },
              },
            },
          },
        },
      },
    });
  });
});
