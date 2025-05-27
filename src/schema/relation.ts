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

  constructor(public getter: G, relationType: T) {
    this.relationType = relationType;
  }

  /**
   * Gets the target model, resolving it lazily
   */
  get targetModel() {
    return this.getter();
  }

  // Field mapping
  on(fieldName: string): this {
    this.onField = fieldName;
    return this;
  }

  ref(fieldName: string): this {
    this.refField = fieldName;
    return this;
  }

  // Cascade options
  onDelete(options: CascadeOptions) {
    this.cascadeOptions = options;
    return this;
  }

  onUpdate(options: CascadeOptions) {
    this.cascadeOptions = options;
    return this as unknown as Relation<G, T>;
  }

  // Many-to-many junction table configuration
  junctionTable(tableName: string): this {
    if (this.relationType !== "manyToMany") {
      throw new Error(
        "Junction tables can only be configured for manyToMany relations"
      );
    }
    this.junctionTableName = tableName;
    return this;
  }

  junctionField(fieldName: string): this {
    if (this.relationType !== "manyToMany") {
      throw new Error(
        "Junction fields can only be configured for manyToMany relations"
      );
    }
    this.junctionFieldName = fieldName;
    return this;
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
// RELATION FACTORIES
// =============================================================================

/**
 * One-to-One relationship factory
 * Example: User has one Profile, Profile belongs to one User
 */
function oneToOne<G extends Getter>(getter: G): Relation<G, "oneToOne"> {
  return new Relation<G, "oneToOne">(getter, "oneToOne");
}

/**
 * One-to-Many relationship factory
 * Example: User has many Posts, Post belongs to one User
 */
function oneToMany<G extends Getter>(getter: G): Relation<G, "oneToMany"> {
  return new Relation<G, "oneToMany">(getter, "oneToMany");
}

/**
 * Many-to-One relationship factory
 * Example: Many Posts belong to one User, User has many Posts
 */
function manyToOne<G extends Getter>(getter: G): Relation<G, "manyToOne"> {
  return new Relation<G, "manyToOne">(getter, "manyToOne");
}

/**
 * Many-to-Many relationship factory
 * Example: Users have many Roles, Roles have many Users
 */
function manyToMany<G extends Getter>(getter: G): Relation<G, "manyToMany"> {
  return new Relation<G, "manyToMany">(getter, "manyToMany");
}

// Main relation factory object
export const relation = {
  oneToOne,
  oneToMany,
  manyToOne,
  manyToMany,
};

export type RelationFactory = typeof relation;

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
