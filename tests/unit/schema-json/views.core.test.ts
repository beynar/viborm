/**
 * Views in the document: `views` beside `models`, read through `s.view`.
 *
 * The document states what `s.view` takes (the source's key, the query, the
 * name) and nothing it derives, so both directions are proven against the
 * derivation itself: the view facts and the derived scalars and keys of the
 * schema a document parses into.
 */

import { ValidationError } from "@errors";
import { s } from "@schema";
import type { Schema } from "@schema/hydration";
import {
  parseSchema,
  type SchemaDocument,
  serializeSchema,
} from "@schema/json";
import type { Scalar } from "@schema/scalars/base";
import { viewFacts } from "@schema/view/facts";
import { sql } from "@sql";
import { validateSchema } from "@src/schema/validation";
import { describe, expect, it } from "vitest";

const user = s.model({
  id: s.string().id(),
  email: s.string().unique(),
  name: s.string(),
  posts: s.toMany(() => post),
});
const post = s.model({
  id: s.string().id(),
  title: s.string(),
  published: s.boolean(),
  createdAt: s.dateTime(),
  readCount: s.bigInt(),
  authorId: s.string(),
  author: s
    .toOne(() => user)
    .fields("authorId")
    .references("id"),
});
const publishedPost = s
  .view(() => post, {
    where: {
      published: true,
      createdAt: { gt: new Date("2020-01-02T03:04:05.000Z") },
      readCount: { gte: 5n },
    },
    select: {
      id: true,
      title: true,
      authorId: true,
      author: { select: { name: true } },
      _count: true,
    },
  })
  .map("published_posts");
// A view over a view, declared before the view it reads.
const postTitle = s.view(() => publishedPost, {
  select: { id: true, title: true, author: true },
});
const author = s.view(() => user, { omit: { email: true } });

const schema = { user, post, postTitle, publishedPost, author };

const DOCUMENT: SchemaDocument = {
  version: 1,
  models: {
    user: {
      fields: {
        id: { type: "string", id: true },
        email: { type: "string", unique: true },
        name: { type: "string" },
        posts: { type: "toMany", target: "post" },
      },
    },
    post: {
      fields: {
        id: { type: "string", id: true },
        title: { type: "string" },
        published: { type: "boolean" },
        createdAt: { type: "datetime" },
        readCount: { type: "bigint" },
        authorId: { type: "string" },
        author: {
          type: "toOne",
          target: "user",
          fields: ["authorId"],
          references: ["id"],
        },
      },
    },
  },
  views: {
    postTitle: {
      source: "publishedPost",
      query: { select: { id: true, title: true, author: true } },
    },
    publishedPost: {
      source: "post",
      query: {
        where: {
          published: true,
          createdAt: { gt: { $date: "2020-01-02T03:04:05.000Z" } },
          readCount: { gte: { $bigint: "5" } },
        },
        select: {
          id: true,
          title: true,
          authorId: true,
          author: { select: { name: true } },
          _count: true,
        },
      },
      table: "published_posts",
    },
    author: { source: "user", query: { omit: { email: true } } },
  },
};

/** What `s.view` derived for a view: its facts and its derived model state. */
function derived(model: Schema[string], within: Schema) {
  const facts = viewFacts(model);
  const state = model["~"].state;
  const keyOf = (member: unknown) =>
    Object.entries(within).find(([, candidate]) => candidate === member)?.[0];
  const scalars: Record<string, Scalar> = state.scalars;
  return {
    source: keyOf(facts?.source),
    query: facts?.query,
    documents: facts?.documents,
    table: state.tableName,
    scalars: Object.fromEntries(
      Object.entries(scalars).map(([name, scalar]) => [
        name,
        scalar["~"].state.type,
      ])
    ),
    uniques: Object.keys(state.uniques),
  };
}

function refused(run: () => unknown): string[] {
  try {
    run();
  } catch (thrown) {
    if (thrown instanceof ValidationError) {
      return thrown.issues.map(
        (issue) => `${issue.message.slice(0, 6)} ${issue.path}`
      );
    }
    throw thrown;
  }
  throw new Error("The call accepted what it must refuse");
}

