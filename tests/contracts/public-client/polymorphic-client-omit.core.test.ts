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
});

const video = s.model({
  id: s.string().id(),
  duration: s.int(),
  token: s.string(),
});

const comment = s.model({
  id: s.string().id(),
  subject: s.toOne(
    { post: () => post, video: () => video },
    { values: { post: "content.post.v1", video: "content.video.v1" } }
  ),
});

const schema = { author, post, video, comment };

prepareSchema(schema);

function configuredResolver() {
  const resolver = createClientOmitResolver(
    schema,
    {
      author: { credential: true },
      post: { secret: true },
      video: { token: true },
    },
    indexFor(comment)
  );
  if (!resolver) throw new Error("Expected a configured omit resolver");
  return resolver;
}

describe("client omit through polymorphic projections", () => {
  test("promotes a true relation node for every configured target default", () => {
    const args = { include: { subject: true } };

    expect(
      applyClientOmit(comment, "findMany", args, configuredResolver())
    ).toEqual({
      include: {
        subject: {
          post: { omit: { secret: true } },
          video: { omit: { token: true } },
        },
      },
    });
  });

  test("rewrites explicit and defaulted variants with their own target model", () => {
    const args = {
      include: {
        subject: {
          post: { include: { author: true } },
        },
      },
    };

    expect(
      applyClientOmit(comment, "findMany", args, configuredResolver())
    ).toEqual({
      include: {
        subject: {
          post: {
            include: { author: { omit: { credential: true } } },
            omit: { secret: true },
          },
          video: { omit: { token: true } },
        },
      },
    });
  });

  test("leaves relation-level false and an unaffected payload identical", () => {
    const falseArgs = { include: { subject: false } };
    const unconfigured = {
      omit: () => undefined,
      relations: indexFor(comment),
    };
    const trueArgs = { include: { subject: true } };

    expect(
      applyClientOmit(comment, "findMany", falseArgs, configuredResolver())
    ).toBe(falseArgs);
    expect(applyClientOmit(comment, "findMany", trueArgs, unconfigured)).toBe(
      trueArgs
    );
  });
});

// =============================================================================
// COLLECTIONS — arms live under `variants`, and `only` is obeyed
// =============================================================================

const gallery = s.model({
  id: s.string().id(),
  items: s.toMany(
    { post: () => post, video: () => video },
    { values: { post: "gal.post.v1", video: "gal.video.v1" } }
  ),
});

/** A collection whose public variants are literally named `only`/`variants`. */
const onlyTarget = s.model({ id: s.string().id(), token: s.string() });
const hostile = s.model({
  id: s.string().id(),
  items: s.toMany(
    { only: () => onlyTarget, variants: () => video },
    { values: { only: "h.only.v1", variants: "h.variants.v1" } }
  ),
});

const collectionSchema = { author, post, video, gallery, onlyTarget, hostile };

prepareSchema(collectionSchema);

function collectionResolver() {
  const resolver = createClientOmitResolver(
    collectionSchema,
    {
      author: { credential: true },
      post: { secret: true },
      video: { token: true },
      onlyTarget: { token: true },
    },
    indexFor(gallery)
  );
  if (!resolver) throw new Error("Expected a configured omit resolver");
  return resolver;
}

