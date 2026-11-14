/**
 * Real-runtime `groupBy` time-step probe for Bun SQL: every case the Vitest
 * behavior runs (`groupby-time-step-cases.ts`), compared with the same
 * JavaScript oracle, in an isolated PostgreSQL schema that is dropped after.
 */

import { isDeepStrictEqual } from "node:util";
import { createClient } from "@client/client";
import { BunSQLDriver } from "@drivers/bun-sql";
import {
  GROUPBY_TIME_STEP_CASES,
  groupByTimeStepClients,
  groupByTimeStepRows,
  groupByTimeStepSchema,
} from "@tests/contracts/engine/query/groupby-time-step-cases";
import { syncLiveSchema as push } from "@tests/fixtures/sync-schema";

const databaseUrl = process.env.PG_TEST_CONNECTION_STRING;
if (!databaseUrl) {
  throw new Error(
    "PG_TEST_CONNECTION_STRING is required for the Bun SQL probe"
  );
}

const PROBE_NAMESPACE = "viborm_bun_sql_groupby_probe";

async function onNamespace(statements: readonly string[]): Promise<void> {
  const driver = new BunSQLDriver({ databaseUrl });
  try {
    for (const statement of statements) await driver._executeRaw(statement);
  } finally {
    await driver._disconnect();
  }
}

await onNamespace([
  `DROP SCHEMA IF EXISTS "${PROBE_NAMESPACE}" CASCADE`,
  `CREATE SCHEMA "${PROBE_NAMESPACE}"`,
]);

const base = createClient({
  schema: groupByTimeStepSchema("bun_sql_groupby"),
  driver: new BunSQLDriver({ databaseUrl, namespace: PROBE_NAMESPACE }),
});

try {
  await push(base, { force: true });
  await base.facture.createMany({ data: [...groupByTimeStepRows.facture] });
  await base.depense.createMany({ data: groupByTimeStepRows.depense });
  await base.ancien.createMany({ data: groupByTimeStepRows.ancien });
  const clients = groupByTimeStepClients(base);
  const failed: string[] = [];
  for (const { name, run } of GROUPBY_TIME_STEP_CASES) {
    const { actual, expected } = await run(clients);
    if (!isDeepStrictEqual(actual, expected))
      failed.push(
        `${name}\n  actual:   ${JSON.stringify(actual)}\n  expected: ${JSON.stringify(expected)}`
      );
  }
  if (failed.length > 0) throw new Error(failed.join("\n"));
  console.log(
    `bun-sql groupBy time-step evidence passed (${GROUPBY_TIME_STEP_CASES.length} cases)`
  );
} finally {
  try {
    await base.$disconnect();
  } finally {
    await onNamespace([`DROP SCHEMA IF EXISTS "${PROBE_NAMESPACE}" CASCADE`]);
  }
}
