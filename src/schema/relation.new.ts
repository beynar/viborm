// New Relation Factory Implementation
// Callback-based relation factory for BaseORM

import type {
  RelationType,
  CascadeOptions,
  RelationValidator,
  ValidationResult,
} from "../types/index.js";
import { Model } from "./model.js";

export type Getter = () => Model<any>;

// The new Relation class that accepts models directly
export class RelationNew<
  M extends Model<any> = Model<any>,
  T extends RelationType = RelationType
> {
  public relationType: RelationType;
  public onField?: string | undefined;
  public refField?: string | undefined;
  public cascadeOptions?: CascadeOptions | undefined;
  public junctionTableName?: string | undefined;
  public junctionFieldName?: string | undefined;

  constructor(public targetModel: M, relationType: T) {
    this.relationType = relationType;
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
    return this as unknown as RelationNew<M, T>;
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
    return {} as T extends "oneToMany" | "manyToMany"
      ? M["infer"][]
      : M["infer"];
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
// NEW CALLBACK-BASED RELATION BUILDER
// =============================================================================

/**
 * Relation builder that contains all relation type methods
 */
export class RelationBuilder {
  /**
   * One-to-One relationship factory
   */
  oneToOne<M extends Model<any>>(model: M): RelationNew<M, "oneToOne"> {
    return new RelationNew<M, "oneToOne">(model, "oneToOne");
  }

  /**
   * One-to-Many relationship factory
   */
  oneToMany<M extends Model<any>>(model: M): RelationNew<M, "oneToMany"> {
    return new RelationNew<M, "oneToMany">(model, "oneToMany");
  }

  /**
   * Many-to-One relationship factory
   */
  manyToOne<M extends Model<any>>(model: M): RelationNew<M, "manyToOne"> {
    return new RelationNew<M, "manyToOne">(model, "manyToOne");
  }

  /**
   * Many-to-Many relationship factory
   */
  manyToMany<M extends Model<any>>(model: M): RelationNew<M, "manyToMany"> {
    return new RelationNew<M, "manyToMany">(model, "manyToMany");
  }
}

// Create a single instance of the relation builder
const relationBuilder = new RelationBuilder();

export function relationNew<T extends RelationNew<any, any>>(
  callback: (builder: RelationBuilder) => T
): T {
  return callback(relationBuilder);
}

// Type for the new relation factory
export type NewRelationFactory = typeof relationNew;