describe("client omit through a polymorphic collection", () => {
  test("a bare true writes every arm UNDER `variants`", () => {
    // THE BUG THIS CLOSES: written at the projection's top level these arms are
    // unknown keys the strict envelope refuses, so `include: { items: true }`
    // threw on any client with a configured omit for a variant's target.
    expect(
      applyClientOmit(
        gallery,
        "findMany",
        { include: { items: true } },
        collectionResolver()
      )
    ).toEqual({
      include: {
        items: {
          variants: {
            post: { omit: { secret: true } },
            video: { omit: { token: true } },
          },
        },
      },
    });
  });

  test("an envelope is rewritten inside `variants`, preserving `only` verbatim", () => {
    expect(
      applyClientOmit(
        gallery,
        "findMany",
        {
          include: {
            items: {
              only: ["post"],
              variants: { post: { include: { author: true } } },
            },
          },
        },
        collectionResolver()
      )
    ).toEqual({
      include: {
        items: {
          only: ["post"],
          variants: {
            post: {
              include: { author: { omit: { credential: true } } },
              omit: { secret: true },
            },
          },
        },
      },
    });
  });

  test("a present `only` is OBEYED — no arm is synthesized outside it", () => {
    // Synthesizing `video` here would fabricate the envelope's own
    // "Variant 'video' is not in 'only'" refusal, from a client option the
    // caller never mentioned.
    const result = applyClientOmit(
      gallery,
      "findMany",
      { include: { items: { only: ["post"] } } },
      collectionResolver()
    );
    expect(result).toEqual({
      include: {
        items: {
          only: ["post"],
          variants: { post: { omit: { secret: true } } },
        },
      },
    });
  });

  test("a partial `variants` keeps the arms the caller wrote", () => {
    expect(
      applyClientOmit(
        gallery,
        "findMany",
        { include: { items: { variants: { video: { take: 2 } } } } },
        collectionResolver()
      )
    ).toEqual({
      include: {
        items: {
          variants: {
            post: { omit: { secret: true } },
            video: { take: 2, omit: { token: true } },
          },
        },
      },
    });
  });

  test("variants literally named `only` and `variants` are rewritten as arms", () => {
    expect(
      applyClientOmit(
        hostile,
        "findMany",
        { include: { items: true } },
        collectionResolver()
      )
    ).toEqual({
      include: {
        items: {
          variants: {
            only: { omit: { token: true } },
            variants: { omit: { token: true } },
          },
        },
      },
    });
  });

  test("an unconfigured collection payload is returned IDENTICAL", () => {
    const args = { include: { items: { only: ["post"] } } };
    const unconfigured = {
      omit: () => undefined,
      relations: indexFor(gallery),
    };
    expect(applyClientOmit(gallery, "findMany", args, unconfigured)).toBe(args);
    const falseArgs = { include: { items: false } };
    expect(
      applyClientOmit(gallery, "findMany", falseArgs, collectionResolver())
    ).toBe(falseArgs);
  });

  test("a malformed envelope is left for validation to name", () => {
    const badOnly = { include: { items: { only: "post" } } };
    const badVariants = { include: { items: { variants: 5 } } };
    expect(
      applyClientOmit(gallery, "findMany", badOnly, collectionResolver())
    ).toBe(badOnly);
    expect(
      applyClientOmit(gallery, "findMany", badVariants, collectionResolver())
    ).toBe(badVariants);
  });
});

// =============================================================================
// §11.4.11 — THE SETTLED TARGET, IN ALL THREE PROJECTION FAMILIES
// =============================================================================

/**
 * Getters that answer their REAL target once and a decoy ever after.
 *
 * The once-cell settles every target during declaration settlement, and the
 * resolver publishes the settled model on the edge. So the omit recursion must
 * reach the real model — the one the SCHEMA is made of — for an ordinary slot, a
 * row-carrier arm and a member-junction arm alike. Anything that re-invokes a
 * getter (or re-walks `targetEntries()`) reaches the decoy, which is configured
 * in NO client omit, so the rewrite silently writes nothing.
 *
 * Each getter is spelled INLINE rather than built by a helper: a variant map
 * whose value is a call expression loses `const` key inference and is refused by
 * the map overload's literal-key guard.
 */
describe("client omit reaches the SETTLED target", () => {
  // The ordinary pair's target carries the back-reference; the variant targets
  // deliberately carry none, so the variant MAPS do not close a type cycle
  // through `holder` (the recursive-model collapse `MEMORY.md` records).
  const ordinaryTarget = s.model({
    id: s.string().id(),
    secret: s.string(),
    holders: s.toMany(() => holder),
  });
  const variantTarget = s.model({
    id: s.string().id(),
    secret: s.string(),
  });
  const decoy = s.model({ id: s.string().id(), secret: s.string() });

  const settled = { direct: false, slot: false, items: false };

  const holder = s.model({
    id: s.string().id(),
    targetId: s.string(),
    // ORDINARY: one stateful getter behind a stored reference.
    direct: s
      .toOne(() => {
        if (settled.direct) return decoy;
        settled.direct = true;
        return ordinaryTarget;
      })
      .fields("targetId")
      .references("id"),
    // ROW CARRIER: one stateful getter behind a variant entry.
    slot: s.toOne(
      {
        real: () => {
          if (settled.slot) return decoy;
          settled.slot = true;
          return variantTarget;
        },
      },
      { values: { real: "settled.slot.real.v1" } }
    ),
    // MEMBER JUNCTION: the same, one storage family over.
    items: s.toMany(
      {
        real: () => {
          if (settled.items) return decoy;
          settled.items = true;
          return variantTarget;
        },
      },
      { values: { real: "settled.items.real.v1" } }
    ),
  });
  const settledSchema = { ordinaryTarget, variantTarget, decoy, holder };
  prepareSchema(settledSchema);

  function settledResolver() {
    const resolver = createClientOmitResolver(
      settledSchema,
      { ordinaryTarget: { secret: true }, variantTarget: { secret: true } },
      indexFor(holder)
    );
    if (!resolver) throw new Error("Expected a configured omit resolver");
    return resolver;
  }

  test("an ordinary slot, a row carrier and a member junction all reach it", () => {
    expect(
      applyClientOmit(
        holder,
        "findMany",
        { include: { direct: true, slot: true, items: true } },
        settledResolver()
      )
    ).toEqual({
      include: {
        direct: { omit: { secret: true } },
        slot: { real: { omit: { secret: true } } },
        items: { variants: { real: { omit: { secret: true } } } },
      },
    });
  });
});
