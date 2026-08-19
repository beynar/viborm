import { s } from "@schema";
import { hydrateSchemaNames } from "@schema/hydration";
import { createSchemaRegistry, parse } from "@validation";
import { describe, expect, test } from "vitest";

/**
 * THE COLLECTION SELECTION ENVELOPE, at the parse boundary.
 *
 * `select` / `include` on a polymorphic collection accept exactly three things:
 * `true`, `false`, and `{ only?, variants? }`. Everything below measures ONE of
 * the envelope's promises — the ones the query engine is allowed to assume
 * rather than re-derive:
 *
 *  - `only` is exact, deduped, and in DECLARATION order whatever the caller
 *    wrote (so allow-list order can never change result order, and two
 *    spellings of one allow-list are one cache entry);
 *  - `variants` never names a variant `only` excludes;
 *  - an arm is the ordinary to-many node, so it has the ordinary controls;
 *  - a public variant literally named `only` or `variants` still works, because
 *    arms live UNDER `variants` rather than at the envelope's top level.
 */

const post = s.model({
  id: s.string().id(),
  title: s.string(),
  rank: s.int(),
});
const video = s.model({ id: s.string().id(), duration: s.int() });
const gallery = s.model({
  id: s.string().id(),
  // Declaration order is post, then video — the one ordering truth.
  items: s.polymorphicToMany(
    { post: () => post, video: () => video },
    { values: { post: "sel.post.v1", video: "sel.video.v1" } }
  ),
});

const schema = { post, video, gallery };
hydrateSchemaNames(schema);
const registry = createSchemaRegistry(schema);
const core = () => registry.proxy.gallery.core;

const parseSelect = (value: unknown) => parse(core().select, { items: value });

/** The validated `items` value, or the failure's message if it did not parse. */
const selected = (value: unknown): unknown => {
  const result = parseSelect(value);
  if (result.issues) throw new Error(result.issues[0]?.message);
  return result.value.items;
};

