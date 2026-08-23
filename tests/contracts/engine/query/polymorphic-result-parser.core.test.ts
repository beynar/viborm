import { PostgresAdapter } from "@adapters/databases/postgres/postgres-adapter";
import { SQLiteAdapter } from "@adapters/databases/sqlite/sqlite-adapter";
import { D1Driver } from "@drivers/d1";
import { QueryEngineError } from "@errors";
import { parseResult } from "@query-engine/result/ResultParser";
import {
  POLYMORPHIC_RESULT_STATE_INVALID,
  POLYMORPHIC_RESULT_STATE_KEY,
  POLYMORPHIC_RESULT_STATE_LINKED,
} from "@query-engine/result-aliases";
import { s } from "@schema";
import { parserFor, prepareSchema } from "@tests/fixtures/query-scope";
import { describe, expect, it } from "vitest";

const models = (() => {
  const video = s.model({
    id: s.string().id(),
    duration: s.int(),
  });
  const post = s.model({
    id: s.string().id(),
    publishedAt: s.dateTime(),
    attachment: s
      .toOne(
        { video: () => video },
        { values: { video: "attachment.video.v1" } }
      )
      .optional(),
  });
  const requiredComment = s.model({
    id: s.string().id(),
    subject: s.toOne(
      { post: () => post, video: () => video },
      {
        values: {
          post: "subject.post.v1",
          video: "subject.video.v1",
        },
      }
    ),
  });
  const optionalComment = s.model({
    id: s.string().id(),
    subject: s
      .toOne(
        { post: () => post, video: () => video },
        {
          values: {
            post: "subject.post.v1",
            video: "subject.video.v1",
          },
        }
      )
      .optional(),
  });
  const schema = { video, post, requiredComment, optionalComment };
  prepareSchema(schema);
  prepareSchema(schema);
  return schema;
})();

const projection = {
  select: {
    id: true,
    subject: {
      post: {
        include: {
          attachment: {
            video: { select: { id: true, duration: true } },
          },
        },
      },
      video: { select: { id: true, duration: true } },
    },
  },
};

function linked(type: string, data: unknown): Record<string, unknown> {
  return {
    [POLYMORPHIC_RESULT_STATE_KEY]: POLYMORPHIC_RESULT_STATE_LINKED,
    type,
    data,
  };
}

function parseRequired(rawSubject: unknown): unknown {
  return parseResult(
    parserFor(new PostgresAdapter(), models.requiredComment),
    "findMany",
    [{ id: "comment-1", subject: rawSubject }],
    projection
  );
}

