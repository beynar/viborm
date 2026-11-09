/**
 * `push` on SurrealDB, through the public migration client: what it writes, what it
 * reads back, and what it refuses. Gated on SURREAL_TEST_URL.
 */

import { createClient } from "@client/client";
import {
  addDropResolver,
  createMigrationClient,
} from "@migrations/dialects/surrealql";
import { s } from "@schema";
import {
  createSurrealRecordingDriver,
  createSurrealTestDriver,
  surrealUrl,
} from "@tests/fixtures/drivers/surrealdb";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import { describe, expect, it } from "vitest";

type Client = any;

const BUILD_FAILED =
  /^SurrealDB index "item\.item_email_key" failed to build: .*already contains/;

function clientOf(schema: object, driver = createSurrealTestDriver()): Client {
  return createClient({ schema: schema as never, driver });
}

/** The same database under another schema, as a deploy of the next version is. */
function nextVersion(schema: object, previous: Client): Client {
  return clientOf(schema, previous.$driver);
}

const push = async (client: Client) => {
  const migrations = createMigrationClient(client);
  const preview = await migrations.push({ dryRun: true });
  return await migrations.push({ consent: preview.consent });
};

const preview = (client: Client) =>
  createMigrationClient(client).push({ dryRun: true });

const statements = (plan: { statements: readonly { sql: string }[] }) =>
  plan.statements.map(({ sql }) => sql);

const raw = async (client: Client, statement: string) =>
  (await client.$driver._executeRaw(statement)).rows;

async function using(client: Client, body: () => Promise<void>) {
  try {
    await body();
  } finally {
    await client.$disconnect();
  }
}

/** Every kind of table and field a schema can ask for. */
function everything() {
  const author = s
    .model({
      id: s.string().id().map("author_pk"),
      email: s.string().unique().map("author_email"),
      age: s.int().nullable(),
      visits: s.bigInt().default(0n),
      score: s.number().default(1.5),
      active: s.boolean().default(true),
      balance: s.decimal({ precision: 12, scale: 2 }),
      seen: s.dateTime().now(),
      birthday: s.date().nullable(),
      avatar: s.blob().nullable(),
      profile: s.json(),
      notes: s.json().nullable(),
      labels: s.string().array(),
      place: s.point().nullable(),
      value: s.int().default(7),
      bio: s.string().default('it\'s "quoted"\nand long'),
      posts: s.toMany(() => post),
      card: s.toOne(() => card),
    })
    .map("authors")
    .index(["age"])
    .index(["bio"], { unique: true });
  const post = s
    .model({
      id: s.int().id().increment(),
      title: s.string(),
      authorId: s.string().nullable().map("author_fk"),
      author: s
        .toOne(() => author)
        .fields("authorId")
        .references("id")
        .onDelete("setNull")
        .onUpdate("cascade"),
      tags: s.toMany(() => tag),
      slugs: s.toMany(() => slugged),
    })
    .map("posts");
  const tag = s.model({
    id: s.string().id(),
    posts: s.toMany(() => post),
    room: s.toOne(() => shelf),
  });
  const shelf = s.model({
    id: s.string().id(),
    tags: s.toMany({ tag: () => tag }).through({
      tag: { table: "shelf_tags", source: "shelf", target: "tag" },
    }),
  });
  const card = s.model({
    id: s.string().id(),
    authorId: s.string().unique(),
    author: s
      .toOne(() => author)
      .fields("authorId")
      .references("id"),
  });
  const slugged = s.model({
    id: s.string().id(),
    postSlug: s.string().unique(),
    postId: s.int().nullable(),
    post: s
      .toOne(() => post)
      .fields("postId")
      .references("id")
      .onDelete("cascade"),
    readers: s.toMany(() => reader),
  });
  const reader = s.model({
    id: s.string().id(),
    slug: s.string().nullable(),
    target: s
      .toOne(() => slugged)
      .fields("slug")
      .references("postSlug")
      .onUpdate("cascade")
      .onDelete("setNull"),
  });
  const member = s
    .model({
      org: s.string(),
      rank: s.int(),
      email: s.string(),
      badges: s.toMany(() => badge),
    })
    .id(["org", "rank"])
    .unique(["org", "email"]);
  const badge = s.model({
    id: s.string().id(),
    org: s.string(),
    rank: s.int(),
    member: s
      .toOne(() => member)
      .fields("org", "rank")
      .references("org", "rank")
      .onDelete("cascade"),
  });
  const seat = s
    .model({
      roomId: s.string(),
      guestId: s.string(),
      note: s.string().nullable(),
      room: s
        .toOne(() => room)
        .fields("roomId")
        .references("id")
        .onDelete("cascade"),
      guest: s
        .toOne(() => guest)
        .fields("guestId")
        .references("id")
        .onDelete("cascade"),
    })
    .id(["roomId", "guestId"]);
  const room = s.model({
    id: s.string().id(),
    guests: s
      .toMany(() => guest)
      .through(() => seat)
      .source("room")
      .target("guest"),
  });
  const guest = s.model({
    id: s.string().id(),
    rooms: s.toMany(() => room),
  });
  return {
    author,
    post,
    tag,
    shelf,
    card,
    slugged,
    reader,
    member,
    badge,
    seat,
    room,
    guest,
  };
}

