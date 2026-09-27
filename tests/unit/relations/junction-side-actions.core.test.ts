/**
 * Issue #46 — the junction action DECLARATION: one normalization owner.
 *
 * A model-target `s.toMany` takes a bare action (the symmetric shorthand) or an
 * exact `{ source, target }` map, and trusted state holds ONE form either way:
 * the side pair. What the pair means on the physical table is the resolver's
 * and the serializer's business (schema-validation and migrations layers);
 * here only the declaration boundary: what is stored, what chains, and what is
 * refused at the call the author wrote.
 */

import {
  isValidationError,
  type ValidationError,
  VibORMErrorCode,
} from "@errors";
import { s } from "@src/schema";
import type { AnyRelation } from "@src/schema/relation";
import { describe, expect, it } from "vitest";

const topic = s.model({ id: s.string().id() });

/** A value stripped of its literal type: the runtime boundary alone judges it. */
function hostile(value: unknown): any {
  return value;
}

function refusal(build: () => unknown): ValidationError {
  try {
    build();
  } catch (error) {
    if (isValidationError(error)) return error;
    throw error;
  }
  throw new Error("Expected a junction action refusal");
}

const junctionOf = (relation: AnyRelation) => relation["~"].state.junction;

describe("one stored form (plan I-46 implementation 1)", () => {
  it("stores the symmetric shorthand as the pair it abbreviates", () => {
    const relation = s.toMany(() => topic).onDelete("restrict");
    expect(junctionOf(relation)).toEqual({
      onDelete: { source: "restrict", target: "restrict" },
    });
  });

  it("stores a side map as stated, frozen", () => {
    const relation = s
      .toMany(() => topic)
      .onDelete({ source: "cascade", target: "noAction" })
      .onUpdate({ source: "cascade", target: "restrict" });
    const junction = junctionOf(relation);
    expect(junction).toEqual({
      onDelete: { source: "cascade", target: "noAction" },
      onUpdate: { source: "cascade", target: "restrict" },
    });
    expect(Object.isFrozen(junction?.onDelete)).toBe(true);
  });

  it("gives an equal map and the shorthand one identical state", () => {
    expect(
      junctionOf(
        s.toMany(() => topic).onDelete({ source: "cascade", target: "cascade" })
      )
    ).toEqual(junctionOf(s.toMany(() => topic).onDelete("cascade")));
  });

  it("snapshots the caller's map: a later mutation changes nothing", () => {
    const sides = { source: "cascade" as const, target: "noAction" as const };
    const relation = s.toMany(() => topic).onDelete(sides);
    hostile(sides).target = "restrict";
    expect(junctionOf(relation)).toEqual({
      onDelete: { source: "cascade", target: "noAction" },
    });
  });

  it("reads each side exactly once", () => {
    let reads = 0;
    const sides = { source: "cascade" };
    Object.defineProperty(sides, "target", {
      enumerable: true,
      get() {
        reads += 1;
        return "noAction";
      },
    });
    s.toMany(() => topic).onDelete(hostile(sides));
    expect(reads).toBe(1);
  });

  it("admits a null-prototype map, the plain record a parser can hand over", () => {
    const sides = Object.assign(Object.create(null), {
      source: "noAction",
      target: "cascade",
    });
    expect(junctionOf(s.toMany(() => topic).onUpdate(hostile(sides)))).toEqual({
      onUpdate: { source: "noAction", target: "cascade" },
    });
  });
});

describe("immutable chains and mixed spellings (witness: asymmetric DELETE and UPDATE independently, mixed shorthand/map)", () => {
  it("keeps DELETE and UPDATE independent", () => {
    const deleteOnly = s
      .toMany(() => topic)
      .onDelete({ source: "cascade", target: "restrict" });
    const updateOnly = s
      .toMany(() => topic)
      .onUpdate({ source: "restrict", target: "cascade" });
    expect(junctionOf(deleteOnly)).toEqual({
      onDelete: { source: "cascade", target: "restrict" },
    });
    expect(junctionOf(updateOnly)).toEqual({
      onUpdate: { source: "restrict", target: "cascade" },
    });
  });

  it("mixes a map for one action with the shorthand for the other", () => {
    const relation = s
      .toMany(() => topic)
      .onDelete({ source: "cascade", target: "noAction" })
      .onUpdate("cascade");
    expect(junctionOf(relation)).toEqual({
      onDelete: { source: "cascade", target: "noAction" },
      onUpdate: { source: "cascade", target: "cascade" },
    });
  });

  it("is last-call-wins in both directions and leaves every earlier value intact", () => {
    const shorthand = s.toMany(() => topic).onDelete("restrict");
    const mapped = shorthand.onDelete({
      source: "cascade",
      target: "noAction",
    });
    const back = mapped.onDelete("noAction");

    expect(junctionOf(shorthand)).toEqual({
      onDelete: { source: "restrict", target: "restrict" },
    });
    expect(junctionOf(mapped)).toEqual({
      onDelete: { source: "cascade", target: "noAction" },
    });
    expect(junctionOf(back)).toEqual({
      onDelete: { source: "noAction", target: "noAction" },
    });
  });

  it("keeps the names beside the actions through any order of calls", () => {
    const relation = s
      .toMany(() => topic)
      .onDelete({ source: "cascade", target: "noAction" })
      .through("post_topics")
      .source("postRef")
      .target("topicRef");
    expect(junctionOf(relation)).toEqual({
      table: "post_topics",
      source: "postRef",
      target: "topicRef",
      onDelete: { source: "cascade", target: "noAction" },
    });
  });
});

