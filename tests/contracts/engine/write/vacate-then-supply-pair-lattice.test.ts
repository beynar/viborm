import { createClient } from "@client/client";
import { PGliteDriver } from "@drivers/pglite";
import {
  resetVacateThenSupply,
  vacateThenSupplySchema,
} from "@tests/contracts/engine/write/vacate-then-supply-behavior";
import { openTestPGlite as openBorrowedPGlite } from "@tests/fixtures/pglite-lifecycle";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import { describe, expect, test } from "vitest";

/**
 * The CHILD-HELD lattice, enumerated. Three witnesses, three fresh databases: the two
 * enumerations each sweep a whole payload space against one committed bed, and the
 * composed-modify probe needs its own bed because its assertion is what did NOT get
 * written. The per-substrate registration bed lives in
 * `vacate-then-supply-substrates.test.ts`; the parent-held direction lives in the two
 * `vacate-then-supply-parent-held-*` files.
 */
/** All 21 unordered pairs pin the public child-held to-one update lattice. */
const PAIR_ARMS: Record<string, unknown> = {
  disconnect: true,
  delete: true,
  update: { tag: "u" },
  upsert: { update: { tag: "u" }, create: { id: "b-up", tag: "up" } },
  connectOrCreate: {
    where: { id: "b-alt" },
    create: { id: "b-alt", tag: "n" },
  },
  connect: { id: "b-alt" },
  create: { id: "b-new", tag: "fresh" },
};

/**
 * Which OWNER answered the exact pair. Package H split the old two-way verdict: a shape
 * the lattice admits can now be refused downstream, and saying only "not
 * VALIDATION-GUARD" would hide which of three owners spoke. `UNCLASSIFIED` keeps its
 * meaning — nobody named below — so a new owner cannot slip in unremarked.
 */
function disposition(error: unknown): string {
  if (error === undefined) return "EXECUTED";
  const message = (error as Error).message;
  if (message.includes("Unsupported to-one operation combination")) {
    return "VALIDATION-GUARD";
  }
  if (message.includes("requires ordered series execution")) {
    return "SUBSTRATE-GUARD";
  }
  if (message.includes("Unique constraint")) return "DATABASE-UNIQUE";
  if (message.includes("Split these operations into separate queries")) {
    return "OWN-WRITE-LEDGER";
  }
  return `UNCLASSIFIED: ${message}`;
}

