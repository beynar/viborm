/**
 * The SurrealDB read prototype against PostgreSQL: the same public reads over the
 * same rows must answer the same. Gated on SURREAL_TEST_URL, a server the runner
 * started; the database it uses is new for each run.
 */

import { createClient } from "@client/client";
import { PGliteDriver } from "@drivers/pglite";
import { SurrealDriver } from "@drivers/surrealdb";
import { PGlite } from "@electric-sql/pglite";
import { s } from "@schema";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import { Surreal } from "surrealdb";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const url = process.env.SURREAL_TEST_URL;

const user = s.model({
  id: s.string().id(),
  email: s.string().unique(),
  name: s.string().nullable(),
  age: s.int().nullable(),
  posts: s.toMany(() => post).name("wrote"),
  reviews: s.toMany(() => post).name("reviewed"),
  profile: s.toOne(() => profile),
});
const profile = s.model({
  id: s.string().id(),
  bio: s.string(),
  userId: s.string().unique(),
  user: s
    .toOne(() => user)
    .fields("userId")
    .references("id"),
});
const post = s.model({
  id: s.int().id(),
  title: s.string(),
  rank: s.int(),
  authorId: s.string(),
  author: s
    .toOne(() => user)
    .name("wrote")
    .fields("authorId")
    .references("id"),
  reviewerId: s.string().nullable(),
  reviewer: s
    .toOne(() => user)
    .name("reviewed")
    .fields("reviewerId")
    .references("id"),
  comments: s.toMany(() => comment),
});
const comment = s.model({
  id: s.int().id(),
  body: s.string(),
  rank: s.int(),
  postId: s.int(),
  post: s
    .toOne(() => post)
    .fields("postId")
    .references("id"),
});
const schema = { user, profile, post, comment };

const USERS = [
  { id: "a", email: "a@x.io", name: "Ann", age: 30 },
  { id: "b", email: "b@x.io", name: null, age: null },
  { id: "c", email: "C_c%@x.io", name: "Cid", age: 20 },
  { id: "d", email: "d@x.io", name: "Dee", age: null },
];
const POSTS = Array.from({ length: 24 }, (_, id) => ({
  id,
  title: `t${id % 5}`,
  rank: (id * 7) % 11,
  authorId: USERS[id % 3]!.id,
  reviewerId: id % 2 ? USERS[(id + 1) % 4]!.id : null,
}));
const COMMENTS = Array.from({ length: 60 }, (_, id) => ({
  id,
  body: `c${id % 9}`,
  rank: (id * 5) % 13,
  postId: id % 24,
}));
const PROFILES = [
  { id: "p1", bio: "first", userId: "a" },
  { id: "p2", bio: "second", userId: "c" },
];

const literal = (value: unknown) =>
  value === null || value === undefined ? "NONE" : JSON.stringify(value);

