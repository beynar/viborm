/**
 * PGlite + PostGIS — the documented construction, on a database the driver
 * makes itself.
 *
 * The extension is PGlite's own `extensions` option, passed through `options`;
 * `postgis: true` tells the adapter the GeoPoint protocol is there; and the
 * caller runs `CREATE EXTENSION`, because VibORM never installs PostGIS. This
 * is its own file because a PostGIS database is a whole Wasm PostgreSQL: the
 * contract suite in `pglite-postgis.test.ts` already holds one, and a second
 * one alive beside it breaches the isolated-provider RSS ceiling.
 */

import { createClient } from "@drivers/pglite";
import { postgis } from "@electric-sql/pglite-postgis";
import { s } from "@schema";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";

const PARIS = { longitude: 2.3522, latitude: 48.8566 } as const;
const LONDON = { longitude: -0.1276, latitude: 51.5072 } as const;

const landmark = s
  .model({ id: s.string().id(), location: s.point() })
  .map("pglite_postgis_landmarks");

describe("PGlite + PostGIS driver-owned database", () => {
  test("loads the extension through PGlite options and answers a distance filter", async () => {
    const client = createClient({
      schema: { landmark },
      options: { extensions: { postgis } },
      postgis: true,
    });
    try {
      await client.$executeRawUnsafe("CREATE EXTENSION IF NOT EXISTS postgis");
      await syncLiveSchema(client);
      await client.landmark.createMany({
        data: [
          { id: "paris", location: PARIS },
          { id: "london", location: LONDON },
        ],
      });
      await expect(
        client.landmark.findMany({
          where: { location: { distance: { to: PARIS, lte: 100_000 } } },
          select: { id: true, location: true },
        })
      ).resolves.toEqual([{ id: "paris", location: PARIS }]);
    } finally {
      await client.$disconnect();
    }
  });
});