describe("polymorphic result parsing", () => {
  it("dispatches variants, parses nested targets, and removes the private tag", () => {
    expect(
      parseRequired(
        linked("post", {
          id: "post-1",
          publishedAt: "2026-08-08T10:00:00.000Z",
          attachment: linked("video", {
            id: "video-1",
            duration: 42,
          }),
        })
      )
    ).toEqual([
      {
        id: "comment-1",
        subject: {
          type: "post",
          data: {
            id: "post-1",
            publishedAt: new Date("2026-08-08T10:00:00.000Z"),
            attachment: {
              type: "video",
              data: { id: "video-1", duration: 42 },
            },
          },
        },
      },
    ]);

    expect(
      parseRequired(linked("video", { id: "video-2", duration: 9 }))
    ).toEqual([
      {
        id: "comment-1",
        subject: {
          type: "video",
          data: { id: "video-2", duration: 9 },
        },
      },
    ]);
  });

  it("decodes SQLite JSON text before validating the carrier", () => {
    const parser = parserFor(
      new SQLiteAdapter(),
      models.requiredComment,
      new D1Driver({ database: Object.create(null) })
    );
    const result = parseResult(
      parser,
      "findMany",
      [
        {
          id: "comment-1",
          subject: JSON.stringify(
            linked("video", { id: "video-1", duration: 7 })
          ),
        },
      ],
      projection
    );

    expect(result).toEqual([
      {
        id: "comment-1",
        subject: {
          type: "video",
          data: { id: "video-1", duration: 7 },
        },
      },
    ]);
  });

  it("returns null only for empty optional storage", () => {
    const optionalParser = parserFor(
      new PostgresAdapter(),
      models.optionalComment
    );
    expect(
      parseResult(
        optionalParser,
        "findMany",
        [{ id: "comment-1", subject: null }],
        projection
      )
    ).toEqual([{ id: "comment-1", subject: null }]);

    let optionalError: unknown;
    try {
      parseResult(
        optionalParser,
        "findMany",
        [{ id: "comment-1", subject: linked("post", null) }],
        projection
      );
    } catch (caught) {
      optionalError = caught;
    }
    expect(optionalError).toBeInstanceOf(QueryEngineError);
    expect(optionalError).toMatchObject({
      message:
        "Polymorphic relation 'subject' references a missing 'post' record.",
      meta: {
        model: "optionalComment",
        relation: "subject",
        type: "post",
      },
    });

    let error: unknown;
    try {
      parseRequired(linked("post", null));
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(QueryEngineError);
    expect(error).toMatchObject({
      message:
        "Polymorphic relation 'subject' references a missing 'post' record.",
      meta: {
        model: "requiredComment",
        relation: "subject",
        type: "post",
      },
    });
  });

  it.each([
    ["required empty storage", null],
    [
      "half-null storage",
      {
        [POLYMORPHIC_RESULT_STATE_KEY]: POLYMORPHIC_RESULT_STATE_INVALID,
        storedType: "subject.post.v1",
        hasId: false,
      },
    ],
    ["unknown discriminator", linked("photo", { id: "photo-1" })],
    [
      "unknown carrier tag",
      { [POLYMORPHIC_RESULT_STATE_KEY]: "other", type: "post", data: {} },
    ],
    [
      "unexpected carrier key",
      { ...linked("video", { id: "video-1", duration: 1 }), leaked: true },
    ],
    ["non-object data", linked("video", "invalid")],
    [
      "unexpected target key",
      linked("video", { id: "video-1", duration: 1, leaked: true }),
    ],
    ["missing target key", linked("video", { id: "video-1" })],
  ])("rejects %s", (_label, carrier) => {
    expect(() => parseRequired(carrier)).toThrow(QueryEngineError);
  });
});

// =============================================================================
// DIRECT POLYMORPHIC COLLECTION PARSING
// =============================================================================

const collectionModels = (() => {
  const article = s.model({
    id: s.string().id(),
    title: s.string(),
  });
  const clip = s.model({
    id: s.string().id(),
    seconds: s.int(),
  });
  const gallery = s.model({
    id: s.string().id(),
    items: s.toMany(
      { article: () => article, clip: () => clip },
      { values: { article: "coll.article.v1", clip: "coll.clip.v1" } }
    ),
  });
  const schema = { article, clip, gallery };
  prepareSchema(schema);
  prepareSchema(schema);
  return schema;
})();

type Arm = {
  membership?: unknown;
  orphans?: unknown;
  rows?: unknown;
};

function arm(rows: unknown, overrides: Arm = {}): Record<string, unknown> {
  return { membership: 0, orphans: 0, rows, ...overrides };
}

function collection(arms: Record<string, unknown>): Record<string, unknown> {
  return { [POLYMORPHIC_RESULT_STATE_KEY]: "collection", arms };
}

/**
 * Parse one owner row through the real shape builder — `projection` is the same
 * args object the read compiled from, so shape and carrier cannot drift.
 */
function parseCollection(
  rawItems: unknown,
  projection: Record<string, unknown> = { select: { id: true, items: true } }
): unknown {
  return parseResult(
    parserFor(new PostgresAdapter(), collectionModels.gallery),
    "findMany",
    [{ id: "gallery-1", items: rawItems }],
    projection
  );
}

describe("polymorphic collection result parsing", () => {
  it("flattens allow-listed arms in declaration order into a fresh array", () => {
    expect(
      parseCollection(
        collection({
          article: arm([
            linked("article", { id: "a1", title: "first" }),
            linked("article", { id: "a2", title: "second" }),
          ]),
          clip: arm([linked("clip", { id: "c1", seconds: 12 })]),
        })
      )
    ).toEqual([
      {
        id: "gallery-1",
        items: [
          { type: "article", data: { id: "a1", title: "first" } },
          { type: "article", data: { id: "a2", title: "second" } },
          { type: "clip", data: { id: "c1", seconds: 12 } },
        ],
      },
    ]);
  });

  it("returns two correctly tagged rows for equal ids in two target tables", () => {
    const rows = parseCollection(
      collection({
        article: arm([linked("article", { id: "same", title: "t" })]),
        clip: arm([linked("clip", { id: "same", seconds: 1 })]),
      })
    ) as { items: { type: string; data: { id: string } }[] }[];
    expect(rows[0]?.items).toHaveLength(2);
    expect(rows[0]?.items.map((item) => item.type)).toEqual([
      "article",
      "clip",
    ]);
    expect(new Set(rows[0]?.items.map((item) => item.data.id))).toEqual(
      new Set(["same"])
    );
  });

  it("returns a fresh empty array — never null — for an empty collection", () => {
    const rows = parseCollection(
      collection({ article: arm([]), clip: arm([]) })
    ) as { items: unknown }[];
    expect(rows[0]?.items).toEqual([]);
    expect(rows[0]?.items).not.toBeNull();
  });

  it("restores an ARM-LOCAL reversed window without touching its sibling", () => {
    const rows = parseCollection(
      collection({
        article: arm([
          linked("article", { id: "a3", title: "third" }),
          linked("article", { id: "a2", title: "second" }),
        ]),
        clip: arm([
          linked("clip", { id: "c1", seconds: 1 }),
          linked("clip", { id: "c2", seconds: 2 }),
        ]),
      }),
      {
        select: {
          id: true,
          items: {
            variants: {
              // Negative take on ONE arm only: the reversed window is restored
              // for that arm alone, and its sibling keeps driver order.
              article: { take: -2 },
              clip: { take: 2 },
            },
          },
        },
      }
    ) as { items: { data: { id: string } }[] }[];
    expect(rows[0]?.items.map((item) => item.data.id)).toEqual([
      "a2",
      "a3",
      "c1",
      "c2",
    ]);
  });

  it("keeps an excluded arm out of the result while still checking it", () => {
    const rows = parseCollection(
      collection({
        article: arm([linked("article", { id: "a1", title: "t" })]),
        clip: arm(null),
      }),
      { select: { id: true, items: { only: ["article"] } } }
    ) as { items: { type: string }[] }[];
    expect(rows[0]?.items.map((item) => item.type)).toEqual(["article"]);
  });

  it("fails an orphan in an EXCLUDED arm, before any visible row is parsed", () => {
    // THE INTEGRITY CONTRACT. `only: []` asks for nothing at all, and the arm
    // that holds the malformed membership is not even the one being read — the
    // carrier still refuses, by name.
    expect(() =>
      parseCollection(
        collection({
          article: arm(null),
          clip: arm(null, { membership: 1, orphans: 1 }),
        }),
        { select: { id: true, items: { only: [] } } }
      )
    ).toThrowError(
      "Polymorphic relation 'items' references a missing 'clip' record."
    );
  });

  it("fails an orphan hidden behind a filtered, windowed arm", () => {
    // The arm carries a perfectly well-formed row array. A filter, cursor or
    // LIMIT that leaves exactly the visible rows the caller wanted cannot hide
    // the membership row whose target is gone.
    expect(() =>
      parseCollection(
        collection({
          article: arm([linked("article", { id: "a1", title: "kept" })], {
            membership: 2,
            orphans: 1,
          }),
          clip: arm([]),
        }),
        {
          select: {
            id: true,
            items: { variants: { article: { take: 1 } } },
          },
        }
      )
    ).toThrowError(
      "Polymorphic relation 'items' references a missing 'article' record."
    );
  });

  it("refuses a null element target with the same named error", () => {
    expect(() =>
      parseCollection(
        collection({
          article: arm([linked("article", null)]),
          clip: arm([]),
        })
      )
    ).toThrowError(
      "Polymorphic relation 'items' references a missing 'article' record."
    );
  });

  // §13.3 malformed-carrier matrix. Every row is a shape a hostile or broken
  // driver can produce; none may reach the caller as data.
  it.each([
    ["outer carrier is not an object", ["nope"]],
    ["outer carrier is null", null],
    [
      "outer state tag is wrong",
      { ...collection({}), __viborm_state: "linked" },
    ],
    [
      "outer carrier carries an extra key",
      { ...collection({ article: arm([]), clip: arm([]) }), extra: 1 },
    ],
    [
      "arm container is not an object",
      { __viborm_state: "collection", arms: 7 },
    ],
    ["a configured arm is missing", collection({ article: arm([]) })],
    [
      "an unconfigured arm is present",
      collection({ article: arm([]), clip: arm([]), ghost: arm([]) }),
    ],
    ["an arm is not an object", collection({ article: 1, clip: arm([]) })],
    [
      "an arm is missing its orphan fact",
      collection({
        article: { membership: 0, rows: [] },
        clip: arm([]),
      }),
    ],
    [
      "an arm carries an extra key",
      collection({
        article: { membership: 0, orphans: 0, rows: [], extra: 1 },
        clip: arm([]),
      }),
    ],
    [
      "an integrity fact is non-numeric",
      collection({ article: arm([], { orphans: "many" }), clip: arm([]) }),
    ],
    [
      "an integrity fact is negative",
      collection({ article: arm([], { orphans: -1 }), clip: arm([]) }),
    ],
    [
      "an integrity fact is a non-canonical string",
      collection({ article: arm([], { membership: "01" }), clip: arm([]) }),
    ],
    [
      "a visible arm returned no row array",
      collection({ article: arm("rows"), clip: arm([]) }),
    ],
    [
      "an element is not an object",
      collection({ article: arm(["row"]), clip: arm([]) }),
    ],
    [
      "an element envelope carries an extra key",
      collection({
        article: arm([{ ...linked("article", { id: "a", title: "t" }), x: 1 }]),
        clip: arm([]),
      }),
    ],
    [
      "an element is tagged with another arm's type",
      collection({
        article: arm([linked("clip", { id: "a", title: "t" })]),
        clip: arm([]),
      }),
    ],
    [
      "an element row carries an unexpected key",
      collection({
        article: arm([linked("article", { id: "a", title: "t", extra: 1 })]),
        clip: arm([]),
      }),
    ],
  ])("refuses a malformed collection carrier: %s", (_name, carrier) => {
    expect(() => parseCollection(carrier)).toThrowError(QueryEngineError);
  });

  it("refuses a well-formed row array sitting behind a non-zero orphan count", () => {
    // ORDER MATTERS: the rows here would parse cleanly. The refusal must come
    // from the integrity pass, which runs first and for every arm.
    expect(() =>
      parseCollection(
        collection({
          article: arm([linked("article", { id: "a1", title: "t" })], {
            orphans: 1,
          }),
          clip: arm([]),
        })
      )
    ).toThrowError(
      "Polymorphic relation 'items' references a missing 'article' record."
    );
  });

  it("refuses an excluded arm that returned rows anyway", () => {
    expect(() =>
      parseCollection(
        collection({
          article: arm([]),
          clip: arm([linked("clip", { id: "c", seconds: 1 })]),
        }),
        { select: { id: true, items: { only: ["article"] } } }
      )
    ).toThrowError(QueryEngineError);
  });
});
