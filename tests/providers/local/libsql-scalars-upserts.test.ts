/**
 * LibSQL client raw, scalar round-trips, decimal exactness, upsert atomicity, and the create-nested-upsert and batch primary-key dataflow schemas.
 *
 * One file of the LibSQL provider suite, which is split across sibling
 * `libsql-*.test.ts` files. Every registered contract instantiates the
 * client's generic surface over its own multi-model schema, and the 1280 MB
 * TypeScript shard heap holds only a handful of those instantiations per
 * program, so the suite is partitioned by schema group rather than by size.
 * The forced-batch driver the batch contracts need lives in
 * `./libsql-fixtures`, which Vitest does not collect.
 */

import { batchPrimaryKeyDataflowContract } from "@tests/contracts/drivers/behaviors/batch-primary-key-dataflow-behavior";
import { clientRawContract } from "@tests/contracts/drivers/behaviors/client-raw-behavior";
import { decimalExactnessContract } from "@tests/contracts/drivers/behaviors/decimal-exactness-behavior";
import {
  fullScalarRoundtripContract,
  scalarRoundtripContract,
} from "@tests/contracts/drivers/behaviors/scalar-roundtrip-behavior";
import { upsertAtomicityContract } from "@tests/contracts/drivers/behaviors/upsert-atomicity-behavior";
import { runCreateNestedUpsertBehavior } from "@tests/contracts/engine/write/create-nested-upsert-behavior";
import { runUpdateNestedUpsertBehavior } from "@tests/contracts/engine/write/update-nested-upsert-behavior";
import { createInMemoryLibSQLDriver } from "@tests/fixtures/drivers/libsql";
import { describe } from "vitest";
import { BatchOnlyLibSQLDriver } from "./libsql-fixtures";

// biome-ignore lint/suspicious/noSkippedTests: V1 effectful push is not supported by libSQL.
describe.skip("LibSQL contracts that need effectful live-schema setup (DRIVER_NOT_SUPPORTED)", () => {
  clientRawContract.register({
    driverName: "LibSQL",
    createDriver: createInMemoryLibSQLDriver,
  });
  scalarRoundtripContract.register({
    driverName: "LibSQL",
    createDriver: createInMemoryLibSQLDriver,
  });
  decimalExactnessContract.register({
    driverName: "LibSQL",
    createDriver: createInMemoryLibSQLDriver,
    // SQLite-legal intersection: `precision + scale <= 18` (plan 3.1).
    descriptor: { precision: 16, scale: 2 },
  });
  fullScalarRoundtripContract.register({
    driverName: "LibSQL",
    createDriver: createInMemoryLibSQLDriver,
  });
  upsertAtomicityContract.register({
    driverName: "LibSQL",
    createDriver: createInMemoryLibSQLDriver,
  });
  runCreateNestedUpsertBehavior({
    name: "LibSQL transaction",
    createDriver: createInMemoryLibSQLDriver,
  });
  runCreateNestedUpsertBehavior({
    name: "LibSQL atomic batch",
    createDriver: () => new BatchOnlyLibSQLDriver(),
  });
  // T4b CLASS III — the batch updated/generated-PK dataflow on the volatile-rowid
  // driver: the updated-PK cases (compile-derived literal FK) and the generated-PK
  // cases (last_insert_rowid batch-ref store) both proven on a real LibSQL batch.
  batchPrimaryKeyDataflowContract.register({
    driverName: "LibSQL batch-only",
    createDriver: () => new BatchOnlyLibSQLDriver(),
  });
  runUpdateNestedUpsertBehavior({
    name: "LibSQL transaction",
    createDriver: createInMemoryLibSQLDriver,
  });
  runUpdateNestedUpsertBehavior({
    name: "LibSQL atomic batch",
    createDriver: () => new BatchOnlyLibSQLDriver(),
  });
});
