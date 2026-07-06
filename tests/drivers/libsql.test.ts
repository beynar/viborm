import { createInMemoryLibSQLDriver } from "../fixtures/drivers/libsql";
import { runCompoundKeyBehavior } from "./compound-key-behavior";
import { runCountAggregateWindowBehavior } from "./count-aggregate-window-behavior";
import { runDistinctSkipWindowBehavior } from "./distinct-skip-window-behavior";
import { runLikeEscapeBehavior } from "./like-escape-behavior";
import { runListJsonFilterBehavior } from "./list-json-filter-behavior";
import { runManyToManyBehavior } from "./many-to-many-behavior";
import { runNestedWriteAdvancedBehavior } from "./nested-write-advanced-behavior";
import { runNestedWriteBehavior } from "./nested-write-behavior";
import { runOptionalRelationParityBehavior } from "./optional-relation-parity-behavior";
import { runOrderingArrayCreateBehavior } from "./ordering-array-create-behavior";
import { runPrismaParityBehavior } from "./prisma-parity-behavior";
import { runReadPathRegressionBehavior } from "./read-path-regression-behavior";
import { runRelationFilterMutationBehavior } from "./relation-filter-mutation-behavior";
import {
  runFullScalarRoundtripBehavior,
  runScalarRoundtripBehavior,
} from "./scalar-roundtrip-behavior";
import { runUpsertAtomicityBehavior } from "./upsert-atomicity-behavior";

// The batch-only suites (batch-primary-key-dataflow, batch-ref-smoke) are not
// wired here: they need a batch-only driver subclass and the batch dataflow is
// already covered by PGlite and SQLite3 batch-only variants.

describe("LibSQL Driver", () => {
  runCountAggregateWindowBehavior({
    driverName: "LibSQL",
    createDriver: createInMemoryLibSQLDriver,
  });

  runDistinctSkipWindowBehavior({
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
});
