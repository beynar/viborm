/**
 * A schema view seen from the client (`docs/architecture/schema-views-plan.md`
 * §2): its delegate has the reads alone, in every form of the delegate; its
 * JSON columns are selected and omitted whole and typed as its declared
 * query's own result for each; they are in no filter and no order.
 * Runtime twin: `tests/contracts/public-client/schema-views-behavior.ts`.
 */

import { createClient } from "@client/client";
import { PGliteDriver } from "@drivers/pglite";
import { defaults } from "@extensions/defaults";
import { extension } from "@extensions/extension";
import { s } from "@schema";
import { MemoryCache } from "@src/cache/drivers/memory";
import { cache } from "@src/cache/extension";
import type { Decimal } from "@validation/primitives/decimal-value";

type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends <
    Value,
  >() => Value extends Right ? 1 : 2
    ? true
    : false;
type Expect<Value extends true> = Value;

const author = s.model({
  id: s.string().id(),
  name: s.string(),
  balance: s.decimal({ precision: 12, scale: 2 }),
  posts: s.toMany(() => post),
});
const post = s.model({
  id: s.string().id(),
  title: s.string(),
  views: s.bigInt(),
  published: s.boolean(),
  authorId: s.string(),
  author: s
    .toOne(() => author)
    .fields("authorId")
    .references("id"),
});

const publishedPost = s.view(() => post, {
  where: { published: true },
  select: {
    id: true,
    title: true,
    views: true,
    author: { select: { name: true, balance: true } },
  },
});
const digest = s.view(() => author, {
  select: {
    name: true,
    posts: { take: 2, select: { title: true } },
    _count: true,
  },
});
const popular = s.view(() => publishedPost, {
  where: { views: { gte: 10n } },
  select: { id: true, author: true },
});

const client = createClient({
  schema: { author, post, publishedPost, digest, popular },
  driver: new PGliteDriver(),
});

// =============================================================================
// THE READ-ONLY SURFACE
// =============================================================================

type ViewDelegate = Exclude<keyof typeof client.publishedPost, `$${string}`>;
type _reads = Expect<
  Equal<
    ViewDelegate,
    | "findMany"
    | "findFirst"
    | "findFirstOrThrow"
    | "findUnique"
    | "findUniqueOrThrow"
    | "count"
    | "aggregate"
    | "groupBy"
    | "exist"
  >
>;
// A table keeps every operation.
type _table = Expect<
  Equal<"create" extends keyof typeof client.post ? true : false, true>
>;

export const _writes = () => {
  // @ts-expect-error - a view is never written
  client.publishedPost.create({ data: { id: "p", title: "t" } });
  // @ts-expect-error - nor updated
  client.publishedPost.update({ where: { id: "p" }, data: { title: "t" } });
  // @ts-expect-error - nor deleted
  client.publishedPost.deleteMany({});
  // @ts-expect-error - nor upserted
  client.publishedPost.upsert;
};

// A chain that stamps create data adds its writes to the tables only.
const stamped = client.$extends(
  extension(
    "stamps",
    defaults(() => ({ post: { create: { published: false } } }))
  )
);
export const _stampedWrites = () => {
  stamped.post.create({
    data: { id: "p", title: "t", views: 1n, authorId: "a" },
  });
  stamped.publishedPost.findMany({ where: { views: { gt: 1n } } });
  // @ts-expect-error - a view gains no write through a chain
  stamped.publishedPost.create;
};

// A transaction's view of the client, and a cached view.
export const _transaction = () =>
  client.$transaction(async (tx) => {
    await tx.publishedPost.findMany();
    // @ts-expect-error - a view is read in a transaction too
    tx.publishedPost.updateMany;
  });
const cached = client.$extends(cache({ driver: new MemoryCache() }));
export const _cached = () => cached.$withCache().publishedPost.count();

// =============================================================================
// THE JSON COLUMNS: SELECTED AND OMITTED WHOLE, TYPED AS THE QUERY'S
// =============================================================================

type Row = Awaited<ReturnType<typeof client.publishedPost.findMany>>[number];
type _defaultRow = Expect<
  Equal<
    Row,
    {
      id: string;
      title: string;
      views: bigint;
      author: { name: string; balance: Decimal };
    }
  >
>;
type _authorDocument = Expect<
  Equal<Row["author"], { name: string; balance: Decimal }>
>;

export const _selectAndOmit = async () => {
  const selected = await client.publishedPost.findMany({
    select: { id: true, author: true },
  });
  type _selected = Expect<
    Equal<
      (typeof selected)[number],
      { id: string; author: { name: string; balance: Decimal } }
    >
  >;
  const omitted = await client.publishedPost.findFirst({
    omit: { author: true },
  });
  type _omitted = Expect<
    Equal<
      NonNullable<typeof omitted>,
      { id: string; title: string; views: bigint }
    >
  >;
  const rows = await client.digest.findMany();
  type _digest = Expect<
    Equal<
      (typeof rows)[number],
      { name: string; posts: { title: string }[]; _count: { posts: number } }
    >
  >;
  const counted = await client.digest.findMany({ select: { _count: true } });
  type _counted = Expect<
    Equal<(typeof counted)[number], { _count: { posts: number } }>
  >;
  // A view over a view: the source view's column, as it holds it.
  const over = await client.popular.findMany();
  type _over = Expect<
    Equal<
      (typeof over)[number],
      { id: string; author: { name: string; balance: Decimal } }
    >
  >;
};

export const _frozenDocuments = () => {
  client.publishedPost.findMany({
    // @ts-expect-error - a JSON column takes no nested arguments
    select: { id: true, author: { select: { name: true } } },
  });
  client.publishedPost.findMany({
    // @ts-expect-error - a JSON column is in no filter
    where: { id: "p", author: { name: "Ann" } },
  });
  client.publishedPost.findMany({
    // @ts-expect-error - nor in an order
    orderBy: { id: "asc", author: "asc" },
  });
  client.publishedPost.findMany({
    // @ts-expect-error - nor in a distinct
    distinct: ["id", "author"],
  });
  client.publishedPost.groupBy({
    // @ts-expect-error - nor in a grouping
    by: ["title", "author"],
  });
  client.publishedPost.findMany({
    // @ts-expect-error - a typo beside a real column
    select: { id: true, autor: true },
  });
};

// =============================================================================
// A KEY THE VIEW PROJECTS: findUnique and cursors
// =============================================================================

export const _keyed = async () => {
  const one = await client.publishedPost.findUnique({ where: { id: "p" } });
  type _one = Expect<Equal<NonNullable<typeof one>, Row>>;
  await client.publishedPost.findMany({ cursor: { id: "p" }, take: 2 });
  await client.publishedPost.findUnique({
    // @ts-expect-error - a column that is no key addresses no row
    where: { title: "t" },
  });
};
