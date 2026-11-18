/**
 * A schema view seen from the client (`docs/architecture/schema-views-plan.md`
 * §2): its delegate has the reads alone, in every form of the delegate; its
 * JSON columns are selected and omitted whole and typed as its declared
 * query's own result for each; they are in no filter and no order.
 * Runtime twin: `tests/contracts/public-client/schema-views-behavior.ts`.
 */

import { createClient } from "@client/client";
import type { InferDatabase, OperationResult } from "@client/types";
import { PGliteDriver } from "@drivers/pglite";
import { defaults } from "@extensions/defaults";
import { extension } from "@extensions/extension";
import { fields } from "@extensions/fields";
import { s } from "@schema";
import { MemoryCache } from "@src/cache/drivers/memory";
import { cache } from "@src/cache/extension";
import { ordering } from "@src/ordering";
import { softDelete } from "@src/soft-delete";
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
  deletedAt: s.dateTime().nullable(),
  authorId: s.string(),
  author: s
    .toOne(() => author)
    .fields("authorId")
    .references("id"),
});
/** A model with no to-many relation: a `_count` on it counts nothing. */
const tag = s.model({ id: s.string().id(), label: s.string() });

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
/** No key of its source projected. */
const headlines = s.view(() => post, {
  select: { title: true, deletedAt: true },
});
const labels = s.view(() => tag, { select: { label: true, _count: true } });
const uncounted = s.view(() => author, {
  select: { name: true, _count: { select: {} } },
});
const counted = s.view(() => author, {
  select: { id: true, _count: { select: { posts: true } } },
});
const tagged = s.view(() => tag, { include: { _count: true } });
const overDigest = s.view(() => digest, {
  select: { name: true, _count: true },
});
const overPopular = s.view(() => popular, {
  select: { id: true, _count: true },
});

const schema = {
  author,
  post,
  tag,
  publishedPost,
  digest,
  popular,
  headlines,
  labels,
  uncounted,
  counted,
  tagged,
  overDigest,
  overPopular,
};
const client = createClient({ schema, driver: new PGliteDriver() });

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

// =============================================================================
// A VIEW WITHOUT A KEY: no unique read, in every form of the delegate
// =============================================================================

type _keylessReads = Expect<
  Equal<
    Exclude<keyof typeof client.headlines, `$${string}`>,
    | "findMany"
    | "findFirst"
    | "findFirstOrThrow"
    | "count"
    | "aggregate"
    | "groupBy"
    | "exist"
  >
>;
// A view of a view keeps the key its source view projects.
type _keyedOver = Expect<
  Equal<"findUnique" extends keyof typeof client.popular ? true : false, true>
>;

const computed = client.$extends(
  extension(
    "computed",
    fields({
      publishedPost: {
        byline: {
          needs: { title: true, author: true },
          compute(row) {
            // What `compute` reads of a view: its JSON columns too.
            type _row = Expect<
              Equal<
                typeof row,
                { title: string; author: { name: string; balance: Decimal } }
              >
            >;
            return `${row.title} (${row.author.name})`;
          },
        },
      },
    })
  )
);

export const _keylessForms = () => {
  // @ts-expect-error - no key names one of its rows
  client.headlines.findUnique;
  // @ts-expect-error - nor throws for one
  client.headlines.findUniqueOrThrow;
  // @ts-expect-error - nor through a chain
  stamped.headlines.findUnique;
  // @ts-expect-error - nor through a chain that computes fields
  computed.headlines.findUniqueOrThrow;
  // @ts-expect-error - nor through the cache
  cached.$withCache().headlines.findUnique;
  // A view that projects its source's key keeps them in every form.
  stamped.publishedPost.findUnique({ where: { id: "p" } });
  computed.publishedPost.findUniqueOrThrow({ where: { id: "p" } });
  cached.$withCache().publishedPost.findUnique({ where: { id: "p" } });
  return client.$transaction(async (tx) => {
    await tx.headlines.findFirst();
    // @ts-expect-error - nor in a transaction
    tx.headlines.findUnique;
    await tx.publishedPost.findUnique({ where: { id: "p" } });
  });
};

// =============================================================================
// EXTENSION METHODS THAT WRITE ARE NO VIEW'S
// =============================================================================

