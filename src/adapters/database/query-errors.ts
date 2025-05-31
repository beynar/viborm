import { Operation } from "../../types/client/operations/defintion";
import { Model } from "../../schema/model";

// ================================
// Base Error Classes
// ================================

export class QueryParserError extends Error {
  constructor(
    message: string,
    public context?: {
      operation?: Operation;
      model?: string;
      field?: string;
      relation?: string;
      payload?: any;
    }
  ) {
    super(message);
    this.name = "QueryParserError";
  }
}

export class ValidationError extends QueryParserError {
  constructor(message: string, context?: QueryParserError["context"]) {
    super(message, context);
    this.name = "ValidationError";
  }
}

// ================================
// Error Factory
// ================================

export class QueryErrors {
  // ================================
  // Operation Errors
  // ================================

  static invalidOperation(operation: string): never {
    throw new ValidationError(`Invalid operation: ${operation}`, {
      operation: operation as Operation,
    });
  }

  // ================================
  // Model Errors
  // ================================

  static modelRequired(): never {
    throw new ValidationError("Model is required");
  }

  static modelMissingName(model?: Model<any>): never {
    throw new ValidationError("Model must have a name", {
      ...(model?.name && { model: model.name }),
    });
  }

  static modelNoFields(modelName: string): never {
    throw new ValidationError(`Model '${modelName}' has no fields`, {
      model: modelName,
    });
  }

  // ================================
  // Field Errors
  // ================================

  static fieldNotFound(
    modelName: string,
    fieldName: string,
    availableFields: string[]
  ): never {
    const available = availableFields.join(", ");
    throw new ValidationError(
      `Field '${fieldName}' not found on model '${modelName}'. Available fields: ${available}`,
      { model: modelName, field: fieldName }
    );
  }

  static invalidScalarFieldSelect(fieldName: string, modelName: string): never {
    throw new ValidationError(
      `Scalar field '${fieldName}' in select must have value 'true'`,
      { model: modelName, field: fieldName }
    );
  }

  // ================================
  // Relation Errors
  // ================================

  static relationNotFound(
    modelName: string,
    relationName: string,
    availableRelations: string[]
  ): never {
    const available = availableRelations.join(", ");
    throw new ValidationError(
      `Relation '${relationName}' not found on model '${modelName}'. Available relations: ${available}`,
      { model: modelName, relation: relationName }
    );
  }

  static invalidRelationSelect(relationName: string, modelName: string): never {
    throw new ValidationError(
      `Relation '${relationName}' in select must be 'true' or an object with select/include properties`,
      { model: modelName, relation: relationName }
    );
  }

  static fieldOrRelationNotFound(
    fieldName: string,
    modelName: string,
    available: string[]
  ): never {
    const availableStr = available.join(", ");
    throw new ValidationError(
      `Field or relation '${fieldName}' not found on model '${modelName}' in select clause. Available: ${availableStr}`,
      { model: modelName, field: fieldName }
    );
  }

  // ================================
  // Payload Errors
  // ================================

  static payloadRequired(operation: Operation): never {
    throw new ValidationError(
      `Payload is required for operation '${operation}'`,
      { operation }
    );
  }

  static dataFieldRequired(operation: Operation): never {
    throw new ValidationError(
      `Operation '${operation}' requires 'data' field`,
      { operation }
    );
  }

  static whereFieldRequired(operation: Operation): never {
    throw new ValidationError(
      `Operation '${operation}' requires 'where' field`,
      { operation }
    );
  }

  static createManyDataMustBeArray(): never {
    throw new ValidationError(
      "createMany operation requires 'data' to be an array",
      { operation: "createMany" }
    );
  }

  // ================================
  // Query Building Errors
  // ================================

  static queryBuildFailed(
    operation: Operation,
    modelName: string,
    error: string
  ): never {
    throw new QueryParserError(`Failed to build ${operation} query: ${error}`, {
      operation,
      model: modelName,
    });
  }

  static whereStatementFailed(modelName: string, error: string): never {
    throw new QueryParserError(`Failed to build where statement: ${error}`, {
      model: modelName,
    });
  }

  static orderByStatementFailed(modelName: string, error: string): never {
    throw new QueryParserError(`Failed to build order by statement: ${error}`, {
      model: modelName,
    });
  }

  static fieldConditionFailed(
    fieldName: string,
    modelName: string,
    error: string
  ): never {
    throw new QueryParserError(
      `Failed to build field condition for '${fieldName}': ${error}`,
      { model: modelName, field: fieldName }
    );
  }

  static relationConditionFailed(
    relationName: string,
    modelName: string,
    error: string
  ): never {
    throw new QueryParserError(
      `Failed to build relation condition for '${relationName}': ${error}`,
      { model: modelName, relation: relationName }
    );
  }