const CASES: readonly [
  string,
  "findMany" | "findFirst" | "findUnique",
  string,
  Record<string, unknown>,
][] = [
  ["every scalar", "findMany", "user", {}],
  ["select some", "findMany", "user", { select: { id: true, age: true } }],
  [
    "order and page",
    "findMany",
    "post",
    { orderBy: { rank: "desc" }, take: 4, skip: 2 },
  ],
  [
    "two order terms",
    "findMany",
    "post",
    { orderBy: [{ title: "asc" }, { rank: "desc" }], take: 6 },
  ],
  [
    "findFirst",
    "findFirst",
    "post",
    { where: { rank: { gt: 4 } }, orderBy: { rank: "asc" } },
  ],
  ["findFirst misses", "findFirst", "post", { where: { rank: { gt: 400 } } }],
  ["findUnique by key", "findUnique", "user", { where: { id: "b" } }],
  [
    "findUnique by unique",
    "findUnique",
    "user",
    { where: { email: "a@x.io" } },
  ],
  ["findUnique misses", "findUnique", "user", { where: { id: "zz" } }],
  ["equals", "findMany", "user", { where: { age: 20 } }],
  ["not on a nullable", "findMany", "user", { where: { age: { not: 20 } } }],
  [
    "less than on a nullable",
    "findMany",
    "user",
    { where: { age: { lt: 25 } } },
  ],
  ["NOT on a nullable", "findMany", "user", { where: { NOT: { age: 20 } } }],
  ["null", "findMany", "user", { where: { age: null } }],
  ["not null", "findMany", "user", { where: { age: { not: null } } }],
  ["in", "findMany", "user", { where: { age: { in: [20, 30] } } }],
  [
    "notIn on a nullable",
    "findMany",
    "user",
    { where: { age: { notIn: [20] } } },
  ],
  ["key in", "findMany", "user", { where: { id: { in: ["a", "c"] } } }],
  [
    "or and",
    "findMany",
    "user",
    { where: { OR: [{ age: 20 }, { name: "Ann" }] } },
  ],
  [
    "NOT over OR",
    "findMany",
    "user",
    { where: { NOT: { OR: [{ age: 20 }, { name: "Ann" }] } } },
  ],
  ["contains", "findMany", "user", { where: { email: { contains: "x.io" } } }],
  [
    "starts with",
    "findMany",
    "user",
    { where: { email: { startsWith: "a@" } } },
  ],
  [
    "insensitive",
    "findMany",
    "user",
    { where: { email: { startsWith: "c_", mode: "insensitive" } } },
  ],
  [
    "a link, filtered",
    "findMany",
    "post",
    { where: { authorId: "a" }, take: 3 },
  ],
  [
    "to-many",
    "findMany",
    "user",
    { select: { id: true, posts: { select: { id: true, rank: true } } } },
  ],
  [
    "to-many ordered and limited",
    "findMany",
    "user",
    {
      select: {
        id: true,
        posts: {
          orderBy: { rank: "desc" },
          take: 3,
          select: { id: true, rank: true },
        },
      },
    },
  ],
  [
    "to-many filtered",
    "findMany",
    "user",
    {
      select: {
        id: true,
        posts: { where: { title: "t1" }, select: { id: true } },
      },
    },
  ],
  [
    "two relations to one table",
    "findMany",
    "user",
    {
      select: {
        id: true,
        posts: { select: { id: true } },
        reviews: { select: { id: true } },
      },
    },
  ],
  [
    "to-one held",
    "findMany",
    "post",
    { take: 5, select: { id: true, author: { select: { email: true } } } },
  ],
  [
    "to-one nullable",
    "findMany",
    "post",
    { take: 5, select: { id: true, reviewer: { select: { email: true } } } },
  ],
  [
    "to-one inverse",
    "findMany",
    "user",
    { select: { id: true, profile: { select: { bio: true } } } },
  ],
  [
    "two levels",
    "findMany",
    "user",
    {
      select: {
        id: true,
        posts: {
          orderBy: { rank: "desc" },
          take: 3,
          select: { id: true, author: { select: { email: true } } },
        },
      },
    },
  ],
  [
    "three levels",
    "findMany",
    "user",
    {
      take: 2,
      select: {
        id: true,
        posts: {
          orderBy: { rank: "desc" },
          take: 2,
          select: {
            id: true,
            comments: {
              orderBy: { rank: "desc" },
              take: 2,
              select: { id: true, body: true },
            },
          },
        },
      },
    },
  ],
  ["some", "findMany", "user", { where: { posts: { some: { title: "t1" } } } }],
  ["none", "findMany", "user", { where: { posts: { none: { title: "t1" } } } }],
  [
    "every",
    "findMany",
    "user",
    { where: { posts: { every: { rank: { gte: 0 } } } } },
  ],
  [
    "every that fails",
    "findMany",
    "user",
    { where: { posts: { every: { rank: { gt: 3 } } } } },
  ],
  ["no posts at all", "findMany", "user", { where: { posts: { none: {} } } }],
  [
    "is",
    "findMany",
    "post",
    { where: { author: { is: { age: 30 } } }, take: 4 },
  ],
  [
    "isNot",
    "findMany",
    "post",
    { where: { author: { isNot: { age: 30 } } }, take: 4 },
  ],
  [
    "nullable to-one",
    "findMany",
    "post",
    { where: { reviewer: { is: { email: "a@x.io" } } } },
  ],
  [
    "nullable to-one absent",
    "findMany",
    "post",
    { where: { reviewer: null }, take: 4 },
  ],
  [
    "inverse to-one",
    "findMany",
    "user",
    { where: { profile: { is: { bio: "first" } } } },
  ],
  [
    "filter inside a relation filter",
    "findMany",
    "user",
    { where: { posts: { some: { comments: { some: { body: "c1" } } } } } },
  ],
];

