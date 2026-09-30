/**
 * Milestone 2 of the `rows` capability (extension-capabilities plan v3.1 §5.3,
 * v2 §3.4, ruling 1 per-target): a to-one relation whose target a client's
 * `rows` can hide reads `null` when it is hidden, so on that client it is
 * typed `| null`, required or optional, ordinary or polymorphic, in every
 * mode (`deleted: "with"` included: the type does not read the
 * call's mode). A target no `rows` entry names keeps its precise type, unless
 * it shares its shallow surface with one that does: models are compared by
 * surface, and a tie widens. A `rows` model set typed over every string hides
 * every model. A recursive slot needs nothing: it is always an optional self
 * relation (CM002), `| null` on every client. The runtime half is
 * `tests/contracts/engine/query/row-scope-behavior.ts`.
 *
 * Nothing in this file is called. Only the types matter.
 */

import { MemoryCache } from "@src/cache/drivers/memory";
import { cache } from "@src/cache/exports";
import type { VibORMClient } from "@src/client/client";
import type { OperationResult } from "@src/client/exports";
import { PGliteDriver } from "@src/drivers/pglite";
import type { ContextualExtensionDefinition } from "@src/extensions/definition";
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
  posts: s.toMany(() => post),
});
const post = s.model({
  id: s.string().id(),
  title: s.string(),
  authorId: s.string(),
  author: s
    .toOne(() => user)
    .fields("authorId")
    .references("id"),
  comments: s.toMany(() => comment),
  deletedAt: s.dateTime().nullable(),
});
const comment = s.model({
  id: s.string().id(),
  body: s.string(),
  postId: s.string(),
  // Required: the base client types it non-null.
  post: s
    .toOne(() => post)
    .fields("postId")
    .references("id"),
  shelfId: s.string(),
  shelf: s
    .toOne(() => shelf)
    .fields("shelfId")
    .references("id")
    .name("shelved"),
  crateId: s.string(),
  crate: s
    .toOne(() => crate)
    .fields("crateId")
    .references("id")
    .name("crated"),
});
// Twins: the same shallow surface. `shelf` is managed, `crate` is not, and
// the result types cannot tell them apart. Their pair names keep the base
// client's own reading of each slot precise (the static membership proof
// separates pairs by label), so the widening below is the rows context's.
const shelf = s.model({
  id: s.string().id(),
  label: s.string(),
  deletedAt: s.dateTime().nullable(),
  comments: s.toMany(() => comment).name("shelved"),
});
const crate = s.model({
  id: s.string().id(),
  label: s.string(),
  deletedAt: s.dateTime().nullable(),
  comments: s.toMany(() => comment).name("crated"),
});
const node = s.model({
  id: s.string().id(),
  parentId: s.string().nullable(),
  parent: s
    .toOne(() => node)
    .fields("parentId")
    .references("id")
    .name("tree"),
  children: s.toMany(() => node).name("tree"),
  deletedAt: s.dateTime().nullable(),
});
// Required polymorphic references: one may reach a managed post, the other
// only unmanaged models.
const badge = s.model({
  id: s.string().id(),
  subject: s.toOne({ post: () => post, user: () => user }).name("subject"),
  owner: s.toOne({ user: () => user }).name("owner"),
});
const schema = { user, post, comment, shelf, crate, node, badge };

const base = createClient({ schema, driver: new PGliteDriver() });
const db = softDelete({
  models: {
    post: { deletedAt: "deletedAt" },
    shelf: { deletedAt: "deletedAt" },
    node: { deletedAt: "deletedAt" },
  },
})(base);

type PostRow = {
  id: string;
  title: string;
  authorId: string;
  deletedAt: Date | null;
};
type UserRow = { id: string; name: string };

// Managed target: nullable on the rows client, whatever the mode; the base
// client (the negative control) keeps it required.
export async function managedTarget() {
  const rows = await db.comment.findMany({ include: { post: true } });
  type _nullable = Expect<Equal<(typeof rows)[number]["post"], PostRow | null>>;
  const all = await db.comment.findMany({
    include: { post: true },
    deleted: "with",
  });
  type _everyMode = Expect<Equal<(typeof all)[number]["post"], PostRow | null>>;
  const selected = await db.comment.findFirstOrThrow({
    select: { post: { select: { title: true } } },
  });
  type _node = Expect<Equal<typeof selected.post, { title: string } | null>>;
  const plain = await base.comment.findMany({ include: { post: true } });
  type _base = Expect<Equal<(typeof plain)[number]["post"], PostRow>>;
}

// A target no entry names, with a surface of its own, stays precise.
export async function uniqueUnmanagedTarget() {
  const rows = await db.post.findMany({ include: { author: true } });
  type _precise = Expect<Equal<(typeof rows)[number]["author"], UserRow>>;
}

// Same-shaped twins widen together: the unmanaged `crate` reads nullable.
export async function twinsWiden() {
  const rows = await db.comment.findMany({
    select: {
      shelf: { select: { id: true } },
      crate: { select: { id: true } },
    },
  });
  type _managed = Expect<
    Equal<(typeof rows)[number]["shelf"], { id: string } | null>
  >;
  type _twin = Expect<
    Equal<(typeof rows)[number]["crate"], { id: string } | null>
  >;
  const plain = await base.comment.findMany({
    select: { crate: { select: { id: true } } },
  });
  type _base = Expect<Equal<(typeof plain)[number]["crate"], { id: string }>>;
}

