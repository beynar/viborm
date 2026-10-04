/**
 * The soft-delete acceptance definition (extension-capabilities plan §1.1),
 * typed from public exports only.
 *
 * `viborm/soft-delete` (`src/soft-delete/index.ts`) is §1.1 token for token:
 * its two import specifiers name the files behind `viborm` and
 * `viborm/client`, and Biome lays it out. It is generic over the receiving
 * client's config and extension state and applies its two steps,
 * `controls`/`rows`/`deletion` then the `restore` methods, to that client.
 * This file is §1.1's use block plus the typing contracts the plan names for
 * M1 unit 1; `tests/contracts/public-client/soft-delete.core.test.ts` runs
 * the same use block.
 *
 * Nothing in this file is called. Only the types matter.
 */

import { MemoryCache } from "@src/cache/drivers/memory";
import { cache } from "@src/cache/exports";
import { defaultOmit } from "@src/client/exports";
import { PGliteDriver } from "@src/drivers/pglite";
import { createClient, type ExtendedOperationResult, s } from "@src/index";
import { softDelete } from "@src/soft-delete";

type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends <
    Value,
  >() => Value extends Right ? 1 : 2
    ? true
    : false;
type Expect<Value extends true> = Value;

const user = s.model({
  id: s.string().id(),
  name: s.string(),
  posts: s.toMany(() => post).name("author"),
});
const post = s.model({
  id: s.string().id(),
  title: s.string(),
  secret: s.string(),
  createdAt: s.dateTime(),
  authorId: s.string(),
  author: s
    .toOne(() => user)
    .name("author")
    .fields("authorId")
    .references("id"),
  deletedAt: s.dateTime().nullable(),
  deletedById: s.string().nullable(),
});
// No relation reaches post from here: `deleted` is still accepted (O1).
const tag = s.model({ id: s.string().id(), name: s.string() });
const schema = { user, post, tag };
type S = typeof schema;

const base = createClient({ schema, driver: new PGliteDriver() });
declare const session: { userId: string };
declare const cutoff: Date;

// §1.1 "Use", verbatim.
const db = softDelete({
  models: { post: { deletedAt: "deletedAt", deletedBy: "deletedById" } },
  actor: session.userId,
})(base);
export async function use() {
  await db.user.findMany({ include: { posts: true } }); // each user's live posts
  await db.post.findMany({ deleted: "only" }); // recycle bin
  await db.post.delete({ where: { id: "p1" } }); // tombstones p1, returns it
  await db.post.restore({ where: { id: "p1" }, select: { id: true } }); // { id }
  await db.post.deleteMany({
    where: { deletedAt: { lt: cutoff } },
    deleted: "only",
    mode: "hard",
  });
}

export async function restoreNarrows() {
  const restored = await db.post.restore({
    where: { id: "p1" },
    select: { id: true },
  });
  type _selected = Expect<Equal<typeof restored, { id: string }>>;
  const full = await db.post.restore({ where: { id: "p1" } });
  full.title satisfies string;
  full.deletedAt satisfies Date | null;
  const included = await db.post.restore({
    where: { id: "p1" },
    include: { author: true },
  });
  included.author.name satisfies string;
  const many = await db.post.restoreMany({ where: { title: "t" } });
  type _many = Expect<Equal<typeof many, { count: number }>>;
  // @ts-expect-error restore exists only on configured models
  await db.user.restore({ where: { id: "u1" } });
}

// DC3: the guard flags what the body would silently override or ignore.
export async function restoreGuard() {
  await db.post.restore({
    where: { id: "p1" },
    // @ts-expect-error restore writes its own `data`
    data: { title: "x" },
  });
  const held = { where: { id: "p1" }, wher: {} };
  // @ts-expect-error a misspelt key is flagged, held
  await db.post.restore(held);
  await db.post.restoreMany({
    where: { title: "t" },
    // @ts-expect-error restoreMany writes its own `data`
    data: { title: "x" },
  });
}

// A preceding defaultOmit's omission carries through reads and restore.
const omitted = base.$extends(defaultOmit<S>()({ post: { secret: true } }));
const dbOmitted = softDelete({ models: { post: { deletedAt: "deletedAt" } } })(
  omitted
);
export async function omissionCarries() {
  const restored = await dbOmitted.post.restore({ where: { id: "p1" } });
  // @ts-expect-error secret is omitted by the preceding defaultOmit
  restored.secret;
  restored.title satisfies string;
  const found = await dbOmitted.post.findFirst({ deleted: "with" });
  // @ts-expect-error secret is omitted on reads too
  found?.secret;
}