describe("collection selection envelope", () => {
  test("true and false are preserved VERBATIM", () => {
    // Not desugared into an all-variants envelope: `false` must stay the flat
    // "no key, no relation SQL" fact the engine already understands, and `true`
    // must stay distinguishable from `{ variants: { … } }` covering everything.
    expect(selected(true)).toBe(true);
    expect(selected(false)).toBe(false);
  });

  test("an empty envelope parses and states nothing", () => {
    expect(selected({})).toEqual({});
  });

  test("only is canonicalized into declaration order", () => {
    // THE POINT: the caller wrote video-first. The engine sees post-first, so
    // "the allow-list's order never changes result order" is structural, and
    // the two spellings collapse to one cache key.
    expect(selected({ only: ["video", "post"] })).toEqual({
      only: ["post", "video"],
    });
    expect(selected({ only: ["post", "video"] })).toEqual({
      only: ["post", "video"],
    });
  });

  test("only is a FRESH array per parse", () => {
    const first = selected({ only: ["post"] });
    const second = selected({ only: ["post"] });
    expect(first).toEqual({ only: ["post"] });
    expect(first).not.toBe(second);
  });

  // The envelope sits inside `v.union([v.boolean(), …])`, and a union reports
  // the members' messages joined and drops their paths — the same flattening an
  // ordinary to-many relation node already has. So these pins measure that the
  // REASON is named and reaches the caller, which is what `only`'s exactness is
  // worth; the outer key is still located by the strict object above it.
  test("duplicate only values are refused, naming the duplicate", () => {
    const issues = parseSelect({ only: ["post", "post"] }).issues;
    expect(issues?.[0]?.message).toContain("Duplicate value in 'only': 'post'");
    expect(issues?.[0]?.path).toEqual(["items"]);
  });

  test("an unknown only value is refused", () => {
    expect(parseSelect({ only: ["ghost"] }).issues?.[0]?.message).toContain(
      "Expected one of"
    );
  });

  test("only: [] is accepted", () => {
    // A legal, if unusual, request: no visible rows, every arm's integrity
    // facts still computed. Refusing it would leave `readonly never[]` as a
    // result type nothing could produce.
    expect(selected({ only: [] })).toEqual({ only: [] });
  });

  test("a variant outside only is refused, naming the variant", () => {
    expect(
      parseSelect({ only: ["post"], variants: { video: true } }).issues?.[0]
        ?.message
    ).toContain("Variant 'video' is not in 'only'");
  });

  test("variants is unconstrained when only is absent", () => {
    expect(parseSelect({ variants: { video: true } }).issues).toBeUndefined();
    // …and when `only` is present but explicitly undefined, which the parse
    // boundary reads as absent.
    expect(
      parseSelect({ only: undefined, variants: { video: true } }).issues
    ).toBeUndefined();
  });

  test("a bare true arm desugars to that variant's default projection", () => {
    expect(selected({ variants: { post: true } })).toEqual({
      variants: { post: { select: { id: true, title: true, rank: true } } },
    });
  });

  test("an arm with no select resolves the default projection at PARSE", () => {
    // Never in the builder: `validatedArgs` is both the cache key and the sole
    // builder input, so a builder-side default would escape the key.
    expect(selected({ variants: { video: { take: 3 } } })).toEqual({
      variants: { video: { take: 3, select: { id: true, duration: true } } },
    });
  });

  test("an arm carries the ordinary to-many controls", () => {
    // Negative take is Prisma's "last N" and survives to the engine intact.
    expect(
      selected({
        variants: {
          post: {
            where: { title: { contains: "a" } },
            orderBy: [{ rank: "asc" }, { title: "desc" }],
            take: -3,
            skip: 2,
            cursor: { id: "p1" },
            distinct: ["rank"],
            select: { id: true },
          },
        },
      })
    ).toEqual({
      variants: {
        post: {
          where: { title: { contains: "a" } },
          orderBy: [{ rank: "asc" }, { title: "desc" }],
          take: -3,
          skip: 2,
          cursor: { id: "p1" },
          distinct: ["rank"],
          select: { id: true },
        },
      },
    });
  });

  test("an arm rejects select and include together", () => {
    expect(
      parseSelect({
        variants: { post: { select: { id: true }, include: {} } },
      }).issues?.[0]?.message
    ).toContain("Mutually exclusive fields");
  });

  test("an arm's omit is subtracted into an explicit select", () => {
    expect(selected({ variants: { post: { omit: { rank: true } } } })).toEqual({
      variants: { post: { select: { id: true, title: true } } },
    });
  });

  test("an unknown key is refused at the envelope and inside an arm", () => {
    expect(parseSelect({ onlyy: ["post"] }).issues?.[0]?.message).toContain(
      "Unknown key"
    );
    expect(
      parseSelect({ variants: { post: { takee: 1 } } }).issues?.[0]?.message
    ).toContain("Unknown key");
    expect(
      parseSelect({ variants: { ghost: true } }).issues?.[0]?.message
    ).toContain("Unknown key");
  });

  test("include takes the identical envelope", () => {
    expect(
      parse(core().include, { items: { only: ["video"] } }).issues
    ).toBeUndefined();
  });
});

// =============================================================================
// HOSTILE VARIANT NAMES
// =============================================================================

const onlyTarget = s.model({ id: s.string().id() });
const variantsTarget = s.model({ id: s.string().id() });
const hostileOwner = s.model({
  id: s.string().id(),
  items: s.polymorphicToMany(
    { only: () => onlyTarget, variants: () => variantsTarget },
    { values: { only: "hostile.only.v1", variants: "hostile.variants.v1" } }
  ),
});

const hostileSchema = { onlyTarget, variantsTarget, hostileOwner };
hydrateSchemaNames(hostileSchema);
const hostileRegistry = createSchemaRegistry(hostileSchema);

