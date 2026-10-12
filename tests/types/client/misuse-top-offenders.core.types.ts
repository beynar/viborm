/**
 * types-10, the top offenders of the 2026-10-09 misuse probe
 * (`t05-misuse.ts`): a misspelled key BESIDE a real one, at the four positions
 * the root clause guards did not reach. Every `@ts-expect-error` below compiled
 * on 1.1.0; each is paired with the correct spelling at the same position,
 * which must keep compiling.
 *
 *  - an operator bag next to a real operator (`where.<scalar>`);
 *  - nested write data (`create`, `createMany.data`, `connectOrCreate.create`,
 *    `update.data`, `upsert.create` / `upsert.update`);
 *  - nested projections (`include.<relation>.where` / `.include`,
 *    `select.<relation>.select`);
 *  - groupBy `orderBy` outside `by`.
 *
 * The gaps the probe still finds (variant arms, an aggregate selector typo,
 * `_min` on a boolean, a foreign key beside its relation's `connect`, an empty
 * groupBy `by`, an empty bulk `select`) are listed on the quick start; the
 * runtime refuses them.
 */

import { PGliteDriver } from "@drivers/pglite";
import { s } from "@schema";
import { createClient } from "@src/index";
import { describe, expectTypeOf, test } from "vitest";

const user = s.model({
  id: s.string().id().ulid(),
  email: s.string().unique(),
  name: s.string().nullable(),
  age: s.int().default(0),
  role: s.enum(["USER", "ADMIN"]).default("USER"),
  tags: s.string().array(),
  posts: s.toMany(() => post),
  profile: s.toOne(() => profile),
});
const profile = s.model({
  id: s.string().id().ulid(),
  bio: s.string(),
  userId: s.string().unique(),
  user: s
    .toOne(() => user)
    .fields("userId")
    .references("id"),
});
const post = s.model({
  id: s.string().id().ulid(),
  title: s.string(),
  published: s.boolean().default(false),
  authorId: s.string(),
  author: s
    .toOne(() => user)
    .fields("authorId")
    .references("id"),
});

const orm = createClient({
  schema: { user, profile, post },
  driver: new PGliteDriver(),
});

describe("an operator typo beside a real operator is refused", () => {
  const _correct = () => {
    orm.user.findMany({
      where: { email: { contains: "x", mode: "insensitive" } },
    });
    orm.post.findMany({ where: { title: { contains: "x", startsWith: "y" } } });
    orm.user.findMany({ where: { tags: { has: "a", hasSome: ["b"] } } });
    orm.user.findMany({
      where: { posts: { some: { title: { contains: "x", endsWith: "y" } } } },
    });
  };
  const _stringMode = () =>
    orm.user.findMany({
      // @ts-expect-error C06 "mdoe" beside "contains"
      where: { email: { contains: "x", mdoe: "insensitive" } },
    });
  const _stringStartsWith = () =>
    // @ts-expect-error C24 "startWith" beside "contains"
    orm.post.findMany({ where: { title: { contains: "x", startWith: "y" } } });
  const _listHas = () =>
    // @ts-expect-error C38 "hsa" beside "has"
    orm.user.findMany({ where: { tags: { has: "a", hsa: "b" } } });
  test("probes", () => {
    expectTypeOf(_correct).toBeFunction();
    expectTypeOf(_stringMode).toBeFunction();
    expectTypeOf(_stringStartsWith).toBeFunction();
    expectTypeOf(_listHas).toBeFunction();
  });
});

describe("a typo in nested write data is refused", () => {
  const _correct = () => {
    orm.user.create({
      data: { email: "z", tags: [], posts: { create: [{ title: "x" }] } },
    });
    orm.user.update({
      where: { id: "1" },
      data: {
        posts: {
          update: { where: { id: "p" }, data: { title: "x" } },
          createMany: { data: [{ title: "x" }] },
          upsert: {
            where: { id: "p" },
            create: { title: "x" },
            update: { published: true },
          },
        },
        profile: { update: { bio: "b" } },
      },
    });
    orm.post.create({
      data: {
        title: "t",
        author: {
          connectOrCreate: {
            where: { email: "a" },
            create: { email: "a", tags: [], name: "x" },
          },
        },
      },
    });
  };
  const _create = () =>
    orm.user.create({
      // @ts-expect-error C23 "publishd" beside "title" in a nested create
      data: {
        email: "z",
        tags: [],
        posts: { create: [{ title: "x", publishd: true }] },
      },
    });
  const _update = () =>
    orm.user.update({
      where: { id: "1" },
      // @ts-expect-error C26 "titel" beside "title" in a nested update's data
      data: {
        posts: {
          update: { where: { id: "p" }, data: { title: "x", titel: "y" } },
        },
      },
    });
  const _connectOrCreate = () =>
    orm.post.create({
      // @ts-expect-error C27 "nmae" beside real keys in connectOrCreate.create
      data: {
        title: "t",
        author: {
          connectOrCreate: {
            where: { email: "a" },
            create: { email: "a", tags: [], nmae: "x" },
          },
        },
      },
    });
  const _createMany = () =>
    orm.user.update({
      where: { id: "1" },
      // @ts-expect-error C41 "titel" beside "title" in createMany.data
      data: { posts: { createMany: { data: [{ title: "x", titel: "y" }] } } },
    });
  const _upsertUpdate = () =>
    orm.user.update({
      where: { id: "1" },
      // @ts-expect-error "publishd" beside "title" in upsert.update
      data: {
        posts: {
          upsert: {
            where: { id: "p" },
            create: { title: "x" },
            update: { title: "x", publishd: true },
          },
        },
      },
    });
  const _toOneBareUpdate = () =>
    orm.user.update({
      where: { id: "1" },
      // @ts-expect-error "boi" beside "bio" in a to-one bare update
      data: { profile: { update: { bio: "b", boi: "b" } } },
    });
  const _rootUpsertCreate = () =>
    orm.user.upsert({
      where: { id: "1" },
      // @ts-expect-error "titel" beside "title" under the upsert create arm
      create: {
        email: "a",
        tags: [],
        posts: { create: { title: "x", titel: "y" } },
      },
      update: {},
    });
  test("probes", () => {
    expectTypeOf(_correct).toBeFunction();
    expectTypeOf(_create).toBeFunction();
    expectTypeOf(_update).toBeFunction();
    expectTypeOf(_connectOrCreate).toBeFunction();
    expectTypeOf(_createMany).toBeFunction();
    expectTypeOf(_upsertUpdate).toBeFunction();
    expectTypeOf(_toOneBareUpdate).toBeFunction();
    expectTypeOf(_rootUpsertCreate).toBeFunction();
  });
});

