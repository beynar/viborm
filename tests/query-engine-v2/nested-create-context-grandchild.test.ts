import { createClient } from "@client/client";
import type { BatchQuery, QueryResult } from "@drivers";
import { PGliteDriver } from "@drivers/pglite";
import { PGlite, type Transaction } from "@electric-sql/pglite";
import { push } from "@migrations";
import { s } from "@schema";
import { describe, expect, test } from "vitest";
import { createV2RoutedClient } from "./v2-client-proxy";

/**
 * T4a CLASS VI — deep create-context grandchildren (the three absorbed blast-radius keys).
 *
 * A nested `create` whose FK carries a parent id one step past the literal-parent reach:
 *   · KEY 1 — a `create` under a PARENT-HELD to-one `update` target located by a PLANNED id
 *             (`post.update → author.update → posts.create`). The target (the author) is
 *             read by this operation's own locate probe; the grandchild post's FK inlines
 *             the located author's captured PK at compile (ATOM §9 inv. 2 — a literal, not a
 *             SQL Ref). Compiled by the shared fresh-record path.
 *   · KEY 2 — a `create` on the UPDATE arm of a to-many upsert, correlated to the found
 *             row's compile-time literal PK (`user.update → posts.upsert(update) →
 *             comments.create`). Absorbed by `RelationUpsertPart` accepting a child-held
 *             create on BOTH arms.
 *   · KEY 3 — a root-`create` nested `createMany skipDuplicates` whose child FK refs the
 *             fresh parent's produced id (`parent.create → children.createMany`). Absorbed
 *             by `CreateOperation.foldCreateMany` composing `buildCreateManyPlan`'s skip.
 *
 * Each is a full dual-run oracle: V1 vs V2-tx vs V2-batch, byte-identical final state, and
 * the routed engine is V2 (a NATIVE execution, not a silent V1 fallback). Keys 1 and 2
 * carry a multi-parent witness at the GRANDCHILD level — a disjoint second parent whose
 * subtree must stay untouched, which is exactly what would break if the captured FK were
 * mis-threaded (inject the wrong parent id and the grandchild lands under the disjoint
 * parent, diverging from V1). That is the standing falsification: the multi-parent
 * assertion is the guard that the FK threading is load-bearing and correct.
 */

const blogSchema = (() => {
  const user = s
    .model({
      id: s.string().id(),
      name: s.string(),
      posts: s.oneToMany(() => post),
    })
    .map("ccg_users");
  const post = s
    .model({
      id: s.string().id(),
      title: s.string(),
      userId: s.string().nullable(),
      author: s
        .manyToOne(() => user)
        .fields("userId")
        .references("id"),
      comments: s.oneToMany(() => comment),
    })
    .map("ccg_posts");
  const comment = s
    .model({
      id: s.string().id(),
      body: s.string(),
      postId: s.string().nullable(),
      post: s
        .manyToOne(() => post)
        .fields("postId")
        .references("id"),
    })
    .map("ccg_comments");
  return { user, post, comment };
})();

const bulkSchema = (() => {
  const parent = s
    .model({
      id: s.int().id().increment(),
      name: s.string(),
      children: s.oneToMany(() => child),
    })
    .map("ccg_parents");
  const child = s
    .model({
      id: s.int().id().increment(),
      code: s.string().unique(),
      label: s.string(),
      parentId: s.int().nullable(),
      parent: s
        .manyToOne(() => parent)
        .fields("parentId")
        .references("id"),
    })
    .map("ccg_children");
  return { parent, child };
})();

class BatchOnlyPGliteDriver extends PGliteDriver {
  override readonly supportsTransactions = false;
  override readonly supportsBatch = true;
  protected override async executeBatch<T>(
    client: PGlite | Transaction,
    queries: BatchQuery[]
  ): Promise<QueryResult<T>[]> {
    return this.transaction(client, async (transaction) => {
      const results: QueryResult<T>[] = [];
      for (const query of queries) {
        results.push(
          await this.executeRaw<T>(transaction, query.sql, query.params)
        );
      }
      return results;
    });
  }
}

type Schema = Record<string, ReturnType<typeof s.model>>;

function makeV1Client(schema: Schema, db: PGlite) {
  return createClient({
    schema: schema as never,
    driver: new PGliteDriver({ client: db }),
  });
}
type AnyClient = ReturnType<typeof makeV1Client>;

async function runV1(
  schema: Schema,
  seed: (c: AnyClient) => Promise<void>,
  op: (c: AnyClient) => Promise<void>,
  snap: (c: AnyClient) => Promise<unknown>
): Promise<unknown> {
  const db = new PGlite();
  const client = makeV1Client(schema, db);
  await push(client as never, { force: true });
  await seed(client);
  await op(client);
  const state = await snap(client);
  await client.$disconnect();
  return state;
}

async function runV2(
  schema: Schema,
  substrate: "tx" | "batch",
  seed: (c: AnyClient) => Promise<void>,
  op: (c: Record<string, any>) => Promise<void>,
  snap: (c: AnyClient) => Promise<unknown>
): Promise<{ state: unknown; engines: Set<"v1" | "v2"> }> {
  const db = new PGlite();
  const fallback = makeV1Client(schema, db);
  await push(fallback as never, { force: true });
  await seed(fallback);
  const driver =
    substrate === "tx"
      ? new PGliteDriver({ client: db })
      : new BatchOnlyPGliteDriver({ client: db });
  const routed = createV2RoutedClient({
    schema: schema as never,
    client: fallback as unknown as Record<string, any>,
    driver,
  });
  await op(routed.client);
  const state = await snap(fallback);
  await fallback.$disconnect();
  return { state, engines: new Set(routed.routes.map((r) => r.engine)) };
}

