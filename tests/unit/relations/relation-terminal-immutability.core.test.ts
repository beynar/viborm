/**
 * Every modifier returns a NEW immutable value and leaves the prior one exactly
 * as it was — the property the whole declaration algebra rests on, because one
 * terminal may be reused under more than one model through `.extends()`.
 *
 * Plan §4.3 (immutable last-call-wins), §5.1 (canonical optional state),
 * falsifiers §11.1.8-9 (runtime halves).
 */

import type { AnyRelation, RelationState } from "@schema/relation";
import { s } from "@src/schema";
import { describe, expect, it } from "vitest";

const target = s.model({ id: s.string().id() });
const other = s.model({ id: s.string().id() });

/**
 * Read a terminal through the CLOSED state union — what every consumer does.
 *
 * A concrete factory state deliberately under-promises: it names only the facts
 * the chain actually declared, so `name`, `junction` and `foreignKey` are absent
 * from its type until the modifier that owns them ran. The union is where the
 * canonical "absent, or exactly one normalized value" reading is spelled.
 */
function stateOf(relation: AnyRelation): RelationState {
  return relation["~"].state;
}

/** Any terminal, viewed through the one modifier all four share. */
type NamedTerminal = AnyRelation & { name(value: string): NamedTerminal };

describe("last-call-wins on every terminal", () => {
  it("renames without touching the prior relation", () => {
    const terminals: NamedTerminal[] = [
      s.toOne(() => target),
      s.toMany(() => target),
      s.toOne({ post: () => target }),
      s.toMany({ post: () => target }),
    ];
    for (const first of terminals) {
      const named = first.name("first");
      const renamed = named.name("second");
      expect(stateOf(first).name).toBeUndefined();
      expect(stateOf(named).name).toBe("first");
      expect(stateOf(renamed).name).toBe("second");
      expect(renamed).not.toBe(named);
    }
  });

  it("keeps trusted state frozen", () => {
    const relation = s.toOne(() => target).name("frozen");
    expect(Object.isFrozen(relation["~"].state)).toBe(true);
  });

  it("stores an optional variant slot only when it was declared", () => {
    const required = s.toOne({ post: () => target });
    const optional = required.optional();
    expect("optional" in stateOf(required)).toBe(false);
    expect(optional["~"].state.optional).toBe(true);
    expect(optional.optional()["~"].state.optional).toBe(true);
  });
});

describe("ordinary junction overrides", () => {
  it("replaces only its own fact on the newly returned value", () => {
    const base = s.toMany(() => target);
    const withTable = base.through("source_targets");
    const withSides = withTable.source("sourceId").target("targetId");
    const retabled = withSides.through("other_table");

    expect(stateOf(base).junction).toBeUndefined();
    expect(stateOf(withTable).junction).toEqual({ table: "source_targets" });
    expect(stateOf(withSides).junction).toEqual({
      table: "source_targets",
      source: "sourceId",
      target: "targetId",
    });
    expect(stateOf(retabled).junction).toEqual({
      table: "other_table",
      source: "sourceId",
      target: "targetId",
    });
  });

  it("stores actions inside the one junction value", () => {
    const configured = s
      .toMany(() => target)
      .onDelete("cascade")
      .onUpdate("restrict");
    expect(stateOf(configured).junction).toEqual({
      onDelete: "cascade",
      onUpdate: "restrict",
    });
  });
});

describe("the fields/references staging", () => {
  it("promotes only a complete pair into trusted state", () => {
    const owner = s
      .toOne(() => target)
      .fields("targetId")
      .references("id");
    expect(owner["~"].state.foreignKey).toEqual({
      fields: ["targetId"],
      references: ["id"],
    });
  });

  it("snapshots both rest-argument tuples", () => {
    const owner = s
      .toOne(() => target)
      .fields("tenantId", "targetId")
      .references("tenantId", "id");
    const foreignKey = owner["~"].state.foreignKey;
    expect(foreignKey.fields).toEqual(["tenantId", "targetId"]);
    expect(foreignKey.references).toEqual(["tenantId", "id"]);
    expect(Object.isFrozen(foreignKey)).toBe(true);
  });

  it("replaces the pair atomically while preserving name and actions", () => {
    const first = s
      .toOne(() => target)
      .name("Owner")
      .fields("targetId")
      .references("id")
      .onDelete("cascade")
      .onUpdate("restrict");
    const second = first.fields("tenantId").references("id");

    expect(first["~"].state.foreignKey.fields).toEqual(["targetId"]);
    expect(second["~"].state.foreignKey).toEqual({
      fields: ["tenantId"],
      references: ["id"],
      onDelete: "cascade",
      onUpdate: "restrict",
    });
    expect(second["~"].state.name).toBe("Owner");
  });

  it("carries a name stated on the stage onto the completed owner", () => {
    const owner = s
      .toOne(() => target)
      .fields("targetId")
      .name("Staged")
      .references("id");
    expect(owner["~"].state.name).toBe("Staged");
    expect(owner["~"].state.foreignKey.fields).toEqual(["targetId"]);
  });

  it("leaves the terminal a stage was started from untouched", () => {
    const before = s.toOne(() => target).name("Before");
    before.fields("targetId").references("id");
    expect(stateOf(before).foreignKey).toBeUndefined();
  });
});

describe("variant member junctions", () => {
  it("folds overrides into a new entry map without touching the prior one", () => {
    const base = s.toMany({ post: () => target, video: () => other });
    const configured = base.through({
      post: { table: "mention_post", source: "mentionId", target: "postId" },
      video: { table: "mention_video", source: "mentionId", target: "videoId" },
    });
    expect(base["~"].state.target.entries.post.junction).toBeUndefined();
    expect(configured["~"].state.target.entries.post.junction).toEqual({
      table: "mention_post",
      source: "mentionId",
      target: "postId",
    });
  });
});
