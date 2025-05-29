// Batch Parser for BaseORM
// Handles batch operations (createMany, updateMany, deleteMany) and converts them to AST

import {
  BatchDataAST,
  BatchOperation,
  BatchOptionsAST,
  DataAST,
  ModelReference,
  ParseError,
  createBatchData,
} from "./ast";
import { DataParser } from "./data-parser";

// ================================
// Batch Parser
// ================================

export class BatchParser {
  constructor(private dataParser: DataParser) {}

  /**
   * Parses createMany operations from Prisma-like syntax to AST
   */
  parseCreateMany(createMany: any, model: ModelReference): BatchDataAST {
    if (!createMany || typeof createMany !== "object") {
      throw new ParseError("Invalid createMany object", { model: model.name });
    }

    const { data, skipDuplicates } = createMany;

    if (!Array.isArray(data)) {
      throw new ParseError("createMany.data must be an array", {
        model: model.name,
      });
    }

    const items: DataAST[] = [];
    for (let i = 0; i < data.length; i++) {
      try {
        const dataAST = this.dataParser.parseData(data[i], model);
        items.push(...dataAST);
      } catch (error) {
        if (error instanceof ParseError) {
          throw new ParseError(
            `Failed to parse createMany item at index ${i}: ${error.message}`,
            {
              model: model.name,
              ...error.context,
            }
          );
        }
        throw error;
      }
    }

    const options: BatchOptionsAST = {};
    if (skipDuplicates !== undefined) {
      options.skipDuplicates = Boolean(skipDuplicates);
    }

    return createBatchData(model, "createMany", items, options);
  }

  /**
   * Parses updateMany operations from Prisma-like syntax to AST
   */
  parseUpdateMany(updateMany: any, model: ModelReference): BatchDataAST {
    if (!updateMany || typeof updateMany !== "object") {
      throw new ParseError("Invalid updateMany object", { model: model.name });
    }

    const { data } = updateMany;

    if (!data) {
      throw new ParseError("updateMany.data is required", {
        model: model.name,
      });
    }

    // For updateMany, data is typically a single object applied to all matching records
    const dataAST = this.dataParser.parseData(data, model);

    return createBatchData(model, "updateMany", dataAST);
  }

  /**
   * Parses deleteMany operations from Prisma-like syntax to AST
   */
  parseDeleteMany(deleteMany: any, model: ModelReference): BatchDataAST {
    // deleteMany typically only needs where conditions, no data
    // The actual filtering will be handled by the filter parser
    return createBatchData(model, "deleteMany", []);
  }

  /**
   * Generic batch operation parser that delegates to specific parsers
   */
  parseBatchOperation(
    operation: BatchOperation,
    args: any,
    model: ModelReference
  ): BatchDataAST {
    switch (operation) {
      case "createMany":
        return this.parseCreateMany(args, model);
      case "updateMany":
        return this.parseUpdateMany(args, model);
      case "deleteMany":
        return this.parseDeleteMany(args, model);
      default:
        throw new ParseError(`Unknown batch operation: ${operation}`, {
          model: model.name,
          operation,
        });
    }
  }
}
