/**
 * Edges whose target table the PAYLOAD selects (K2 `ReferenceFamily.variants`)
 * and their fixed inverses. The reference is the same cells; the discriminator
 * cell's value is bound from the payload (direct) or fixed (inverse) — D4, not
 * a carrier.
 */
import { s } from "@schema";
import { referenceCells } from "@src/query-engine/pattern/cells";
import { describe, expect, test } from "vitest";
import {
  cells,
  construct,
  constructRaw,
  indexOf,
  references,
  rows,
} from "./harness";

const schema = (() => {
  const article = s
    .model({
      id: s.int().id(),
      title: s.string(),
      cards: s.toMany(() => card).name("subject"),
    })
    .map("v_articles");
  const clip = s.model({ id: s.int().id(), title: s.string() }).map("v_clips");
  const card = s
    .model({
      id: s.string().id(),
      label: s.string(),
      subject: s
        .toOne(
          { article: () => article, clip: () => clip },
          { values: { article: "v.article", clip: "v.clip" } }
        )
        .name("subject")
        .optional(),
    })
    .map("v_cards");
  return { article, clip, card };
})();

const collection = (() => {
  const post = s.model({ id: s.int().id(), title: s.string() }).map("v_posts");
  const video = s
    .model({ id: s.int().id(), title: s.string() })
    .map("v_videos");
  const board = s
    .model({
      id: s.int().id(),
      items: s.toMany(
        { post: () => post, video: () => video },
        { values: { post: "v.post", video: "v.video" } }
      ),
    })
    .map("v_boards");
  return { post, video, board };
})();

function subjectCells(variant: string) {
  const family = referenceCells(indexOf(schema), schema.card, "subject");
  if (family.kind !== "variants") throw new Error("expected variants");
  const cells = family.byVariant.get(variant)!;
  return {
    id: cells.cells[0]!.holderColumn,
    type: cells.discriminator!.column,
    stored: cells.discriminator!.storedValue,
  };
}

const updateCard = (subject: Record<string, unknown>) =>
  construct(schema, schema.card, "update", {
    where: { id: "c1" },
    data: { subject },
  });

describe("payload-bound target", () => {
  test("connect binds the variant from the payload: reference + discriminator cell as a literal", () => {
    const c = subjectCells("article");
    const { pattern } = updateCard({
      connect: { type: "article", where: { id: 1 } },
    });
    expect(rows(pattern)[1]).toMatchObject({
      table: "v_articles",
      key: ["lit(1)"],
    });
    expect(references(pattern)).toEqual([
      {
        holder: 0,
        referenced: 1,
        columns: [`${c.id}->id`],
        discriminator: `${c.type}=lit("v.article")`,
        relation: "subject",
      },
    ]);
    expect(cells(pattern)).toEqual([
      { row: 0, column: c.id, mode: "assert", value: "lit(1)" },
      { row: 0, column: c.type, mode: "assert", value: 'lit("v.article")' },
    ]);
  });

  test("a different variant binds a different table with the same holder cells", () => {
    const c = subjectCells("clip");
    const { pattern } = updateCard({
      create: { type: "clip", data: { id: 7, title: "t" } },
    });
    expect(rows(pattern)[1]).toMatchObject({ table: "v_clips", fresh: true });
    expect(cells(pattern, 0)).toEqual([
      { row: 0, column: c.id, mode: "assert", value: "lit(7)" },
      { row: 0, column: c.type, mode: "assert", value: 'lit("v.clip")' },
    ]);
  });

  test("disconnect: true (targetless) retracts both holder cells with no target row", () => {
    const c = subjectCells("article");
    const { pattern } = updateCard({ disconnect: true });
    expect(rows(pattern)).toHaveLength(1);
    expect(cells(pattern)).toEqual([
      { row: 0, column: c.id, mode: "retract", value: "lit(null)" },
      { row: 0, column: c.type, mode: "retract", value: "lit(null)" },
    ]);
  });

  test("delete { type }: match the member of THAT table by membership; retract it and the cells", () => {
    const c = subjectCells("clip");
    const { pattern } = updateCard({ delete: { type: "clip" } });
    expect(rows(pattern)[1]).toMatchObject({
      table: "v_clips",
      mode: "retract",
    });
    expect(cells(pattern)).toEqual([
      { row: 0, column: c.id, mode: "match", value: "matched(r1.id)" },
      { row: 0, column: c.type, mode: "match", value: 'lit("v.clip")' },
      { row: 0, column: c.id, mode: "retract", value: "lit(null)" },
      { row: 0, column: c.type, mode: "retract", value: "lit(null)" },
    ]);
  });

  test("upsert { type, create, update }: both arms on the selected variant", () => {
    const { pattern } = updateCard({
      upsert: {
        type: "article",
        create: { id: 3, title: "c" },
        update: { title: "u" },
      },
    });
    expect(
      rows(pattern)
        .slice(1)
        .map((r) => [r.table, r.mode, r.arm])
    ).toEqual([
      ["v_articles", "match", undefined],
      ["v_articles", "assert", 1],
    ]);
  });

  test("an unknown variant is a deferred refusal, not a throw", () => {
    const { deferredRefusals } = constructRaw(schema, schema.card, "update", {
      where: { id: "c1" },
      data: { subject: { connect: { type: "nope", where: { id: 1 } } } },
    });
    expect(deferredRefusals).toEqual([
      expect.objectContaining({ kind: "unknownVariant", relation: "subject" }),
    ]);
  });
});