// A required polymorphic reference: nullable when an arm's target can be
// hidden, precise when none can.
export async function polymorphic() {
  const row = await db.badge.findFirstOrThrow({
    include: { subject: true, owner: true },
  });
  type _hideable = Expect<
    Equal<
      typeof row.subject,
      | { readonly type: "post"; readonly data: PostRow }
      | { readonly type: "user"; readonly data: UserRow }
      | null
    >
  >;
  type _precise = Expect<
    Equal<typeof row.owner, { readonly type: "user"; readonly data: UserRow }>
  >;

  const plain = await base.badge.findFirstOrThrow({
    include: { subject: true },
  });
  type _base = Expect<
    Equal<
      typeof plain.subject,
      | { readonly type: "post"; readonly data: PostRow }
      | { readonly type: "user"; readonly data: UserRow }
    >
  >;
}

// Not a pin of milestone 2, documentation of CM002: upward recursion reads
// `null` at a hidden node, and a recursive slot is an optional self relation,
// so it is already `| null` on the base client. The rows client's type is
// the base client's, exactly: nothing here depends on the rows context.
export async function recursive() {
  const recurse = {
    select: { id: true, parent: { recurse: true, select: { id: true } } },
  } as const;
  const row = await db.node.findFirstOrThrow(recurse);
  const plain = await base.node.findFirstOrThrow(recurse);
  type _nullable = Expect<Equal<null extends typeof row.parent ? 1 : 0, 1>>;
  type _nested = Expect<
    Equal<null extends NonNullable<typeof row.parent>["parent"] ? 1 : 0, 1>
  >;
  type _base = Expect<Equal<typeof row, typeof plain>>;
}

// A `rows` model set typed over every string (a definition built from a
// runtime record) hides every model rather than none: `user`, which no
// literal entry names and whose surface is its own, widens too (U6-4).
declare const everyModel: {
  readonly name: "test.every-model";
  readonly rows: {
    readonly control: "deleted";
    readonly default: "without";
    readonly models: Readonly<
      Record<string, { readonly without: Record<never, never> }>
    >;
  };
};
const wide = base.$extends(everyModel);
export async function everyStringHidesEveryModel() {
  const rows = await wide.post.findMany({ include: { author: true } });
  type _wide = Expect<Equal<(typeof rows)[number]["author"], UserRow | null>>;
}

// The cached, transaction and helper surfaces read the same context.
const cachedDb = softDelete({ models: { post: { deletedAt: "deletedAt" } } })(
  base.$extends(
    cache({
      driver: new MemoryCache(),
      version: "v1",
      waitUntil: (_promise) => undefined,
    })
  )
);
export async function sameContextEverywhere() {
  const cached = await cachedDb
    .$withCache()
    .comment.findMany({ include: { post: true } });
  type _cached = Expect<Equal<(typeof cached)[number]["post"], PostRow | null>>;
  await db.$transaction(async (tx) => {
    const rows = await tx.comment.findMany({ include: { post: true } });
    type _tx = Expect<Equal<(typeof rows)[number]["post"], PostRow | null>>;
  });
  const restored = await db.post.restore({
    where: { id: "p1" },
    include: { author: true },
  });
  restored.author satisfies UserRow;
}
type Extended = ExtendedOperationResult<
  typeof db,
  "comment",
  "findFirstOrThrow",
  { include: { post: true } }
>;
type _extended = Expect<Equal<Extended["post"], PostRow | null>>;
// Schema-only helpers stay schema-only: wrong for a rows client, documented.
type SchemaOnly = OperationResult<
  "findFirstOrThrow",
  typeof comment,
  { include: { post: true } }
>;
type _schemaOnly = Expect<Equal<SchemaOnly["post"], PostRow>>;

// A model-mapped query handler applied to a rows client reads that client's
// result context: `proceed()` says `| null` where the runtime can read null.
// On the base client it stays precise. (`rows` cannot follow such a handler,
// so no later extension changes what it sees.)
type QueryHandlers<Client> =
  Client extends VibORMClient<infer C, infer X>
    ? Exclude<
        NonNullable<ContextualExtensionDefinition<C, X>["query"]>,
        (...args: never[]) => unknown
      >
    : never;
type Proceeded<Handler extends (context: never) => unknown> = Awaited<
  ReturnType<Parameters<Handler>[0]["proceed"]>
>;
declare const onRows: NonNullable<
  NonNullable<QueryHandlers<typeof db>["comment"]>["findFirstOrThrow"]
>;
declare const onBase: NonNullable<
  NonNullable<QueryHandlers<typeof base>["comment"]>["findFirstOrThrow"]
>;
const rowsHandler = onRows<{ include: { post: true } }>;
const baseHandler = onBase<{ include: { post: true } }>;
type _handlerRows = Expect<
  Equal<Proceeded<typeof rowsHandler>["post"], PostRow | null>
>;
type _handlerBase = Expect<
  Equal<Proceeded<typeof baseHandler>["post"], PostRow>
>;
