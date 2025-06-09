// Relation Class Implementation
// Based on specification: readme/1.4_relation_class.md
// Updated to support standard relational database relationship types

import { Model } from "../model";
import { Simplify } from "../../types/utilities.js";
export type Getter = () => Model<any>;

// Relation options interface
export interface RelationOptions {
  onDelete?: CascadeOptions;
  onUpdate?: CascadeOptions;
  onField?: string;
  refField?: string;
  junctionTable?: string;
  junctionField?: string;
}

export class Relation<
  G extends Getter = Getter,
  T extends RelationType = RelationType
> {
  public "~relationType": RelationType;
  public "~onField"?: string | undefined;
  public "~refField"?: string | undefined;
  public "~cascadeOptions"?: CascadeOptions | undefined;
  public "~junctionTableName"?: string | undefined;
  public "~junctionFieldName"?: string | undefined;

  constructor(public getter: G, relationType: T, options?: RelationOptions) {
    this["~relationType"] = relationType;

    // Apply options if provided
    if (options) {
      this["~cascadeOptions"] = options.onDelete || options.onUpdate;
      this["~onField"] = options.onField;
      this["~refField"] = options.refField;
      this["~junctionTableName"] = options.junctionTable;
      this["~junctionFieldName"] = options.junctionField;
    }
  }

  /**
   * Gets the target model, resolving it lazily
   */
  get targetModel() {
    return this.getter();
  }

  /**
   * Type inference for relation return types
   */
  get infer() {
    return {} as G extends () => infer M
      ? M extends Model<any>
        ? T extends "oneToMany" | "manyToMany"
          ? Simplify<M["infer"]>[]
          : Simplify<M["infer"]>
        : never
      : never;
  }

  /**
   * Check if this is a "to-many" relationship
   */
  get "~isToMany"(): boolean {
    return (
      this["~relationType"] === "oneToMany" ||
      this["~relationType"] === "manyToMany"
    );
  }

  /**
   * Check if this is a "to-one" relationship
   */
  get "~isToOne"(): boolean {
    return (
      this["~relationType"] === "oneToOne" ||
      this["~relationType"] === "manyToOne"
    );
  }

  /**
   * Check if this requires a junction table
   */
  get "~requiresJunctionTable"(): boolean {
    return this["~relationType"] === "manyToMany";
  }
}

// =============================================================================
// RELATION FACTORY WITH OPTIONS
// =============================================================================

/**
 * Relation factory that accepts options and returns relation type methods
 */
export class RelationFactory {
  constructor(private options?: RelationOptions) {}

  /**
   * One-to-One relationship factory
   */
  oneToOne<G extends Getter>(getter: G): Relation<G, "oneToOne"> {
    return new Relation<G, "oneToOne">(getter, "oneToOne", this.options);
  }

  /**
   * One-to-Many relationship factory
   */
  oneToMany<G extends Getter>(getter: G): Relation<G, "oneToMany"> {
    return new Relation<G, "oneToMany">(getter, "oneToMany", this.options);
  }

  /**
   * Many-to-One relationship factory
   */
  manyToOne<G extends Getter>(getter: G): Relation<G, "manyToOne"> {
    return new Relation<G, "manyToOne">(getter, "manyToOne", this.options);
  }

  /**
   * Many-to-Many relationship factory
   */
  manyToMany<G extends Getter>(getter: G): Relation<G, "manyToMany"> {
    return new Relation<G, "manyToMany">(getter, "manyToMany", this.options);
  }
}

// Main relation factory function - accepts options and returns RelationFactory instance
export function relation(options?: RelationOptions): RelationFactory {
  return new RelationFactory(options);
}

// Attach direct methods to the relation function for convenience
// This allows both s.relation().oneToOne() and s.relation.oneToOne()
relation.oneToOne = <G extends Getter>(getter: G): Relation<G, "oneToOne"> => {
  return new Relation<G, "oneToOne">(getter, "oneToOne");
};

relation.oneToMany = <G extends Getter>(
  getter: G
): Relation<G, "oneToMany"> => {
  return new Relation<G, "oneToMany">(getter, "oneToMany");
};

relation.manyToOne = <G extends Getter>(
  getter: G
): Relation<G, "manyToOne"> => {
  return new Relation<G, "manyToOne">(getter, "manyToOne");
};

relation.manyToMany = <G extends Getter>(
  getter: G
): Relation<G, "manyToMany"> => {
  return new Relation<G, "manyToMany">(getter, "manyToMany");
};

// =============================================================================
// LAZY EVALUATION HELPERS
// =============================================================================

/**
 * Helper function to create a lazy one-to-one relation
 */

/**
 * Generates a standard junction table name for Many-to-Many relations
 * Format: {model1}_{model2} (alphabetical order, lowercase, underscore-separated)
 */
export function generateJunctionTableName(
  model1Name: string,
  model2Name: string
): string {
  const names = [model1Name.toLowerCase(), model2Name.toLowerCase()].sort();
  return `${names[0]}_${names[1]}`;
}

/**
 * Generates a standard junction field name
 * Format: {modelName}Id (camelCase with "Id" suffix)
 */
export function generateJunctionFieldName(modelName: string): string {
  return `${modelName.toLowerCase()}Id`;
}

/**
 * Gets the junction table name for a Many-to-Many relation
 * Uses explicitly provided junction table name
 */
export function getJunctionTableName(
  relation: Relation<any, any>,
  sourceModelName: string,
  targetModelName: string
): string {
  // Use explicitly provided junction table name
  if (relation["~junctionTableName"]) {
    return relation["~junctionTableName"];
  }

  // Generate standard junction table name
  return generateJunctionTableName(sourceModelName, targetModelName);
}

/**
 * Gets the junction field names for a Many-to-Many relation
 * Returns [sourceFieldName, targetFieldName]
 */
export function getJunctionFieldNames(
  relation: Relation<any, any>,
  sourceModelName: string,
  targetModelName: string
): [string, string] {
  // Generate the default field name for the source model (linking back to the current model)
  const sourceFieldName = generateJunctionFieldName(sourceModelName);

  // Use explicitly provided junction field name for target, or generate default
  // The junctionField in relation config refers to the field that points to the target model
  const targetFieldName =
    relation["~junctionFieldName"] ||
    generateJunctionFieldName(targetModelName);

  return [sourceFieldName, targetFieldName];
}

export type RelationType =
  | "oneToOne"
  | "oneToMany"
  | "manyToOne"
  | "manyToMany";

// Cascade options for relations
export type CascadeOptions = "CASCADE" | "SET NULL" | "RESTRICT" | "NO ACTION";
