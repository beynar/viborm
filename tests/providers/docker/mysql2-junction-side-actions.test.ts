/**
 * MySQL2 Driver Tests — asymmetric junction referential actions (#46).
 *
 * The MySQL leg, pushed into its own database so the no-op repush diffs this
 * suite's tables and nothing a neighbour left in the shared one. InnoDB treats
 * `NO ACTION` as `RESTRICT`; both refuse while the other junction key
 * cascades.
 */

import { MySQL2Driver } from "@drivers/mysql2";
import { runJunctionSideActionsBehavior } from "@tests/contracts/engine/write/junction-side-actions-behavior";
import { createMySQL2Driver, TEST_CONNECTION_STRING } from "./mysql2-fixtures";

const describeIf = TEST_CONNECTION_STRING ? describe : describe.skip;
const NAMESPACE = "viborm_junction_side_actions";

describeIf("MySQL2 Driver", () => {
  const admin = createMySQL2Driver();

  beforeAll(async () => {
    await admin._executeRaw(`DROP DATABASE IF EXISTS \`${NAMESPACE}\``);
    await admin._executeRaw(`CREATE DATABASE \`${NAMESPACE}\``);
  });

  afterAll(async () => {
    await admin._executeRaw(`DROP DATABASE IF EXISTS \`${NAMESPACE}\``);
    await admin.disconnect();
  });

  runJunctionSideActionsBehavior({
    name: "mysql2",
    createDriver: () =>
      new MySQL2Driver({
        databaseUrl: TEST_CONNECTION_STRING,
        namespace: NAMESPACE,
        migrationNamespaceAttestation: "non-redirecting",
      }),
  });
});
