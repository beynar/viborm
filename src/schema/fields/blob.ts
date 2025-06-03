// Blob Field Implementation
// Type-safe blob field with enhanced generics

import { BaseField } from "./base.js";

import type {
  FieldValidator,
  FieldState,
  DefaultFieldState,
  MakeNullable,
  MakeArray,
  MakeId,
  MakeUnique,
  MakeDefault,
  InferType,
} from "./types.js";

export class BlobField<
  T extends FieldState<
    any,
    any,
    any,
    any,
    any,
    any
  > = DefaultFieldState<Uint8Array>
> extends BaseField<T> {
  public override "~fieldType" = "blob" as const;
  private "~fieldValidator"?: FieldValidator<InferType<T>>;

  constructor() {
    super();
  }

  protected "~createInstance"<
    U extends FieldState<any, any, any, any, any, any>
  >(): BaseField<U> {
    const newField = new BlobField<U>();
    return newField as any;
  }

  // Copy blob-specific properties
  protected override "~copyFieldSpecificProperties"(
    target: BaseField<any>
  ): void {
    (target as any)["~fieldValidator"] = this["~fieldValidator"];
  }

  // Override chainable methods to return BlobField instances
  override nullable(): BlobField<MakeNullable<T>> {
    return this["~cloneWith"]<MakeNullable<T>>({
      "~isOptional": true,
    }) as BlobField<MakeNullable<T>>;
  }

  array(): BlobField<MakeArray<T>> {
    return this["~cloneWith"]<MakeArray<T>>({ "~isArray": true }) as BlobField<
      MakeArray<T>
    >;
  }

  id(): BlobField<MakeId<T>> {
    return this["~cloneWith"]<MakeId<T>>({ "~isId": true }) as BlobField<
      MakeId<T>
    >;
  }

  unique(): BlobField<MakeUnique<T>> {
    return this["~cloneWith"]<MakeUnique<T>>({
      "~isUnique": true,
    }) as BlobField<MakeUnique<T>>;
  }

  override default(value: InferType<T>): BlobField<MakeDefault<T>> {
    return this["~cloneWith"]<MakeDefault<T>>({
      "~defaultValue": value,
    }) as BlobField<MakeDefault<T>>;
  }

  // Add validator method that accepts a single standard schema
  validator(validator: FieldValidator<InferType<T>>): this {
    this["~fieldValidator"] = validator;
    return this;
  }

  // Override validate to include custom validator
  override async "~validate"(value: any): Promise<any> {
    return super["~validate"](value, this["~fieldValidator"]);
  }
}

// Factory function for creating blob fields with proper typing
export function blob(): BlobField<DefaultFieldState<Uint8Array>> {
  return new BlobField();
}