describe.skipIf(!url)("SurrealDB read prototype against PostgreSQL", () => {
  let surreal: Surreal;
  let pglite: PGlite;
  let onSurreal: any;
  let onPostgres: any;

  beforeAll(async () => {
    surreal = new Surreal();
    const database = `read_${Date.now()}`;
    await surreal.connect(url!, {
      authentication: { username: "root", password: "root" },
    });
    await surreal.query(
      `DEFINE NAMESPACE IF NOT EXISTS viborm; USE NS viborm; DEFINE DATABASE ${database};`
    );
    await surreal.use({ namespace: "viborm", database });
    await surreal.query(`
      DEFINE TABLE user SCHEMAFULL; DEFINE FIELD email ON user TYPE string; DEFINE FIELD name ON user TYPE option<string>; DEFINE FIELD age ON user TYPE option<int>;
      DEFINE TABLE profile SCHEMAFULL; DEFINE FIELD bio ON profile TYPE string; DEFINE FIELD userId ON profile TYPE record<user> REFERENCE;
      DEFINE TABLE post SCHEMAFULL; DEFINE FIELD title ON post TYPE string; DEFINE FIELD rank ON post TYPE int; DEFINE FIELD authorId ON post TYPE record<user> REFERENCE; DEFINE FIELD reviewerId ON post TYPE option<record<user>> REFERENCE;
      DEFINE INDEX post_author ON post FIELDS authorId; DEFINE INDEX post_reviewer ON post FIELDS reviewerId;
      DEFINE TABLE comment SCHEMAFULL; DEFINE FIELD body ON comment TYPE string; DEFINE FIELD rank ON comment TYPE int; DEFINE FIELD postId ON comment TYPE record<post> REFERENCE;
      DEFINE INDEX comment_post ON comment FIELDS postId;
    `);
    for (const u of USERS)
      await surreal.query(
        `CREATE user:${u.id} SET email=${literal(u.email)},name=${literal(u.name)},age=${literal(u.age)}`
      );
    for (const p of PROFILES)
      await surreal.query(
        `CREATE profile:${p.id} SET bio=${literal(p.bio)},userId=user:${p.userId}`
      );
    for (const p of POSTS)
      await surreal.query(
        `CREATE post:${p.id} SET title=${literal(p.title)},rank=${p.rank},authorId=user:${p.authorId},reviewerId=${p.reviewerId ? `user:${p.reviewerId}` : "NONE"}`
      );
    for (const c of COMMENTS)
      await surreal.query(
        `CREATE comment:${c.id} SET body=${literal(c.body)},rank=${c.rank},postId=post:${c.postId}`
      );
    onSurreal = createClient({ schema, driver: new SurrealDriver(surreal) });

    pglite = new PGlite();
    onPostgres = createClient({
      schema,
      driver: new PGliteDriver({ client: pglite }),
    });
    await syncLiveSchema(onPostgres);
    await onPostgres.user.createMany({ data: USERS });
    await onPostgres.profile.createMany({ data: PROFILES });
    await onPostgres.post.createMany({ data: POSTS });
    await onPostgres.comment.createMany({ data: COMMENTS });
  }, 120_000);

  afterAll(async () => {
    await surreal?.close();
    await pglite?.close();
  });

  it.each(CASES)("%s", async (_, verb, model, args) => {
    const expected = await onPostgres[model][verb](args);
    const answered = await onSurreal[model][verb](args);
    expect(answered).toEqual(expected);
  });

  it("holds no SQL: reaching for any syntax refuses", () => {
    const { adapter } = new SurrealDriver(surreal);
    expect(adapter.result).toBeDefined();
    expect(() => adapter.operators).toThrow("speaks no SQL");
    expect(() => adapter.clauses).toThrow("speaks no SQL");
    expect(() => adapter.identifiers).toThrow("speaks no SQL");
  });
});
