/**
 * LibSQL write-engine conformance over the update schemas: the update family, located parent refs, inverse to-one creates, the depth seam, and produced identity.
 *
 * One file of the LibSQL provider suite, which is split across sibling
 * `libsql-*.test.ts` files. Every registered contract instantiates the
 * client's generic surface over its own multi-model schema, and the 1280 MB
 * TypeScript shard heap holds only a handful of those instantiations per
 * program, so the suite is partitioned by schema group rather than by size.
 * The forced-batch driver the batch contracts need lives in
 * `./libsql-fixtures`, which Vitest does not collect.
 */

import { runDepthSeamBehavior } from "@tests/contracts/engine/write/depth-seam-behavior";
import { runInverseToOneCreateBehavior } from "@tests/contracts/engine/write/inverse-to-one-create-behavior";
import { runLocatedParentRefBehavior } from "@tests/contracts/engine/write/located-parent-ref-behavior";
import { runProducedIdentityBehavior } from "@tests/contracts/engine/write/produced-identity-depth-behavior";
import { runUpdateFamilyBehavior } from "@tests/contracts/engine/write/update-family-behavior";
import { createInMemoryLibSQLDriver } from "@tests/fixtures/drivers/libsql";
import { describe } from "vitest";
import { BatchOnlyLibSQLDriver } from "./libsql-fixtures";

// biome-ignore lint/suspicious/noSkippedTests: V1 effectful push is not supported by libSQL.
describe.skip("LibSQL contracts that need effectful live-schema setup (DRIVER_NOT_SUPPORTED)", () => {
  runUpdateFamilyBehavior({
    name: "LibSQL transaction",
    createDriver: createInMemoryLibSQLDriver,
  });
  runUpdateFamilyBehavior({
    name: "LibSQL atomic batch",
    createDriver: () => new BatchOnlyLibSQLDriver(),
  });
  runLocatedParentRefBehavior({
    name: "LibSQL transaction",
    createDriver: createInMemoryLibSQLDriver,
  });
  runLocatedParentRefBehavior({
    name: "LibSQL atomic batch",
    createDriver: () => new BatchOnlyLibSQLDriver(),
  });
  runInverseToOneCreateBehavior({
    name: "LibSQL transaction",
    createDriver: createInMemoryLibSQLDriver,
  });
  runInverseToOneCreateBehavior({
    name: "LibSQL atomic batch",
    createDriver: () => new BatchOnlyLibSQLDriver(),
  });
  runDepthSeamBehavior({
    name: "LibSQL transaction",
    createDriver: createInMemoryLibSQLDriver,
  });
  runDepthSeamBehavior({
    name: "LibSQL atomic batch",
    createDriver: () => new BatchOnlyLibSQLDriver(),
  });
  runProducedIdentityBehavior({
    name: "LibSQL transaction",
    createDriver: createInMemoryLibSQLDriver,
  });
  runProducedIdentityBehavior({
    name: "LibSQL atomic batch",
    createDriver: () => new BatchOnlyLibSQLDriver(),
  });
});
