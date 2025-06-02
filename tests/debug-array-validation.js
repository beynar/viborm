// Simple debug script to understand array validation
import { QueryParser } from "../src/query-parser/index.js";
import { PostgresAdapter } from "../src/adapters/databases/postgres/postgres-adapter.js";
import { s } from "../src/schema/index.js";

const testModel = s.model("testModel", {
  id: s.string().id(),
  name: s.string(),
});

const adapter = new PostgresAdapter();
const parser = new QueryParser(adapter);

console.log("Testing array validation directly...");

const fieldValidator = parser.components.fieldValidators;

// Test 1: Valid string array
console.log("\n=== Test 1: Valid string array ===");
const validStringArray = fieldValidator.validateValue("array", [
  "valid",
  "string",
  "array",
]);
console.log("Result:", validStringArray);

// Test 2: Invalid mixed array (should fail)
console.log("\n=== Test 2: Invalid mixed array ===");
const invalidMixedArray = fieldValidator.validateValue("array", [
  "valid",
  123,
  "string",
]);
console.log("Result:", invalidMixedArray);

// Test 3: Valid number array
console.log("\n=== Test 3: Valid number array ===");
const validNumberArray = fieldValidator.validateValue("array", [1, 2, 3, 42]);
console.log("Result:", validNumberArray);

// Test 4: Invalid mixed number array (should fail)
console.log("\n=== Test 4: Invalid mixed number array ===");
const invalidNumberArray = fieldValidator.validateValue("array", [
  1,
  "not-a-number",
  3,
]);
console.log("Result:", invalidNumberArray);

// Test 5: Invalid UUID array (should fail)
console.log("\n=== Test 5: Invalid UUID array ===");
const invalidUuidArray = fieldValidator.validateValue("array", [
  "valid-uuid",
  "invalid-uuid",
]);
console.log("Result:", invalidUuidArray);

// Test 6: Valid UUID array
console.log("\n=== Test 6: Valid UUID array ===");
const validUuidArray = fieldValidator.validateValue("array", [
  "550e8400-e29b-41d4-a716-446655440000",
  "6ba7b810-9dad-11d1-80b4-00c04fd430c8",
]);
console.log("Result:", validUuidArray);
