import { createClient } from "@client/client";
import type { AnyDriver } from "@drivers";
import { SQLite3Driver } from "@drivers/sqlite3";
import { s } from "@schema";
import {
  type PGliteSchemaFamily,
  usePGliteSchemaFamily,
} from "@tests/fixtures/drivers/pglite";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import { describe, expect, test } from "vitest";

/**
 * engine-04: a to-many payload runs in the relation body's canonical verb order
 * — `disconnect, delete, set, updateMany, deleteMany, update, upsert,
 * connectOrCreate, connect, create, createMany` — whatever order the caller
 * spells its keys in. Until 1.2.0 the validator refused an adding verb spelled
 * before a clearing one; every case here runs the adding-first spelling AND the
 * canonical spelling on SQLite and PGlite and requires one persisted answer, the
 * clear-first one, across a junction (m:n), a foreign key (1:n) and a
 * polymorphic collection.
 */
const schema = (() => {
  const post = s
    .model({
      id: s.string().id(),
      tags: s.toMany(() => tag),
    })
    .map("vso_posts");
  const tag = s
    .model({
      id: s.string().id(),
      posts: s.toMany(() => post),
    })
    .map("vso_tags");
  const basket = s
    .model({
      id: s.string().id(),
      lines: s.toMany(() => line),
    })
    .map("vso_baskets");
  const line = s
    .model({
      id: s.string().id(),
      basketId: s.string(),
      basket: s
        .toOne(() => basket)
        .fields("basketId")
        .references("id")
        .onDelete("cascade"),
    })
    .map("vso_lines");
  const article = s.model({ id: s.string().id() }).map("vso_articles");
  const photo = s.model({ id: s.string().id() }).map("vso_photos");
  const board = s
    .model({
      id: s.string().id(),
      items: s.toMany(
        { article: () => article, photo: () => photo },
        { values: { article: "vso.article.v1", photo: "vso.photo.v1" } }
      ),
    })
    .map("vso_boards");
  return { post, tag, basket, line, article, photo, board };
})();

type Client = PGliteSchemaFamily<typeof schema>["client"];

async function seed(client: Client): Promise<void> {
  await client.tag.create({ data: { id: "t1" } });
  await client.tag.create({ data: { id: "t2" } });
  await client.post.create({
    data: { id: "p", tags: { connect: [{ id: "t1" }] } },
  });
  await client.basket.create({
    data: { id: "b", lines: { create: [{ id: "q" }] } },
  });
  await client.photo.create({ data: { id: "ph1" } });
  await client.board.create({
    data: {
      id: "w",
      items: { create: [{ type: "article", data: { id: "a1" } }] },
    },
  });
}

async function persisted(client: Client) {
  const post = await client.post.findUniqueOrThrow({
    where: { id: "p" },
    include: { tags: { orderBy: { id: "asc" } } },
  });
  const basket = await client.basket.findUniqueOrThrow({
    where: { id: "b" },
    include: { lines: { orderBy: { id: "asc" } } },
  });
  const board = await client.board.findUniqueOrThrow({
    where: { id: "w" },
    include: { items: true },
  });
  return {
    postTags: post.tags.map((row) => row.id),
    tags: (await client.tag.findMany({ orderBy: { id: "asc" } })).map(
      (row) => row.id
    ),
    basketLines: basket.lines.map((row) => row.id),
    boardItems: board.items.map((item) => `${item.type}:${item.data.id}`),
    articles: (await client.article.findMany()).map((row) => row.id),
    photos: (await client.photo.findMany({ orderBy: { id: "asc" } })).map(
      (row) => row.id
    ),
  };
}

type State = Awaited<ReturnType<typeof persisted>>;

const BASELINE: State = {
  postTags: ["t1"],
  tags: ["t1", "t2"],
  basketLines: ["q"],
  boardItems: ["article:a1"],
  articles: ["a1"],
  photos: ["ph1"],
};

interface SpellingCase {
  readonly name: string;
  /** The caller's adding-first spelling, refused by the 1.1.0 validator. */
  readonly addingFirst: (client: Client) => Promise<unknown>;
  /** The same verbs spelled in the canonical clear-first order. */
  readonly canonical: (client: Client) => Promise<unknown>;
  readonly expected: State;
}

const connectT2 = { connect: [{ id: "t2" }] };
const connectPhoto = {
  connect: [{ type: "photo" as const, where: { id: "ph1" } }],
};

