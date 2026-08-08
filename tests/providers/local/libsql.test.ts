import { LibSQLDriver } from "@drivers/libsql";
import type { BatchQuery, QueryResult } from "@drivers/types";
import type { Client, Transaction } from "@libsql/client";
import { createInMemoryLibSQLDriver } from "@tests/fixtures/drivers/libsql";
import { runBooleanNoOpArmBehavior } from "@tests/contracts/engine/write/boolean-noop-arm-behavior";
import { runBulkWriteBehavior } from "@tests/contracts/engine/write/bulk-write-behavior";
import { runCreateManyBehavior } from "@tests/contracts/engine/write/create-many-behavior";
import { runCreateNestedUpsertBehavior } from "@tests/contracts/engine/write/create-nested-upsert-behavior";
import { runDepthSeamBehavior } from "@tests/contracts/engine/write/depth-seam-behavior";
import { runExtendedWhereUniqueBehavior } from "@tests/contracts/engine/write/extended-where-unique-behavior";
import { runInverseToOneCreateBehavior } from "@tests/contracts/engine/write/inverse-to-one-create-behavior";
import { runJunctionCreateManyBehavior } from "@tests/contracts/engine/write/junction-create-many-behavior";
import { runLocatedParentRefBehavior } from "@tests/contracts/engine/write/located-parent-ref-behavior";
import { runNestedMutationBehavior } from "@tests/contracts/engine/write/nested-mutation-behavior";
import { runOwnWriteLinearizationBehavior } from "@tests/contracts/engine/write/own-write-linearization-behavior";
import { runPostTransitionAdoptBehavior } from "@tests/contracts/engine/write/post-transition-adopt-behavior";
import { runProducedIdentityBehavior } from "@tests/contracts/engine/write/produced-identity-depth-behavior";
import { runReadBehavior } from "@tests/contracts/engine/write/read-behavior";
import { runToOneUpdateWhereBehavior } from "@tests/contracts/engine/write/to-one-update-where-behavior";
import { runUpdateFamilyBehavior } from "@tests/contracts/engine/write/update-family-behavior";
import { runUpdateNestedUpsertBehavior } from "@tests/contracts/engine/write/update-nested-upsert-behavior";
import { runUpsertFamilyBehavior } from "@tests/contracts/engine/write/upsert-family-behavior";
import { batchPrimaryKeyDataflowContract } from "@tests/contracts/drivers/behaviors/batch-primary-key-dataflow-behavior";
import { blobFilterContract } from "@tests/contracts/drivers/behaviors/blob-filter-behavior";
import { bulkWriteLimitContract } from "@tests/contracts/drivers/behaviors/bulk-write-limit-behavior";
import { clientRawContract } from "@tests/contracts/drivers/behaviors/client-raw-behavior";
import { compoundKeyContract } from "@tests/contracts/drivers/behaviors/compound-key-behavior";
import { countAggregateWindowContract } from "@tests/contracts/drivers/behaviors/count-aggregate-window-behavior";
import { createManyReturnFoldContract } from "@tests/contracts/drivers/behaviors/create-many-return-fold-behavior";
import { cursorPaginationContract } from "@tests/contracts/drivers/behaviors/cursor-pagination-behavior";
import { decimalExactnessContract } from "@tests/contracts/drivers/behaviors/decimal-exactness-behavior";
import { distinctSkipWindowContract } from "@tests/contracts/drivers/behaviors/distinct-skip-window-behavior";
import { fieldReferenceContract } from "@tests/contracts/drivers/behaviors/field-reference-behavior";
import {
  fkIndexContract,
  fkIndexUpgradeContract,
} from "@tests/contracts/drivers/behaviors/fk-index-behavior";
import { forwardFkOrderingContract } from "@tests/contracts/drivers/behaviors/forward-fk-ordering-behavior";
import { implicitReturningContract } from "@tests/contracts/drivers/behaviors/implicit-returning-behavior";
import {
  mappedIndexContract,
  partialIndexContract,
  partialIndexCoverageContract,
} from "@tests/contracts/drivers/behaviors/index-ddl-behavior";
import { jsonNullSentinelContract } from "@tests/contracts/drivers/behaviors/json-null-sentinel-behavior";
import { likeEscapeContract } from "@tests/contracts/drivers/behaviors/like-escape-behavior";
import { listJsonFilterContract } from "@tests/contracts/drivers/behaviors/list-json-filter-behavior";
import { manyToManyContract } from "@tests/contracts/drivers/behaviors/many-to-many-behavior";
import { nestedOrderByContract } from "@tests/contracts/drivers/behaviors/nested-orderby-behavior";
import { nestedPaginationContract } from "@tests/contracts/drivers/behaviors/nested-pagination-behavior";
import { nestedWriteAdvancedContract } from "@tests/contracts/drivers/behaviors/nested-write-advanced-behavior";
import { nestedWriteContract } from "@tests/contracts/drivers/behaviors/nested-write-behavior";
import { omitContract } from "@tests/contracts/drivers/behaviors/omit-behavior";
import { optionalRelationParityContract } from "@tests/contracts/drivers/behaviors/optional-relation-parity-behavior";
import { orderingArrayCreateContract } from "@tests/contracts/drivers/behaviors/ordering-array-create-behavior";
import { prismaParityContract } from "@tests/contracts/drivers/behaviors/prisma-parity-behavior";
import { readPathRegressionContract } from "@tests/contracts/drivers/behaviors/read-path-regression-behavior";
import { relationFilterMutationContract } from "@tests/contracts/drivers/behaviors/relation-filter-mutation-behavior";
import { relationReadAggregateContract } from "@tests/contracts/drivers/behaviors/relation-read-aggregate-behavior";
import {
  fullScalarRoundtripContract,
  scalarRoundtripContract,
} from "@tests/contracts/drivers/behaviors/scalar-roundtrip-behavior";
import { upsertAtomicityContract } from "@tests/contracts/drivers/behaviors/upsert-atomicity-behavior";

