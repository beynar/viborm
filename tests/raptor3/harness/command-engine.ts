/**
 * The command engine as the raptor3 harnesses drive it.
 *
 * Production prepares one operation through the route and keeps the handle,
 * so the engine publishes `prepare` alone. A harness runs a public recipe in
 * one call, so this adds the two run-throughs it needs over that same
 * `prepare`: `execute` and `prepareBatch` of one freshly prepared operation.
 */

import type { Operations } from "@client/types";
import type { QueryExecutionContext } from "@drivers/types";
import { createCommandEngine } from "@query-engine/raptor3/commands";
import type { ExecutionBinding } from "@query-engine/raptor3/shared/operation-context";
import type { PreparedBatchOperation } from "@query-engine/types";

export function createTestCommandEngine(
  config: Parameters<typeof createCommandEngine>[0]
) {
  const { prepare } = createCommandEngine(config);
  return {
    prepare,
    execute(
      modelName: string,
      operation: Operations,
      rawArgs: unknown,
      binding?: ExecutionBinding,
      attribution?: QueryExecutionContext
    ): Promise<unknown> {
      return prepare(modelName, operation, rawArgs).execute(
        binding,
        attribution
      );
    },
    prepareBatch(
      modelName: string,
      operation: Operations,
      rawArgs: unknown,
      attribution?: QueryExecutionContext
    ): Promise<PreparedBatchOperation<unknown> | undefined> {
      return prepare(modelName, operation, rawArgs).prepareBatch(attribution);
    },
  };
}
