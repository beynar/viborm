import { PostgresAdapter } from "@adapters/databases/postgres/postgres-adapter";
import { buildParsedRelationPrograms } from "@query-engine/builders/relation-mutation-parser";
import {
  assertRelationKeyUpdatesAreCompilable,
  assertSingleTargetMembershipMoveAppliesToRecords,
} from "@query-engine/relation-key-legality";
import { s } from "@schema";
import { prepareSchema, scopeFor } from "@tests/fixtures/query-scope";
import { describe, expect, test } from "vitest";

const rowHeldSchema = (() => {
  const child = s.model({
    id: s.int().id(),
    parentId: s.int().nullable(),
    parent: s
      .toOne(() => parent)
      .fields("parentId")
      .references("id"),
  });
  const parent = s.model({
    id: s.int().id(),
    children: s.toMany(() => child),
  });
  return { parent, child };
})();

const junctionSchema = (() => {
  const owner = s.model({
    id: s.int().id(),
    targets: s.toMany(() => target).through("legality_owner_target"),
  });
  const target = s.model({
    id: s.int().id(),
    owners: s.toMany(() => owner),
  });
  return { owner, target };
})();

const collectionSchema = (() => {
  const post = s.model({ id: s.int().id() });
  const clip = s.model({
    id: s.int().id(),
    board: s.toOne(() => board),
  });
  const board = s.model({
    id: s.int().id(),
    items: s.toMany(
      { post: () => post, clip: () => clip },
      {
        values: {
          post: "legality.post.v1",
          clip: "legality.clip.v1",
        },
      }
    ),
  });
  return { board, post, clip };
})();

prepareSchema(rowHeldSchema);
prepareSchema(junctionSchema);
prepareSchema(collectionSchema);

const adapter = new PostgresAdapter();

function parsedRelations(
  source: Parameters<typeof scopeFor>[1],
  data: Record<string, unknown>
) {
  const scope = scopeFor(adapter, source);
  return {
    scope,
    relations: buildParsedRelationPrograms(scope, data).relations,
  };
}

describe("single-target membership move legality", () => {
  test("refuses one row-held target assigned to several source records", () => {
    const { scope, relations } = parsedRelations(rowHeldSchema.parent, {
      children: { connect: { id: 7 } },
    });

    expect(() =>
      assertSingleTargetMembershipMoveAppliesToRecords(scope, relations, 1)
    ).not.toThrow();
    expect(() =>
      assertSingleTargetMembershipMoveAppliesToRecords(scope, relations, 2)
    ).toThrow("membership is stored on the target row");
  });

  test("classifies set and connectOrCreate as named row-held moves", () => {
    const set = parsedRelations(rowHeldSchema.parent, {
      children: { set: [{ id: 7 }] },
    });
    const connectOrCreate = parsedRelations(rowHeldSchema.parent, {
      children: {
        connectOrCreate: {
          where: { id: 7 },
          create: { id: 7 },
        },
      },
    });

    expect(() =>
      assertSingleTargetMembershipMoveAppliesToRecords(
        set.scope,
        set.relations,
        2
      )
    ).toThrow("apply 'set' to relation 'children'");
    expect(() =>
      assertSingleTargetMembershipMoveAppliesToRecords(
        connectOrCreate.scope,
        connectOrCreate.relations,
        2
      )
    ).toThrow("apply 'connectOrCreate' to relation 'children'");
  });

  test("allows empty moves, fresh targets, and plural junction memberships", () => {
    const emptySet = parsedRelations(rowHeldSchema.parent, {
      children: { set: [] },
    });
    const freshCreate = parsedRelations(rowHeldSchema.parent, {
      children: { create: { id: 7 } },
    });
    const pluralJunction = parsedRelations(junctionSchema.owner, {
      targets: { connect: { id: 7 } },
    });

    for (const plan of [emptySet, freshCreate, pluralJunction]) {
      expect(() =>
        assertSingleTargetMembershipMoveAppliesToRecords(
          plan.scope,
          plan.relations,
          2
        )
      ).not.toThrow();
    }
  });

  test("distinguishes a singular polymorphic member-junction slot", () => {
    const singular = parsedRelations(collectionSchema.board, {
      items: { connect: [{ type: "clip", where: { id: 7 } }] },
    });
    const plural = parsedRelations(collectionSchema.board, {
      items: { connect: [{ type: "post", where: { id: 8 } }] },
    });

    expect(() =>
      assertSingleTargetMembershipMoveAppliesToRecords(
        singular.scope,
        singular.relations,
        2
      )
    ).toThrow("member-junction slot can belong to only one");
    expect(() =>
      assertSingleTargetMembershipMoveAppliesToRecords(
        plural.scope,
        plural.relations,
        2
      )
    ).not.toThrow();
  });
});

describe("relation-key update legality", () => {
  test("refuses a nonliteral parent-held key update beside a relation mutation", () => {
    const plan = parsedRelations(rowHeldSchema.child, {
      parent: { connect: { id: 7 } },
    });

    expect(() =>
      assertRelationKeyUpdatesAreCompilable(
        plan.scope,
        { parentId: { increment: 1 } },
        plan.relations
      )
    ).toThrow(
      "Cannot update relation key field 'parentId' with a non-literal operation"
    );
    expect(() =>
      assertRelationKeyUpdatesAreCompilable(
        plan.scope,
        { parentId: { set: 7 } },
        plan.relations
      )
    ).not.toThrow();
  });

  test("leaves junction storage and child-held primary-key cascades to their owners", () => {
    const junction = parsedRelations(junctionSchema.owner, {
      targets: { connect: { id: 7 } },
    });
    const childHeld = parsedRelations(rowHeldSchema.parent, {
      children: { connect: { id: 7 } },
    });

    expect(() =>
      assertRelationKeyUpdatesAreCompilable(
        junction.scope,
        { id: { increment: 1 } },
        junction.relations
      )
    ).not.toThrow();
    expect(() =>
      assertRelationKeyUpdatesAreCompilable(
        childHeld.scope,
        { id: { increment: 1 } },
        childHeld.relations
      )
    ).not.toThrow();
  });
});
