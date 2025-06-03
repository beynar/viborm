import { BaseField } from "./base.js";
import type {
  FieldState,
  DefaultFieldState,
  MakeNullable,
  MakeArray,
  MakeId,
  MakeUnique,
  MakeDefault,
  InferType,
} from "./types";

export class VectorField<
  S extends FieldState<number[], any, any, any, any, any> = DefaultFieldState<
    number[]
  >
> extends BaseField<S> {
  public override "~fieldType" = "vector" as const;
  private "~dimension": number | undefined;

  constructor(dimension?: number) {
    super();
    this["~dimension"] = dimension;
  }

  protected "~createInstance"<
    U extends FieldState<any, any, any, any, any, any>
  >(): BaseField<U> {
    const newField = new VectorField<any>(this["~dimension"]);
    return newField as any;
  }

  protected override "~copyFieldSpecificProperties"(
    target: BaseField<any>
  ): void {
    (target as any)["~dimension"] = this["~dimension"];
  }

  // Override chainable methods to return VectorField instances
  override nullable(): VectorField<MakeNullable<S>> {
    return this["~cloneWith"]<MakeNullable<S>>({
      "~isOptional": true,
    }) as VectorField<MakeNullable<S>>;
  }

  array(): VectorField<MakeArray<S>> {
    return this["~cloneWith"]<MakeArray<S>>({
      "~isArray": true,
    }) as VectorField<MakeArray<S>>;
  }

  id(): VectorField<MakeId<S>> {
    return this["~cloneWith"]<MakeId<S>>({ "~isId": true }) as VectorField<
      MakeId<S>
    >;
  }

  unique(): VectorField<MakeUnique<S>> {
    return this["~cloneWith"]<MakeUnique<S>>({
      "~isUnique": true,
    }) as VectorField<MakeUnique<S>>;
  }

  override default(value: InferType<S>): VectorField<MakeDefault<S>> {
    return this["~cloneWith"]<MakeDefault<S>>({
      "~defaultValue": value,
    }) as VectorField<MakeDefault<S>>;
  }

  // Vector-specific method for setting dimension
  dimension(dim: number): VectorField<S> {
    const newField = this["~cloneWith"]<S>({}) as VectorField<S>;
    newField["~dimension"] = dim;
    return newField;
  }

  // Override validate to include dimension validation
  override async "~validate"(value: any): Promise<any> {
    // Basic type validation first
    if (!Array.isArray(value)) {
      return {
        output: undefined,
        valid: false,
        errors: ["Value must be an array of numbers"],
      };
    }

    // Check if all elements are numbers
    if (!value.every((item) => typeof item === "number")) {
      return {
        output: undefined,
        valid: false,
        errors: ["All vector elements must be numbers"],
      };
    }

    // Dimension validation if specified
    if (
      this["~dimension"] !== undefined &&
      value.length !== this["~dimension"]
    ) {
      return {
        output: undefined,
        valid: false,
        errors: [
          `Vector must have exactly ${this["~dimension"]} dimensions, got ${value.length}`,
        ],
      };
    }

    return super["~validate"](value as InferType<S>);
  }

  // The .id() and .unique() methods are intentionally NOT defined/overridden
  // so they remain unavailable for VectorField

  // public validator(validator: FieldValidator<InferType<S>>): this { ... } // REMOVED

  // override async validate(value: any): Promise<ValidationResult<InferType<S>>> { ... } // REMOVED
}

// Factory function for creating vector fields with proper typing
export function vector(
  dimension?: number
): VectorField<DefaultFieldState<number[]>> {
  return new VectorField(dimension);
}
