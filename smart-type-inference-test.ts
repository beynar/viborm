import { s } from "./src/schema/index.js";

// Test 1: ID fields are never nullable (even if marked nullable)
const idField = s.string().id(); // Should infer: string (never null)
const nullableIdField = s.string().id().nullable(); // Should still infer: string (nullable ignored)

type IdFieldType = typeof idField.infer; // string
type NullableIdFieldType = typeof nullableIdField.infer; // string (not string | null!)

// Test 2: Auto-generated fields are never nullable
const autoUlidField = s.string().auto.ulid(); // Should infer: string
const nullableAutoField = s.string().auto.uuid().nullable(); // Should still infer: string

type AutoFieldType = typeof autoUlidField.infer; // string
type NullableAutoFieldType = typeof nullableAutoField.infer; // string (not string | null!)

// Test 3: Fields with defaults are non-nullable for storage
const defaultField = s.string().default("hello"); // Should infer: string
const nullableDefaultField = s.string().default("world").nullable(); // Should still infer: string

type DefaultFieldType = typeof defaultField.infer; // string
type NullableDefaultFieldType = typeof nullableDefaultField.infer; // string (not string | null!)

// Test 4: Input vs Storage type distinction
const autoIdField = s.string().id().auto.ulid();

type AutoIdGeneralType = typeof autoIdField.infer; // string (for general use)
type AutoIdInputType = typeof autoIdField.inferInput; // string | undefined (optional for input)
type AutoIdStorageType = typeof autoIdField.inferStorage; // string (always present in storage)

// Test 5: Regular nullable fields still work as expected
const normalNullableField = s.string().nullable();
type NormalNullableType = typeof normalNullableField.infer; // string | null

// Test 6: Complex combinations
const complexField = s.string().id().auto.ulid().unique();
type ComplexType = typeof complexField.infer; // string (ID + auto = never null)
type ComplexInputType = typeof complexField.inferInput; // string | undefined (auto = optional input)

// Test 7: List fields with constraints
const listIdField = s.string().list().id(); // Should be string[] (not string[] | null)
const nullableListField = s.string().list().nullable(); // Should be string[] | null

type ListIdType = typeof listIdField.infer; // string[]
type NullableListType = typeof nullableListField.infer; // string[] | null

// Test 8: Type-level validation warnings
const validIdField = s.string().id();
const problematicIdField = s.string().id().nullable();

// These should show helpful warning messages in the IDE
type ValidIdValidation = typeof validIdField.validateState;
type ProblematicIdValidation = typeof problematicIdField.validateState;

// Test 9: Schema with mixed field types
const userSchema = {
  // ID field: never nullable, auto-generated = optional for input
  id: s.string().id().auto.ulid(),

  // Regular field: nullable as specified
  name: s.string().nullable(),

  // Field with default: non-nullable, optional for input
  status: s.string().default("active"),

  // Regular required field
  email: s.string(),

  // Problematic field (should show warnings)
  problematicId: s.int().id().nullable().auto.increment(),
};

// Extract types from schema
type UserSchema = {
  [K in keyof typeof userSchema]: (typeof userSchema)[K]["infer"];
};

type UserInputSchema = {
  [K in keyof typeof userSchema]: (typeof userSchema)[K]["inferInput"];
};

type UserStorageSchema = {
  [K in keyof typeof userSchema]: (typeof userSchema)[K]["inferStorage"];
};

// Type tests - these should compile correctly
const userGeneral: UserSchema = {
  id: "ulid_123", // string (required)
  name: null, // string | null
  status: "active", // string (required despite having default)
  email: "test@example.com", // string (required)
  problematicId: 123, // number (required despite nullable marking)
};

const userInput: Partial<UserInputSchema> = {
  // id is optional for input (auto-generated)
  name: null, // string | null
  // status is optional for input (has default)
  email: "test@example.com", // string (required)
  // problematicId is optional for input (auto-generated)
  // tags is optional for input (has default)
};

const userStorage: UserStorageSchema = {
  id: "ulid_123", // string (always present)
  name: null, // string | null
  status: "active", // string (never null due to default)
  email: "test@example.com", // string (required)
  problematicId: 123, // number (never null despite nullable marking)
};

console.log("Smart type inference test completed!");
console.log("Check TypeScript types in your IDE to see the improvements:");
console.log("1. ID fields are never nullable");
console.log("2. Auto-generated fields are never nullable");
console.log("3. Fields with defaults are non-nullable");
console.log("4. Input types make auto/default fields optional");
console.log(
  "5. Type-level validation warnings appear for problematic configurations"
);

// Export for type checking
export {
  IdFieldType,
  NullableIdFieldType,
  AutoFieldType,
  NullableAutoFieldType,
  DefaultFieldType,
  NullableDefaultFieldType,
  AutoIdGeneralType,
  AutoIdInputType,
  AutoIdStorageType,
  NormalNullableType,
  ComplexType,
  ComplexInputType,
  ListIdType,
  NullableListType,
  UserSchema,
  UserInputSchema,
  UserStorageSchema,
};
