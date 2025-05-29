// Cursor Parser for BaseORM
// Handles cursor-based pagination and converts it to AST

import {
  CursorAST,
  ModelReference,
  FieldReference,
  ParseError,
  createCursor,
} from "./ast";
import { FieldResolver } from "./field-resolver";
import { ValueParser } from "./value-parser";

// ================================
// Cursor Parser
// ================================

export class CursorParser {
  constructor(
    private fieldResolver: FieldResolver,
    private valueParser: ValueParser
  ) {}

  /**
   * Parses cursor-based pagination from Prisma-like syntax to AST
   */
  parseCursor(cursor: any, model: ModelReference): CursorAST {
    if (!cursor || typeof cursor !== "object") {
      throw new ParseError("Invalid cursor object", { model: model.name });
    }

    // Cursor should be an object with a single field:value pair
    const entries = Object.entries(cursor);
    if (entries.length !== 1) {
      throw new ParseError("Cursor must contain exactly one field:value pair", {
        model: model.name,
      });
    }

    const [fieldName, value] = entries[0] as [string, any];

    try {
      const fieldRef = this.fieldResolver.resolveField(model.name, fieldName);
      const valueAST = this.valueParser.parseValue(value, fieldRef.field);

      return createCursor(fieldRef, valueAST);
    } catch (error) {
      if (error instanceof ParseError) {
        throw error;
      }
      throw new ParseError(
        `Failed to parse cursor field '${fieldName}': ${error}`,
        {
          model: model.name,
          field: fieldName,
        }
      );
    }
  }

  /**
   * Validates if a field can be used as a cursor field
   * Only orderable field types are valid for cursors
   */
  validateCursorField(field: FieldReference): boolean {
    // Define orderable types that can be used for cursor pagination
    const orderableTypes = [
      "string",
      "int",
      "bigInt",
      "float",
      "decimal",
      "dateTime",
    ];

    const fieldType = field.field["~fieldType"];
    return fieldType !== undefined && orderableTypes.includes(fieldType);
  }
}