// KEY 1 — a create under a parent-held (planned) to-one update target.
describe("CLASS VI key 1 — create under a parent-held (planned) update target", () => {
  const seed = async (c: AnyClient) => {
    const client = c as any;
    await client.user.create({ data: { id: "u1", name: "Alice" } });
    await client.post.create({
      data: { id: "p1", title: "root", userId: "u1" },
    });
    // A disjoint author + post — the multi-parent grandchild witness: it must stay
    // untouched, and the created grandchild must land under u1 (p1's author), not u2.
    await client.user.create({ data: { id: "u2", name: "Bob" } });
    await client.post.create({
      data: { id: "p9", title: "other", userId: "u2" },
    });
  };
  const op = async (c: Record<string, any>) => {
    await c.post.update({
      where: { id: "p1" },
      data: {
        author: {
          update: { posts: { create: { id: "p2", title: "grandchild" } } },
        },
      },
    });
  };
  const snap = async (c: AnyClient) => {
    const posts = await (c as any).post.findMany({ orderBy: { id: "asc" } });
    return posts.map((p: any) => [p.id, p.userId]);
  };

  test("dual-run oracle (v1 vs v2-tx vs v2-batch) + grandchild attaches to the located author", async () => {
    const v1 = await runV1(blogSchema, seed, op as never, snap);
    // p2 created under u1; the disjoint u2/p9 untouched.
    expect(v1).toEqual([
      ["p1", "u1"],
      ["p2", "u1"],
      ["p9", "u2"],
    ]);
    for (const substrate of ["tx", "batch"] as const) {
      const { state, engines } = await runV2(
        blogSchema,
        substrate,
        seed,
        op,
        snap
      );
      expect(engines).toEqual(new Set(["v2"]));
      expect(state).toEqual(v1);
    }
  });
});

// KEY 2 — a create on the update arm of a to-many upsert (literal parent).
describe("CLASS VI key 2 — create on the update arm of a nested upsert", () => {
  const seed = async (c: AnyClient) => {
    const client = c as any;
    await client.user.create({ data: { id: "u1", name: "Alice" } });
    await client.post.create({
      data: { id: "p1", title: "target", userId: "u1" },
    });
    // A disjoint sibling post under the SAME user — the grandchild must land under p1
    // (the upsert-located row), never p2 (multi-parent witness at the grandchild level).
    await client.post.create({
      data: { id: "p2", title: "sibling", userId: "u1" },
    });
  };
  const op = async (c: Record<string, any>) => {
    await c.user.update({
      where: { id: "u1" },
      data: {
        posts: {
          upsert: {
            where: { id: "p1" },
            create: { id: "p1", title: "unused" },
            update: {
              comments: { create: { id: "c1", body: "from update arm" } },
            },
          },
        },
      },
    });
  };
  const snap = async (c: AnyClient) => {
    const comments = await (c as any).comment.findMany({
      orderBy: { id: "asc" },
    });
    return comments.map((m: any) => [m.id, m.postId]);
  };

  test("dual-run oracle (v1 vs v2-tx vs v2-batch) + grandchild attaches to the found post", async () => {
    const v1 = await runV1(blogSchema, seed, op as never, snap);
    expect(v1).toEqual([["c1", "p1"]]);
    for (const substrate of ["tx", "batch"] as const) {
      const { state, engines } = await runV2(
        blogSchema,
        substrate,
        seed,
        op,
        snap
      );
      expect(engines).toEqual(new Set(["v2"]));
      expect(state).toEqual(v1);
    }
  });
});

// KEY 3 — a root-create nested createMany skipDuplicates (create-context ref parent).
describe("CLASS VI key 3 — root-create nested createMany skipDuplicates", () => {
  const seed = async () => {
    // no seed — the parent is freshly created by the op.
  };
  const op = async (c: Record<string, any>) => {
    await c.parent.create({
      data: {
        name: "parent",
        children: {
          createMany: {
            data: [
              { code: "unrelated", label: "generated-first" },
              { id: 50, code: "winner", label: "input-first" },
              { code: "winner", label: "must-skip" },
            ],
            skipDuplicates: true,
          },
        },
      },
    });
  };
  const snap = async (c: AnyClient) => {
    const children = await (c as any).child.findMany({
      orderBy: { id: "asc" },
    });
    // Every child's FK points at the one fresh parent; the winner keeps its input-first id.
    return children.map((row: any) => [
      row.code,
      row.label,
      row.parentId !== null,
    ]);
  };

  test("dual-run oracle (v1 vs v2-tx vs v2-batch) + skip keeps input-first winner", async () => {
    const v1 = (await runV1(bulkSchema, seed, op as never, snap)) as unknown[];
    // Two children survive (the second "winner" is skipped); both carry the parent FK.
    expect(v1).toHaveLength(2);
    expect(v1).toContainEqual(["unrelated", "generated-first", true]);
    expect(v1).toContainEqual(["winner", "input-first", true]);
    for (const substrate of ["tx", "batch"] as const) {
      const { state, engines } = await runV2(
        bulkSchema,
        substrate,
        seed,
        op,
        snap
      );
      expect(engines).toEqual(new Set(["v2"]));
      expect(state).toEqual(v1);
    }
  });
});
