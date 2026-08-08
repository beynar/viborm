import { createClient as PGliteCreateClient } from "@drivers/pglite";
import { push } from "@migrations";
import { s } from "@schema";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "vitest";

const person = s
  .model({
    id: s.string().id(),
    name: s.string(),
    authoredArticles: s.oneToMany(() => article).name("author"),
    coAuthoredArticles: s.oneToMany(() => article).name("coAuthor"),
  })
  .map("named_inverse_people");

const article = s
  .model({
    id: s.string().id(),
    title: s.string(),
    authorId: s.string().nullable(),
    coAuthorId: s.string().nullable(),
    author: s
      .manyToOne(() => person)
      .fields("authorId")
      .references("id")
      .optional()
      .name("author"),
    coAuthor: s
      .manyToOne(() => person)
      .fields("coAuthorId")
      .references("id")
      .optional()
      .name("coAuthor"),
  })
  .map("named_inverse_articles");

const schema = { person, article };

let client: Awaited<
  ReturnType<
    typeof PGliteCreateClient<typeof schema, { schema: typeof schema }>
  >
>;

beforeAll(async () => {
  client = PGliteCreateClient({ schema });
  await push(client, { force: true });
});

afterAll(async () => {
  await client.$disconnect();
});

beforeEach(async () => {
  await client.article.deleteMany();
  await client.person.deleteMany();
});

describe("Named Inverse Nested Writes", () => {
  test("create writes named inverse relations to their matching FK columns", async () => {
    await client.person.create({
      data: {
        id: "person-1",
        name: "Alice",
        authoredArticles: {
          create: {
            id: "article-1",
            title: "Primary author",
            coAuthorId: null,
          },
        },
        coAuthoredArticles: {
          create: {
            id: "article-2",
            title: "Secondary author",
            authorId: null,
          },
        },
      },
    });

    const articles = await client.article.findMany({
      orderBy: { id: "asc" },
    });

    expect(articles).toEqual([
      {
        id: "article-1",
        title: "Primary author",
        authorId: "person-1",
        coAuthorId: null,
      },
      {
        id: "article-2",
        title: "Secondary author",
        authorId: null,
        coAuthorId: "person-1",
      },
    ]);
  });
});
