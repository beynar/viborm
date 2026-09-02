/**
 * Edges whose reference lives in a row of its own (K2 `viaJunction`): the
 * reference row is a fresh key whose only cells are two references. The same
 * sugar rows apply; only the cell map differs.
 */
import { s } from "@schema";
import { referenceCells } from "@src/query-engine/pattern/cells";
import { describe, expect, test } from "vitest";
import { cells, construct, indexOf, references, rows } from "./harness";

const schema = (() => {
  const tag = s
    .model({
      id: s.string().id(),
      label: s.string(),
      posts: s.toMany(() => post),
    })
    .map("r_tags");
  const post = s
    .model({
      id: s.string().id(),
      title: s.string(),
      tags: s.toMany(() => tag),
    })
    .map("r_posts");
  return { tag, post };
})();

/** The plain K2 view of post.tags: the reference row's two pairings. */
function edge() {
  const family = referenceCells(indexOf(schema), schema.post, "tags");
  if (family.kind !== "single") throw new Error("expected one reference");
  const via = family.cells.viaJunction;
  if (!via) throw new Error("expected a reference row");
  // `cells` pairs the row to the referenced endpoint (tag); the asking side
  // (post) is the other endpoint pairing.
  const toPostPairs =
    family.cells.cells[0]!.holderColumn === via.targetCells[0]!.holderColumn
      ? via.sourceCells
      : via.targetCells;
  return {
    table: via.table,
    toPost: toPostPairs.map((c) => `${c.holderColumn}->${c.referencedColumn}`),
    toTag: family.cells.cells.map(
      (c) => `${c.holderColumn}->${c.referencedColumn}`
    ),
    postColumn: toPostPairs[0]!.holderColumn,
    tagColumn: family.cells.cells[0]!.holderColumn,
  };
}

const updatePost = (tags: Record<string, unknown>) =>
  construct(schema, schema.post, "update", {
    where: { id: "p1" },
    data: { tags },
  });

describe("reference rows", () => {
  test("connect: a fresh reference row holding both references", () => {
    const e = edge();
    const { pattern } = updatePost({ connect: { id: "t1" } });
    expect(rows(pattern)).toEqual([
      expect.objectContaining({ id: 0, table: "r_posts", mode: "match" }),
      expect.objectContaining({
        id: 1,
        table: "r_tags",
        mode: "match",
        key: ['lit("t1")'],
      }),
      expect.objectContaining({
        id: 2,
        table: e.table,
        mode: "assert",
        fresh: true,
        key: [],
      }),
    ]);
    expect(references(pattern)).toEqual([
      { holder: 2, referenced: 0, columns: e.toPost, relation: "tags" },
      { holder: 2, referenced: 1, columns: e.toTag, relation: "tags" },
    ]);
    expect(cells(pattern)).toEqual([
      { row: 2, column: e.postColumn, mode: "assert", value: 'lit("p1")' },
      { row: 2, column: e.tagColumn, mode: "assert", value: 'lit("t1")' },
    ]);
  });

  test("create: the fresh target, then the fresh reference row", () => {
    const e = edge();
    const { pattern } = updatePost({ create: { id: "t2", label: "l" } });
    expect(rows(pattern).map((r) => [r.table, r.fresh])).toEqual([
      ["r_posts", false],
      ["r_tags", true],
      [e.table, true],
    ]);
  });

  test("disconnect [X]: the reference row matched by both sides is retracted; the target stays", () => {
    const e = edge();
    const { pattern } = updatePost({ disconnect: { id: "t1" } });
    expect(rows(pattern)[1]).toMatchObject({ table: "r_tags", mode: "match" });
    expect(rows(pattern)[2]).toMatchObject({ table: e.table, mode: "retract" });
    // A retracted row's cells are its identity (match), never cleared cells.
    expect(cells(pattern).map((c) => c.mode)).toEqual(["match", "match"]);
  });

  test("delete [X]: the target AND its reference row are retracted", () => {
    const { pattern } = updatePost({ delete: { id: "t1" } });
    expect(
      rows(pattern)
        .slice(1)
        .map((r) => r.mode)
    ).toEqual(["retract", "retract"]);
  });

  test("set S: retract every reference row of the parent (the pinned form), then assert S", () => {
    const e = edge();
    const { pattern } = updatePost({ set: [{ id: "t1" }, { id: "t2" }] });
    expect(
      rows(pattern)
        .slice(1)
        .map((r) => [r.table, r.mode, r.cardinality])
    ).toEqual([
      [e.table, "retract", "set"],
      ["r_tags", "match", "one"],
      [e.table, "assert", "one"],
      ["r_tags", "match", "one"],
      [e.table, "assert", "one"],
    ]);
    // The clear-all row references only the parent.
    expect(references(pattern)[0]).toEqual({
      holder: 1,
      referenced: 0,
      columns: e.toPost,
      relation: "tags",
    });
  });

  test("deleteMany: the set of members and their reference rows retract", () => {
    const { pattern } = updatePost({ deleteMany: { label: "x" } });
    expect(
      rows(pattern)
        .slice(1)
        .map((r) => [r.mode, r.cardinality])
    ).toEqual([
      ["retract", "set"],
      ["retract", "one"],
    ]);
  });

  test("the plain K2 view yields the real reference-row column names on both sides", () => {
    const e = edge();
    expect(e.postColumn).not.toBe(e.tagColumn);
    expect(e.toPost).toEqual([`${e.postColumn}->id`]);
    expect(e.toTag).toEqual([`${e.tagColumn}->id`]);
    const { pattern, deferredRefusals } = construct(
      schema,
      schema.post,
      "update",
      { where: { id: "p1" }, data: { tags: { connect: { id: "t1" } } } },
      referenceCells
    );
    expect(deferredRefusals).toEqual([]);
    expect(references(pattern).map((r) => r.columns)).toEqual([
      e.toPost,
      e.toTag,
    ]);
    // A reference-only row says so on its table, and every row names its verb.
    expect(pattern.rows[2]!.table.referenceRow).toBe(true);
    expect(pattern.rows[2]!.verb).toBe("connect");
    expect(pattern.rows[0]!.table.referenceRow).toBeUndefined();
  });
});
