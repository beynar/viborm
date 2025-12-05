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
  TFields extends Record<string, Field | Relation<any, any, any>>
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

type ModelOptions = {
  tableName?: string | undefined;
  indexes?: IndexDefinition[];
};

export class Model<
  TFields extends Record<string, Field | Relation<any, any, any>> = {}
> {
  // ---------------------------------------------------------------------------
  // Private state (exposed via ~)
  // ---------------------------------------------------------------------------
  private _fields: Map<string, Field> = new Map();
  private _relations: Map<string, Relation<any, any>> = new Map();
  private _tableName: string | undefined = undefined;
  private _indexes: IndexDefinition[] = [];
  private _schemas?: TypedModelSchemas<TFields>;

  constructor(private _fieldDefinitions: TFields, options?: ModelOptions) {
    this.separateFieldsAndRelations(_fieldDefinitions);
    if (options) {
      this._tableName = options.tableName ?? undefined;
      this._indexes = options.indexes ?? [];
    }
  }

  private separateFieldsAndRelations(definitions: TFields): void {
    for (const [key, definition] of Object.entries(definitions)) {
      if (isField(definition)) {
        this._fields.set(key, definition as Field);
      } else if (definition instanceof Relation) {
        this._relations.set(key, definition);
      } else {
        throw new Error(
          `Invalid field definition for '${key}'. Must be a Field or Relation instance.`
        );
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Gets the model/table name (for display/error messages)
   * Returns tableName if set, otherwise "Model"
   */
  get name(): string {
    return this._tableName ?? "Model";
  }

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
    this._tableName = tableName;
    return this;
  }

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
      if (!this._fields.has(String(field))) {
        const availableFields = Array.from(this._fields.keys());
        throw new Error(
          `Field '${String(
            field
          )}' does not exist in model. Available fields: ${availableFields.join(
            ", "
          )}`
        );
      }
    }

    this._indexes.push({
      fields: fieldArray.map(String),
      options,
    });

    return this;
  }

  extends<ETFields extends Record<string, Field | Relation<any, any, any>>>(
    fields: ETFields
  ): Model<TFields & ETFields> {
    return new Model(
      { ...this._fieldDefinitions, ...fields },
      {
        tableName: this._tableName,
        indexes: this._indexes,
      }
    );
  }

  // ---------------------------------------------------------------------------
  // Internal namespace (~)
  // ---------------------------------------------------------------------------

  /**
   * Internal namespace for ORM internals
   * Not part of the public API - may change without notice
   */
  get "~"() {
    // Use a self reference for lazy schema access to avoid circular issues
    const self = this;

    return {
      /** Field definitions as passed to the model constructor */
      fields: this._fieldDefinitions,
      /** Map of scalar field names to Field instances */
      fieldMap: this._fields,
      /** Map of relation names to Relation instances */
      relations: this._relations,
      /** Database table name (set via .map()) */
      tableName: this._tableName,
      /** Index definitions */
      indexes: this._indexes,
      /** ArkType schemas for validation (lazily computed) */
      get schemas(): TypedModelSchemas<TFields> {
        if (!self._schemas) {
          self._schemas = buildModelSchemas(self);
        }
        return self._schemas;
      },
      /** Inferred TypeScript type for model records */
      infer: {} as InferModelFields<TFields>,
    };
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
  TFields extends Record<string, Field | Relation<any, any, any>>
>(
  fields: TFields
) => new Model(fields);
