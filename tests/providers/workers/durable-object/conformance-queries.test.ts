/**
 * The driver contracts sqlite3 runs, registered against the Durable Object
 * driver: reads, pagination, windows, index DDL, raw SQL. Each test runs in a
 * fresh object (`harness.ts`).
 */
import { blobFilterContract } from "@tests/contracts/drivers/behaviors/blob-filter-behavior";
import { clientRawContract } from "@tests/contracts/drivers/behaviors/client-raw-behavior";
import { countAggregateWindowContract } from "@tests/contracts/drivers/behaviors/count-aggregate-window-behavior";
import { cursorPaginationContract } from "@tests/contracts/drivers/behaviors/cursor-pagination-behavior";
import { distinctSkipWindowContract } from "@tests/contracts/drivers/behaviors/distinct-skip-window-behavior";
import {
  fkIndexContract,
  fkIndexPlanContract,
  fkIndexUpgradeContract,
} from "@tests/contracts/drivers/behaviors/fk-index-behavior";
import { forwardFkOrderingContract } from "@tests/contracts/drivers/behaviors/forward-fk-ordering-behavior";
import {
  mappedIndexContract,
  partialIndexContract,
  partialIndexCoverageContract,
} from "@tests/contracts/drivers/behaviors/index-ddl-behavior";
import { likeEscapeContract } from "@tests/contracts/drivers/behaviors/like-escape-behavior";
import { nestedOrderByContract } from "@tests/contracts/drivers/behaviors/nested-orderby-behavior";
import { nestedPaginationContract } from "@tests/contracts/drivers/behaviors/nested-pagination-behavior";
import { readPathRegressionContract } from "@tests/contracts/drivers/behaviors/read-path-regression-behavior";
import { durableObjectDriver } from "./harness";

const fixture = {
  driverName: "Durable Object",
  createDriver: durableObjectDriver,
};

fkIndexContract.register(fixture);
mappedIndexContract.register(fixture);
partialIndexContract.register(fixture);
partialIndexCoverageContract.register(fixture);
fkIndexUpgradeContract.register(fixture);
fkIndexPlanContract.register(fixture);
forwardFkOrderingContract.register({ ...fixture, fkNamesRoundTrip: false });
countAggregateWindowContract.register(fixture);
distinctSkipWindowContract.register(fixture);
cursorPaginationContract.register(fixture);
nestedPaginationContract.register(fixture);
nestedOrderByContract.register(fixture);
readPathRegressionContract.register(fixture);
clientRawContract.register(fixture);
likeEscapeContract.register(fixture);
blobFilterContract.register(fixture);
