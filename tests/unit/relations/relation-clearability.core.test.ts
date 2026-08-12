import { s } from "@schema";
import {
  membershipCanBeCleared,
  slotMayBeEmpty,
} from "@schema/relation/clearability";
import { canBindPolymorphicInverse } from "@schema/relation/inverse";
import { describe, expect, test } from "vitest";

/**
 * THE TWO FACTS ABOUT EMPTYING A RELATION, and the reason they are two.
 *
 * `slotMayBeEmpty` is what the declaration says: may this relation hold nothing.
 * `membershipCanBeCleared` is what the storage allows: may the columns recording the
 * membership be nulled while both records survive. An optional slot whose child-side
 * foreign key is NOT nullable satisfies the first and fails the second — that schema
 * is legal, and the operation surface it produces offers `delete` without
 * `disconnect`. Nothing here may derive one fact from the other.
 */

const stateOf = (relation: { "~": { state: unknown } }) =>
  relation["~"].state as Parameters<typeof membershipCanBeCleared>[0];

describe("slotMayBeEmpty — the public slot", () => {
  test("follows the declaration's own optionality", () => {
    const target = s.model({ id: s.string().id() });
    const optional = s.oneToOne(() => target).optional();
    const required = s.oneToOne(() => target);
    const toMany = s.oneToMany(() => target);

    expect(slotMayBeEmpty(stateOf(optional))).toBe(true);
    expect(slotMayBeEmpty(stateOf(required))).toBe(false);
    // A to-many slot is never declared optional; an empty list is not an empty slot.
    expect(slotMayBeEmpty(stateOf(toMany))).toBe(false);
  });
});

describe("canBindPolymorphicInverse — which shapes may take a polymorphic inverse", () => {
  test("a oneToMany and a fields-less oneToOne may; every fields-bearing shape may not", () => {
    const target = s.model({ id: s.string().id() });

    expect(canBindPolymorphicInverse(stateOf(s.oneToMany(() => target)))).toBe(
      true
    );
    expect(canBindPolymorphicInverse(stateOf(s.oneToOne(() => target)))).toBe(
      true
    );
    // A zero-argument `.fields()` is fields-LESS — the aligned reading.
    expect(
      canBindPolymorphicInverse(stateOf(s.oneToOne(() => target).fields()))
    ).toBe(true);
    expect(
      canBindPolymorphicInverse(
        stateOf(
          s
            .oneToOne(() => target)
            .fields("targetId")
            .references("id")
        )
      )
    ).toBe(false);
    expect(
      canBindPolymorphicInverse(
        stateOf(
          s
            .manyToOne(() => target)
            .fields("targetId")
            .references("id")
        )
      )
    ).toBe(false);
    expect(canBindPolymorphicInverse(stateOf(s.manyToMany(() => target)))).toBe(
      false
    );
  });
});

describe("membershipCanBeCleared — the physical membership", () => {
  test("a polymorphic inverse reads the target relation's own optionality", () => {
    const optionalOwner = s.model({
      id: s.string().id(),
      entries: s.oneToMany(() => optionalEntry).name("optionalOwned"),
    });
    const optionalEntry = s.model({
      id: s.string().id(),
      owner: s
        .polymorphic(
          { owner: () => optionalOwner },
          { values: { owner: "clearability.optional.v1" } }
        )
        .name("optionalOwned")
        .optional(),
    });
    const requiredOwner = s.model({
      id: s.string().id(),
      entries: s.oneToMany(() => requiredEntry).name("requiredOwned"),
    });
    const requiredEntry = s.model({
      id: s.string().id(),
      owner: s
        .polymorphic(
          { owner: () => requiredOwner },
          { values: { owner: "clearability.required.v1" } }
        )
        .name("requiredOwned"),
    });

    expect(
      membershipCanBeCleared(
        stateOf(optionalOwner["~"].state.relations.entries),
        optionalOwner
      )
    ).toBe(true);
    // The private `(type, id)` pair is nullable exactly when the relation is
    // optional, so a required membership cannot be cleared — only removed.
    expect(
      membershipCanBeCleared(
        stateOf(requiredOwner["~"].state.relations.entries),
        requiredOwner
      )
    ).toBe(false);
  });

  test("an ordinary inverse reads every foreign-key scalar's nullability", () => {
    const nullableParent = s.model({
      id: s.string().id(),
      children: s.oneToMany(() => nullableChild),
    });
    const nullableChild = s.model({
      id: s.string().id(),
      parentId: s.string().nullable(),
      parent: s
        .manyToOne(() => nullableParent)
        .fields("parentId")
        .references("id")
        .optional(),
    });
    const requiredParent = s.model({
      id: s.string().id(),
      children: s.oneToMany(() => requiredChild),
    });
    const requiredChild = s.model({
      id: s.string().id(),
      parentId: s.string(),
      parent: s
        .manyToOne(() => requiredParent)
        .fields("parentId")
        .references("id"),
    });

    expect(
      membershipCanBeCleared(
        stateOf(nullableParent["~"].state.relations.children),
        nullableParent
      )
    ).toBe(true);
    expect(
      membershipCanBeCleared(
        stateOf(requiredParent["~"].state.relations.children),
        requiredParent
      )
    ).toBe(false);
  });

  test("a compound foreign key clears only when EVERY column accepts null", () => {
    const compoundParent = s.model({
      id: s.string().id(),
      tenant: s.string(),
      children: s.oneToMany(() => compoundChild),
    });
    const compoundChild = s.model({
      id: s.string().id(),
      parentId: s.string().nullable(),
      parentTenant: s.string(),
      parent: s
        .manyToOne(() => compoundParent)
        .fields("parentId", "parentTenant")
        .references("id", "tenant"),
    });

    expect(
      membershipCanBeCleared(
        stateOf(compoundParent["~"].state.relations.children),
        compoundParent
      )
    ).toBe(false);
  });

  test("no resolvable back-reference means nothing to clear", () => {
    const lonelyParent = s.model({
      id: s.string().id(),
      children: s.oneToMany(() => lonelyChild),
    });
    const lonelyChild = s.model({ id: s.string().id() });

    expect(
      membershipCanBeCleared(
        stateOf(lonelyParent["~"].state.relations.children),
        lonelyParent
      )
    ).toBe(false);
  });

  test("a parent-held to-one names columns the TARGET does not carry", () => {
    // `getInverseRelationMap` answers this side's OWN `.fields()` here, and those
    // columns are on the source row. This function reads the target's scalars, so
    // the answer is false — which is why the operation surface asks it only for the
    // edges whose membership the TARGET records (fields-less inverses and to-many).
    const desk = s.model({
      id: s.string().id(),
      owners: s.oneToMany(() => owner),
    });
    const owner = s.model({
      id: s.string().id(),
      deskId: s.string().nullable(),
      desk: s
        .manyToOne(() => desk)
        .fields("deskId")
        .references("id")
        .optional(),
    });

    expect(
      membershipCanBeCleared(stateOf(owner["~"].state.relations.desk), owner)
    ).toBe(false);
  });
});
