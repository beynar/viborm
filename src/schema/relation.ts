// Relation Class Implementation
// Based on specification: readme/1.4_relation_class.md

import type {
  RelationType,
  CascadeOptions,
  RelationValidator,
  ValidationResult,
} from "../types/index.js";

export class Relation<T = any> {
  public relationType?: RelationType | undefined;
  public targetModel?: (() => any) | undefined;
  public onField?: string | undefined;
  public refField?: string | undefined;
  public cascadeOptions?: CascadeOptions | undefined;
  public junctionTableName?: string | undefined;
  public junctionFieldName?: string | undefined;

  constructor() {}

  // Relation type setters
  one<TTarget>(target: () => TTarget): Relation<TTarget> {
    const newRelation = new Relation<TTarget>();
    this.copyPropertiesTo(newRelation);
    newRelation.relationType = "one";
    newRelation.targetModel = target;
    return newRelation;
  }

  many<TTarget>(target: () => TTarget): Relation<TTarget[]> {
    const newRelation = new Relation<TTarget[]>();
    this.copyPropertiesTo(newRelation);
    newRelation.relationType = "many";
    newRelation.targetModel = target;
    return newRelation;
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
  cascade(options: CascadeOptions): this {
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

  // Validation execution - accepts any number of validators
  async validate(
    data: T,
    ...validators: RelationValidator<T>[]
  ): Promise<ValidationResult> {
    const errors: string[] = [];

    for (const validator of validators) {
      try {
        if (typeof validator === "function") {
          const result = await validator(data);
          if (result !== true) {
            errors.push(
              typeof result === "string" ? result : "Validation failed"
            );
          }
        }
      } catch (error) {
        errors.push(
          `Validation error: ${
            error instanceof Error ? error.message : "Unknown error"
          }`
        );
      }
    }

    return {
      valid: errors.length === 0,
      errors: errors.length > 0 ? errors : undefined,
    };
  }

  // Helper methods
  private clone(): Relation<T> {
    const newRelation = new Relation<T>();
    newRelation.relationType = this.relationType;
    newRelation.targetModel = this.targetModel;
    newRelation.onField = this.onField;
    newRelation.refField = this.refField;
    newRelation.cascadeOptions = this.cascadeOptions;
    newRelation.junctionTableName = this.junctionTableName;
    newRelation.junctionFieldName = this.junctionFieldName;
    return newRelation;
  }

  private copyPropertiesTo(newRelation: Relation<any>): void {
    newRelation.relationType = this.relationType;
    newRelation.targetModel = this.targetModel;
    newRelation.onField = this.onField;
    newRelation.refField = this.refField;
    newRelation.cascadeOptions = this.cascadeOptions;
    newRelation.junctionTableName = this.junctionTableName;
    newRelation.junctionFieldName = this.junctionFieldName;
  }
}
