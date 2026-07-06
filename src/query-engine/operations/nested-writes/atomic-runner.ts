import type { AnyDriver } from "@drivers";
import { type Operation, QueryEngineError } from "../../types";

type NestedMutationOperation = Extract<
  Operation,
  "create" | "update" | "upsert"
>;

export async function runNestedMutationAtomically<T>(
  driver: AnyDriver,
  operation: NestedMutationOperation,
  run: (atomicDriver: AnyDriver) => Promise<T>
): Promise<T> {
  if (driver.supportsTransactions) {
    return driver.withTransaction((txDriver) => run(txDriver));
  }

  if (driver.supportsBatch) {
    throw new QueryEngineError(
      `Driver '${driver.driverName}' reached the transaction-only nested ${operation} path, but this driver requires planned atomic batch execution.`,
      {
        meta: {
          driver: driver.driverName,
          operation,
          strategy: "batch",
        },
      }
    );
  }

  throw new QueryEngineError(
    `Driver '${driver.driverName}' cannot execute nested ${operation} writes atomically because it supports neither callback transactions nor atomic batch execution.`,
    {
      meta: {
        driver: driver.driverName,
        operation,
        strategy: "unsupported",
      },
    }
  );
}
