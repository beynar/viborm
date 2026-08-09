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

/** Whether the schema accepted the exact pair and the engine executed it. */
function disposition(error: unknown): string {
  if (error === undefined) return "EXECUTED";
  const message = (error as Error).message;
  if (message.includes("Unsupported to-one operation combination")) {
    return "VALIDATION-GUARD";
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
      "update+connectOrCreate": "VALIDATION-GUARD",
      "update+connect": "VALIDATION-GUARD",
      "update+create": "VALIDATION-GUARD",
      "upsert+connect": "VALIDATION-GUARD",
      "upsert+create": "VALIDATION-GUARD",
      "connectOrCreate+connect": "VALIDATION-GUARD",
      "connectOrCreate+create": "VALIDATION-GUARD",
      "connect+create": "VALIDATION-GUARD",
    });
    expect(disposition(emptyError)).toBe("EXECUTED");
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
      "Unsupported to-one operation combination: create, delete"
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