describe.skipIf(!surrealUrl)("push on SurrealDB", () => {
  it("what it defined reads back as what was asked: a second push plans nothing", async () => {
    const db = clientOf(everything());
    await using(db, async () => {
      await syncLiveSchema(db);
      const again = await preview(db);
      expect(again.operations).toEqual([]);
      expect(again.outcome).toBe("noop");
      expect(statements(again)).toEqual([]);
    });
  });

  it("a preview changes nothing, and its consent applies exactly that plan", async () => {
    const db = clientOf({ item: s.model({ id: s.string().id() }) });
    await using(db, async () => {
      await (db.$driver as { fresh(): Promise<void> }).fresh();
      const plan = await preview(db);
      expect(plan.outcome).toBe("planned");
      expect(plan.target.dialect).toBe("surrealql");
      await expect(db.item.findMany()).rejects.toThrow();
      const applied = await createMigrationClient(db).push({
        consent: plan.consent,
      });
      expect(applied.outcome).toBe("applied");
      expect(await db.item.findMany()).toEqual([]);
    });
  });

  it("a consent refuses when the database moved since its preview", async () => {
    const db = clientOf({ item: s.model({ id: s.string().id() }) });
    await using(db, async () => {
      await (db.$driver as { fresh(): Promise<void> }).fresh();
      const plan = await preview(db);
      await raw(db, "DEFINE TABLE stray SCHEMAFULL");
      await expect(
        createMigrationClient(db).push({ consent: plan.consent })
      ).rejects.toThrow();
    });
  });

  it("a reference held by events refuses a row naming nothing, as a record's does", async () => {
    const db = clientOf(everything());
    await using(db, async () => {
      await syncLiveSchema(db);
      const refused = { code: "V3002" };
      // To another unique field, from a column that may be unset.
      await db.slugged.create({ data: { id: "s", postSlug: "there" } });
      await expect(
        db.reader.create({ data: { id: "r", slug: "missing" } })
      ).rejects.toMatchObject(refused);
      await db.reader.create({ data: { id: "r", slug: "there" } });
      await db.reader.create({ data: { id: "unset" } });
      await expect(
        db.reader.update({ where: { id: "r" }, data: { slug: "missing" } })
      ).rejects.toMatchObject(refused);
      await db.reader.update({ where: { id: "r" }, data: { slug: null } });
      expect(
        await db.reader.findMany({ orderBy: { id: "asc" } })
      ).toMatchObject([
        { id: "r", slug: null },
        { id: "unset", slug: null },
      ]);
      // Over several columns, to a whole compound key.
      await db.member.create({ data: { org: "o", rank: 1, email: "m" } });
      await expect(
        db.badge.create({ data: { id: "b", org: "o", rank: 2 } })
      ).rejects.toMatchObject(refused);
      await db.badge.create({ data: { id: "b", org: "o", rank: 1 } });
      // From a part of the row's own key.
      await db.guest.create({ data: { id: "g" } });
      await expect(
        db.seat.create({ data: { roomId: "missing", guestId: "g" } })
      ).rejects.toMatchObject(refused);
      await db.room.create({ data: { id: "room" } });
      await db.seat.create({ data: { roomId: "room", guestId: "g" } });
      expect(await db.seat.count()).toBe(1);
    });
  });

  it("defines the forms the driver reads", async () => {
    const db = clientOf(everything());
    await using(db, async () => {
      await (db.$driver as { fresh(): Promise<void> }).fresh();
      const text = statements(await preview(db)).join("\n");
      for (const form of [
        "LIGHTWEIGHT COMMENT",
        "ENFORCED SCHEMAFULL COMMENT",
        "TYPE [org: string, rank: int]",
        "REFERENCE ON DELETE UNSET",
        "DEFINE SEQUENCE posts_seq START 1",
        "math::abs($value) < 10000000000dec",
        "DEFINE FIELD age ON authors TYPE option<i32>",
        "DEFINE FIELD visits ON authors TYPE int DEFAULT",
        "ON member FIELDS org, email UNIQUE",
      ])
        expect(text).toContain(form);
    });
  });
});

