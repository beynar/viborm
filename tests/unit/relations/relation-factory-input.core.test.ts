/**
 * Structurally knowable input is judged AT THE FACTORY, before anything enters
 * trusted relation state — including input no TypeScript pin can see, because it
 * was parsed, spread, or forged at runtime.
 *
 * Plan §4.1 (V4002 / `schema-builder`), §4.2 (variant-map contract), §7.1
 * (guard ownership), falsifiers §11.1.3b, §11.1.4-6, §11.1.8 (model boundary),
 * §11.1.12. Ruling D5.
 */

import {
  isValidationError,
  type ValidationError,
  VibORMErrorCode,
} from "@errors";
import { s } from "@src/schema";
import { isVariantRelationState } from "@src/schema/relation/types";
import { describe, expect, it } from "vitest";

const post = s.model({ id: s.string().id() });
const video = s.model({ id: s.string().id() });

/**
 * A value stripped of its literal type — what a JSON payload, a spread, or
 * hostile JavaScript hands the factory. Every probe below that needs the
 * RUNTIME boundary enters through here, because the type surface refuses these
 * shapes on its own and would otherwise be the thing under test.
 */
function hostile(value: unknown): any {
  return value;
}

/**
 * One canonical rendering of a refusal: `"<code> <source.kind> <issue path>"`.
 *
 * Returning the rendering instead of asserting inside the helper keeps every
 * assertion in its own `it()`, and pinning the exact issue path is what proves
 * each refusal is attributed to the input it is about rather than merely thrown.
 */
function refusalOf(build: () => unknown): string {
  try {
    build();
  } catch (error) {
    if (isValidationError(error)) {
      return `${error.code} ${error.source.kind} ${error.issues[0]?.path ?? ""}`;
    }
    return `unexpected error: ${String(error)}`;
  }
  return "no refusal";
}

function refusalMessage(build: () => unknown): string {
  try {
    build();
  } catch (error) {
    return isValidationError(error) ? (error.issues[0]?.message ?? "") : "";
  }
  return "";
}

function validationRefusal(build: () => unknown): ValidationError {
  try {
    build();
  } catch (error) {
    if (isValidationError(error)) return error;
    throw error;
  }
  throw new Error("Expected a relation declaration refusal");
}

const REFUSED = (path: string) =>
  `${VibORMErrorCode.INVALID_INPUT} schema-builder ${path}`;

describe("variant target map", () => {
  it("refuses an empty dynamic map at construction", () => {
    expect(refusalOf(() => s.toOne(JSON.parse("{}")))).toBe(REFUSED("target"));
    expect(refusalOf(() => s.toMany(JSON.parse("{}")))).toBe(REFUSED("target"));
  });

  it("refuses a non-record target", () => {
    expect(refusalOf(() => s.toOne(JSON.parse("[]")))).toBe(REFUSED("target"));
    expect(refusalOf(() => s.toOne(JSON.parse("7")))).toBe(REFUSED("target"));
  });

  it("refuses a map whose prototype is not plain", () => {
    const inherited = Object.create({ inherited: () => post });
    inherited.post = () => post;
    expect(refusalOf(() => s.toOne(hostile(inherited)))).toBe(
      REFUSED("target")
    );
  });

  it("refuses a non-getter entry and names the repair", () => {
    expect(refusalOf(() => s.toOne(hostile({ video })))).toBe(
      REFUSED("target.video")
    );
    expect(refusalMessage(() => s.toOne(hostile({ video })))).toContain(
      "() => model"
    );
  });

  it("refuses a variant key that is not a schema identifier", () => {
    expect(
      refusalOf(() => s.toOne(hostile({ "not an identifier": () => post })))
    ).toBe(REFUSED("target.not an identifier"));
  });

  it("does not read symbol keys or inherited entries as variants", () => {
    const marker = Symbol("hidden");
    const relation = s.toOne(
      hostile({ post: () => post, [marker]: () => video })
    );
    expect(Object.keys(relation["~"].state.target.entries)).toEqual(["post"]);
  });

  it("snapshots the map so later caller mutation cannot change schema truth", () => {
    const map: Record<string, unknown> = { post: () => post };
    const relation = s.toOne(hostile(map));
    map.video = () => video;
    expect(Object.keys(relation["~"].state.target.entries)).toEqual(["post"]);
  });

  it("reads each own property exactly once", () => {
    let reads = 0;
    const map = {};
    Object.defineProperty(map, "post", {
      enumerable: true,
      get() {
        reads += 1;
        return () => post;
      },
    });
    s.toOne(hostile(map));
    expect(reads).toBe(1);
  });

  it("owns a throwing target accessor as V4002 with its exact builder, path and cause", () => {
    const cause = new Error("target accessor failed");
    const map = {};
    Object.defineProperty(map, "post", {
      enumerable: true,
      get() {
        throw cause;
      },
    });

    const refusal = validationRefusal(() => s.toOne(hostile(map)));

    expect(refusal.code).toBe(VibORMErrorCode.INVALID_INPUT);
    expect(refusal.source).toEqual({
      kind: "schema-builder",
      builder: "s.toOne",
      path: "target.post",
    });
    expect(refusal.issues).toEqual([
      expect.objectContaining({ path: "target.post" }),
    ]);
    expect(refusal.originalCause).toBeInstanceOf(Error);
  });

  it("freezes the normalized entries and the map that holds them", () => {
    const relation = s.toOne({ post: () => post });
    const entries = relation["~"].state.target.entries;
    expect(Object.isFrozen(entries)).toBe(true);
    expect(Object.isFrozen(entries.post)).toBe(true);
  });
});

