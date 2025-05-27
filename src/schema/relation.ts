// Relation Class Implementation
// Based on specification: readme/1.4_relation_class.md
// Updated to support standard relational database relationship types

import type {
  RelationType,
  CascadeOptions,
  RelationValidator,
  ValidationResult,
} from "../types/index.js";
import { Model } from "./model.js";

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
  public relationType: RelationType;
  public onField?: string | undefined;
  public refField?: string | undefined;
  public cascadeOptions?: CascadeOptions | undefined;
  public junctionTableName?: string | undefined;
  public junctionFieldName?: string | undefined;

  constructor(public getter: G, relationType: T, options?: RelationOptions) {
    this.relationType = relationType;

    // Apply options if provided
    if (options) {
      this.cascadeOptions = options.onDelete || options.onUpdate;
      this.onField = options.onField;
      this.refField = options.refField;
      this.junctionTableName = options.junctionTable;
      this.junctionFieldName = options.junctionField;
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
          ? M["infer"][]
          : M["infer"]
        : never
      : never;
  }

  /**
   * Check if this is a "to-many" relationship
   */
  get isToMany(): boolean {
    return (
      this.relationType === "oneToMany" || this.relationType === "manyToMany"
    );
  }

  /**
   * Check if this is a "to-one" relationship
   */
  get isToOne(): boolean {
    return (
      this.relationType === "oneToOne" || this.relationType === "manyToOne"
    );
  }

  /**
   * Check if this requires a junction table
   */
  get requiresJunctionTable(): boolean {
    return this.relationType === "manyToMany";
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
export function lazy<T extends Model<any>>(
  getter: () => T
): Relation<() => T, "oneToOne"> {
  return new Relation<() => T, "oneToOne">(getter, "oneToOne");
}

/**
 * Helper functions for all relation types
 */
lazy.oneToOne = <T extends Model<any>>(
  getter: () => T
): Relation<() => T, "oneToOne"> => {
  return new Relation<() => T, "oneToOne">(getter, "oneToOne");
};

lazy.oneToMany = <T extends Model<any>>(
  getter: () => T
): Relation<() => T, "oneToMany"> => {
  return new Relation<() => T, "oneToMany">(getter, "oneToMany");
};

lazy.manyToOne = <T extends Model<any>>(
  getter: () => T
): Relation<() => T, "manyToOne"> => {
  return new Relation<() => T, "manyToOne">(getter, "manyToOne");
};

lazy.manyToMany = <T extends Model<any>>(
  getter: () => T
): Relation<() => T, "manyToMany"> => {
  return new Relation<() => T, "manyToMany">(getter, "manyToMany");
};

// Legacy aliases
lazy.one = lazy.manyToOne;
lazy.many = lazy.oneToMany;

// Define the type for the lazy factory
export type LazyFactory = typeof lazy;
