/** MySQL2 Driver Tests — a declared model as the junction, in its own database. */

import { MySQL2Driver } from "@drivers/mysql2";
import { runThroughModelGovernedBehavior } from "@tests/contracts/engine/query/through-model-governed-behavior";
import { runThroughModelBehavior } from "@tests/contracts/engine/write/through-model-behavior";
import { createMySQL2Driver, TEST_CONNECTION_STRING } from "./mysql2-fixtures";

const describeIf = TEST_CONNECTION_STRING ? describe : describe.skip;
const NAMESPACE = "viborm_through_model";
const GOVERNED_NAMESPACE = "viborm_through_model_governed";

describeIf("MySQL2 Driver", () => {
  const admin = createMySQL2Driver();

  beforeAll(async () => {
    await admin._executeRaw(`DROP DATABASE IF EXISTS \`${NAMESPACE}\``);
    await admin._executeRaw(`CREATE DATABASE \`${NAMESPACE}\``);
    await admin._executeRaw(
      `DROP DATABASE IF EXISTS \`${GOVERNED_NAMESPACE}\``
    );
    await admin._executeRaw(`CREATE DATABASE \`${GOVERNED_NAMESPACE}\``);
  });

  afterAll(async () => {
    await admin._executeRaw(`DROP DATABASE IF EXISTS \`${NAMESPACE}\``);
    await admin._executeRaw(
      `DROP DATABASE IF EXISTS \`${GOVERNED_NAMESPACE}\``
    );
    await admin.disconnect();
  });

  runThroughModelBehavior({
    name: "mysql2",
    createDriver: () =>
      new MySQL2Driver({
        databaseUrl: TEST_CONNECTION_STRING,
        namespace: NAMESPACE,
        migrationNamespaceAttestation: "non-redirecting",
      }),
  });
  runThroughModelGovernedBehavior({
    name: "mysql2",
    createDriver: () =>
      new MySQL2Driver({
        databaseUrl: TEST_CONNECTION_STRING,
        namespace: GOVERNED_NAMESPACE,
        migrationNamespaceAttestation: "non-redirecting",
      }),
  });
});