describe("variant options", () => {
  it("uses each public key as its stored value by default", () => {
    const relation = s.toOne({ post: () => post, video: () => video });
    const entries = relation["~"].state.target.entries;
    expect(entries.post.storedValue).toBe("post");
    expect(entries.video.storedValue).toBe("video");
  });

  it("round-trips explicit stored values", () => {
    const relation = s.toMany(
      { post: () => post, video: () => video },
      { values: { post: "content.post.v1", video: "content.video.v1" } }
    );
    const entries = relation["~"].state.target.entries;
    expect(entries.post.storedValue).toBe("content.post.v1");
    expect(entries.video.storedValue).toBe("content.video.v1");
  });

  it("treats explicit undefined as omission", () => {
    const singular = s.toOne({ post: () => post }, undefined);
    const collection = s.toMany({ post: () => post }, undefined);
    expect(singular["~"].state.target.entries.post.storedValue).toBe("post");
    expect(collection["~"].state.target.entries.post.storedValue).toBe("post");
  });

  it("owns a throwing options.values accessor at that exact path", () => {
    const cause = new Error("values accessor failed");
    const options = {};
    Object.defineProperty(options, "values", {
      enumerable: true,
      get() {
        throw cause;
      },
    });

    const refusal = validationRefusal(() =>
      s.toMany({ post: () => post }, hostile(options))
    );

    expect(refusal.source).toEqual({
      kind: "schema-builder",
      builder: "s.toMany",
      path: "options.values",
    });
    expect(refusal.originalCause).toBeInstanceOf(Error);
  });

  it("owns a throwing stored-value accessor at the member path", () => {
    const cause = new Error("stored value accessor failed");
    const values = {};
    Object.defineProperty(values, "post", {
      enumerable: true,
      get() {
        throw cause;
      },
    });

    const refusal = validationRefusal(() =>
      s.toOne({ post: () => post }, hostile({ values }))
    );

    expect(refusal.source).toEqual({
      kind: "schema-builder",
      builder: "s.toOne",
      path: "options.values.post",
    });
    expect(refusal.originalCause).toBeInstanceOf(Error);
  });

  it("refuses an empty options bag", () => {
    expect(refusalOf(() => s.toOne({ post: () => post }, hostile({})))).toBe(
      REFUSED("options")
    );
  });

  it("refuses an options argument that is not a record at all", () => {
    expect(
      refusalOf(() => s.toOne({ post: () => post }, hostile("values")))
    ).toBe(REFUSED("options"));
    expect(refusalOf(() => s.toOne({ post: () => post }, hostile([])))).toBe(
      REFUSED("options")
    );
  });

  it("refuses a values entry that is not a record at all", () => {
    expect(
      refusalOf(() => s.toOne({ post: () => post }, hostile({ values: "p" })))
    ).toBe(REFUSED("options.values"));
  });

  it("refuses an unknown sibling option beside values", () => {
    expect(
      refusalOf(() =>
        s.toOne(
          { post: () => post },
          hostile({ values: { post: "p" }, unknownOption: true })
        )
      )
    ).toBe(REFUSED("options"));
  });

  it("refuses missing and extra values keys", () => {
    expect(
      refusalOf(() =>
        s.toOne(
          { post: () => post, video: () => video },
          hostile({ values: { post: "p" } })
        )
      )
    ).toBe(REFUSED("options.values"));
    expect(
      refusalOf(() =>
        s.toOne(
          { post: () => post },
          hostile({ values: { post: "p", audio: "a" } })
        )
      )
    ).toBe(REFUSED("options.values"));
  });

  it("refuses a stored value outside the discriminator grammar", () => {
    expect(
      refusalOf(() =>
        s.toOne({ post: () => post }, hostile({ values: { post: "no!" } }))
      )
    ).toBe(REFUSED("options.values.post"));
  });

  it("refuses two variants claiming one stored value", () => {
    expect(
      refusalOf(() =>
        s.toOne(
          { post: () => post, video: () => video },
          hostile({ values: { post: "same", video: "same" } })
        )
      )
    ).toBe(REFUSED("options.values.video"));
  });
});