describe.skipIf(!surrealUrl)("a change on a populated table", () => {
  const version = (extra: object = {}) => ({
    item: s.model({
      id: s.string().id(),
      name: s.string(),
      ...extra,
    }),
  });

  async function populated(body: (db: Client) => Promise<void>) {
    const db = clientOf(version());
    await using(db, async () => {
      await syncLiveSchema(db);
      await db.item.create({ data: { id: "a", name: "A" } });
      await body(db);
    });
  }

  it("an index holding the key is kept: a page walks it, and a new key restates it", async () => {
    const cards = (key: "id" | "code") => ({
      card: s
        .model({
          id: key === "id" ? s.string().id() : s.string(),
          code: key === "code" ? s.string().id() : s.string(),
          listId: s.string(),
          rank: s.string(),
        })
        .index(["listId", "rank", "code", "id"], { name: "card_walk" }),
    });
    const db = clientOf(cards("id"));
    await using(db, async () => {
      await syncLiveSchema(db);
      await db.card.create({
        data: { id: "a", code: "c1", listId: "l", rank: "1" },
      });
      const columns = async (client: Client) => {
        const [info] = await raw(
          client,
          "RETURN [(INFO FOR TABLE card STRUCTURE).{ indexes }]"
        );
        return (info as { indexes: { name: string; cols: string[] }[] }).indexes
          .filter(({ name }) => name === "card_walk")
          .map(({ cols }) => cols);
      };
      expect(await columns(db)).toEqual([["listId", "rank", "code", "id"]]);
      expect((await preview(db)).outcome).toBe("noop");
      const [plan] = await raw(
        db,
        "LET $plan = (EXPLAIN FORMAT JSON SELECT * FROM card WHERE listId = 'l' ORDER BY rank DESC LIMIT 1); RETURN [$plan]"
      );
      expect(JSON.stringify(plan)).toContain("IndexScan");

      const moved = nextVersion(cards("code"), db);
      await push(moved);
      expect(await columns(moved)).toEqual([
        ["listId", "rank", "id", "id_field"],
      ]);
      expect((await preview(moved)).outcome).toBe("noop");
      expect(
        await moved.card.findMany({
          where: { listId: "l" },
          orderBy: { rank: "desc" },
        })
      ).toEqual([{ id: "a", code: "c1", listId: "l", rank: "1" }]);

      // Back onto a column whose field had to be named apart from the id.
      const back = nextVersion(cards("id"), db);
      await push(back);
      expect(await columns(back)).toEqual([["listId", "rank", "code", "id"]]);
      expect((await preview(back)).outcome).toBe("noop");
      expect(await back.card.findUnique({ where: { id: "a" } })).toEqual({
        id: "a",
        code: "c1",
        listId: "l",
        rank: "1",
      });
    });
  });

  it("an index over the key alone is the id's, and asks for nothing", async () => {
    const db = clientOf({
      card: s
        .model({ id: s.string().id(), rank: s.string() })
        .index(["id"], { name: "card_key" }),
    });
    await using(db, async () => {
      await syncLiveSchema(db);
      const [info] = await raw(
        db,
        "RETURN [(INFO FOR TABLE card STRUCTURE).{ indexes }]"
      );
      expect((info as { indexes: unknown[] }).indexes).toEqual([]);
      expect((await preview(db)).outcome).toBe("noop");
    });
  });

  it("a field that may be unset is added, and existing rows hold nothing", async () => {
    await populated(async (db) => {
      const next = nextVersion(version({ note: s.string().nullable() }), db);
      await push(next);
      expect(await next.item.findMany()).toEqual([
        { id: "a", name: "A", note: null },
      ]);
      expect((await preview(next)).outcome).toBe("noop");
    });
  });

  it("a required field with a default fills the rows already there", async () => {
    await populated(async (db) => {
      const next = nextVersion(version({ rank: s.int().default(3) }), db);
      await push(next);
      expect(await next.item.findMany()).toEqual([
        { id: "a", name: "A", rank: 3 },
      ]);
      await next.item.update({ where: { id: "a" }, data: { name: "B" } });
      expect((await preview(next)).outcome).toBe("noop");
    });
  });

  it("a required field with no default refuses, as on any provider", async () => {
    await populated(async (db) => {
      const next = nextVersion(version({ rank: s.int() }), db);
      await expect(preview(next)).rejects.toThrow(
        'Cannot add required column "item.rank"'
      );
      expect(await db.item.findMany()).toEqual([{ id: "a", name: "A" }]);
    });
  });

  it("dropping a field asks consent, and its values go with it", async () => {
    await populated(async (db) => {
      const wide = nextVersion(version({ note: s.string().nullable() }), db);
      await push(wide);
      await wide.item.update({ where: { id: "a" }, data: { note: "kept" } });
      const narrow = nextVersion(version(), db);
      const plan = await createMigrationClient(narrow).push({
        dryRun: true,
        resolve: addDropResolver,
      });
      expect(plan.destructive).toBe(true);
      await createMigrationClient(narrow).push({ consent: plan.consent });
      const back = nextVersion(version({ note: s.string().nullable() }), db);
      await push(back);
      expect(await back.item.findMany()).toEqual([
        { id: "a", name: "A", note: null },
      ]);
    });
  });

  it("a type the rows might not satisfy is the server's to refuse, and changes nothing", async () => {
    await populated(async (db) => {
      const next = {
        item: s.model({ id: s.string().id(), name: s.int() }),
      };
      const client = nextVersion(next, db);
      await expect(push(client)).rejects.toThrow();
      expect(await db.item.findMany()).toEqual([{ id: "a", name: "A" }]);
      expect((await preview(db)).outcome).toBe("noop");
    });
  });

  it("a stored discriminator the schema no longer declares refuses", async () => {
    const shape = (arm: "clip" | "note") => {
      const book = s.model({ id: s.string().id() });
      const clip = s.model({ id: s.string().id() });
      const note = s.model({ id: s.string().id() });
      const pin = s.model({
        id: s.string().id(),
        target: s
          .toOne(
            (arm === "clip"
              ? { book: () => book, clip: () => clip }
              : { book: () => book, note: () => note }) as never
          )
          .name("target"),
      });
      return { book, clip, note, pin };
    };
    const db = clientOf(shape("clip"));
    await using(db, async () => {
      await syncLiveSchema(db);
      await db.clip.create({ data: { id: "c" } });
      await db.pin.create({
        data: {
          id: "p",
          target: { connect: { type: "clip", where: { id: "c" } } },
        },
      });
      await expect(preview(nextVersion(shape("note"), db))).rejects.toThrow(
        "no longer declares"
      );
    });
  });

  it("an index is built over what is there", async () => {
    const schema = (index: boolean) => {
      const item = s.model({ id: s.string().id(), name: s.string() });
      return { item: index ? item.index(["name"]) : item };
    };
    const db = clientOf(schema(false));
    await using(db, async () => {
      await syncLiveSchema(db);
      await db.item.create({ data: { id: "a", name: "A" } });
      const next = nextVersion(schema(true), db);
      const applied = await push(next);
      // Built at once, as before: only a new table's indexes build in the background.
      expect(statements(applied)).toEqual([
        "DEFINE INDEX item_name_idx ON item FIELDS name;",
      ]);
      expect((await preview(next)).outcome).toBe("noop");
    });
  });

  it("a backfilled field and an index over it arrive in one push", async () => {
    const db = clientOf(version());
    await using(db, async () => {
      await syncLiveSchema(db);
      await db.item.create({ data: { id: "a", name: "A" } });
      const item = s
        .model({
          id: s.string().id(),
          name: s.string(),
          rank: s.int().default(3),
        })
        .index(["rank"]);
      const next = nextVersion({ item }, db);
      await push(next);
      expect(await next.item.findMany({ where: { rank: 3 } })).toEqual([
        { id: "a", name: "A", rank: 3 },
      ]);
      expect((await preview(next)).outcome).toBe("noop");
    });
  });

  it("a unique the rows break refuses, and the whole push with it", async () => {
    const schema = (unique: boolean) => ({
      item: s.model({
        id: s.string().id(),
        name: unique ? s.string().unique() : s.string(),
        note: s.string().nullable(),
      }),
    });
    const db = clientOf(schema(false));
    await using(db, async () => {
      await syncLiveSchema(db);
      await db.item.createMany({
        data: [
          { id: "a", name: "same" },
          { id: "b", name: "same" },
        ],
      });
      const next = {
        item: s.model({
          id: s.string().id(),
          name: s.string().unique(),
          note: s.string().nullable(),
          added: s.string().nullable(),
        }),
      };
      await expect(push(nextVersion(next, db))).rejects.toThrow();
      // The field planned beside it is not there either.
      expect((await preview(db)).outcome).toBe("noop");
    });
  });

  it("a new table, its reference and its action arrive together", async () => {
    await populated(async (db) => {
      const item = s.model({
        id: s.string().id(),
        name: s.string(),
        parts: s.toMany(() => part),
      });
      const part = s.model({
        id: s.string().id(),
        itemId: s.string(),
        item: s
          .toOne(() => item)
          .fields("itemId")
          .references("id")
          .onDelete("cascade"),
      });
      const next = nextVersion({ item, part }, db);
      await push(next);
      await next.part.create({ data: { id: "p", itemId: "a" } });
      await next.item.delete({ where: { id: "a" } });
      expect(await next.part.findMany()).toEqual([]);
      expect((await preview(next)).outcome).toBe("noop");
    });
  });

  it("a link added to a populated table stays unset, and holds a record", async () => {
    const owner = s.model({
      id: s.string().id(),
      items: s.toMany(() => linked),
    });
    const linked = s.model({
      id: s.string().id(),
      name: s.string(),
      ownerId: s.string().nullable(),
      owner: s
        .toOne(() => owner)
        .fields("ownerId")
        .references("id"),
    });
    await populated(async (db) => {
      const bare = nextVersion(
        {
          item: s.model({ id: s.string().id(), name: s.string() }),
          owner: s.model({ id: s.string().id() }),
        },
        db
      );
      await push(bare);
      const next = nextVersion({ item: linked, owner }, db);
      await push(next);
      expect((await preview(next)).outcome).toBe("noop");
      await next.owner.create({ data: { id: "o" } });
      await next.item.update({
        where: { id: "a" },
        data: { owner: { connect: { id: "o" } } },
      });
      expect(
        await next.owner.findMany({ include: { items: true } })
      ).toMatchObject([{ id: "o", items: [{ id: "a", ownerId: "o" }] }]);
    });
  });

  it("dropping a table takes its sequence and the events it left on others", async () => {
    const parent = s.model({
      id: s.string().id(),
      slug: s.string().unique(),
      kids: s.toMany(() => kid),
    });
    const kid = s.model({
      id: s.int().id().increment(),
      parentSlug: s.string().nullable(),
      parent: s
        .toOne(() => parent)
        .fields("parentSlug")
        .references("slug")
        .onDelete("cascade"),
    });
    const db = clientOf({ parent, kid });
    await using(db, async () => {
      await syncLiveSchema(db);
      const alone = {
        parent: s.model({ id: s.string().id(), slug: s.string().unique() }),
      };
      const next = nextVersion(alone, db);
      const migrations = createMigrationClient(next);
      const plan = await migrations.push({
        dryRun: true,
        resolve: addDropResolver,
      });
      await migrations.push({ consent: plan.consent });
      expect((await preview(next)).outcome).toBe("noop");
      const [info] = await raw(next, "RETURN [INFO FOR DB STRUCTURE]");
      expect(info.sequences).toEqual([]);
      const [parentInfo] = await raw(
        next,
        "RETURN [INFO FOR TABLE parent STRUCTURE]"
      );
      expect(parentInfo.events).toEqual([]);
      await next.parent.create({ data: { id: "a", slug: "a" } });
      await next.parent.delete({ where: { id: "a" } });
      expect(await next.parent.findMany()).toEqual([]);
    });
  });
});

