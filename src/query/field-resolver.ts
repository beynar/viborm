// Field Resolver for BaseORM
// Handles field and relation path resolution within models

import {
  SchemaRegistry,
  FieldReference,
  RelationReference,
  ParseError,
} from "./ast";

export { ParseError };

// ================================
// Field Resolution
// ================================

export class FieldResolver {
  constructor(private registry: SchemaRegistry) {}

  /**
   * Resolves a field path like "user.profile.bio" to field/relation references
   */
  resolveFieldPath(
    modelName: string,
    fieldPath: string[]
  ): FieldReference | RelationReference {
    if (fieldPath.length === 0) {
      throw new ParseError("Empty field path", { model: modelName });
    }

    let currentModel = this.registry.getModel(modelName);
    if (!currentModel) {
      throw new ParseError(`Model '${modelName}' not found`, {
        model: modelName,
      });
    }

    // Navigate through relations if path has multiple parts
    for (let i = 0; i < fieldPath.length - 1; i++) {
      const relationName = fieldPath[i];
      if (!relationName) {
        throw new ParseError("Invalid field path with empty segment", {
          model: currentModel.name,
          path: fieldPath,
        });
      }

      const relation = currentModel.relations.get(relationName);

      if (!relation) {
        throw new ParseError(
          `Relation '${relationName}' not found in model '${currentModel.name}'`,
          { model: currentModel.name, field: relationName, path: fieldPath }
        );
      }

      currentModel = relation.targetModel;
      if (!currentModel) {
        throw new ParseError(
          `Target model for relation '${relationName}' is not available`,
          { field: relationName, path: fieldPath }
        );
      }
    }

    // Get final field or relation
    const finalName = fieldPath[fieldPath.length - 1];
    if (!finalName) {
      throw new ParseError("Invalid field path with empty final segment", {
        model: currentModel.name,
        path: fieldPath,
      });
    }

    // Try field first
    const field = currentModel.fields.get(finalName);
    if (field) {
      return this.registry.createFieldReference(currentModel.name, finalName);
    }

    // Try relation
    const relation = currentModel.relations.get(finalName);
    if (relation) {
      return this.registry.createRelationReference(
        currentModel.name,
        finalName
      );
    }

    throw new ParseError(
      `Field or relation '${finalName}' not found in model '${currentModel.name}'`,
      { model: currentModel.name, field: finalName, path: fieldPath }
    );
  }

  /**
   * Resolves a simple field name within a model
   */
  resolveField(modelName: string, fieldName: string): FieldReference {
    const field = this.registry.getField(modelName, fieldName);
    if (!field) {
      throw new ParseError(
        `Field '${fieldName}' not found in model '${modelName}'`,
        { model: modelName, field: fieldName }
      );
    }
    return this.registry.createFieldReference(modelName, fieldName);
  }

  /**
   * Resolves a relation name within a model
   */
  resolveRelation(modelName: string, relationName: string): RelationReference {
    const relation = this.registry.getRelation(modelName, relationName);
    if (!relation) {
      throw new ParseError(
        `Relation '${relationName}' not found in model '${modelName}'`,
        { model: modelName, field: relationName }
      );
    }
    return this.registry.createRelationReference(modelName, relationName);
  }
}
