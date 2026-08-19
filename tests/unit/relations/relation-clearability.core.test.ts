import { s } from "@schema";
import {
  type MembershipCanBeCleared,
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
  // AMENDED with B2's widening: the shape fact admits the four FIELDS-LESS
  // shapes (compatibility with the bound group is the projection's question,
  // not this one's); every fields-bearing shape still may not.
  test("the four fields-less shapes may; every fields-bearing shape may not", () => {
    const target = s.model({ id: s.string().id() });

    expect(canBindPolymorphicInverse(stateOf(s.oneToMany(() => target)))).toBe(
      true
    );
    expect(canBindPolymorphicInverse(stateOf(s.oneToOne(() => target)))).toBe(
      true
    );
    expect(canBindPolymorphicInverse(stateOf(s.manyToOne(() => target)))).toBe(
      true
    );
    // A manyToMany never carries `.fields()`, so every one is fields-less.
    expect(canBindPolymorphicInverse(stateOf(s.manyToMany(() => target)))).toBe(
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
        .polymorphicToOne(
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
        .polymorphicToOne(
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

describe("membershipCanBeCleared — collection-group (toMany) bindings", () => {
  test("junction membership always clears, whatever the asking shape", () => {
    const collectionHolder = s.manyToOne(() => collectionOwner).optional();
    const collectionHolders = s.manyToMany(() => collectionOwner);
    const collectionParents = s.oneToMany(() => collectionOwner);
    const collectionMember = s.model({
      id: s.string().id(),
      holder: collectionHolder,
      holders: collectionHolders,
      parents: collectionParents,
    });
    const collectionOwner = s.model({
      id: s.string().id(),
      items: s.polymorphicToMany(
        { member: () => collectionMember },
        { values: { member: "clearability.collection.v1" } }
      ),
    });

    // Junction membership clears by DELETING the member row — singular inverse
    // (one row) and plural inverse (rows) alike; no column is ever nulled.
    expect(
      membershipCanBeCleared(stateOf(collectionHolder), collectionMember)
    ).toBe(true);
    expect(
      membershipCanBeCleared(stateOf(collectionHolders), collectionMember)
    ).toBe(true);
    // AMENDED BY B3's tightening (the conscious amendment the B2 dormancy note
    // demanded). The retained `oneToMany` shape no longer binds a collection
    // group, so it falls to its ORDINARY arm — and there it finds no
    // fields-bearing back-reference on the member at all, which is the same
    // `false` the "no resolvable back-reference means nothing to clear" pin
    // above records. Nothing about junction membership changed; this shape
    // simply stopped claiming to be junction membership.
    expect(
      membershipCanBeCleared(stateOf(collectionParents), collectionMember)
    ).toBe(false);
  });

  test("a fields-less manyToOne over a toOne group keeps the ordinary reading", () => {
    const singularHolder = s.manyToOne(() => singularOwner).optional();
    const singularMember = s.model({
      id: s.string().id(),
      holder: singularHolder,
    });
    const singularOwner = s.model({
      id: s.string().id(),
      item: s.polymorphicToOne(
        { member: () => singularMember },
        { values: { member: "clearability.singular.v1" } }
      ),
    });

    // The projection refuses the binding (toOne group, junction-shaped asker),
    // and undefined IS the ordinary fallback: no resolvable back-reference on
    // the owner records this membership, so there is nothing to clear.
    expect(
      membershipCanBeCleared(stateOf(singularHolder), singularMember)
    ).toBe(false);
  });
});

// =============================================================================
// Type-twin probes — one rule, both levels, with the documented divergence
// =============================================================================

const twinHolder = s.manyToOne(() => twinOwner).optional();
const twinHolders = s.manyToMany(() => twinOwner);
const twinParents = s.oneToMany(() => twinOwner);
const twinTwin = s.oneToOne(() => twinOwner).optional();
const twinMember = s.model({
  id: s.string().id(),
  holder: twinHolder,
  holders: twinHolders,
  parents: twinParents,
  twin: twinTwin,
});
const twinOwner = s.model({
  id: s.string().id(),
  items: s.polymorphicToMany(
    { member: () => twinMember },
    { values: { member: "clearability.twin.v1" } }
  ),
});
const twinSingularHolder = s.manyToOne(() => twinSingularOwner).optional();
const twinSingularMember = s.model({
  id: s.string().id(),
  holder: twinSingularHolder,
});
const twinSingularOwner = s.model({
  id: s.string().id(),
  item: s.polymorphicToOne(
    { member: () => twinSingularMember },
    { values: { member: "clearability.twin.singular.v1" } }
  ),
});

type Expect<Value extends true> = Value;
type TypeEqual<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends <
    Value,
  >() => Value extends Right ? 1 : 2
    ? true
    : false;

// The retained shapes reach the twin's `cardinality: "many"` arm over a toMany
// group — matching the runtime projection's B2 answer for those shapes.
type _oneToManyTwinClearsOverCollection = Expect<
  MembershipCanBeCleared<(typeof twinParents)["~"]["state"], typeof twinMember>
>;
type _fieldsLessOneToOneTwinClearsOverCollection = Expect<
  MembershipCanBeCleared<(typeof twinTwin)["~"]["state"], typeof twinMember>
>;
// The junction shapes stay TYPE-CONSERVATIVE (runtime true, twin false) — the
// twin's documented divergence #2 in `@schema/relation/inverse`; the operation
// surface is already correct for both shapes without the widening.
type _manyToOneTwinStaysConservative = Expect<
  TypeEqual<
    MembershipCanBeCleared<
      (typeof twinHolder)["~"]["state"],
      typeof twinMember
    >,
    false
  >
>;
type _manyToManyTwinStaysConservative = Expect<
  TypeEqual<
    MembershipCanBeCleared<
      (typeof twinHolders)["~"]["state"],
      typeof twinMember
    >,
    false
  >
>;
// Over a toOne group the ordinary reading answers at BOTH levels.
type _manyToOneOverSingularGroupMirrorsRuntime = Expect<
  TypeEqual<
    MembershipCanBeCleared<
      (typeof twinSingularHolder)["~"]["state"],
      typeof twinSingularMember
    >,
    false
  >
>;
