// Relation Class Implementation
// Based on specification: readme/1.4_relation_class.md

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
  public relationType?: RelationType | undefined;
  // private _targetModel: M | undefined = undefined;
  // private _resolved = false;
  public onField?: string | undefined;
  public refField?: string | undefined;
  public cascadeOptions?: CascadeOptions | undefined;
  public junctionTableName?: string | undefined;
  public junctionFieldName?: string | undefined;

  constructor(public getter: G, relationType: T) {
    this.relationType = relationType;
  }

  /**
   * Gets the target model, resolving it lazily if not already resolved
   */
  // get targetModel(): M {
  //   if (!this._resolved) {
  //     const target = this.targetGetter();
  //     this._targetModel = Array.isArray(target) ? target[0] : target;
  //     this._resolved = true;
  //   }
  //   return this._targetModel as M;
  // }

  /**
   * Resets the lazy relation, forcing re-resolution on next access
   */
  // reset(): void {
  //   this._resolved = false;
  //   this._targetModel = undefined;
  // }

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
  onDelete(options: CascadeOptions): this {
    this.cascadeOptions = options;
    return this;
  }

  onUpdate(options: CascadeOptions): this {
    this.cascadeOptions = options;
    return this;
  }

  // Many-to-many junction table configuration
  junctionTable(tableName: string): this {
    this.junctionTableName = tableName;
    return this;
  }

  junctionField(fieldName: string): this {
    this.junctionFieldName = fieldName;
    return this;
  }

  // For "one" relations, transform to "many"
  many(): Relation<G, "many"> {
    return new Relation(this.getter, "many");
  }

  get infer() {
    return {} as G extends () => infer M
      ? M extends Model<any>
        ? T extends "many"
          ? M["infer"][]
          : M["infer"]
        : never
      : never;
  }
}

// =============================================================================
// RELATION FACTORIES
// =============================================================================

/**
 * Main relation factory for "one" relationship
 */
function relationFactory<G extends Getter>(getter: G): Relation<G, "one"> {
  return new Relation<G, "one">(getter, "one");
}

/**
 * Factory specifically for "many" relationships
 */
relationFactory.many = <G extends Getter>(getter: G): Relation<G, "many"> => {
  return new Relation<G, "many">(getter, "many");
};

// Define the type for the relation factory

export const relation = {
  one: relationFactory,
  many: relationFactory.many,
};
export type RelationFactory = typeof relation;

// =============================================================================
// LAZY EVALUATION HELPERS
// =============================================================================

/**
 * Helper function to create a lazy relation with explicit typing
 * This helps TypeScript with recursive schema inference
 */
export function lazy<T extends Model<any>>(
  getter: () => T
): Relation<() => T, "one"> {
  return new Relation<() => T, "one">(getter, "one");
}

/**
 * Helper function to create a lazy "many" relation with explicit typing
 */
lazy.many = <T extends Model<any>>(
  getter: () => T
): Relation<() => T, "many"> => {
  return new Relation<() => T, "many">(getter, "many");
};

// Define the type for the lazy factory
export type LazyFactory = typeof lazy;