  static logicalConditionFailed(
    operator: string,
    modelName: string,
    error: string
  ): never {
    throw new QueryParserError(
      `Failed to build logical condition '${operator}': ${error}`,
      { model: modelName }
    );
  }

  static abstractConditionFailed(
    fieldName: string,
    modelName: string,
    error: string
  ): never {
    throw new QueryParserError(
      `Failed to handle abstract condition '${fieldName}': ${error}`,
      { model: modelName, field: fieldName }
    );
  }

  static relationSubqueryFailed(
    relationName: string,
    modelName: string,
    error: string
  ): never {
    throw new QueryParserError(
      `Failed to build relation subquery for '${relationName}': ${error}`,
      { model: modelName, relation: relationName }
    );
  }

  // ================================
  // Filter Errors
  // ================================

  static filterConditionInvalid(fieldName: string, modelName: string): never {
    throw new ValidationError(
      `Field filter condition for '${fieldName}' must be an object`,
      { model: modelName, field: fieldName }
    );
  }

  static filterOperationInvalid(fieldName: string, modelName: string): never {
    throw new ValidationError(
      `Field filter condition for '${fieldName}' must have exactly one operation`,
      { model: modelName, field: fieldName }
    );
  }

  static filterGroupNotFound(
    fieldType: string,
    fieldName: string,
    modelName: string
  ): never {
    throw new ValidationError(
      `No filter group found for field type '${fieldType}'`,
      { model: modelName, field: fieldName }
    );
  }

  static filterOperationUnsupported(
    operation: string,
    fieldType: string,
    fieldName: string,
    modelName: string,
    availableOps: string[]
  ): never {
    const available = availableOps.join(", ");
    throw new ValidationError(
      `Unsupported filter operation '${operation}' for field type '${fieldType}'. Available operations: ${available}`,
      { model: modelName, field: fieldName }
    );
  }

  static filterApplicationFailed(
    fieldName: string,
    modelName: string,
    error: string
  ): never {
    throw new QueryParserError(`Failed to apply field filter: ${error}`, {
      model: modelName,
      field: fieldName,
    });
  }

  // ================================
  // Validation Errors
  // ================================

  static invalidOrderDirection(
    direction: string,
    fieldName: string,
    modelName: string
  ): never {
    throw new ValidationError(
      `Invalid order direction '${direction}'. Must be 'asc' or 'desc'`,
      { model: modelName, field: fieldName }
    );
  }

  static logicalOperatorRequiresConditions(
    operator: string,
    modelName: string
  ): never {
    throw new ValidationError(
      `Logical operator '${operator}' requires array or object conditions`,
      { model: modelName }
    );
  }

  static logicalOperatorNeedsAtLeastOne(
    operator: string,
    modelName: string
  ): never {
    throw new ValidationError(
      `Logical operator '${operator}' requires at least one condition`,
      { model: modelName }
    );
  }

  static notOperatorNeedsCondition(): never {
    throw new ValidationError("NOT operator requires at least one condition");
  }

  static unsupportedLogicalOperator(operator: string): never {
    throw new ValidationError(`Unsupported logical operator: ${operator}`);
  }

  static unknownAbstractCondition(fieldName: string, modelName: string): never {
    throw new ValidationError(`Unknown abstract condition: ${fieldName}`, {
      model: modelName,
      field: fieldName,
    });
  }

  // ================================
  // Relation Link Errors
  // ================================

  static relationLinkGenerationFailed(relationType: string): never {
    throw new ValidationError(
      `Unable to generate relation link SQL for relation type: ${relationType}. Missing onField or refField.`
    );
  }

  static invalidParentRef(condition: any): never {
    throw new ValidationError(
      `Invalid _parentRef condition. Expected format: "alias.field", got: ${condition}`
    );
  }

  // ================================
  // Model Resolution Errors
  // ================================

  static relationModelNotFound(): never {
    throw new ValidationError("Relation target model not found", {
      model: "unknown",
    });
  }

  static relationModelResolutionFailed(error: string): never {
    throw new QueryParserError(`Failed to resolve relation model: ${error}`, {
      model: "unknown",
    });
  }

  // ================================
  // Generic Errors
  // ================================

  static unexpectedParsingError(
    operation: Operation,
    modelName: string,
    error: string
  ): never {
    throw new QueryParserError(
      `Unexpected error during query parsing: ${error}`,
      { operation, model: modelName }
    );
  }

  static invalidRelationArguments(
    relationName: string,
    modelName: string
  ): never {
    throw new ValidationError(
      `Invalid relation arguments for '${relationName}'. Must be true or object with select/include properties`,
      { model: modelName, relation: relationName }
    );
  }

  static invalidRelationFilterFormat(
    modelName: string,
    relationName: string
  ): never {
    throw new ValidationError("Invalid relation filter condition format", {
      model: modelName,
      relation: relationName,
    });
  }
}
