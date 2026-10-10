import { createClient } from "@client/client";
import type { AnyDriver } from "@drivers";
import {
  ForeignKeyError,
  NestedWriteError,
  NotFoundError,
  QueryEngineError,
  UniqueConstraintError,
} from "@errors";
import { s } from "@schema";
import { sql } from "@sql";
import { expectChangeWalkingItsModel } from "@tests/contracts/engine/query/recursive-relation-filter-behavior";
import { failure } from "@tests/fixtures/failure";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

/**
 * The `rows` capability at every SET scope (extension-capabilities plan v3.1
 * §2.2, Appendix lookup purposes; milestone 1) and every REFERENCE scope
 * (§5.3, milestone 2), through public entry points.
 *
 * A call's own candidates take its ROOT domain: every read verb, the
 * aggregates, a cursor's anchor, and the root lookups of `update`,
 * `updateMany` and `upsert`. Rows reached through a relation take its
 * RELATED domain, joined where the relation is correlated and outside any
 * quantifier's negation: to-many projections, `some`/`none`/`every`, counts,
 * `_count` order, a nested page, recursion, and the nested lookups of
 * `connect`, `set`, `update`, `upsert`, `updateMany` and `delete`; and, since
 * milestone 2, to-one projections (ordinary and polymorphic), `is`/`isNot`,
 * to-one order terms and upward recursion, where a hidden target reads as an
 * absent one. A recursive filter (`recurse` in `where`) walks the related
 * domain at every hop, so a hidden row stops the walk below it; its `self` row
 * is the outer row, which the call's root domain already chose. `disconnect`,
 * identity re-reads and integrity probes stay physical: a missing row is still
 * corruption, a hidden one is not. `base` is the same database without the
 * extension: its answers are the negative control beside each domain answer.
 *
 * Fixture (hand-computed oracles below): authors 1, 2, 4, 5 live, 3 a
 * tombstone. Posts (author, title): 10 (1, a), 13 (2, c), 14 (1, d) live;
 * 11 (1, b), 12 (2, a), 15 (2, e), 16 (2, f), 17 (5, g) tombstones.
 * Comments: 100 (post 10), 102 (13), 103 (11) live; 101 (10), 104 (11)
 * tombstones. Tags (unmanaged): 1 "x" links posts 10 and 11; 2 "y" links 13.
 * Boards (unmanaged, polymorphic collection): 1 holds post 10, post 11 and
 * tag 1; 2 holds post 11 and tag 1; 3 holds post 10. Pins (unmanaged,
 * polymorphic reference): 1 on post 11, 2 on post 10; stamps (unmanaged, a
 * REQUIRED polymorphic reference) the same. Nodes: 1 -> 2 (a
 * tombstone) -> 3, and 1 -> 4. One audit row, on a model no relation reaches.
 * Albums (managed, a polymorphic collection whose photo arm has a singular
 * inverse): 1 live holds photo 2; 2 a tombstone holds photo 1. Cover 1
 * (managed, one to one) holds post 10.
 */

const T = new Date("2026-01-01T00:00:00.000Z");

export function rowScopeSchema() {
  const author = s.model({
    id: s.int().id(),
    name: s.string(),
    deletedAt: s.dateTime().nullable(),
    posts: s.toMany(() => post),
    pins: s.toMany(() => pin).name("subject"),
  });
  const post = s.model({
    id: s.int().id(),
    title: s.string(),
    slug: s.string().unique(),
    authorId: s.int(),
    author: s
      .toOne(() => author)
      .fields("authorId")
      .references("id"),
    deletedAt: s.dateTime().nullable(),
    comments: s.toMany(() => comment),
    tags: s.toMany(() => tag),
    pins: s.toMany(() => pin).name("subject"),
    stamps: s.toMany(() => stamp).name("stamped"),
    cover: s.toOne(() => cover),
  });
  const cover = s.model({
    id: s.int().id(),
    postId: s.int().unique(),
    post: s
      .toOne(() => post)
      .fields("postId")
      .references("id"),
    deletedAt: s.dateTime().nullable(),
  });
  const comment = s.model({
    id: s.int().id(),
    body: s.string(),
    postId: s.int(),
    post: s
      .toOne(() => post)
      .fields("postId")
      .references("id"),
    deletedAt: s.dateTime().nullable(),
  });
  const tag = s.model({
    id: s.int().id(),
    name: s.string(),
    posts: s.toMany(() => post),
  });
  const node = s.model({
    id: s.int().id(),
    label: s.string(),
    parentId: s.int().nullable(),
    parent: s
      .toOne(() => node)
      .fields("parentId")
      .references("id")
      .name("tree"),
    children: s.toMany(() => node).name("tree"),
    deletedAt: s.dateTime().nullable(),
  });
  const board = s.model({
    id: s.int().id(),
    items: s.toMany({ post: () => post, tag: () => tag }),
  });
  const pin = s.model({
    id: s.int().id(),
    subject: s
      .toOne({ post: () => post, author: () => author })
      .name("subject")
      .optional(),
  });
  // A REQUIRED polymorphic reference stored on its own row.
  const stamp = s.model({
    id: s.int().id(),
    subject: s.toOne({ post: () => post }).name("stamped"),
  });
  const audit = s.model({ id: s.int().id(), note: s.string() });
  const album = s.model({
    id: s.int().id(),
    deletedAt: s.dateTime().nullable(),
    items: s.toMany({ photo: () => photo, tag: () => tag }),
  });
  const photo = s.model({ id: s.int().id(), album: s.toOne(() => album) });
  return {
    author,
    post,
    comment,
    tag,
    node,
    board,
    pin,
    stamp,
    audit,
    album,
    photo,
    cover,
  };
}

const modes = {
  without: { root: { deletedAt: null }, related: { deletedAt: null } },
  with: {},
  only: { root: { deletedAt: { not: null } }, related: { deletedAt: null } },
} as const;

/** §1.1's step A over the four managed models. */
const softDelete = {
  name: "test.rows",
  controls: { mode: { oneOf: ["soft", "hard"] } },
  rows: {
    control: "deleted",
    default: "without",
    models: {
      author: modes,
      post: modes,
      comment: modes,
      node: modes,
      album: modes,
      cover: modes,
    },
  },
  deletion: {
    removeWhen: { mode: "hard" },
    models: {
      author: { at: "deletedAt" },
      post: { at: "deletedAt" },
      comment: { at: "deletedAt" },
      node: { at: "deletedAt" },
    },
  },
} as const;