// DC22: a definition binds to the client it was built for. Built for `base`
// and applied to `omitted`, it compiles (model factories are bivariant so
// §1.1's step B can be generic over the client), and its result type shows
// `secret`, which the runtime omits. At `30ff17e69` this was refused (TS2345).
const builtForBase = {
  name: "built-for-base",
  model: {
    post: (delegate: (typeof base)["post"]) => ({
      firstPost: () => delegate.findFirst({ where: { id: "p1" } }),
    }),
  },
};
const replayed = omitted.$extends(builtForBase);
export async function replayCompiles() {
  const row = await replayed.post.firstPost();
  row?.secret satisfies string | undefined; // typed from base, not omitted
}

// The rows order guard: defaultOmit after softDelete is refused.
export function orderGuard() {
  // @ts-expect-error softDelete adds result-consuming methods: defaultOmit after it is refused
  db.$extends(defaultOmit<S>()({ post: { secret: true } }));
}

// Placement: `deleted` on every candidate-selecting operation of every model
// (O1); `mode` only on the deletes of the models `deletion` manages.
export async function placement() {
  await db.user.findMany({ deleted: "only" });
  await db.tag.count({ deleted: "with" });
  await db.post.update({ where: { id: "p1" }, data: {}, deleted: "only" });
  await db.post.upsert({
    where: { id: "p1" },
    create: {
      id: "p1",
      title: "t",
      secret: "s",
      createdAt: cutoff,
      authorId: "u1",
    },
    update: {},
    deleted: "with",
  });
  await db.post.delete({ where: { id: "p1" }, mode: "soft" });
  await db.tag.aggregate({ _count: true, deleted: "without" });
  await db.post.create({
    data: {
      id: "p2",
      title: "t",
      secret: "s",
      createdAt: cutoff,
      authorId: "u1",
    },
    // @ts-expect-error create selects no candidates: no rows control
    deleted: "with",
  });
  // @ts-expect-error mode is placed only on the deletes of managed models
  await db.user.delete({ where: { id: "u1" }, mode: "hard" });
  // @ts-expect-error mode is not a read control
  await db.post.findMany({ mode: "hard" });
  // @ts-expect-error mode is not an update control
  await db.post.updateMany({ data: {}, mode: "hard" });
  // @ts-expect-error the base client has no controls
  await base.post.findMany({ deleted: "with" });
  // A control's value is typed by its declaration, inline and held alike.
  // @ts-expect-error "bogus" is not a mode
  await db.post.findMany({ deleted: "bogus" });
  const heldMode = { where: { id: "p1" }, deleted: "only" } as const;
  await db.post.findMany(heldMode);
  const heldBogus = { deleted: "bogus" } as const;
  // @ts-expect-error a held value is checked too
  await db.post.findMany(heldBogus);
  await db.$transaction(async (tx) => {
    await tx.post.findMany({ deleted: "only" });
    await tx.tag.findMany({ deleted: "with" });
    // @ts-expect-error controls in a transaction follow the same placement
    await tx.user.deleteMany({ mode: "hard" });
  });
}

// Values: closed lists; a held value needs `as const`.
export async function values() {
  const held = { deleted: "only" } as const;
  await db.post.findMany(held);
  const wide = { deleted: "only" };
  // @ts-expect-error a held value without `as const` widens to string
  await db.post.findMany(wide);
  // @ts-expect-error fresh typo refused
  await db.post.findMany({ deleted: "onyl" });
  // @ts-expect-error unknown mode value
  await db.post.delete({ where: { id: "p1" }, mode: "purge" });
  // @ts-expect-error an undeclared control is an unknown key
  await db.post.findMany({ archived: true });
}

// The official cache before softDelete: its reads carry the controls, its
// `cache` stays on core mutations, and restore flags it (decided 7).
const cachedDb = softDelete({ models: { post: { deletedAt: "deletedAt" } } })(
  base.$extends(
    cache({
      driver: new MemoryCache(),
      version: "v1",
      waitUntil: (_promise) => undefined,
    })
  )
);
export async function cachedChain() {
  const rows = await cachedDb
    .$withCache()
    .post.findMany({ deleted: "only", select: { id: true } });
  type _rows = Expect<Equal<typeof rows, { id: string }[]>>;
  // @ts-expect-error cached reads follow the same values
  await cachedDb.$withCache().post.findMany({ deleted: "onyl" });
  await cachedDb.post.update({
    where: { id: "p1" },
    data: { title: "t" },
    cache: { autoInvalidate: true },
  });
  await cachedDb.post.restore({
    where: { id: "p1" },
    // @ts-expect-error restore takes the model's own update arguments only
    cache: { autoInvalidate: true },
  });
}

// `ExtendedOperationResult` reads the derived client's own config.
type OmittedRow = NonNullable<
  ExtendedOperationResult<typeof dbOmitted, "post", "findFirst", object>
>;
type _omittedRow = Expect<Equal<"secret" extends keyof OmittedRow ? 1 : 0, 0>>;
type _selectedRow = Expect<
  Equal<
    ExtendedOperationResult<
      typeof db,
      "post",
      "findMany",
      { select: { id: true } }
    >,
    { id: string }[]
  >
>;
