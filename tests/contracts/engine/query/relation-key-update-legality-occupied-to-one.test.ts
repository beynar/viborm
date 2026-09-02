import {
  expectParity,
  type LegalityClient,
  RESTRICT_OCCUPIED_ERROR,
  SET_NULL_OCCUPIED_ERROR,
  TARGET_NOT_FOUND_ERROR,
} from "@tests/contracts/engine/query/relation-key-update-legality-fixtures";
import { describe, test } from "vitest";

// T4c-fix, the ONE-TO-ONE half: the occupied guard swept across nested KINDS (update /
// delete / disconnect) on a child-held to-one whose referenced PK the same root update
// transitions, on both non-cascade actions, with the empty-slot arms beside each
// rejection. The to-many half of the same sweep is
// `relation-key-update-legality-occupied-to-many.test.ts`; the single nested-upsert shape
// the original T4c wired is in `relation-key-update-legality-transition-arm.test.ts`.
// The schema and the parity oracle live in
// `relation-key-update-legality-fixtures.ts`.

describe("relation-key update legality", () => {
  // T4c-fix — V1's occupied guard is kind- AND cardinality-agnostic: EVERY nested
  // mutation on a child-held, non-cascade relation whose referenced PK the SAME root
  // update transitions rejects an occupied OLD slot, not only the nested `upsert` the
  // original T4c wired. The finding: update / delete / disconnect / create (and the whole
  // to-many family) reached NO guard and diverged (accept-where-V1-rejects — corruption /
  // data-loss). These reproduce V1's verdict natively (byte-identical NestedWriteError,
  // both substrates); the empty-slot accept-shapes stay native.
  const seedOccupiedSetNullOneToOne = async (client: LegalityClient) => {
    await client.setNullParent.create({ data: { id: 1, name: "Parent" } });
    await client.setNullChild.create({
      data: { id: 1, label: "Child", parentId: 1 },
    });
  };
  const setNullOneToOneState = async (client: LegalityClient) => ({
    parents: await client.setNullParent.findMany(),
    children: await client.setNullChild.findMany(),
  });
  const occupiedSetNullOneToOneUnchanged = {
    parents: [{ id: 1, name: "Parent" }],
    children: [{ id: 1, label: "Child", parentId: 1 }],
  };

  test("rejects an occupied setNull child-held UPDATE under a PK transition", async () => {
    await expectParity(
      {
        seed: seedOccupiedSetNullOneToOne,
        act: (client) =>
          client.setNullParent.update({
            where: { id: 1 },
            data: {
              id: { increment: 1 },
              child: { update: { label: "must not change" } },
            },
          }),
        snapshot: setNullOneToOneState,
        expectedState: occupiedSetNullOneToOneUnchanged,
      },
      SET_NULL_OCCUPIED_ERROR
    );
  });

  test("rejects an occupied setNull child-held DELETE under a PK transition", async () => {
    await expectParity(
      {
        seed: seedOccupiedSetNullOneToOne,
        act: (client) =>
          client.setNullParent.update({
            where: { id: 1 },
            data: { id: { increment: 1 }, child: { delete: true } },
          }),
        snapshot: setNullOneToOneState,
        expectedState: occupiedSetNullOneToOneUnchanged,
      },
      SET_NULL_OCCUPIED_ERROR
    );
  });

  test("rejects an occupied setNull child-held DISCONNECT under a PK transition", async () => {
    await expectParity(
      {
        seed: seedOccupiedSetNullOneToOne,
        act: (client) =>
          client.setNullParent.update({
            where: { id: 1 },
            data: { id: { increment: 1 }, child: { disconnect: true } },
          }),
        snapshot: setNullOneToOneState,
        expectedState: occupiedSetNullOneToOneUnchanged,
      },
      SET_NULL_OCCUPIED_ERROR
    );
  });

  test("reports not-found for an empty setNull child-held UPDATE under a PK transition", async () => {
    await expectParity(
      {
        seed: async (client) => {
          await client.setNullParent.create({
            data: { id: 1, name: "Parent" },
          });
        },
        act: (client) =>
          client.setNullParent.update({
            where: { id: 1 },
            data: {
              id: { increment: 1 },
              child: { update: { label: "no target" } },
            },
          }),
        snapshot: setNullOneToOneState,
        expectedState: { parents: [{ id: 1, name: "Parent" }], children: [] },
      },
      TARGET_NOT_FOUND_ERROR
    );
  });

  test("allows an empty setNull child-held DELETE under a PK transition", async () => {
    await expectParity(
      {
        seed: async (client) => {
          await client.setNullParent.create({
            data: { id: 1, name: "Parent" },
          });
        },
        act: (client) =>
          client.setNullParent.update({
            where: { id: 1 },
            data: { id: { increment: 1 }, child: { delete: true } },
          }),
        snapshot: setNullOneToOneState,
        expectedState: { parents: [{ id: 2, name: "Parent" }], children: [] },
      },
      undefined
    );
  });

  test("rejects an occupied restrict child-held UPDATE under a PK transition", async () => {
    await expectParity(
      {
        seed: async (client) => {
          await client.restrictParent.create({
            data: { id: 1, name: "Parent" },
          });
          await client.restrictChild.create({
            data: { id: 1, label: "Child", parentId: 1 },
          });
        },
        act: (client) =>
          client.restrictParent.update({
            where: { id: 1 },
            data: {
              id: { increment: 1 },
              child: { update: { label: "must not change" } },
            },
          }),
        snapshot: async (client) => ({
          parents: await client.restrictParent.findMany(),
          children: await client.restrictChild.findMany(),
        }),
        expectedState: {
          parents: [{ id: 1, name: "Parent" }],
          children: [{ id: 1, label: "Child", parentId: 1 }],
        },
      },
      RESTRICT_OCCUPIED_ERROR
    );
  });

  test("rejects an occupied restrict child-held DELETE under a PK transition", async () => {
    await expectParity(
      {
        seed: async (client) => {
          await client.restrictParent.create({
            data: { id: 1, name: "Parent" },
          });
          await client.restrictChild.create({
            data: { id: 1, label: "Child", parentId: 1 },
          });
        },
        act: (client) =>
          client.restrictParent.update({
            where: { id: 1 },
            data: { id: { increment: 1 }, child: { delete: true } },
          }),
        snapshot: async (client) => ({
          parents: await client.restrictParent.findMany(),
          children: await client.restrictChild.findMany(),
        }),
        expectedState: {
          parents: [{ id: 1, name: "Parent" }],
          children: [{ id: 1, label: "Child", parentId: 1 }],
        },
      },
      RESTRICT_OCCUPIED_ERROR
    );
  });
});
