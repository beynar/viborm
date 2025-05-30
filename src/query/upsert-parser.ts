// Upsert Parser for BaseORM
// Handles upsert operations with conflict resolution and converts them to AST

import {
  UpsertAST,
  ConflictTargetAST,
  ConflictTargetType,
  FieldConflictTarget,
  IndexConflictTarget,
  ConstraintConflictTarget,
  DataAST,
  ModelReference,
  FieldReference,
  ParseError,
  createUpsert,
  createConflictTarget,
  createFieldConflictTarget,
  createIndexConflictTarget,
  createConstraintConflictTarget,
} from "./ast";
import { DataParser } from "./data-parser";
import { FieldResolver } from "./field-resolver";

// ================================
// Upsert Parser
// ================================

export class UpsertParser {
  constructor(
    private dataParser: DataParser,
    private fieldResolver: FieldResolver
  ) {}

  /**
   * Parses upsert operations from Prisma-like syntax to AST
   */
  parseUpsert(upsert: any, model: ModelReference): UpsertAST {
    if (!upsert || typeof upsert !== "object") {
      throw new ParseError("Invalid upsert object", { model: model.name });
    }

    const { where, create, update, conflictTarget } = upsert;

    if (!create) {
      throw new ParseError("upsert.create is required", {
        model: model.name,
      });
    }

    if (!update) {
      throw new ParseError("upsert.update is required", {
        model: model.name,
      });
    }

    // Parse create and update data
    const createData = this.dataParser.parseData(create, model)[0];
    const updateData = this.dataParser.parseData(update, model)[0];

    if (!createData || !updateData) {
      throw new ParseError("Failed to parse upsert data", {
        model: model.name,
      });
    }

    // Parse conflict target
    const conflictTargetAST = this.parseConflictTarget(
      conflictTarget,
      model,
      createData
    );

    // Parse where conditions if provided
    let whereConditions: any = undefined;
    if (where) {
      // Where conditions would be parsed by FilterParser
      whereConditions = where;
    }

    return createUpsert(
      model,
      conflictTargetAST,
      createData,
      updateData,
      whereConditions
    );
  }

  /**
   * Parses conflict target for upsert operations
   */
  private parseConflictTarget(
    conflictTarget: any,
    model: ModelReference,
    createData: DataAST
  ): ConflictTargetAST {
    // If no explicit conflict target, try to infer from unique fields in createData
    if (!conflictTarget) {
      return this.inferConflictTarget(model, createData);
    }

    if (typeof conflictTarget === "string") {
      // Single field name
      try {
        const fieldRef = this.fieldResolver.resolveField(
          model.name,
          conflictTarget
        );
        const target = createFieldConflictTarget([fieldRef]);
        return createConflictTarget(target);
      } catch (error) {
        throw new ParseError(
          `Invalid conflict target field '${conflictTarget}': ${error}`,
          { model: model.name, field: conflictTarget }
        );
      }
    }

    if (Array.isArray(conflictTarget)) {
      // Multiple field names
      const fieldRefs: FieldReference[] = [];
      for (const fieldName of conflictTarget) {
        if (typeof fieldName !== "string") {
          throw new ParseError("Conflict target field names must be strings", {
            model: model.name,
          });
        }
        try {
          const fieldRef = this.fieldResolver.resolveField(
            model.name,
            fieldName
          );
          fieldRefs.push(fieldRef);
        } catch (error) {
          throw new ParseError(
            `Invalid conflict target field '${fieldName}': ${error}`,
            { model: model.name, field: fieldName }
          );
        }
      }
      const target = createFieldConflictTarget(fieldRefs);
      return createConflictTarget(target);
    }

    if (typeof conflictTarget === "object") {
      if (conflictTarget.fields) {
        // Explicit field specification
        return this.parseConflictTarget(
          conflictTarget.fields,
          model,
          createData
        );
      }

      if (conflictTarget.index) {
        // Index-based conflict target
        const target = createIndexConflictTarget(conflictTarget.index);
        return createConflictTarget(target);
      }

      if (conflictTarget.constraint) {
        // Constraint-based conflict target
        const target = createConstraintConflictTarget(
          conflictTarget.constraint
        );
        return createConflictTarget(target);
      }
    }

    throw new ParseError("Invalid conflict target specification", {
      model: model.name,
    });
  }

  /**
   * Infers conflict target from model schema and create data
   */
  private inferConflictTarget(
    model: ModelReference,
    createData: DataAST
  ): ConflictTargetAST {
    // Look for unique fields in the model and create data
    const uniqueFields: FieldReference[] = [];

    // Check each field in create data to see if it's unique
    for (const field of createData.fields) {
      if (field.target.type === "FIELD") {
        const fieldRef = field.target.field;

        // Check if field has unique constraint or is ID field
        // This would need to be enhanced with actual field metadata
        const fieldMeta = fieldRef.field as any;
        if (fieldMeta["~isUnique"] || fieldMeta["~isId"]) {
          uniqueFields.push(fieldRef);
        }
      }
    }

    if (uniqueFields.length === 0) {
      throw new ParseError(
        "No conflict target specified and no unique fields found for upsert",
        { model: model.name }
      );
    }

    // Use the first unique field found, or ID field if present
    const idField = uniqueFields.find((field) => {
      const fieldMeta = field.field as any;
      return fieldMeta["~isId"];
    });

    const targetField = idField || uniqueFields[0];
    const target = createFieldConflictTarget([targetField!]);
    return createConflictTarget(target);
  }
}
