// Vector Field Class
// Field for storing vector embeddings

import { BaseField } from "./base.js";
import type {
  FieldState,
  DefaultFieldState,
  MakeNullable,
  MakeDefault,
  InferType,
  BaseFieldType,
} from "../../types/field-states.js";
// import type { StandardSchemaV1 } from "../../types/standardSchema.js"; // No longer needed for validate
// import type { FieldValidator, ValidationResult } from "../../types/validators.js"; // No longer needed

export class VectorField<
  S extends FieldState<number[], any, any, any, any, any> = DefaultFieldState<
    number[]
  >
> extends BaseField<S> {
  public override fieldType = "vector" as const;
  public readonly dimension: number;

  constructor(dimension: number) {
    super();
    this.dimension = dimension;
  }

  protected override createInstance<
    U extends FieldState<any, any, any, any, any, any>
  >(): BaseField<U> {
    const newField = new VectorField<U>(this.dimension);
    return newField as any;
  }

  protected override copyFieldSpecificProperties(target: BaseField<any>): void {
    (target as any).dimension = this.dimension;
  }

  override nullable(): VectorField<MakeNullable<S>> {
    return this.cloneWith<MakeNullable<S>>({ isOptional: true }) as VectorField<
      MakeNullable<S>
    >;
  }

  override default(value: InferType<S>): VectorField<MakeDefault<S>> {
    // Validate that the default value is an array with correct dimension
    if (!Array.isArray(value)) {
      throw new Error("Vector default value must be an array");
    }
    if (value.length !== this.dimension) {
      throw new Error(
        `Vector default value must have dimension ${this.dimension}. Received ${value.length}`
      );
    }
    for (const item of value) {
      if (typeof item !== "number") {
        throw new Error("Vector default value elements must be numbers");
      }
    }

    return this.cloneWith<MakeDefault<S>>({
      defaultValue: value,
    }) as VectorField<MakeDefault<S>>;
  }

  override async validate(value: any): Promise<any> {
    return {
      error: false,
      value: [],
      issues: [],
    };
  }

  // The .id() and .unique() methods are intentionally NOT defined/overridden
  // so they remain unavailable for VectorField

  // public validator(validator: FieldValidator<InferType<S>>): this { ... } // REMOVED

  // override async validate(value: any): Promise<ValidationResult<InferType<S>>> { ... } // REMOVED
}

// Factory function for creating vector fields
export function vector(
  dimension: number
): VectorField<DefaultFieldState<number[]>> {
  if (
    typeof dimension !== "number" ||
    !Number.isInteger(dimension) ||
    dimension <= 0
  ) {
    throw new Error("Vector dimension must be a positive integer.");
  }
  return new VectorField(dimension);
}
