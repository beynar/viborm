import { BatchOnlyPGliteDriver } from "@tests/fixtures/drivers/pglite";
import { createClient } from "@client/client";
import type { BatchQuery, QueryResult } from "@drivers";
import { PGliteDriver } from "@drivers/pglite";
import { PGlite, type Transaction } from "@electric-sql/pglite";
import { push } from "@migrations";
import { s } from "@schema";
import { describe, expect, test } from "vitest";
import {
  registerVacateThenSupplyBehavior,
  resetVacateThenSupply,
  vacateThenSupplySchema,
} from "@tests/contracts/engine/write/vacate-then-supply-behavior";

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

/**
 * THE ENUMERATION, as a pin rather than a claim in a comment.
 *
 * The old argument called every two-kind to-one payload a contradiction without ever
 * listing them, so it never had to say which guard actually fired for which pair — and
 * two of its cases (the mutator-involving pairs and the empty payload) it did not
 * classify at all. This walks all 21 unordered pairs the update-root to-one parse factory
 * delivers plus `{}`, and pins each one's DISPOSITION.
 *
 * Measured at 8c2908d (before the absorption): 15 DISPATCH-GUARD, 6 OWN-WRITE-WALK,
 * 0 EXECUTED. After it: 10 / 6 / 5 — the five absorbed pairs moved across, and NOTHING
 * moved between the two refusal classes. That last part is the reason this test exists:
 * the own-write legality walk is a different guard with a different reason, and an
 * absorption that quietly took payloads away from it would be changing a contract this
 * unit never measured.
 */
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

/** Which guard (if any) the payload met — never the message text, so this pin does not
 *  duplicate the message assertions the behavior suite already owns. */
function disposition(error: unknown): string {
  if (error === undefined) return "EXECUTED";
  const message = (error as Error).message;
  if (message.includes("supports one mutation kind")) return "DISPATCH-GUARD";
  if (message.includes("Split these operations")) return "OWN-WRITE-WALK";
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
      // The five this unit absorbs: a vacate, then a supplier.
      "disconnect+connectOrCreate": "EXECUTED",
      "disconnect+connect": "EXECUTED",
      "disconnect+create": "EXECUTED",
      "delete+connect": "EXECUTED",
      "delete+create": "EXECUTED",
      // The sixth vacate+supply pair never reaches the dispatch: `connectOrCreate`
      // READS the row `delete` removes, and the own-write walk says so first.
      "delete+connectOrCreate": "OWN-WRITE-WALK",
      // Every other pair involving a mutator meets one guard or the other, unchanged.
      "disconnect+update": "OWN-WRITE-WALK",
      "disconnect+upsert": "OWN-WRITE-WALK",
      "delete+update": "OWN-WRITE-WALK",
      "delete+upsert": "OWN-WRITE-WALK",
      "upsert+connectOrCreate": "OWN-WRITE-WALK",
      "disconnect+delete": "DISPATCH-GUARD",
      "update+upsert": "DISPATCH-GUARD",
      "update+connectOrCreate": "DISPATCH-GUARD",
      "update+connect": "DISPATCH-GUARD",
      "update+create": "DISPATCH-GUARD",
      "upsert+connect": "DISPATCH-GUARD",
      "upsert+create": "DISPATCH-GUARD",
      "connectOrCreate+connect": "DISPATCH-GUARD",
      "connectOrCreate+create": "DISPATCH-GUARD",
      // Two SUPPLIERS: the contradiction the old argument was right about.
      "connect+create": "DISPATCH-GUARD",
    });
    expect(disposition(emptyError)).toBe("EXECUTED");
    await client.$disconnect();
  }, 120_000);
});

/**
 * The PARENT-HELD twin of the same payload. It stays refused, and the reason is this
 * direction's write shape rather than the payload's meaning: `delete` NULLs the
 * parent's own foreign key in a post-root write, which lands AFTER the supplier's
 * rebind has been folded into the root SET. Lifting the guard here was measured to
 * insert the fresh row and then ORPHAN it.
 */
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

describe("E6.5 the parent-held direction keeps the pair refused", () => {
  test("delete + create still refuses, and writes nothing", async () => {
    const db = new PGlite();
    const client = createClient({
      schema: parentHeldSchema,
      driver: new PGliteDriver({ client: db }),
    }) as any;
    await push(client, { force: true });
    await client.depot.create({ data: { id: "d1", note: "incumbent" } });
    await client.station.create({
      data: { id: "s1", label: "L", depotId: "d1" },
    });

    await expect(
      client.station.update({
        where: { id: "s1" },
        data: {
          depot: { delete: true, create: { id: "d-new", note: "fresh" } },
        },
      })
    ).rejects.toThrow(
      "query-engine-v2 update supports one mutation kind on the to-one relation 'depot'; it has delete, create."
    );

    // Construction-time: nothing ran.
    expect(
      await client.station.findUnique({ where: { id: "s1" } })
    ).toMatchObject({ depotId: "d1" });
    expect(
      (await client.depot.findMany({ orderBy: { id: "asc" } })).map(
        (row: any) => row.id
      )
    ).toEqual(["d1"]);
    await client.$disconnect();
  }, 30_000);
});
