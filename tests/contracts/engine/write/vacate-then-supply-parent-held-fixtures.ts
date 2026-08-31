import { createClient } from "@client/client";
import { PGliteDriver } from "@drivers/pglite";
import { s } from "@schema";
import { openTestPGlite as openBorrowedPGlite } from "@tests/fixtures/pglite-lifecycle";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";

/** Parent-held to-one updates do not support a replacement pair. */
export const parentHeldSchema = (() => {
  const depot = s
    .model({
      id: s.string().id(),
      note: s.string(),
      stations: s.toMany(() => station),
    })
    .map("e65p_depots");

  const station = s
    .model({
      id: s.string().id(),
      label: s.string(),
      depotId: s.string().nullable(),
      depot: s
        .toOne(() => depot)
        .fields("depotId")
        .references("id"),
    })
    .map("e65p_stations");

  return { depot, station };
})();

/**
 * One fresh database per call, seeded with the incumbent `d1`, the live and
 * unconnected `d-alt` decoy, and the station whose slot the payload under test
 * rewrites. Every parent-held witness needs its own committed starting state, so the
 * database is per-test rather than per-file.
 */
export const seedParentHeld = async () => {
  const client = createClient({
    schema: parentHeldSchema,
    driver: new PGliteDriver({ client: openBorrowedPGlite() }),
  }) as any;
  await syncLiveSchema(client);
  await client.depot.create({ data: { id: "d1", note: "incumbent" } });
  await client.depot.create({ data: { id: "d-alt", note: "decoy" } });
  await client.station.create({
    data: { id: "s1", label: "L", depotId: "d1" },
  });
  return client;
};

/** `[id, note]` for every depot, ordered by code unit rather than by the database. */
export const depots = async (client: any): Promise<unknown[][]> =>
  (await client.depot.findMany({}))
    .map((row: any) => [row.id, row.note])
    .sort((left: unknown[], right: unknown[]) =>
      String(left[0]) < String(right[0]) ? -1 : 1
    );
