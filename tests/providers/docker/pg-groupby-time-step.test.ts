/**
 * pg: `groupBy` by a time step on a real PostgreSQL server, every session in
 * Pacific/Chatham (UTC+13:45), so a period that followed the session's zone
 * would land on another day.
 *
 * NOTE: These tests require a running PostgreSQL database.
 */

import { PgDriver } from "@drivers/pg";
import {
  runGroupByDateStyleBehavior,
  runGroupByTimeStepBehavior,
} from "@tests/contracts/engine/query/groupby-time-step-behavior";
import { dropEveryLiveTable, TEST_CONNECTION_STRING } from "./pg-fixtures";

const SESSION_ZONE = "Pacific/Chatham";

/** `url`'s sessions with `setting` added to whatever its options set. */
const withSession = (url: string, setting: string): string => {
  const parsed = new URL(url);
  const options = parsed.searchParams.get("options");
  parsed.searchParams.set(
    "options",
    options ? `${options} ${setting}` : setting
  );
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
      new PgDriver({
        databaseUrl: withSession(
          TEST_CONNECTION_STRING!,
          `-c TimeZone=${SESSION_ZONE}`
        ),
      }),
  });
  describe("DateStyle", () => {
    // A schema of its own: the tables above are not this push's.
    beforeAll(dropEveryLiveTable);
    // Every session of this driver is in the style from its first connection.
    runGroupByDateStyleBehavior({
      name: "pg",
      createDriver: () =>
        new PgDriver({
          databaseUrl: withSession(
            TEST_CONNECTION_STRING!,
            "-c DateStyle=SQL,DMY"
          ),
        }),
      inStyle: async () => undefined,
    });
  });
});
