/**
 * PGlite provider suite — scalar values and value filters.
 *
 * Scalar and decimal roundtrips, JSON / list / blob / LIKE filters, field
 * references, raw client SQL, and the Prisma-parity and optional-relation
 * parity reads.
 *
 * This is one of five `pglite*.test.ts` pieces. The suite is split by SCHEMA:
 * every behavior contract carries its own model set, and one program holding
 * all of them cannot be typechecked inside the fixed 1280 MB shard heap. Each
 * piece keeps the same `describe("PGlite Driver")` wrapper, so every test's
 * reported name is unchanged by the split.
 */

import { blobFilterContract } from "@tests/contracts/drivers/behaviors/blob-filter-behavior";
import { clientRawContract } from "@tests/contracts/drivers/behaviors/client-raw-behavior";
import { decimalExactnessContract } from "@tests/contracts/drivers/behaviors/decimal-exactness-behavior";
import { fieldReferenceContract } from "@tests/contracts/drivers/behaviors/field-reference-behavior";
import { jsonNullSentinelContract } from "@tests/contracts/drivers/behaviors/json-null-sentinel-behavior";
import { likeEscapeContract } from "@tests/contracts/drivers/behaviors/like-escape-behavior";
import { listJsonFilterContract } from "@tests/contracts/drivers/behaviors/list-json-filter-behavior";
import { optionalRelationParityContract } from "@tests/contracts/drivers/behaviors/optional-relation-parity-behavior";
import { prismaParityContract } from "@tests/contracts/drivers/behaviors/prisma-parity-behavior";
import {
  fullScalarRoundtripContract,
  scalarRoundtripContract,
} from "@tests/contracts/drivers/behaviors/scalar-roundtrip-behavior";
import { createInMemoryPGliteDriver } from "@tests/fixtures/drivers/pglite";

describe("PGlite Driver", () => {
  listJsonFilterContract.register({
    driverName: "PGlite",
    createDriver: createInMemoryPGliteDriver,
  });
  jsonNullSentinelContract.register({
    driverName: "PGlite",
    createDriver: createInMemoryPGliteDriver,
  });
  likeEscapeContract.register({
    driverName: "PGlite",
    createDriver: createInMemoryPGliteDriver,
  });
  blobFilterContract.register({
    driverName: "PGlite",
    createDriver: createInMemoryPGliteDriver,
  });

  fieldReferenceContract.register({
    driverName: "PGlite",
    createDriver: createInMemoryPGliteDriver,
  });
  prismaParityContract.register({
    driverName: "PGlite",
    createDriver: createInMemoryPGliteDriver,
  });

  optionalRelationParityContract.register({
    driverName: "PGlite",
    createDriver: createInMemoryPGliteDriver,
  });
  clientRawContract.register({
    driverName: "PGlite",
    createDriver: createInMemoryPGliteDriver,
  });
  scalarRoundtripContract.register({
    driverName: "PGlite",
    createDriver: createInMemoryPGliteDriver,
  });
  decimalExactnessContract.register({
    driverName: "PGlite",
    createDriver: createInMemoryPGliteDriver,
    // SQLite-legal intersection: `precision + scale <= 18` (plan 3.1).
    descriptor: { precision: 16, scale: 2 },
  });
  fullScalarRoundtripContract.register({
    driverName: "PGlite",
    createDriver: createInMemoryPGliteDriver,
  });
});
