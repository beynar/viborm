/**
 * Construction is TOTAL (pattern-engine-ideal-state.md §5 rule 3): every shape
 * today's engine refuses at construction is recorded, never thrown, so the
 * scheduler and packer raise it after legality in §19 order.
 */
import { ValidationError } from "@errors";
import { s } from "@schema";
import { describe, expect, test } from "vitest";
import { construct, constructRaw } from "./harness";

const NOT_PORTABLE_NUMBER_KEY = /not portable for number primary key/;

const schema = (() => {
  const user = s
    .model({
      id: s.string().id(),
      name: s.string(),
      posts: s.toMany(() => post),
    })
    .map("f_users");
  const post = s
    .model({
      id: s.int().id(),
      title: s.string(),
      authorId: s.string().nullable(),
      author: s
        .toOne(() => user)
        .fields("authorId")
        .references("id"),
    })
    .map("f_posts");
  const measure = s
    .model({ id: s.number().id(), value: s.number() })
    .map("f_measures");
  return { user, post, measure };
})();

describe("deferred refusals", () => {
  test("portable primary key: two operations on a key member (legality stage, QueryEngineError)", () => {
    const { deferredRefusals } = constructRaw(schema, schema.post, "update", {
      where: { id: 1 },
      data: { id: { set: 2, increment: 1 } },
    });
    expect(deferredRefusals).toEqual([
      expect.objectContaining({
        stage: "legality",
        kind: "portablePrimaryKey",
        error: "QueryEngineError",
        path: "data.id",
      }),
    ]);
  });

  test("portable primary key: arithmetic on a number key", () => {
    const { deferredRefusals } = construct(schema, schema.measure, "update", {
      where: { id: 1 },
      data: { id: { increment: 1 } },
    });
    expect(deferredRefusals.map((r) => r.kind)).toEqual(["portablePrimaryKey"]);
    expect(deferredRefusals[0]!.message).toMatch(NOT_PORTABLE_NUMBER_KEY);
  });

  test("relation-key legality: a non-literal write to a reference member while the relation is written", () => {
    const { deferredRefusals } = constructRaw(schema, schema.post, "update", {
      where: { id: 1 },
      data: {
        authorId: { increment: 1 },
        author: { connect: { id: "u1" } },
      },
    });
    expect(deferredRefusals).toEqual([
      expect.objectContaining({
        stage: "legality",
        kind: "relationKeyNonLiteral",
        relation: "author",
        error: "NestedWriteError",
      }),
    ]);
  });

  test("a literal `{ set }` on the reference member is not a refusal; `{ set: null }` is the null-key refusal", () => {
    const literal = construct(schema, schema.post, "update", {
      where: { id: 1 },
      data: { authorId: "u2", author: { connect: { id: "u1" } } },
    });
    expect(literal.deferredRefusals).toEqual([]);
    const nulled = construct(schema, schema.post, "update", {
      where: { id: 1 },
      data: { authorId: null, author: { connect: { id: "u1" } } },
    });
    expect(nulled.deferredRefusals.map((r) => r.kind)).toEqual([
      "nullRelationKey",
    ]);
  });

  test("a bulk verb on a singular edge is recorded, and the pattern is still built", () => {
    const { pattern, deferredRefusals } = constructRaw(
      schema,
      schema.post,
      "update",
      {
        where: { id: 1 },
        data: { author: { updateMany: [{ data: { name: { set: "x" } } }] } },
      }
    );
    expect(deferredRefusals).toEqual([
      expect.objectContaining({ kind: "toOneBulkVerb", relation: "author" }),
    ]);
    expect(pattern.rows.length).toBeGreaterThan(1);
  });

  test("a bulk root moving an existing row's membership on a target-held reference is packing's refusal", () => {
    const moved = construct(schema, schema.user, "updateMany", {
      where: {},
      data: { posts: { connect: { id: 1 } } },
    });
    expect(moved.deferredRefusals).toEqual([
      expect.objectContaining({
        stage: "packing",
        kind: "bulkRootMembershipMove",
        relation: "posts",
        path: "data.posts.connect",
      }),
    ]);
    // A fresh child carries its own membership: no refusal.
    const created = construct(schema, schema.user, "updateMany", {
      where: {},
      data: { posts: { create: { id: 5, title: "t" } } },
    });
    expect(created.deferredRefusals).toEqual([]);
  });

  test("shapes the grammar cannot produce never throw an engine error", () => {
    const shapes: Record<string, unknown>[] = [
      { where: { id: 1 }, data: { author: { connect: "not-a-record" } } },
      {
        where: { id: 1 },
        data: { author: { upsert: [{ create: {}, update: {} }] } },
      },
      { where: { id: 1 }, data: { author: 42 } },
      { where: { id: 1 }, data: { author: { nonsense: true } } },
      { where: { id: 1 }, data: { title: { set: undefined } } },
      { where: "no", data: { title: "t" } },
    ];
    for (const args of shapes) {
      try {
        constructRaw(schema, schema.post, "update", args);
      } catch (error) {
        expect(error).toBeInstanceOf(ValidationError);
      }
    }
  });

  test("today's texts, verbatim: unknown variant, shared-key merge, bulk membership move", () => {
    const variant = constructRaw(schema, schema.post, "update", {
      where: { id: 1 },
      data: { author: { connect: { type: "nope", where: { id: "u1" } } } },
    });
    // No variants family on this edge: the variant is ignored, not refused.
    expect(variant.deferredRefusals).toEqual([]);

    const moved = construct(schema, schema.user, "updateMany", {
      where: {},
      data: { posts: { connect: { id: 1 } } },
    });
    const [move] = moved.deferredRefusals;
    expect(move).toMatchObject({
      kind: "bulkRootMembershipMove",
      error: "UnsupportedOperationError",
    });
    expect(move!.messageFor?.(3)).toBe(
      "updateMany matched 3 rows, so it cannot apply 'connect' to relation 'posts': that membership is stored on the target row, which can belong to only one of them — the last row updated would take it from the others. Narrow the filter (or add 'limit: 1') so exactly one row matches, or write this relation in a separate call."
    );
    expect(move!.message).toBe(move!.messageFor?.(2));
  });
});