/**
 * A mode whose related domain is narrower than the default's: it hides every
 * comment. A delete under it still meets the restrict of the comments the
 * DEFAULT domain shows.
 */
const narrowModes = {
  ...modes,
  narrow: { root: { deletedAt: null }, related: { deletedAt: null, id: -1 } },
} as const;
const narrowDelete = {
  name: "test.narrow",
  rows: {
    control: "deleted",
    default: "without",
    models: { post: narrowModes, comment: narrowModes },
  },
  deletion: { models: { post: { at: "deletedAt" } } },
} as const;

/** The seeded database, the base client and its rows client. */
export async function openRowScopeFixture(driver: AnyDriver) {
  const base = createClient({ schema: rowScopeSchema(), driver });
  await syncLiveSchema(base);
  await base.author.createMany({
    data: (
      [
        [1, null],
        [2, null],
        [3, T],
        [4, null],
        [5, null],
      ] as const
    ).map(([id, deletedAt]) => ({ id, name: `n${id}`, deletedAt })),
  });
  await base.post.createMany({
    data: (
      [
        [10, 1, "a", null],
        [11, 1, "b", T],
        [12, 2, "a", T],
        [13, 2, "c", null],
        [14, 1, "d", null],
        [15, 2, "e", T],
        [16, 2, "f", T],
        [17, 5, "g", T],
      ] as const
    ).map(([id, authorId, title, deletedAt]) => ({
      id,
      authorId,
      title,
      slug: `s${id}`,
      deletedAt,
    })),
  });
  await base.comment.createMany({
    data: (
      [
        [100, 10, null],
        [101, 10, T],
        [102, 13, null],
        [103, 11, null],
        [104, 11, T],
      ] as const
    ).map(([id, postId, deletedAt]) => ({
      id,
      postId,
      body: `c${id}`,
      deletedAt,
    })),
  });
  await base.tag.create({
    data: { id: 1, name: "x", posts: { connect: [{ id: 10 }, { id: 11 }] } },
  });
  await base.tag.create({
    data: { id: 2, name: "y", posts: { connect: [{ id: 13 }] } },
  });
  await base.board.create({
    data: {
      id: 1,
      items: {
        connect: [
          { type: "post", where: { id: 10 } },
          { type: "post", where: { id: 11 } },
          { type: "tag", where: { id: 1 } },
        ],
      },
    },
  });
  await base.board.create({
    data: {
      id: 2,
      items: {
        connect: [
          { type: "post", where: { id: 11 } },
          { type: "tag", where: { id: 1 } },
        ],
      },
    },
  });
  await base.board.create({
    data: { id: 3, items: { connect: [{ type: "post", where: { id: 10 } }] } },
  });
  await base.node.create({ data: { id: 1, label: "root" } });
  await base.node.create({
    data: { id: 2, label: "mid", parentId: 1, deletedAt: T },
  });
  await base.node.createMany({
    data: [
      { id: 3, label: "leaf", parentId: 2 },
      { id: 4, label: "side", parentId: 1 },
    ],
  });
  await base.pin.create({
    data: {
      id: 1,
      subject: { connect: { type: "post", where: { id: 11 } } },
    },
  });
  await base.pin.create({
    data: {
      id: 2,
      subject: { connect: { type: "post", where: { id: 10 } } },
    },
  });
  for (const [id, postId] of [
    [1, 11],
    [2, 10],
  ] as const)
    await base.stamp.create({
      data: {
        id,
        subject: { connect: { type: "post", where: { id: postId } } },
      },
    });
  await base.audit.create({ data: { id: 1, note: "x" } });
  await base.cover.create({ data: { id: 1, postId: 10 } });
  await base.photo.createMany({ data: [{ id: 1 }, { id: 2 }] });
  await base.album.create({
    data: {
      id: 1,
      items: { connect: [{ type: "photo", where: { id: 2 } }] },
    },
  });
  await base.album.create({
    data: {
      id: 2,
      deletedAt: T,
      items: { connect: [{ type: "photo", where: { id: 1 } }] },
    },
  });
  return {
    base,
    db: base.$extends(softDelete),
    narrow: base.$extends(narrowDelete),
  };
}

export type RowScopeFixture = Awaited<ReturnType<typeof openRowScopeFixture>>;

export const ids = (rows: readonly { readonly id: number }[]) =>
  rows.map((row) => row.id);

type RawClient = RowScopeFixture["base"];

/**
 * Drop a junction's constraints of one kind, raw: SQLite turns its foreign
 * keys off per connection and cannot drop a table-level UNIQUE (it answers
 * `false`); PostgreSQL drops them by name; MySQL drops them by name too, a
 * UNIQUE together with the table's foreign keys, since MySQL refuses to drop
 * an index a foreign key still needs. No other dialect runs the behaviour.
 */
async function dropConstraints(
  client: RawClient,
  name: string,
  kind: "f" | "u"
): Promise<boolean> {
  const dialect = client.$driver.dialect;
  if (dialect === "sqlite") {
    if (kind === "u") return false;
    await client.$executeRawUnsafe("PRAGMA foreign_keys = OFF");
    return true;
  }
  const ident = client.$driver.adapter.identifiers.escape;
  const table = client.$driver.adapter.identifiers.table;
  if (dialect === "mysql") {
    for (const type of kind === "f"
      ? ["FOREIGN KEY"]
      : ["FOREIGN KEY", "UNIQUE"]) {
      const named = await client.$queryRaw<{ name: string }>(
        sql`SELECT CONSTRAINT_NAME AS name FROM information_schema.TABLE_CONSTRAINTS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ${name} AND CONSTRAINT_TYPE = ${type}`
      );
      for (const row of named)
        await client.$executeRaw(
          type === "UNIQUE"
            ? sql`ALTER TABLE ${table(name)} DROP INDEX ${ident(row.name)}`
            : sql`ALTER TABLE ${table(name)} DROP FOREIGN KEY ${ident(row.name)}`
        );
    }
    return true;
  }
  if (dialect !== "postgresql")
    throw new Error(`no raw constraint helper for ${dialect}`);
  const named = await client.$queryRaw<{ conname: string }>(
    sql`SELECT conname FROM pg_constraint WHERE conrelid = ${`"${client.$driver.adapter.namespace ?? "public"}"."${name}"`}::regclass AND contype = ${kind}`
  );
  for (const row of named)
    await client.$executeRaw(
      sql`ALTER TABLE ${table(name)} DROP CONSTRAINT ${ident(row.conname)}`
    );
  return true;
}