describe.skipIf(!surrealUrl)("what SurrealDB has no form for", () => {
  it("a key that changes is planned", async () => {
    const db = clientOf({ item: s.model({ id: s.string().id() }) });
    await using(db, async () => {
      await syncLiveSchema(db);
      const next = nextVersion(
        {
          item: s.model({ code: s.string().id() }).map("item"),
        },
        db
      );
      await expect(
        createMigrationClient(next).push({
          dryRun: true,
          resolve: addDropResolver,
        })
      ).resolves.toMatchObject({ outcome: "planned" });
    });
  });

  it("a partial unique index holds among the rows it names, and a second push plans nothing", async () => {
    const item = s
      .model({
        id: s.string().id(),
        org: s.string(),
        slug: s.string(),
        gone: s.dateTime().nullable(),
      })
      .index(["org", "slug"], { unique: true, where: '"gone" IS NULL' });
    const db = clientOf({ item });
    await using(db, async () => {
      await (db.$driver as { fresh(): Promise<void> }).fresh();
      await push(db);
      expect((await preview(db)).operations).toEqual([]);
      await db.item.create({ data: { id: "a", org: "o", slug: "s" } });
      await db.item.create({ data: { id: "b", org: "o", slug: "t" } });
      await db.item.create({ data: { id: "c", org: "p", slug: "s" } });
      await expect(
        db.item.create({ data: { id: "d", org: "o", slug: "s" } })
      ).rejects.toMatchObject({ code: "V3001" });
      const at = new Date();
      await db.item.update({ where: { id: "a" }, data: { gone: at } });
      await db.item.create({ data: { id: "d", org: "o", slug: "s" } });
      await expect(
        db.item.update({ where: { id: "a" }, data: { gone: null } })
      ).rejects.toMatchObject({ code: "V3001" });
    });
  });

  it("a partial unique index arrives on a populated table, and goes", async () => {
    const plain = {
      item: s.model({
        id: s.string().id(),
        slug: s.string(),
        gone: s.dateTime().nullable(),
      }),
    };
    const partial = {
      item: s
        .model({
          id: s.string().id(),
          slug: s.string(),
          gone: s.dateTime().nullable(),
        })
        .index(["slug"], { unique: true, where: '"gone" IS NULL' }),
    };
    const db = clientOf(plain);
    await using(db, async () => {
      await (db.$driver as { fresh(): Promise<void> }).fresh();
      await push(db);
      await db.item.create({ data: { id: "a", slug: "s" } });
      await db.item.create({ data: { id: "b", slug: "s", gone: new Date() } });
      const indexed = nextVersion(partial, db);
      await push(indexed);
      await expect(
        indexed.item.create({ data: { id: "c", slug: "s" } })
      ).rejects.toMatchObject({ code: "V3001" });
      const back = nextVersion(plain, db);
      await push(back);
      expect((await preview(back)).operations).toEqual([]);
      await back.item.create({ data: { id: "c", slug: "s" } });
    });
  });

  it("a partial unique index's predicate reads a key's value, whole or in part", async () => {
    const single = s
      .model({ id: s.int().id(), email: s.string() })
      .index(["email"], { unique: true, where: '"id" IN (1, 2)' });
    const pair = s
      .model({ org: s.string(), rank: s.int(), email: s.string() })
      .id(["org", "rank"])
      .index(["email"], { unique: true, where: '"rank" < 3' });
    const db = clientOf({ single, pair });
    await using(db, async () => {
      await (db.$driver as { fresh(): Promise<void> }).fresh();
      await push(db);
      expect((await preview(db)).operations).toEqual([]);
      await db.single.create({ data: { id: 1, email: "e" } });
      await expect(
        db.single.create({ data: { id: 2, email: "e" } })
      ).rejects.toMatchObject({ code: "V3001" });
      await db.single.create({ data: { id: 3, email: "e" } });
      await db.pair.create({ data: { org: "o", rank: 1, email: "e" } });
      await expect(
        db.pair.create({ data: { org: "p", rank: 2, email: "e" } })
      ).rejects.toMatchObject({ code: "V3001" });
      await db.pair.create({ data: { org: "p", rank: 3, email: "e" } });
    });
  });

  it("a compound key listed out of its fields' order names its parts as the engine writes them", async () => {
    const shelf = s
      .model({ a: s.int(), b: s.int(), label: s.string() })
      .id(["b", "a"])
      .unique(["b", "label"]);
    const db = clientOf({ shelf });
    await using(db, async () => {
      await (db.$driver as { fresh(): Promise<void> }).fresh();
      await push(db);
      expect((await preview(db)).operations).toEqual([]);
      await db.shelf.create({ data: { a: 1, b: 9, label: "l" } });
      expect(await raw(db, "SELECT a, b FROM shelf")).toEqual([{ a: 1, b: 9 }]);
      await expect(
        db.shelf.create({ data: { a: 2, b: 9, label: "l" } })
      ).rejects.toMatchObject({ code: "V3001" });
      await db.shelf.create({ data: { a: 1, b: 8, label: "l" } });
    });
  });

  it("a partial index over anything but set columns refuses by name", async () => {
    const item = s
      .model({ id: s.string().id(), name: s.string() })
      .index(["name"], { where: "lower(name) = 'a'" } as never);
    const db = clientOf({ item });
    await using(db, async () => {
      await (db.$driver as { fresh(): Promise<void> }).fresh();
      await expect(preview(db)).rejects.toThrow("the partial index");
    });
  });

  it("a unique over a part of a key no name can hold refuses by name", async () => {
    const item = s
      .model({
        price: s.decimal({ precision: 8, scale: 2 }),
        code: s.string(),
        email: s.string(),
      })
      .id(["price", "code"])
      .unique(["code", "email"]);
    const db = clientOf({ item });
    await using(db, async () => {
      await (db.$driver as { fresh(): Promise<void> }).fresh();
      await expect(preview(db)).rejects.toThrow("cannot be named");
    });
  });
});

