// Type System Demonstration
// Shows how the advanced generic system provides proper type inference

import { string } from "./src/schema/fields/string.js";

// Basic string field
const name = string();
type NameType = typeof name.infer; // string

// Nullable string field
const optionalName = string().nullable();
type OptionalNameType = typeof optionalName.infer; // string | null

// String field with default
const description = string().default("No description");
type DescriptionType = typeof description.infer; // string

// ID field with auto-generation
const id = string().id().auto.ulid();
type IdType = typeof id.infer; // string

// List field
const tags = string().list();
type TagsType = typeof tags.infer; // string[]

// Complex combination: nullable list with default
const categories = string().list().nullable().default([]);
type CategoriesType = typeof categories.infer; // string[] | null

// Unique field
const slug = string().unique();
type SlugType = typeof slug.infer; // string

// Email field with validation
const email = string().email().unique();
type EmailType = typeof email.infer; // string

// Show the types in action
function demonstrateTypes() {
  // These should all be properly typed based on field configuration
  const nameValue: NameType = "Alice"; // string
  const optionalNameValue: OptionalNameType = null; // string | null
  const descriptionValue: DescriptionType = "A description"; // string
  const idValue: IdType = "01FXQZ2KBGQC1J8X9R5QFXN0K2"; // string
  const tagsValue: TagsType = ["tag1", "tag2"]; // string[]
  const categoriesValue: CategoriesType = null; // string[] | null
  const slugValue: SlugType = "my-slug"; // string
  const emailValue: EmailType = "user@example.com"; // string

  console.log({
    nameValue,
    optionalNameValue,
    descriptionValue,
    idValue,
    tagsValue,
    categoriesValue,
    slugValue,
    emailValue,
  });
}

// Example of how this would work in a model definition
const userSchema = {
  id: string().id().auto.ulid(),
  email: string().email().unique(),
  name: string(),
  bio: string().nullable(),
  tags: string().list(),
  createdAt: string(), // In real implementation, this would be dateTime().auto.now()
};

// TypeScript can infer the complete user type from the schema
type User = {
  [K in keyof typeof userSchema]: (typeof userSchema)[K]["infer"];
};

// This should result in:
// type User = {
//   id: string;
//   email: string;
//   name: string;
//   bio: string | null;
//   tags: string[];
//   createdAt: string;
// }

export { demonstrateTypes, userSchema };
export type { User };
