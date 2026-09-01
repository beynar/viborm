/**
 * LibSQL Prisma parity, optional and polymorphic relations, JSON list and null-sentinel filtering, read-path regressions, relation aggregates, and nested orderBy.
 *
 * One file of the LibSQL provider suite, which is split across sibling
 * `libsql-*.test.ts` files. Every registered contract instantiates the
 * client's generic surface over its own multi-model schema, and the 1280 MB
 * TypeScript shard heap holds only a handful of those instantiations per
 * program, so the suite is partitioned by schema group rather than by size.
 * The forced-batch driver the batch contracts need lives in
 * `./libsql-fixtures`, which Vitest does not collect.
 */

import { jsonNullSentinelContract } from "@tests/contracts/drivers/behaviors/json-null-sentinel-behavior";
import { listJsonFilterContract } from "@tests/contracts/drivers/behaviors/list-json-filter-behavior";
import { nestedOrderByContract } from "@tests/contracts/drivers/behaviors/nested-orderby-behavior";
import { optionalRelationParityContract } from "@tests/contracts/drivers/behaviors/optional-relation-parity-behavior";
import { polymorphicRelationContract } from "@tests/contracts/drivers/behaviors/polymorphic-relation-behavior";
import { prismaParityContract } from "@tests/contracts/drivers/behaviors/prisma-parity-behavior";
import { readPathRegressionContract } from "@tests/contracts/drivers/behaviors/read-path-regression-behavior";
import { relationReadAggregateContract } from "@tests/contracts/drivers/behaviors/relation-read-aggregate-behavior";
import { createInMemoryLibSQLDriver } from "@tests/fixtures/drivers/libsql";
import { describe } from "vitest";

// biome-ignore lint/suspicious/noSkippedTests: V1 effectful push is not supported by libSQL.
describe.skip("LibSQL contracts that need effectful live-schema setup (DRIVER_NOT_SUPPORTED)", () => {
  prismaParityContract.register({
    driverName: "LibSQL",
    createDriver: createInMemoryLibSQLDriver,
  });
  optionalRelationParityContract.register({
    driverName: "LibSQL",
    createDriver: createInMemoryLibSQLDriver,
  });
  polymorphicRelationContract.register({
    name: "LibSQL",
    createDriver: createInMemoryLibSQLDriver,
  });
  listJsonFilterContract.register({
    driverName: "LibSQL",
    createDriver: createInMemoryLibSQLDriver,
  });
  jsonNullSentinelContract.register({
    driverName: "LibSQL",
    createDriver: createInMemoryLibSQLDriver,
  });
  readPathRegressionContract.register({
    driverName: "LibSQL",
    createDriver: createInMemoryLibSQLDriver,
  });
  relationReadAggregateContract.register({
    driverName: "LibSQL",
    createDriver: createInMemoryLibSQLDriver,
  });
  nestedOrderByContract.register({
    driverName: "LibSQL",
    createDriver: createInMemoryLibSQLDriver,
  });
});
