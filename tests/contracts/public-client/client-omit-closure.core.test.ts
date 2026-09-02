/**
 * Client-level `omit` on the parts of a payload the earlier contracts never
 * reach: a nested relation node written as an object, a caller-stated `select`,
 * the settled target of a pair read from either end and across a junction, and
 * the bound inverse of a variant carrier.
 */

import { applyClientOmit, createClientOmitResolver } from "@client/omit";
import { s } from "@schema";
import { indexFor, prepareSchema } from "@tests/fixtures/query-scope";
import { describe, expect, test } from "vitest";

const author = s.model({
  id: s.string().id(),
  name: s.string(),
  credential: s.string(),
  posts: s.toMany(() => post),
});

const post = s.model({
  id: s.string().id(),
  title: s.string(),
  secret: s.string(),
  authorId: s.string(),
  author: s
    .toOne(() => author)
    .fields("authorId")
    .references("id"),
  tags: s.toMany(() => tag),
});

const tag = s.model({
  id: s.string().id(),
  label: s.string(),
  posts: s.toMany(() => post),
});

const ordinarySchema = { author, post, tag };

prepareSchema(ordinarySchema);

function ordinaryResolver() {
  const resolver = createClientOmitResolver(
    ordinarySchema,
    { author: { credential: true }, post: { secret: true } },
    indexFor(author)
  );
  if (!resolver) throw new Error("Expected a configured omit resolver");
  return resolver;
}

describe("client omit through ordinary relation nodes", () => {
  test("rewrites a nested relation node and keeps the caller's own keys", () => {
    expect(
      applyClientOmit(
        author,
        "findMany",
        { include: { posts: { take: 2 } } },
        ordinaryResolver()
      )
    ).toEqual({
      include: { posts: { take: 2, omit: { secret: true } } },
      omit: { credential: true },
    });
  });

  test("returns a fully stated projection identical, node for node", () => {
    // An explicit `select` overrides the client default at that node, and the
    // nested node states its own — so nothing is copied anywhere in the tree.
    const args = {
      select: { id: true, posts: { select: { title: true } } },
    };

    expect(applyClientOmit(author, "findMany", args, ordinaryResolver())).toBe(
      args
    );
  });

  test("writes a default arm into a relation selected beside scalars", () => {
    expect(
      applyClientOmit(
        author,
        "findMany",
        { select: { id: true, posts: true } },
        ordinaryResolver()
      )
    ).toEqual({
      select: { id: true, posts: { omit: { secret: true } } },
    });
  });

  test("leaves a relation the caller switched off exactly as written", () => {
    expect(
      applyClientOmit(
        author,
        "findMany",
        { include: { posts: false } },
        ordinaryResolver()
      )
    ).toEqual({
      include: { posts: false },
      omit: { credential: true },
    });
  });

  test("reads one pair's settled target from either end, and across a junction", () => {
    const resolver = ordinaryResolver();

    expect(
      applyClientOmit(
        author,
        "findMany",
        { include: { posts: true } },
        resolver
      )
    ).toEqual({
      include: { posts: { omit: { secret: true } } },
      omit: { credential: true },
    });
    expect(
      applyClientOmit(post, "findMany", { include: { author: true } }, resolver)
    ).toEqual({
      include: { author: { omit: { credential: true } } },
      omit: { secret: true },
    });
    // The junction's target is configured nowhere, so its node is untouched.
    expect(
      applyClientOmit(post, "findMany", { include: { tags: true } }, resolver)
    ).toEqual({
      include: { tags: true },
      omit: { secret: true },
    });
  });

  test("skips a configured model key that carries no field record", () => {
    const resolver = createClientOmitResolver(
      ordinarySchema,
      { author: undefined, post: { secret: true } },
      indexFor(author)
    );
    if (!resolver) throw new Error("Expected a configured omit resolver");

    const authorArgs = {};
    expect(applyClientOmit(author, "findMany", authorArgs, resolver)).toBe(
      authorArgs
    );
    expect(applyClientOmit(post, "findMany", {}, resolver)).toEqual({
      omit: { secret: true },
    });
  });
});

// =============================================================================
// A VARIANT CARRIER AND ITS BOUND INVERSE
// =============================================================================

const entry = s.model({
  id: s.string().id(),
  title: s.string(),
  draft: s.string(),
});

const clipping = s.model({
  id: s.string().id(),
  token: s.string(),
  shelves: s.toMany(() => shelf),
});

const shelf = s.model({
  id: s.string().id(),
  headline: s.string(),
  hidden: s.string(),
  items: s.toMany(
    { entry: () => entry, clipping: () => clipping },
    { values: { entry: "closure.entry.v1", clipping: "closure.clipping.v1" } }
  ),
});

const variantSchema = { entry, clipping, shelf };

prepareSchema(variantSchema);

function variantResolver() {
  const resolver = createClientOmitResolver(
    variantSchema,
    { clipping: { token: true }, shelf: { hidden: true } },
    indexFor(shelf)
  );
  if (!resolver) throw new Error("Expected a configured omit resolver");
  return resolver;
}

describe("client omit through a bound variant inverse", () => {
  test("resolves a bound inverse through the carrier that holds the storage", () => {
    // `clipping.shelves` is a view of ONE member of the carrier, so its target
    // is the carrier's own source rather than either endpoint of a pair.
    expect(
      applyClientOmit(
        clipping,
        "findMany",
        { include: { shelves: true } },
        variantResolver()
      )
    ).toEqual({
      include: { shelves: { omit: { hidden: true } } },
      omit: { token: true },
    });
  });

  test("leaves an arm the caller switched off and still defaults its sibling", () => {
    expect(
      applyClientOmit(
        shelf,
        "findMany",
        { include: { items: { variants: { entry: false } } } },
        variantResolver()
      )
    ).toEqual({
      include: {
        items: {
          variants: { entry: false, clipping: { omit: { token: true } } },
        },
      },
      omit: { hidden: true },
    });
  });

  test("leaves an arm that states its own projection unchanged", () => {
    expect(
      applyClientOmit(
        shelf,
        "findMany",
        {
          include: {
            items: { variants: { entry: { select: { title: true } } } },
          },
        },
        variantResolver()
      )
    ).toEqual({
      include: {
        items: {
          variants: {
            entry: { select: { title: true } },
            clipping: { omit: { token: true } },
          },
        },
      },
      omit: { hidden: true },
    });
  });
});
