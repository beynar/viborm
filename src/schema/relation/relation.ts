// Relation Class Implementation
// Based on specification: readme/1.4_relation_class.md
// Updated to support standard relational database relationship types

import { Model } from "../model";
import { Simplify } from "../../types/utilities.js";

export type Getter = () => Model<any>;

// =============================================================================
// RELATION CONFIG INTERFACE
// =============================================================================

export type RelationType =
  | "oneToOne"
  | "oneToMany"
  | "manyToOne"
  | "manyToMany";

export type CascadeOptions = "CASCADE" | "SET NULL" | "RESTRICT" | "NO ACTION";

/**
 * Configuration interface for relations
 * Using `| undefined` for exactOptionalPropertyTypes compatibility
 */
export interface RelationConfig {
  relationType: RelationType;
  isOptional?: boolean | undefined;
  onField?: string | undefined;
  refField?: string | undefined;
  cascadeOptions?: CascadeOptions | undefined;
  junctionTable?: string | undefined;
  junctionField?: string | undefined;
}

/**
 * Internal methods and computed properties for relations
 */
export interface RelationInternals<
  G extends Getter,
  T extends RelationType,
  TOptional extends boolean = false
> {
  readonly isToMany: boolean;
  readonly isToOne: boolean;
  readonly isOptional: TOptional;
  readonly requiresJunctionTable: boolean;
  readonly infer: G extends () => infer M
    ? M extends Model<any>
      ? T extends "oneToMany" | "manyToMany"
        ? Simplify<M["infer"]>[]
        : TOptional extends true
        ? Simplify<M["infer"]> | null
        : Simplify<M["infer"]>
      : never
    : never;
}

// =============================================================================
// RELATION CLASS
// =============================================================================

export class Relation<
  G extends Getter = Getter,
  T extends RelationType = RelationType,
  TOptional extends boolean = false
> {
  readonly config: RelationConfig;
  readonly "~": RelationInternals<G, T, TOptional>;

  constructor(
    public getter: G,
    relationType: T,
    options?: Partial<Omit<RelationConfig, "relationType">>
  ) {
    this.config = {
      relationType,
      isOptional: options?.isOptional,
      onField: options?.onField,
      refField: options?.refField,
      cascadeOptions: options?.cascadeOptions,
      junctionTable: options?.junctionTable,
      junctionField: options?.junctionField,
    };

    // Initialize internals
    const self = this;
    this["~"] = {
      get isToMany() {
        return (
          self.config.relationType === "oneToMany" ||
          self.config.relationType === "manyToMany"
        );
      },
      get isToOne() {
        return (
          self.config.relationType === "oneToOne" ||
          self.config.relationType === "manyToOne"
        );
      },
      get isOptional() {
        return (self.config.isOptional ?? false) as TOptional;
      },
      get requiresJunctionTable() {
        return self.config.relationType === "manyToMany";
      },
      get infer() {
        return {} as any;
      },
    };
  }

  /**
   * Gets the target model, resolving it lazily
   */
  get targetModel() {
    return this.getter();
  }

  /**
   * Marks this relation as optional
   * Optional relations allow disconnect/delete operations
   */
  optional(): Relation<G, T, true> {
    return new Relation<G, T, true>(
      this.getter,
      this.config.relationType as T,
      {
        ...this.config,
        isOptional: true,
      }
    );
  }
}

// =============================================================================
// RELATION OPTIONS INTERFACE (for factory functions)
// =============================================================================

export interface RelationOptions {
  onDelete?: CascadeOptions;
  onUpdate?: CascadeOptions;
  onField?: string;
  refField?: string;
  junctionTable?: string;
  junctionField?: string;
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
    return new Relation<G, "oneToOne">(getter, "oneToOne", {
      cascadeOptions: this.options?.onDelete || this.options?.onUpdate,
      onField: this.options?.onField,
      refField: this.options?.refField,
      junctionTable: this.options?.junctionTable,
      junctionField: this.options?.junctionField,
    });
  }

  /**
   * One-to-Many relationship factory
   */
  oneToMany<G extends Getter>(getter: G): Relation<G, "oneToMany"> {
    return new Relation<G, "oneToMany">(getter, "oneToMany", {
      cascadeOptions: this.options?.onDelete || this.options?.onUpdate,
      onField: this.options?.onField,
      refField: this.options?.refField,
      junctionTable: this.options?.junctionTable,
      junctionField: this.options?.junctionField,
    });
  }

  /**
   * Many-to-One relationship factory
   */
  manyToOne<G extends Getter>(getter: G): Relation<G, "manyToOne"> {
    return new Relation<G, "manyToOne">(getter, "manyToOne", {
      cascadeOptions: this.options?.onDelete || this.options?.onUpdate,
      onField: this.options?.onField,
      refField: this.options?.refField,
      junctionTable: this.options?.junctionTable,
      junctionField: this.options?.junctionField,
    });
  }

  /**
   * Many-to-Many relationship factory
   */
  manyToMany<G extends Getter>(getter: G): Relation<G, "manyToMany"> {
    return new Relation<G, "manyToMany">(getter, "manyToMany", {
      cascadeOptions: this.options?.onDelete || this.options?.onUpdate,
      onField: this.options?.onField,
      refField: this.options?.refField,
      junctionTable: this.options?.junctionTable,
      junctionField: this.options?.junctionField,
    });
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
  if (relation.config.junctionTable) {
    return relation.config.junctionTable;
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
    relation.config.junctionField || generateJunctionFieldName(targetModelName);

  return [sourceFieldName, targetFieldName];
}