describe.skipIf(!surrealUrl)("the command's lock", () => {
  const schema = () => ({ item: s.model({ id: s.string().id() }) });

  it("two pushes at once: one applies, the other finds nothing to do", async () => {
    const first = clientOf(schema());
    await using(first, async () => {
      await (first.$driver as { fresh(): Promise<void> }).fresh();
      const second = clientOf(schema());
      await using(second, async () => {
        const plan = await preview(first);
        const outcomes = await Promise.allSettled([
          createMigrationClient(first).push({ consent: plan.consent }),
          createMigrationClient(second).push({ consent: plan.consent }),
        ]);
        const applied = outcomes.filter(
          (outcome) =>
            outcome.status === "fulfilled" &&
            outcome.value.outcome === "applied"
        );
        expect(applied).toHaveLength(1);
        expect((await preview(first)).outcome).toBe("noop");
      });
    });
  });

  it("a lock held by a live command refuses past the wait, and stays", async () => {
    const db = clientOf(schema());
    await using(db, async () => {
      await (db.$driver as { fresh(): Promise<void> }).fresh();
      await raw(
        db,
        "DEFINE TABLE IF NOT EXISTS viborm_migration_lock SCHEMALESS"
      );
      await raw(
        db,
        "CREATE viborm_migration_lock:command SET at = time::now(), token = 'other'"
      );
      const migrations = createMigrationClient(db, {
        limits: { lockWait: 100 },
      });
      const plan = await migrations.push({ dryRun: true });
      await expect(
        migrations.push({ consent: plan.consent })
      ).rejects.toMatchObject({ code: "V11005" });
      const [left] = await raw(db, "SELECT token FROM viborm_migration_lock");
      expect(left.token).toBe("other");
    });
  });

  it("a lock its command died holding is taken over once its lease is up", async () => {
    const db = clientOf(schema());
    await using(db, async () => {
      await (db.$driver as { fresh(): Promise<void> }).fresh();
      await raw(
        db,
        "DEFINE TABLE IF NOT EXISTS viborm_migration_lock SCHEMALESS"
      );
      await raw(
        db,
        "CREATE viborm_migration_lock:command SET at = time::now() - 1h, token = 'dead'"
      );
      expect((await push(db)).outcome).toBe("applied");
      expect(await raw(db, "SELECT * FROM viborm_migration_lock")).toEqual([]);
    });
  });

  it("its own table is no part of a schema", async () => {
    const db = clientOf(schema());
    await using(db, async () => {
      await syncLiveSchema(db);
      expect((await preview(db)).outcome).toBe("noop");
    });
  });

  it("a push that fails lets go of the lock", async () => {
    const db = clientOf({
      item: s.model({ id: s.string().id(), name: s.string() }),
    });
    await using(db, async () => {
      await syncLiveSchema(db);
      await db.item.create({ data: { id: "a", name: "A" } });
      const next = nextVersion(
        { item: s.model({ id: s.string().id(), name: s.int() }) },
        db
      );
      await expect(push(next)).rejects.toThrow();
      expect(await raw(db, "SELECT * FROM viborm_migration_lock")).toEqual([]);
    });
  });
});