describe("public variants named 'only' and 'variants'", () => {
  test("both are addressable, because arms live under `variants`", () => {
    // The envelope's two keys are the only reserved words, and they are one
    // level ABOVE the discriminator map — so a schema author naming a variant
    // after either of them collides with nothing.
    const result = parse(hostileRegistry.proxy.hostileOwner.core.select, {
      items: {
        only: ["only", "variants"],
        variants: { only: true, variants: { select: { id: true } } },
      },
    });
    if (result.issues) throw new Error(result.issues[0]?.message);
    expect(result.value.items).toEqual({
      only: ["only", "variants"],
      variants: {
        only: { select: { id: true } },
        variants: { select: { id: true } },
      },
    });
  });
});

// =============================================================================
// THE INVERSE SIDE — "ordinary relation schemas for their cardinality" (§8.3)
// =============================================================================

/**
 * A collection's INVERSE gets no bespoke grammar. Whether a target reaches back
 * through a SINGULAR inverse (a fields-less `manyToOne` bound to a member whose
 * `inverseCardinality` is "one") or a PLURAL one (a fields-less `manyToMany`),
 * its `include` node is the ordinary node for that cardinality — the same one an
 * edge with real foreign-key fields would get.
 *
 * This is pinned because the shape is easy to misread as a Package C omission:
 * a singular inverse refuses `include: { shelf: { where: … } }`, and the reflex
 * is to call that a missing filter. It is not. NO to-one include node in the
 * estate offers `where` — `toOneIncludeFactory` is `{select, include, omit}`, in
 * Prisma parity — so the ordinary `author` edge below refuses it identically.
 * The plural arm is what stops that from being vacuous: a to-many inverse DOES
 * carry `where`, so the two cardinalities are measured apart.
 */
const author = s.model({ id: s.string().id(), name: s.string() });
const book = s.model({
  id: s.string().id(),
  title: s.string(),
  // SINGULAR inverse — bound to the `book` member of `shelf.contents`.
  shelf: s.manyToOne(() => shelf).optional(),
  // The control: an ORDINARY to-one edge, nothing polymorphic about it.
  author: s.manyToOne(() => author).optional(),
});
const reel = s.model({
  id: s.string().id(),
  // PLURAL inverse — bound to the `reel` member of `shelf.contents`.
  shelves: s.manyToMany(() => shelf),
});
const shelf = s.model({
  id: s.string().id(),
  label: s.string(),
  contents: s.polymorphicToMany(
    { book: () => book, reel: () => reel },
    { values: { book: "inv.book.v1", reel: "inv.reel.v1" } }
  ),
});

const inverseSchema = { author, book, reel, shelf };
hydrateSchemaNames(inverseSchema);
const inverseRegistry = createSchemaRegistry(inverseSchema);

describe("collection inverse include nodes", () => {
  const bookInclude = () => inverseRegistry.proxy.book.core.include;
  const reelInclude = () => inverseRegistry.proxy.reel.core.include;

  test("a SINGULAR inverse is the ordinary to-one node, `where` and all", () => {
    expect(parse(bookInclude(), { shelf: true }).issues).toBeUndefined();
    expect(
      parse(bookInclude(), { shelf: { select: { label: true } } }).issues
    ).toBeUndefined();
    expect(
      parse(bookInclude(), { shelf: { omit: { label: true } } }).issues
    ).toBeUndefined();

    const singular = parse(bookInclude(), { shelf: { where: { id: "s1" } } });
    const ordinary = parse(bookInclude(), { author: { where: { id: "a1" } } });
    // Identical refusal, identical reason: this is the to-one node's shape,
    // not a polymorphic restriction.
    expect(singular.issues?.[0]?.message).toContain("Unknown key: where");
    expect(ordinary.issues?.[0]?.message).toContain("Unknown key: where");
    expect(singular.issues?.[0]?.message).toBe(ordinary.issues?.[0]?.message);
  });

  test("a PLURAL inverse is the ordinary to-many node, so it DOES take `where`", () => {
    expect(
      parse(reelInclude(), {
        shelves: {
          where: { label: { contains: "a" } },
          orderBy: { label: "asc" },
          take: 2,
          skip: 1,
          distinct: ["label"],
        },
      }).issues
    ).toBeUndefined();
  });
});
