import { PostgresAdapter } from "@adapters/databases/postgres/postgres-adapter";
import { SQLiteAdapter } from "@adapters/databases/sqlite/sqlite-adapter";
import { D1Driver } from "@drivers/d1";
import { QueryEngineError } from "@errors";
import { ResultParser, parseResult } from "@query-engine/result/ResultParser";
import {
  POLYMORPHIC_RESULT_STATE_INVALID,
  POLYMORPHIC_RESULT_STATE_KEY,
  POLYMORPHIC_RESULT_STATE_LINKED,
} from "@query-engine/result-aliases";
import { hydrateSchemaNames, s } from "@schema";
import { validateSchemaOrThrow } from "@schema/validation";
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
      .polymorphic(
        { video: () => video },
        { values: { video: "attachment.video.v1" } }
      )
      .optional(),
  });
  const requiredComment = s.model({
    id: s.string().id(),
    subject: s.polymorphic(
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
      .polymorphic(
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
  hydrateSchemaNames(schema);
  validateSchemaOrThrow(schema);
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
    new ResultParser(new PostgresAdapter(), models.requiredComment),
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
      parseRequired(
        linked("video", { id: "video-2", duration: 9 })
      )
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
    const parser = new ResultParser(
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

  it("applies the approved empty and orphan semantics", () => {
    const optionalParser = new ResultParser(
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
    expect(
      parseResult(
        optionalParser,
        "findMany",
        [{ id: "comment-1", subject: linked("post", null) }],
        projection
      )
    ).toEqual([{ id: "comment-1", subject: null }]);

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
