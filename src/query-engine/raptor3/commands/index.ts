import type { Operations } from "@client/types";
import type { PreparedBatchOperation } from "../../types";
import {
  type ExecutionBinding,
  OperationContext,
} from "../shared/operation-context";
import {
  type Arguments,
  type EngineConfig,
  EngineSchema,
  type Operation,
} from "../shared/schema";
import { Commands } from "./commands";

function supportsOperation(operation: Operations): operation is Operation {
  return (
    operation === "create" ||
    operation === "createMany" ||
    operation === "update" ||
    operation === "upsert" ||
    operation === "updateMany" ||
    operation === "deleteMany" ||
    operation === "findMany" ||
    operation === "findUnique" ||
    operation === "groupBy"
  );
}

export function createCommandEngine(config: EngineConfig) {
  const schema = new EngineSchema(config.schema);
  const run = async (
    context: OperationContext,
    operation: Parameters<EngineSchema["admit"]>[1],
    rawArgs: unknown
  ): Promise<unknown> => {
    const model = config.schema[context.modelName]!;
    const args = schema.admit(model, operation, rawArgs);
    return context.run(async () => {
      if (operation === "findUnique") {
        const rows = await context.read(
          context.queries.select(model, { ...args, take: 1 })
        );
        return rows[0] ?? null;
      }
      if (operation === "findMany" || operation === "groupBy")
        return context.read(
          operation === "groupBy"
            ? context.queries.grouped(model, args)
            : context.queries.select(model, args)
        );
      return new Commands(context).execute(model, args, rawArgs as Arguments);
    });
  };
  return {
    async execute(
      modelName: string,
      operation: Operations,
      rawArgs: unknown,
      binding?: ExecutionBinding
    ): Promise<unknown> {
      if (!supportsOperation(operation)) {
        throw new Error(
          `Raptor 3 G1 operation is not implemented: ${operation}`
        );
      }
      const context = new OperationContext(
        schema,
        config.driver,
        modelName,
        operation,
        binding
      );
      return run(context, operation, rawArgs);
    },
    async prepareBatch(
      modelName: string,
      operation: Operations,
      rawArgs: unknown
    ): Promise<PreparedBatchOperation<unknown> | undefined> {
      if (!supportsOperation(operation)) {
        throw new Error(
          `Raptor 3 G1 operation is not implemented: ${operation}`
        );
      }
      const context = new OperationContext(
        schema,
        config.driver,
        modelName,
        operation,
        undefined,
        true
      );
      try {
        await run(context, operation, rawArgs);
      } catch (error) {
        if (context.isIncompletePreparation(error)) return undefined;
        throw error;
      }
      return context.preparedBatch();
    },
  };
}
