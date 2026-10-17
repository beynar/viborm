/**
 * K5's types (plan §4.5, §11.2 F8): a model whose `rows.verbs` declares a
 * projection key gains its row operations again as overloads that admit the
 * key in every `select` and `include` the call spells, at that model's own
 * names, and carry it in the result there; a read-gated field is a `boolean`
 * default omit: optional in a default row, present where a selection names
 * it. A call that names no key keeps its exact types.
 */

import { MemoryCache } from "@src/cache/drivers/memory";
import { cache } from "@src/cache/exports";
import { PGliteDriver } from "@src/drivers/pglite";
import { createClient, s } from "@src/index";
import { describe, expectTypeOf, test } from "vitest";

const user = s.model({
  id: s.string().id(),
  email: s.string(),
  posts: s.toMany(() => post).name("author"),
});
const post = s.model({
  id: s.string().id(),
  title: s.string(),
  secret: s.string(),
  authorId: s.string(),
  author: s
    .toOne(() => user)
    .fields("authorId")
    .references("id")
    .name("author"),
  notes: s.toMany(() => note),
});
const note = s.model({
  id: s.string().id(),
  body: s.string(),
  postId: s.string(),
  post: s
    .toOne(() => post)
    .fields("postId")
    .references("id"),
});

const base = createClient({
  schema: { user, post, note },
  driver: new PGliteDriver(),
});
const db = base.$extends({
  name: "evidence",
  rows: {
    control: "as",
    default: "all",
    models: {},
    verbs: {
      post: {
        predicates: { view: {}, edit: { title: "x" } },
        read: "view",
        evidence: { as: "$access", names: ["view", "edit"] },
        reads: { secret: "edit" },
      },
      user: {
        predicates: { view: {}, edit: {}, full: {} },
        read: "view",
        evidence: {
          as: "$access",
          names: ["view", "edit", "full"],
          ordered: true,
        },
      },
      note: { predicates: { view: {} }, read: "view" },
    },
  },
});

describe("a declared projection key", () => {
  test("reports the model's names at the root, a list its own, ordered the highest", async () => {
    const posts = await db.post.findMany({
      select: { id: true, $access: true },
    });
    expectTypeOf(posts).toEqualTypeOf<
      {
        id: string;
        readonly $access: { readonly view: boolean; readonly edit: boolean };
      }[]
    >();
    const one = await db.post.findUnique({
      where: { id: "p" },
      select: { id: true, $access: ["edit"] },
    });
    expectTypeOf(one!.$access).toEqualTypeOf<{ readonly edit: boolean }>();
    const users = await db.user.findMany({
      select: { id: true, $access: true },
    });
    expectTypeOf(users[0]!.$access).toEqualTypeOf<
      "view" | "edit" | "full" | null
    >();
  });

  test("is admitted at every depth, at the target's own names", async () => {
    const users = await db.user.findMany({
      include: {
        $access: true,
        posts: { select: { id: true, $access: ["view"] } },
      },
    });
    expectTypeOf(users[0]!.posts[0]!.$access).toEqualTypeOf<{
      readonly view: boolean;
    }>();
    expectTypeOf(users[0]!.email).toEqualTypeOf<string>();
    const posts = await db.post.findMany({
      include: { author: { include: { $access: true } } },
    });
    // A to-one onto a model a `rows` member names may read hidden: `null`.
    expectTypeOf(posts[0]!.author!.$access).toEqualTypeOf<
      "view" | "edit" | "full" | null
    >();
  });

  test("rides a write's result", async () => {
    const updated = await db.post.update({
      where: { id: "p" },
      data: { title: "t" },
      select: { id: true, $access: true },
    });
    expectTypeOf(updated.$access.edit).toEqualTypeOf<boolean>();
  });

  test("a call naming no key keeps the base client's types", async () => {
    const plain = await db.note.findMany({ select: { id: true } });
    expectTypeOf(plain).toEqualTypeOf<
      Awaited<ReturnType<typeof base.note.findMany<{ select: { id: true } }>>>
    >();
  });

  test("is refused misspelt, at a name the model does not declare, and on a model that declares none", () => {
    // @ts-expect-error - `$acess` is no key of post
    db.post.findMany({ select: { id: true, $acess: true } });
    // @ts-expect-error - `full` is not one of post's names
    db.post.findMany({ select: { $access: ["full"] } });
    // @ts-expect-error - note declares no key
    db.post.findMany({ include: { notes: { select: { $access: true } } } });
    // @ts-expect-error - the base client declares none
    base.post.findMany({ select: { id: true, $access: true } });
  });
});

describe("a read-gated field", () => {
  test("is optional in a default row and present where a selection names it", async () => {
    const rows = await db.post.findMany();
    expectTypeOf(rows[0]!.secret).toEqualTypeOf<string | undefined>();
    expectTypeOf(rows[0]!.title).toEqualTypeOf<string>();
    const selected = await db.post.findMany({
      select: { id: true, secret: true },
    });
    expectTypeOf(selected[0]!.secret).toEqualTypeOf<string>();
    const restored = await db.post.findMany({ omit: { secret: false } });
    expectTypeOf(restored[0]!.secret).toEqualTypeOf<string>();
    const nested = await db.user.findMany({ include: { posts: true } });
    expectTypeOf(nested[0]!.posts[0]!.secret).toEqualTypeOf<
      string | undefined
    >();
  });
});

/** A second projection on the same model must not erase the first in a cache view. */
test("cached views preserve two projection keys and exact nested results", () => {
  const composed = db
    .$extends({
      name: "review-evidence",
      rows: {
        control: "reviewMode",
        default: "all",
        models: {},
        verbs: {
          post: {
            predicates: { draft: {}, published: { title: "published" } },
            read: "draft",
            evidence: { as: "$review", names: ["draft", "published"] },
          },
          user: {
            predicates: { contact: {} },
            read: "contact",
            evidence: { as: "$review", names: ["contact"] },
          },
        },
      },
    })
    .$extends(cache({ driver: new MemoryCache() }));
  const cached = composed.$withCache();
  const access = cached.post.findMany({
    select: { id: true, $access: ["edit"] },
  });
  expectTypeOf(access).toEqualTypeOf<
    Promise<{ id: string; readonly $access: { readonly edit: boolean } }[]>
  >();
  const review = cached.post.findMany({
    select: { id: true, $review: ["published"] },
  });
  expectTypeOf(review).toEqualTypeOf<
    Promise<{ id: string; readonly $review: { readonly published: boolean } }[]>
  >();
  const nested = cached.post.findMany({
    select: { author: { select: { id: true, $review: ["contact"] } } },
  });
  expectTypeOf(nested).toEqualTypeOf<
    Promise<
      {
        author: {
          id: string;
          readonly $review: { readonly contact: boolean };
        } | null;
      }[]
    >
  >();
  const ordered = cached.user.findMany({ select: { $access: true } });
  expectTypeOf(ordered).toEqualTypeOf<
    Promise<{ readonly $access: "view" | "edit" | "full" | null }[]>
  >();
  // @ts-expect-error - each projection retains its own permission vocabulary
  cached.post.findMany({ select: { $review: ["edit"] } });
  cached.post.findMany({
    // @ts-expect-error - a related projection uses the target's vocabulary
    include: { author: { select: { $review: ["published"] } } },
  });
  // @ts-expect-error - cached projected reads are not batchable pending operations
  composed.$transaction([review]);
  // @ts-expect-error - projection metadata does not add cached mutation methods
  cached.post.update({ where: { id: "p" }, data: { title: "changed" } });
});
