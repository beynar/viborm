import { s } from "@schema";
import { hydrateSchemaNames } from "@schema/hydration";
import { createSchemaRegistry, parse } from "@validation";
import { describe, expect, test } from "vitest";

/**
 * THE COLLECTION QUANTIFIER FILTER, at the parse boundary.
 *
 * `where: { items: { some | every | none } }`, each taking the SAME tagged
 * target predicate the to-one filter takes. Two things are worth measuring
 * here, and they are both about what is ABSENT:
 *
 *  - there is no null-presence arm, because a collection has no null state;
 *  - every quantifier is TAGGED, because "every member satisfies P" is only
 *    answerable per variant — `P` is a `where` of one target model, and the
 *    other variants' members are a separate question the engine answers with a
 *    conjunction of `NOT EXISTS`.
 */

const post = s.model({ id: s.string().id(), title: s.string() });
const video = s.model({ id: s.string().id(), duration: s.int() });
// An ORDINARY to-many beside the collection, so `_count` is measured on a model
// where both namespaces are live rather than on a polymorphic-only one.
const tag = s.model({
  id: s.string().id(),
  galleries: s.manyToMany(() => gallery),
});
const gallery = s.model({
  id: s.string().id(),
  tags: s.manyToMany(() => tag),
  items: s.polymorphicToMany(
    { post: () => post, video: () => video },
    { values: { post: "flt.post.v1", video: "flt.video.v1" } }
  ),
  feature: s
    .polymorphicToOne(
      { post: () => post, video: () => video },
      { values: { post: "featflt.post.v1", video: "featflt.video.v1" } }
    )
    .optional(),
});

const schema = { post, video, tag, gallery };
hydrateSchemaNames(schema);
const registry = createSchemaRegistry(schema);
const core = () => registry.proxy.gallery.core;

const parseWhere = (value: unknown) => parse(core().where, { items: value });

describe("collection quantifier filter", () => {
  test.each([
    "some",
    "every",
    "none",
  ] as const)("%s takes a bare tag", (quantifier) => {
    expect(
      parseWhere({ [quantifier]: { type: "post" } }).issues
    ).toBeUndefined();
  });

  test.each([
    "some",
    "every",
    "none",
  ] as const)("%s takes a tagged is / isNot predicate", (quantifier) => {
    expect(
      parseWhere({ [quantifier]: { type: "post", is: { title: "a" } } }).issues
    ).toBeUndefined();
    expect(
      parseWhere({ [quantifier]: { type: "video", isNot: { duration: 1 } } })
        .issues
    ).toBeUndefined();
  });

  test("the predicate is bound to the tagged variant's own where", () => {
    // `duration` is a video column, so it cannot appear under `type: "post"`.
    expect(
      parseWhere({ some: { type: "post", is: { duration: 1 } } }).issues
    ).toBeDefined();
  });

  test("all three quantifiers compose in one object", () => {
    expect(
      parseWhere({
        some: { type: "post", is: { title: "a" } },
        none: { type: "video" },
        every: { type: "post" },
      }).issues
    ).toBeUndefined();
  });

  test("an empty filter object is accepted and states nothing", () => {
    const result = parseWhere({});
    if (result.issues) throw new Error(result.issues[0]?.message);
    expect(result.value).toEqual({ items: {} });
  });

  test("is and isNot together are refused", () => {
    expect(
      parseWhere({
        some: { type: "post", is: { title: "a" }, isNot: { title: "b" } },
      }).issues
    ).toBeDefined();
  });

  test("an untagged predicate is refused", () => {
    expect(parseWhere({ some: { is: { title: "a" } } }).issues).toBeDefined();
  });

  test("NO null-presence arm exists on a collection", () => {
    // A to-one slot offers `is: null` / `isNot: null` / the bare-`null`
    // shorthand. A collection offers none of them: emptiness is `[]`, and it is
    // asked with `none`, not with a second reading of `null`.
    expect(parseWhere({ is: null }).issues).toBeDefined();
    expect(parseWhere({ isNot: null }).issues).toBeDefined();
    expect(parseWhere(null).issues).toBeDefined();
    // …while the to-one group beside it keeps all three.
    expect(parse(core().where, { feature: null }).issues).toBeUndefined();
    expect(
      parse(core().where, { feature: { is: null } }).issues
    ).toBeUndefined();
  });

  test("the to-one tagged grammar is NOT accepted at a collection key", () => {
    // `items: { type: "post", is: … }` is the singular envelope. A collection
    // key must go through a quantifier, so the two grammars cannot be confused.
    expect(parseWhere({ type: "post" }).issues).toBeDefined();
  });

  test("an unknown quantifier is refused", () => {
    expect(
      parseWhere({ any: { type: "post" } }).issues?.[0]?.message
    ).toContain("Unknown key");
  });
});

describe("collection _count filter", () => {
  test("true counts every member of every variant", () => {
    expect(
      parse(core().select, { _count: { select: { items: true } } }).issues
    ).toBeUndefined();
  });

  test("the filtered form takes the same tagged predicate", () => {
    expect(
      parse(core().select, {
        _count: {
          select: { items: { where: { type: "post", is: { title: "a" } } } },
        },
      }).issues
    ).toBeUndefined();
    expect(
      parse(core().select, {
        _count: { select: { items: { where: { some: { type: "post" } } } } },
      }).issues
    ).toBeDefined();
  });

  test("`_count: true` lists ordinary lists AND collections, not the to-one slot", () => {
    // Ordinary relation names first, then polymorphic collection names — one
    // ordering, so the desugared shorthand is stable across parses.
    const result = parse(core().select, { _count: true });
    if (result.issues) throw new Error(result.issues[0]?.message);
    expect(result.value._count).toEqual({
      select: { tags: true, items: true },
    });
  });
});

describe("collection _count ordering", () => {
  test("orderBy accepts `{ _count }` on the collection", () => {
    expect(
      parse(core().orderBy, { items: { _count: "asc" } }).issues
    ).toBeUndefined();
  });

  test("orderBy refuses a member column", () => {
    // Which table the column lives in is decided per row, so there is no single
    // column to sort by.
    expect(
      parse(core().orderBy, { items: { title: "asc" } }).issues
    ).toBeDefined();
  });
});