describe("variant member junctions", () => {
  const carrier = () => s.toMany({ post: () => post, video: () => video });
  const complete = {
    post: { table: "mention_post", source: "mentionId", target: "postId" },
    video: { table: "mention_video", source: "mentionId", target: "videoId" },
  };

  it("folds one override into each normalized entry", () => {
    const entries = carrier().through(complete)["~"].state.target.entries;
    expect(entries.post.junction).toEqual(complete.post);
    expect(entries.video.junction).toEqual(complete.video);
    expect(entries.post.storedValue).toBe("post");
  });

  it("refuses a through argument that is not a map at all", () => {
    expect(refusalOf(() => carrier().through(hostile("mention_post")))).toBe(
      REFUSED("through")
    );
  });

  it("refuses an entry that is not a record at all", () => {
    expect(
      refusalOf(() =>
        carrier().through(hostile({ ...complete, post: "mention_post" }))
      )
    ).toBe(REFUSED("through.post"));
  });

  it("refuses a map that is not exact over the variants", () => {
    expect(
      refusalOf(() => carrier().through(hostile({ post: complete.post })))
    ).toBe(REFUSED("through"));
    expect(
      refusalOf(() =>
        carrier().through(hostile({ ...complete, audio: complete.post }))
      )
    ).toBe(REFUSED("through"));
  });

  it("refuses an entry that is not exactly table/source/target strings", () => {
    expect(
      refusalOf(() =>
        carrier().through(
          hostile({ ...complete, post: { ...complete.post, extra: 1 } })
        )
      )
    ).toBe(REFUSED("through.post"));
    expect(
      refusalOf(() =>
        carrier().through(
          hostile({ ...complete, post: { table: 1, source: "s", target: "t" } })
        )
      )
    ).toBe(REFUSED("through.post"));
  });

  it("owns a throwing through-member accessor at that member path", () => {
    const cause = new Error("through member accessor failed");
    const through = { video: complete.video };
    Object.defineProperty(through, "post", {
      enumerable: true,
      get() {
        throw cause;
      },
    });

    const refusal = validationRefusal(() =>
      carrier().through(hostile(through))
    );

    expect(refusal.source).toEqual({
      kind: "schema-builder",
      builder: "s.toMany",
      path: "through.post",
    });
    expect(refusal.originalCause).toBeInstanceOf(Error);
  });

  it.each([
    "table",
    "source",
    "target",
  ] as const)("owns a throwing through entry %s accessor at its property path", (property) => {
    const cause = new Error(`${property} accessor failed`);
    const override: Record<string, unknown> = {
      table: "mention_post",
      source: "mentionId",
      target: "postId",
    };
    Object.defineProperty(override, property, {
      enumerable: true,
      get() {
        throw cause;
      },
    });

    const refusal = validationRefusal(() =>
      s.toMany({ post: () => post }).through(hostile({ post: override }))
    );

    expect(refusal.source).toEqual({
      kind: "schema-builder",
      builder: "s.toMany",
      path: `through.post.${property}`,
    });
    expect(refusal.originalCause).toBeInstanceOf(Error);
  });
});

describe("factory arity", () => {
  it.each([
    ["s.toOne", s.toOne],
    ["s.toMany", s.toMany],
  ] as const)("refuses a second getter-form argument in %s", (builder, factory) => {
    const dynamicFactory = hostile(factory);

    expect(refusalOf(() => dynamicFactory(() => post, {}))).toBe(
      REFUSED("options")
    );
    expect(refusalOf(() => dynamicFactory(() => post, undefined))).toBe(
      REFUSED("options")
    );
    expect(
      validationRefusal(() => dynamicFactory(() => post, undefined)).source
    ).toEqual({ kind: "schema-builder", builder, path: "options" });
  });
});

