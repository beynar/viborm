import type { Operations } from "@client/types";
import {
  type ExecutionBinding,
  OperationContext,
} from "../shared/operation-context";
import {
  type Arguments,
  type EngineConfig,
  EngineSchema,
} from "../shared/schema";
import { Program } from "./program";

export function createProgramEngine(config: EngineConfig) {
  const schema = new EngineSchema(config.schema);
  return {
    async execute(
      modelName: string,
      operation: Operations,
      rawArgs: unknown,
      binding?: ExecutionBinding
    ): Promise<unknown> {
      if (
        operation !== "create" &&
        operation !== "update" &&
        operation !== "updateMany" &&
        operation !== "findMany" &&
        operation !== "groupBy"
      ) {
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
      const model = config.schema[modelName]!;
      const args = schema.admit(model, operation, rawArgs);
      return context.run(async () => {
        if (operation === "findMany" || operation === "groupBy")
          return context.read(
            operation === "groupBy"
              ? context.queries.grouped(model, args)
              : context.queries.select(model, args)
          );
        return new Program(context).execute(model, args, rawArgs as Arguments);
      });
    },
  };
}
