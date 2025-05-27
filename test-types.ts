// Test file to verify working type system
import { string } from "./src/schema/fields/string.js";
import { int, float, decimal } from "./src/schema/fields/number.js";

// Basic types
const name = string();
const age = int();
const price = decimal();

// Test type inference
type NameType = typeof name.infer; // should be string
type AgeType = typeof age.infer; // should be number
type PriceType = typeof price.infer; // should be number

// Modifiers
const optionalName = string().nullable();
const tagsList = string().list();
const optionalTags = string().list().nullable();
const uniqueEmail = string().unique();
const userId = string().id();
const defaultBio = string().default("No bio");

// Test modifier types
type OptionalNameType = typeof optionalName.infer; // should be string | null
type TagsListType = typeof tagsList.infer; // should be string[]
type OptionalTagsType = typeof optionalTags.infer; // should be string[] | null
type UniqueEmailType = typeof uniqueEmail.infer; // should be string
type UserIdType = typeof userId.infer; // should be string
type DefaultBioType = typeof defaultBio.infer; // should be string

// Complex field combinations
const ageOptional = int().nullable();
const scoresList = float().list();
const uniqueScore = float().unique();

type AgeOptionalType = typeof ageOptional.infer; // should be number | null
type ScoresListType = typeof scoresList.infer; // should be number[]
type UniqueScoreType = typeof uniqueScore.infer; // should be number

// Schema example
const schema = {
  id: string().id(),
  email: string().unique(),
  name: string(),
  age: int(),
  bio: string().nullable(),
  tags: string().list(),
  scores: float().list().nullable(),
  description: string().default("No description"),
};

// Infer schema type
type Schema = {
  [K in keyof typeof schema]: (typeof schema)[K]["infer"];
};

// This should resolve to:
// type Schema = {
//   id: string;
//   email: string;
//   name: string;
//   age: number;
//   bio: string | null;
//   tags: string[];
//   scores: number[] | null;
//   description: string;
// }

// Test that the types work correctly
const testData: Schema = {
  id: "user-123",
  email: "test@example.com",
  name: "John",
  age: 25,
  bio: null,
  tags: ["developer", "typescript"],
  scores: [95.5, 87.2],
  description: "A developer",
};

console.log("Type system is working correctly!");
console.log(testData);

export { schema, testData };
export type { Schema };
