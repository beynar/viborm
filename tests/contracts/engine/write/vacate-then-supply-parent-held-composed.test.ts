import {
  depots,
  seedParentHeld,
} from "@tests/contracts/engine/write/vacate-then-supply-parent-held-fixtures";
import { describe, expect, test } from "vitest";

/**
 * PACKAGE H RETARGET. This block used to say the parent-held direction keeps the
 * replacement pair refused; E6.5 declined to absorb it because the FK-null of a `delete`
 * lands in the post-root write bucket, AFTER the supplier's rebind is folded into the
 * root SET — measured at 8c2908d as inserting the fresh depot and then ORPHANING it.
 * R2's elision is that ordering change: when a sibling supplier rebinds the edge's
 * columns, the vacate contributes no assignment and the FK-null UPDATE is not emitted at
 * all, while the correlated DELETE still addresses the OLD value from the located row.
 *
 * The `d-alt` decoy is live and unconnected throughout, so a composition that vacated or
 * supplied the wrong row would be visible in every assertion below.
 *
 * This file holds the compositions that EXECUTE. The two the parent-held direction
 * declines — one by the own-write ledger, one by the lattice — are in
 * `vacate-then-supply-parent-held-refused.test.ts`. Every witness here seeds its own
 * database, so the split costs no extra one.
 */
describe("Package H — the parent-held direction composes the replacement", () => {
  test("delete + create replaces: the newcomer holds the slot and is NOT orphaned", async () => {
    const client = await seedParentHeld();
    await client.station.update({
      where: { id: "s1" },
      data: { depot: { delete: true, create: { id: "d-new", note: "fresh" } } },
    });
    // The whole point of the elision: `depotId` is the newcomer, not NULL.
    expect(
      await client.station.findUnique({ where: { id: "s1" } })
    ).toMatchObject({ depotId: "d-new" });
    expect(await depots(client)).toEqual([
      ["d-alt", "decoy"],
      ["d-new", "fresh"],
    ]);
    await client.$disconnect();
  }, 30_000);

  test("disconnect + connect is ONE root assignment, and the incumbent survives", async () => {
    const client = await seedParentHeld();
    await client.station.update({
      where: { id: "s1" },
      data: { depot: { disconnect: true, connect: { id: "d-alt" } } },
    });
    expect(
      await client.station.findUnique({ where: { id: "s1" } })
    ).toMatchObject({ depotId: "d-alt" });
    expect(await depots(client)).toEqual([
      ["d-alt", "decoy"],
      ["d1", "incumbent"],
    ]);
    await client.$disconnect();
  }, 30_000);

  test("disconnect + create mints the newcomer and leaves the incumbent connected to nothing", async () => {
    const client = await seedParentHeld();
    await client.station.update({
      where: { id: "s1" },
      data: {
        depot: { disconnect: true, create: { id: "d-new", note: "fresh" } },
      },
    });
    expect(
      await client.station.findUnique({ where: { id: "s1" } })
    ).toMatchObject({ depotId: "d-new" });
    // `disconnect` on this direction only nulls the parent's column, and the supplier
    // replaced that assignment, so the incumbent row is untouched — the same fate the
    // `disconnect + connect` row above pins, reached through the other supplier.
    expect(await depots(client)).toEqual([
      ["d-alt", "decoy"],
      ["d-new", "fresh"],
      ["d1", "incumbent"],
    ]);
    await client.$disconnect();
  }, 30_000);

  test.each([
    [
      "found arm",
      "d-alt",
      { id: "d-alt", note: "never-minted" },
      [
        ["d-alt", "decoy"],
        ["d1", "incumbent"],
      ],
    ],
    [
      "missing arm",
      "d-new",
      { id: "d-new", note: "minted" },
      [
        ["d-alt", "decoy"],
        ["d-new", "minted"],
        ["d1", "incumbent"],
      ],
    ],
  ])(
    "disconnect + connectOrCreate takes the slot on its %s",
    async (_label, whereId, create, expected) => {
      const client = await seedParentHeld();
      // `connectOrCreate` is the one supplier with two arms, so "does the elided vacate
      // really contribute nothing?" has two answers and both are pinned: the found arm
      // rebinds to a row that already exists, the missing arm to one this statement
      // inserts. Either way the parent's column ends holding the supplier's value and
      // never a transient NULL.
      await client.station.update({
        where: { id: "s1" },
        data: {
          depot: {
            disconnect: true,
            connectOrCreate: { where: { id: whereId }, create },
          },
        },
      });
      expect(
        await client.station.findUnique({ where: { id: "s1" } })
      ).toMatchObject({ depotId: whereId });
      expect(await depots(client)).toEqual(expected);
      await client.$disconnect();
    },
    30_000
  );

  test("connect + update modifies the INCOMING member, not the outgoing one", async () => {
    const client = await seedParentHeld();
    await client.station.update({
      where: { id: "s1" },
      data: { depot: { connect: { id: "d-alt" }, update: { note: "moved" } } },
    });
    expect(
      await client.station.findUnique({ where: { id: "s1" } })
    ).toMatchObject({ depotId: "d-alt" });
    // `d1` keeps its note. A modify still correlated on the parent's foreign key would
    // have rewritten it: at probe time that column still holds `d1`.
    expect(await depots(client)).toEqual([
      ["d-alt", "moved"],
      ["d1", "incumbent"],
    ]);
    await client.$disconnect();
  }, 30_000);
});
