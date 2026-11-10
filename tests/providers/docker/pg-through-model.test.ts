/** pg Driver Tests — a declared model as the junction, in its own schema. */

import { PgDriver } from "@drivers/pg";
import { runThroughModelGovernedBehavior } from "@tests/contracts/engine/query/through-model-governed-behavior";
import { runThroughModelBehavior } from "@tests/contracts/engine/write/through-model-behavior";
import { TEST_CONNECTION_STRING } from "./pg-fixtures";

const describeIf = TEST_CONNECTION_STRING ? describe : describe.skip;
const NAMESPACE = "viborm_through_model";
const GOVERNED_NAMESPACE = "viborm_through_model_governed";

describeIf("pg Driver", () => {
  const admin = new PgDriver({ databaseUrl: TEST_CONNECTION_STRING });

  beforeAll(async () => {
    await admin._executeRaw(`DROP SCHEMA IF EXISTS "${NAMESPACE}" CASCADE`);
    await admin._executeRaw(`CREATE SCHEMA "${NAMESPACE}"`);
    await admin._executeRaw(
      `DROP SCHEMA IF EXISTS "${GOVERNED_NAMESPACE}" CASCADE`
    );
    await admin._executeRaw(`CREATE SCHEMA "${GOVERNED_NAMESPACE}"`);
  });

  afterAll(async () => {
    await admin._executeRaw(`DROP SCHEMA IF EXISTS "${NAMESPACE}" CASCADE`);
    await admin._executeRaw(
      `DROP SCHEMA IF EXISTS "${GOVERNED_NAMESPACE}" CASCADE`
    );
    await admin.disconnect();
  });

  runThroughModelBehavior({
    name: "pg",
    createDriver: () =>
      new PgDriver({
        databaseUrl: TEST_CONNECTION_STRING,
        namespace: NAMESPACE,
      }),
  });
  runThroughModelGovernedBehavior({
    name: "pg",
    createDriver: () =>
      new PgDriver({
        databaseUrl: TEST_CONNECTION_STRING,
        namespace: GOVERNED_NAMESPACE,
      }),
  });
});
