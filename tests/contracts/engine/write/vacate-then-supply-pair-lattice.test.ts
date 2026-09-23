import {
  resetVacateThenSupply,
  vacateThenSupplySchema,
} from "@tests/contracts/engine/write/vacate-then-supply-behavior";
import { usePGliteSchemaFamily } from "@tests/fixtures/drivers/pglite";
import { describe, expect, test } from "vitest";

/**
 * The CHILD-HELD lattice, enumerated. Three witnesses, three emptied beds: the two
 * enumerations each sweep a whole payload space against one committed bed, and the
 * composed-modify probe needs its own bed because its assertion is what did NOT get
 * written. The per-substrate registration bed lives in
 * `vacate-then-supply-substrates.test.ts`; the parent-held direction lives in the two
 * `vacate-then-supply-parent-held-*` files.
 */
const getFamily = usePGliteSchemaFamily(vacateThenSupplySchema);

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
 *
 * N1 (D-51) left `OWN-WRITE-LEDGER` with no shape in this file: the dependency sentence
 * survives only where the ancestor's own write CONSUMES the read (the parent-held
 * direction, `vacate-then-supply-parent-held-refused.test.ts`). The branch stays because
 * it is the falsifier — a regression that restores the veto reads as the ledger here,
 * not as `UNCLASSIFIED`.
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
    const client = getFamily().client as any;

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
  }, 120_000);

  /**
   * PACKAGE H — the three-kind shapes, which the pair enumeration by construction cannot
   * see. The lattice admits `(vacate, supplier, modify)`; this is where each of the six
   * lands and who answers it, so a later reader does not have to infer the triples from
   * the pairs.
   */
  test("the six vacate + supplier + modify triples land where H3 says they do", async () => {
    const client = getFamily().client as any;

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
      // N1 (D-51): pinned DESIGN §6.2's veto ("Nested operation 'update' on relation
      // 'badge' depends on an earlier 'delete' target write in the same nested write.
      // Split these operations into separate queries") — `delete` writes the TARGET's
      // existence with an unknown identity, and a `connect` modify declares a
      // construction-time target read, so the analyzer could not rule out that the
      // deleted row was the one the modify reads. It no longer has to: that read is an
      // ordered observation taken at its consumer's execution point, behind both
      // writes, and the canonical to-one order (`delete, connect, update`) is what makes
      // it correct. The incumbent goes, `b-alt` takes the slot the delete vacated, and
      // the modify hits `b-alt`. `disconnect` in this position already executed — the
      // difference between the two was never the end state, only whether the analyzer
      // could name the row in advance. The end state is pinned below, because a verdict
      // map records who answered and never what was written.
      "delete+connect+update": "EXECUTED",
      // `delete` + `connectOrCreate` is the deliberate sixth-that-isn't, refused by the
      // lattice whether or not a modify rides along.
      "delete+connectOrCreate+update": "VALIDATION-GUARD",
    });

    // N1 (D-51) — the path the removed refusal opened, witnessed. `delete+connect+update`
    // wrote nothing in this file until D-51, so no cell here has ever said what it does.
    // Re-run it against a fresh bed and pin the end state whole: the incumbent is GONE
    // (the vacate is a `delete`, not a `disconnect`), the decoy holds the slot, and it
    // carries the modify's tag rather than its own. A regression that let the modify
    // correlate on the OUTGOING member would find no row at all here.
    await resetVacateThenSupply(client);
    await client.station.update({
      where: { id: "s1" },
      data: {
        badge: {
          delete: true,
          connect: { id: "b-alt" },
          update: { tag: "u" },
        },
      },
    });
    expect(
      (await client.badge.findMany({}))
        .map((row: any) => [row.id, row.tag, row.stationId])
        .sort((left: unknown[], right: unknown[]) =>
          String(left[0]) < String(right[0]) ? -1 : 1
        )
    ).toEqual([["b-alt", "u", "s1"]]);
  }, 120_000);
});

describe("Package H — the composed modify declares every field its probe reads", () => {
  test("a sibling write to the wrapper filter's field no longer vetoes — the unvacated slot is the database's", async () => {
    const client = getFamily().client as any;
    await resetVacateThenSupply(client);

    // The composed modify locates by the SUPPLIER's selector — but the wrapper's `where`
    // does not disappear when it does: `correlatedProbeStatement` splices the filter's
    // conjuncts beside the selector's, in the probe AND in the batch guard. So this read
    // predicates on `tag` as well as on `id`, and a write to `tag` earlier in the same
    // nested write is a real dependency. Declaring the selector alone would have made
    // this payload compile with the probe silently reading a value the root had already
    // moved — an under-report the analyzer cannot see and no other owner covers.
    //
    // N1 (D-51): this cell pinned DESIGN §6.2's veto for exactly that dependency
    // ("Nested operation 'update' on relation 'badge' depends on an earlier 'update'
    // target write in the same nested write. Split these operations into separate
    // queries."). A dependent read is an ordered observation now, so declaring `tag`
    // buys a PLACEMENT — the parent-held `station` subtree, whose probe reads what the
    // root's own write changes, moves behind that write — instead of a refusal, and the
    // payload executes. What it executes into is the slot: nothing in it vacates the
    // incumbent, and an inverse to-one `connect` over an occupied unique slot does not
    // vacate one (note §2, "not repaired, recorded"), so `b1` and `b-alt` both claim
    // `stationId = 's1'` and the child's unique key answers. The declaration is pinned
    // upstream now (`tests/raptor3/g4/parity/ordered-observation.test.ts`); what this
    // cell still owns is whose refusal this is and how total it is.
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
    ).rejects.toThrow("Unique constraint violation");

    // Nothing landed — and that is now a ROLLBACK rather than a veto taken before any
    // statement ran, so the memberships are pinned beside the rows: the root's `tag`
    // write on `b1` and the sibling `connect` on `b-alt` are both undone, and the
    // incumbent still holds the slot the `connect` collided with.
    expect(
      (await client.badge.findMany({})).map((row: any) => [
        row.id,
        row.tag,
        row.stationId,
      ])
    ).toEqual([
      ["b1", "incumbent", "s1"],
      ["b-alt", "alt", null],
    ]);
  }, 30_000);
});