const cases: readonly SpellingCase[] = [
  {
    name: "m:n {connect, disconnect} swaps the member",
    addingFirst: (client) =>
      client.post.update({
        where: { id: "p" },
        data: {
          tags: { connect: [{ id: "t2" }], disconnect: [{ id: "t1" }] },
        },
      }),
    canonical: (client) =>
      client.post.update({
        where: { id: "p" },
        data: {
          tags: { disconnect: [{ id: "t1" }], connect: [{ id: "t2" }] },
        },
      }),
    expected: { ...BASELINE, postTags: ["t2"] },
  },
  {
    name: "m:n {...{connect}, set: []} clears, then connects",
    addingFirst: (client) =>
      client.post.update({
        where: { id: "p" },
        data: { tags: { ...connectT2, set: [] } },
      }),
    canonical: (client) =>
      client.post.update({
        where: { id: "p" },
        data: { tags: { set: [], ...connectT2 } },
      }),
    expected: { ...BASELINE, postTags: ["t2"] },
  },
  {
    // The one target named by a clearing AND an adding verb: clear-first makes
    // it a member. Run in spelling order, the same payload would end without it.
    name: "m:n {connect: t1, disconnect: t1} keeps t1 a member",
    addingFirst: (client) =>
      client.post.update({
        where: { id: "p" },
        data: { tags: { connect: [{ id: "t1" }], disconnect: [{ id: "t1" }] } },
      }),
    canonical: (client) =>
      client.post.update({
        where: { id: "p" },
        data: { tags: { disconnect: [{ id: "t1" }], connect: [{ id: "t1" }] } },
      }),
    expected: BASELINE,
  },
  {
    name: "1:n {create, delete} replaces the child",
    addingFirst: (client) =>
      client.basket.update({
        where: { id: "b" },
        data: { lines: { create: [{ id: "r" }], delete: [{ id: "q" }] } },
      }),
    canonical: (client) =>
      client.basket.update({
        where: { id: "b" },
        data: { lines: { delete: [{ id: "q" }], create: [{ id: "r" }] } },
      }),
    expected: { ...BASELINE, basketLines: ["r"] },
  },
  {
    name: "polymorphic {connect, disconnect} swaps the member",
    addingFirst: (client) =>
      client.board.update({
        where: { id: "w" },
        data: {
          items: {
            ...connectPhoto,
            disconnect: [{ type: "article", where: { id: "a1" } }],
          },
        },
      }),
    canonical: (client) =>
      client.board.update({
        where: { id: "w" },
        data: {
          items: {
            disconnect: [{ type: "article", where: { id: "a1" } }],
            ...connectPhoto,
          },
        },
      }),
    expected: { ...BASELINE, boardItems: ["photo:ph1"] },
  },
  {
    name: "polymorphic {...{connect}, set: []} clears, then connects",
    addingFirst: (client) =>
      client.board.update({
        where: { id: "w" },
        data: { items: { ...connectPhoto, set: [] } },
      }),
    canonical: (client) =>
      client.board.update({
        where: { id: "w" },
        data: { items: { set: [], ...connectPhoto } },
      }),
    expected: { ...BASELINE, boardItems: ["photo:ph1"] },
  },
  {
    name: "polymorphic {create, delete} replaces the member",
    addingFirst: (client) =>
      client.board.update({
        where: { id: "w" },
        data: {
          items: {
            create: [{ type: "photo", data: { id: "ph2" } }],
            delete: [{ type: "article", where: { id: "a1" } }],
          },
        },
      }),
    canonical: (client) =>
      client.board.update({
        where: { id: "w" },
        data: {
          items: {
            delete: [{ type: "article", where: { id: "a1" } }],
            create: [{ type: "photo", data: { id: "ph2" } }],
          },
        },
      }),
    expected: {
      ...BASELINE,
      boardItems: ["photo:ph2"],
      articles: [],
      photos: ["ph1", "ph2"],
    },
  },
];

async function outcome(
  client: Client,
  act: (client: Client) => Promise<unknown>
): Promise<State> {
  await seed(client);
  await act(client);
  return persisted(client);
}

describe("to-many verbs run clear-first whatever their spelling: SQLite", () => {
  async function onSQLite(
    act: (client: Client) => Promise<unknown>
  ): Promise<State> {
    const driver: AnyDriver = new SQLite3Driver({ dataDir: ":memory:" });
    const client = createClient({ schema, driver });
    try {
      await syncLiveSchema(client);
      return await outcome(client, act);
    } finally {
      await client.$disconnect();
    }
  }

  for (const spelling of cases)
    test(spelling.name, async () => {
      const addingFirst = await onSQLite(spelling.addingFirst);
      expect(addingFirst).toEqual(await onSQLite(spelling.canonical));
      expect(addingFirst).toEqual(spelling.expected);
    });
});

describe("to-many verbs run clear-first whatever their spelling: PGlite", () => {
  const family = usePGliteSchemaFamily(schema);
  async function onPGlite(
    act: (client: Client) => Promise<unknown>
  ): Promise<State> {
    await family().reset();
    return outcome(family().client, act);
  }

  for (const spelling of cases)
    test(spelling.name, async () => {
      const addingFirst = await onPGlite(spelling.addingFirst);
      expect(addingFirst).toEqual(await onPGlite(spelling.canonical));
      expect(addingFirst).toEqual(spelling.expected);
    });
});