describe.skipIf(!surrealUrl)("the indexes of a new table", () => {
  const schema = () => ({
    item: s
      .model({ id: s.string().id(), email: s.string().unique(), rank: s.int() })
      .index(["rank"]),
  });

  it("build in the background, and push returns once each is ready", async () => {
    const driver = createSurrealRecordingDriver();
    const db = clientOf(schema(), driver);
    await using(db, async () => {
      await (driver as unknown as { fresh(): Promise<void> }).fresh();
      const applied = await push(db);
      expect(
        statements(applied).filter((sql) => sql.startsWith("DEFINE INDEX"))
      ).toEqual([
        "DEFINE INDEX item_email_key ON item FIELDS email UNIQUE CONCURRENTLY;",
        "DEFINE INDEX item_rank_idx ON item FIELDS rank CONCURRENTLY;",
      ]);
      // Their builds were read once the program had run, and push returned after.
      const defined = driver.statements.findLastIndex((sql) =>
        sql.includes("CONCURRENTLY")
      );
      expect(
        driver.statements
          .slice(defined)
          .some((sql) => sql.includes("INFO FOR INDEX"))
      ).toBe(true);
      expect(
        await raw(
          db,
          "RETURN [{ email: (INFO FOR INDEX item_email_key ON item).building.status, rank: (INFO FOR INDEX item_rank_idx ON item).building.status }]"
        )
      ).toEqual([{ email: "ready", rank: "ready" }]);
      await db.item.create({ data: { id: "a", email: "same", rank: 1 } });
      await expect(
        db.item.create({ data: { id: "b", email: "same", rank: 2 } })
      ).rejects.toThrow();
      expect((await preview(db)).outcome).toBe("noop");
    });
  });

  it("a build that fails refuses the push by name, its statements committed", async () => {
    const driver = createSurrealRecordingDriver();
    // Two rows holding one email, written in the push's own transaction just
    // ahead of the unique index over it.
    const execute = (driver as any).execute.bind(driver);
    (driver as any).execute = (
      client: never,
      statement: string,
      params: unknown[]
    ) =>
      execute(
        client,
        statement.includes("UNIQUE CONCURRENTLY")
          ? `CREATE item:a SET email = "same", rank = 1; CREATE item:b SET email = "same", rank = 2; ${statement}`
          : statement,
        params
      );
    const db = clientOf(schema(), driver);
    await using(db, async () => {
      await (driver as unknown as { fresh(): Promise<void> }).fresh();
      await expect(push(db)).rejects.toMatchObject({
        code: "V11023",
        message: expect.stringMatching(BUILD_FAILED),
        meta: { table: "item", indexName: "item_email_key" },
      });
      // What the program did is there, and the lock is let go.
      expect(await raw(db, "SELECT email FROM item ORDER BY id")).toEqual([
        { email: "same" },
        { email: "same" },
      ]);
      expect(await raw(db, "SELECT * FROM viborm_migration_lock")).toEqual([]);
    });
  });
});

describe.skipIf(!surrealUrl)("force reset", () => {
  it("clears the database, sequences and events too, and defines the schema anew", async () => {
    const parent = s.model({
      id: s.string().id(),
      slug: s.string().unique(),
      kids: s.toMany(() => kid),
    });
    const kid = s.model({
      id: s.int().id().increment(),
      parentSlug: s.string().nullable(),
      parent: s
        .toOne(() => parent)
        .fields("parentSlug")
        .references("slug")
        .onDelete("cascade"),
    });
    const db = clientOf({ parent, kid });
    await using(db, async () => {
      await syncLiveSchema(db);
      await db.parent.create({ data: { id: "a", slug: "a" } });
      await db.kid.create({ data: { parentSlug: "a" } });
      const migrations = createMigrationClient(db);
      const plan = await migrations.push({ dryRun: true, forceReset: true });
      expect(plan.destructive).toBe(true);
      await migrations.push({ consent: plan.consent });
      expect(await db.parent.findMany()).toEqual([]);
      expect((await db.kid.create({ data: {} })).id).toBe(1);
      expect((await preview(db)).outcome).toBe("noop");
    });
  });
});
