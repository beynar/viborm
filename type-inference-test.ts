// Type inference test for StringField
import { string } from "./src/schema/fields/string.js";

// Test individual field type inference
const basicString = string();
const idString = string().id();
const nullableString = string().nullable();
const listString = string().list();
const defaultString = string().default("test");

// Extract types for verification
type BasicType = typeof basicString.infer; // should be string
type IdType = typeof idString.infer; // should be string
type NullableType = typeof nullableString.infer; // should be string | null
type ListType = typeof listString.infer; // should be string[]
type DefaultType = typeof defaultString.infer; // should be string

// Complex combinations
const complexField1 = string().nullable().list(); // should be string[] | null
const complexField2 = string().id().unique(); // should be string

type Complex1Type = typeof complexField1.infer; // should be string[] | null
type Complex2Type = typeof complexField2.infer; // should be string

// Test that all field instances are StringField
console.log(
  "Basic string is StringField:",
  basicString.constructor.name === "StringField"
);
console.log(
  "ID string is StringField:",
  idString.constructor.name === "StringField"
);
console.log(
  "Nullable string is StringField:",
  nullableString.constructor.name === "StringField"
);
console.log(
  "List string is StringField:",
  listString.constructor.name === "StringField"
);
console.log(
  "Default string is StringField:",
  defaultString.constructor.name === "StringField"
);
console.log(
  "Complex field 1 is StringField:",
  complexField1.constructor.name === "StringField"
);
console.log(
  "Complex field 2 is StringField:",
  complexField2.constructor.name === "StringField"
);

// Test method chaining works
const chainedField = string().minLength(3).maxLength(100).unique().email();

console.log(
  "Chained field is StringField:",
  chainedField.constructor.name === "StringField"
);

// Verify properties are set correctly
console.log("ID field has isId:", (idString as any).isId === true);
console.log(
  "Nullable field has isOptional:",
  (nullableString as any).isOptional === true
);
console.log("List field has isList:", (listString as any).isList === true);

console.log("Type inference test completed successfully!");

// Export for type checking
export type {
  BasicType,
  IdType,
  NullableType,
  ListType,
  DefaultType,
  Complex1Type,
  Complex2Type,
};
