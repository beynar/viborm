// Model Class Implementation
// Based on specification: readme/1.1_model_class.md
import { Relation, BaseField, type Field } from "../fields";
import {
  parseCreateInput,
  parseUpdateInput,
  parseWhereManyInput,
  parseWhereUniqueInput,
} from "./validator";

export class Model<
  TFields extends Record<string, Field | Relation<any, any>> = {}
> {
  public readonly fields: Map<string, BaseField<any>> = new Map();
  public readonly relations: Map<string, Relation<any, any>> = new Map();
  public readonly name: string;
  public tableName?: string;
  public readonly indexes: IndexDefinition[] = [];
  public readonly uniqueConstraints: UniqueConstraintDefinition[] = [];

  constructor(name: string, private fieldDefinitions: TFields) {
    this.name = name;
    this.separateFieldsAndRelations(fieldDefinitions);
  }

  private separateFieldsAndRelations(definitions: TFields): void {
    for (const [key, definition] of Object.entries(definitions)) {
      if (definition instanceof BaseField) {
        this.fields.set(key, definition as BaseField<any>);
      } else if (definition instanceof Relation) {
        this.relations.set(key, definition);
      } else {
        throw new Error(
          `Invalid field definition for '${key}'. Must be a Field, Relation, or LazyRelation instance.`
        );
      }
    }
  }

  // Database table mapping
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

  // Index management
  index(fields: string | string[], options: IndexOptions = {}): this {
    const fieldArray = Array.isArray(fields) ? fields : [fields];

    // Validate all fields exist
    for (const field of fieldArray) {
      if (!this.fields.has(field)) {
        const availableFields = Array.from(this.fields.keys());
        throw new Error(
          `Field '${field}' does not exist in model '${
            this.name
          }'. Available fields: ${availableFields.join(", ")}`
        );
      }
    }

    this.indexes.push({
      fields: fieldArray,
      options,
    });

    return this;
  }

  // Unique constraints
  unique(
    fields: string | string[],
    options: UniqueConstraintOptions = {}
  ): this {
    const fieldArray = Array.isArray(fields) ? fields : [fields];

    // Validate all fields exist
    for (const field of fieldArray) {
      if (!this.fields.has(field)) {
        const availableFields = Array.from(this.fields.keys());
        throw new Error(
          `Field '${field}' does not exist in model '${
            this.name
          }'. Available fields: ${availableFields.join(", ")}`
        );
      }
    }

    this.uniqueConstraints.push({
      fields: fieldArray,
      options,
    });

    return this;
  }

  get infer() {
    return {} as {
      [K in keyof TFields]: TFields[K]["infer"];
    };
  }
  ["~validate"] = {
    whereMany: (input: Record<string, any>) => {
      return parseWhereManyInput(this, input);
    },
    whereUnique: (input: Record<string, any>) => {
      return parseWhereUniqueInput(this, input);
    },
    update: (input: Record<string, any>) => {
      return parseUpdateInput(this, input);
    },
    create: (input: Record<string, any>) => {
      return parseCreateInput(this, input);
    },
  };
}

export const model = <
  TName extends string,
  TFields extends Record<string, Field | Relation<any, any>>
>(
  name: TName,
  fields: TFields
) => new Model(name, fields);

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

// Unique constraint types
export interface UniqueConstraintOptions {
  name?: string;
}

export interface UniqueConstraintDefinition {
  fields: string[];
  options: UniqueConstraintOptions;
}
