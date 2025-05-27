// Test StringField chainable methods
import { string } from "./src/schema/fields/string.js";
import type { StringField } from "./src/schema/fields/string.js";

// Basic string field
const name = string();
console.log("Basic string field:", name instanceof Object);

// Test chainable methods return StringField instances
const idField = string().id();
const nullableField = string().nullable();
const listField = string().list();
const uniqueField = string().unique();
const defaultField = string().default("test");

// Test that they're still StringField instances
console.log("ID field type:", idField.constructor.name);
console.log("Nullable field type:", nullableField.constructor.name);
console.log("List field type:", listField.constructor.name);
console.log("Unique field type:", uniqueField.constructor.name);
console.log("Default field type:", defaultField.constructor.name);

// Test validation with .validator() method
const emailValidator = (value: string) =>
  /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) || "Invalid email format";

const minLengthValidator = (min: number) => (value: string) =>
  value.length >= min || `Must be at least ${min} characters`;

const maxLengthValidator = (max: number) => (value: string) =>
  value.length <= max || `Must be at most ${max} characters`;

// Test that string fields work with .validator() method after chaining
const emailField = string().unique().validator(emailValidator); // Now uses .validator() method
const urlField = string().nullable(); // URL validation would be added via .validator() if needed
const lengthField = string().validator(
  minLengthValidator(5),
  maxLengthValidator(100)
); // Multiple validators

console.log("Email field type:", emailField.constructor.name);
console.log("URL field type:", urlField.constructor.name);
console.log("Length field type:", lengthField.constructor.name);

// Test type inference still works
type IdFieldType = typeof idField.infer; // should be string
type NullableFieldType = typeof nullableField.infer; // should be string | null
type ListFieldType = typeof listField.infer; // should be string[]

// Complex combination with validation
const complexField = string().id().unique().validator(minLengthValidator(3));
console.log("Complex field type:", complexField.constructor.name);

// Test that field properties are set correctly
console.log("ID field isId:", (idField as any).isId);
console.log("Nullable field isOptional:", (nullableField as any).isOptional);
console.log("List field isList:", (listField as any).isList);
console.log("Unique field isUnique:", (uniqueField as any).isUnique);

// Test validation API with .validator() method
async function testValidation() {
  console.log("Testing validation with .validator() method:");

  const validResult = await emailField.validate("test@example.com");
  console.log("Valid email result:", validResult);

  const invalidResult = await emailField.validate("invalid-email");
  console.log("Invalid email result:", invalidResult);

  const lengthResult = await lengthField.validate("hi");
  console.log("Length validation result:", lengthResult);

  const complexResult = await complexField.validate("ab");
  console.log("Complex field validation result:", complexResult);
}

testValidation();

// Schema test - now uses .validator() method for validation
const testSchema = {
  id: string().id(),
  email: string().unique().validator(emailValidator), // Uses .validator() method
  name: string().validator(minLengthValidator(2), maxLengthValidator(50)), // Multiple validators
  bio: string().nullable(),
  tags: string().list(),
  slug: string().unique(),
  description: string().default("No description"),
};

console.log("Schema created successfully!");
console.log("Schema keys:", Object.keys(testSchema));

export { testSchema };
