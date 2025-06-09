// Base Field Class
// Foundation for all field types with common functionality

import type {
  ScalarFieldType,
  FieldValidator,
  ValidationResult,
  AutoGenerateType,
  FieldState,
  MakeNullable,
  MakeDefault,
  InferType,
  BaseFieldType,
} from "./types";

// Base Field class with simplified generic type system
export abstract class BaseField<
  T extends FieldState<any, any, any, any, any, any> = any
> implements BaseFieldType<T>
{
  // Hidden state property for type inference
  public readonly "~fieldState"!: T;

  // Runtime properties
  public "~fieldType"?: ScalarFieldType | undefined;
  public "~isOptional": boolean = false;
  public "~isUnique": boolean = false;
  public "~isId": boolean = false;
  public "~isArray": boolean = false;
  public "~defaultValue"?: T["BaseType"] | (() => T["BaseType"]) | undefined;
  public "~autoGenerate"?: AutoGenerateType | undefined;

  constructor() {}

  // Type-safe modifiers that return new field instances with updated types
  nullable(): BaseFieldType<MakeNullable<T>> {
    return this["~cloneWith"]<MakeNullable<T>>({ "~isOptional": true });
  }

  default(value: InferType<T>): BaseFieldType<MakeDefault<T>> {
    return this["~cloneWith"]<MakeDefault<T>>({ "~defaultValue": value });
  }

  // Abstract method to create the correct instance type
  protected abstract "~createInstance"<
    U extends FieldState<any, any, any, any, any, any>
  >(): BaseField<U>;

  // Generic clone-and-modify helper for reducing duplication
  protected "~cloneWith"<U extends FieldState<any, any, any, any, any, any>>(
    modifications: Partial<BaseField<any>> = {}
  ): BaseField<U> {
    const newField = this["~createInstance"]<U>();
    this["~copyPropertiesTo"](newField);
    this["~copyFieldSpecificProperties"](newField);

    // Apply all modifications
    for (const [key, value] of Object.entries(modifications)) {
      (newField as any)[key] = value;
    }

    return newField;
  }

  // Hook for subclasses to copy their specific properties
  protected "~copyFieldSpecificProperties"(target: BaseField<any>): void {
    // Base implementation does nothing - subclasses can override
  }

  protected "~copyPropertiesTo"(target: BaseField<any>): void {
    target["~fieldType"] = this["~fieldType"];
    target["~isOptional"] = this["~isOptional"];
    target["~isUnique"] = this["~isUnique"];
    target["~isId"] = this["~isId"];
    target["~isArray"] = this["~isArray"];
    target["~defaultValue"] = this["~defaultValue"];
    target["~autoGenerate"] = this["~autoGenerate"];
  }

  // Type inference getters
  get infer(): InferType<T> {
    return {} as InferType<T>;
  }
}
