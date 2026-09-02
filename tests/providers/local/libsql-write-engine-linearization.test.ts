/**
 * LibSQL write-engine conformance over the linearization schemas: own-write linearization, boolean no-op arms, post-transition adoption, junction createMany, and extended whereUnique.
 *
 * One file of the LibSQL provider suite, which is split across sibling
 * `libsql-*.test.ts` files. Every registered contract instantiates the
 * client's generic surface over its own multi-model schema, and the 1280 MB
 * TypeScript shard heap holds only a handful of those instantiations per
 * program, so the suite is partitioned by schema group rather than by size.
 * The forced-batch driver the batch contracts need lives in
 * `./libsql-fixtures`, which Vitest does not collect.
 */

import { runBooleanNoOpArmBehavior } from "@tests/contracts/engine/write/boolean-noop-arm-behavior";
import { runExtendedWhereUniqueBehavior } from "@tests/contracts/engine/write/extended-where-unique-behavior";
import { runJunctionCreateManyBehavior } from "@tests/contracts/engine/write/junction-create-many-behavior";
import { runOwnWriteLinearizationBehavior } from "@tests/contracts/engine/write/own-write-linearization-behavior";
import { runPostTransitionAdoptBehavior } from "@tests/contracts/engine/write/post-transition-adopt-behavior";
import { createInMemoryLibSQLDriver } from "@tests/fixtures/drivers/libsql";
import { describe } from "vitest";
import { BatchOnlyLibSQLDriver } from "./libsql-fixtures";

// biome-ignore lint/suspicious/noSkippedTests: V1 effectful push is not supported by libSQL.
describe.skip("LibSQL contracts that need effectful live-schema setup (DRIVER_NOT_SUPPORTED)", () => {
  runOwnWriteLinearizationBehavior({
    name: "LibSQL transaction",
    createDriver: createInMemoryLibSQLDriver,
  });
  runOwnWriteLinearizationBehavior({
    name: "LibSQL atomic batch",
    createDriver: () => new BatchOnlyLibSQLDriver(),
  });
  runBooleanNoOpArmBehavior({
    name: "LibSQL transaction",
    createDriver: createInMemoryLibSQLDriver,
  });
  runBooleanNoOpArmBehavior({
    name: "LibSQL atomic batch",
    createDriver: () => new BatchOnlyLibSQLDriver(),
  });
  runPostTransitionAdoptBehavior({
    name: "LibSQL transaction",
    createDriver: createInMemoryLibSQLDriver,
  });
  runPostTransitionAdoptBehavior({
    name: "LibSQL atomic batch",
    createDriver: () => new BatchOnlyLibSQLDriver(),
  });
  runJunctionCreateManyBehavior({
    name: "LibSQL transaction",
    createDriver: createInMemoryLibSQLDriver,
  });
  runJunctionCreateManyBehavior({
    name: "LibSQL atomic batch",
    createDriver: () => new BatchOnlyLibSQLDriver(),
  });
  runExtendedWhereUniqueBehavior({
    name: "LibSQL transaction",
    createDriver: createInMemoryLibSQLDriver,
  });
  runExtendedWhereUniqueBehavior({
    name: "LibSQL atomic batch",
    createDriver: () => new BatchOnlyLibSQLDriver(),
  });
});
