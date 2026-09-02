import { s } from "@schema";
import { usePGliteSchemaFamily } from "@tests/fixtures/drivers/pglite";

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
 * A private SCHEMA on the worker's ONE PGlite, emptied before every test and then
 * seeded with the incumbent `d1`, the live and unconnected `d-alt` decoy, and the
 * station whose slot the payload under test rewrites.
 *
 * Every parent-held witness still gets its own committed starting state — that is
 * what the fixture's per-test reset gives it — without the database per witness this
 * used to open: nine live PGlite instances across the two suites that call it, each a
 * whole Postgres in Wasm, none of them released until the file ended.
 *
 * Call it at the TOP LEVEL of a suite: it registers the family's hooks on that file.
 */
export function useParentHeldSeed(): () => Promise<any> {
  const getFamily = usePGliteSchemaFamily(parentHeldSchema);
  return async () => {
    const client = getFamily().client as any;
    await client.depot.create({ data: { id: "d1", note: "incumbent" } });
    await client.depot.create({ data: { id: "d-alt", note: "decoy" } });
    await client.station.create({
      data: { id: "s1", label: "L", depotId: "d1" },
    });
    return client;
  };
}

/** `[id, note]` for every depot, ordered by code unit rather than by the database. */
export const depots = async (client: any): Promise<unknown[][]> =>
  (await client.depot.findMany({}))
    .map((row: any) => [row.id, row.note])
    .sort((left: unknown[], right: unknown[]) =>
      String(left[0]) < String(right[0]) ? -1 : 1
    );