/**
 * The fixture hides the FIRST hop of the node tree (node 2), which only a
 * recursion's anchor reads. Make `live` live and hide `hidden` instead, so a
 * walk meets its hidden node at the second hop, where only the recursive
 * step's correlation can end it.
 */
async function hideSecondHop(
  client: RawClient,
  live: number,
  hidden: number
): Promise<void> {
  await client.node.update({ where: { id: live }, data: { deletedAt: null } });
  await client.node.update({ where: { id: hidden }, data: { deletedAt: T } });
}

export interface RowScopeProvider {
  readonly name: string;
  readonly createDriver: () => AnyDriver;
}

export function runRowScopeBehavior(provider: RowScopeProvider): void {
  describe(`${provider.name}: rows at set scopes`, () => {
    let context: RowScopeFixture;

    beforeEach(async () => {
      context = await openRowScopeFixture(provider.createDriver());
    });
    afterEach(async () => {
      await context.base.$disconnect();
    });

    test("every read verb takes the call's root domain, in each mode", async () => {
      const { base, db } = context;
      const order = { orderBy: { id: "asc" } } as const;
      expect(ids(await db.post.findMany(order))).toEqual([10, 13, 14]);
      expect(
        ids(await db.post.findMany({ ...order, deleted: "without" }))
      ).toEqual([10, 13, 14]);
      expect(
        ids(await db.post.findMany({ ...order, deleted: "with" }))
      ).toEqual([10, 11, 12, 13, 14, 15, 16, 17]);
      expect(
        ids(await db.post.findMany({ ...order, deleted: "only" }))
      ).toEqual([11, 12, 15, 16, 17]);
      expect(await db.post.findUnique({ where: { id: 11 } })).toBeNull();
      expect(
        await failure(db.post.findUniqueOrThrow({ where: { id: 11 } }))
      ).toBeInstanceOf(NotFoundError);
      expect(
        (await db.post.findUnique({ where: { id: 11 }, deleted: "with" }))?.id
      ).toBe(11);
      expect(await db.post.findFirst({ where: { title: "b" } })).toBeNull();
      // A read without `where` takes the domain too.
      expect((await db.post.findFirst({ orderBy: { id: "desc" } }))?.id).toBe(
        14
      );
      expect((await base.post.findFirst({ orderBy: { id: "desc" } }))?.id).toBe(
        17
      );
      expect(ids(await db.author.findMany(order))).toEqual([1, 2, 4, 5]);
    });

    test("count, exist, aggregate and groupBy with HAVING compute over the domain's rows", async () => {
      const { base, db } = context;
      expect(await db.post.count()).toBe(3);
      expect(await db.post.count({ deleted: "only" })).toBe(5);
      expect(await base.post.count()).toBe(8);
      expect(await db.post.exist({ where: { id: 11 } })).toBe(false);
      expect(await db.post.exist({ where: { id: 11 }, deleted: "only" })).toBe(
        true
      );
      expect(
        (await db.post.aggregate({ _count: { _all: true } }))._count
      ).toEqual({ _all: 3 });
      const grouped = await db.post.groupBy({
        by: ["authorId"],
        _count: { _all: true },
        orderBy: { authorId: "asc" },
      });
      expect(grouped.map((row) => [row.authorId, row._count._all])).toEqual([
        [1, 2],
        [2, 1],
      ]);
      const having = await db.post.groupBy({
        by: ["authorId"],
        _count: { _all: true },
        having: { id: { _count: { gt: 1 } } },
      });
      expect(having.map((row) => row.authorId)).toEqual([1]);
      const physical = await base.post.groupBy({
        by: ["authorId"],
        _count: { _all: true },
        orderBy: { authorId: "asc" },
      });
      expect(physical.map((row) => [row.authorId, row._count._all])).toEqual([
        [1, 3],
        [2, 4],
        [5, 1],
      ]);
    });

    test("a page is cut from the domain: a hidden cursor anchor is a missing one, a negative take counts visible rows", async () => {
      const { base, db } = context;
      const page = (cursor: number) =>
        ({ cursor: { id: cursor }, take: 2, orderBy: { id: "asc" } }) as const;
      expect(ids(await db.post.findMany(page(10)))).toEqual([10, 13]);
      expect(ids(await db.post.findMany(page(11)))).toEqual([]);
      expect(ids(await base.post.findMany(page(11)))).toEqual([11, 12]);
      expect(
        ids(await db.post.findMany({ ...page(11), deleted: "with" }))
      ).toEqual([11, 12]);
      expect(
        ids(await db.post.findMany({ take: -2, orderBy: { id: "asc" } }))
      ).toEqual([13, 14]);
      expect(
        ids(await base.post.findMany({ take: -2, orderBy: { id: "asc" } }))
      ).toEqual([16, 17]);
      // The nested page: the same operator inside the parent's correlation.
      const nested = (cursor: number) =>
        db.author.findUniqueOrThrow({
          where: { id: 1 },
          include: {
            posts: { cursor: { id: cursor }, take: 5, orderBy: { id: "asc" } },
          },
        });
      expect(ids((await nested(11)).posts)).toEqual([]);
      expect(ids((await nested(10)).posts)).toEqual([10, 14]);
      const last = await db.author.findUniqueOrThrow({
        where: { id: 1 },
        include: { posts: { take: -1, orderBy: { id: "asc" } } },
      });
      expect(ids(last.posts)).toEqual([14]);
    });

    test("to-many projections read the related domain, from a managed or an unmanaged root", async () => {
      const { base, db } = context;
      const authors = await db.author.findMany({
        orderBy: { id: "asc" },
        include: {
          posts: { select: { id: true }, orderBy: { id: "asc" } },
        },
      });
      expect(authors.map((row) => [row.id, ids(row.posts)])).toEqual([
        [1, [10, 14]],
        [2, [13]],
        [4, []],
        [5, []],
      ]);
      // `only` selects tombstoned roots; their related rows stay live.
      const bin = await db.post.findMany({
        deleted: "only",
        orderBy: { id: "asc" },
        include: { comments: { select: { id: true } } },
      });
      expect(bin.map((row) => [row.id, ids(row.comments)])).toEqual([
        [11, [103]],
        [12, []],
        [15, []],
        [16, []],
        [17, []],
      ]);
      const tags = await db.tag.findMany({
        orderBy: { id: "asc" },
        include: { posts: { select: { id: true }, orderBy: { id: "asc" } } },
      });
      expect(tags.map((row) => [row.id, ids(row.posts)])).toEqual([
        [1, [10]],
        [2, [13]],
      ]);
      const physical = await base.tag.findMany({
        orderBy: { id: "asc" },
        include: { posts: { select: { id: true }, orderBy: { id: "asc" } } },
      });
      expect(physical.map((row) => [row.id, ids(row.posts)])).toEqual([
        [1, [10, 11]],
        [2, [13]],
      ]);
      const board = await db.board.findUniqueOrThrow({
        where: { id: 1 },
        include: { items: true },
      });
      expect(
        board.items.map((item) => `${item.type}:${item.data.id}`).sort()
      ).toEqual(["post:10", "tag:1"]);
    });

    test("some, none and every range over visible members, empty and hidden-only included", async () => {
      const { base, db } = context;
      const authors = async (where: object) =>
        ids(await db.author.findMany({ where, orderBy: { id: "asc" } }));
      const live = async (where: object) =>
        ids(
          await base.author.findMany({
            where: { AND: [where, { deletedAt: null }] },
            orderBy: { id: "asc" },
          })
        );
      expect(await authors({ posts: { some: { title: "b" } } })).toEqual([]);
      expect(await live({ posts: { some: { title: "b" } } })).toEqual([1]);
      expect(await authors({ posts: { some: {} } })).toEqual([1, 2]);
      expect(await live({ posts: { some: {} } })).toEqual([1, 2, 5]);
      expect(await authors({ posts: { none: {} } })).toEqual([4, 5]);
      expect(await authors({ posts: { none: { title: "b" } } })).toEqual([
        1, 2, 4, 5,
      ]);
      expect(await live({ posts: { none: { title: "b" } } })).toEqual([
        2, 4, 5,
      ]);
      expect(
        await authors({ posts: { every: { title: { in: ["a", "d"] } } } })
      ).toEqual([1, 4, 5]);
      expect(
        await live({ posts: { every: { title: { in: ["a", "d"] } } } })
      ).toEqual([4]);
      expect(
        await authors({
          OR: [{ posts: { some: { title: "b" } } }, { name: "n4" }],
        })
      ).toEqual([4]);
      expect(
        await authors({ NOT: { posts: { some: { title: "a" } } } })
      ).toEqual([2, 4, 5]);
      expect(await live({ NOT: { posts: { some: { title: "a" } } } })).toEqual([
        4, 5,
      ]);
    });

    test("relation counts and _count order read the domain; a negated tagged count and a tagged every negate only the member predicate", async () => {
      const { base, db } = context;
      const counted = await db.author.findMany({
        orderBy: { id: "asc" },
        select: { id: true, _count: { select: { posts: true } } },
      });
      expect(counted.map((row) => [row.id, row._count.posts])).toEqual([
        [1, 2],
        [2, 1],
        [4, 0],
        [5, 0],
      ]);
      const ordered = await db.author.findMany({
        orderBy: [{ posts: { _count: "desc" } }, { id: "asc" }],
      });
      expect(ids(ordered)).toEqual([1, 2, 4, 5]);
      const physical = await base.author.findMany({
        where: { deletedAt: null },
        orderBy: [{ posts: { _count: "desc" } }, { id: "asc" }],
      });
      expect(ids(physical)).toEqual([2, 1, 5, 4]);
      const tagged = {
        orderBy: { id: "asc" },
        select: {
          id: true,
          _count: {
            select: {
              items: { where: { type: "post", isNot: { title: "a" } } },
            },
          },
        },
      } as const;
      expect(
        (await db.board.findMany(tagged)).map((row) => [
          row.id,
          row._count.items,
        ])
      ).toEqual([
        [1, 0],
        [2, 0],
        [3, 0],
      ]);
      expect(
        (await base.board.findMany(tagged)).map((row) => [
          row.id,
          row._count.items,
        ])
      ).toEqual([
        [1, 1],
        [2, 1],
        [3, 0],
      ]);
      const every = {
        where: { items: { every: { type: "tag", is: { name: "x" } } } },
        orderBy: { id: "asc" },
      } as const;
      expect(ids(await db.board.findMany(every))).toEqual([2]);
      expect(ids(await base.board.findMany(every))).toEqual([]);
    });

    test("a recursive to-many relation cuts the branch below a hidden node", async () => {
      const { base, db } = context;
      const tree = {
        where: { id: 1 },
        select: {
          id: true,
          children: {
            recurse: { depth: 3 },
            orderBy: { id: "asc" },
            select: { id: true },
          },
        },
      } as const;
      expect(await db.node.findUnique(tree)).toEqual({
        id: 1,
        children: [{ id: 4, children: [] }],
      });
      expect(await base.node.findUnique(tree)).toEqual({
        id: 1,
        children: [
          { id: 2, children: [{ id: 3, children: [] }] },
          { id: 4, children: [] },
        ],
      });
    });

    test("a to-one projection reads a hidden target as null, required or optional, in the modes that hide it", async () => {
      const { base, db } = context;
      const select = {
        orderBy: { id: "asc" },
        select: { id: true, post: { select: { id: true } } },
      } as const;
      const pairs = (
        rows: readonly { id: number; post: { id: number } | null }[]
      ) => rows.map((row) => [row.id, row.post?.id ?? null]);
      // `comment.post` is required: comment 103's post 11 is a tombstone.
      expect(pairs(await db.comment.findMany(select))).toEqual([
        [100, 10],
        [102, 13],
        [103, null],
      ]);
      expect(
        pairs(await db.comment.findMany({ ...select, deleted: "only" }))
      ).toEqual([
        [101, 10],
        [104, null],
      ]);
      expect(
        pairs(await db.comment.findMany({ ...select, deleted: "with" }))
      ).toEqual([
        [100, 10],
        [101, 10],
        [102, 13],
        [103, 11],
        [104, 11],
      ]);
      expect(pairs(await base.comment.findMany(select))).toEqual([
        [100, 10],
        [101, 10],
        [102, 13],
        [103, 11],
        [104, 11],
      ]);
      // An include reads the same, and a visible target keeps its row.
      const included = await db.comment.findUniqueOrThrow({
        where: { id: 103 },
        include: { post: true },
      });
      expect(included.post).toBeNull();
      // Photo 1's album (a singular inverse through a junction) is a tombstone.
      const photos = await db.photo.findMany({
        orderBy: { id: "asc" },
        include: { album: { select: { id: true } } },
      });
      expect(photos.map((row) => [row.id, row.album?.id ?? null])).toEqual([
        [1, null],
        [2, 1],
      ]);
      const physical = await base.photo.findMany({
        orderBy: { id: "asc" },
        include: { album: { select: { id: true } } },
      });
      expect(physical.map((row) => [row.id, row.album?.id ?? null])).toEqual([
        [1, 2],
        [2, 1],
      ]);
    });

    test("is, isNot and a to-one order term read the related domain", async () => {
      const { base, db } = context;
      const ordered = { orderBy: { id: "asc" } } as const;
      const is = { where: { post: { is: { title: "b" } } }, ...ordered };
      expect(ids(await db.comment.findMany(is))).toEqual([]);
      expect(
        ids(await db.comment.findMany({ ...is, deleted: "with" }))
      ).toEqual([103, 104]);
      expect(ids(await base.comment.findMany(is))).toEqual([103, 104]);
      const isNot = { where: { post: { isNot: { title: "b" } } }, ...ordered };
      expect(ids(await db.comment.findMany(isNot))).toEqual([100, 102, 103]);
      expect(ids(await base.comment.findMany(isNot))).toEqual([100, 101, 102]);
      // Titles a (post 10), b (11, hidden), c (13): a hidden target orders as
      // a null key, which each provider places at one end of the order.
      expect(
        ids(
          await base.comment.findMany({
            orderBy: [{ post: { title: "asc" } }, { id: "asc" }],
          })
        )
      ).toEqual([100, 101, 103, 104, 102]);
      const scoped = ids(
        await db.comment.findMany({
          orderBy: [{ post: { title: "asc" } }, { id: "asc" }],
        })
      );
      expect(scoped.filter((id) => id !== 103)).toEqual([100, 102]);
      expect([0, 2]).toContain(scoped.indexOf(103));
    });

    test("a lookup that reads through a to-one relation depends on the call's earlier write of that target's domain fields", async () => {
      const { base, db } = context;
      // The root write hides cover 1; the nested post lookup reads it back
      // through `cover`, so it runs after that write and finds nothing.
      const refused = await failure(
        db.cover.update({
          where: { id: 1 },
          data: {
            deletedAt: T,
            post: {
              update: { where: { cover: { is: {} } }, data: { title: "x" } },
            },
          },
        })
      );
      expect(refused).toBeInstanceOf(NestedWriteError);
      expect((refused as NestedWriteError).message).toContain(
        "target record was not found"
      );
      expect(
        await base.post.findUniqueOrThrow({
          where: { id: 10 },
          select: { title: true },
        })
      ).toEqual({ title: "a" });
    });

    test("an upward recursion stops at a hidden node", async () => {
      const { base, db } = context;
      const ancestors = {
        where: { id: 3 },
        select: {
          id: true,
          parent: { recurse: { depth: 3 }, select: { id: true } },
        },
      } as const;
      expect(await db.node.findUnique(ancestors)).toEqual({
        id: 3,
        parent: null,
      });
      expect(await base.node.findUnique(ancestors)).toEqual({
        id: 3,
        parent: { id: 2, parent: { id: 1, parent: null } },
      });
      expect(
        await db.node.findUnique({ ...ancestors, deleted: "with" })
      ).toEqual({ id: 3, parent: { id: 2, parent: { id: 1, parent: null } } });
    });

    test("the recursive step reads the related domain: upward, a node hidden two hops away ends the walk", async () => {
      const { base, db } = context;
      await hideSecondHop(base, 2, 1);
      const ancestors = {
        where: { id: 3 },
        select: {
          id: true,
          parent: { recurse: { depth: 3 }, select: { id: true } },
        },
      } as const;
      expect(await db.node.findUnique(ancestors)).toEqual({
        id: 3,
        parent: { id: 2, parent: null },
      });
      expect(await base.node.findUnique(ancestors)).toEqual({
        id: 3,
        parent: { id: 2, parent: { id: 1, parent: null } },
      });
    });

    test("the recursive step reads the related domain: downward, a node hidden two hops away is cut", async () => {
      const { base, db } = context;
      await hideSecondHop(base, 2, 3);
      const tree = {
        where: { id: 1 },
        select: {
          id: true,
          children: {
            recurse: { depth: 3 },
            orderBy: { id: "asc" },
            select: { id: true },
          },
        },
      } as const;
      expect(await db.node.findUnique(tree)).toEqual({
        id: 1,
        children: [
          { id: 2, children: [] },
          { id: 4, children: [] },
        ],
      });
      expect(await base.node.findUnique(tree)).toEqual({
        id: 1,
        children: [
          { id: 2, children: [{ id: 3, children: [] }] },
          { id: 4, children: [] },
        ],
      });
    });

    test("a recursive filter walks the related domain: a tombstoned intermediate stops it, and `with` sees through", async () => {
      const { base, db } = context;
      const ordered = { orderBy: { id: "asc" } } as const;
      // Node 3's ancestors are 2 (a tombstone) and 1: the walk stops at 2.
      const belowRoot = {
        where: { parent: { recurse: true, some: { id: 1 } } },
        ...ordered,
      } as const;
      expect(ids(await db.node.findMany(belowRoot))).toEqual([4]);
      expect(await db.node.count({ where: belowRoot.where })).toBe(1);
      expect(
        ids(await db.node.findMany({ ...belowRoot, deleted: "with" }))
      ).toEqual([2, 3, 4]);
      expect(ids(await base.node.findMany(belowRoot))).toEqual([2, 3, 4]);
      // Downward, node 1 reaches the leaf only through the tombstone.
      const aboveLeaf = {
        where: {
          children: { recurse: { depth: false }, some: { label: "leaf" } },
        },
        ...ordered,
      } as const;
      expect(ids(await db.node.findMany(aboveLeaf))).toEqual([]);
      expect(
        ids(await db.node.findMany({ ...aboveLeaf, deleted: "with" }))
      ).toEqual([1, 2]);
      expect(ids(await base.node.findMany(aboveLeaf))).toEqual([1, 2]);
    });

    test("a hidden descendant is not a member of a closure: some, every and none range over visible rows", async () => {
      const { base, db } = context;
      const visible = async (where: object) =>
        ids(await db.node.findMany({ where, orderBy: { id: "asc" } }));
      const physical = async (where: object) =>
        ids(await base.node.findMany({ where, orderBy: { id: "asc" } }));
      const some = { children: { recurse: true, some: { label: "mid" } } };
      expect(await visible(some)).toEqual([]);
      expect(await physical(some)).toEqual([1]);
      // Node 1's visible closure is {4}; physically it is {2, 3, 4}.
      const every = { children: { recurse: true, every: { label: "side" } } };
      expect(await visible(every)).toEqual([1, 3, 4]);
      expect(await physical(every)).toEqual([3, 4]);
      const none = { children: { recurse: true, none: { label: "leaf" } } };
      expect(await visible(none)).toEqual([1, 3, 4]);
      expect(await physical(none)).toEqual([3, 4]);
    });

    test("a closure's self row is the outer row, never filtered again by the related domain", async () => {
      const { db } = context;
      // `only` selects the tombstone 2 at the root; its related domain hides
      // tombstones, yet `self` keeps the row the call already selected.
      const tombstoned = (self: boolean) =>
        db.node.findMany({
          deleted: "only",
          where: {
            parent: {
              recurse: true,
              self,
              some: { deletedAt: { not: null } },
            },
          },
          orderBy: { id: "asc" },
        });
      expect(ids(await tombstoned(true))).toEqual([2]);
      // Without self the closure is {1}, which is live.
      expect(ids(await tombstoned(false))).toEqual([]);
    });

    test("a soft deleteMany whose closure walks its own model: tombstones the visible match, refused on MySQL", async () => {
      const { base, db } = context;
      await expectChangeWalkingItsModel(
        base.$driver,
        "parent",
        async () =>
          (
            await base.node.findMany({
              orderBy: { id: "asc" },
              select: { id: true, deletedAt: true },
            })
          ).map((row) => [row.id, row.deletedAt !== null]),
        () =>
          db.node.deleteMany({
            where: { parent: { recurse: true, some: { id: 1 } } },
          }),
        {
          result: { count: 1 },
          state: [
            [1, false],
            [2, true],
            [3, false],
            [4, true],
          ],
        }
      );
    });

    test("a hidden polymorphic arm stored on the parent row reads null (R1)", async () => {
      const { base, db } = context;
      const read = {
        orderBy: { id: "asc" },
        include: { subject: true },
      } as const;
      const subjects = (
        rows: readonly {
          subject: { type: string; data: { id: number } } | null;
        }[]
      ) =>
        rows.map((row) =>
          row.subject ? `${row.subject.type}:${row.subject.data.id}` : null
        );
      // Pin 1 claims post 11, a tombstone: hidden, not missing.
      expect(subjects(await db.pin.findMany(read))).toEqual([null, "post:10"]);
      expect(
        subjects(await db.pin.findMany({ ...read, deleted: "with" }))
      ).toEqual(["post:11", "post:10"]);
      expect(subjects(await base.pin.findMany(read))).toEqual([
        "post:11",
        "post:10",
      ]);
      const selected = await db.pin.findUniqueOrThrow({
        where: { id: 1 },
        select: { subject: { post: { select: { title: true } } } },
      });
      expect(selected.subject).toBeNull();
    });

    test("a required polymorphic arm stored on the parent row reads null when hidden, and a missing one still fails (R1)", async () => {
      const { base, db } = context;
      const read = {
        orderBy: { id: "asc" },
        include: { subject: true },
      } as const;
      const subjects = (
        rows: readonly {
          subject: { type: string; data: { id: number } } | null;
        }[]
      ) =>
        rows.map((row) =>
          row.subject ? `${row.subject.type}:${row.subject.data.id}` : null
        );
      // Stamp 1 claims post 11, a tombstone: hidden, although the slot is
      // required.
      expect(subjects(await db.stamp.findMany(read))).toEqual([
        null,
        "post:10",
      ]);
      expect(
        subjects(await db.stamp.findMany({ ...read, deleted: "with" }))
      ).toEqual(["post:11", "post:10"]);
      expect(subjects(await base.stamp.findMany(read))).toEqual([
        "post:11",
        "post:10",
      ]);
      const ident = base.$driver.adapter.identifiers.escape;
      const table = base.$driver.adapter.identifiers.table;
      await base.$executeRaw(
        sql`UPDATE ${table("stamp")} SET ${ident("subject_id")} = ${999} WHERE ${ident("id")} = ${2}`
      );
      const refused = await failure(db.stamp.findMany(read));
      expect(refused).toBeInstanceOf(QueryEngineError);
      expect((refused as Error).message).toBe(
        "Polymorphic relation 'subject' references a missing 'post' record."
      );
    });

    test("physical integrity stays physical: a missing arm row, an orphan in an excluded arm and a duplicate singular membership still fail", async () => {
      const { base, db } = context;
      const client = base;
      const ident = client.$driver.adapter.identifiers.escape;
      const table = client.$driver.adapter.identifiers.table;
      // Pin 2 now claims a post that does not exist: corruption, whatever
      // the mode, where pin 1's tombstone reads null.
      await client.$executeRaw(
        sql`UPDATE ${table("pin")} SET ${ident("subject_id")} = ${999} WHERE ${ident("id")} = ${2}`
      );
      const missing =
        "Polymorphic relation 'subject' references a missing 'post' record.";
      for (const read of [
        db.pin.findMany({ include: { subject: true } }),
        db.pin.findMany({ include: { subject: true }, deleted: "with" }),
        base.pin.findMany({ include: { subject: true } }),
      ]) {
        const refused = await failure(read);
        expect(refused).toBeInstanceOf(QueryEngineError);
        expect((refused as Error).message).toBe(missing);
      }
      expect(
        await db.pin.findUniqueOrThrow({
          where: { id: 1 },
          include: { subject: true },
        })
      ).toEqual({ id: 1, subject: null });
      // A tag membership of album 1 whose tag is gone fails the read even
      // when `only` excludes the tag arm; album 2's hidden photo is not one.
      await dropConstraints(client, "album_items_tag", "f");
      await client.$executeRaw(
        sql`INSERT INTO ${table("album_items_tag")} (${ident("albumId")}, ${ident("tagId")}) VALUES (${1}, ${999})`
      );
      const orphan = await failure(
        db.album.findUniqueOrThrow({
          where: { id: 1 },
          include: { items: { only: ["photo"] } },
        })
      );
      expect(orphan).toBeInstanceOf(QueryEngineError);
      expect((orphan as Error).message).toBe(
        "Polymorphic relation 'items' references a missing 'tag' record."
      );
      // Photo 2 in both albums: the singular inverse is malformed although
      // the second album is hidden and only one row is visible.
      const second = sql`INSERT INTO ${table("album_items_photo")} (${ident("albumId")}, ${ident("photoId")}) VALUES (${2}, ${2})`;
      if (!(await dropConstraints(client, "album_items_photo", "u"))) {
        // SQLite cannot drop the UNIQUE: the database refuses the state.
        expect(await failure(client.$executeRaw(second))).toBeInstanceOf(Error);
        return;
      }
      await client.$executeRaw(second);
      expect(
        await failure(
          db.photo.findUniqueOrThrow({
            where: { id: 2 },
            include: { album: true },
          })
        )
      ).toMatchObject({ name: "QueryError", code: "V2006" });
    });

    test("the control on a model no entry governs: a no-op where no relation reaches it, `only` reads related rows as `without`", async () => {
      const { db } = context;
      expect(ids(await db.audit.findMany({ deleted: "only" }))).toEqual([1]);
      const tags = await db.tag.findMany({
        deleted: "only",
        orderBy: { id: "asc" },
        include: { posts: { select: { id: true }, orderBy: { id: "asc" } } },
      });
      expect(tags.map((row) => [row.id, ids(row.posts)])).toEqual([
        [1, [10]],
        [2, [13]],
      ]);
    });

    test("nested connect, set, disconnect, update and upsert take related rows: a hidden target is not found and keeps its links", async () => {
      const { base, db } = context;
      expect(
        await failure(
          db.author.update({
            where: { id: 4 },
            data: { posts: { connect: [{ id: 11 }] } },
          })
        )
      ).toBeInstanceOf(NestedWriteError);
      expect(
        await failure(
          db.tag.update({
            where: { id: 2 },
            data: { posts: { set: [{ id: 13 }, { id: 12 }] } },
          })
        )
      ).toBeInstanceOf(NestedWriteError);
      expect(
        await failure(
          db.author.update({
            where: { id: 1 },
            data: {
              posts: {
                update: [{ where: { id: 11 }, data: { title: "hidden" } }],
              },
            },
          })
        )
      ).toBeInstanceOf(NestedWriteError);
      // A hidden key is not a candidate: the upsert's create arm meets it.
      expect(
        await failure(
          db.author.update({
            where: { id: 1 },
            data: {
              posts: {
                upsert: [
                  {
                    where: { id: 11 },
                    create: { id: 11, title: "again", slug: "s11-again" },
                    update: { title: "hidden" },
                  },
                ],
              },
            },
          })
        )
      ).toBeInstanceOf(UniqueConstraintError);
      expect(
        (await base.post.findUniqueOrThrow({ where: { id: 11 } })).title
      ).toBe("b");
      // `with` sees every row: the connect links the tombstone.
      await db.tag.update({
        where: { id: 2 },
        data: { posts: { connect: [{ id: 12 }] } },
        deleted: "with",
      });
      const links = async () =>
        (
          await base.tag.findMany({
            orderBy: { id: "asc" },
            include: {
              posts: { select: { id: true }, orderBy: { id: "asc" } },
            },
          })
        ).map((row) => [row.id, ids(row.posts)]);
      // A disconnect takes related rows too: the tombstone is not found, and
      // keeps its link for a restore.
      expect(
        await failure(
          db.tag.update({
            where: { id: 1 },
            data: { posts: { disconnect: [{ id: 11 }] } },
          })
        )
      ).toBeInstanceOf(NestedWriteError);
      // A set replaces the members the call sees: the tombstone stays linked.
      await db.tag.update({ where: { id: 1 }, data: { posts: { set: [] } } });
      expect(await links()).toEqual([
        [1, [11]],
        [2, [12, 13]],
      ]);
      // `with` sees every row: the disconnect detaches the tombstone.
      await db.tag.update({
        where: { id: 1 },
        data: { posts: { disconnect: [{ id: 11 }] } },
        deleted: "with",
      });
      expect(await links()).toEqual([
        [1, []],
        [2, [12, 13]],
      ]);
    });

    test("a nested delete of a model with rows and no deletion entry takes the related domain: a hidden target is not found and stays", async () => {
      const { base, narrow } = context;
      // Under `narrow`, `comment` declares rows but no deletion entry: its
      // deletes are physical, and a nested one looks its target up in the
      // call's related domain, as every nested write lookup does.
      expect(
        await failure(
          narrow.post.update({
            where: { id: 10 },
            data: { comments: { delete: [{ id: 101 }] } },
          })
        )
      ).toBeInstanceOf(NestedWriteError);
      expect(
        await base.comment.findUnique({ where: { id: 101 } })
      ).not.toBeNull();
      // A visible target is deleted physically; the base client, reading no
      // domain, deletes the hidden one.
      await narrow.post.update({
        where: { id: 10 },
        data: { comments: { delete: [{ id: 100 }] } },
      });
      await base.post.update({
        where: { id: 10 },
        data: { comments: { delete: [{ id: 101 }] } },
      });
      expect(await base.comment.findMany({ where: { postId: 10 } })).toEqual(
        []
      );
    });

    test("root and nested bulk writes take their domain's rows", async () => {
      const { base, db } = context;
      expect(
        await db.post.updateMany({
          where: { authorId: 1 },
          data: { title: "bulk" },
        })
      ).toEqual({ count: 2 });
      await db.author.update({
        where: { id: 2 },
        data: {
          posts: { updateMany: { where: {}, data: { title: "nested" } } },
        },
      });
      const titles = await base.post.findMany({
        where: { authorId: { in: [1, 2] } },
        orderBy: { id: "asc" },
        select: { id: true, title: true },
      });
      expect(titles).toEqual([
        { id: 10, title: "bulk" },
        { id: 11, title: "b" },
        { id: 12, title: "a" },
        { id: 13, title: "nested" },
        { id: 14, title: "bulk" },
        { id: 15, title: "e" },
        { id: 16, title: "f" },
      ]);
      expect(
        await db.post.updateMany({
          where: { authorId: 1 },
          data: { title: "bin" },
          deleted: "only",
        })
      ).toEqual({ count: 1 });
    });

    test("root update and upsert take the root domain: a hidden key is not found, conflicts on create, and is never resurrected", async () => {
      const { base, db } = context;
      expect(
        await failure(
          db.post.update({ where: { id: 11 }, data: { title: "hidden" } })
        )
      ).toBeInstanceOf(NotFoundError);
      expect(
        await db.post.update({
          where: { id: 11 },
          data: { title: "seen" },
          deleted: "with",
          select: { id: true, title: true },
        })
      ).toEqual({ id: 11, title: "seen" });
      // Consumer 4: the hidden conflict surfaces the create arm's own error.
      const conflict = await failure(
        db.post.upsert({
          where: { slug: "s12" },
          create: { id: 99, title: "new", slug: "s12", authorId: 1 },
          update: { title: "hidden" },
        })
      );
      expect(conflict).toBeInstanceOf(UniqueConstraintError);
      expect(
        await base.post.findUniqueOrThrow({
          where: { id: 12 },
          select: { title: true, deletedAt: true },
        })
      ).toEqual({ title: "a", deletedAt: T });
      expect(await base.post.findUnique({ where: { id: 99 } })).toBeNull();
      // `with` makes the tombstone the update candidate; it stays one.
      expect(
        await db.post.upsert({
          where: { slug: "s12" },
          create: { id: 99, title: "new", slug: "s12", authorId: 1 },
          update: { title: "updated" },
          deleted: "with",
          select: { title: true, deletedAt: true },
        })
      ).toEqual({ title: "updated", deletedAt: T });
    });

    test("the call's own earlier write of a domain field is seen by its later lookups", async () => {
      const { base, db } = context;
      const deleted = await failure(
        db.author.update({
          where: { id: 1 },
          data: {
            posts: {
              delete: [{ id: 14 }],
              update: [{ where: { id: 14 }, data: { title: "after" } }],
            },
          },
        })
      );
      expect(deleted).toBeInstanceOf(NestedWriteError);
      expect((deleted as NestedWriteError).message).toContain(
        "target record was not found"
      );
      // The call rolled back as one unit: neither write landed.
      expect(
        await base.post.findUniqueOrThrow({
          where: { id: 14 },
          select: { title: true, deletedAt: true },
        })
      ).toEqual({ title: "d", deletedAt: null });
      // A lookup the domain narrows reads the domain's fields, so the call's
      // own write of one is an earlier write it depends on. A parent-held
      // connect that write consumes has no order that satisfies it: refused.
      const parent = await failure(
        db.node.update({
          where: { id: 4 },
          data: { deletedAt: T, parent: { connect: { id: 4 } } },
        })
      );
      expect(parent).toBeInstanceOf(NestedWriteError);
      expect((parent as NestedWriteError).message).toContain(
        "depends on an earlier 'update' target write"
      );
      // A lookup that reads a to-many relation reads its domain's fields too:
      // once comment 100 is hidden, post 10 has no visible comment.
      const related = await failure(
        db.comment.update({
          where: { id: 100 },
          data: {
            deletedAt: T,
            post: {
              update: {
                where: { comments: { some: {} } },
                data: { title: "commented" },
              },
            },
          },
        })
      );
      expect(related).toBeInstanceOf(NestedWriteError);
      expect((related as NestedWriteError).message).toContain(
        "target record was not found"
      );
      expect(
        await base.node.findUniqueOrThrow({
          where: { id: 4 },
          select: { parentId: true, deletedAt: true },
        })
      ).toEqual({ parentId: 1, deletedAt: null });
      expect(
        await base.post.findUniqueOrThrow({
          where: { id: 10 },
          select: { title: true },
        })
      ).toEqual({ title: "a" });
    });

    test("a soft delete's referential requirement reads the default related domain, never the call's", async () => {
      const { base, narrow } = context;
      // Under `narrow` no comment is visible, yet comment 100 still refuses.
      expect(
        await narrow.post.findUniqueOrThrow({
          where: { id: 10 },
          select: { comments: { select: { id: true } } },
          deleted: "narrow",
        })
      ).toEqual({ comments: [] });
      expect(
        await failure(
          narrow.post.delete({ where: { id: 10 }, deleted: "narrow" })
        )
      ).toBeInstanceOf(ForeignKeyError);
      expect(
        (await base.post.findUniqueOrThrow({ where: { id: 10 } })).deletedAt
      ).toBeNull();
      // Post 14 has no comment: the same call tombstones it.
      await narrow.post.delete({ where: { id: 14 }, deleted: "narrow" });
      expect(
        (await base.post.findUniqueOrThrow({ where: { id: 14 } })).deletedAt
      ).toBeInstanceOf(Date);
    });

    test("connectOrCreate adopts the row an earlier entry of the same call creates", async () => {
      const { db } = context;
      const author = await db.author.update({
        where: { id: 4 },
        data: {
          posts: {
            connectOrCreate: [
              {
                where: { slug: "fresh" },
                create: { id: 40, title: "f", slug: "fresh" },
              },
              {
                where: { slug: "fresh" },
                create: { id: 41, title: "g", slug: "fresh" },
              },
            ],
          },
        },
        include: { posts: { select: { id: true } } },
      });
      expect(ids(author.posts)).toEqual([40]);
    });
  });
}
