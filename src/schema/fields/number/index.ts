// Number Field Exports
export { IntField, FloatField, DecimalField, int, float, decimal } from "./field";
export * from "./schemas";

import type { IntField, FloatField, DecimalField } from "./field";
import type { FieldState } from "../common";

// Union type alias for any number field
export type NumberField =
  | IntField<FieldState<"int">>
  | FloatField<FieldState<"float">>
  | DecimalField<FieldState<"decimal">>;
