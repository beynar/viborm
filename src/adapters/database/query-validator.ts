import { Model } from "../../schema/model";
import { Operation } from "../../types/client/operations/defintion";
import { Field, Relation } from "../../schema";
import { QueryErrors } from "./query-errors";

// Re-export error classes for convenience
export { QueryParserError, ValidationError, QueryErrors } from "./query-errors";

// ================================
// Query Validator
// ================================

export class QueryValidator {
  // ================================
  // Operation Validation
  // ================================

  static validateOperation(operation: Operation): void {
    const validOperations: Operation[] = [
      "findMany",
      "findFirst",
      "findUnique",
      "findUniqueOrThrow",
      "findFirstOrThrow",
      "create",
      "createMany",
      "update",
      "updateMany",
      "delete",
      "deleteMany",
      "upsert",
      "count",
      "aggregate",
      "groupBy",
    ];

    if (!validOperations.includes(operation)) {
      QueryErrors.invalidOperation(operation);
    }
  }

  // ================================
  // Model Validation
  // ================================

  static validateModel(model: Model<any>): void {
    if (!model) {
      QueryErrors.modelRequired();
    }

    if (!model.name) {
      QueryErrors.modelMissingName(model);
    }

    if (!model.fields || model.fields.size === 0) {
      QueryErrors.modelNoFields(model.name);
    }
  }

  // ================================
  // Field Validation
  // ================================

  static validateField(model: Model<any>, fieldName: string): void {
    if (!model.fields.has(fieldName)) {
      const availableFields = Array.from(model.fields.keys());
      QueryErrors.fieldNotFound(model.name, fieldName, availableFields);
    }
  }

  // ================================
  // Relation Validation
  // ================================

  static validateRelation(model: Model<any>, relationName: string): void {
    if (!model.relations.has(relationName)) {
      const availableRelations = Array.from(model.relations.keys());
      QueryErrors.relationNotFound(
        model.name,
        relationName,
        availableRelations
      );
    }
  }

  // ================================
  // Payload Validation
  // ================================

  static validatePayload(operation: Operation, payload: any): void {
    if (!payload || typeof payload !== "object") {
      QueryErrors.payloadRequired(operation);
    }

    // Validate operation-specific requirements
    switch (operation) {
      case "create":
      case "createMany":
      case "update":
      case "updateMany":
      case "upsert":
        if (!payload.data) {
          QueryErrors.dataFieldRequired(operation);
        }
        break;

      case "findUnique":
      case "findUniqueOrThrow":
        if (!payload.where) {
          QueryErrors.whereFieldRequired(operation);
        }
        break;
    }

    // Validate createMany data is array
    if (operation === "createMany" && !Array.isArray(payload.data)) {
      QueryErrors.createManyDataMustBeArray();
    }
  }

  // ================================
  // Select Fields Validation
  // ================================

  static validateSelectFields(
    model: Model<any>,
    select: any,
    resolveRelationModel: (relation: Relation<any, any>) => Model<any>
  ): void {
    if (!select || typeof select !== "object") return;

    for (const [fieldName, value] of Object.entries(select)) {
      if (model.fields.has(fieldName)) {
        // Scalar field - value should be true
        if (value !== true) {
          QueryErrors.invalidScalarFieldSelect(fieldName, model.name);
        }
      } else if (model.relations.has(fieldName)) {
        // Relation field - value can be true or object with nested select
        if (value === true) {
          // Simple relation selection - valid
          continue;
        } else if (typeof value === "object" && value !== null) {
          // Nested relation selection - validate recursively
          const relation = model.relations.get(fieldName)!;
          const targetModel = resolveRelationModel(relation);
          const relationValue = value as any; // Cast to any to access nested properties

          // Validate nested select if present
          if (relationValue.select) {
            QueryValidator.validateSelectFields(
              targetModel,
              relationValue.select,
              resolveRelationModel
            );
          }

          // Validate nested include if present (relations can have both select and include)
          if (relationValue.include) {
            QueryValidator.validateIncludeFields(
              targetModel,
              relationValue.include
            );
          }

          // Validate nested where if present (relations can have where clauses)
          if (relationValue.where) {
            // We could add where validation here, but it would be complex
            // For now, we'll let the where validation happen in buildWhereStatement
          }
        } else {
          QueryErrors.invalidRelationSelect(fieldName, model.name);
        }
      } else {
        // Field/relation not found
        const availableFields = Array.from(model.fields.keys());
        const availableRelations = Array.from(model.relations.keys());
        const available = [...availableFields, ...availableRelations];
        QueryErrors.fieldOrRelationNotFound(fieldName, model.name, available);
      }
    }
  }

  // ================================
  // Include Fields Validation
  // ================================

  static validateIncludeFields(model: Model<any>, include: any): void {
    if (!include || typeof include !== "object") return;

    for (const relationName of Object.keys(include)) {
      QueryValidator.validateRelation(model, relationName);
    }
  }

  // ================================
  // Complete Validation Suite
  // ================================

  static validateQuery(
    operation: Operation,
    model: Model<any>,
    payload: any,
    resolveRelationModel: (relation: Relation<any, any>) => Model<any>
  ): void {
    // Validate inputs
    QueryValidator.validateOperation(operation);
    QueryValidator.validateModel(model);
    QueryValidator.validatePayload(operation, payload);

    // Additional validations for read operations
    if (
      [
        "findMany",
        "findFirst",
        "findUnique",
        "findUniqueOrThrow",
        "findFirstOrThrow",
      ].includes(operation)
    ) {
      if (payload.select) {
        QueryValidator.validateSelectFields(
          model,
          payload.select,
          resolveRelationModel
        );
      }
      if (payload.include) {
        QueryValidator.validateIncludeFields(model, payload.include);
      }
    }
  }
}
