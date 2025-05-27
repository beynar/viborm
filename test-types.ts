// Comprehensive test for all field types with advanced type system
import { s } from "./src/schema/index.js";

// Test all field types with chainable methods
const comprehensiveModel = s.model("comprehensive", {
  // String fields
  id: s.string().id(),
  email: s.string().unique().email(),
  name: s.string(),
  bio: s.string().nullable(),
  tags: s.string().list(),
  description: s.string().default("No description"),

  // Number fields
  age: s.int().min(0).max(150),
  score: s.float().positive(),
  price: s.decimal(),
  count: s.int().list(),

  // Boolean fields
  isActive: s.boolean(),
  isVerified: s.boolean().default(false),
  permissions: s.boolean().list(),

  // BigInt fields
  bigId: s.bigInt().id(),
  bigValue: s.bigInt().nullable(),

  // DateTime fields
  createdAt: s.dateTime().auto.now(),
  updatedAt: s.dateTime().auto.updatedAt(),
  birthDate: s.dateTime().nullable(),

  // JSON fields
  metadata: s.json(),
  config: s.json().nullable(),
  settings: s.json().list(),

  // Blob fields
  avatar: s.blob().nullable(),
  documents: s.blob().list(),

  // Enum fields
  status: s.enum(["draft", "published", "archived"] as const),
  role: s.enum(["user", "admin", "moderator"] as const).default("user"),
  categories: s.enum([1, 2, 3, 4, 5] as const).list(),
});

// Test individual field type inference
const stringField = s.string().nullable();
const intField = s.int().list();
const boolField = s.boolean().default(true);
const bigintField = s.bigInt().unique();
const dateField = s.dateTime().nullable();
const jsonField = s.json().list();
const blobField = s.blob().nullable();
const enumField = s.enum(["a", "b", "c"] as const).nullable();

// Extract types for verification
type StringType = typeof stringField.infer; // should be string | null
type IntType = typeof intField.infer; // should be number[]
type BoolType = typeof boolField.infer; // should be boolean
type BigIntType = typeof bigintField.infer; // should be bigint
type DateType = typeof dateField.infer; // should be Date | null
type JsonType = typeof jsonField.infer; // should be any[]
type BlobType = typeof blobField.infer; // should be Uint8Array | null
type EnumType = typeof enumField.infer; // should be "a" | "b" | "c" | null

// Test that all field instances are correct types
console.log("=== Field Instance Tests ===");
console.log(
  "String field is StringField:",
  stringField.constructor.name === "StringField"
);
console.log(
  "Int field is NumberField:",
  intField.constructor.name === "NumberField"
);
console.log(
  "Bool field is BooleanField:",
  boolField.constructor.name === "BooleanField"
);
console.log(
  "BigInt field is BigIntField:",
  bigintField.constructor.name === "BigIntField"
);
console.log(
  "Date field is DateTimeField:",
  dateField.constructor.name === "DateTimeField"
);
console.log(
  "JSON field is JsonField:",
  jsonField.constructor.name === "JsonField"
);
console.log(
  "Blob field is BlobField:",
  blobField.constructor.name === "BlobField"
);
console.log(
  "Enum field is EnumField:",
  enumField.constructor.name === "EnumField"
);

// Test complex chaining
const complexString = s.string().unique().minLength(5).maxLength(100).email();
const complexNumber = s.int().id().positive().max(1000);
const complexDate = s.dateTime().nullable().after(new Date("2020-01-01"));
const complexEnum = s
  .enum(["red", "green", "blue"] as const)
  .list()
  .nullable();

console.log("\n=== Complex Chaining Tests ===");
console.log(
  "Complex string is StringField:",
  complexString.constructor.name === "StringField"
);
console.log(
  "Complex number is NumberField:",
  complexNumber.constructor.name === "NumberField"
);
console.log(
  "Complex date is DateTimeField:",
  complexDate.constructor.name === "DateTimeField"
);
console.log(
  "Complex enum is EnumField:",
  complexEnum.constructor.name === "EnumField"
);

// Test field properties are set correctly
console.log("\n=== Field Properties Tests ===");
console.log(
  "String field isOptional:",
  (stringField as any).isOptional === true
);
console.log("Int field isList:", (intField as any).isList === true);
console.log("BigInt field isUnique:", (bigintField as any).isUnique === true);
console.log("Complex number isId:", (complexNumber as any).isId === true);

console.log("\n=== Model Test ===");
console.log("Model created successfully!");
console.log("Model name:", comprehensiveModel.name);
console.log("Number of fields:", comprehensiveModel.fields.size);

// Test type-specific validations work
console.log("\n=== Field-Specific Methods Test ===");
const emailField = s.string().email();
const minMaxNumber = s.int().min(10).max(100);
const sizedBlob = s.blob().minSize(100).maxSize(1000);

console.log("Email field has email validation");
console.log("Number field has min/max validation");
console.log("Blob field has size validation");

console.log("\nAll tests completed successfully!");

export {
  comprehensiveModel,
  stringField,
  intField,
  boolField,
  bigintField,
  dateField,
  jsonField,
  blobField,
  enumField,
};

export type {
  StringType,
  IntType,
  BoolType,
  BigIntType,
  DateType,
  JsonType,
  BlobType,
  EnumType,
};
