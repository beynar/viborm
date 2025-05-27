// Working Type System Demo
// Shows the advanced type system working with string and number fields

import { string } from "./src/schema/fields/string.js";
import { int, float } from "./src/schema/fields/number.js";

// String field examples
const name = string();
type NameType = typeof name.infer; // string

const optionalName = string().nullable();
type OptionalNameType = typeof optionalName.infer; // string | null

const tags = string().list();
type TagsType = typeof tags.infer; // string[]

const optionalTags = string().list().nullable();
type OptionalTagsType = typeof optionalTags.infer; // string[] | null

// Number field examples
const age = int();
type AgeType = typeof age.infer; // number

const optionalAge = int().nullable();
type OptionalAgeType = typeof optionalAge.infer; // number | null

const scores = float().list();
type ScoresType = typeof scores.infer; // number[]

// Complex combinations
const id = string().id();
type IdType = typeof id.infer; // string

const uniqueEmail = string().unique();
type UniqueEmailType = typeof uniqueEmail.infer; // string

const defaultDescription = string().default("No description");
type DefaultDescriptionType = typeof defaultDescription.infer; // string

// Show the types work correctly
function demonstrateWorkingTypes() {
  // These should all be properly typed
  const nameValue: NameType = "Alice";
  const optionalNameValue: OptionalNameType = null;
  const tagsValue: TagsType = ["tag1", "tag2"];
  const optionalTagsValue: OptionalTagsType = null;

  const ageValue: AgeType = 25;
  const optionalAgeValue: OptionalAgeType = null;
  const scoresValue: ScoresType = [95.5, 87.2, 92.1];

  const idValue: IdType = "user-123";
  const uniqueEmailValue: UniqueEmailType = "user@example.com";
  const defaultDescriptionValue: DefaultDescriptionType = "A user";

  console.log({
    nameValue,
    optionalNameValue,
    tagsValue,
    optionalTagsValue,
    ageValue,
    optionalAgeValue,
    scoresValue,
    idValue,
    uniqueEmailValue,
    defaultDescriptionValue,
  });
}

// Schema example with mixed field types
const userSchema = {
  id: string().id(),
  email: string().unique(),
  name: string(),
  age: int(),
  bio: string().nullable(),
  tags: string().list(),
  scores: float().list().nullable(),
  description: string().default("No description"),
};

// TypeScript infers the complete user type
type User = {
  [K in keyof typeof userSchema]: (typeof userSchema)[K]["infer"];
};

// This resolves to:
// type User = {
//   id: string;
//   email: string;
//   name: string;
//   age: number;
//   bio: string | null;
//   tags: string[];
//   scores: number[] | null;
//   description: string;
// }

// Test the inferred type
function createUser(): User {
  return {
    id: "user-123",
    email: "user@example.com",
    name: "Alice",
    age: 25,
    bio: null,
    tags: ["developer", "typescript"],
    scores: [95.5, 87.2],
    description: "A TypeScript developer",
  };
}

export { demonstrateWorkingTypes, userSchema, createUser };
export type { User };
