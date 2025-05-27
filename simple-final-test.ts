// Simple test to verify StringField chainable methods work correctly
import { s } from "./src/schema/index.js";

// This should work without any type errors now
const testModel = s.model("test", {
  id: s.string().id(),
  email: s.string().unique().email(),
  name: s.string(),
  bio: s.string().nullable(),
  tags: s.string().list(),
  description: s.string().default("No description"),
});

// Test individual field creation - these should all be StringField instances
const idField = s.string().id();
const emailField = s.string().unique().email();
const nameField = s.string();
const bioField = s.string().nullable();
const tagsField = s.string().list();
const descField = s.string().default("test");

// Test that they're StringField instances
console.log("ID field constructor:", idField.constructor.name);
console.log("Email field constructor:", emailField.constructor.name);
console.log("Name field constructor:", nameField.constructor.name);
console.log("Bio field constructor:", bioField.constructor.name);
console.log("Tags field constructor:", tagsField.constructor.name);
console.log("Description field constructor:", descField.constructor.name);

// Test that string-specific methods work
const complexField = s.string().unique().minLength(5).maxLength(100).email();

console.log("Complex field constructor:", complexField.constructor.name);

// Simple manual type test
const userSchema = {
  id: s.string().id(),
  name: s.string(),
  email: s.string().nullable(),
  tags: s.string().list(),
};

// Test type inference on individual fields
type IdType = typeof userSchema.id.infer; // should be string
type NameType = typeof userSchema.name.infer; // should be string
type EmailType = typeof userSchema.email.infer; // should be string | null
type TagsType = typeof userSchema.tags.infer; // should be string[]

console.log("Test completed successfully!");
console.log("Model name:", testModel.name);

export { testModel, userSchema };
export type { IdType, NameType, EmailType, TagsType };
