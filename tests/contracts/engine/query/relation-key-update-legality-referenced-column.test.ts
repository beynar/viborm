import {
  CODE_RELATION_KEY_ERROR,
  expectParity,
} from "@tests/contracts/engine/query/relation-key-update-legality-fixtures";
import { describe, test } from "vitest";

// The REFERENCED-COLUMN slice: the rewritten key is a non-PK column the PARENT is
// referenced by — `organization.code` on the cascading pair, `registry.tag` on the
// non-cascading one. The two are read together because they are the same axis with the
// referential action flipped, and the registry pair exists precisely to reach the
// derivation the cascading pair never asks for. One live and one forced-batch database
// per scenario; the schema and the parity oracle live in
// `relation-key-update-legality-fixtures.ts`.

describe("relation-key update legality", () => {
  test("rejects non-PK referenced arithmetic before effects", async () => {
    await expectParity(
      {
        seed: async (client) => {
          await client.organization.create({ data: { id: 1, code: 10 } });
          await client.member.create({
            data: { id: 1, name: "Member", organizationCode: 10 },
          });
        },
        act: (client) =>
          client.organization.update({
            where: { id: 1 },
            data: {
              code: { increment: 1 },
              members: {
                update: { where: { id: 1 }, data: { name: "changed" } },
              },
            },
          }),
        snapshot: async (client) => ({
          organizations: await client.organization.findMany(),
          members: await client.member.findMany(),
        }),
        expectedState: {
          organizations: [{ id: 1, code: 10 }],
          members: [{ id: 1, name: "Member", organizationCode: 10 }],
        },
      },
      CODE_RELATION_KEY_ERROR
    );
  });

  test("allows literal non-PK referenced transition with cascade", async () => {
    await expectParity(
      {
        seed: async (client) => {
          await client.organization.create({ data: { id: 1, code: 10 } });
          await client.member.create({
            data: { id: 1, name: "Member", organizationCode: 10 },
          });
        },
        act: (client) =>
          client.organization.update({
            where: { id: 1 },
            data: {
              code: { set: 11 },
              members: {
                update: { where: { id: 1 }, data: { name: "Updated" } },
              },
            },
          }),
        snapshot: async (client) => ({
          organizations: await client.organization.findMany(),
          members: await client.member.findMany(),
        }),
        expectedState: {
          organizations: [{ id: 1, code: 11 }],
          members: [{ id: 1, name: "Updated", organizationCode: 11 }],
        },
      },
      undefined
    );
  });

  test("the `{ set: v }` envelope on a rewritten NON-cascading referenced column feeds a nested CREATE the post-SET value", async () => {
    // N7-U-B's third absorption (UpdateOperation.resolveCreateParent): the envelope
    // spelling and the bare literal are ONE assignment. The edge must NOT cascade —
    // a cascading edge never consults this derivation (N5-U2) — which is why this
    // witness lives on registry/entry, not organization/member. Falsified:
    // reverting the envelope unwrapping to a bare
    // `input.rootScalarData[referencedField]` read fails this test while the
    // bare-literal sibling below still passes. Residual G moved the unwrapping
    // (and the verdict on what it produces) into
    // `RecordUpdateCompiler.requireRewrittenReferenceValue`, so that is where the
    // falsification now goes: without it, `{ set: 11 }` is not a construction
    // literal and lands in the unrepresentable state.
    await expectParity(
      {
        seed: async (client) => {
          await client.registry.create({ data: { id: 1, tag: 10 } });
        },
        act: (client) =>
          client.registry.update({
            where: { id: 1 },
            data: {
              tag: { set: 11 },
              entries: { create: { id: 2, name: "Fresh" } },
            },
          }),
        snapshot: async (client) => ({
          registries: await client.registry.findMany(),
          entries: await client.entry.findMany(),
        }),
        expectedState: {
          registries: [{ id: 1, tag: 11 }],
          entries: [{ id: 2, name: "Fresh", registryTag: 11 }],
        },
      },
      undefined
    );
  });

  test("the bare literal on a rewritten NON-cascading referenced column feeds a nested CREATE the same value", async () => {
    // The control beside the envelope witness: the two spellings must stay one
    // assignment. If the envelope test fails and this one passes, the envelope
    // unwrapping is what broke.
    await expectParity(
      {
        seed: async (client) => {
          await client.registry.create({ data: { id: 1, tag: 10 } });
        },
        act: (client) =>
          client.registry.update({
            where: { id: 1 },
            data: {
              tag: 12,
              entries: { create: { id: 3, name: "Bare" } },
            },
          }),
        snapshot: async (client) => ({
          registries: await client.registry.findMany(),
          entries: await client.entry.findMany(),
        }),
        expectedState: {
          registries: [{ id: 1, tag: 12 }],
          entries: [{ id: 3, name: "Bare", registryTag: 12 }],
        },
      },
      undefined
    );
  });
});
