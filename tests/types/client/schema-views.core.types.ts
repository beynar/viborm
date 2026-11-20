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
  // A stored `_count` counts nothing at read time: read whole, by a boolean,
  // under `include` as under `select`.
  const included = await client.digest.findMany({ include: { _count: true } });
  type _included = Expect<
    Equal<(typeof included)[number]["_count"], { posts: number }>
  >;
  client.digest.findMany({
    include: {
      // @ts-expect-error - a stored `_count` takes no arguments
      _count: { select: { posts: { where: { name: "x" } } } },
    },
  });
  client.digest.findMany({
    // @ts-expect-error - nor under `select`
    select: { _count: { select: { posts: true } } },
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

// =============================================================================
// INHERITED RELATIONS: A VIEW READS ITS SOURCE'S WHERE IT KEEPS THEIR KEYS
// =============================================================================

const owner = s.model({
  id: s.string().id(),
  name: s.string(),
  items: s.toMany(() => item),
  watched: s.toMany(() => item).name("watcher"),
});
const item = s.model({
  id: s.string().id(),
  title: s.string(),
  live: s.boolean(),
  ownerId: s.string(),
  watcherId: s.string().nullable(),
  owner: s
    .toOne(() => owner)
    .fields("ownerId")
    .references("id"),
  watcher: s
    .toOne(() => owner)
    .name("watcher")
    .fields("watcherId")
    .references("id"),
  reviews: s.toMany(() => review),
  badges: s.toMany(() => badge),
});
const review = s.model({
  id: s.string().id(),
  stars: s.int(),
  itemId: s.string(),
  item: s
    .toOne(() => item)
    .fields("itemId")
    .references("id"),
});
const badge = s.model({
  id: s.string().id(),
  label: s.string(),
  items: s.toMany(() => item),
});
/** Every key column kept: a foreign key, a to-many and a junction. */
const liveItems = s.view(() => item, {
  where: { live: true },
  select: { id: true, title: true, ownerId: true, watcherId: true },
});
/** No `id`: neither the to-many nor the junction, which join on it. */
const itemTitles = s.view(() => item, {
  select: { title: true, ownerId: true },
});
/** A JSON column named `owner` takes the name: that relation is not inherited. */
const ownedItems = s.view(() => item, {
  select: { id: true, ownerId: true, owner: { select: { name: true } } },
});
/** A view of reviews keeping `itemId`: its to-one is the table's. */
const scores = s.view(() => review, { select: { id: true, itemId: true } });
/** A view of a view inherits what its source inherits, where it keeps it. */
const liveIds = s.view(() => liveItems, { select: { id: true } });

const related = createClient({
  schema: {
    owner,
    item,
    review,
    badge,
    liveItems,
    itemTitles,
    ownedItems,
    liveIds,
    scores,
  },
  driver: new PGliteDriver(),
});
type RelationsOf<M> = M extends {
  readonly "~": { readonly state: { readonly relations: infer R } };
}
  ? keyof R
  : never;

type _liveRelations = Expect<
  Equal<
    RelationsOf<typeof liveItems>,
    "owner" | "watcher" | "reviews" | "badges"
  >
>;
type _titlesRelations = Expect<Equal<RelationsOf<typeof itemTitles>, "owner">>;
type _ownedRelations = Expect<
  Equal<RelationsOf<typeof ownedItems>, "reviews" | "badges">
>;
type _overRelations = Expect<
  Equal<RelationsOf<typeof liveIds>, "reviews" | "badges">
>;

export const _inheritedReads = async () => {
  const rows = await related.liveItems.findMany({
    where: {
      owner: { name: "Ann" },
      watcher: null,
      reviews: { some: { stars: { gte: 4 } } },
      badges: { none: { label: "spam" } },
    },
    orderBy: [{ owner: { name: "asc" } }, { reviews: { _count: "desc" } }],
    include: {
      owner: true,
      watcher: { select: { name: true } },
      reviews: { where: { stars: 5 }, take: 2 },
      badges: true,
      _count: true,
    },
  });
  type Row = (typeof rows)[number];
  // Read as the source reads them, nullability included.
  const tableRows = await related.item.findMany({
    include: { owner: true, watcher: { select: { name: true } } },
  });
  type TableRow = (typeof tableRows)[number];
  type _owner = Expect<Equal<Row["owner"], TableRow["owner"]>>;
  const scored = await related.scores.findMany({ include: { item: true } });
  const reviewed = await related.review.findMany({ include: { item: true } });
  type _item = Expect<
    Equal<(typeof scored)[number]["item"], (typeof reviewed)[number]["item"]>
  >;
  // A required foreign key's row is there.
  type _itemThere = Expect<
    Equal<null extends (typeof scored)[number]["item"] ? true : false, false>
  >;
  type _watcher = Expect<Equal<Row["watcher"], { name: string } | null>>;
  type _reviews = Expect<
    Equal<Row["reviews"], { id: string; stars: number; itemId: string }[]>
  >;
  type _count = Expect<
    Equal<Row["_count"], { reviews: number; badges: number }>
  >;
  const nested = await related.liveIds.findFirst({
    select: {
      id: true,
      reviews: { select: { stars: true, item: { select: { title: true } } } },
      _count: { select: { badges: true } },
    },
  });
  type _nested = Expect<
    Equal<
      typeof nested,
      {
        id: string;
        reviews: { stars: number; item: { title: string } }[];
        _count: { badges: number };
      } | null
    >
  >;
  // A relation whose key the view does not keep is no member of it.
  // @ts-expect-error - `itemTitles` keeps no `id`, which `reviews` joins on
  related.itemTitles.findMany({ include: { reviews: true } });
  // @ts-expect-error - nor in a filter
  related.itemTitles.findMany({ where: { badges: { some: {} } } });
  // @ts-expect-error - `owner` is `ownedItems`' JSON column, not a relation
  related.ownedItems.findMany({ include: { owner: true } });
  // @ts-expect-error - `liveIds` keeps no `ownerId`
  related.liveIds.findMany({ include: { owner: true } });
  // The JSON column stays the frozen document it is.
  related.ownedItems.findMany({ select: { owner: true, reviews: true } });
};

// =============================================================================
// A DECLARED JUNCTION: THE COLUMNS IT REFERENCES, NOT THE ROW KEY
// =============================================================================

const teamParent = s
  .model({
    organizationId: s.string(),
    childId: s.string(),
    parentId: s.string(),
    child: s
      .toOne(() => team)
      .fields("organizationId", "childId")
      .references("organizationId", "id"),
    parent: s
      .toOne(() => team)
      .fields("organizationId", "parentId")
      .references("organizationId", "id"),
  })
  .id(["childId", "parentId"]);
const team = s
  .model({
    id: s.string().id(),
    organizationId: s.string(),
    parents: s
      .toMany(() => team)
      .name("graph")
      .through(() => teamParent)
      .source("child")
      .target("parent"),
    children: s.toMany(() => team).name("graph"),
    tags: s.toMany(() => teamTag).through("team_tag"),
  })
  .unique(["organizationId", "id"]);
const teamTag = s.model({
  id: s.string().id(),
  teams: s.toMany(() => team),
});
/** Its junction references `organizationId` beside `id`, which this view drops. */
const teamIds = s.view(() => team, { select: { id: true } });
const teamKeys = s.view(() => team, {
  select: { id: true, organizationId: true },
});
const teams = createClient({
  schema: { teamParent, team, teamTag, teamIds, teamKeys },
  driver: new PGliteDriver(),
});

export const _declaredJunction = async () => {
  // @ts-expect-error - the junction joins on `organizationId`, which it drops
  await teams.teamIds.findMany({ include: { parents: true } });
  // @ts-expect-error - nor does the other end of the pair read
  await teams.teamIds.findMany({ include: { children: true } });
  // A junction the schema owns references the row key.
  await teams.teamIds.findMany({ include: { tags: true } });
  const kept = await teams.teamKeys.findMany({
    include: { parents: true, children: true },
  });
  type _kept = Expect<
    Equal<(typeof kept)[number]["parents"][number]["organizationId"], string>
  >;
};

// =============================================================================
// A VARIANT COLLECTION: ITS MEMBER JUNCTIONS REFERENCE THE ROW KEY
// =============================================================================

const book = s.model({ id: s.string().id(), title: s.string() });
const disc = s.model({ id: s.string().id(), label: s.string() });
const shelf = s.model({
  id: s.string().id(),
  name: s.string(),
  items: s.toMany({ book: () => book, disc: () => disc }),
});
const shelfIds = s.view(() => shelf, { select: { id: true } });
const shelfNames = s.view(() => shelf, { select: { name: true } });
const shelves = createClient({
  schema: { book, disc, shelf, shelfIds, shelfNames },
  driver: new PGliteDriver(),
});

export const _variantCollection = async () => {
  await shelves.shelfIds.findMany({ include: { items: true } });
  // @ts-expect-error - without the row key, no member junction joins
  await shelves.shelfNames.findMany({ include: { items: true } });
};

// =============================================================================
// A MATERIALIZED VIEW: $refresh on its delegate alone, .index() on its columns
// =============================================================================

const authorDigest = s
  .view(() => author, {
    select: { id: true, name: true, posts: { where: { published: true } } },
  })
  .materialized()
  .index(["name"]);
/** Keyless, and named after it was materialized. */
const titles = s
  .view(() => post, { select: { title: true } })
  .materialized()
  .map("titles");
const stored = createClient({
  schema: { author, post, publishedPost, authorDigest, titles },
  driver: new PGliteDriver(),
});

type _refresh = Expect<
  Equal<ReturnType<(typeof stored.authorDigest)["$refresh"]>, PromiseLike<void>>
>;
type _refreshKeyless = Expect<
  Equal<"$refresh" extends keyof typeof stored.titles ? true : false, true>
>;
type _noRefreshOnAView = Expect<
  Equal<
    "$refresh" extends keyof typeof stored.publishedPost ? true : false,
    false
  >
>;
type _noRefreshOnATable = Expect<
  Equal<"$refresh" extends keyof typeof stored.post ? true : false, false>
>;

export const _refreshes = async () => {
  await stored.authorDigest.$refresh();
  // Typed on any materialized view; refused when it runs on one without a key.
  await stored.titles.$refresh({ concurrently: true });
  await stored.$transaction(async (tx) => {
    await tx.authorDigest.$refresh();
  });
  // An array transaction takes pending operations alone, and a refresh is
  // not one: it is refused there, before it is awaited, so nothing is sent.
  // @ts-expect-error - refused in the array form
  await stored.$transaction([stored.authorDigest.$refresh()]);
  // A materialized view keeps its reads, and its key.
  await stored.authorDigest.findUnique({ where: { id: "a" } });
  // @ts-expect-error - an ordinary view stores no rows to recompute
  stored.publishedPost.$refresh;
  // @ts-expect-error - nor a table
  stored.post.$refresh;
  // @ts-expect-error - a typo in the options
  stored.authorDigest.$refresh({ concurently: true });
  // Options held in a variable are checked as a literal is.
  const blocking = { concurrently: false };
  await stored.authorDigest.$refresh(blocking);
  const misspelt = { concurrently: undefined, concurently: true };
  // @ts-expect-error - a typo beside an option, in a held object
  stored.authorDigest.$refresh(misspelt);
};

const storedChain = stored.$extends(
  extension(
    "stamps",
    defaults(() => ({ post: { create: { published: false } } }))
  )
);
export const _chainedRefresh = () => storedChain.authorDigest.$refresh();
const storedCache = stored.$extends(cache({ driver: new MemoryCache() }));
export const _cachedRefresh = () => {
  // @ts-expect-error - a cached view reads, and recomputes nothing
  storedCache.$withCache().authorDigest.$refresh;
};

export const _indexes = () => {
  const view = s
    .view(() => author, { select: { id: true, name: true, posts: true } })
    .materialized();
  view.index(["id", "name"], { unique: true });
  // @ts-expect-error - a JSON column is no member of an index
  view.index(["posts"]);
  // @ts-expect-error - nor a column the view does not project
  view.index(["balance"]);
  // @ts-expect-error - only a view is materialized
  author.materialized();
};

// =============================================================================
// AGGREGATED VIEWS: ONE ROW PER GROUP, FLAT TYPED COLUMNS, KEYED BY `by`
// =============================================================================

const shop = s.model({
  id: s.string().id(),
  name: s.string(),
  sales: s.toMany(() => sale),
});
const sale = s.model({
  id: s.string().ulid().id(),
  shopId: s.string(),
  currency: s.enum(["EUR", "USD"]),
  region: s.string().nullable(),
  units: s.int(),
  big: s.bigInt(),
  ratio: s.number(),
  amount: s.decimal({ precision: 10, scale: 2 }),
  note: s.string().map("sale_note"),
  soldAt: s.dateTime(),
  shop: s
    .toOne(() => shop)
    .fields("shopId")
    .references("id"),
});
const salesQuery = {
  by: [{ soldAt: "day" }, "currency"],
  timeZone: "Europe/Paris",
  where: { units: { gt: 0 } },
  _count: { _all: true, region: true },
  _sum: { units: true, big: true, ratio: true, amount: true },
  _avg: { units: true, amount: true },
  _min: { id: true, note: true, soldAt: true, currency: true },
  _max: { amount: true },
} as const;
const salesByDay = s.view(() => sale, salesQuery);
/** One grouped field, not nullable: the view's key is that field alone. */
const salesByShop = s.view(() => sale, {
  by: ["shopId"],
  _sum: { amount: true },
});
/** A nullable grouped field: no key. */
const salesByRegion = s.view(() => sale, { by: "region", _count: true });
/** A view of an aggregated view, and an aggregated view of a view. */
const busyDays = s.view(() => salesByDay, {
  where: { count: { gt: 1 } },
  select: { soldAt: true, currency: true, count: true },
});
const liveSale = s.view(() => sale, {
  where: { units: { gt: 0 } },
  select: { id: true, shopId: true, units: true },
});
const unitsByShop = s.view(() => liveSale, {
  by: ["shopId"],
  _sum: { units: true },
});
const aggregatedSchema = {
  shop,
  sale,
  salesByDay,
  salesByShop,
  salesByRegion,
  busyDays,
  liveSale,
  unitsByShop,
};
const aggregated = createClient({
  schema: aggregatedSchema,
  driver: new PGliteDriver(),
});

type SalesRow = {
  soldAt: string;
  currency: "EUR" | "USD";
  count: number;
  countRegion: number;
  avgUnits: number | null;
  avgAmount: Decimal | null;
  sumUnits: number | null;
  sumBig: bigint | null;
  sumRatio: number | null;
  sumAmount: Decimal | null;
  minId: string | null;
  minNote: string | null;
  minSoldAt: Date | null;
  minCurrency: "EUR" | "USD" | null;
  maxAmount: Decimal | null;
};
type _salesRow = Expect<Equal<RowOf<typeof aggregated.salesByDay>, SalesRow>>;

/**
 * What `groupBy` answers for the same selection, column by column (its `by`
 * takes a mutable list).
 */
type Grouped = Awaited<
  ReturnType<
    typeof aggregated.sale.groupBy<
      Omit<typeof salesQuery, "by"> & { by: [{ soldAt: "day" }, "currency"] }
    >
  >
>[number];
type _asGroupBy = Expect<
  Equal<
    [
      SalesRow["soldAt"],
      SalesRow["count"],
      SalesRow["sumUnits"],
      SalesRow["sumBig"],
      SalesRow["sumAmount"],
      SalesRow["avgUnits"],
      SalesRow["avgAmount"],
      SalesRow["minSoldAt"],
      SalesRow["minCurrency"],
    ],
    [
      Grouped["soldAt"],
      Grouped["_count"]["_all"],
      Grouped["_sum"]["units"],
      Grouped["_sum"]["big"],
      Grouped["_sum"]["amount"],
      Grouped["_avg"]["units"],
      Grouped["_avg"]["amount"],
      Grouped["_min"]["soldAt"],
      Grouped["_min"]["currency"],
    ]
  >
>;
type _shopRow = Expect<
  Equal<
    RowOf<typeof aggregated.salesByShop>,
    { shopId: string; sumAmount: Decimal | null }
  >
>;
type _overAggregated = Expect<
  Equal<
    RowOf<typeof aggregated.busyDays>,
    { soldAt: string; currency: "EUR" | "USD"; count: number }
  >
>;
type _aggregatedOverView = Expect<
  Equal<
    RowOf<typeof aggregated.unitsByShop>,
    { shopId: string; sumUnits: number | null }
  >
>;
// No key where a grouped field is nullable.
type _noGroupKey = Expect<
  Equal<
    "findUnique" extends keyof typeof aggregated.salesByRegion ? true : false,
    false
  >
>;

export const _aggregatedReads = async () => {
  // A filter, an order and an aggregate on the flat columns.
  await aggregated.salesByDay.findMany({
    where: { sumAmount: { gt: "1000" }, count: { gte: 2 }, minNote: null },
    orderBy: [{ soldAt: "desc" }, { sumUnits: "asc" }],
  });
  const max = await aggregated.salesByDay.aggregate({
    _max: { sumAmount: true },
    _sum: { count: true },
  });
  type _max = Expect<Equal<typeof max._max.sumAmount, Decimal | null>>;
  // The key: the `by` list, as `.id([...])` would name it; one field alone.
  const day = await aggregated.salesByDay.findUnique({
    where: { soldAt_currency: { soldAt: "2024-01-01", currency: "EUR" } },
  });
  type _day = Expect<Equal<NonNullable<typeof day>, SalesRow>>;
  await aggregated.salesByShop.findUnique({ where: { shopId: "s" } });
  // Its columns are not its source's: it inherits no relation.
  // @ts-expect-error - no `shop` relation on an aggregated view
  aggregated.salesByShop.findMany({ include: { shop: true } });
  await aggregated.liveSale.findMany({ include: { shop: true } });
  aggregated.salesByDay.findMany({
    // @ts-expect-error - a source column the view does not group is none of its own
    where: { units: { gt: 1 } },
  });
  // @ts-expect-error - no key where a grouped field is nullable
  aggregated.salesByRegion.findUnique;
  // @ts-expect-error - an aggregated view is never written
  aggregated.salesByDay.create;
};

/**
 * `.extends()` reads a view's keys from its columns again: a column derived
 * from a key of the source (its least id, a member of a compound `by`) is no
 * key of the view, which is keyed by its `by` list alone.
 */
export const _extendedAggregatedKeys = () => {
  const firsts = s
    .view(() => sale, {
      by: ["shopId"],
      _min: { id: true },
      _max: { id: true },
    })
    .extends({
      shop: s
        .toOne(() => shop)
        .fields("shopId")
        .references("id"),
    });
  const pairs = s
    .view(() => sale, { by: ["id", "currency"], _count: true })
    .extends({});
  const regions = s
    .view(() => sale, { by: ["region", "id"], _count: true })
    .extends({});
  const extended = createClient({
    schema: { shop, sale, firsts, pairs, regions },
    driver: new PGliteDriver(),
  });
  extended.firsts.findUnique({ where: { shopId: "s" } });
  // @ts-expect-error - the least id of a group is no key of the view
  extended.firsts.findUnique({ where: { minId: "x" } });
  // @ts-expect-error - nor is the greatest
  extended.firsts.findUnique({ where: { maxId: "x" } });
  extended.pairs.findUnique({
    where: { id_currency: { id: "x", currency: "EUR" } },
  });
  // @ts-expect-error - one member of a compound key is no key
  extended.pairs.findUnique({ where: { id: "x" } });
  // @ts-expect-error - no key where a grouped field is nullable
  extended.regions.findUnique;
};

export const _refusedAggregatedQueries = () => {
  // @ts-expect-error - a field the source does not have
  s.view(() => sale, { by: ["nope"], _count: true });
  // @ts-expect-error - a sum of a string
  s.view(() => sale, { by: ["currency"], _sum: { note: true } });
  // @ts-expect-error - a time step of a column that holds no date
  s.view(() => sale, { by: [{ units: "day" }] });
};

// =============================================================================
// A SELF JUNCTION WHOSE SIDES REFERENCE DIFFERENT KEYS: EACH END ITS OWN SIDE
// ======================================================================};

// =============================================================================

const nodeLink = s
  .model({
    childId: s.string(),
    parentSlug: s.string(),
    child: s
      .toOne(() => node)
      .fields("childId")
      .references("id"),
    parent: s
      .toOne(() => node)
      .fields("parentSlug")
      .references("slug"),
  })
  .id(["childId", "parentSlug"]);
const node = s.model({
  id: s.string().id(),
  slug: s.string().unique(),
  parents: s
    .toMany(() => node)
    .name("graph")
    .through(() => nodeLink)
    .source("child")
    .target("parent"),
  children: s.toMany(() => node).name("graph"),
});
const nodeIds = s.view(() => node, { select: { id: true } });
const nodeSlugs = s.view(() => node, { select: { slug: true } });
const nodes = createClient({
  schema: { nodeLink, node, nodeIds, nodeSlugs },
  driver: new PGliteDriver(),
});

export const _selfJunctionSides = async () => {
  // `parents` reads its `child` side, which references `id`.
  await nodes.nodeIds.findMany({ include: { parents: true } });
  // @ts-expect-error - `children` reads the `parent` side, which references `slug`
  await nodes.nodeIds.findMany({ include: { children: true } });
  await nodes.nodeSlugs.findMany({ include: { children: true } });
  // @ts-expect-error - and `parents` needs `id`
  await nodes.nodeSlugs.findMany({ include: { parents: true } });
=======
// A LIST IN A VIEW'S QUERY: THE VIEW'S COLUMNS ARE STILL ITS QUERY'S
// =============================================================================

/**
 * A query is inferred `const`, so a list in it is a read-only tuple. Where
 * the constraint took only a mutable list, the inference failed in silence
 * and the view had every scalar of its source.
 */
export const _listsInAQuery = () => {
  const entry = s.model({
    id: s.string().id(),
    title: s.string(),
    status: s.string(),
    hits: s.int(),
  });
  const listed = s.view(() => entry, {
    where: { status: { in: ["a", "b"] } },
    select: { id: true, title: true },
  });
  type ListedColumn = keyof (typeof listed)["~"]["state"]["scalars"];
  const listedColumns: ListedColumn[] = ["id", "title"];
  // @ts-expect-error - the view does not project hits
  const notListed: ListedColumn = "hits";

  const ordered = s.view(() => entry, {
    orderBy: [{ hits: "desc" }],
    take: 3,
    select: { id: true },
  });
  // @ts-expect-error - the view does not project title
  const notOrdered: keyof (typeof ordered)["~"]["state"]["scalars"] = "title";

  const either = s.view(() => entry, {
    where: { OR: [{ status: "a" }, { hits: { gt: 3 } }] },
    select: { id: true },
  });
  // @ts-expect-error - the view does not project title
  const notEither: keyof (typeof either)["~"]["state"]["scalars"] = "title";

  const grouped = s.view(() => entry, {
    by: ["status"],
    where: { status: { in: ["a", "b"] }, OR: [{ hits: { gt: 1 } }] },
    _sum: { hits: true },
  });
  type GroupedColumn = keyof (typeof grouped)["~"]["state"]["scalars"];
  const groupedColumns: GroupedColumn[] = ["status", "sumHits"];
  // @ts-expect-error - an aggregated view has its grouped fields and its aggregates
  const notGrouped: GroupedColumn = "title";

  return [
    listedColumns,
    notListed,
    notOrdered,
    notEither,
    groupedColumns,
    notGrouped,
  ];
};
