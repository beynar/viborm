import {
  depots,
  useParentHeldSeed,
} from "@tests/contracts/engine/write/vacate-then-supply-parent-held-fixtures";
import { describe, expect, test } from "vitest";

/**
 * The two parent-held compositions that do NOT execute, kept beside each other because
 * each is refused by a DIFFERENT owner: the own-write ledger answers the `delete` +
 * `connect` pair, and the lattice answers `create` + `update` before the compiler ever
 * sees it. The compositions this direction does compose are in
 * `vacate-then-supply-parent-held-composed.test.ts`, which also carries the R2 elision
 * account these two are the boundary of.
 *
 * The `d-alt` decoy is live and unconnected throughout, so a composition that vacated or
 * supplied the wrong row would be visible in every assertion below.
 */

/** One schema on the worker's PGlite for this file, re-seeded before every case. */
const seedParentHeld = useParentHeldSeed();

describe("Package H — the parent-held direction composes the replacement", () => {
  test("delete + connect is the own-write ledger's refusal, and writes nothing", async () => {
    const client = await seedParentHeld();
    // The lattice admits this pair on this direction. `delete: true` names the CURRENT
    // member, whose identity is unknown at construction, so the analyzer cannot rule out
    // that it is the very row the `connect` reads — and if it were, the root would end
    // pointing at a deleted depot. Recorded here rather than in the lattice, because the
    // lattice is not who refuses it.
    await expect(
      client.station.update({
        where: { id: "s1" },
        data: { depot: { delete: true, connect: { id: "d-alt" } } },
      })
    ).rejects.toThrow(
      "Nested operation 'connect' on relation 'depot' depends on an earlier 'delete' target write in the same nested write. Split these operations into separate queries."
    );
    expect(
      await client.station.findUnique({ where: { id: "s1" } })
    ).toMatchObject({ depotId: "d1" });
    expect(await depots(client)).toEqual([
      ["d-alt", "decoy"],
      ["d1", "incumbent"],
    ]);
  }, 30_000);

  test("create + update stays refused on this direction — by the LATTICE", async () => {
    const client = await seedParentHeld();
    // Not the engine's composition site: the parent-held half of the lattice admits
    // `connect` + `update` only, so this never reaches the compiler at all.
    await expect(
      client.station.update({
        where: { id: "s1" },
        data: {
          depot: {
            create: { id: "d-new", note: "fresh" },
            update: { note: "n" },
          },
        },
      })
    ).rejects.toThrow(
      "Unsupported to-one operation combination: create, update"
    );
    expect(await depots(client)).toEqual([
      ["d-alt", "decoy"],
      ["d1", "incumbent"],
    ]);
  }, 30_000);
});