const tombs = client.$extends(
  softDelete({
    models: {
      post: { deletedAt: "deletedAt" },
      headlines: { deletedAt: "deletedAt" },
    },
  })
);
const ranked = client.$extends(
  ordering({ models: { post: { key: "title" }, headlines: { key: "title" } } })
);

export const _extensionMethods = async () => {
  // The view is read through the extensions that list it.
  await tombs.headlines.findMany({ deleted: "with" });
  await ranked.headlines.findMany();
  // A table keeps every method.
  tombs.post.restore({ where: { id: "p" } });
  ranked.post.move({ where: { id: "p" }, after: { id: "q" } });
  // @ts-expect-error - restore writes
  tombs.headlines.restore;
  // @ts-expect-error - restoreMany writes
  tombs.headlines.restoreMany;
  // @ts-expect-error - purge writes
  tombs.headlines.purge;
  // @ts-expect-error - purgeMany writes
  tombs.headlines.purgeMany;
  // @ts-expect-error - move writes
  ranked.headlines.move;
  // @ts-expect-error - rekey writes
  ranked.headlines.rekey;
};

// =============================================================================
// _count: A COLUMN ONLY WHERE IT COUNTS A RELATION
// =============================================================================

type RowOf<Delegate extends { findMany: (...args: never[]) => unknown }> =
  Awaited<ReturnType<Delegate["findMany"]>> extends readonly (infer Each)[]
    ? Each
    : never;

// `true` on a source without a to-many relation counts nothing.
type _labels = Expect<Equal<RowOf<typeof client.labels>, { label: string }>>;
// Nor does a `select` that names no relation.
type _uncounted = Expect<
  Equal<RowOf<typeof client.uncounted>, { name: string }>
>;
// Nor an included `_count` on such a source.
type _tagged = Expect<
  Equal<RowOf<typeof client.tagged>, { id: string; label: string }>
>;
// A `select` naming a relation is one.
type _counted = Expect<
  Equal<RowOf<typeof client.counted>, { id: string; _count: { posts: number } }>
>;
// A source view's `_count` column is kept as its other columns are.
type _overDigest = Expect<
  Equal<
    RowOf<typeof client.overDigest>,
    { name: string; _count: { posts: number } }
  >
>;
// A source view without one gives none.
type _overPopular = Expect<
  Equal<RowOf<typeof client.overPopular>, { id: string }>
>;

export const _countColumn = async () => {
  // Switched off as any column is.
  const off = await client.digest.findMany({
    select: { name: true, _count: false },
  });
  type _off = Expect<Equal<(typeof off)[number], { name: string }>>;
  const omitted = await client.digest.findMany({ omit: { _count: true } });
  type _omitted = Expect<
    Equal<
      (typeof omitted)[number],
      { name: string; posts: { title: string }[] }
    >
  >;
  client.labels.findMany({
    // @ts-expect-error - a view without the column has none to omit
    omit: { label: false, _count: true },
  });
};

// =============================================================================
// THE SCHEMA-ONLY TYPES CARRY A VIEW'S JSON COLUMNS
// =============================================================================

type _operationResult = Expect<
  Equal<
    OperationResult<"findMany", typeof publishedPost, Record<never, never>>,
    Row[]
  >
>;
type _databaseRow = Expect<
  Equal<InferDatabase<typeof schema>["publishedPost"]["Row"], Row>
>;

// =============================================================================
// OMIT BESIDE SELECT: WHAT OMIT NAMES IS NO COLUMN OF THE VIEW
// =============================================================================

const trimmed = s.view(() => post, {
  select: { id: true, title: true, author: { select: { name: true } } },
  omit: { id: true },
});
const trimmedOver = s.view(() => trimmed, {
  select: { title: true, author: true },
  omit: { author: true },
});
type _trimmedRow = Expect<
  Equal<
    OperationResult<"findMany", typeof trimmed, Record<never, never>>,
    { title: string; author: { name: string } }[]
  >
>;
type _trimmedOverRow = Expect<
  Equal<
    OperationResult<"findMany", typeof trimmedOver, Record<never, never>>,
    { title: string }[]
  >
>;
/** The omitted key was the view's only key: it has no unique read. */
const trimmedClient = createClient({
  schema: { author, post, trimmed },
  driver: new PGliteDriver(),
});
type _trimmedKeyless = Expect<
  Equal<
    "findUnique" extends keyof typeof trimmedClient.trimmed ? true : false,
    false
  >
>;