describe("refusals at the modifier (witness: wrong keys, missing side, setNull)", () => {
  const REFUSED = (path: string) => ({
    code: VibORMErrorCode.INVALID_INPUT,
    source: { kind: "schema-builder", builder: "s.toMany", path },
  });
  const judge = (build: () => unknown) => {
    const error = refusal(build);
    return { code: error.code, source: error.source };
  };
  const relation = () => hostile(s.toMany(() => topic));

  it("refuses an unknown key beside both sides", () => {
    expect(
      judge(() =>
        relation().onDelete({
          source: "cascade",
          target: "noAction",
          extra: "cascade",
        })
      )
    ).toEqual(REFUSED("onDelete"));
    expect(
      refusal(() =>
        relation().onUpdate({ source: "cascade", target: "cascade", both: 1 })
      ).issues[0]?.message
    ).toBe(
      "A junction 'onUpdate' map is a plain record naming exactly 'source' (the foreign key to the declaring model) and 'target' (the foreign key to its target model)"
    );
  });

  it("refuses a map that omits a side, or names neither", () => {
    expect(judge(() => relation().onDelete({ source: "cascade" }))).toEqual(
      REFUSED("onDelete")
    );
    expect(judge(() => relation().onUpdate({ target: "cascade" }))).toEqual(
      REFUSED("onUpdate")
    );
    expect(judge(() => relation().onDelete({}))).toEqual(REFUSED("onDelete"));
  });

  it("refuses `setNull` on either side, attributed to that side", () => {
    expect(
      judge(() => relation().onDelete({ source: "setNull", target: "cascade" }))
    ).toEqual(REFUSED("onDelete.source"));
    expect(
      judge(() => relation().onUpdate({ source: "cascade", target: "setNull" }))
    ).toEqual(REFUSED("onUpdate.target"));
    expect(
      refusal(() =>
        relation().onDelete({ source: "cascade", target: "setNull" })
      ).issues[0]?.message
    ).toContain("'setNull' cannot null a membership-key member");
  });

  it("refuses an explicit undefined side: stated is not omitted", () => {
    expect(
      judge(() => relation().onDelete({ source: "cascade", target: undefined }))
    ).toEqual(REFUSED("onDelete.target"));
  });

  it("refuses a value that is neither an action nor a plain map, in the words of what it was read as", () => {
    const refused = (value: unknown) => {
      const error = refusal(() => relation().onDelete(value));
      return { source: error.source, message: error.issues[0]?.message };
    };
    class Sides {
      readonly source = "cascade";
      readonly target = "noAction";
    }
    const inherited = Object.create({ source: "cascade", target: "noAction" });
    // Every object is read as a map: it is told what a map must be.
    for (const value of [new Sides(), inherited, ["cascade", "noAction"]]) {
      expect(refused(value)).toEqual({
        source: REFUSED("onDelete").source,
        message:
          "A junction 'onDelete' map is a plain record naming exactly 'source' (the foreign key to the declaring model) and 'target' (the foreign key to its target model)",
      });
    }
    // A non-object is read as the shorthand: it is told the action vocabulary.
    for (const value of [null, "CASCADE"]) {
      expect(refused(value).source).toEqual(REFUSED("onDelete").source);
      expect(refused(value).message).toContain(
        "A junction referential action must be one of 'cascade', 'restrict' or 'noAction'"
      );
    }
  });

  it("owns a throwing side accessor as V4002 with its path and cause", () => {
    const cause = new Error("side accessor failed");
    const sides = { source: "cascade" };
    Object.defineProperty(sides, "target", {
      enumerable: true,
      get() {
        throw cause;
      },
    });
    const error = refusal(() => relation().onDelete(sides));
    expect(error.source).toEqual({
      kind: "schema-builder",
      builder: "s.toMany",
      path: "onDelete.target",
    });
    expect(error.originalCause).toBeInstanceOf(Error);
  });

  it("offers the map to no row-reference owner: its actions stay single", () => {
    const owner = hostile(
      s
        .toOne(() => topic)
        .fields("topicId")
        .references("id")
    );
    const error = refusal(() =>
      owner.onDelete({ source: "cascade", target: "cascade" })
    );
    expect(error.source).toEqual({
      kind: "schema-builder",
      builder: "s.toOne",
      path: "onDelete",
    });
  });

  it("gives a variant collection no action modifier at all", () => {
    const variants = hostile(s.toMany({ topic: () => topic }));
    expect(variants.onDelete).toBeUndefined();
    expect(variants.onUpdate).toBeUndefined();
  });
});
