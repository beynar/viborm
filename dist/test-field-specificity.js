// Test file to verify field specificity and type safety
import { SchemaBuilder } from "./schema/index.js";
const s = new SchemaBuilder();
// Test that string fields only allow string-specific methods
const stringField = s
    .string()
    .min(5) // ✅ Valid: min length for strings
    .max(100) // ✅ Valid: max length for strings
    .regex(/\w+/) // ✅ Valid: regex for strings
    .nullable() // ✅ Valid: common modifier
    .unique() // ✅ Valid: common modifier
    .id() // ✅ Valid: common modifier
    .auto.uuid(); // ✅ Valid: string auto-generation
// Test that number fields only allow number-specific methods
const numberField = s
    .int()
    .min(0) // ✅ Valid: min value for numbers
    .max(1000) // ✅ Valid: max value for numbers
    .nullable() // ✅ Valid: common modifier
    .unique() // ✅ Valid: common modifier
    .auto.increment(); // ✅ Valid: number auto-generation
// Test that boolean fields only allow common methods
const booleanField = s
    .boolean()
    .nullable() // ✅ Valid: common modifier
    .unique() // ✅ Valid: common modifier
    .default(false); // ✅ Valid: common modifier
// Test that date fields have date-specific auto-generation
const dateField = s
    .dateTime()
    .nullable() // ✅ Valid: common modifier
    .auto.now() // ✅ Valid: date auto-generation
    .unique(); // ✅ Valid: common modifier
// Test model creation with typed fields
const testModel = s.model("test", {
    id: stringField,
    count: numberField,
    isActive: booleanField,
    createdAt: dateField,
});
// Should be:
// {
//   id: string;
//   count: number;
//   isActive: boolean;
//   createdAt: Date;
// }
// These should cause TypeScript errors (uncomment to test):
// const invalidStringField = s.string().min(5).max(10).increment(); // ❌ Should error: increment not available on string
// const invalidBooleanField = s.boolean().min(0).max(1); // ❌ Should error: min/max not available on boolean
// const invalidNumberField = s.int().regex(/\d+/); // ❌ Should error: regex not available on number
console.log("Field specificity test completed successfully!");
console.log("String field type:", stringField.getType());
console.log("Number field type:", numberField.getType());
console.log("Boolean field type:", booleanField.getType());
console.log("Date field type:", dateField.getType());
//# sourceMappingURL=test-field-specificity.js.map