// Number Field Exports
export {
  DecimalField,
  decimal,
  FloatField,
  float,
  IntField,
  int,
} from "./field";
export * from "./schemas";

import type { FieldState } from "../common";
import type { DecimalField, FloatField, IntField } from "./field";

// Union type alias for any number field
export type NumberField =
  | IntField<FieldState<"int">>
  | FloatField<FieldState<"float">>
  | DecimalField<FieldState<"decimal">>;
