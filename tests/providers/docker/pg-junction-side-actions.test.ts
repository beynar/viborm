/**
 * pg Driver Tests — asymmetric junction referential actions (#46).
 *
 * The PostgreSQL server leg, pushed into its own schema so the no-op repush
 * diffs this suite's tables and nothing a neighbour left in `public`.
 */

import { PgDriver } from "@drivers/pg";
import { runJunctionSideActionsBehavior } from "@tests/contracts/engine/write/junction-side-actions-behavior";
import { TEST_CONNECTION_STRING } from "./pg-fixtures";

const describeIf = TEST_CONNECTION_STRING ? describe : describe.skip;
const NAMESPACE = "viborm_junction_side_actions";

describeIf("pg Driver", () => {
  const admin = new PgDriver({ databaseUrl: TEST_CONNECTION_STRING });

  beforeAll(async () => {
    await admin._executeRaw(`DROP SCHEMA IF EXISTS "${NAMESPACE}" CASCADE`);
    await admin._executeRaw(`CREATE SCHEMA "${NAMESPACE}"`);
  });

  afterAll(async () => {
    await admin._executeRaw(`DROP SCHEMA IF EXISTS "${NAMESPACE}" CASCADE`);
    await admin.disconnect();
  });

  runJunctionSideActionsBehavior({
    name: "pg",
    createDriver: () =>
      new PgDriver({
        databaseUrl: TEST_CONNECTION_STRING,
        namespace: NAMESPACE,
      }),
  });
});
