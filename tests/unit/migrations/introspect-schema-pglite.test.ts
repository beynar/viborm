/**
 * `introspectSchema` on PostgreSQL, through PGlite: the round trip to an empty
 * push plan, the skipped report, and a database VibORM pushed itself.
 */

import { PGliteDriver } from "@drivers/pglite";
import { openTestPGlite } from "@tests/fixtures/pglite-lifecycle";
import { postgresIntrospectionSuite } from "./_introspect-postgres-suite";

postgresIntrospectionSuite({
  async fresh() {
    return new PGliteDriver({ client: openTestPGlite() });
  },
});