describe("E6.5 the enumeration of every update-root to-one pair", () => {
  test("all 21 pairs and the empty payload land where this unit says they do", async () => {
    const client = createClient({
      schema: vacateThenSupplySchema,
      driver: new PGliteDriver({ client: openBorrowedPGlite() }),
    }) as any;
    await syncLiveSchema(client);

    const names = Object.keys(PAIR_ARMS);
    const verdicts: Record<string, string> = {};
    for (let i = 0; i < names.length; i++) {
      for (let j = i + 1; j < names.length; j++) {
        const [a, b] = [names[i]!, names[j]!];
        await resetVacateThenSupply(client);
        const error = await client.station
          .update({
            where: { id: "s1" },
            data: { badge: { [a]: PAIR_ARMS[a], [b]: PAIR_ARMS[b] } },
          })
          .then(() => undefined)
          .catch((caught: unknown) => caught);
        verdicts[`${a}+${b}`] = disposition(error);
      }
    }
    await resetVacateThenSupply(client);
    const emptyError = await client.station
      .update({ where: { id: "s1" }, data: { badge: {} } })
      .then(() => undefined)
      .catch((caught: unknown) => caught);

    expect(verdicts).toEqual({
      // The five executable replacements: one vacate, then one supplier.
      "disconnect+connectOrCreate": "EXECUTED",
      "disconnect+connect": "EXECUTED",
      "disconnect+create": "EXECUTED",
      "delete+connect": "EXECUTED",
      "delete+create": "EXECUTED",
      "delete+connectOrCreate": "VALIDATION-GUARD",
      "disconnect+update": "VALIDATION-GUARD",
      "disconnect+upsert": "VALIDATION-GUARD",
      "delete+update": "VALIDATION-GUARD",
      "delete+upsert": "VALIDATION-GUARD",
      "upsert+connectOrCreate": "VALIDATION-GUARD",
      "disconnect+delete": "VALIDATION-GUARD",
      "update+upsert": "VALIDATION-GUARD",
      // PACKAGE E — the lattice admits all three supplier + modify pairs and the engine
      // now composes ALL THREE. `connect` hands its modify a unique selector that exists
      // before the fragment's first write; `create` and `connectOrCreate` hand it
      // membership instead, and the modify becomes a record-series continuation whose
      // capture runs AFTER the supplier writes. So none of the three has an opinion
      // about occupancy any more, and all three land on the same owner here: the slot
      // is OCCUPIED in this fixture and nothing in a PAIR vacates it, so the child's
      // unique foreign key answers — exactly as it does for a lone `connect`. The
      // triples below, which do vacate, execute.
      "update+connectOrCreate": "DATABASE-UNIQUE",
      "update+connect": "DATABASE-UNIQUE",
      "update+create": "DATABASE-UNIQUE",
      "upsert+connect": "VALIDATION-GUARD",
      "upsert+create": "VALIDATION-GUARD",
      "connectOrCreate+connect": "VALIDATION-GUARD",
      "connectOrCreate+create": "VALIDATION-GUARD",
      "connect+create": "VALIDATION-GUARD",
    });
    expect(disposition(emptyError)).toBe("EXECUTED");
    await client.$disconnect();
  }, 120_000);

  /**
   * PACKAGE H — the three-kind shapes, which the pair enumeration by construction cannot
   * see. The lattice admits `(vacate, supplier, modify)`; this is where each of the six
   * lands and who answers it, so a later reader does not have to infer the triples from
   * the pairs.
   */
  test("the six vacate + supplier + modify triples land where H3 says they do", async () => {
    const client = createClient({
      schema: vacateThenSupplySchema,
      driver: new PGliteDriver({ client: openBorrowedPGlite() }),
    }) as any;
    await syncLiveSchema(client);

    const verdicts: Record<string, string> = {};
    for (const vacate of ["disconnect", "delete"]) {
      for (const supplier of ["connect", "connectOrCreate", "create"]) {
        await resetVacateThenSupply(client);
        const error = await client.station
          .update({
            where: { id: "s1" },
            data: {
              badge: {
                [vacate]: PAIR_ARMS[vacate],
                [supplier]: PAIR_ARMS[supplier],
                update: { tag: "u" },
              },
            },
          })
          .then(() => undefined)
          .catch((caught: unknown) => caught);
        verdicts[`${vacate}+${supplier}+update`] = disposition(error);
      }
    }

    expect(verdicts).toEqual({
      // The triple whose modify is located by the supplier's own unique selector — an
      // identity that exists before the fragment's first write — beside a `disconnect`
      // that writes membership rather than the target's existence.
      "disconnect+connect+update": "EXECUTED",
      // PACKAGE E — a PRODUCING supplier's modify no longer reads membership at
      // planning: it is a record-series capture that runs after the supplier writes, so
      // the analyzer has no premise for the sibling vacate to invalidate and both
      // triples execute. The `delete` variant executes for the same reason, and its
      // ordering (delete, create, capture, update) is what makes it correct.
      "disconnect+connectOrCreate+update": "EXECUTED",
      "disconnect+create+update": "EXECUTED",
      "delete+create+update": "EXECUTED",
      // UNCHANGED, and the reason E did not widen it: `delete` writes the TARGET's
      // existence with an unknown identity, and a `connect` modify still declares a
      // construction-time target read, so the analyzer still cannot rule out that the
      // deleted row is the one the modify reads.
      "delete+connect+update": "OWN-WRITE-LEDGER",
      // `delete` + `connectOrCreate` is the deliberate sixth-that-isn't, refused by the
      // lattice whether or not a modify rides along.
      "delete+connectOrCreate+update": "VALIDATION-GUARD",
    });
    await client.$disconnect();
  }, 120_000);
});

describe("Package H — the composed modify declares every field its probe reads", () => {
  test("a sibling write to the wrapper filter's field is a dependency, not a blind spot", async () => {
    const client = createClient({
      schema: vacateThenSupplySchema,
      driver: new PGliteDriver({ client: openBorrowedPGlite() }),
    }) as any;
    await syncLiveSchema(client);
    await resetVacateThenSupply(client);

    // The composed modify locates by the SUPPLIER's selector — but the wrapper's `where`
    // does not disappear when it does: `correlatedProbeStatement` splices the filter's
    // conjuncts beside the selector's, in the probe AND in the batch guard. So this read
    // predicates on `tag` as well as on `id`, and a write to `tag` earlier in the same
    // nested write is a real dependency. Declaring the selector alone would have made
    // this payload compile with the probe silently reading a value the root had already
    // moved — an under-report the analyzer cannot see and no other owner covers.
    await expect(
      client.badge.update({
        where: { id: "b1" },
        data: {
          tag: "root-writes-tag",
          station: {
            update: {
              badge: {
                connect: { id: "b-alt" },
                update: { where: { tag: "alt" }, data: { tag: "moved" } },
              },
            },
          },
        },
      })
    ).rejects.toThrow(
      "Nested operation 'update' on relation 'badge' depends on an earlier 'update' target write in the same nested write. Split these operations into separate queries."
    );

    // Nothing landed: the same payload with no filter on the written field is the
    // control, and it is the only difference between the two.
    expect(
      (await client.badge.findMany({})).map((row: any) => [row.id, row.tag])
    ).toEqual([
      ["b1", "incumbent"],
      ["b-alt", "alt"],
    ]);
    await client.$disconnect();
  }, 30_000);
});
