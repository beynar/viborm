import { LibSQLDriver } from "@drivers/libsql";
import type { BatchQuery, QueryResult } from "@drivers/types";
import type { Client, Transaction } from "@libsql/client";
import { createInMemoryLibSQLDriver } from "../fixtures/drivers/libsql";
import { runBooleanNoOpArmBehavior } from "../query-engine-v2/boolean-noop-arm-behavior";
import { runBulkWriteBehavior } from "../query-engine-v2/bulk-write-behavior";
import { runCreateManyBehavior } from "../query-engine-v2/create-many-behavior";
import { runCreateNestedUpsertBehavior } from "../query-engine-v2/create-nested-upsert-behavior";
import { runDepthSeamBehavior } from "../query-engine-v2/depth-seam-behavior";
import { runExtendedWhereUniqueBehavior } from "../query-engine-v2/extended-where-unique-behavior";
import { runInverseToOneCreateBehavior } from "../query-engine-v2/inverse-to-one-create-behavior";
import { runJunctionCreateManyBehavior } from "../query-engine-v2/junction-create-many-behavior";
import { runLocatedParentRefBehavior } from "../query-engine-v2/located-parent-ref-behavior";
import { runNestedMutationBehavior } from "../query-engine-v2/nested-mutation-behavior";
import { runOwnWriteLinearizationBehavior } from "../query-engine-v2/own-write-linearization-behavior";
import { runPostTransitionAdoptBehavior } from "../query-engine-v2/post-transition-adopt-behavior";
import { runProducedIdentityBehavior } from "../query-engine-v2/produced-identity-depth-behavior";
import { runReadBehavior } from "../query-engine-v2/read-behavior";
import { runToOneUpdateWhereBehavior } from "../query-engine-v2/to-one-update-where-behavior";
import { runUpdateFamilyBehavior } from "../query-engine-v2/update-family-behavior";
import { runUpdateNestedUpsertBehavior } from "../query-engine-v2/update-nested-upsert-behavior";
import { runUpsertFamilyBehavior } from "../query-engine-v2/upsert-family-behavior";
import { runBatchPrimaryKeyDataflowBehavior } from "./batch-primary-key-dataflow-behavior";
import { runBlobFilterBehavior } from "./blob-filter-behavior";
import { runBulkWriteLimitBehavior } from "./bulk-write-limit-behavior";
import { runClientRawBehavior } from "./client-raw-behavior";
import { runCompoundKeyBehavior } from "./compound-key-behavior";
import { runCountAggregateWindowBehavior } from "./count-aggregate-window-behavior";
import { runCursorPaginationBehavior } from "./cursor-pagination-behavior";
import { runDecimalExactnessBehavior } from "./decimal-exactness-behavior";
import { runDistinctSkipWindowBehavior } from "./distinct-skip-window-behavior";
import { runFieldReferenceBehavior } from "./field-reference-behavior";
import {
  runFkIndexBehavior,
  runFkIndexUpgradeBehavior,
} from "./fk-index-behavior";
import { runForwardFkOrderingBehavior } from "./forward-fk-ordering-behavior";
import { runImplicitReturningBehavior } from "./implicit-returning-behavior";
import {
  runMappedIndexBehavior,
  runPartialIndexBehavior,
} from "./index-ddl-behavior";
import { runJsonNullSentinelBehavior } from "./json-null-sentinel-behavior";
import { runLikeEscapeBehavior } from "./like-escape-behavior";
import { runListJsonFilterBehavior } from "./list-json-filter-behavior";
import { runManyToManyBehavior } from "./many-to-many-behavior";
import { runNestedOrderByBehavior } from "./nested-orderby-behavior";
import { runNestedPaginationBehavior } from "./nested-pagination-behavior";
import { runNestedWriteAdvancedBehavior } from "./nested-write-advanced-behavior";
import { runNestedWriteBehavior } from "./nested-write-behavior";
import { runOmitBehavior } from "./omit-behavior";
import { runOptionalRelationParityBehavior } from "./optional-relation-parity-behavior";
import { runOrderingArrayCreateBehavior } from "./ordering-array-create-behavior";
import { runPrismaParityBehavior } from "./prisma-parity-behavior";
import { runReadPathRegressionBehavior } from "./read-path-regression-behavior";
import { runRelationFilterMutationBehavior } from "./relation-filter-mutation-behavior";
import { runRelationReadAggregateBehavior } from "./relation-read-aggregate-behavior";
import {
  runFullScalarRoundtripBehavior,
  runScalarRoundtripBehavior,
} from "./scalar-roundtrip-behavior";
import { runUpsertAtomicityBehavior } from "./upsert-atomicity-behavior";

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
  runFkIndexBehavior({
    driverName: "LibSQL",
    createDriver: createInMemoryLibSQLDriver,
  });
  runMappedIndexBehavior({
    driverName: "LibSQL",
    createDriver: createInMemoryLibSQLDriver,
  });
  runPartialIndexBehavior({
    driverName: "LibSQL",
    createDriver: createInMemoryLibSQLDriver,
  });
  runFkIndexUpgradeBehavior({
    driverName: "LibSQL",
    createDriver: createInMemoryLibSQLDriver,
  });

  runForwardFkOrderingBehavior({
    driverName: "LibSQL",
    createDriver: createInMemoryLibSQLDriver,
    fkNamesRoundTrip: false,
  });

  runCountAggregateWindowBehavior({
    driverName: "LibSQL",
    createDriver: createInMemoryLibSQLDriver,
  });

  runDistinctSkipWindowBehavior({
    driverName: "LibSQL",
    createDriver: createInMemoryLibSQLDriver,
  });

  runCursorPaginationBehavior({
    driverName: "LibSQL",
    createDriver: createInMemoryLibSQLDriver,
  });

  runNestedPaginationBehavior({
    driverName: "LibSQL",
    createDriver: createInMemoryLibSQLDriver,
  });

  runOmitBehavior({
    driverName: "LibSQL",
    createDriver: createInMemoryLibSQLDriver,
  });

  runNestedWriteBehavior({
    driverName: "LibSQL",
    createDriver: createInMemoryLibSQLDriver,
  });

  runNestedWriteAdvancedBehavior({
    driverName: "LibSQL",
    createDriver: createInMemoryLibSQLDriver,
  });

  runCompoundKeyBehavior({
    driverName: "LibSQL",
    createDriver: createInMemoryLibSQLDriver,
  });

  runManyToManyBehavior({
    driverName: "LibSQL",
    createDriver: createInMemoryLibSQLDriver,
  });

  runOrderingArrayCreateBehavior({
    driverName: "LibSQL",
    createDriver: createInMemoryLibSQLDriver,
  });

  runRelationFilterMutationBehavior({
    driverName: "LibSQL",
    createDriver: createInMemoryLibSQLDriver,
  });

  // LibSQL supports RETURNING, so the full suite applies. Caveat for the
  // atomic-divide scenario: @libsql/client binds JS numbers as REAL
  // (float64), so `qty / 2` on an INT column yields 3.5 where better-sqlite3
  // (INTEGER binding, integer division) yields 3 — same dialect, different
  // driver binding.
  runImplicitReturningBehavior({
    driverName: "LibSQL",
    createDriver: createInMemoryLibSQLDriver,
  });
  runBulkWriteLimitBehavior({
    driverName: "LibSQL",
    createDriver: createInMemoryLibSQLDriver,
  });

  runLikeEscapeBehavior({
    driverName: "LibSQL",
    createDriver: createInMemoryLibSQLDriver,
  });

  runBlobFilterBehavior({
    driverName: "LibSQL",
    createDriver: createInMemoryLibSQLDriver,
  });

  runFieldReferenceBehavior({
    driverName: "LibSQL",
    createDriver: createInMemoryLibSQLDriver,
  });

  runPrismaParityBehavior({
    driverName: "LibSQL",
    createDriver: createInMemoryLibSQLDriver,
  });

  runOptionalRelationParityBehavior({
    driverName: "LibSQL",
    createDriver: createInMemoryLibSQLDriver,
  });

  runListJsonFilterBehavior({
    driverName: "LibSQL",
    createDriver: createInMemoryLibSQLDriver,
  });

  runJsonNullSentinelBehavior({
    driverName: "LibSQL",
    createDriver: createInMemoryLibSQLDriver,
  });

  runReadPathRegressionBehavior({
    driverName: "LibSQL",
    createDriver: createInMemoryLibSQLDriver,
  });

  runRelationReadAggregateBehavior({
    driverName: "LibSQL",
    createDriver: createInMemoryLibSQLDriver,
  });
  runNestedOrderByBehavior({
    driverName: "LibSQL",
    createDriver: createInMemoryLibSQLDriver,
  });

  runClientRawBehavior({
    driverName: "LibSQL",
    createDriver: createInMemoryLibSQLDriver,
  });

  runScalarRoundtripBehavior({
    driverName: "LibSQL",
    createDriver: createInMemoryLibSQLDriver,
  });
  runDecimalExactnessBehavior({
    driverName: "LibSQL",
    createDriver: createInMemoryLibSQLDriver,
    exactDecimal: false,
  });

  runFullScalarRoundtripBehavior({
    driverName: "LibSQL",
    createDriver: createInMemoryLibSQLDriver,
  });

  runUpsertAtomicityBehavior({
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
  runBatchPrimaryKeyDataflowBehavior({
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
