import { createClient } from "@client/client";
import { PGliteDriver } from "@drivers/pglite";
import { PGlite } from "@electric-sql/pglite";
import { push } from "@migrations";
import { s } from "@schema";
import {
  registerVacateThenSupplyBehavior,
  resetVacateThenSupply,
  vacateThenSupplySchema,
} from "@tests/contracts/engine/write/vacate-then-supply-behavior";
import { BatchOnlyPGliteDriver } from "@tests/fixtures/drivers/pglite";
import { describe, expect, test } from "vitest";

const substrates = [
  {
    name: "transaction",
    make: (db: PGlite) => new PGliteDriver({ client: db }),
  },
  {
    name: "atomic batch",
    make: (db: PGlite) => new BatchOnlyPGliteDriver({ client: db }),
  },
] as const;

for (const substrate of substrates) {
  let shared: any;
  registerVacateThenSupplyBehavior(substrate.name, async () => {
    if (!shared) {
      shared = createClient({
        schema: vacateThenSupplySchema,
        driver: substrate.make(new PGlite()),
      }) as any;
      await push(shared, { force: true });
    }
    return shared;
  });
}

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
  if (message.includes("cannot compose")) return "ENGINE-GUARD";
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
      driver: new PGliteDriver({ client: new PGlite() }),
    }) as any;
    await push(client, { force: true });

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
      // PACKAGE H — the lattice admits all three supplier + modify pairs. Only `connect`
      // composes: the modify is located by the supplier's own unique selector, which is
      // an identity that exists before the fragment's first write. `create` and
      // `connectOrCreate` produce theirs by INSERTING the row, and a selected-record
      // compiler locates with a PLANNING read, which precedes every write.
      "update+connectOrCreate": "ENGINE-GUARD",
      // The slot is OCCUPIED in this fixture and nothing in the pair vacates it, so the
      // child's unique foreign key answers — exactly as it does for a lone `connect`.
      // The composition adds no occupancy opinion of its own; the triple below, which
      // does vacate, executes.
      "update+connect": "DATABASE-UNIQUE",
      "update+create": "ENGINE-GUARD",
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
      driver: new PGliteDriver({ client: new PGlite() }),
    }) as any;
    await push(client, { force: true });

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
      // The one triple this engine composes end to end: the supplier's unique selector
      // is an identity that exists before the fragment's first write, and a `disconnect`
      // writes membership rather than the target's existence.
      "disconnect+connect+update": "EXECUTED",
      // Without a `connect` there is no selector for the modify to be located by, so the
      // analyzer keeps its decision read on MEMBERSHIP — and the sibling vacate wrote
      // membership. It answers before the engine's own composition site does, which is
      // the right order (analysis precedes construction); the pair spellings in the map
      // above show that same engine site with no vacate in the way.
      "disconnect+connectOrCreate+update": "OWN-WRITE-LEDGER",
      "disconnect+create+update": "OWN-WRITE-LEDGER",
      // `delete` writes the TARGET's existence with an unknown identity, so the analyzer
      // cannot rule out that the deleted row is the one the modify reads — even when the
      // modify IS located by a selector.
      "delete+connect+update": "OWN-WRITE-LEDGER",
      // `delete` + `connectOrCreate` is the deliberate sixth-that-isn't, refused by the
      // lattice whether or not a modify rides along.
      "delete+connectOrCreate+update": "VALIDATION-GUARD",
      "delete+create+update": "OWN-WRITE-LEDGER",
    });
    await client.$disconnect();
  }, 120_000);
});

/** Parent-held to-one updates do not support a replacement pair. */
const parentHeldSchema = (() => {
  const depot = s
    .model({
      id: s.string().id(),
      note: s.string(),
      stations: s.oneToMany(() => station),
    })
    .map("e65p_depots");

  const station = s
    .model({
      id: s.string().id(),
      label: s.string(),
      depotId: s.string().nullable(),
      depot: s
        .manyToOne(() => depot)
        .fields("depotId")
        .references("id")
        .optional(),
    })
    .map("e65p_stations");

  return { depot, station };
})();

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
 */
describe("Package H — the composed modify declares every field its probe reads", () => {
  test("a sibling write to the wrapper filter's field is a dependency, not a blind spot", async () => {
    const client = createClient({
      schema: vacateThenSupplySchema,
      driver: new PGliteDriver({ client: new PGlite() }),
    }) as any;
    await push(client, { force: true });
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

describe("Package H — the parent-held direction composes the replacement", () => {
  const seed = async () => {
    const client = createClient({
      schema: parentHeldSchema,
      driver: new PGliteDriver({ client: new PGlite() }),
    }) as any;
    await push(client, { force: true });
    await client.depot.create({ data: { id: "d1", note: "incumbent" } });
    await client.depot.create({ data: { id: "d-alt", note: "decoy" } });
    await client.station.create({
      data: { id: "s1", label: "L", depotId: "d1" },
    });
    return client;
  };
  const depots = async (client: any): Promise<unknown[][]> =>
    (await client.depot.findMany({}))
      .map((row: any) => [row.id, row.note])
      .sort((left: unknown[], right: unknown[]) =>
        String(left[0]) < String(right[0]) ? -1 : 1
      );

  test("delete + create replaces: the newcomer holds the slot and is NOT orphaned", async () => {
    const client = await seed();
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
    const client = await seed();
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
    const client = await seed();
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
      const client = await seed();
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
    const client = await seed();
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

  test("delete + connect is the own-write ledger's refusal, and writes nothing", async () => {
    const client = await seed();
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
    await client.$disconnect();
  }, 30_000);

  test("create + update stays refused on this direction — by the LATTICE", async () => {
    const client = await seed();
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
    await client.$disconnect();
  }, 30_000);
});