describe("views in a schema document", () => {
  it("a coded schema writes each view as its source key, its query and its name", () => {
    expect(serializeSchema(schema)).toEqual(DOCUMENT);
  });

  it("the document reads back to itself, views in the document's order", () => {
    const parsed = parseSchema(JSON.stringify(DOCUMENT));
    expect(Object.keys(parsed)).toEqual([
      "user",
      "post",
      "postTitle",
      "publishedPost",
      "author",
    ]);
    expect(serializeSchema(parsed)).toEqual(DOCUMENT);
  });

  it("a parsed view is what s.view derives: facts, scalars, keys and documents", () => {
    const parsed = parseSchema(DOCUMENT);
    for (const name of ["publishedPost", "postTitle", "author"] as const) {
      expect(derived(parsed[name]!, parsed)).toEqual(
        derived(schema[name], schema)
      );
    }
    expect(derived(parsed.publishedPost!, parsed)).toMatchObject({
      source: "post",
      // `_count: true` counts no relation of `post`, so it is no column.
      documents: ["author"],
      scalars: { id: "string", title: "string", authorId: "string" },
      table: "published_posts",
    });
    expect(derived(parsed.postTitle!, parsed)).toMatchObject({
      source: "publishedPost",
      documents: ["author"],
    });
    // A tag decodes to the value a coded query holds.
    const where = viewFacts(parsed.publishedPost!)?.query.where;
    expect(where).toEqual({
      published: true,
      createdAt: { gt: new Date("2020-01-02T03:04:05.000Z") },
      readCount: { gte: 5n },
    });
    expect(viewFacts(parsed.author!)?.documents).toEqual([]);
    expect(derived(parsed.author!, parsed).uniques).toEqual(["id"]);
  });

  it("a parsed schema with views is one the validator accepts", () => {
    expect(validateSchema(parseSchema(DOCUMENT)).errors).toEqual([]);
    expect(() => parseSchema(DOCUMENT, { validate: true })).not.toThrow();
  });

  it("a light document's views are light too", () => {
    const light = serializeSchema(parseSchema({ ...DOCUMENT, light: true }));
    expect(light.light).toBe(true);
    expect(light.views).toEqual(DOCUMENT.views);
  });
});

describe("refusals", () => {
  const models = DOCUMENT.models;

  it("a source the document does not declare, a cycle, and a key used twice", () => {
    expect(
      refused(() =>
        parseSchema({
          version: 1,
          models,
          views: {
            missing: { source: "comment", query: {} },
            first: { source: "second", query: {} },
            second: { source: "first", query: {} },
            itself: { source: "itself", query: {} },
            readsCycle: { source: "first", query: {} },
            post: { source: "user", query: {} },
          },
        })
      )
    ).toEqual([
      "[J006] /views/missing/source",
      "[J012] /views/first/source",
      "[J012] /views/second/source",
      "[J012] /views/itself/source",
      "[J013] /views/post",
    ]);
  });

  it("a view node's shape: its keys, its source and its query", () => {
    expect(
      refused(() =>
        parseSchema({
          version: 1,
          models,
          views: {
            "not-a-key": { source: "post", query: {} },
            extra: { source: "post", query: {}, columns: ["id"] },
            noQuery: { source: "post" },
            arrayQuery: { source: "post", query: [] },
            tagged: { source: "post", query: { $date: "2020-01-02" } },
            badTag: { source: "post", query: { where: { $when: 1 } } },
            noSource: { query: {} },
          },
        })
      )
    ).toEqual([
      "[J005] /views/not-a-key",
      "[J003] /views/extra/columns",
      "[J004] /views/noQuery/query",
      "[J004] /views/arrayQuery/query",
      "[J004] /views/tagged/query",
      "[J008] /views/badTag/query/where",
      "[J004] /views/noSource/source",
    ]);
  });

  it("a tag whose payload names nothing is refused where it is decoded", () => {
    expect(
      refused(() =>
        parseSchema({
          version: 1,
          models,
          views: {
            recent: {
              source: "post",
              query: { where: { createdAt: { gt: { $date: "never" } } } },
            },
          },
        })
      )
    ).toEqual(["[J008] /views/recent/query/where/createdAt/gt"]);
  });

  it("a query value the document cannot state is named, not dropped", () => {
    const operand = sql`now()`;
    expect(
      refused(() =>
        serializeSchema({
          user,
          post,
          byFunction: s.view(() => post, {
            where: { title: () => operand },
          }),
          bySql: s.view(() => post, {
            where: { createdAt: { gt: Reflect.get({ operand }, "operand") } },
          }),
        })
      )
    ).toEqual([
      "[J009] /views/byFunction/query/where/title",
      "[J009] /views/bySql/query/where/createdAt/gt",
    ]);
  });

  it("a view whose source is not in the record names its source", () => {
    expect(refused(() => serializeSchema({ publishedPost }))).toEqual([
      "[J006] /views/publishedPost/source",
    ]);
  });

  it("a declaration chained on a view has no spelling in its document", () => {
    const query = { select: { id: true, title: true } } as const;
    const clustered = s.view(() => post, query).withoutRowid();
    const indexed = s
      .view(() => post, query)
      .rawIndex("by_title", { pg: "CREATE INDEX {name} ON {table} ({title})" });
    const hidden = s.view(() => post, query).omit({ title: true });
    expect(
      refused(() => serializeSchema({ user, post, clustered, indexed, hidden }))
    ).toEqual([
      "[J009] /views/clustered",
      "[J009] /views/indexed",
      "[J009] /views/hidden",
    ]);
  });
});

