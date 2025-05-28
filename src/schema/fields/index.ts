// Field Types - Index
// Exports all field types from their individual files

import { FieldState } from "../../types/field-states.js";

export { BaseField } from "./base.js";
export { StringField, string } from "./string.js";
export { NumberField, int, float, decimal } from "./number.js";
export { BooleanField, boolean } from "./boolean.js";
export { BigIntField, bigint } from "./bigint.js";
export { DateTimeField, datetime } from "./datetime.js";
export { JsonField, json } from "./json.js";
export { BlobField, blob } from "./blob.js";
export { EnumField, enumField } from "./enum.js";
export { VectorField, vector } from "./vector.js";

// Union type for all field types
export type Field<T = any> =
  | import("./string.js").StringField<any>
  | import("./number.js").NumberField<any>
  | import("./boolean.js").BooleanField<any>
  | import("./bigint.js").BigIntField<any>
  | import("./datetime.js").DateTimeField<any>
  | import("./json.js").JsonField<any>
  | import("./blob.js").BlobField<any>
  | import("./enum.js").EnumField<any, any>
  | import("./vector.js").VectorField<any>;