describe("a typo in a nested projection is refused", () => {
  const _correct = () => {
    orm.user.findMany({
      include: { posts: { where: { title: "x" }, include: { author: true } } },
    });
    orm.user.findMany({
      select: { posts: { select: { title: true, _count: true } } },
    });
    orm.post.findMany({
      include: { author: { include: { posts: true, profile: true } } },
    });
  };
  const _includeWhere = () =>
    orm.user.findMany({
      // @ts-expect-error C21 "ttitle" beside "title" in include.where
      include: { posts: { where: { title: "x", ttitle: "x" } } },
    });
  const _selectSelect = () =>
    orm.user.findMany({
      // @ts-expect-error C22 "titel" beside "title" in select.select
      select: { posts: { select: { title: true, titel: true } } },
    });
  const _includeInclude = () =>
    orm.post.findMany({
      // @ts-expect-error C28 "postz" beside "posts" in include.include
      include: { author: { include: { posts: true, postz: true } } },
    });
  const _twoDeep = () =>
    orm.post.findMany({
      include: {
        author: {
          // @ts-expect-error "titel" two relations deep
          include: { posts: { select: { title: true, titel: true } } },
        },
      },
    });
  test("probes", () => {
    expectTypeOf(_correct).toBeFunction();
    expectTypeOf(_includeWhere).toBeFunction();
    expectTypeOf(_selectSelect).toBeFunction();
    expectTypeOf(_includeInclude).toBeFunction();
    expectTypeOf(_twoDeep).toBeFunction();
  });
});

describe("groupBy orders only by what it grouped", () => {
  const _correct = () => {
    orm.user.groupBy({ by: ["role"], orderBy: { role: "asc" } });
    orm.user.groupBy({ by: "role", orderBy: [{ _count: { role: "desc" } }] });
    orm.user.groupBy({ by: ["role", "age"], orderBy: { age: "asc" } });
  };
  const _orderByOutsideBy = () =>
    // @ts-expect-error C45 "email" is not grouped
    orm.user.groupBy({ by: ["role"], orderBy: { email: "asc" } });
  const _orderByArrayOutsideBy = () =>
    orm.user.groupBy({
      by: "role",
      // @ts-expect-error "email" is not grouped, in the array spelling
      orderBy: [{ role: "asc" }, { email: "asc" }],
    });
  test("probes", () => {
    expectTypeOf(_correct).toBeFunction();
    expectTypeOf(_orderByOutsideBy).toBeFunction();
    expectTypeOf(_orderByArrayOutsideBy).toBeFunction();
  });
});

/**
 * A type parameter cannot be keyed, so these guards keep a generic LEAF
 * assignable (a scalar value, a boolean projection flag, a node whose
 * constraint spells only real keys) and refuse a generic nested write object,
 * whose keys no guard can check — the convention a generic `recurse` bag
 * already follows. Spelling the object, or typing it as the payload, compiles.
 */
describe("generic wrappers", () => {
  const _leaves = <T extends string, B extends boolean>(title: T, flag: B) => {
    orm.post.findMany({ where: { title } });
    orm.user.findMany({ where: { posts: { some: { title } } } });
    orm.user.findMany({ include: { posts: flag } });
    orm.user.create({
      data: { email: title, tags: [], posts: { create: { title } } },
    });
    orm.user.groupBy({ by: ["role"], orderBy: { _count: { role: "desc" } } });
  };
  const _node = <N extends { select?: { title?: true } }>(posts: N) =>
    orm.user.findMany({ select: { posts } });
  const _nestedData = <D extends { title: string }>(data: D) => {
    const posts = { create: data };
    // @ts-expect-error a generic nested create cannot be proven free of typos
    return orm.user.update({ where: { id: "1" }, data: { posts } });
  };
  test("probes", () => {
    expectTypeOf(_leaves).toBeFunction();
    expectTypeOf(_node).toBeFunction();
    expectTypeOf(_nestedData).toBeFunction();
  });
});
