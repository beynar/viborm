import { LibSQLDriver } from "@drivers/libsql";
import type { BatchQuery, QueryResult } from "@drivers/types";
import type { Client, Transaction } from "@libsql/client";
import { createInMemoryLibSQLDriver } from "../fixtures/drivers/libsql";
import { runCreateManyBehavior } from "../query-engine-v2/create-many-behavior";
import { runCreateNestedUpsertBehavior } from "../query-engine-v2/create-nested-upsert-behavior";
import { runNestedMutationBehavior } from "../query-engine-v2/nested-mutation-behavior";
import { runUpdateFamilyBehavior } from "../query-engine-v2/update-family-behavior";
import { runUpdateNestedUpsertBehavior } from "../query-engine-v2/update-nested-upsert-behavior";
import { runUpsertFamilyBehavior } from "../query-engine-v2/upsert-family-behavior";
import { runReadBehavior } from "../query-engine-v2/read-behavior";
import { runBulkWriteBehavior } from "../query-engine-v2/bulk-write-behavior";
import { runClientRawBehavior } from "./client-raw-behavior";
import { runCompoundKeyBehavior } from "./compound-key-behavior";
import { runCountAggregateWindowBehavior } from "./count-aggregate-window-behavior";
import { runCursorPaginationBehavior } from "./cursor-pagination-behavior";
import { runDistinctSkipWindowBehavior } from "./distinct-skip-window-behavior";
import { runLikeEscapeBehavior } from "./like-escape-behavior";
import { runListJsonFilterBehavior } from "./list-json-filter-behavior";
import { runManyAndReturnBehavior } from "./many-and-return-behavior";
import { runManyToManyBehavior } from "./many-to-many-behavior";
import { runNestedOrderByBehavior } from "./nested-orderby-behavior";
import { runNestedWriteAdvancedBehavior } from "./nested-write-advanced-behavior";
import { runNestedWriteBehavior } from "./nested-write-behavior";
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
  runManyAndReturnBehavior({
    driverName: "LibSQL",
    createDriver: createInMemoryLibSQLDriver,
  });

  runLikeEscapeBehavior({
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
