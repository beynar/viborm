import { createClient } from "@src/client/client";
import type { Schema } from "@src/client/types";
import type { AnyDriver } from "@src/drivers";

export interface OperationRecord {
  readonly model: string;
  readonly operation: string;
  readonly boundary: "production";
}

type ModelApi = Record<string, (...args: unknown[]) => unknown>;

export interface ObservedClient {
  readonly client: Record<string, ModelApi>;
  readonly operations: OperationRecord[];
}

/**
 * Creates the production client and records calls at its public model boundary.
 * It observes the seam only; it never selects, reimplements, or falls back to a
 * query engine.
 */
export function observeClientOperations<const TSchema extends Schema>(options: {
  schema: TSchema;
  driver: AnyDriver;
}): ObservedClient {
  const { schema, driver } = options;
  const client = createClient({ schema, driver });
  const operations: OperationRecord[] = [];
  const observedClient: Record<string, ModelApi> = {};

  for (const modelName of Object.keys(schema)) {
    observedClient[modelName] = new Proxy<ModelApi>(
      {},
      {
        get(_target, operationProperty) {
          if (typeof operationProperty !== "string") return undefined;
          return (...args: unknown[]) => {
            const modelApi = Reflect.get(client, modelName);
            if (
              (typeof modelApi !== "object" &&
                typeof modelApi !== "function") ||
              modelApi === null
            ) {
              throw new Error(`Client model "${modelName}" is unavailable.`);
            }
            const operation = Reflect.get(modelApi, operationProperty);
            if (typeof operation !== "function") {
              throw new Error(
                `Client operation "${modelName}.${operationProperty}" is unavailable.`
              );
            }
            operations.push({
              model: modelName,
              operation: operationProperty,
              boundary: "production",
            });
            return Reflect.apply(operation, modelApi, args);
          };
        },
      }
    );
  }

  return { client: observedClient, operations };
}
