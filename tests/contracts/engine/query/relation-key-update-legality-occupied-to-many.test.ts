import {
  expectParity,
  type LegalityClient,
  SET_NULL_OCCUPIED_ERROR,
} from "@tests/contracts/engine/query/relation-key-update-legality-fixtures";
import { describe, test } from "vitest";

// T4c-fix, the TO-MANY half: the same occupied guard is cardinality-agnostic, so the
// update / delete / create sweep is repeated on a child-held to-many, with the empty-slot
// accept beside it and the two multi-parent witnesses that pin the guard's correlation to
// THIS parent. Its one-to-one twin is
// `relation-key-update-legality-occupied-to-one.test.ts`. The schema and the parity
// oracle live in `relation-key-update-legality-fixtures.ts`.

describe("relation-key update legality", () => {
  const seedOccupiedSetNullToMany = async (client: LegalityClient) => {
    await client.setNullList.create({ data: { id: 1, name: "List" } });
    await client.setNullItem.create({
      data: { id: 10, label: "Item", listId: 1 },
    });
  };
  const setNullToManyState = async (client: LegalityClient) => ({
    lists: await client.setNullList.findMany({ orderBy: { id: "asc" } }),
    items: await client.setNullItem.findMany({ orderBy: { id: "asc" } }),
  });
  const occupiedSetNullToManyUnchanged = {
    lists: [{ id: 1, name: "List" }],
    items: [{ id: 10, label: "Item", listId: 1 }],
  };

  test("rejects an occupied setNull TO-MANY UPDATE under a PK transition", async () => {
    await expectParity(
      {
        seed: seedOccupiedSetNullToMany,
        act: (client) =>
          client.setNullList.update({
            where: { id: 1 },
            data: {
              id: { increment: 5 },
              items: { update: { where: { id: 10 }, data: { label: "X" } } },
            },
          }),
        snapshot: setNullToManyState,
        expectedState: occupiedSetNullToManyUnchanged,
      },
      SET_NULL_OCCUPIED_ERROR
    );
  });

  test("rejects an occupied setNull TO-MANY DELETE under a PK transition", async () => {
    await expectParity(
      {
        seed: seedOccupiedSetNullToMany,
        act: (client) =>
          client.setNullList.update({
            where: { id: 1 },
            data: { id: { increment: 5 }, items: { delete: { id: 10 } } },
          }),
        snapshot: setNullToManyState,
        expectedState: occupiedSetNullToManyUnchanged,
      },
      SET_NULL_OCCUPIED_ERROR
    );
  });

  test("rejects an occupied setNull TO-MANY CREATE under a PK transition", async () => {
    await expectParity(
      {
        seed: seedOccupiedSetNullToMany,
        act: (client) =>
          client.setNullList.update({
            where: { id: 1 },
            data: {
              id: { increment: 5 },
              items: { create: { id: 20, label: "New" } },
            },
          }),
        snapshot: setNullToManyState,
        expectedState: occupiedSetNullToManyUnchanged,
      },
      SET_NULL_OCCUPIED_ERROR
    );
  });

  test("allows an empty setNull TO-MANY CREATE under a PK transition", async () => {
    await expectParity(
      {
        seed: async (client) => {
          await client.setNullList.create({ data: { id: 1, name: "List" } });
        },
        act: (client) =>
          client.setNullList.update({
            where: { id: 1 },
            data: {
              id: { increment: 5 },
              items: { create: { id: 20, label: "New" } },
            },
          }),
        snapshot: setNullToManyState,
        expectedState: {
          lists: [{ id: 6, name: "List" }],
          items: [{ id: 20, label: "New", listId: 6 }],
        },
      },
      undefined
    );
  });

  // MULTI-PARENT WITNESS: the occupied guard correlates on THIS parent's pre-transition
  // value, not globally. An occupied SIBLING (list 2, its own item) must NOT false-reject
  // an EMPTY target's (list 1) transition — the create lands on list 1's post-transition
  // id, the sibling's item is untouched. (Falsifying the guard's `before` correlation to a
  // constant would reject here where V1 accepts.)
  test("correlates the occupied guard on THIS parent (occupied sibling does not false-reject an empty target)", async () => {
    await expectParity(
      {
        seed: async (client) => {
          await client.setNullList.create({ data: { id: 1, name: "Target" } });
          await client.setNullList.create({ data: { id: 2, name: "Sibling" } });
          await client.setNullItem.create({
            data: { id: 30, label: "SiblingItem", listId: 2 },
          });
        },
        act: (client) =>
          client.setNullList.update({
            where: { id: 1 },
            data: {
              id: { increment: 5 },
              items: { create: { id: 20, label: "New" } },
            },
          }),
        snapshot: setNullToManyState,
        expectedState: {
          lists: [
            { id: 2, name: "Sibling" },
            { id: 6, name: "Target" },
          ],
          items: [
            { id: 20, label: "New", listId: 6 },
            { id: 30, label: "SiblingItem", listId: 2 },
          ],
        },
      },
      undefined
    );
  });

  // MULTI-PARENT WITNESS (reject side): an occupied TARGET rejects even when a sibling is
  // also occupied — the guard finds the target's own child, and the sibling stays put.
  test("rejects an occupied target UPDATE while an occupied sibling is untouched", async () => {
    await expectParity(
      {
        seed: async (client) => {
          await client.setNullList.create({ data: { id: 1, name: "Target" } });
          await client.setNullItem.create({
            data: { id: 10, label: "TargetItem", listId: 1 },
          });
          await client.setNullList.create({ data: { id: 2, name: "Sibling" } });
          await client.setNullItem.create({
            data: { id: 30, label: "SiblingItem", listId: 2 },
          });
        },
        act: (client) =>
          client.setNullList.update({
            where: { id: 1 },
            data: {
              id: { increment: 5 },
              items: { update: { where: { id: 10 }, data: { label: "X" } } },
            },
          }),
        snapshot: setNullToManyState,
        expectedState: {
          lists: [
            { id: 1, name: "Target" },
            { id: 2, name: "Sibling" },
          ],
          items: [
            { id: 10, label: "TargetItem", listId: 1 },
            { id: 30, label: "SiblingItem", listId: 2 },
          ],
        },
      },
      SET_NULL_OCCUPIED_ERROR
    );
  });
});
