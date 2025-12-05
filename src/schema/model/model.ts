// Model Class Implementation
// Defines database models with fields and relations

import { isField, type Field } from "../fields/base";
import { Relation } from "../relation/relation";
import { buildModelSchemas, type TypedModelSchemas } from "./runtime";
import { ScalarFieldKeys } from "./types";

// =============================================================================
// TYPE INFERENCE HELPER
// =============================================================================

/**
 * Infers the TypeScript types for model fields
 * Only includes scalar fields, not relations
 */
type InferModelFields<
  TFields extends Record<string, Field | Relation<any, any>>
> = {
  [K in keyof TFields as TFields[K] extends Field
    ? K
    : never]: TFields[K] extends Field
    ? TFields[K]["~"]["schemas"]["base"]["infer"]
    : never;
};

// =============================================================================
// INDEX AND CONSTRAINT TYPES
// =============================================================================

export type IndexType = "btree" | "hash" | "gin" | "gist";

export interface IndexOptions {
  name?: string;
  unique?: boolean;
  type?: IndexType;
  where?: string; // For partial indexes (PostgreSQL)
}

export interface IndexDefinition {
  fields: string[];
  options: IndexOptions;
}

export interface UniqueConstraintOptions {
  name?: string;
}

export interface UniqueConstraintDefinition {
  fields: string[];
  options: UniqueConstraintOptions;
}

// =============================================================================
// MODEL CLASS
// =============================================================================

export class Model<
  TFields extends Record<string, Field | Relation<any, any>> = {}
> {
  public readonly fields: Map<string, Field> = new Map();
  public readonly relations: Map<string, Relation<any, any>> = new Map();
  /** The table name in the database (set via .map()) */
  public tableName?: string;
  public readonly indexes: IndexDefinition[] = [];
  public readonly uniqueConstraints: UniqueConstraintDefinition[] = [];

  private _schemas?: TypedModelSchemas<TFields>;

  constructor(private fieldDefinitions: TFields) {
    this.separateFieldsAndRelations(fieldDefinitions);
  }

  /**
   * Gets the model name (for display/error messages)
   * Returns tableName if set, otherwise "Model"
   */
  get name(): string {
    return this.tableName ?? "Model";
  }

  private separateFieldsAndRelations(definitions: TFields): void {
    for (const [key, definition] of Object.entries(definitions)) {
      if (isField(definition)) {
        this.fields.set(key, definition as Field);
      } else if (definition instanceof Relation) {
        this.relations.set(key, definition);
      } else {
        throw new Error(
          `Invalid field definition for '${key}'. Must be a Field or Relation instance.`
        );
      }
    }
  }

  // ===========================================================================
  // TABLE MAPPING
  // ===========================================================================

  /**
   * Maps the model to a specific database table name
   */
  map(tableName: string): this {
    if (
      !tableName ||
      typeof tableName !== "string" ||
      tableName.trim() === ""
    ) {
      throw new Error("Table name must be a non-empty string");
    }
    this.tableName = tableName;
    return this;
  }

  // ===========================================================================
  // INDEX MANAGEMENT
  // ===========================================================================

  /**
   * Adds an index on the specified field(s)
   */
  index(
    fields: ScalarFieldKeys<TFields> | ScalarFieldKeys<TFields>[],
    options: IndexOptions = {}
  ): this {
    const fieldArray = Array.isArray(fields) ? fields : [fields];

    // Validate all fields exist
    for (const field of fieldArray) {
      if (!this.fields.has(String(field))) {
        const availableFields = Array.from(this.fields.keys());
        throw new Error(
          `Field '${String(
            field
          )}' does not exist in model. Available fields: ${availableFields.join(
            ", "
          )}`
        );
      }
    }

    this.indexes.push({
      fields: fieldArray.map(String),
      options,
    });

    return this;
  }

  // ===========================================================================
  // UNIQUE CONSTRAINTS
  // ===========================================================================

  /**
   * Adds a unique constraint on the specified field(s)
   */
  unique(
    fields: ScalarFieldKeys<TFields> | ScalarFieldKeys<TFields>[],
    options: UniqueConstraintOptions = {}
  ): this {
    const fieldArray = Array.isArray(fields) ? fields : [fields];

    // Validate all fields exist
    for (const field of fieldArray) {
      if (!this.fields.has(String(field))) {
        const availableFields = Array.from(this.fields.keys());
        throw new Error(
          `Field '${String(
            field
          )}' does not exist in model. Available fields: ${availableFields.join(
            ", "
          )}`
        );
      }
    }

    this.uniqueConstraints.push({
      fields: fieldArray.map(String),
      options,
    });

    return this;
  }

  // ===========================================================================
  // SCHEMAS
  // ===========================================================================

  /**
   * Gets all ArkType schemas for this model
   * Lazily computed and cached
   */
  get schemas(): TypedModelSchemas<TFields> {
    if (!this._schemas) {
      this._schemas = buildModelSchemas(this);
    }
    return this._schemas;
  }

  // ===========================================================================
  // TYPE INFERENCE
  // ===========================================================================

  /**
   * Inferred TypeScript type for model records
   * Only includes scalar fields, not relations
   */
  get infer(): InferModelFields<TFields> {
    return {} as InferModelFields<TFields>;
  }

  /**
   * Internal namespace for accessing internals
   */
  get "~"() {
    return {
      infer: this.infer,
      schemas: this.schemas,
      fields: this.fieldDefinitions,
    };
  }

  // ===========================================================================
  // VALIDATION METHODS
  // ===========================================================================

  /**
   * Validates a where input against the model's where schema
   */
  validateWhere(input: unknown) {
    return this.schemas.where(input);
  }

  /**
   * Validates a where unique input against the model's whereUnique schema
   */
  validateWhereUnique(input: unknown) {
    return this.schemas.whereUnique(input);
  }

  /**
   * Validates a create input against the model's create schema
   */
  validateCreate(input: unknown) {
    return this.schemas.create(input);
  }

  /**
   * Validates an update input against the model's update schema
   */
  validateUpdate(input: unknown) {
    return this.schemas.update(input);
  }
}

// =============================================================================
// FACTORY FUNCTION
// =============================================================================

/**
 * Creates a new model with the given fields
 *
 * @example
 * const user = s.model({
 *   id: s.string().id().ulid(),
 *   name: s.string(),
 * }).map("users");
 */
export const model = <
  TFields extends Record<string, Field | Relation<any, any>>
>(
  fields: TFields
) => new Model(fields);
