/**
 * pg: `groupBy` by a time step on a real PostgreSQL server, every session in
 * Pacific/Chatham (UTC+13:45), so a period that followed the session's zone
 * would land on another day.
 *
 * NOTE: These tests require a running PostgreSQL database.
 */

import { PgDriver } from "@drivers/pg";
import { runGroupByTimeStepBehavior } from "@tests/contracts/engine/query/groupby-time-step-behavior";
import { dropEveryLiveTable, TEST_CONNECTION_STRING } from "./pg-fixtures";

const SESSION_ZONE = "Pacific/Chatham";

/** `url`'s sessions in {@link SESSION_ZONE}, whatever else its options set. */
const inSessionZone = (url: string): string => {
  const parsed = new URL(url);
  const options = parsed.searchParams.get("options");
  const zone = `-c TimeZone=${SESSION_ZONE}`;
  parsed.searchParams.set("options", options ? `${options} ${zone}` : zone);
  return parsed.href;
};

describe.skipIf(!TEST_CONNECTION_STRING)("pg Driver", () => {
  beforeAll(dropEveryLiveTable);
  // The provider files share one database: leave it as empty as it was found.
  afterAll(dropEveryLiveTable);

  runGroupByTimeStepBehavior({
    name: "pg",
    sessionZone: SESSION_ZONE,
    createDriver: () =>
      new PgDriver({ databaseUrl: inSessionZone(TEST_CONNECTION_STRING!) }),
  });
});
