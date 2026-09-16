import type { Operations } from "@client/types";
import {
  type ExecutionBinding,
  OperationContext,
} from "../shared/operation-context";
import {
  type Arguments,
  type EngineConfig,
  EngineSchema,
  isReadOperation,
  type Operation,
} from "../shared/schema";
import { Program } from "./program";

/** The G1-01 comparison specimen's verbs, in its own retained vocabulary. */
function admittedOperation(operation: Operations): Operation | undefined {
  switch (operation) {
    case "create":
    case "update":
    case "updateMany":
    case "findMany":
    case "groupBy":
      return operation;
    default:
      return undefined;
  }
}

export function createProgramEngine(config: EngineConfig) {
  const schema = new EngineSchema(config.schema, config.resolved);
  return {
    async execute(
      modelName: string,
      operation: Operations,
      rawArgs: unknown,
      binding?: ExecutionBinding
    ): Promise<unknown> {
      const admitted = admittedOperation(operation);
      if (!admitted)
        throw new Error(
          `Raptor 3 G1 operation is not implemented: ${operation}`
        );
      const context = new OperationContext(
        schema,
        config.driver,
        modelName,
        admitted,
        binding
      );
      const model = config.schema[modelName]!;
      const args = schema.admit(model, admitted, rawArgs);
      return context.run(async () => {
        // The specimen keeps ONE read entry: the same `Queries.read` owner the
        // commands engine consumes decides statement, cardinality and shape.
        if (isReadOperation(admitted))
          return context.publish(context.queries.read(model, admitted, args));
        return new Program(context).execute(model, args, rawArgs as Arguments);
      });
    },
  };
}