describe("modifier tokens", () => {
  it("refuses an empty relation name", () => {
    expect(refusalOf(() => s.toOne(() => post).name(hostile("")))).toBe(
      REFUSED("name")
    );
    expect(
      refusalOf(() => s.toMany({ post: () => post }).name(hostile("")))
    ).toBe(REFUSED("name"));
  });

  it("refuses a junction token that is not a schema identifier", () => {
    expect(refusalOf(() => s.toMany(() => post).through("post tags"))).toBe(
      REFUSED("through")
    );
    expect(refusalOf(() => s.toMany(() => post).source("a-b"))).toBe(
      REFUSED("source")
    );
    expect(refusalOf(() => s.toMany(() => post).target(""))).toBe(
      REFUSED("target")
    );
  });

  it("refuses setNull on a junction action at runtime too", () => {
    expect(
      refusalOf(() => hostile(s.toMany(() => post)).onDelete("setNull"))
    ).toBe(REFUSED("onDelete"));
  });

  it("refuses a foreign-key action on a slot that owns no foreign key", () => {
    expect(
      refusalOf(() => hostile(s.toOne(() => post)).onDelete("cascade"))
    ).toBe(REFUSED("onDelete"));
  });

  it("accepts every referential action a foreign-key owner may carry", () => {
    const owner = () =>
      s
        .toOne(() => post)
        .fields("postId")
        .references("id");
    for (const action of [
      "cascade",
      "setNull",
      "restrict",
      "noAction",
    ] as const) {
      expect(owner().onDelete(action)["~"].state.foreignKey?.onDelete).toBe(
        action
      );
      expect(owner().onUpdate(action)["~"].state.foreignKey?.onUpdate).toBe(
        action
      );
    }
  });

  it("refuses a referential action outside that set", () => {
    const owner = hostile(
      s
        .toOne(() => post)
        .fields("postId")
        .references("id")
    );
    expect(refusalOf(() => owner.onDelete("SET NULL"))).toBe(
      REFUSED("onDelete")
    );
    expect(refusalOf(() => owner.onUpdate(undefined))).toBe(
      REFUSED("onUpdate")
    );
  });

  it("refuses an empty or unequal fields/references pair", () => {
    const relation = hostile(s.toOne(() => post));
    expect(refusalOf(() => relation.fields())).toBe(REFUSED("fields"));
    expect(refusalOf(() => relation.fields("a", "a"))).toBe(REFUSED("fields"));
    expect(refusalOf(() => relation.fields("a", "b").references("id"))).toBe(
      REFUSED("references")
    );
    expect(
      refusalOf(() => relation.fields("a", "b").references("id", "id"))
    ).toBe(REFUSED("references"));
    expect(refusalOf(() => relation.fields("a").references())).toBe(
      REFUSED("references")
    );
  });
});

describe("the s.model member boundary", () => {
  it("rejects an embedded incomplete foreign-key chain", () => {
    const stage = s.toOne(() => post).fields("postId");
    expect(
      refusalOf(() => s.model(hostile({ id: s.string().id(), broken: stage })))
    ).toBe(REFUSED("broken"));
  });

  it("keeps silently dropping any other unrecognized member", () => {
    const model = s.model(
      hostile({ id: s.string().id(), stray: { not: "a field" } })
    );
    expect(Object.keys(model["~"].state.scalars)).toEqual(["id"]);
    expect(Object.keys(model["~"].state.relations)).toEqual([]);
  });

  it("holds both target domains in ONE relation map, in declaration order", () => {
    const model = s.model({
      id: s.string().id(),
      author: s.toOne(() => post),
      subject: s.toOne({ post: () => post, video: () => video }),
      tags: s.toMany(() => post),
    });
    expect(Object.keys(model["~"].state.relations)).toEqual([
      "author",
      "subject",
      "tags",
    ]);
    // ONE map, so the target domain is a QUESTION asked of each entry rather
    // than a second lane. `isVariantRelationState` is the one spelling of it,
    // and every derived view splits on that axis before anything else.
    expect(
      Object.entries(model["~"].state.relations).map(([field, relation]) => [
        field,
        isVariantRelationState(relation["~"].state),
      ])
    ).toEqual([
      ["author", false],
      ["subject", true],
      ["tags", false],
    ]);
  });
});