describe("fixed inverse of a payload-bound target", () => {
  test("the inverse is one reference with its discriminator fixed; the target row holds the cells", () => {
    const c = subjectCells("article");
    const { pattern } = construct(schema, schema.article, "update", {
      where: { id: 1 },
      data: { cards: { create: { id: "c9", label: "l" } } },
    });
    expect(references(pattern)).toEqual([
      {
        holder: 1,
        referenced: 0,
        columns: [`${c.id}->id`],
        discriminator: `${c.type}=lit("v.article")`,
        relation: "cards",
      },
    ]);
    expect(cells(pattern, 1).slice(-2)).toEqual([
      { row: 1, column: c.id, mode: "assert", value: "lit(1)" },
      { row: 1, column: c.type, mode: "assert", value: 'lit("v.article")' },
    ]);
  });
});

describe("payload-bound collection", () => {
  test("each tagged item binds its own member table; runs keep declared order", () => {
    const { pattern } = construct(collection, collection.board, "update", {
      where: { id: 1 },
      data: {
        items: {
          connect: [
            { type: "post", where: { id: 1 } },
            { type: "video", where: { id: 2 } },
            { type: "post", where: { id: 3 } },
          ],
        },
      },
    });
    const tables = rows(pattern)
      .slice(1)
      .map((r) => r.table);
    expect(tables.filter((t) => t === "v_posts")).toHaveLength(2);
    expect(tables.filter((t) => t === "v_videos")).toHaveLength(1);
    // Three fresh reference rows, in two distinct member tables.
    const referenceTables = rows(pattern)
      .filter((r) => r.fresh)
      .map((r) => r.table);
    expect(referenceTables).toHaveLength(3);
    expect(new Set(referenceTables).size).toBe(2);
    expect(referenceTables[0]).toBe(referenceTables[2]);
  });

  test("set [] over a collection clears every member table's reference rows", () => {
    const { pattern } = construct(collection, collection.board, "update", {
      where: { id: 1 },
      data: { items: { set: [] } },
    });
    // One clear-all row PER configured variant, in declaration order, whether
    // the payload named the variant or not (ATOM §16.1's barrier).
    const departures = rows(pattern).slice(1);
    expect(departures.map((r) => [r.mode, r.cardinality])).toEqual([
      ["retract", "set"],
      ["retract", "set"],
    ]);
    expect(new Set(departures.map((r) => r.table)).size).toBe(2);
  });
});