/**
 * A materialized view: `materialized`, written only as `true`, and its
 * indexes in the form a model writes them.
 */
describe("a materialized view in a schema document", () => {
  const digest = s
    .view(() => user, { select: { id: true, name: true } })
    .materialized()
    .index(["name"], { name: "by_name" })
    .index(["id", "name"], { type: "hash" });
  const DIGEST = {
    source: "user",
    query: { select: { id: true, name: true } },
    materialized: true,
    indexes: [
      { fields: ["name"], name: "by_name" },
      { fields: ["id", "name"], type: "hash" },
    ],
  } as const;
  const withDigest = (view: object): SchemaDocument =>
    ({ version: 1, models: DOCUMENT.models, views: { digest: view } }) as never;

  it("writes materialized and the view's indexes, and reads them back to the same view", () => {
    expect(serializeSchema({ user, post, digest }).views).toEqual({
      digest: DIGEST,
    });
    const parsed = parseSchema(JSON.stringify(withDigest(DIGEST)));
    expect(viewFacts(parsed.digest!)?.materialized).toBe(true);
    expect(parsed.digest!["~"].state.indexes).toEqual(
      digest["~"].state.indexes
    );
    expect(serializeSchema(parsed)).toEqual(withDigest(DIGEST));
    expect(validateSchema(parsed).errors).toEqual([]);
  });

  it("a view that is not materialized writes neither", () => {
    expect(
      serializeSchema(
        parseSchema(withDigest({ ...DIGEST, materialized: false, indexes: [] }))
      ).views
    ).toEqual({ digest: { source: "user", query: DIGEST.query } });
  });

  it("refuses a flag that is not a boolean and an index a model's document refuses", () => {
    expect(
      refused(() =>
        parseSchema({
          version: 1,
          models: DOCUMENT.models,
          views: {
            flag: { source: "user", query: {}, materialized: "yes" },
            list: {
              source: "user",
              query: {},
              materialized: true,
              indexes: {},
            },
            partial: {
              source: "user",
              query: {},
              materialized: true,
              indexes: [{ fields: ["name"], where: "name <> ''" }],
            },
          },
        } as never)
      )
    ).toEqual([
      "[J004] /views/flag/materialized",
      "[J004] /views/list/indexes",
      "[J009] /views/partial/indexes/0/where",
    ]);
  });

  it("an index on a view that is not materialized parses, and is W002's to refuse", () => {
    const { materialized: _, ...plain } = DIGEST;
    const parsed = parseSchema(withDigest(plain));
    expect(validateSchema(parsed).errors.map(({ code }) => code)).toEqual([
      "W002",
    ]);
  });
});

describe("an aggregated view in a schema document", () => {
  const totals = s
    .view(() => post, {
      by: [{ createdAt: "day" }, "authorId"],
      timeZone: "Europe/Paris",
      where: { published: true },
      having: { readCount: { _sum: { gt: 5 } } },
      _count: true,
      _sum: { readCount: true },
    })
    .map("post_totals");
  const aggregated = { user, post, totals };
  const AGGREGATED: SchemaDocument = {
    version: 1,
    models: DOCUMENT.models,
    views: {
      totals: {
        source: "post",
        query: {
          by: [{ createdAt: "day" }, "authorId"],
          timeZone: "Europe/Paris",
          where: { published: true },
          having: { readCount: { _sum: { gt: 5 } } },
          _count: true,
          _sum: { readCount: true },
        },
        table: "post_totals",
      },
    },
  };

  it("is written as its source key and its grouping query, a time step and a having included, and reads back to itself", () => {
    expect(serializeSchema(aggregated)).toEqual(AGGREGATED);
    const parsed = parseSchema(JSON.stringify(AGGREGATED));
    expect(serializeSchema(parsed)).toEqual(AGGREGATED);
    expect(validateSchema(parsed).errors).toEqual([]);
  });

  it("a parsed aggregated view derives what s.view derives: its columns, their origins and its key", () => {
    const parsed = parseSchema(AGGREGATED);
    expect(derived(parsed.totals!, parsed)).toEqual(
      derived(totals, aggregated)
    );
    expect(derived(parsed.totals!, parsed).scalars).toEqual({
      createdAt: "string",
      authorId: "string",
      count: "int",
      sumReadCount: "bigint",
    });
    expect(viewFacts(parsed.totals!)?.aggregated?.origins).toEqual(
      viewFacts(totals)?.aggregated?.origins
    );
    expect(Object.keys(parsed.totals!["~"].state.compoundId ?? {})).toEqual([
      "createdAt_authorId",
    ]);
  });
});