class BatchOnlyLibSQLDriver extends LibSQLDriver {
  override readonly supportsTransactions = false;
  override readonly supportsBatch = true;

  protected override async executeBatch<T>(
    client: Client | Transaction,
    queries: BatchQuery[]
  ): Promise<QueryResult<T>[]> {
    return this.transaction(client, async (transaction) => {
      const results: QueryResult<T>[] = [];
      for (const query of queries) {
        results.push(
          await this.executeRaw<T>(transaction, query.sql, query.params)
        );
      }
      return results;
    });
  }
}

describe("LibSQL Driver", () => {
  fkIndexContract.register({
    driverName: "LibSQL",
    createDriver: createInMemoryLibSQLDriver,
  });
  mappedIndexContract.register({
    driverName: "LibSQL",
    createDriver: createInMemoryLibSQLDriver,
  });
  partialIndexContract.register({
    driverName: "LibSQL",
    createDriver: createInMemoryLibSQLDriver,
  });
  partialIndexCoverageContract.register({
    driverName: "LibSQL",
    createDriver: createInMemoryLibSQLDriver,
  });
  fkIndexUpgradeContract.register({
    driverName: "LibSQL",
    createDriver: createInMemoryLibSQLDriver,
  });

  forwardFkOrderingContract.register({
    driverName: "LibSQL",
    createDriver: createInMemoryLibSQLDriver,
    fkNamesRoundTrip: false,
  });

  countAggregateWindowContract.register({
    driverName: "LibSQL",
    createDriver: createInMemoryLibSQLDriver,
  });

  distinctSkipWindowContract.register({
    driverName: "LibSQL",
    createDriver: createInMemoryLibSQLDriver,
  });

  cursorPaginationContract.register({
    driverName: "LibSQL",
    createDriver: createInMemoryLibSQLDriver,
  });

  nestedPaginationContract.register({
    driverName: "LibSQL",
    createDriver: createInMemoryLibSQLDriver,
  });

  omitContract.register({
    driverName: "LibSQL",
    createDriver: createInMemoryLibSQLDriver,
  });

  nestedWriteContract.register({
    driverName: "LibSQL",
    createDriver: createInMemoryLibSQLDriver,
  });

  nestedWriteAdvancedContract.register({
    driverName: "LibSQL",
    createDriver: createInMemoryLibSQLDriver,
  });

  compoundKeyContract.register({
    driverName: "LibSQL",
    createDriver: createInMemoryLibSQLDriver,
  });

  manyToManyContract.register({
    driverName: "LibSQL",
    createDriver: createInMemoryLibSQLDriver,
  });

  orderingArrayCreateContract.register({
    driverName: "LibSQL",
    createDriver: createInMemoryLibSQLDriver,
  });

  relationFilterMutationContract.register({
    driverName: "LibSQL",
    createDriver: createInMemoryLibSQLDriver,
  });

  // LibSQL supports RETURNING, so the full suite applies. Caveat for the
  // atomic-divide scenario: @libsql/client binds JS numbers as REAL
  // (float64), so `qty / 2` on an INT column yields 3.5 where better-sqlite3
  // (INTEGER binding, integer division) yields 3 — same dialect, different
  // driver binding.
  implicitReturningContract.register({
    driverName: "LibSQL",
    createDriver: createInMemoryLibSQLDriver,
  });
  createManyReturnFoldContract.register({
    driverName: "LibSQL",
    createDriver: createInMemoryLibSQLDriver,
  });
  bulkWriteLimitContract.register({
    driverName: "LibSQL",
    createDriver: createInMemoryLibSQLDriver,
  });

  likeEscapeContract.register({
    driverName: "LibSQL",
    createDriver: createInMemoryLibSQLDriver,
  });

  blobFilterContract.register({
    driverName: "LibSQL",
    createDriver: createInMemoryLibSQLDriver,
  });

  fieldReferenceContract.register({
    driverName: "LibSQL",
    createDriver: createInMemoryLibSQLDriver,
  });

  prismaParityContract.register({
    driverName: "LibSQL",
    createDriver: createInMemoryLibSQLDriver,
  });

  optionalRelationParityContract.register({
    driverName: "LibSQL",
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
    exactDecimal: false,
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

  runToOneUpdateWhereBehavior({
    name: "LibSQL transaction",
    createDriver: createInMemoryLibSQLDriver,
  });
  runToOneUpdateWhereBehavior({
    name: "LibSQL atomic batch",
    createDriver: () => new BatchOnlyLibSQLDriver(),
  });

  runUpsertFamilyBehavior({
    name: "LibSQL transaction",
    createDriver: createInMemoryLibSQLDriver,
  });
  runUpsertFamilyBehavior({
    name: "LibSQL atomic batch",
    createDriver: () => new BatchOnlyLibSQLDriver(),
  });

  runNestedMutationBehavior({
    name: "LibSQL transaction",
    createDriver: createInMemoryLibSQLDriver,
  });
  runNestedMutationBehavior({
    name: "LibSQL atomic batch",
    createDriver: () => new BatchOnlyLibSQLDriver(),
  });

  runReadBehavior({
    name: "LibSQL",
    createDriver: createInMemoryLibSQLDriver,
  });
  runBulkWriteBehavior({
    name: "LibSQL",
    createDriver: createInMemoryLibSQLDriver,
  });
  runCreateManyBehavior({
    name: "LibSQL transaction",
    createDriver: createInMemoryLibSQLDriver,
  });
  runCreateManyBehavior({
    name: "LibSQL atomic batch",
    createDriver: () => new BatchOnlyLibSQLDriver(),
  });
});
